# Claim Progress and Idle Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the parent an advisory, pull-based signal that tells it whether a delegated child's claim is still advancing the run — by recording a per-claim `lastProgressAt` on successful claim-authenticated mutation and deriving an `idle` label at read time on `rundown status` and `rundown collect` (#519).

**Architecture:** Three seams, no machine state. (1) `ClaimRecord` gains one **required** field `lastProgressAt`, set to `issuedAt` at creation by `createClaimRecord`; sessions whose persisted claims lack it are **rejected** by a structural guard in `loadSession` with the existing finish/prune/restart error shape — no migration, no hydration, no shim. (2) A new `SessionService.recordClaimProgress(claimId)` refreshes exactly one claim — the one whose bearer the caller presented — inside the existing session-lock scope, and is invoked **after** a mutation commits, best-effort: the method never throws, so it cannot mask the committed mutation (RD-102). It is called by **every** claim-authenticated command that changes runbook workflow state (eight of the eleven on the `--claim-id` surface), and a fail-closed drift guard classifies all eleven and pins the set in both directions. It is deliberately NOT wired into `verifyClaimId` — nor into `stash`/`pop`, which mutate but change only session targeting — so neither a child polling `status --claim-id` nor one looping `stash`/`pop` can refresh its own mark without advancing the run. (3) A new pure module `claim-activity.ts` derives `ClaimActivity` from `(record, now, idleAfter)` with `now` injected; `rundown status` and `rundown collect` join it onto claimed/unresolved delegations at read time, deriving **per child** so one corrupt record cannot erase the others. Nothing expires, nothing is reclaimed, no result is synthesized.

The drift guard in (2) derives its left-hand side from the **real program** (`createProgram()`, `cli.ts:72`), never from the test's own tables — a guard whose scan and whose classification come from the same source shrinks on both sides at once and can never fail.

**Tech Stack:** TypeScript, Zod (persisted + output schemas), Jest (unit + integration), fast-check (property), Stryker (scoped mutation), pnpm workspaces. Packages: `@rundown-org/core` (claim shape, recording seam, pure activity module, collect read model), `@rundown-org/cli` (thin front end — status/collect rendering, the goto/abort recording call sites, and the drift guard).

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `docs/superpowers/specs/2026-07-16-claim-progress-idle-detection-design.md` (APPROVED — do not redesign, do not soften).

- **`lastProgressAt` is REQUIRED, not optional.** "An optional field with a fallback is legacy-field hydration, which CLAUDE.md forbids." No `?`, no `??`, no default-on-read, anywhere.
- **NEVER migrate persisted state.** "This breaks existing persisted sessions. Per CLAUDE.md that is acceptable and preferred over compatibility code." A session whose claims lack the field is **rejected** with the same error shape and recovery path as the existing legacy-ownership guard (`state.ts:773`): finish, prune, or restart. No runtime migration, fallback parser, legacy field hydration, compatibility shim, or warning-only adapter.
- **Not a reuse of `updatedAt`.** `updatedAt` means "this record was last written" and **is left alone** — `recordClaimProgress` must NOT touch it, and `refreshedClaimRecord` must NOT touch `lastProgressAt`. One field, one meaning.
- **THE RULE: every successful claim-authenticated command that CHANGES RUNBOOK WORKFLOW STATE records progress.** The predicate is **"changes runbook workflow state", NOT "mutates"** — that distinction is load-bearing, not stylistic (see `stash`/`pop` below). This is a rule rather than an enumerated allow-list because "a list has to be remembered. A command added later that forgets to record fails _invisibly_: no test fails, no type error, and the only symptom is a claim reading idle while it is actually advancing — a spurious 'go check on this' that nobody can trace back to a missing line in a command file."
- **The `--claim-id` surface is ELEVEN commands in THREE categories.** All eleven must be classified. The rule still has **no exception list**, because the two non-recording categories are **not carve-outs** — they simply do not satisfy the predicate:

  | Category                       | Commands                                                                   | Records |
  | ------------------------------ | -------------------------------------------------------------------------- | ------- |
  | Changes runbook workflow state | `pass`, `fail`, `complete`, `stop`, `collect`, `delegate`, `goto`, `abort` | **Yes** |
  | Changes session targeting only | `stash`, `pop`                                                             | **No**  |
  | Changes nothing (read-only)    | `status`                                                                   | **No**  |

  The eight are the codebase's own mutating-command list — the seven pinned by the `--run` drift guard (`packages/cli/__tests__/helpers/run-option.test.ts:50`) plus `abort`, which is claim-authenticated and mutating (`abort.ts:59`) but sits outside that guard's scope because it takes a token argument rather than `--run`.

- **`stash` / `pop` FAIL THE PREDICATE — they are not exceptions to it.** The ANTI-FOOLING INVARIANT is why the predicate is worded as it is, and the wording is why these two fall outside the rule without any carve-out being needed. Both ARE claim-authenticated mutations (`stash.ts:19`, `pop.ts:59`), so a rule keyed on "mutation" alone would sweep them in — which is precisely why the predicate is workflow state. "`lastProgressAt` means the holder advanced the _controlled run_, and stashing advances session _targeting_ — the run itself is untouched. Recording them would reopen precisely the hole that disqualified the rejected verify-path design: a child looping `stash`/`pop` would refresh itself alive forever without advancing anything, faking liveness through a mutating command instead of through a read. **Same defect, different door.**" Corroboration: `unstashForClaimId` already moves `updatedAt` (`session-service.ts:1060`) — the field this design deliberately leaves alone, precisely because it means "record written", not "run advanced".
- **Recording on a claim-terminating command (`complete`, `stop`, `abort`) IS deliberately not special-cased away.** "It is a redundant write to a claim leaving the reportable population: it costs nothing, and it buys a predicate with no exceptions to remember." Do not add an exception, however harmless it looks. Contrast with `stash`/`pop`: those are not exceptions being denied — they fail the predicate outright.
- **`status --claim-id` does not record.** Claim-authenticated but read-only: "a stuck child polling its own status would otherwise refresh its claim forever and never report idle — a false negative on precisely the case being detected." `verifyClaimId` (`session-service.ts:361`) stays read-only and lock-free.
- **A fail-closed drift guard pins all eleven IN BOTH DIRECTIONS** (Task 5), and must be **proven to bite** — "a guard that cannot fail is theatre". "The guard, not the seam's uniformity, is the guarantee", which is why the recording _seam_ may legitimately differ per command: core for six; CLI for `goto` and `abort`, whose core services are authorization gates that return `authorized`/`refused` and mutate nothing. **Restructuring those two seams is out of scope for #519.** Because that sanction rests **entirely** on the guard, the guard's construction is load-bearing:
  - **The scan's left-hand side MUST come from `createProgram()` (`packages/cli/src/cli.ts:72`)**, which registers every command. A guard that builds its program by registering the same tables it then compares against is **tautological**: a new `rundown foo --claim-id` is never registered by the test, never classified, and the suite stays green. Both sides must not shrink together, or there is no guarantee at all and the CLI silently owns the policy.
  - **`RoleSpecificMutationCommand` is NOT the definition of "claim-authenticated workflow mutation"** and must not be typed as one. Its own TSDoc (`subprocess-mutation-boundary.ts:27-32`) defines a **subprocess-trust** concept: "commands whose only available trust is the bare direct-CLI lane". Its overlap with this plan's eight is a **coincidence**, and already an imperfect one — `abort` records but is not in the union. Treating it as both would be the "one field, two meanings" conflation this design rejects everywhere else. It appears in Task 5 only as a secondary **cross-check**, never as the anchor.
- **A corrupt `lastProgressAt` is contained per child, never swallowed wholesale.** `claimActivity` throws (below), but a boundary that catches around the **whole list** and returns `[]` is a **worse fail-open than the NaN it exists to prevent**: one corrupt child erases every genuinely-idle sibling from the report and the parent concludes nothing needs checking. The decision, pinned at the CLI/read boundary: **derive per child, and surface an unreadable child as its own typed union member** (`kind: 'unreadable'`) that renders as needing attention. Other children stay visible; the corrupt one is loud. `status` (read-only) uses the same per-entry containment, so a corrupt record never escapes as an unhandled stack trace instead of a JSON error envelope. The path is reachable: `z.string().min(1)` admits `'not-a-date'` and Task 1's structural guard only checks key **presence**.
- **An unparseable `lastProgressAt` THROWS — as a typed `RundownError`, not a bare `Error`.** Never classify it as `progressing`: "every `NaN` comparison is false — so `idleFor > idleAfter` would be false and a dead claim would silently classify as `progressing`. That is the single worst failure this design can have: a safety signal that fails *open*, quietly, in exactly the case it exists to catch." The throw carries `ErrorCodes.CLAIM_PROGRESS_UNREADABLE` (RD-824, added by Task 2) so callers and tests discriminate **on the code**. A bare `Error` would be distinguishable from `durationMs`'s bare `Error` — thrown from the same function — only by message substring, so a harmless reword would silently gut AC6 with every test still green.
- **`ClaimActivity` is a `readonly interface`, not a union.** A two-member union whose variants carry **identical** fields is a boolean in costume: no caller narrows, both consumers flatten it straight back to `activity.kind === 'idle'`, and the spec's own naming table says `idle: boolean`. Type-driven dispatch means unions that force narrowing — not ceremony that doesn't. The union that **does** earn its keep is `ChildActivity` at the read boundary (`known` | `unreadable`), whose members differ in the data they carry and which callers genuinely must narrow.
- **Recorded on success, not on attempt.** A failed mutation records nothing. "A live-but-erroring child correctly reads as idle — a true positive worth surfacing."
- **A command refreshes only the claim whose bearer it presented.** Never another claim. `collect --claim-id <orchestrator-claim>` refreshes the orchestrator's own claim, **not** the children's. "A parent cannot vouch for a child's liveness, and must not appear to."
- **Recording is best-effort and never masks the mutation.** Ordering is fixed: verify bearer → authorize grant → commit mutation → best-effort record progress. `recordClaimProgress` never throws and never propagates (RD-102 policy).
- **`claimActivity` is pure.** No I/O, no clock read — `now` is injected. `DEFAULT_IDLE_AFTER_MS = 60 * 60 * 1000` (one hour). **No configuration surface in this change.**
- **Advisory only (AC10).** No expiry, no reclaim, no auto-abort, no synthesized child PASS/FAIL, **no machine state, no events**, no `rundown heartbeat` command, no probing. Nothing under `packages/core/src/runbook/compiler*.ts`, `actors/`, or any event type is touched by this plan.
- **`idle` iff `idleFor > idleAfter` — strictly greater.** Exactly at the threshold is `progressing`.
- **JSON is the contract and the default.** `idleFor` is milliseconds in JSON; `--text` renders it humanised. CLI tests exercise the default JSON path first; `--text` is covered separately (CLAUDE.md Testing Conventions).
- **Mutation gate imports must be STATIC.** Per #541's lesson, `claim-activity.test.ts` must import `claim-activity.js` with a top-level static `import`, or Stryker's static related-tests graph will not see the module and it will score 0.00%.
- **TSDoc on every exported symbol** (description, `@param`, `@returns`, `@throws`) per CLAUDE.md TSDoc Standards.
- Branch is `claim-progress-idle-detection`. Do not switch or create branches.

---

## Background: what exists today

- `ClaimRecord` (`packages/core/src/runbook/claim-id.ts:89`) has `claimKey`, `secretHash`, `controlledRunId`, `delegation?`, `grants`, `issuedAt`, `updatedAt`.
- `createClaimRecord` (`claim-id.ts:402`) takes `{ ..., now }` and sets `issuedAt: input.now, updatedAt: input.now`. It has exactly **two** production call sites, both in `session-service.ts` (`:335` `mintRunControlClaim`, `:544` the delegated-child mint). Setting `lastProgressAt: input.now` there satisfies AC1 for both.
- `refreshedClaimRecord` (`claim-id.ts:428`) is `{ ...record, updatedAt: now }`. Its only caller is `unstashForClaimId` (`session-service.ts:1060`).
- `SessionService.withLock` (`session-service.ts:251`) is `acquire` + `await using this.lock.held()` + `fn()`.
- `unstashForClaimId` (`session-service.ts:1023`) is the verify→refresh→save template: `withLock` → `parseClaimBearer` → `loadSession` → `Object.hasOwn(session.claims, key)` → `verifyClaimSecret` → `refreshedClaimRecord` → `saveSession`.
- `RunbookStateManager.loadSession` (`state.ts:759`) reads the file, then at `:773` runs a structural guard that throws `'Legacy session ownership format detected. Finish or prune active runbooks and restart.'`, then `SessionDataSchema.safeParse` (whose failure throws a *different*, delete-the-file message). The new guard goes **between** the legacy guard and `safeParse`, so a session missing the field gets the finish/prune/restart message rather than the delete-the-file one.
- **The `loadSession` rejection tests live in `packages/core/__tests__/runbook/state.test.ts:820-858`** — the three `Legacy session ownership format` cases. `state-schema-version.test.ts` contains **zero** occurrences of `loadSession` (verified: `grep -c loadSession` returns 0); it owns run-state schema versioning, not session loading. Task 1 extends `state.test.ts`.
- **`packages/claude-code-plugin/src/rdpath.ts:70-76` allow-lists session-load error messages by substring** — including `'Legacy session ownership format detected'` — to degrade gracefully instead of exploding when the session is unreadable. It does **not** match the new claim message, so `rdpath` would lose that degradation on exactly the sessions this change invalidates. Task 1 adds the new message there. The plugin package is in scope for this one line.
- **The `--text` delegations renderer is `packages/cli/src/services/renderers/text-renderer.ts:296-314`**, not `status-builder.ts` and not `collect.ts` (both have zero rendering hits). It is a **line** format — `` `  ${d.substep}  ${d.runbook}  DELEGATED  ${stateLabel}` `` — so "add a column with UPPERCASE headers" does not apply; append to the line. It also carries its **own structural duplicate** of the delegation entry shape at `:62-71`, independent of `status-builder.ts:77-84`, so the fields must be added in both or the renderer cannot see them.
- `ClaimRecordSchema` (`packages/core/src/schemas.ts:634`) is `.strict()` — an unknown key is already rejected, so adding the field to the type WITHOUT adding it to the schema would break every round-trip.
- `rundown status` already loads `session.claims` and joins `claimKey` onto claimed delegations (`packages/cli/src/commands/status.ts:43-52` → `ActiveStatusOptions.claimKeyByChildRunId` → `status-builder.ts:373-382`). The per-entry output shape is owned by `DelegationStatusEntrySchema` (`packages/core/src/output/zod-schemas.ts:390`).
- `rundown collect` reports a scalar `unresolved` count on the `collection_applied` and `collection_frame_not_active` outcomes (`collection-service.ts:482,531,589`). `CollectionSessionService` (`collection-service.ts:40`) extends `CommandTargetReader`, which already exposes `listOpenClaimsForParent(parentRunId)` (`command-target-resolver.ts:253`; implemented at `session-service.ts:640`) — it returns exactly the non-terminal, not-yet-`done` delegated child `ClaimRecord`s for a parent run. That is the join key for collect's per-child activity; no new read model is needed.
- `collection-service.ts:517-525` already carries the canonical RD-102 best-effort comment + `try {} catch {}` shape to imitate.
- **Two of the eight commands are gates-only in core, so they record from the CLI.** `resolveRunNavigation` (`lifecycle-command-service.ts:1509`) returns `{ kind: 'allowed', state, steps, ... }` — `goto`'s actual mutation is `actorService.sendAndSync(state.id, steps, { type: 'GOTO', target })` inside `executeGoto` (`packages/cli/src/helpers/goto-workflow.ts:309`). Likewise `AbortCommandService.authorizeAbortCommand` (`abort-command-service.ts:78`) returns only `authorized` / `refused` — `abort`'s mutation is `manager.update(freshParent.id, {...})` at `packages/cli/src/commands/abort.ts:203`, under the delegation lock. Both are pre-existing architecture and are NOT restructured here; both record by invoking the core `SessionService` API from the CLI — the CLI dispatching into core, not re-implementing it. The spec sanctions this explicitly, because the drift guard (Task 5) — not seam uniformity — is what makes the rule enforceable.
- `runTerminal` (`lifecycle-command-service.ts:1417`) IS a full core seam: it dispatches to `#driveTerminalClaim` / `#driveTerminalBare` / `#driveTerminalRun` and returns `LifecycleTerminalOutcome`, whose committed-success members are `applied_claim` (`:578`) and `applied_bare` (`:587`). `terminal_claim_confirmed` and `already_terminal` commit nothing new.
- There is no `DurationMs` type and no duration humaniser in the repo today. Both are introduced by this plan. The branded-primitive convention to follow is `FrameKey` (`packages/core/src/runbook/targeting.ts:20`): `type X = base & { readonly __brand: 'X' }`.

---

## File Structure

**Created:**

- `packages/core/src/runbook/claim-activity.ts` — the pure derivation seam: `DurationMs`, `durationMs()`, `ClaimActivity`, `claimActivity()`, `DEFAULT_IDLE_AFTER_MS`. No I/O, no clock read, no imports from `session-service.ts`. Separate from `claim-id.ts` because that module owns bearer/hashing/grant/authorization primitives and this is a distinct concern with its own seam (spec § Derived Activity).
- `packages/core/__tests__/runbook/claim-activity.test.ts` — unit tests. **Statically** imports `claim-activity.js` (Stryker gate).
- `packages/core/__tests__/runbook/claim-activity.properties.test.ts` — fast-check property tests. Also a static import.
- `packages/core/__tests__/runbook/claim-progress.test.ts` — the recording seam's core integration tests (anti-fooling invariant, bearer scoping, failed-mutation, RD-102 non-masking, adoption self-heal).
- `packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts` — the fail-closed drift guard classifying all eleven claim-authenticated commands and pinning both directions (AC4), modelled on `run-option.test.ts:50`.
- `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts` — CLI JSON-first then `--text` coverage for `status` and `collect`.

**Modified:**

- `packages/core/src/runbook/claim-id.ts` — add required `ClaimRecord.lastProgressAt`; set it in `createClaimRecord`; add `progressedClaimRecord()`. Leave `refreshedClaimRecord` alone.
- `packages/core/src/schemas.ts` — add `lastProgressAt` to `ClaimRecordSchema`.
- `packages/core/src/runbook/state.ts` — the structural rejection guard in `loadSession`.
- `packages/core/src/runbook/session-service.ts` — `recordClaimProgress()` + `ClaimProgressRecordResult`.
- `packages/core/src/runbook/index.ts` — export the new module.
- `packages/core/src/runbook/lifecycle-command-service.ts` — record after `runTransition` (pass/fail), `issueDelegation` (delegate), and `runTerminal` (complete/stop) commit.
- `packages/core/src/runbook/collection-service.ts` — record the presenter's own claim after `collection_applied`; attach `unresolvedChildren` to the two outcomes that report `unresolved`; add `recordClaimProgress` to `CollectionSessionService`.
- `packages/core/src/runbook/command-policy.ts` — `unresolvedChildren` on the two `DelegationPolicyOutcome` members.
- `packages/core/src/output/zod-schemas.ts` — activity fields on `DelegationStatusEntrySchema`.
- `packages/cli/src/helpers/goto-workflow.ts` — `claimId` on `GotoContext`; record after `sendAndSync` succeeds.
- `packages/cli/src/commands/goto.ts` — thread `claimId` into the context.
- `packages/cli/src/commands/abort.ts` — record after the cancellation commits (`:203`).
- `packages/cli/src/commands/status.ts` — build the activity join map, containing a corrupt record per entry.
- `packages/cli/src/helpers/status-builder.ts` — `ActiveStatusOptions.activityByChildRunId`; emit the fields.
- `packages/cli/src/services/renderers/text-renderer.ts` — `:62-71` the renderer's own copy of the delegation entry shape; `:296-314` the `--text` delegations **line** renderer. Without this file the `--text` fields are invisible no matter what the builder emits.
- `packages/core/src/errors/codes.ts` — `CLAIM_PROGRESS_UNREADABLE` (RD-824).
- `packages/claude-code-plugin/src/rdpath.ts:70-76` — allow-list the new session-rejection message so `rdpath` keeps degrading gracefully.
- `packages/cli/src/commands/collect.ts` — render `unresolvedChildren` in JSON and `--text`.
- `packages/cli/src/schemas/output-schemas.ts` — `unresolvedChildren` on the collect response schemas.
- `packages/cli/src/helpers/duration.ts` — **created**: `humaniseDurationMs` for `--text`.
- `docs/spec/cli-output.md` — status delegations prose; a new `## collect` section.

**Test fixtures that BREAK on the required-field change and MUST be updated (Task 1) — TWELVE files, not nine.** Every site that constructs a `ClaimRecord`. The obvious grep (`grep -rn "secretHash:"`) finds only nine, because it **misses shorthand properties** (`{ secretHash, ... }` with no colon). Use **both** forms:

```bash
grep -rln "secretHash:" packages/core/__tests__ packages/cli/__tests__          # 9 explicit-property files
grep -rln "secretHash,\|secretHash$" packages/core/__tests__ packages/cli/__tests__  # 3 MORE, shorthand
```

The three shorthand files (`command-policy.properties.test.ts`, `delegation-exposure.properties.test.ts`, `delegation-exposure.test.ts`) are the dangerous ones: **`delegation-exposure.test.ts` builds its record for `safeParse`, so it fails at RUNTIME, not at compile time.** Step 11's typecheck is therefore *not* a complete completeness guard — Step 12's full suite run is what catches that one. Do not treat a green `check:types` as proof you found them all.

Each needs `lastProgressAt` added:

| File | Line | Note |
| --- | --- | --- |
| `packages/core/__tests__/runbook/command-target-resolver.test.ts` | 73 | claim fixture factory |
| `packages/core/__tests__/runbook/command-policy.test.ts` | 59 | claim fixture factory |
| `packages/core/__tests__/runbook/delegation-schemas.test.ts` | 338, 465, 483 | `validClaim` + `ClaimRecordSchema` cases; 384 mutates `validClaim` and inherits the fix |
| `packages/cli/__tests__/helpers/claim-and-launch.test.ts` | 59 | |
| `packages/cli/__tests__/helpers/runbook-pipeline.test.ts` | 77 | |
| `packages/cli/__tests__/helpers/goto-workflow.test.ts` | 649 | |
| `packages/cli/__tests__/helpers/transitions-seam.test.ts` | 171 | |
| `packages/cli/__tests__/commands/prune.test.ts` | 716 | hand-writes a session claim with `hashClaimSecret` |
| `packages/cli/__tests__/commands/stash-pop.test.ts` | 683 | hand-writes a session claim with `hashClaimSecret` |
| `packages/core/__tests__/runbook/command-policy.properties.test.ts` | — | **shorthand** `secretHash,` — missed by the `secretHash:` grep |
| `packages/core/__tests__/runbook/delegation-exposure.properties.test.ts` | — | **shorthand** `secretHash,` |
| `packages/core/__tests__/runbook/delegation-exposure.test.ts` | — | **shorthand**; feeds `safeParse`, so it fails at RUNTIME, not compile time |

Tests that mint claims through `SessionService.issueRunControlClaim` / the delegated-child mint (e.g. `lifecycle-command-service.test.ts`, the `delegation-*` suites) do **not** break — `createClaimRecord` supplies the field for them. `packages/core/.stryker-tmp/**` and `packages/*/dist/**` are build artefacts; ignore them.

---

## Task 1: `ClaimRecord.lastProgressAt` — required field, set at creation, rejected when absent (AC1, AC2)

**Files:**

- Modify: `packages/core/src/runbook/claim-id.ts:89-102` (interface), `:402-420` (`createClaimRecord`)
- Modify: `packages/core/src/schemas.ts:634-643` (`ClaimRecordSchema`)
- Modify: `packages/core/src/runbook/state.ts:759-787` (`loadSession`)
- Modify: the **twelve** fixture files listed in the File Structure table (nine explicit-property + three shorthand)
- Modify: `packages/claude-code-plugin/src/rdpath.ts:70-76` (error allow-list)
- Test: `packages/core/__tests__/runbook/delegation-schemas.test.ts` (schema), `packages/core/__tests__/runbook/state.test.ts:820-858` (structural guard — the `Legacy session ownership format` cases there are the suite that owns `loadSession` rejection behaviour)

**Interfaces:**

- Consumes: nothing new.
- Produces: `ClaimRecord.lastProgressAt: string` (required, ISO). `createClaimRecord(input)` unchanged in signature — it now also sets `lastProgressAt: input.now`. `loadSession` throws `'Legacy claim record format detected. Finish or prune active runbooks and restart.'` for a session whose claims lack the field.

- [ ] **Step 1: Write the failing schema + creation tests**

Add to `packages/core/__tests__/runbook/delegation-schemas.test.ts`, in the `describe` that owns `validClaim` (the fixture at `:338`). First add `lastProgressAt` to the `validClaim` fixture itself so the existing cases keep passing:

```typescript
  // in the validClaim fixture object (around :338), alongside issuedAt/updatedAt:
    lastProgressAt: '2026-07-16T00:00:00.000Z',
```

Then add these two cases:

```typescript
  it('rejects a claim record with no lastProgressAt (#519)', () => {
    // `lastProgressAt` is REQUIRED — an optional field with a fallback would be
    // legacy-field hydration, which CLAUDE.md forbids.
    const { lastProgressAt: _omitted, ...withoutProgress } = validClaim;
    expect(ClaimRecordSchema.safeParse(withoutProgress).success).toBe(false);
  });

  it('rejects a claim record with an empty lastProgressAt (#519)', () => {
    expect(ClaimRecordSchema.safeParse({ ...validClaim, lastProgressAt: '' }).success).toBe(false);
  });
```

Add to the same file a creation case (import `createClaimRecord` from `../../src/runbook/claim-id.js` — check the file's existing import block and extend it rather than adding a second one):

```typescript
  it('sets lastProgressAt to issuedAt at claim creation (#519)', () => {
    const now = '2026-07-16T12:00:00.000Z';
    const record = createClaimRecord({
      claimKey: validClaim.claimKey,
      secretHash: validClaim.secretHash,
      controlledRunId: validClaim.controlledRunId,
      grants: validClaim.grants,
      now,
    });
    // A brand-new claim has, by definition, made no progress since issuance —
    // so the idle clock starts at issuance, not at zero/undefined.
    expect(record.lastProgressAt).toBe(now);
    expect(record.lastProgressAt).toBe(record.issuedAt);
  });
```

> The destructured `validClaim` fields must type-check against `createClaimRecord`'s input. If `validClaim` in this file is an untyped literal (it is — `secretHash` is a bare template string at `:338`), cast at the call site with the same `assertClaimSecretHash` / `assertClaimLookupKey` helpers the sibling suites use (see `command-target-resolver.test.ts:73`), rather than loosening `createClaimRecord`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core exec jest delegation-schemas.test.ts -t "lastProgressAt"`

Expected: FAIL. `ClaimRecordSchema` is `.strict()`, so the `validClaim` fixture now carrying `lastProgressAt` is rejected as an unknown key ("Unrecognized key"), and `createClaimRecord` does not return the field (TypeScript error: property does not exist).

> **Jest invocation:** use `exec jest <path> -t "<name>"`, NOT `test -- <path> -t "<name>"`. Both packages define `"test": "jest"`, so the script form forwards a literal `--` into jest 30, which then treats `-t` and the name as positional path patterns — the name filter is silently dropped and a mistyped red-test name matches nothing yet reports green.

- [ ] **Step 3: Add the required field to `ClaimRecord` and set it at creation**

In `packages/core/src/runbook/claim-id.ts`, add to the `ClaimRecord` interface (`:89`), directly after `updatedAt`:

```typescript
  /** ISO timestamp when this claim was last refreshed. */
  readonly updatedAt: string;
  /**
   * ISO timestamp when the holder last advanced the controlled run.
   *
   * REQUIRED. Deliberately NOT a reuse of `updatedAt`: that field means "this
   * record was last written" (a generic write timestamp), and the day an
   * unrelated claim write is added it would silently refresh the idle clock so a
   * dead claim reads as live. One field, two meanings, is exactly what
   * type-driven dispatch exists to prevent. Refreshed only by
   * `SessionService.recordClaimProgress` after a successful claim-authenticated
   * mutation (#519).
   */
  readonly lastProgressAt: string;
```

In `createClaimRecord` (`:402`), extend the returned object (leave the signature and every other field untouched):

```typescript
    issuedAt: input.now,
    updatedAt: input.now,
    // A brand-new claim has made no progress since issuance, so the idle clock
    // starts at issuance (#519 AC1).
    lastProgressAt: input.now,
```

- [ ] **Step 4: Add the field to `ClaimRecordSchema`**

In `packages/core/src/schemas.ts`, inside the `ClaimRecordSchema` object (`:634-643`), after `updatedAt`:

```typescript
    updatedAt: z.string().min(1),
    lastProgressAt: z.string().min(1),
```

Leave `.strict()` and both `superRefine` blocks exactly as they are.

- [ ] **Step 5: Run the schema + creation tests to verify they pass**

Run: `pnpm --filter @rundown-org/core exec jest delegation-schemas.test.ts -t "lastProgressAt"`

Expected: PASS.

- [ ] **Step 6: Write the failing structural-guard test**

Add to `packages/core/__tests__/runbook/state.test.ts`, in the describe that owns the three `Legacy session ownership format` rejection cases (`:820-858`) — mirror their setup for writing a raw `.rundown/session.json` and calling `manager.loadSession()`.

> **Not `state-schema-version.test.ts`.** That file has **zero** `loadSession` occurrences (`grep -c loadSession` → `0`); it owns run-state schema versioning. `state.test.ts:820-858` is where `loadSession` rejection actually lives, and the legacy-ownership guard your new guard sits beside is pinned there.

```typescript
  it('rejects a session whose claim records predate lastProgressAt (#519)', async () => {
    // A pre-#519 claim record: structurally a valid claim in every other respect,
    // but with no `lastProgressAt`. CLAUDE.md forbids migrating persisted state —
    // the guard REJECTS it with the finish/prune/restart recovery path, exactly as
    // the legacy-ownership guard does. It is never hydrated, defaulted, or shimmed.
    const claimKey = `rdclk_${'a'.repeat(32)}`;
    const runId = `rd_${'0'.repeat(32)}`;
    await writeFile(
      join(cwd, '.rundown', 'session.json'),
      JSON.stringify({
        defaultStack: [runId],
        claims: {
          [claimKey]: {
            claimKey,
            secretHash: `sha256:${'b'.repeat(64)}`,
            controlledRunId: runId,
            grants: [{ action: 'mutate-run', runId }],
            issuedAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );

    await expect(manager.loadSession()).rejects.toThrow(
      'Legacy claim record format detected. Finish or prune active runbooks and restart.',
    );
  });
```

- [ ] **Step 7: Run the guard test to verify it fails for the right reason**

Run: `pnpm --filter @rundown-org/core exec jest state.test.ts -t "predate lastProgressAt"`

Expected: FAIL. Without the guard, `SessionDataSchema.safeParse` rejects the record (the field is now required) and `loadSession` throws the *other* message — `'Session file contains invalid runbook targeting data. Delete .rundown/session.json and restart active runbooks.'`. That is the wrong recovery path (the spec requires the finish/prune/restart shape), so the assertion fails on the message. This is precisely why the guard is a separate check and not left to Zod.

- [ ] **Step 8: Add the structural rejection guard to `loadSession`**

In `packages/core/src/runbook/state.ts`, insert this immediately **after** the existing legacy-ownership guard (`:772-777`) and **before** `SessionDataSchema.safeParse` (`:779`):

```typescript
    // #519: `ClaimRecord.lastProgressAt` is required. A session persisted before
    // it existed is INVALID, not upgradable — CLAUDE.md forbids runtime migration,
    // fallback parsers, legacy field hydration, and warning-only adapters for
    // persisted runbook state. This guard runs BEFORE `safeParse` purely to route
    // this cause to the correct recovery path: Zod's failure message tells the user
    // to delete session.json, while the sanctioned recovery here — as for the legacy
    // ownership format above — is to finish or prune the active runbooks and restart.
    const rawClaims = raw['claims'];
    if (typeof rawClaims === 'object' && rawClaims !== null && !Array.isArray(rawClaims)) {
      const missingProgress = Object.values(rawClaims as Record<string, unknown>).some(
        (claim) =>
          typeof claim === 'object' &&
          claim !== null &&
          !Array.isArray(claim) &&
          !('lastProgressAt' in claim),
      );
      if (missingProgress) {
        throw new Error(
          'Legacy claim record format detected. Finish or prune active runbooks and restart.',
        );
      }
    }
```

- [ ] **Step 9: Run the guard test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest state.test.ts -t "predate lastProgressAt"`

Expected: PASS.

- [ ] **Step 10: Update every breaking `ClaimRecord` fixture**

This is a breaking schema change; every hand-written `ClaimRecord` literal in the test suites must carry the new field. Work the table in the File Structure section. In each, add `lastProgressAt` next to `updatedAt` with the same value the fixture already uses for `updatedAt` (or `issuedAt` — they are equal in every one of these fixtures):

```typescript
    issuedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastProgressAt: '2026-01-01T00:00:00.000Z',
```

Find them all — do not rely on the table alone if the tree has moved:

Run: `grep -rn "secretHash:" packages/core/__tests__ packages/cli/__tests__`

Every hit that is a `ClaimRecord` object literal (not a `ClaimRecordSchema.safeParse({ ...validClaim, secretHash: ... })` spread, which inherits the field) needs the line. `packages/cli/__tests__/commands/prune.test.ts:716` and `packages/cli/__tests__/commands/stash-pop.test.ts:683` hand-write a session claim with `hashClaimSecret(parsedClaim.secret)` — they need it too.

- [ ] **Step 10b: Keep `rdpath` degrading gracefully on the sessions this change invalidates**

`packages/claude-code-plugin/src/rdpath.ts:70-76` allow-lists session-load failures **by message substring** so `rdpath` degrades instead of exploding. It already lists `'Legacy session ownership format detected'`. The new message is not matched, so without this line `rdpath` would hard-fail on precisely the sessions this change invalidates — the plugin package is in scope for exactly this one line.

Add to that `||` chain, next to the sibling legacy message:

```typescript
    message.includes('Legacy session ownership format detected') ||
    message.includes('Legacy claim record format detected') ||
```

Then pin it. Add to `packages/claude-code-plugin/__tests__/` alongside the existing legacy-message case (find it with `grep -rn "Legacy session ownership" packages/claude-code-plugin/__tests__`), mirroring that case exactly with the new message.

- [ ] **Step 11: Typecheck — a NECESSARY but NOT sufficient completeness check**

Run: `pnpm run check:types`

Expected: PASS. Because `lastProgressAt` is required (not optional), TypeScript flags every **statically typed** literal still missing it. Do not silence any with a cast or `as ClaimRecord`; add the field.

> **A green typecheck does NOT mean you found them all.** `delegation-exposure.test.ts` builds its record for `ClaimRecordSchema.safeParse` — an untyped path, so it compiles clean and fails at **runtime**. Step 12 is the step that catches it. This is why both greps in Step 10 are mandatory rather than belt-and-braces.

- [ ] **Step 12: Run both packages' full suites**

Run: `pnpm --filter @rundown-org/core exec jest`
Run: `pnpm --filter @rundown-org/cli exec jest`

Expected: PASS. Any remaining failure is a fixture that constructs a claim record through a path Step 10 missed — fix the fixture, never the requiredness.

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/runbook/claim-id.ts \
  packages/core/src/schemas.ts \
  packages/core/src/runbook/state.ts \
  packages/claude-code-plugin/src/rdpath.ts \
  packages/core/__tests__ packages/cli/__tests__ packages/claude-code-plugin/__tests__
git commit -m "feat(core)!: add required ClaimRecord.lastProgressAt and reject sessions without it (#519)"
```

---

## Task 2: `claim-activity.ts` — the pure derivation seam (AC6, AC8, AC13)

**Files:**

- Create: `packages/core/src/runbook/claim-activity.ts`
- Modify: `packages/core/src/errors/codes.ts` (add `CLAIM_PROGRESS_UNREADABLE`, RD-824 — the next free code in the DELEGATION 8xx block, which currently ends at RD-823)
- Modify: `packages/core/src/runbook/index.ts:60` (add the export next to `claim-id.js`)
- Test: `packages/core/__tests__/runbook/claim-activity.test.ts` (create), `packages/core/__tests__/runbook/claim-activity.properties.test.ts` (create)

**Interfaces:**

- Consumes: `ClaimRecord` from `./claim-id.js` (type-only import).
- Produces — later tasks rely on these exact names and types:
  - `type DurationMs = number & { readonly __brand: 'DurationMs' }`
  - `function durationMs(value: number): DurationMs` — throws on non-finite / negative.
  - `interface ClaimActivity { readonly lastProgressAt: string; readonly idleFor: DurationMs; readonly idle: boolean }` — a **readonly interface, not a union**. See the Global Constraint: identical union variants that no caller narrows are a boolean in costume, and both consumers flatten straight back to `idle`. The spec's own naming table says `idle: boolean`.
  - `function claimActivity(record: ClaimRecord, now: Date, idleAfter: DurationMs): ClaimActivity` — throws `RundownError(ErrorCodes.CLAIM_PROGRESS_UNREADABLE)`.
  - `const DEFAULT_IDLE_AFTER_MS: DurationMs`

- [ ] **Step 1: Write the failing unit test**

Create `packages/core/__tests__/runbook/claim-activity.test.ts`.

> **Static import is load-bearing (AC13).** The `import` below MUST stay a top-level static import of `../../src/runbook/claim-activity.js`. Per #541, a dynamic-only (`await import(...)`) import leaves the module out of Stryker's static related-tests graph and it scores 0.00% regardless of how good the assertions are.

```typescript
// packages/core/__tests__/runbook/claim-activity.test.ts

import {
  claimActivity,
  durationMs,
  DEFAULT_IDLE_AFTER_MS,
  type DurationMs,
} from '../../src/runbook/claim-activity.js';
import { RundownError } from '../../src/errors/rundown-error.js';
import type { ClaimRecord } from '../../src/runbook/claim-id.js';
import { assertClaimLookupKey, assertClaimSecretHash } from '../../src/runbook/claim-id.js';
import { assertRunId } from '../../src/runbook/run-id.js';

const runId = assertRunId(`rd_${'0'.repeat(32)}`);

function claimAt(lastProgressAt: string): ClaimRecord {
  return {
    claimKey: assertClaimLookupKey(`rdclk_${'a'.repeat(32)}`),
    secretHash: assertClaimSecretHash(`sha256:${'b'.repeat(64)}`),
    controlledRunId: runId,
    grants: [{ action: 'mutate-run', runId }],
    issuedAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    lastProgressAt,
  };
}

const ONE_HOUR = durationMs(60 * 60 * 1000);

describe('claimActivity (#519)', () => {
  it('reports not-idle before the threshold', () => {
    const activity = claimActivity(
      claimAt('2026-07-16T00:00:00.000Z'),
      new Date('2026-07-16T00:59:59.999Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(3_599_999);
    expect(activity.lastProgressAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('reports not-idle EXACTLY at the threshold', () => {
    // The boundary is strict: idle iff idleFor > idleAfter. Exactly at the
    // threshold is still not idle. This case kills the `>` -> `>=` mutant.
    const activity = claimActivity(
      claimAt('2026-07-16T00:00:00.000Z'),
      new Date('2026-07-16T01:00:00.000Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(3_600_000);
  });

  it('reports idle one millisecond past the threshold', () => {
    const activity = claimActivity(
      claimAt('2026-07-16T00:00:00.000Z'),
      new Date('2026-07-16T01:00:00.001Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(true);
    expect(activity.idleFor).toBe(3_600_001);
  });

  it('clamps a future lastProgressAt to zero idle rather than reporting negative', () => {
    // Clock skew between the writer and the reader must not produce a negative
    // duration; the holder cannot be "less than zero" idle.
    const activity = claimActivity(
      claimAt('2026-07-16T02:00:00.000Z'),
      new Date('2026-07-16T01:00:00.000Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(0);
  });

  it('is pure: the same inputs always yield the same output and the record is untouched', () => {
    const record = claimAt('2026-07-16T00:00:00.000Z');
    const now = new Date('2026-07-16T00:30:00.000Z');
    expect(claimActivity(record, now, ONE_HOUR)).toEqual(claimActivity(record, now, ONE_HOUR));
    expect(record.lastProgressAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('throws CLAIM_PROGRESS_UNREADABLE on an unparseable lastProgressAt rather than reporting not-idle (AC6)', () => {
    // THE fail-open case. `Date.parse` yields NaN on a corrupt timestamp, and every
    // NaN comparison is false — so `idleFor > idleAfter` would be false and a DEAD
    // claim would silently classify as not-idle. That is a safety signal failing
    // open, quietly, in exactly the case it exists to catch. Corrupt persisted state
    // is rejected, never interpreted.
    //
    // Asserted on the CODE, not a message substring: `durationMs` throws a bare
    // Error out of this same function, so a substring match is the only thing
    // separating them — and a harmless reword would gut this test while it stays
    // green. The code is the contract the read boundary catches on too.
    let thrown: unknown;
    try {
      claimActivity(claimAt('not-a-date'), new Date(), ONE_HOUR);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RundownError);
    expect((thrown as RundownError).errorCode.code).toBe('RD-824');
  });

  it('defaults the idle threshold to one hour', () => {
    expect(DEFAULT_IDLE_AFTER_MS).toBe(3_600_000);
  });
});

describe('durationMs (#519)', () => {
  it('accepts zero and positive finite values', () => {
    expect(durationMs(0)).toBe(0);
    expect(durationMs(1234)).toBe(1234);
  });

  it('rejects negative values', () => {
    expect(() => durationMs(-1)).toThrow('DurationMs must be a non-negative finite number');
  });

  it('rejects non-finite values', () => {
    expect(() => durationMs(Number.NaN)).toThrow('DurationMs must be a non-negative finite number');
    expect(() => durationMs(Number.POSITIVE_INFINITY)).toThrow(
      'DurationMs must be a non-negative finite number',
    );
  });
});

// Type-level pin: `DurationMs` is branded, so a bare number is not assignable.
// (Compile-time only; kept as a reference so the brand is not silently dropped.)
const _typePin: DurationMs = DEFAULT_IDLE_AFTER_MS;
void _typePin;
```

> Confirm the helper names before writing: `grep -n "export function assertClaimLookupKey\|export function assertClaimSecretHash" packages/core/src/runbook/claim-id.ts` and `grep -n "export function assertRunId" packages/core/src/runbook/run-id.ts`. If a name differs, use the real one — do not invent a helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest claim-activity.test.ts`

Expected: FAIL — `Cannot find module '../../src/runbook/claim-activity.js'`.

- [ ] **Step 2b: Add the `CLAIM_PROGRESS_UNREADABLE` error code**

In `packages/core/src/errors/codes.ts`, add to the `ErrorCodes` object at the end of the DELEGATION 8xx block (currently ending at `RD-823` — verify with `grep -n "code: 'RD-8" packages/core/src/errors/codes.ts | tail -3` and take the next free number):

```typescript
  CLAIM_PROGRESS_UNREADABLE: {
    code: 'RD-824',
    category: ErrorCategory.DELEGATION,
    title: 'Claim progress timestamp unreadable',
    description:
      'A claim record has a lastProgressAt that is not a parseable ISO timestamp. The claim activity signal cannot be derived, so it is reported as unreadable rather than guessed. Finish or prune active runbooks and restart.',
    docSlug: 'claim-progress-unreadable',
  },
```

> A typed code, not a bare `Error`, is what lets the read boundary (Tasks 6 and 7) and AC6's test discriminate this from `durationMs`'s bare `Error` — thrown out of the very same function — without matching on a message substring that a reword would silently break.

- [ ] **Step 3: Write the module**

Create `packages/core/src/runbook/claim-activity.ts`:

```typescript
// packages/core/src/runbook/claim-activity.ts

import { RundownError } from '../errors/rundown-error.js';
import type { ClaimRecord } from './claim-id.js';

/**
 * A non-negative duration in milliseconds.
 *
 * Branded so a raw `number` cannot be passed where a duration is meant (and vice
 * versa), following the `FrameKey` convention in `targeting.ts`. Milliseconds is
 * the JSON wire unit for `idleFor`.
 */
export type DurationMs = number & { readonly __brand: 'DurationMs' };

/**
 * Construct a {@link DurationMs} from a raw millisecond count.
 *
 * @param value - Non-negative, finite millisecond count.
 * @returns The branded duration.
 * @throws {Error} When `value` is negative, `NaN`, or infinite.
 */
export function durationMs(value: number): DurationMs {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`DurationMs must be a non-negative finite number, received: ${String(value)}`);
  }
  return value as DurationMs;
}

/**
 * Threshold after which a claim is reported idle: one hour.
 *
 * Deliberately six times more generous than Kubernetes' 10-minute
 * `progressDeadlineSeconds` default, because a delegated agent step legitimately
 * runs far longer than a rollout. The asymmetry is intentional: reporting idle
 * too late costs a delayed check, while reporting it too early trains the reader
 * to ignore an advisory label — the one failure mode that cannot be corrected by
 * acting on it. There is deliberately no configuration surface (YAGNI); adding
 * one later is purely additive.
 */
export const DEFAULT_IDLE_AFTER_MS: DurationMs = durationMs(60 * 60 * 1000);

/**
 * Derived, advisory activity of a claim at a point in time.
 *
 * A readonly interface, deliberately NOT a discriminated union. Type-driven
 * dispatch calls for unions whose variants carry DIFFERENT data and so force
 * callers to narrow; a two-member union with identical fields forces nothing —
 * every consumer flattens it straight back to a boolean, which is what this
 * already is. The union that earns its keep in this design is `ChildActivity`
 * at the read boundary (`known` | `unreadable`), whose members genuinely differ.
 *
 * Purely advisory — `idle` expires nothing, reclaims nothing, and synthesizes no
 * result. A claim leaves `idle` simply by its holder running a command that
 * advances the run.
 */
export interface ClaimActivity {
  /** ISO timestamp of the claim's last recorded progress. */
  readonly lastProgressAt: string;
  /** Milliseconds elapsed since that progress. */
  readonly idleFor: DurationMs;
  /** Advisory: no progress recorded for longer than the idle threshold. */
  readonly idle: boolean;
}

/**
 * Classify a claim's activity at an injected point in time.
 *
 * Pure: no I/O and no clock read — `now` is injected, so this cannot drift with
 * wall-clock behaviour in tests. Idle is strictly `idleFor > idleAfter`; exactly
 * at the threshold is still `progressing`. A `lastProgressAt` in the future
 * (writer/reader clock skew) clamps to zero rather than reporting a negative
 * duration.
 *
 * @param record - Persisted claim record carrying `lastProgressAt`.
 * @param now - Injected observation time.
 * @param idleAfter - Threshold past which the claim is reported idle.
 * @returns The derived advisory activity.
 * @throws {RundownError} `CLAIM_PROGRESS_UNREADABLE` when `record.lastProgressAt`
 *   is not a parseable ISO timestamp. Deliberate: `Date.parse` yields `NaN`, every
 *   `NaN` comparison is false, so `idleFor > idleAfter` would be false and a DEAD
 *   claim would silently classify as progressing — a safety signal failing OPEN in
 *   exactly the case it exists to catch. Corrupt persisted state is rejected, never
 *   interpreted. TYPED rather than a bare `Error` because `durationMs` throws a bare
 *   `Error` from this same function: with both untyped, only a message substring
 *   would tell them apart, and a harmless reword would silently gut AC6 with every
 *   test still green. Callers contain this PER CHILD (never around a whole list) —
 *   see the read boundary in Tasks 6 and 7.
 */
export function claimActivity(
  record: ClaimRecord,
  now: Date,
  idleAfter: DurationMs,
): ClaimActivity {
  const lastProgress = Date.parse(record.lastProgressAt);
  if (Number.isNaN(lastProgress)) {
    throw new RundownError('CLAIM_PROGRESS_UNREADABLE', {
      claimKey: record.claimKey,
      lastProgressAt: String(record.lastProgressAt),
    });
  }
  const idleFor = durationMs(Math.max(0, now.getTime() - lastProgress));
  return {
    lastProgressAt: record.lastProgressAt,
    idleFor,
    idle: idleFor > idleAfter,
  };
}
```

- [ ] **Step 4: Export the module from the core barrel**

In `packages/core/src/runbook/index.ts`, next to the existing `export * from './claim-id.js';` (`:60`):

```typescript
export * from './claim-activity.js';
export * from './claim-id.js';
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest claim-activity.test.ts`

Expected: PASS (all cases).

- [ ] **Step 6: Write the property test**

Create `packages/core/__tests__/runbook/claim-activity.properties.test.ts`. Static import again (AC13).

```typescript
// packages/core/__tests__/runbook/claim-activity.properties.test.ts

import fc from 'fast-check';
import {
  claimActivity,
  durationMs,
  type DurationMs,
} from '../../src/runbook/claim-activity.js';
import type { ClaimRecord } from '../../src/runbook/claim-id.js';
import { assertClaimLookupKey, assertClaimSecretHash } from '../../src/runbook/claim-id.js';
import { assertRunId } from '../../src/runbook/run-id.js';

const runId = assertRunId(`rd_${'0'.repeat(32)}`);

function claimAt(lastProgressAt: string): ClaimRecord {
  return {
    claimKey: assertClaimLookupKey(`rdclk_${'a'.repeat(32)}`),
    secretHash: assertClaimSecretHash(`sha256:${'b'.repeat(64)}`),
    controlledRunId: runId,
    grants: [{ action: 'mutate-run', runId }],
    issuedAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    lastProgressAt,
  };
}

// Bounded so every timestamp is a valid ISO string and every difference fits
// comfortably in a safe integer.
const epochMs = fc.integer({ min: 0, max: 4_102_444_800_000 });
const thresholdMs = fc.integer({ min: 0, max: 86_400_000 });

describe('claimActivity properties (#519)', () => {
  it('is total over any valid ISO lastProgressAt and any valid now', () => {
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, (progressAt, nowAt, threshold) => {
        const activity = claimActivity(
          claimAt(new Date(progressAt).toISOString()),
          new Date(nowAt),
          durationMs(threshold) as DurationMs,
        );
        expect(typeof activity.idle).toBe('boolean');
        expect(activity.idleFor).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(activity.idleFor)).toBe(true);
      }),
    );
  });

  it('agrees with an INDEPENDENT oracle computed from the raw inputs', () => {
    // Deliberately NOT `expect(activity.idle).toBe(activity.idleFor > idleAfter)`.
    // That restates the implementation character-for-character using the
    // implementation's own output, so it holds under ANY mutation of `>` — a
    // tautology that costs runtime and buys nothing. This oracle is derived from
    // the raw inputs instead, so it disagrees when the comparison is mutated.
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, (progressAt, nowAt, threshold) => {
        const idleAfter = durationMs(threshold) as DurationMs;
        const activity = claimActivity(
          claimAt(new Date(progressAt).toISOString()),
          new Date(nowAt),
          idleAfter,
        );
        const expectedIdle = nowAt > progressAt + threshold;
        expect(activity.idle).toBe(expectedIdle);
      }),
    );
  });

  it('is monotonic in the threshold: raising idleAfter never makes a claim idler', () => {
    // A structural property with no counterpart line in the implementation:
    // a more generous threshold can only ever reclassify idle -> not idle.
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, thresholdMs, (progressAt, nowAt, a, b) => {
        const [lower, higher] = a <= b ? [a, b] : [b, a];
        const record = claimAt(new Date(progressAt).toISOString());
        const strict = claimActivity(record, new Date(nowAt), durationMs(lower) as DurationMs);
        const lenient = claimActivity(record, new Date(nowAt), durationMs(higher) as DurationMs);
        if (!strict.idle) expect(lenient.idle).toBe(false);
      }),
    );
  });

  it('idleFor is monotonic non-decreasing in now', () => {
    fc.assert(
      fc.property(
        epochMs,
        epochMs,
        fc.integer({ min: 0, max: 86_400_000 }),
        thresholdMs,
        (progressAt, nowAt, delta, threshold) => {
          const record = claimAt(new Date(progressAt).toISOString());
          const idleAfter = durationMs(threshold) as DurationMs;
          const earlier = claimActivity(record, new Date(nowAt), idleAfter);
          const later = claimActivity(record, new Date(nowAt + delta), idleAfter);
          // Time only moves forward, so an unrefreshed claim only gets idler.
          expect(later.idleFor).toBeGreaterThanOrEqual(earlier.idleFor);
        },
      ),
    );
  });

  it('never reports idle for a claim whose progress is at or after now (skew safety)', () => {
    // The clock-skew invariant, stated over the whole input space rather than the
    // single unit-test point: a holder that progressed at or after the observation
    // time can never be idle, at ANY threshold.
    fc.assert(
      fc.property(epochMs, fc.integer({ min: 0, max: 86_400_000 }), thresholdMs, (nowAt, skew, threshold) => {
        const activity = claimActivity(
          claimAt(new Date(nowAt + skew).toISOString()),
          new Date(nowAt),
          durationMs(threshold) as DurationMs,
        );
        expect(activity.idleFor).toBe(0);
        expect(activity.idle).toBe(false);
      }),
    );
  });
});
```

> Confirm the property-suite conventions before running: `ls packages/core/__tests__/runbook/*.properties.test.ts` and check how a sibling (e.g. `delegation-exposure.properties.test.ts`) imports fast-check and whether the property suites run under a separate jest project (`pnpm run test:property`). Match it.

- [ ] **Step 7: Run the property test**

Run: `pnpm --filter @rundown-org/core exec jest claim-activity.properties.test.ts`

Expected: PASS.

- [ ] **Step 8: Run the scoped mutation gate (AC13)**

Run the **direct filter form with an explicit `--`**:

```bash
pnpm --filter @rundown-org/core test:mutate -- \
  --mutate packages/core/src/runbook/claim-activity.ts \
  --testFiles packages/core/__tests__/runbook/claim-activity.test.ts,packages/core/__tests__/runbook/claim-activity.properties.test.ts
```

> **NOT `pnpm run test:mutate:core -- --mutate …`.** Unlike `test:mutate:cli` (`package.json:29`), the `test:mutate:core` script (`:28`) has **no trailing `--`**, so the scoping flags are consumed by the inner `pnpm` invocation instead of reaching Stryker: the gate silently runs **unscoped** over the whole package and its result tells you nothing about this module. Verify the scoping took effect — the run should report a handful of mutants for one file, not thousands.

Expected: a non-zero score with no surviving mutants — specifically:

- `idleFor > idleAfter` → `>=` is killed by the "reports not-idle EXACTLY at the threshold" case.
- `idleFor > idleAfter` → `<` / `true` / `false` are killed by the before/at/after triple **and** by the independent-oracle property (the tautological restatement it replaced would have survived all of these).
- `Math.max(0, ...)` removal is killed by the clock-skew clamp case and the skew-safety property.
- `!Number.isFinite(value) || value < 0` mutants are killed by the `durationMs` rejection cases.
- `Number.isNaN(lastProgress)` removal is killed by the unparseable-timestamp case.

**If the score is 0.00%, the cause is the import, not the tests.** Confirm both test files import `claim-activity.js` with a top-level static `import` — a dynamic `await import(...)` hides the module from Stryker's static related-tests graph (#541). Do not paper over a surviving mutant: add the input that makes the forced branch observable.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runbook/claim-activity.ts \
  packages/core/src/errors/codes.ts \
  packages/core/src/runbook/index.ts \
  packages/core/__tests__/runbook/claim-activity.test.ts \
  packages/core/__tests__/runbook/claim-activity.properties.test.ts
git commit -m "feat(core): add pure claimActivity idle derivation (#519)"
```

---

## Task 3: `SessionService.recordClaimProgress` — bearer-scoped, best-effort, non-masking (AC5, AC7)

**Files:**

- Modify: `packages/core/src/runbook/claim-id.ts:428-431` (add `progressedClaimRecord` beside `refreshedClaimRecord`)
- Modify: `packages/core/src/runbook/session-service.ts` (add `recordClaimProgress` after `verifyClaimId` at `:361`; add the result type near the file's other result types)
- Test: `packages/core/__tests__/runbook/claim-progress.test.ts` (create)

**Interfaces:**

- Consumes: `parseClaimBearer`, `verifyClaimSecret`, `refreshedClaimRecord`'s sibling shape (all already imported in `session-service.ts:18`), `SessionService.withLock` (`:251`), `progressedClaimRecord` (new, this task).
- Produces — later tasks call exactly this:
  - `function progressedClaimRecord(record: ClaimRecord, now: string): ClaimRecord` — `{ ...record, lastProgressAt: now }`. Does NOT touch `updatedAt`.
  - `type ClaimProgressRecordResult = { readonly kind: 'recorded'; readonly claimKey: ClaimLookupKey; readonly lastProgressAt: string } | { readonly kind: 'no-claim' } | { readonly kind: 'record-failed'; readonly error: unknown }`
  - `SessionService.recordClaimProgress(claimId: ClaimId): Promise<ClaimProgressRecordResult>` — **never throws**.

- [ ] **Step 1: Write the failing unit test**

Create `packages/core/__tests__/runbook/claim-progress.test.ts`. Mirror the setup of an existing `SessionService` suite that uses a real temp workspace — find one with `grep -rln "new SessionService(" packages/core/__tests__/runbook | head` and copy its `beforeEach` (temp dir + `new RunbookStateManager(cwd)` + `new SessionService(manager)` + a started run). `packages/core` tests may construct real core services (CLAUDE.md Testing Conventions).

```typescript
describe('SessionService.recordClaimProgress (#519)', () => {
  it('refreshes lastProgressAt on the presented claim', async () => {
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    const before = claim.lastProgressAt;

    // Any observable forward step in wall-clock time is enough; the timestamp is
    // sourced from the service, not injected (only `claimActivity` injects `now`).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('recorded');
    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    expect(Date.parse(stored.lastProgressAt)).toBeGreaterThanOrEqual(Date.parse(before));
    expect(stored.lastProgressAt).not.toBe(before);
  });

  it('leaves updatedAt untouched', async () => {
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await sessionService.recordClaimProgress(claimId);

    // `updatedAt` means "this record was last written" and keeps that meaning.
    // Conflating the two would let an unrelated future claim write silently
    // refresh the idle clock, so a dead claim would read as live.
    const session = await manager.loadSession();
    expect(session.claims[claim.claimKey].updatedAt).toBe(claim.updatedAt);
  });

  it('refreshes ONLY the presented claim, never another (AC4)', async () => {
    const { claimId: claimA } = await sessionService.issueRunControlClaim(runIdA);
    const { claim: recordB } = await sessionService.issueRunControlClaim(runIdB);
    const beforeB = recordB.lastProgressAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await sessionService.recordClaimProgress(claimA);

    // A parent cannot vouch for a child's liveness and must not appear to.
    const session = await manager.loadSession();
    expect(session.claims[recordB.claimKey].lastProgressAt).toBe(beforeB);
  });

  it('records nothing for a bearer whose secret does not verify', async () => {
    const { claim } = await sessionService.issueRunControlClaim(runId);
    const before = claim.lastProgressAt;
    // Same claim key, wrong secret segment.
    const forged = forgeBearerWithWrongSecret(claim.claimKey);

    const result = await sessionService.recordClaimProgress(forged);

    expect(result.kind).toBe('no-claim');
    const session = await manager.loadSession();
    expect(session.claims[claim.claimKey].lastProgressAt).toBe(before);
  });

  it('records nothing for a claim key that is not in the session', async () => {
    const { claimId } = await sessionService.issueRunControlClaim(runId);
    await sessionService.releaseRunbook(runId);

    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('no-claim');
  });

  it('never throws when the session write fails — it returns record-failed (AC5)', async () => {
    const { claimId } = await sessionService.issueRunControlClaim(runId);
    const saveSpy = jest
      .spyOn(manager, 'saveSession')
      .mockRejectedValue(new Error('disk on fire'));

    // The mutation this recording follows is ALREADY committed. A bookkeeping
    // hiccup must never surface as a failure, or it would mask the committed
    // result (RD-102). The method is total by construction.
    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('record-failed');
    saveSpy.mockRestore();
  });

  it('never throws when the bearer is syntactically invalid', async () => {
    // parseClaimBearer throws on a malformed id; recordClaimProgress swallows it.
    const result = await sessionService.recordClaimProgress('not-a-claim-id' as ClaimId);
    expect(result.kind).toBe('record-failed');
  });
});
```

> `forgeBearerWithWrongSecret` is not a real helper — build the forged id inline from the claim key plus a wrong secret segment using the same shape `parseClaimBearer` expects. Read `packages/core/src/runbook/claim-id.ts` (`generateClaimBearer` / `parseClaimBearer`) for the exact `rdclm_…` layout and construct it literally in the test. If a sibling suite already forges one (`grep -rn "invalid-secret" packages/core/__tests__`), reuse that construction verbatim.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest claim-progress.test.ts`

Expected: FAIL — `sessionService.recordClaimProgress is not a function` (and a TypeScript error: property does not exist).

- [ ] **Step 3: Add `progressedClaimRecord` to `claim-id.ts`**

Add directly after `refreshedClaimRecord` (`:428-431`). Do **not** modify `refreshedClaimRecord`.

```typescript
/**
 * Return a claim record with only its progress timestamp changed.
 *
 * Deliberately distinct from {@link refreshedClaimRecord}: that function moves
 * `updatedAt` ("this record was last written"), while this one moves
 * `lastProgressAt` ("the holder advanced the controlled run"). They coincide
 * today only by accident, and merging them would let an unrelated future claim
 * write silently refresh the idle clock — a safety signal corrupted by an
 * unrelated feature, with no type error to catch it (#519).
 *
 * @param record - Existing persisted claim record.
 * @param now - ISO timestamp of the progress being recorded.
 * @returns Claim record with the new `lastProgressAt`.
 */
export function progressedClaimRecord(record: ClaimRecord, now: string): ClaimRecord {
  return { ...record, lastProgressAt: now };
}
```

- [ ] **Step 4: Add `ClaimProgressRecordResult` and `recordClaimProgress` to `SessionService`**

In `packages/core/src/runbook/session-service.ts`, import `progressedClaimRecord` by extending the existing `./claim-id.js` import block (`:18`). Add the result type near the file's other exported result types (above the class):

```typescript
/**
 * Outcome of a best-effort claim-progress recording.
 *
 * Returned rather than thrown: recording always follows an ALREADY-COMMITTED
 * mutation, so a failure here must be observable to tests but must never
 * propagate to the caller and mask the committed result (RD-102) (#519).
 */
export type ClaimProgressRecordResult =
  | {
      /** The presented claim's `lastProgressAt` was advanced and persisted. */
      readonly kind: 'recorded';
      /** Claim key whose record was advanced. */
      readonly claimKey: ClaimLookupKey;
      /** ISO timestamp written to `lastProgressAt`. */
      readonly lastProgressAt: string;
    }
  | {
      /** No claim matched the presented bearer (missing key or unverified secret). */
      readonly kind: 'no-claim';
    }
  | {
      /** Recording was attempted and failed. Swallowed — never propagated. */
      readonly kind: 'record-failed';
      /** The swallowed cause, surfaced for diagnostics and tests only. */
      readonly error: unknown;
    };
```

Add the method immediately after `verifyClaimId` (`:361-373`), so the read-only verify path and the write-side recording path sit adjacent and their asymmetry is visible:

```typescript
  /**
   * Record that the holder of a presented bearer claim advanced its controlled run.
   *
   * Follows the `unstashForClaimId` template — `withLock` -> verify bearer ->
   * refresh -> `saveSession` — and refreshes EXACTLY the claim whose bearer the
   * caller presented, never another: progress is a property of a single claim and
   * its holder, and a parent cannot vouch for a child's liveness (#519).
   *
   * Call this ONLY after a claim-authenticated mutation has COMMITTED, and ONLY
   * from a mutating path. Deliberately NOT wired into {@link verifyClaimId}: that
   * would make a read-only, lock-free inspection take the session lock, and — worse
   * — a stuck child polling `rundown status --claim-id` would refresh its own claim
   * forever and never report idle, a false negative on precisely the case being
   * detected.
   *
   * Best-effort and TOTAL: this method never throws. The run mutation it follows
   * lives in `.rundown/runs/` under `RunStateLock` while the claim lives in
   * `session.json` under `SessionLock` — different files, different locks, no
   * atomicity. Failing to record under-reports progress, costing one spurious idle
   * report and one wasted check; failing a user's `rundown pass` because a
   * bookkeeping write hiccuped would be indefensible (RD-102).
   *
   * @param claimId - Bearer claim id presented by the caller on the mutation.
   * @returns Typed recording outcome. Never rejects.
   */
  async recordClaimProgress(claimId: ClaimId): Promise<ClaimProgressRecordResult> {
    try {
      return await this.withLock(async () => {
        const parsed = parseClaimBearer(claimId);
        const session = await this.manager.loadSession();
        if (!Object.hasOwn(session.claims, parsed.claimKey)) {
          return { kind: 'no-claim' };
        }
        const claim = session.claims[parsed.claimKey];
        if (!verifyClaimSecret(parsed.secret, claim.secretHash)) {
          return { kind: 'no-claim' };
        }
        const now = new Date().toISOString();
        session.claims[parsed.claimKey] = progressedClaimRecord(claim, now);
        await this.manager.saveSession(session);
        return { kind: 'recorded', claimKey: parsed.claimKey, lastProgressAt: now };
      });
    } catch (error: unknown) {
      // Intentionally swallowed — see the best-effort note above. Nothing here may
      // reach the caller, whose mutation is already committed.
      return { kind: 'record-failed', error };
    }
  }
```

> The `try` wraps `withLock`, not just the body, so a lock-acquisition failure and a `parseClaimBearer` throw on a malformed bearer are also swallowed. That is deliberate: totality is the contract.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest claim-progress.test.ts`

Expected: PASS (all seven cases).

- [ ] **Step 6: Confirm `verifyClaimId` is still read-only and lock-free**

Run: `grep -n "async verifyClaimId" -A 14 packages/core/src/runbook/session-service.ts`

Expected: the body still has no `withLock`, no `saveSession`, and no `recordClaimProgress`. This is the rejected "heartbeat on every verify" design — the anti-fooling invariant depends on it staying read-only. Task 4 pins it with a test.

- [ ] **Step 7: Run the session suites for regression**

Run: `pnpm --filter @rundown-org/core exec jest session`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/runbook/claim-id.ts \
  packages/core/src/runbook/session-service.ts \
  packages/core/__tests__/runbook/claim-progress.test.ts
git commit -m "feat(core): record best-effort claim progress on the presented bearer (#519)"
```

---

## Task 4: Wire recording into every command that changes runbook workflow state (AC3, AC5, AC7, AC11)

**Files:**

- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` — end of `runTransition` (`:1293-1400`, the `#drive` return at ~`:1398`), `issueDelegation` (`:841+`), and `runTerminal` (`:1417+`)
- Modify: `packages/core/src/runbook/collection-service.ts:40-55` (`CollectionSessionService`) and the `collection_applied` returns (`:527`, `:585`)
- Modify: `packages/cli/src/helpers/goto-workflow.ts:42-61` (`GotoContext`), `:159-200` (`buildGotoContext`), `:306-325` (`executeGoto`)
- Modify: `packages/cli/src/commands/goto.ts` (thread `claimId` into `buildGotoContext`'s options — it is already parsed there for the seam)
- Modify: `packages/cli/src/commands/abort.ts:203-235` (record after the cancellation commits)
- Test: `packages/core/__tests__/runbook/claim-progress.test.ts` (extend with the seam-level integration cases)

**Interfaces:**

- Consumes: `SessionService.recordClaimProgress(claimId): Promise<ClaimProgressRecordResult>` (Task 3). Never throws, so no call site needs a `try`.
- Produces: no new exported symbols. `CollectionSessionService` gains `recordClaimProgress(claimId: ClaimId): Promise<ClaimProgressRecordResult>`.

**Scope note (read before implementing).** The predicate is **"changes runbook workflow state"**, not "mutates". The **eight** commands that satisfy it all record — `pass`, `fail`, `complete`, `stop`, `collect`, `delegate`, `goto`, `abort` — and there is **no exception list**.

Two things this task must NOT do, for opposite reasons:

- **Do NOT special-case away the claim-terminating commands** (`complete`, `stop`, `abort`) on the reasoning that their claim is leaving the reportable population. That write is redundant and harmless, and the point is a predicate with no exceptions to remember. These DO satisfy the predicate.
- **Do NOT add recording to `stash` / `pop`** (or `status`) on the reasoning that "they mutate too, and the rule says no exceptions". They are **not exceptions** — they fail the predicate: they change session *targeting*, not the run. Recording them would reopen the anti-fooling hole that disqualified the rejected verify-path design (a child looping `stash`/`pop` fakes liveness without advancing anything — same defect as polling `status`, different door). Task 5 pins this direction too.

The eight commands reach `recordClaimProgress` through **six** call sites, because several share a seam:

| Command(s) | Seam | Records on |
| --- | --- | --- |
| `pass`, `fail` | `LifecycleCommandService.runTransition` (core) | `applied` |
| `complete`, `stop` | `LifecycleCommandService.runTerminal` (core) | `applied_claim`, `applied_bare` |
| `delegate` | `LifecycleCommandService.issueDelegation` (core) | `delegated`, `retried` |
| `collect` | `RunbookCollectionService.collectDelegationOutcomes` (core) | `collection_applied` |
| `goto` | `executeGoto` (CLI — core seam is a gate only) | successful `sendAndSync` |
| `abort` | `abort.ts` (CLI — core seam is a gate only) | committed cancellation |

- [ ] **Step 1: Write the failing seam integration tests**

Append to `packages/core/__tests__/runbook/claim-progress.test.ts`. These need a claimed delegated child; mirror the fixture an existing suite already uses — `grep -n "issueRunControlClaim\|claimDelegationToken" packages/core/__tests__/runbook/lifecycle-command-service.test.ts | head` — and reuse its setup rather than inventing one.

```typescript
describe('progress recording across mutating seams (#519)', () => {
  it('records progress on a SUCCESSFUL claim-authenticated pass (AC3)', async () => {
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    const before = (await manager.loadSession()).claims[claim.claimKey].lastProgressAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
    });
    expect(outcome.kind).toBe('applied');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastProgressAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('does NOT record progress on `status --claim-id` — the anti-fooling invariant', async () => {
    // THE load-bearing test of this change. `verifyClaimId` is the read-only path
    // `status --claim-id` takes. If a bearer presentation refreshed the mark, a
    // stuck child polling its own status would refresh forever and never report
    // idle — a false negative on precisely the case #519 detects. This is why the
    // "heartbeat on every verifyClaimId" design was rejected.
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    const before = (await manager.loadSession()).claims[claim.claimKey].lastProgressAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const verified = await sessionService.verifyClaimId(claimId);
    expect(verified.status).toBe('verified');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastProgressAt;
    expect(after).toBe(before);
  });

  it('does NOT record progress on a FAILED claim-authenticated mutation (AC3)', async () => {
    // A child whose `pass` is refused proved it is alive but did NOT advance the
    // run. `lastProgressAt` means "the run advanced at T", so a live-but-erroring
    // child correctly reads as idle — a true positive worth surfacing.
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    // Drive the claim's run terminal so a further transition is refused.
    await manager.updateWithState(runId, () => ({ lifecycle: 'completed' as const }));
    const before = (await manager.loadSession()).claims[claim.claimKey].lastProgressAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
    });
    expect(outcome.kind).not.toBe('applied');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastProgressAt;
    expect(after).toBe(before);
  });

  it('a failed progress write neither fails nor masks the committed mutation (AC5, RD-102)', async () => {
    const { claimId } = await sessionService.issueRunControlClaim(runId);
    const saveSpy = jest
      .spyOn(manager, 'saveSession')
      .mockRejectedValue(new Error('session write exploded'));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
    });

    // The run mutation COMMITTED under RunStateLock before the session write was
    // ever attempted. The bookkeeping failure must be invisible here.
    expect(outcome.kind).toBe('applied');
    saveSpy.mockRestore();
    const state = await manager.load(runId);
    expect(state?.step).not.toBe(startingStep);
  });

  it('adoption self-heals: a fresh session mutating with the bearer clears idle (AC9)', async () => {
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    // Backdate the mark far past the threshold — the claim reads idle.
    const session = await manager.loadSession();
    session.claims[claim.claimKey] = {
      ...session.claims[claim.claimKey],
      lastProgressAt: '2020-01-01T00:00:00.000Z',
    };
    await manager.saveSession(session);
    expect(
      claimActivity(
        (await manager.loadSession()).claims[claim.claimKey],
        new Date(),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(true);

    // A fresh session presenting the bearer on a MUTATING command genuinely is the
    // new live holder making progress — so recovery is adoption, not reclamation.
    const adopting = new SessionService(new RunbookStateManager(cwd));
    const outcome = await buildSeam(cwd).runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
    });
    expect(outcome.kind).toBe('applied');
    void adopting;

    expect(
      claimActivity(
        (await manager.loadSession()).claims[claim.claimKey],
        new Date(),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(false);
  });

  it('adoption does NOT self-heal via `status --claim-id` (AC9)', async () => {
    // Reading a claim advances nothing. Adoption via status alone must not clear idle.
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    const session = await manager.loadSession();
    session.claims[claim.claimKey] = {
      ...session.claims[claim.claimKey],
      lastProgressAt: '2020-01-01T00:00:00.000Z',
    };
    await manager.saveSession(session);

    await new SessionService(new RunbookStateManager(cwd)).verifyClaimId(claimId);

    expect(
      claimActivity(
        (await manager.loadSession()).claims[claim.claimKey],
        new Date(),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(true);
  });
});
```

> `buildSeam(cwd)` / `seam` / `startingStep` are placeholders for the suite's own fixture names — take the real ones from the `lifecycle-command-service.test.ts` setup you mirror (`grep -n "buildSeam\|const seam" packages/core/__tests__/runbook/lifecycle-command-service.test.ts | head`). `claimActivity` and `DEFAULT_IDLE_AFTER_MS` import statically from `../../src/runbook/claim-activity.js`.

- [ ] **Step 2: Run the tests to verify the right ones fail**

Run: `pnpm --filter @rundown-org/core exec jest claim-progress.test.ts -t "progress recording across mutating seams"`

Expected: the "records progress on a SUCCESSFUL … pass" and both adoption cases FAIL (the mark never moves — nothing calls `recordClaimProgress` yet). The anti-fooling, failed-mutation, and RD-102 cases PASS already: before the wiring nothing records anywhere, which is trivially what they assert. **That is intended** — they are invariant guards that must stay green after Step 3, not red→green drivers. Confirm they are still green at Step 5.

- [ ] **Step 3: Record after `runTransition` commits**

In `packages/core/src/runbook/lifecycle-command-service.ts`, `runTransition` currently ends (`~:1398`) with:

```typescript
    return this.#drive(input, steps, ready.state, terminalReleaseMode, guardOpenChildren);
```

Replace with:

```typescript
    const outcome = await this.#drive(input, steps, ready.state, terminalReleaseMode, guardOpenChildren);
    // Ordering is fixed: verify bearer -> authorize grant -> commit mutation ->
    // best-effort record progress (#519). Recorded on SUCCESS, not on attempt: a
    // child whose transition is refused proved it is alive but did not advance the
    // run, and `lastProgressAt` means "the run advanced at T". `recordClaimProgress`
    // never throws, so this can never mask the committed transition (RD-102).
    if (outcome.kind === 'applied' && input.callerEvidence.kind === 'claim_bearer') {
      await sessionService.recordClaimProgress(input.callerEvidence.claimId);
    }
    return outcome;
```

> `sessionService` is already destructured at the top of the method (`:1294`). The claim recorded is `input.callerEvidence.claimId` — the bearer the caller PRESENTED — never `target.claimId` or any claim discovered during resolution (AC4).

- [ ] **Step 4: Record after `issueDelegation` commits**

In the same file, `issueDelegation` (`:841`) returns a `DelegationIssuanceOutcome`. Wrap its return so the two committed-success members record. Find the method's terminal `return` statements and route them through a single tail — if the method has multiple success returns, extract the body into a private `#issueDelegationInner(input)` and make `issueDelegation` the recording wrapper:

```typescript
  /**
   * Issue (or retry) a delegation, recording the presenter's claim progress on success.
   *
   * @param input - Delegation issuance input carrying the caller's evidence.
   * @returns The issuance outcome, unchanged by the recording tail.
   */
  async issueDelegation(input: DelegationIssuanceInput): Promise<DelegationIssuanceOutcome> {
    const outcome = await this.#issueDelegationInner(input);
    // Only a COMMITTED issuance/retry advanced the run (#519). `already_delegated`
    // is an echo of a prior issuance and commits nothing new, so it records nothing.
    if (
      (outcome.kind === 'delegated' || outcome.kind === 'retried') &&
      input.callerEvidence.kind === 'claim_bearer'
    ) {
      await this.#deps.sessionService.recordClaimProgress(input.callerEvidence.claimId);
    }
    return outcome;
  }
```

> Confirm the exact success member names before writing: `grep -n "readonly kind: '" packages/core/src/runbook/lifecycle-command-service.ts | sed -n '/281,400p/'` — or read the `DelegationIssuanceOutcome` union at `:281`. Use the real members; `delegated` and `retried` are the two the sibling #586 plan names. If `already_delegated` is spelled differently, still exclude it — the rule is "commits nothing new records nothing".

- [ ] **Step 4b: Record after `runTerminal` commits (complete / stop)**

In the same file, `runTerminal` (`:1417`) dispatches to `#driveTerminalClaim` / `#driveTerminalBare` / `#driveTerminalRun` and returns their outcome directly. Apply the same wrapper shape as `issueDelegation`: rename the existing method body to `#runTerminalInner(input)` and make `runTerminal` the recording wrapper:

```typescript
  /**
   * Force a run (or an inline chain) terminal, recording the presenter's claim
   * progress on success.
   *
   * Recording on a claim-TERMINATING command is deliberate and not special-cased
   * away: the write is redundant (the claim is leaving the reportable population)
   * but harmless, and it buys a predicate with no exceptions to remember (#519).
   *
   * @param input - Command, caller evidence, target selector, and optional message.
   * @returns The terminal outcome, unchanged by the recording tail.
   */
  async runTerminal(input: LifecycleTerminalInput): Promise<LifecycleTerminalOutcome> {
    const outcome = await this.#runTerminalInner(input);
    // `applied_claim` / `applied_bare` are the committed-success members.
    // `terminal_claim_confirmed` and `already_terminal` commit nothing new, so they
    // record nothing — "recorded on success, not on attempt" applies to no-ops too.
    if (
      (outcome.kind === 'applied_claim' || outcome.kind === 'applied_bare') &&
      input.callerEvidence.kind === 'claim_bearer'
    ) {
      await this.#deps.sessionService.recordClaimProgress(input.callerEvidence.claimId);
    }
    return outcome;
  }
```

> Confirm the member names against the union before writing: `grep -n "readonly kind: 'applied_claim'\|readonly kind: 'applied_bare'" packages/core/src/runbook/lifecycle-command-service.ts` (expected around `:578` and `:587`). `applied_bare` is included for uniformity even though a bare path carries no `claim_bearer` evidence — the evidence check is the real gate, so there is no need to reason about which outcome can pair with which selector.

- [ ] **Step 5: Record after `collectDelegationOutcomes` commits**

In `packages/core/src/runbook/collection-service.ts`, extend `CollectionSessionService` (`:40-55`) with:

```typescript
  /**
   * Record best-effort progress for a presented bearer claim after a committed
   * collection. Never throws (#519).
   *
   * @param claimId - Bearer claim id the caller presented.
   * @returns Typed recording outcome, not consumed by the collection seam.
   */
  recordClaimProgress(claimId: ClaimId): Promise<ClaimProgressRecordResult>;
```

`applyCollection` already extracts the presented claim id at `:239` (`input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined`). At the end of `applyCollection`, immediately before each `return { kind: 'collection_applied', ... }` (`:527` terminal arm and `:585` non-terminal arm), add:

```typescript
  // The collection is committed. Record the ORCHESTRATOR's own claim — the bearer
  // this command presented — and NEVER the children's: a parent cannot vouch for a
  // child's liveness and must not appear to (#519 AC4). Best-effort; the callee
  // never throws, so it cannot mask the committed collection (RD-102).
  if (presentedClaimId !== undefined) {
    await input.sessionService.recordClaimProgress(presentedClaimId);
  }
```

> Lift the `:239` claim id into a `presentedClaimId` local reachable from `applyCollection` (it currently lives in the calling scope — pass it in on the `scope` argument object alongside `claim`, or re-derive it from `input.callerEvidence` locally; re-deriving is one line and avoids touching the `scope` type). Only the two `collection_applied` arms record — a refusal, `already_collected`, `collection_frame_not_active`, and `collection_failed` all commit nothing.

- [ ] **Step 6: Record after `goto` commits (CLI call site)**

`resolveRunNavigation` is a gate only — `goto`'s mutation is `sendAndSync` inside `executeGoto`. That is pre-existing architecture and is not restructured here; the CLI invokes the core API rather than re-implementing it.

In `packages/cli/src/helpers/goto-workflow.ts`, add to `GotoContext` (`:42-61`):

```typescript
  /** Bearer claim id presented via `--claim-id`, when the caller named one. */
  claimId?: ClaimId;
```

In `buildGotoContext` (`:186-198`), thread it into the returned `ctx`:

```typescript
      sessionService,
      ...(options.claimId !== undefined ? { claimId: options.claimId } : {}),
      state: outcome.state,
```

In `executeGoto` (`:306`), after the `sendAndSync` success guard and before `output.action(...)`:

```typescript
  const syncResult = await actorService.sendAndSync(state.id, steps, {
    type: 'GOTO',
    target,
  });
  if (!syncResult) {
    return { ok: false, error: 'Failed to initialize runbook engine', code: 'ENGINE_INIT_FAILED' };
  }

  // The GOTO committed. Record the presented bearer's progress via the core
  // SessionService API — best-effort, never throws, so it cannot mask the
  // committed navigation (#519, RD-102). A failed sendAndSync above returned
  // already: recorded on success, not on attempt.
  if (ctx.claimId !== undefined) {
    await ctx.sessionService.recordClaimProgress(ctx.claimId);
  }
```

`executeGoto` destructures `ctx` at `:307` — either add `sessionService` and `claimId` to that destructure or reference `ctx.` as above (as written). In `packages/cli/src/commands/goto.ts`, the parsed `--claim-id` is already passed to `buildGotoContext`'s `options`; confirm with `grep -n "buildGotoContext" -A 6 packages/cli/src/commands/goto.ts` and add `claimId` to the options object if it is not already there.

- [ ] **Step 6b: Record after `abort` commits (CLI call site)**

`AbortCommandService.authorizeAbortCommand` (`abort-command-service.ts:78`) is a gate only — it returns `authorized` / `refused`. `abort`'s mutation is the `manager.update(freshParent.id, {...})` at `packages/cli/src/commands/abort.ts:203`, inside the delegation-lock scope. Same rationale as `goto`: the CLI dispatches into the core API rather than re-implementing it, and Task 5's guard is the guarantee.

In `packages/cli/src/commands/abort.ts`, after the lock is released (`await _lockGuard.release();`, `:224`) and before the success output (`:233`):

```typescript
            await _lockGuard.release();

            // The cancellation COMMITTED at :203. Record the presented bearer's
            // progress via the core SessionService API — best-effort, never throws,
            // so it cannot mask the committed abort (#519, RD-102). Recorded after
            // the lock is released: the session lock is a DIFFERENT lock, and taking
            // it inside the delegation-lock scope would nest two domain locks for a
            // bookkeeping write. The `already_cancelled` early return at :178 commits
            // nothing new and correctly records nothing.
            if (claimTarget.claimId !== undefined) {
              await sessionService.recordClaimProgress(claimTarget.claimId);
            }
```

`sessionService` is already destructured from `buildNonDelegatingLifecycleSeam(cwd)` at `:70`, and `claimTarget` from `parseClaimIdOption(options.claimId, output)` at `:73`. Confirm both names are in scope at the insertion point before writing: `grep -n "sessionService\|claimTarget" packages/cli/src/commands/abort.ts | head`.

- [ ] **Step 7: Run the seam tests to verify they pass**

Run: `pnpm --filter @rundown-org/core exec jest claim-progress.test.ts`

Expected: PASS — all cases, including the three invariant guards that were already green (the anti-fooling one especially: `verifyClaimId` must still not record).

- [ ] **Step 8: Run the surrounding core + CLI suites for regression**

Run: `pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test.ts`
Run: `pnpm --filter @rundown-org/core exec jest collection-service`
Run: `pnpm --filter @rundown-org/core exec jest delegation`
Run: `pnpm --filter @rundown-org/cli exec jest goto`
Run: `pnpm --filter @rundown-org/cli exec jest abort`
Run: `pnpm --filter @rundown-org/core exec jest abort`

Expected: PASS. Recording is additive and swallowing, so no existing outcome changes. Non-core suites that mock `@rundown-org/core` and pass a structural `sessionService` double will need `recordClaimProgress` added to the double (CLAUDE.md: mock injected core services structurally — do NOT reach for `new SessionService(...)` from a mocked module). Find them with `grep -rn "sessionService:" packages/cli/__tests__ | head -20`.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts \
  packages/core/src/runbook/collection-service.ts \
  packages/cli/src/helpers/goto-workflow.ts \
  packages/cli/src/commands/goto.ts \
  packages/cli/src/commands/abort.ts \
  packages/core/__tests__/runbook/claim-progress.test.ts \
  packages/cli/__tests__
git commit -m "feat: record claim progress on every command that changes runbook workflow state (#519)"
```

---

## Task 5: Fail-closed drift guard over the recording set (AC4)

**Files:**

- Create: `packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts`

**Interfaces:**

- Consumes: **`createProgram()` from `packages/cli/src/cli.ts:72`** — the real program, which registers every command. `type RoleSpecificMutationCommand` from `@rundown-org/core` (declared at `subprocess-mutation-boundary.ts:33` as exactly `pass | fail | delegate | goto | complete | stop | collect`), used **only** as a secondary cross-check. `SessionService.recordClaimProgress` (Task 3).
- Produces: no production symbols — this is the guarantee that makes the rule enforceable rather than aspirational.

**Why this task exists.** The recording _seam_ differs per command: six commands record from core, while `goto` and `abort` record from the CLI (their core services are authorization gates that mutate nothing — see Background). Seam uniformity is therefore not available as the guarantee, so the guard is. This is exactly what the spec means by "the guard, not the seam's uniformity, is the guarantee", and it is why the two CLI call sites are acceptable rather than debt.

**The guard pins BOTH directions over all ELEVEN claim-authenticated commands.** Recording-when-it-should is only half of it: a future command that silently _starts_ recording — `stash`, say, or a new session-targeting command — would quietly reopen the anti-fooling hole, and nothing else in the suite would notice. A non-recording classification is a **decision**, not an omission, so the guard asserts it:

| Category                       | Commands                                                                   | Records | Why                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changes runbook workflow state | `pass`, `fail`, `complete`, `stop`, `collect`, `delegate`, `goto`, `abort` | **Yes** | They advance the controlled run — which is what `lastProgressAt` measures.                                                                                                                                                                                              |
| Changes session targeting only | `stash`, `pop`                                                             | **No**  | They ARE claim-authenticated mutations (`stash.ts:19`, `pop.ts:59`) but advance session _targeting_, not the run. Recording them would let a child loop `stash`/`pop` to fake liveness without advancing anything — the rejected verify-path defect through a different door. |
| Changes nothing (read-only)    | `status`                                                                   | **No**  | A stuck child polling its own status must never refresh its own mark.                                                                                                                                                                                                   |

**THE ANCHOR: scan the REAL program.** The guard's left-hand side comes from `createProgram()` (`packages/cli/src/cli.ts:72`) — the same factory the shipped binary uses, which registers every command. Every command it registers with a `--claim-id` option must appear in one of the two classification tables: recording, or non-recording **with a reason**. `pass`/`fail` register `--claim-id` via `PASS_FAIL_VALUE_TAKING_OPTION_NAMES` (`transition-command.ts:92`), so the scan sees them too, as it does `abort` — claim-authenticated and mutating, but taking a token rather than `--run`.

> **The single most important line in this task.** An earlier draft built the scanned program by registering the tables it then compared against. That guard is **tautological and cannot fail**: a new `rundown foo --claim-id` is never imported by the test, so it is never registered, never scanned, never classified — both sides shrink together and the suite stays green while the hole opens. Sourcing the program from `createProgram()` is what makes the left side **independent of the test's own imports**, which is the entire point. If you find yourself calling `register*Command` in this file, stop: you have rebuilt the tautology.
>
> This is not a stylistic preference. Spec `:103` and this plan's Global Constraints stake the acceptability of the CLI-side `goto`/`abort` seams **entirely** on this guard existing. With an inert guard there is no guarantee at all, and the CLI silently owns the policy decision of when progress is recorded.

**`RoleSpecificMutationCommand` is a CROSS-CHECK, not the definition.** An earlier draft typed the recording table `Record<RoleSpecificMutationCommand, RecordingCase>`, claiming that union "IS the codebase's definition of a role-specific mutating command". **It is not.** Its own TSDoc (`subprocess-mutation-boundary.ts:27-32`) defines a **subprocess-trust** concept — "commands whose only available trust is the bare direct-CLI lane" — and its overlap with this plan's eight is a coincidence that is **already imperfect**: `abort` records but is not a member (1 of 8 outside the union today). Binding the two would give one type two meanings, the exact conflation this design rejects for `updatedAt` / `lastProgressAt`, and the union would then drift for subprocess-trust reasons that have nothing to do with idle detection. It appears below only as a cheap cross-check that every member is classified somewhere.

The anchor must be **proven to bite** (Step 3) — a guard that cannot fail is theatre.

- [ ] **Step 1: Write the guard**

Create `packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts`. Match `run-option.test.ts`'s table + `it.each` structure, but source the scanned program from `createProgram()`.

```typescript
// packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts

import { describe, expect, it } from '@jest/globals';
import type { RoleSpecificMutationCommand } from '@rundown-org/core';
// THE anchor. The real program factory the shipped binary uses — it registers
// every command, so this import is what makes the scan INDEPENDENT of this
// test's own knowledge. Never rebuild a program from register*Command here: a
// scan fed by the classification tables can never fail (see "Why this task
// exists"). There must be NO `register*Command` import in this file.
import { createProgram } from '../../src/cli.js';

/** How one claim-authenticated command is driven to a committed success. */
interface RecordingCase {
  /**
   * Drive this command to a SUCCESSFUL mutation using the supplied bearer.
   * Must arrange its own precondition and assert its own exit code, so a
   * silently-refused command cannot masquerade as "recorded nothing".
   */
  readonly driveSuccess: (claimId: string) => Promise<void>;
}

/**
 * Commands that change runbook workflow state, and so record.
 *
 * Keyed by command name and cross-checked below against BOTH the real program's
 * --claim-id surface and core's RoleSpecificMutationCommand union. Deliberately
 * NOT typed `Record<RoleSpecificMutationCommand, …>`: that union is a
 * SUBPROCESS-TRUST concept (subprocess-mutation-boundary.ts:27-32 — "commands
 * whose only available trust is the bare direct-CLI lane"), and its overlap with
 * this set is a coincidence that is already imperfect — `abort` records but is
 * not a member. Binding them would give one type two meanings and let the union
 * drift this guard for reasons unrelated to idle detection.
 */
const RECORDING_COMMANDS: Readonly<Record<string, RecordingCase>> = {
  pass: { driveSuccess: async (id) => driveClaimPass(id) },
  fail: { driveSuccess: async (id) => driveClaimFail(id) },
  complete: { driveSuccess: async (id) => driveClaimComplete(id) },
  stop: { driveSuccess: async (id) => driveClaimStop(id) },
  collect: { driveSuccess: async (id) => driveClaimCollect(id) },
  delegate: { driveSuccess: async (id) => driveClaimDelegate(id) },
  goto: { driveSuccess: async (id) => driveClaimGoto(id) },
  abort: { driveSuccess: async (id) => driveClaimAbort(id) },
};

/**
 * Claim-authenticated commands that do NOT change runbook workflow state, and so
 * do NOT record. These are NOT exceptions to the rule — they fail its predicate.
 *
 * Listed rather than omitted, because a non-recording classification is a
 * DECISION the guard pins in BOTH directions: a future edit that starts recording
 * on one of these fails loudly, which matters because such an edit would quietly
 * reopen the anti-fooling hole and nothing else in the suite would notice.
 */
const NON_RECORDING_CLAIM_COMMANDS: Readonly<Record<string, { readonly reason: string }>> = {
  status: {
    reason:
      'Changes nothing (read-only). A stuck child polling its own status must never refresh its own mark.',
  },
  stash: {
    reason:
      'Changes session targeting only, not the run. IS a claim-authenticated mutation (stash.ts:19) — which is exactly why the predicate is "changes runbook workflow state", not "mutates". Recording it would let a child loop stash/pop to fake liveness without advancing anything.',
  },
  pop: {
    reason:
      'Changes session targeting only, not the run. IS a claim-authenticated mutation (pop.ts:59); see stash. Corroboration: unstashForClaimId already moves updatedAt ("record written"), the field this design deliberately leaves alone.',
  },
};

/**
 * Every command the REAL program exposes with --claim-id, found by walking
 * createProgram() recursively (subcommands included).
 */
function claimAuthenticatedCommandNames(): string[] {
  const names: string[] = [];
  const visit = (command: import('commander').Command): void => {
    if (command.options.some((option) => option.long === '--claim-id')) {
      names.push(command.name());
    }
    for (const child of command.commands) visit(child);
  };
  visit(createProgram());
  return names.sort();
}

describe('claim progress recording drift guard (#519 AC4)', () => {
  // THE ANCHOR: every command the real program exposes with --claim-id must be
  // CLASSIFIED, in one direction or the other. Both failure modes are invisible
  // without this:
  //  - a new workflow-state command that records nothing => a claim reads idle
  //    while advancing, a spurious check nobody traces back to a missing line;
  //  - a new session-targeting command that DOES record => the anti-fooling hole
  //    reopens and the idle signal can be faked.
  // Set equality against the REAL program is what makes it fail closed in both
  // directions. Fed from these tables instead, it could never fail at all.
  it('classifies every command the real program registers with --claim-id', () => {
    const classified = [
      ...Object.keys(RECORDING_COMMANDS),
      ...Object.keys(NON_RECORDING_CLAIM_COMMANDS),
    ].sort();

    // If this fails with an EXTRA command, classify it: does it change runbook
    // workflow state (=> RECORDING_COMMANDS) or only session targeting / nothing
    // (=> NON_RECORDING_CLAIM_COMMANDS, WITH a reason)? Do NOT narrow the scan to
    // make this pass — the scan is the guarantee.
    expect(claimAuthenticatedCommandNames()).toEqual(classified);
  });

  // CROSS-CHECK (not the anchor): core's subprocess-trust union overlaps this set
  // by coincidence. If a member of it is unclassified here, that is worth a look —
  // but `abort` proves the two concepts are NOT the same, so the union is checked
  // for containment only, never for equality.
  it('classifies every RoleSpecificMutationCommand member somewhere', () => {
    const union: readonly RoleSpecificMutationCommand[] = [
      'pass',
      'fail',
      'delegate',
      'goto',
      'complete',
      'stop',
      'collect',
    ];
    for (const name of union) {
      expect(
        name in RECORDING_COMMANDS || name in NON_RECORDING_CLAIM_COMMANDS,
      ).toBe(true);
    }
  });

  it.each(Object.entries(RECORDING_COMMANDS))(
    'records claim progress on a successful %s',
    async (name, { driveSuccess }) => {
      const { claimId, claimKey } = await arrangeFor(name);
      await backdateClaimProgress(workspace, claimKey, '2020-01-01T00:00:00.000Z');

      await driveSuccess(claimId);

      // The rule: EVERY successful claim-authenticated command that changes runbook
      // workflow state records. Including the claim-terminating ones (complete/stop/
      // abort), whose write is redundant but harmless and buys a predicate with no
      // exceptions to remember.
      const after = (await readSession(workspace)).claims[claimKey].lastProgressAt;
      expect(Date.parse(after)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
    },
  );

  it.each(Object.entries(NON_RECORDING_CLAIM_COMMANDS))(
    'does NOT record claim progress on %s',
    async (name, { reason }) => {
      const { claimId, claimKey } = await arrangeFor(name);
      await backdateClaimProgress(workspace, claimKey, '2020-01-01T00:00:00.000Z');

      // Drives the command to a SUCCESSFUL invocation (exit 0) — a refusal would
      // record nothing for the wrong reason and pass this test vacuously.
      await driveNonRecording(name, claimId);

      // The mark must not move. `reason` documents WHY at the failure site: a
      // reader who broke this needs the anti-fooling argument, not just a diff.
      const after = (await readSession(workspace)).claims[claimKey].lastProgressAt;
      expect(after, reason).toBe('2020-01-01T00:00:00.000Z');
    },
  );

  it('a stash/pop loop never clears idle (anti-fooling sibling of the status loop)', async () => {
    // The decisive argument for excluding stash/pop. Both ARE claim-authenticated
    // mutations, so a rule keyed on "mutation" would record them — and then a child
    // could loop them to refresh itself alive forever WITHOUT advancing the run.
    // That is the exact hole that disqualified the rejected verify-path design,
    // reached through a mutating command instead of a read. Same defect, different
    // door. This is the sibling of the `status --claim-id` anti-fooling test in
    // packages/core/__tests__/runbook/claim-progress.test.ts.
    const { claimId, claimKey } = await arrangeStashablePair();
    await backdateClaimProgress(workspace, claimKey, '2020-01-01T00:00:00.000Z');

    for (let i = 0; i < 3; i++) {
      expect((await runCliInProcess(['stash', '--claim-id', claimId], workspace)).exitCode).toBe(0);
      expect((await runCliInProcess(['pop', '--claim-id', claimId], workspace)).exitCode).toBe(0);
    }

    const claim = (await readSession(workspace)).claims[claimKey];
    expect(claim.lastProgressAt).toBe('2020-01-01T00:00:00.000Z');
    // Still idle after six successful claim-authenticated mutations: the signal
    // cannot be faked by a holder that never advances the run.
    expect(claimActivity(claim, new Date(), DEFAULT_IDLE_AFTER_MS).idle).toBe(true);
  });
});
```

> **The `drive*` / `arrangeFor` helpers are the substance of this task, not boilerplate.** Each of the eight recording commands needs a workspace arranged so it reaches a _committed success_ with a bearer — `complete`/`stop` need a running claimed run; `collect` needs a parent with a reported child; `delegate` needs an authored DELEGATE step; `abort` needs a pending token. `arrangeStashablePair` needs a claimed child that is stashable and poppable. Build them on the existing integration fixtures rather than inventing new ones: `packages/cli/__tests__/integration/delegate-workflow.test.ts` (`setupParentWithChildren`, `issueRunControlClaim`, `runCliInProcess`) and `packages/cli/__tests__/helpers/test-utils.ts`; `packages/cli/__tests__/commands/stash-pop.test.ts` already stands up a claimed stash/pop workspace (`:683`) — mirror it. `backdateClaimProgress` / `readSession` are the same local helpers Tasks 6 and 7 use — factor them into `test-utils.ts` so all three suites share one definition.
>
> **Every `drive*` helper must assert its own exit code is 0**, on BOTH the recording and non-recording paths. On the recording path, a command that silently starts refusing would record nothing and the guard would report a _recording_ failure, sending the reader hunting in the wrong place. On the non-recording path it matters more: a refused `stash` records nothing and would pass the assertion **vacuously**, so the guard would keep reporting green while pinning nothing at all. Assert success first, then the timestamp.
>
> `claimActivity` / `DEFAULT_IDLE_AFTER_MS` import from `@rundown-org/core`.

- [ ] **Step 2: Run the guard**

Run: `pnpm --filter @rundown-org/cli exec jest claim-progress-drift-guard.test.ts`

Expected: PASS — all eight recording cases, all three non-recording cases, the stash/pop anti-fooling loop, the `RoleSpecificMutationCommand` containment cross-check, and the classification set equality against the real program.

- [ ] **Step 3: Prove the guard is fail-closed (do not skip)**

"A guard that cannot fail is theatre" — the spec requires the anchor be **proven to bite**. Run each probe, confirm the expected failure, then revert it:

1. **The anchor, unclassified-command direction:** temporarily comment out the `status` entry in `NON_RECORDING_CLAIM_COMMANDS` and re-run. Expected: the classification test FAILS — `status` is present in the `createProgram()` scan but absent from the classified list. **This is the probe the tautological draft could not pass**, because removing the entry also removed the registration that put `status` into the scan. If it does not fail, your scan is still fed by the tables: check that this file imports `createProgram` and no `register*Command`.
2. **The anchor, new-command direction (the case that motivates the whole guard):** temporarily add a throwaway command to `createProgram()` in `packages/cli/src/cli.ts` that registers `--claim-id`:

   ```typescript
   program.command('probe-noop').option('--claim-id <id>', 'probe').action(() => {});
   ```

   Re-run. Expected: the classification test FAILS with `probe-noop` in the scan and unclassified. Revert. This simulates exactly the drift the guard exists to catch — a future `rundown foo --claim-id` that nobody remembered to classify — and it is the probe that proves the left side is genuinely independent of the test's imports.
3. **Behaviour, positive direction:** temporarily comment out the `recordClaimProgress` call in `runTerminal` (Task 4 Step 4b) and re-run. Expected: the `complete` and `stop` cases FAIL. Revert.
4. **Behaviour, negative direction:** temporarily add a `recordClaimProgress` call to `packages/cli/src/commands/stash.ts` (as a careless future edit would) and re-run. Expected: the `does NOT record claim progress on stash` case AND the stash/pop anti-fooling loop both FAIL. Revert. This probe is the point of the whole negative half — without it, nothing proves the guard would catch the anti-fooling hole reopening.

If any probe does NOT produce its expected failure, the guard is not pinning what it claims. **Fix the guard before proceeding** — this is not a formality: a green suite that cannot go red is worse than no suite, because it is trusted, and this guard is the sole justification for letting `goto`/`abort` record from the CLI.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts \
  packages/cli/__tests__/helpers/test-utils.ts
git commit -m "test(cli): pin the claim-progress recording set with a fail-closed drift guard (#519)"
```

---

## Task 6: `rundown status` surfaces `lastProgressAt` / `idleFor` / `idle` (AC9 status)

**Files:**

- Create: `packages/cli/src/helpers/duration.ts`
- Modify: `packages/core/src/output/zod-schemas.ts:390-433` (`DelegationStatusEntrySchema`)
- Modify: `packages/cli/src/helpers/status-builder.ts:46-90` (`StatusOutputData.delegations`), `:275-283` (`ActiveStatusOptions`), `:356-386` (the delegations map)
- Modify: `packages/cli/src/services/renderers/text-renderer.ts:62-71` (the renderer's **own** copy of the delegation entry shape) and `:296-314` (the `--text` delegations renderer) — **the plan previously named neither, and the `--text` fields are invisible without both**
- Modify: `packages/cli/src/commands/status.ts:43-52` (the #531 claim join)
- Test: `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts` (create), `packages/cli/__tests__/helpers/status-builder.test.ts` (extend)

**Interfaces:**

- Consumes: `claimActivity`, `DEFAULT_IDLE_AFTER_MS`, `ClaimActivity`, `DurationMs`, `RundownError` from `@rundown-org/core` (Task 2).
- Produces:
  - `packages/cli/src/helpers/duration.ts`: `function humaniseDurationMs(value: DurationMs): string`.
  - `packages/core/src/runbook/claim-activity.ts` also exports the read-boundary union — **this** is the union that earns its keep, unlike the flattened `ClaimActivity`, because its members carry different data and every consumer must narrow:

    ```typescript
    /**
     * A claim's activity as seen at a read boundary.
     *
     * `unreadable` is a first-class member, not an error path: a corrupt
     * `lastProgressAt` must neither be guessed at (fail-open) nor allowed to erase
     * its siblings from the report. The reader is told this child cannot be
     * assessed, and every other child still renders (#519).
     */
    export type ChildActivity =
      | { readonly kind: 'known'; readonly activity: ClaimActivity }
      | { readonly kind: 'unreadable' };
    ```

  - `ActiveStatusOptions.activityByChildRunId?: ReadonlyMap<string, ChildActivity>`.
  - `DelegationStatusEntrySchema` gains optional `lastProgressAt: string`, `idleFor: number`, `idle: boolean` — present together, and only when `state === 'claimed'` — plus `activityUnreadable?: boolean` for the corrupt case.

- [ ] **Step 1: Write the failing CLI JSON test**

Create `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts`. JSON first per CLAUDE.md Testing Conventions. Mirror the workspace + delegation setup an existing suite uses — `grep -n "setupParentWithChildren\|issueRunControlClaim" packages/cli/__tests__/integration/delegate-workflow.test.ts | head` — and reuse its helpers.

```typescript
describe('rundown status claim activity (#519)', () => {
  it('surfaces lastProgressAt, idleFor and idle on a claimed delegation (JSON)', async () => {
    const { parentRunId } = await setupParentWithChildren();
    const childClaim = await claimChild(workspace, '1.1');

    const status = await runCliInProcess('status', workspace);
    expect(status.exitCode).toBe(0);

    const detail = findDetailOutput<{
      delegations: Array<{
        substep: string;
        state: string;
        claimKey: string;
        lastProgressAt: string;
        idleFor: number;
        idle: boolean;
      }>;
    }>(status.stdout);
    const entry = detail!.delegations.find((d) => d.substep === '1.1');
    expect(entry).toBeDefined();
    expect(entry!.state).toBe('claimed');
    // A freshly claimed child has just made progress: idleFor is small and the
    // claim is not idle. `idleFor` is MILLISECONDS in JSON (the DurationMs wire unit).
    expect(typeof entry!.lastProgressAt).toBe('string');
    expect(entry!.idleFor).toBeGreaterThanOrEqual(0);
    expect(entry!.idleFor).toBeLessThan(60 * 60 * 1000);
    expect(entry!.idle).toBe(false);
    void childClaim;
    void parentRunId;
  });

  it('reports idle:true once lastProgressAt is older than the one-hour threshold (JSON)', async () => {
    await setupParentWithChildren();
    const childClaim = await claimChild(workspace, '1.1');
    await backdateClaimProgress(workspace, childClaim, '2020-01-01T00:00:00.000Z');

    const status = await runCliInProcess('status', workspace);

    const detail = findDetailOutput<{
      delegations: Array<{ substep: string; idle: boolean; idleFor: number }>;
    }>(status.stdout);
    const entry = detail!.delegations.find((d) => d.substep === '1.1');
    expect(entry!.idle).toBe(true);
    expect(entry!.idleFor).toBeGreaterThan(60 * 60 * 1000);
  });

  it('omits activity fields on a pending (unclaimed) delegation (JSON)', async () => {
    // Activity is a property of a CLAIM. A pending delegation has no claim record,
    // so there is nothing to report — and the schema forbids reporting one.
    await setupParentWithChildren();

    const status = await runCliInProcess('status', workspace);

    const detail = findDetailOutput<{
      delegations: Array<{ substep: string; state: string; idle?: boolean }>;
    }>(status.stdout);
    const pending = detail!.delegations.find((d) => d.state === 'pending');
    expect(pending).toBeDefined();
    expect(pending!.idle).toBeUndefined();
  });

  it('keeps other children visible when one claim has a corrupt lastProgressAt (JSON, AC6)', async () => {
    // The fail-open this design must not have. `z.string().min(1)` admits
    // 'not-a-date' and Task 1's guard only checks key PRESENCE, so this state is
    // reachable on disk. A boundary that caught around the whole join and returned
    // nothing would erase the healthy child too, and status would imply all is
    // well — strictly worse than the NaN comparison AC6 rejects.
    await setupParentWithChildren();
    const corruptChild = await claimChild(workspace, '1.1');
    const healthyChild = await claimChild(workspace, '1.2');
    await backdateClaimProgress(workspace, corruptChild, 'not-a-date');
    await backdateClaimProgress(workspace, healthyChild, '2020-01-01T00:00:00.000Z');

    const status = await runCliInProcess('status', workspace);

    // A read-only command must not die on corrupt advisory data...
    expect(status.exitCode).toBe(0);
    const detail = findDetailOutput<{
      delegations: Array<{
        substep: string;
        idle?: boolean;
        idleFor?: number;
        activityUnreadable?: boolean;
      }>;
    }>(status.stdout);

    // ...the corrupt child is reported as unreadable, never as a guessed value...
    const corrupt = detail!.delegations.find((d) => d.substep === '1.1');
    expect(corrupt!.activityUnreadable).toBe(true);
    expect(corrupt!.idle).toBeUndefined();

    // ...and its sibling is still fully visible and still reads idle.
    const healthy = detail!.delegations.find((d) => d.substep === '1.2');
    expect(healthy!.idle).toBe(true);
    expect(healthy!.idleFor).toBeGreaterThan(60 * 60 * 1000);
  });

  it('renders humanised idle time in --text', async () => {
    await setupParentWithChildren();
    const childClaim = await claimChild(workspace, '1.1');
    await backdateClaimProgress(workspace, childClaim, '2020-01-01T00:00:00.000Z');

    const status = await runCliInProcess('status --text', workspace);

    // `--text` is the human format: humanised, never raw milliseconds.
    expect(status.stdout).toContain('idle');
    expect(status.stdout).not.toContain('idleFor');
  });
});
```

> `claimChild`, `backdateClaimProgress`, and `findDetailOutput` are placeholders for the suite's real helpers. `findDetailOutput` — check `packages/cli/__tests__/helpers/test-utils.ts` for the existing status-detail reader (`grep -n "export function find" packages/cli/__tests__/helpers/test-utils.ts`); use the real name. `backdateClaimProgress` is a local test helper you write in this file: read `.rundown/session.json`, set the claim's `lastProgressAt`, write it back. `claimChild` should run `rundown claim <token>` against the pending substep's token from `status` output and return the bearer.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/cli exec jest claim-idle-surfaces.test.ts -t "rundown status claim activity"`

Expected: FAIL — the `delegations` entries carry no `lastProgressAt` / `idleFor` / `idle`, so `entry!.idle` is `undefined`.

- [ ] **Step 3: Add the activity fields to `DelegationStatusEntrySchema`**

In `packages/core/src/output/zod-schemas.ts`, inside the object (`:390-416`), after `claimKey`:

```typescript
    /** ISO timestamp when the claim's holder last advanced the child run (#519) */
    lastProgressAt: z
      .string()
      .optional()
      .describe("ISO timestamp of the claim holder's last recorded progress"),
    /** Milliseconds elapsed since that progress (DurationMs wire unit) (#519) */
    idleFor: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Milliseconds elapsed since the last recorded progress'),
    /** Advisory: no progress recorded for longer than the idle threshold (#519) */
    idle: z
      .boolean()
      .optional()
      .describe('Advisory idle label; nothing expires or is reclaimed at this boundary'),
    /** The claim's lastProgressAt is corrupt, so no activity could be derived (#519) */
    activityUnreadable: z
      .boolean()
      .optional()
      .describe('The claim record has an unparseable lastProgressAt; activity cannot be derived'),
```

Add these refines after the existing `claimKey` refines (`:426-433`), keeping the same style:

```typescript
  .refine(
    (entry) =>
      entry.state === 'claimed' ||
      (entry.lastProgressAt === undefined &&
        entry.idleFor === undefined &&
        entry.idle === undefined &&
        entry.activityUnreadable === undefined),
    {
      message: 'claim activity is only available when state is claimed',
      path: ['idle'],
    },
  )
  .refine((entry) => !(entry.activityUnreadable === true && entry.idle !== undefined), {
    message: 'an unreadable claim activity cannot also report an idle label',
    path: ['activityUnreadable'],
  })
  .refine(
    (entry) =>
      (entry.lastProgressAt === undefined) === (entry.idleFor === undefined) &&
      (entry.idleFor === undefined) === (entry.idle === undefined),
    {
      message: 'lastProgressAt, idleFor, and idle must be present together',
      path: ['idle'],
    },
  )
```

> They are optional-when-claimed rather than required-when-claimed (unlike `claimKey`): the join is a read-model lookup, and a claimed delegation whose claim record has been released still renders correctly with no activity. The "present together" refine is what keeps the trio coherent.

- [ ] **Step 4: Add the humaniser**

Create `packages/cli/src/helpers/duration.ts`:

```typescript
// packages/cli/src/helpers/duration.ts

import type { DurationMs } from '@rundown-org/core';

/**
 * Render a duration for human-readable (`--text`) output.
 *
 * JSON is the agent-facing contract and carries raw milliseconds (`DurationMs`);
 * this is the `--text` rendering only. Coarse by design — an advisory idle label
 * does not need sub-second precision.
 *
 * @param value - Duration in milliseconds.
 * @returns A compact humanised string, e.g. `"45s"`, `"12m"`, `"3h 4m"`.
 */
export function humaniseDurationMs(value: DurationMs): string {
  const totalSeconds = Math.floor(value / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${String(totalMinutes)}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`;
}
```

- [ ] **Step 5: Extend the status builder**

In `packages/cli/src/helpers/status-builder.ts`, add to the `delegations` entry type in `StatusOutputData` (`:77-84`), after `claimKey?: string;`:

```typescript
    /** ISO timestamp of the claim holder's last recorded progress (#519). */
    lastProgressAt?: string;
    /** Milliseconds since that progress (#519). */
    idleFor?: number;
    /** Advisory idle label (#519). */
    idle?: boolean;
    /** The claim's lastProgressAt is corrupt and its activity cannot be derived (#519). */
    activityUnreadable?: boolean;
```

Add to `ActiveStatusOptions` (`:275-283`):

```typescript
  /**
   * Session claim activity join map: childRunId -> derived {@link ChildActivity}
   * (#519). Populated from the same `session.claims` pass that builds
   * {@link ActiveStatusOptions.claimKeyByChildRunId}. Advisory only — nothing
   * expires or is reclaimed at the idle boundary. A corrupt record arrives here as
   * the `unreadable` member rather than being dropped, so one bad claim cannot
   * erase its siblings from the report.
   */
  readonly activityByChildRunId?: ReadonlyMap<string, ChildActivity>;
```

(Import `type ChildActivity` from `@rundown-org/core` in this file's existing import block.)

In the delegations map (`:373-386`), beside the `claimKey` lookup:

```typescript
      const claimKey =
        entryState === 'claimed' && childRunId != null
          ? options.claimKeyByChildRunId?.get(childRunId)
          : undefined;
      // Gate on the COMPUTED state exactly as claimKey does: a cancelled-after-claim
      // delegation retains childRunId with state 'cancelled', and attaching activity
      // there would fail the DelegationStatusEntrySchema refine (#519).
      const activity =
        entryState === 'claimed' && childRunId != null
          ? options.activityByChildRunId?.get(childRunId)
          : undefined;
      return {
        substep: ss.id,
        runbook: delegation.childRunbookPath,
        state: entryState,
        ...(childRunId != null ? { childRunId } : {}),
        ...(claimKey != null ? { claimKey } : {}),
        // Narrowing on `kind` is REQUIRED here — the two members carry different
        // data. An unreadable child reports that fact rather than a guessed value.
        ...(activity?.kind === 'known'
          ? {
              lastProgressAt: activity.activity.lastProgressAt,
              idleFor: activity.activity.idleFor,
              idle: activity.activity.idle,
            }
          : {}),
        ...(activity?.kind === 'unreadable' ? { activityUnreadable: true } : {}),
        tokenHash: delegation.tokenHash,
        ...(childRunId == null && delegation.cancelledAt == null && delegation.token != null
          ? { token: delegation.token }
          : {}),
      };
```

- [ ] **Step 6: Build the activity map in `status.ts`**

In `packages/cli/src/commands/status.ts`, extend the #531 join (`:43-52`) — one pass, both maps:

```typescript
          // #531: join session claim records onto claimed delegations so
          // orphaned claims are recoverable from status output. Later
          // `updatedAt` wins on a controlledRunId collision.
          // #519: derive each claim's advisory activity in the same pass. `now` is
          // read here (a CLI-side clock read) and INJECTED into the pure
          // `claimActivity` — the derivation itself never reads a clock.
          const session = await manager.loadSession();
          const now = new Date();
          const claimKeyByChildRunId = new Map<string, string>();
          const activityByChildRunId = new Map<string, ChildActivity>();
          for (const claim of Object.values(session.claims).sort((a, b) =>
            a.updatedAt.localeCompare(b.updatedAt),
          )) {
            claimKeyByChildRunId.set(claim.controlledRunId, claim.claimKey);
            // Contained PER CLAIM. `claimActivity` throws CLAIM_PROGRESS_UNREADABLE
            // on a corrupt timestamp, which `z.string().min(1)` admits and Task 1's
            // presence-only guard does not catch. Two ways to get this wrong:
            //  - no catch at all: the throw escapes a READ-ONLY command as an
            //    unhandled stack trace instead of a JSON error envelope;
            //  - catch around the whole LOOP: one corrupt claim erases every other
            //    claim's activity, so genuinely idle children silently read as
            //    having nothing to report. That is a worse fail-open than the NaN
            //    comparison AC6 exists to reject.
            // So: contain it here, keep every other claim intact, and surface this
            // one as `unreadable` rather than guessing a value for it.
            try {
              activityByChildRunId.set(claim.controlledRunId, {
                kind: 'known',
                activity: claimActivity(claim, now, DEFAULT_IDLE_AFTER_MS),
              });
            } catch (error) {
              if (!(error instanceof RundownError) || error.errorCode.code !== 'RD-824') throw error;
              activityByChildRunId.set(claim.controlledRunId, { kind: 'unreadable' });
            }
          }
          const statusOptions = { claimKeyByChildRunId, activityByChildRunId };
```

Extend the `@rundown-org/core` import at `:4`:

```typescript
import {
  RunbookStateManager,
  RundownError,
  SessionService,
  resolveCommandTarget,
  claimActivity,
  DEFAULT_IDLE_AFTER_MS,
  type ChildActivity,
} from '@rundown-org/core';
```

- [ ] **Step 7: Run the JSON tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli exec jest claim-idle-surfaces.test.ts -t "(JSON)"`

Expected: PASS — the **three JSON cases only**.

> **The `--text` case is still RED here, and that is correct.** An earlier draft claimed "PASS (all four, including `--text`)" at this point while no step had touched a renderer — a green asserted for work not yet done, which trains the implementer to disbelieve the plan's expectations. `--text` goes green in Step 7b, the step that actually renders it.

- [ ] **Step 7b: Render activity in the `--text` delegations renderer**

**This is the step the plan previously omitted entirely.** The `--text` delegations renderer is `packages/cli/src/services/renderers/text-renderer.ts:296-314` — **not** `status-builder.ts` (which builds data, renders nothing) and **not** `collect.ts`. Verify before editing: `grep -n "Show delegations" packages/cli/src/services/renderers/text-renderer.ts`.

It carries its **own structural duplicate** of the delegation entry shape at `:62-71`, independent of `status-builder.ts:77-84`. Add the fields there first or the renderer cannot see them:

```typescript
  delegations?: {
    substep: string;
    runbook: string;
    state: string;
    childRunId?: string;
    /** Non-secret claim lookup key for claimed delegation correlation. */
    claimKey?: string;
    /** ISO timestamp of the claim holder's last recorded progress (#519). */
    lastProgressAt?: string;
    /** Milliseconds since that progress (#519). */
    idleFor?: number;
    /** Advisory idle label (#519). */
    idle?: boolean;
    /** Activity could not be derived from a corrupt record (#519). */
    activityUnreadable?: boolean;
    token?: string;
  }[];
```

Then extend the line at `:312`. **This is a LINE format, not a table** — `` `  ${d.substep}  ${d.runbook}  DELEGATED  ${stateLabel}` `` — so the CLI Output Standards' "UPPERCASE headers, 2-space columns" guidance does not apply here; there are no headers to add a column to. Append a suffix instead:

```typescript
        // #519: advisory idle suffix. JSON carries raw `idleFor` milliseconds (the
        // agent-facing contract); `--text` is the human format and gets it
        // humanised. An unreadable record says so rather than showing a number it
        // does not have.
        const activitySuffix =
          d.activityUnreadable === true
            ? '  IDLE?  (unreadable progress timestamp)'
            : d.idle === true && d.idleFor !== undefined
              ? `  IDLE  (${humaniseDurationMs(d.idleFor as DurationMs)})`
              : '';
        this.writer.writeLine(`  ${d.substep}  ${d.runbook}  DELEGATED  ${stateLabel}${activitySuffix}`);
```

Import `humaniseDurationMs` from `../../helpers/duration.js` and `type DurationMs` from `@rundown-org/core` (confirm the relative depth from `src/services/renderers/` before writing it).

- [ ] **Step 7c: Run the `--text` test to verify it now passes**

Run: `pnpm --filter @rundown-org/cli exec jest claim-idle-surfaces.test.ts -t "rundown status claim activity"`

Expected: PASS — all four now, including `--text`.

- [ ] **Step 8: Add a status-builder unit test for the join and pin `--text` rendering**

Add to `packages/cli/__tests__/helpers/status-builder.test.ts`, mirroring the file's existing `claimKeyByChildRunId` cases (`grep -n "claimKeyByChildRunId" packages/cli/__tests__/helpers/status-builder.test.ts`):

```typescript
  it('attaches claim activity to a claimed delegation (#519)', () => {
    const data = buildActiveStatus(stateWithClaimedDelegation, cwd, undefined, undefined, {
      claimKeyByChildRunId: new Map([[childRunId, claimKey]]),
      activityByChildRunId: new Map([
        [
          childRunId,
          {
            kind: 'known',
            activity: { lastProgressAt: '2020-01-01T00:00:00.000Z', idleFor: 99_999_999, idle: true },
          },
        ],
      ]),
    });

    const entry = data.delegations!.find((d) => d.childRunId === childRunId);
    expect(entry!.idle).toBe(true);
    expect(entry!.idleFor).toBe(99_999_999);
    expect(entry!.lastProgressAt).toBe('2020-01-01T00:00:00.000Z');
    expect(entry!.activityUnreadable).toBeUndefined();
  });

  it('reports an unreadable claim record without a guessed idle label (#519 AC6)', () => {
    // The corrupt case must be VISIBLE and must not carry a fabricated idle value.
    // Reporting `idle: false` here would be the fail-open AC6 exists to prevent.
    const data = buildActiveStatus(stateWithClaimedDelegation, cwd, undefined, undefined, {
      claimKeyByChildRunId: new Map([[childRunId, claimKey]]),
      activityByChildRunId: new Map([[childRunId, { kind: 'unreadable' }]]),
    });

    const entry = data.delegations!.find((d) => d.childRunId === childRunId);
    expect(entry!.activityUnreadable).toBe(true);
    expect(entry!.idle).toBeUndefined();
    expect(entry!.idleFor).toBeUndefined();
  });

  it('never attaches claim activity to a cancelled-after-claim delegation (#519)', () => {
    // A cancelled delegation retains childRunId; attaching activity would fail the
    // DelegationStatusEntrySchema refine.
    const data = buildActiveStatus(stateWithCancelledDelegation, cwd, undefined, undefined, {
      activityByChildRunId: new Map([
        [
          childRunId,
          {
            kind: 'known',
            activity: { lastProgressAt: '2020-01-01T00:00:00.000Z', idleFor: 99_999_999, idle: true },
          },
        ],
      ]),
    });

    const entry = data.delegations!.find((d) => d.childRunId === childRunId);
    expect(entry!.state).toBe('cancelled');
    expect(entry!.idle).toBeUndefined();
  });
```

> The `--text` rendering is already done in Step 7b. **Do not go looking for a delegations table in `output-emitter.ts` or `table-formatter.ts`** — an earlier draft sent readers there, and both have **zero** delegation-rendering hits. The renderer is `text-renderer.ts:296-314`, it is a **line** format with no headers, and "add an `IDLE` column with UPPERCASE headers" is inapplicable to it.

- [ ] **Step 9: Run the status suites**

Run: `pnpm --filter @rundown-org/cli exec jest status`
Run: `pnpm --filter @rundown-org/core exec jest zod-schemas`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/output/zod-schemas.ts \
  packages/cli/src/helpers/duration.ts \
  packages/cli/src/helpers/status-builder.ts \
  packages/cli/src/commands/status.ts \
  packages/cli/__tests__/commands/claim-idle-surfaces.test.ts \
  packages/cli/__tests__/helpers/status-builder.test.ts
git commit -m "feat(cli): surface claim idle activity on rundown status (#519)"
```

---

## Task 7: `rundown collect` surfaces unresolved-child activity (AC9 collect, AC10)

**Files:**

- Modify: `packages/core/src/runbook/command-policy.ts:218-232` (`collection_applied`) and the `collection_frame_not_active` member
- Modify: `packages/core/src/runbook/collection-service.ts:440-600` (`applyCollection`)
- Modify: `packages/cli/src/commands/collect.ts:~250` (`renderAppliedOutcome`) and the `not-active` arm
- Modify: `packages/cli/src/schemas/output-schemas.ts:129-165` (`CollectAppliedResponseSchema`, `CollectNotActiveResponseSchema`)
- Test: `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts` (extend), `packages/core/__tests__/runbook/collection-service.test.ts` (extend)

**Interfaces:**

- Consumes: `CommandTargetReader.listOpenClaimsForParent(parentRunId): Promise<readonly ClaimRecord[]>` (already on `CollectionSessionService` via `command-target-resolver.ts:253`; implemented at `session-service.ts:640`). It returns exactly the non-terminal, not-yet-`done` delegated child claims for a parent — the unresolved children. `claimActivity` / `DEFAULT_IDLE_AFTER_MS` (Task 2).
- Produces:
  - `interface UnresolvedChildActivity { readonly substep: string; readonly childRunId: RunId; readonly claimKey: ClaimLookupKey; readonly lastProgressAt: string; readonly idleFor: DurationMs; readonly idle: boolean }` — exported from `command-policy.ts` next to `DelegationPolicyOutcome`.
  - `collection_applied` and `collection_frame_not_active` each gain `readonly unresolvedChildren: readonly UnresolvedChildActivity[]`.

- [ ] **Step 1: Write the failing core test**

Add to `packages/core/__tests__/runbook/collection-service.test.ts`, mirroring the suite's existing `collection_applied` setup:

```typescript
  it('reports each unresolved child claim with its activity (#519)', async () => {
    // Parent has two delegated children: 1.1 has reported and will be drained,
    // 1.2 is still open. Backdate 1.2's claim far past the threshold.
    const { parentRunId, openChildClaimKey } = await setupPartiallyResolvedParent();
    const session = await manager.loadSession();
    session.claims[openChildClaimKey] = {
      ...session.claims[openChildClaimKey],
      lastProgressAt: '2020-01-01T00:00:00.000Z',
    };
    await manager.saveSession(session);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: await requireState(parentRunId),
      steps,
      callerEvidence: { kind: 'claim_bearer', claimId: parentClaimId },
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome.kind).toBe('collection_applied');
    if (outcome.kind !== 'collection_applied') throw new Error('expected collection_applied');
    // The parent resuming after its child's turn sees WHICH children are not
    // progressing, without issuing a second command.
    const child = outcome.unresolvedChildren.find((c) => c.substep === '1.2');
    expect(child).toBeDefined();
    expect(child!.idle).toBe(true);
    expect(child!.lastProgressAt).toBe('2020-01-01T00:00:00.000Z');
    expect(child!.claimKey).toBe(openChildClaimKey);
  });

  it('reports the CHILDREN\'s activity while refreshing only the orchestrator\'s own claim (#519 AC4)', async () => {
    const { parentRunId, openChildClaimKey } = await setupPartiallyResolvedParent();
    const before = (await manager.loadSession()).claims[openChildClaimKey].lastProgressAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await collectionService.collectDelegationOutcomes({
      targetState: await requireState(parentRunId),
      steps,
      callerEvidence: { kind: 'claim_bearer', claimId: parentClaimId },
      frame: activeFrame(frameKey, 1),
    });

    // The collect refreshes the ORCHESTRATOR's claim. The child's claim is
    // REPORTED ON, never refreshed — a parent cannot vouch for a child's liveness.
    const after = (await manager.loadSession()).claims[openChildClaimKey].lastProgressAt;
    expect(after).toBe(before);
    expect((await manager.loadSession()).claims[parentClaimKey].lastProgressAt).not.toBe(
      parentProgressBefore,
    );
  });
```

> `setupPartiallyResolvedParent`, `requireState`, `parentClaimId`, `parentClaimKey`, `parentProgressBefore`, `steps`, `frameKey` are placeholders for the suite's own fixtures — take the real ones from `collection-service.test.ts` (`grep -n "collectDelegationOutcomes" -B 20 packages/core/__tests__/runbook/collection-service.test.ts | head -60`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest collection-service.test.ts -t "unresolved child"`

Expected: FAIL — `outcome.unresolvedChildren` does not exist (TypeScript error).

- [ ] **Step 3: Add `UnresolvedChildActivity` to the policy outcome**

In `packages/core/src/runbook/command-policy.ts`, above `DelegationPolicyOutcome` (`:136`):

```typescript
/**
 * Advisory activity of one unresolved delegated child, joined onto a collection
 * outcome that reports `unresolved` (#519).
 *
 * Reports the CHILD's activity. The orchestrator's own claim is refreshed by the
 * collect itself; a child's claim is never refreshed by its parent's command.
 * `unresolvedChildren.length` may be LESS than `unresolved`: `unresolved` counts
 * unresolved substeps, while this lists only those with a claimed child (a pending,
 * unclaimed delegation has no claim record and therefore no activity to report).
 */
export interface UnresolvedChildActivity {
  /** Parent substep id that owns the delegation (e.g. "1.2"). */
  readonly substep: string;
  /** Child run the claim controls. */
  readonly childRunId: RunId;
  /** Non-secret claim lookup key for correlation. */
  readonly claimKey: ClaimLookupKey;
  /** ISO timestamp of the child holder's last recorded progress. */
  readonly lastProgressAt: string;
  /** Milliseconds elapsed since that progress. */
  readonly idleFor: DurationMs;
  /** Advisory idle label. Nothing expires or is reclaimed at this boundary. */
  readonly idle: boolean;
}
```

Add to the `collection_applied` member (`:220-232`), after `unresolved`:

```typescript
      /** Number of outcomes still unresolved after this collection. */
      readonly unresolved: number;
      /** Advisory activity for each unresolved child that has a claim (#519). */
      readonly unresolvedChildren: readonly UnresolvedChildActivity[];
```

Define the member type above them — a **union**, because an unreadable child genuinely has different data (it has no `idleFor` to report) and callers must narrow rather than read a fabricated value:

```typescript
/** Fields identifying an unresolved delegated child, common to both members. */
interface UnresolvedChildIdentity {
  /** Parent substep id owning the delegation. */
  readonly substep: string;
  /** Child run identifier. */
  readonly childRunId: RunId;
  /** Non-secret claim lookup key. */
  readonly claimKey: ClaimLookupKey;
}

/**
 * Advisory activity for one unresolved delegated child (#519).
 *
 * `unreadable` is a first-class member rather than an error path or an omission:
 * a corrupt `lastProgressAt` must not be guessed at (fail-open), and must not
 * remove the child from the report either — a silently shorter list reads as
 * "fewer children need checking", which is the same fail-open wearing a
 * different hat.
 */
export type UnresolvedChildActivity =
  | (UnresolvedChildIdentity & {
      readonly kind: 'known';
      /** ISO timestamp of the child holder's last recorded progress. */
      readonly lastProgressAt: string;
      /** Milliseconds elapsed since that progress. */
      readonly idleFor: DurationMs;
      /** Advisory idle label. */
      readonly idle: boolean;
    })
  | (UnresolvedChildIdentity & {
      readonly kind: 'unreadable';
    });
```

Add the identical pair of lines to the `collection_frame_not_active` member (find it with `grep -n "collection_frame_not_active" -A 14 packages/core/src/runbook/command-policy.ts`).

Import `ClaimLookupKey` and `DurationMs` in this file's existing `@rundown-org/core`-internal import block (`./claim-id.js` and `./claim-activity.js` respectively).

- [ ] **Step 4: Build the list in `applyCollection`**

In `packages/core/src/runbook/collection-service.ts`, add a module-private helper above `applyCollection` (`:440`):

```typescript
/**
 * Derive advisory activity for a parent's unresolved delegated children.
 *
 * Joins `session.claims` by `controlledRunId` exactly as `rundown status` does,
 * via the existing `listOpenClaimsForParent` read — which already excludes
 * terminal children and children whose parent substep is `done`, i.e. exactly the
 * unresolved set. `now` is read here and INJECTED into the pure `claimActivity`.
 *
 * Best-effort at the LIST level (a failed session read yields no list rather than
 * failing a committed collection, RD-102) but NEVER at the per-child level: a
 * corrupt child is reported as `unreadable` and its siblings survive (#519).
 *
 * @param sessionService - Session reader used to list the parent's open child claims.
 * @param parentRunId - Delegating run whose children to inspect.
 * @returns Advisory activity per unresolved child, sorted by substep for stable output.
 */
async function readUnresolvedChildActivity(
  sessionService: CollectionSessionService,
  parentRunId: RunId,
): Promise<readonly UnresolvedChildActivity[]> {
  let claims: readonly ClaimRecord[];
  try {
    // ONLY the session read is contained here. Widening this try to cover the
    // derivation below would mean one corrupt timestamp returns [] and erases
    // EVERY unresolved child — including the genuinely idle ones — so the parent
    // reads "nothing to check". That is a worse fail-open than the NaN comparison
    // AC6 exists to reject, and it is why the catch is scoped this tightly.
    claims = await sessionService.listOpenClaimsForParent(parentRunId);
  } catch {
    // Intentionally ignored — an advisory read must never fail a committed collection.
    return [];
  }

  const now = new Date();
  return claims
    .filter((claim) => claim.delegation !== undefined)
    .map((claim): UnresolvedChildActivity => {
      const base = {
        substep: claim.delegation!.parentStepId,
        childRunId: claim.controlledRunId,
        claimKey: claim.claimKey,
      };
      try {
        const activity = claimActivity(claim, now, DEFAULT_IDLE_AFTER_MS);
        return {
          kind: 'known',
          ...base,
          lastProgressAt: activity.lastProgressAt,
          idleFor: activity.idleFor,
          idle: activity.idle,
        };
      } catch (error) {
        if (!(error instanceof RundownError) || error.errorCode.code !== 'RD-824') throw error;
        // Contained per child: this one cannot be assessed, the rest still report.
        return { kind: 'unreadable', ...base };
      }
    })
    .sort((left, right) => left.substep.localeCompare(right.substep));
}
```

Then in `applyCollection`, add `unresolvedChildren` to the three returns that report `unresolved`:

- the `collection_frame_not_active` return (`:479-485`)
- the terminal `collection_applied` return (`:527-538`)
- the non-terminal `collection_applied` return (`:585-590`)

Each gains, alongside `unresolved: drained.unresolved`:

```typescript
      unresolvedChildren: await readUnresolvedChildActivity(
        input.sessionService,
        input.targetState.id,
      ),
```

> Import `claimActivity`, `DEFAULT_IDLE_AFTER_MS` from `./claim-activity.js`, `RundownError` from `../errors/rundown-error.js`, `type ClaimRecord` from `./claim-id.js`, and `type UnresolvedChildActivity` from `./command-policy.js` in this file's existing import block. Place the `readUnresolvedChildActivity` call AFTER the drain (so a child resolved by this very collect no longer appears) and after the Step 5 (Task 4) `recordClaimProgress` call — the ordering is: commit → record own progress → derive the children's read model.

- [ ] **Step 4b: Make the core test double able to return claims (do this BEFORE Step 5)**

`packages/core/__tests__/runbook/collection-service.test.ts:193-195` stubs `listOpenClaimsForParent` as `async () => []` — **unconditionally**. Every test asserting `unresolvedChildren` content is structurally impossible against that double: the list is always empty, so a green run proves nothing and an implementer following the plan literally will burn time before noticing.

Make the stub configurable, keeping its current behaviour as the default so every existing case in the file is unaffected:

```typescript
  // #519: tests that assert unresolvedChildren need to supply claims. Defaults to
  // [] so every pre-existing case in this suite behaves exactly as before.
  let openClaimsForParent: ClaimRecord[] = [];
  // ...in the double:
      async listOpenClaimsForParent() {
        return openClaimsForParent;
      },
```

Then a test arranges its own claims by assigning `openClaimsForParent` in the case body. Add these two cases:

```typescript
  it('reports advisory activity for each unresolved child (#519)', async () => {
    openClaimsForParent = [claimRecordFor('1.1', '2020-01-01T00:00:00.000Z')];

    const outcome = await applyCollection(collectionInput());

    expect(outcome.kind).toBe('collection_applied');
    const [child] = outcome.unresolvedChildren;
    expect(child.kind).toBe('known');
    expect(child.substep).toBe('1.1');
    expect(child.idle).toBe(true);
  });

  it('keeps healthy children visible when one child has a corrupt timestamp (#519 AC6)', async () => {
    // The decisive case: a list-level catch would return [] here and erase the
    // healthy child, telling the parent nothing needs checking. Containment is
    // per child precisely so that cannot happen.
    openClaimsForParent = [
      claimRecordFor('1.1', 'not-a-date'),
      claimRecordFor('1.2', '2020-01-01T00:00:00.000Z'),
    ];

    const outcome = await applyCollection(collectionInput());

    expect(outcome.unresolvedChildren).toHaveLength(2);
    expect(outcome.unresolvedChildren[0]!.kind).toBe('unreadable');
    expect(outcome.unresolvedChildren[1]!.kind).toBe('known');
    expect(outcome.unresolvedChildren[1]!.idle).toBe(true);
  });
```

> `claimRecordFor(substep, lastProgressAt)` is a local helper you write in this file: a `ClaimRecord` with a `delegation.parentStepId` of `substep` and the given `lastProgressAt`. Build it from the file's existing claim fixture if it has one (`grep -n "secretHash" packages/core/__tests__/runbook/collection-service.test.ts`); otherwise mirror `command-target-resolver.test.ts:73`. `collectionInput()` stands for the file's existing `applyCollection` input builder — use the real one.

- [ ] **Step 5: Run the core tests to verify they pass**

Run: `pnpm --filter @rundown-org/core exec jest collection-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Render `unresolvedChildren` in the CLI**

In `packages/cli/src/schemas/output-schemas.ts`, define the entry schema above `CollectAppliedResponseSchema` (`:129`):

```typescript
const UnresolvedChildIdentitySchema = {
  /** Parent substep id owning the delegation */
  substep: z.string().describe('Parent substep id owning the delegation'),
  /** Child run identifier */
  childRunId: z.string().describe('Child run identifier'),
  /** Non-secret claim lookup key */
  claimKey: z.string().describe('Non-secret claim lookup key'),
};

/**
 * A discriminated union on the wire, mirroring the core type. The `unreadable`
 * member deliberately has NO idleFor/idle: a corrupt record must not be reported
 * with a fabricated value, and an agent reading this must narrow on `kind` rather
 * than trusting a default (#519).
 */
const UnresolvedChildActivitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('known'),
    ...UnresolvedChildIdentitySchema,
    /** ISO timestamp of the child holder's last recorded progress */
    lastProgressAt: z.string().describe("ISO timestamp of the child's last recorded progress"),
    /** Milliseconds elapsed since that progress */
    idleFor: z
      .number()
      .int()
      .nonnegative()
      .describe('Milliseconds since the last recorded progress'),
    /** Advisory idle label */
    idle: z.boolean().describe('Advisory idle label; nothing expires or is reclaimed'),
  }),
  z.object({
    kind: z.literal('unreadable'),
    ...UnresolvedChildIdentitySchema,
  }),
]);
```

Add to both `CollectAppliedResponseSchema` and `CollectNotActiveResponseSchema`, after `unresolved`:

```typescript
  /** Advisory activity for each unresolved child that has a claim (#519) */
  unresolvedChildren: z
    .array(UnresolvedChildActivitySchema)
    .describe('Advisory activity for unresolved delegated children'),
```

In `packages/cli/src/commands/collect.ts`, `renderAppliedOutcome` (`~:250`) JSON branch — add after `unresolved`:

```typescript
        unresolved: outcome.unresolved,
        unresolvedChildren: outcome.unresolvedChildren,
```

And in its `--text` branch, append an advisory line per child needing attention. **Narrowing on `kind` is required** — the `unreadable` member has no `idleFor`, so reading it without narrowing does not compile (which is the union doing its job):

```typescript
  } else {
    output.message(
      `Collected ${String(outcome.applied)} delegation outcome(s) on step ${outcome.step} ` +
        `(${String(outcome.unresolved)} unresolved; lifecycle ${String(outcome.lifecycle)}).`,
      'success',
    );
    for (const child of outcome.unresolvedChildren) {
      // Advisory only: idle is indistinguishable from working. Nothing is expired
      // or reclaimed — the reader decides whether to adopt the claim or abort (#519).
      if (child.kind === 'unreadable') {
        // Surfaced, never silently dropped: a child that cannot be assessed is a
        // child the reader should look at, not one to omit from the report.
        output.message(
          `Substep ${child.substep} (claim ${child.claimKey}) has an unreadable progress ` +
            `timestamp; its activity cannot be assessed.`,
          'info',
        );
      } else if (child.idle) {
        output.message(
          `Substep ${child.substep} (claim ${child.claimKey}) has recorded no progress for ` +
            `${humaniseDurationMs(child.idleFor)}.`,
          'info',
        );
      }
    }
  }
```

Do the same for the `collection_frame_not_active` arm (`renderCollectOutcome`, the `not-active` branch): add `unresolvedChildren: outcome.unresolvedChildren` to its `output.json({...})`. Import `humaniseDurationMs` from `../helpers/duration.js`.

- [ ] **Step 7: Write and run the CLI collect tests**

Add to `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts`:

```typescript
describe('rundown collect claim activity (#519)', () => {
  it('reports each unresolved child with lastProgressAt, idleFor and idle (JSON)', async () => {
    // Parent with two delegated children; 1.1 reports, 1.2 stays open and idle.
    const { childClaim12 } = await setupParentWithOneReportedOneOpen();
    await backdateClaimProgress(workspace, childClaim12, '2020-01-01T00:00:00.000Z');

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const action = findActionOutput<{
      unresolved: number;
      unresolvedChildren: Array<{
        kind: string;
        substep: string;
        idle?: boolean;
        idleFor?: number;
      }>;
    }>(collected.stdout);
    const child = action!.unresolvedChildren.find((c) => c.substep === '1.2');
    expect(child).toBeDefined();
    expect(child!.kind).toBe('known');
    expect(child!.idle).toBe(true);
    // Milliseconds in JSON, matching DurationMs.
    expect(child!.idleFor).toBeGreaterThan(60 * 60 * 1000);
  });

  it('keeps healthy children visible when one child has a corrupt timestamp (JSON, AC6)', async () => {
    // The CLI-boundary sibling of the core case: one unreadable child must not
    // erase the report. A list-level catch would return [] and tell the parent
    // nothing needs checking — the fail-open AC6 exists to reject.
    const { childClaim11, childClaim12 } = await setupParentWithTwoOpenChildren();
    await backdateClaimProgress(workspace, childClaim11, 'not-a-date');
    await backdateClaimProgress(workspace, childClaim12, '2020-01-01T00:00:00.000Z');

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const action = findActionOutput<{
      unresolvedChildren: Array<{ kind: string; substep: string; idle?: boolean }>;
    }>(collected.stdout);
    expect(action!.unresolvedChildren).toHaveLength(2);
    const corrupt = action!.unresolvedChildren.find((c) => c.substep === '1.1');
    expect(corrupt!.kind).toBe('unreadable');
    expect(corrupt!.idle).toBeUndefined();
    const healthy = action!.unresolvedChildren.find((c) => c.substep === '1.2');
    expect(healthy!.kind).toBe('known');
    expect(healthy!.idle).toBe(true);
  });

  it('reports an empty unresolvedChildren list when every child resolved (JSON)', async () => {
    await setupParentWithAllChildrenReported();

    const collected = await runCliInProcess('collect', workspace);

    const action = findActionOutput<{ unresolvedChildren: unknown[] }>(collected.stdout);
    expect(action!.unresolvedChildren).toEqual([]);
  });

  it('renders an advisory idle line in --text', async () => {
    const { childClaim12 } = await setupParentWithOneReportedOneOpen();
    await backdateClaimProgress(workspace, childClaim12, '2020-01-01T00:00:00.000Z');

    const collected = await runCliInProcess('collect --text', workspace);

    expect(collected.stdout).toContain('1.2');
    expect(collected.stdout).toContain('no progress');
    expect(collected.stdout).not.toContain('idleFor');
  });
});
```

Run: `pnpm --filter @rundown-org/cli exec jest claim-idle-surfaces.test.ts -t "rundown collect claim activity"`

Expected: FAIL first (no `unresolvedChildren` in the action object), then PASS after Step 6 is applied.

- [ ] **Step 8: Run the collect suites for regression**

Run: `pnpm --filter @rundown-org/cli exec jest collect`
Run: `pnpm --filter @rundown-org/core exec jest collection`

Expected: PASS. `unresolvedChildren` is a required field on the two outcome members, so any core test constructing those members by literal is a compile error — fix the literal, do not make the field optional.

> `setupParentWithTwoOpenChildren` is a sibling of the suite's existing parent setup — reuse `setupParentWithChildren` from `packages/cli/__tests__/integration/delegate-workflow.test.ts` and claim both children rather than writing a third fixture.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runbook/command-policy.ts \
  packages/core/src/runbook/collection-service.ts \
  packages/cli/src/commands/collect.ts \
  packages/cli/src/schemas/output-schemas.ts \
  packages/core/__tests__/runbook/collection-service.test.ts \
  packages/cli/__tests__/commands/claim-idle-surfaces.test.ts
git commit -m "feat: report unresolved child claim activity on rundown collect (#519)"
```

---

## Task 8: Document both output schemas and verify the whole change (AC10, AC12)

**Files:**

- Modify: `docs/spec/cli-output.md:234-244` (status delegations prose) and a new `## collect` section (insert after the `## claim` section, `:384-417`, keeping the file's command ordering)

- [ ] **Step 1: Document the status activity fields**

In `docs/spec/cli-output.md`, extend the paragraph at `:238-244`:

```markdown
Claimed `delegations` entries MAY carry an optional non-secret `claimKey`
(pattern `rdclk_...`, present only when the entry's `state` is `claimed`) for
correlation. Bearer `claim_id` values are only returned by `rundown claim` and
the `runbook_started` event emitted by `rundown run`; they are never
reconstructed from status output. The Zod `DelegationStatusEntrySchema` in
`@rundown-org/core` remains the single source of truth for the exact per-entry
shape.

Claimed entries MAY additionally carry the advisory progress trio
`lastProgressAt` (ISO timestamp of the claim holder's last recorded progress),
`idleFor` (**milliseconds**), and `idle` (boolean). The three are present
together or not at all, and only when `state` is `claimed`. `lastProgressAt` is
refreshed only by a successful claim-authenticated **mutation** by that claim's
own bearer — `rundown status --claim-id` deliberately does **not** refresh it, so
a stuck child polling its own status cannot mask that it is idle. `idle` is
`true` strictly when `idleFor` exceeds a one-hour threshold; exactly at the
threshold is not idle.

`idle` is **advisory**. Nothing expires, nothing is reclaimed, and no result is
synthesized at the boundary — the label only changes the wording of a report. A
claim crosses back out of `idle` simply by its holder running a mutating command.
Recovery is unchanged: **adopt** the claim by presenting its bearer on a mutating
command (which self-heals `lastProgressAt`), or **abort** it via the
orchestrator's `abort-delegation` grant. In `--text` output `idleFor` is rendered
humanised; JSON is the contract and carries raw milliseconds.
```

- [ ] **Step 2: Add the `## collect` section**

`docs/spec/cli-output.md` currently documents `collect` only in its error cases (`### Collect not authorized for this target`, `:1198`). Add a full section — insert it after the `## claim` section (which ends at `:417`), before `## pass` (`:418`):

````markdown
## collect

### `rundown collect`

**Text:**

```text
Collected 2 delegation outcome(s) on step 1 (1 unresolved; lifecycle running).
Substep 1.2 (claim rdclk_0123456789abcdef0123456789abcdef) has recorded no progress for 3h 12m.
```

**JSON:**

```json
{
  "kind": "collect",
  "action": "collect",
  "status": "applied",
  "parentRunId": "rd_0123456789abcdef0123456789abcdef",
  "applied": 2,
  "unresolved": 1,
  "unresolvedChildren": [
    {
      "substep": "1.2",
      "childRunId": "rd_fedcba9876543210fedcba9876543210",
      "claimKey": "rdclk_0123456789abcdef0123456789abcdef",
      "lastProgressAt": "2026-07-16T05:00:00.000Z",
      "idleFor": 11520000,
      "idle": true
    }
  ],
  "lifecycle": "running",
  "reportedTerminalOutcome": false
}
```

`unresolvedChildren` reports the **children's** advisory activity, joined from
`session.claims` by `controlledRunId` exactly as `rundown status` does, so a
parent resuming after its children's turn sees which children are not progressing
without issuing a second command. `idleFor` is **milliseconds**; `--text` renders
it humanised.

`unresolvedChildren.length` may be less than `unresolved`: `unresolved` counts
unresolved substeps, while `unresolvedChildren` lists only those with a claimed
child — a pending, unclaimed delegation has no claim record and therefore no
activity to report.

The orchestrator's own claim is refreshed by the collect itself; the children's
claims are **reported on, never refreshed**. A parent cannot vouch for a child's
liveness and must not appear to.

The `status: "not-active"` response carries the same `unresolvedChildren` field
alongside its `unresolved` count. `status: "already-aggregated"` does not — it
reports no `unresolved` count either.

`idle` is advisory: nothing expires, nothing is reclaimed, no result is
synthesized. Recovery is to **adopt** the claim (present its bearer on a mutating
command, which self-heals `lastProgressAt`) or **abort** it via the
orchestrator's `abort-delegation` grant.
````

- [ ] **Step 3: Verify AC10 — no machine state, event, expiry, reclaim, or synthesized result**

Run: `git diff main --stat`

Expected: the changed-file list contains **no** file under `packages/core/src/runbook/actors/`, no `compiler*.ts`, no `events/` type, and no state-machine definition. Then:

Run: `git diff main -- packages/core/src packages/cli/src | grep -nE "expire|expiry|reclaim|ttl|TTL|heartbeat|setInterval|setTimeout"`

Expected: no hits in production code (test-only `setTimeout` waits are fine and are not in this diff scope). If anything matches, it is a design violation — the spec's Non-Goals are explicit: no expiry, no reclaim, no auto-abort, no synthesized child PASS/FAIL, no machine state, no events, no `rundown heartbeat`, no probing, no configuration surface.

- [ ] **Step 4: Format and spell-check the docs and code**

Run: `npx prettier --write docs/spec/cli-output.md docs/superpowers/plans/2026-07-16-claim-progress-idle-detection.md`
Run: `pnpm run check:spell`

Expected: PASS. If cspell flags a new term (`humanise`, `rdclk`, `Stryker`), add it to the repo's cspell dictionary the same way existing terms are registered — do not reword the doc to dodge the checker.

- [ ] **Step 5: Run the pre-PR verification gate**

Run: `pnpm run verify`

Expected: PASS (format, spell, lint, tests across all packages). **Mandatory before every push** per CLAUDE.md.

- [ ] **Step 6: Re-run the scoped mutation gate (AC13)**

Run: `pnpm run test:mutate:core -- --mutate packages/core/src/runbook/claim-activity.ts --testFiles packages/core/__tests__/runbook/claim-activity.test.ts,packages/core/__tests__/runbook/claim-activity.properties.test.ts`

Expected: no surviving mutants. A 0.00% score means the test files stopped importing the module statically (#541) — fix the import, not the threshold.

- [ ] **Step 6b: Re-run the drift guard last (AC4)**

Run: `pnpm --filter @rundown-org/cli exec jest claim-progress-drift-guard.test.ts`

Expected: PASS. Run this **after** every other task has landed: it is the one test that fails if any of the eight commands lost its recording call site during the intervening work, which is exactly the drift it exists to catch.

- [ ] **Step 7: Commit**

```bash
git add docs/spec/cli-output.md
git commit -m "docs(spec): document claim idle activity on status and collect (#519)"
```

- [ ] **Step 8: Close #519 via the PR**

The PR description should include `Closes #519`. Note in the body that this discharges cluster #565's (R4 Capability Tier) third exit criterion — "parent-side liveness or lease behavior" — as a **reframing**: no liveness detection and no lease are possible for a claim held by an agent across transient CLI invocations (there is no process to probe and no daemon to reap), so an advisory progress signal is the most the architecture admits. Note also that this is a **breaking change to persisted sessions**: `ClaimRecord.lastProgressAt` is required, and pre-existing sessions are rejected with the finish/prune/restart error rather than migrated (CLAUDE.md § State Persistence). Do NOT edit the epic (#564) or cluster (#565) roadmap status in this PR beyond referencing #519.

---

## Self-Review

**Spec coverage — every Acceptance Criterion maps to at least one task:**

Retraced against the revised (2026-07-16, commit `12146f9b3`) 13-criterion list.

| AC | Requirement | Task |
| --- | --- | --- |
| 1 | `lastProgressAt` exists, required, `= issuedAt` at creation | Task 1 Steps 1-5 (schema + `createClaimRecord`; both production mint sites go through `createClaimRecord`) |
| 2 | Sessions lacking it are rejected; no migration | Task 1 Steps 6-9 (structural guard in `loadSession`, finish/prune/restart message) |
| 3 | Every successful claim-authenticated command that **changes runbook workflow state** refreshes (the eight); session-targeting-only (`stash`, `pop`), read-only (`status`), and failed mutations do not | Task 4 (six call sites covering the eight: `runTransition`, `runTerminal`, `issueDelegation`, `collectDelegationOutcomes`, `executeGoto`, `abort.ts`), whose scope note forbids both adding an exception AND extending to `stash`/`pop`; Task 4 Step 1 (`status --claim-id` anti-fooling + failed-mutation tests); Task 5 (`stash`/`pop`/`status` pinned non-recording + the stash/pop anti-fooling loop) |
| 4 | A fail-closed drift guard **classifies all eleven** and pins the set **in both directions**, **proven to bite** | Task 5 — the three-category classification over all eleven, anchored on a `--claim-id` scan of the **real** `createProgram()` (`cli.ts:72`), so the scan is independent of the test's own imports and cannot shrink with the tables; `RoleSpecificMutationCommand` appears only as a containment cross-check, never as the anchor (it is a subprocess-trust concept, and `abort` already sits outside it). Task 5 Step 3's four revert-after probes prove it bites: probe 2 (a new `--claim-id` command appears unclassified) is the one an anchor fed by its own tables could never pass; probe 4 is the negative direction (a `recordClaimProgress` added to `stash.ts` must fail the suite) |
| 5 | A command refreshes only the claim whose bearer it presented | Task 3 Step 1 ("refreshes ONLY the presented claim"); Task 4 (every call site passes the PRESENTED `callerEvidence.claimId`, never a resolved/other claim); Task 7 Step 1 (collect refreshes the orchestrator, reports on the children) |
| 6 | An unparseable `lastProgressAt` throws rather than classifying as `progressing` | Task 2 Step 1 (the fail-open unit test) + Step 3 (the `Number.isNaN` guard and its `@throws`) |
| 7 | A failed recording never fails and never masks the mutation | Task 3 (`recordClaimProgress` is total by construction — the `try` wraps `withLock`); Task 3 Step 1 + Task 4 Step 1 (the two RD-102 tests) |
| 8 | `claimActivity` pure, injected `now`, discriminated union | Task 2 |
| 9 | `status` + `collect` surface `lastProgressAt`, `idleFor` (ms in JSON), `idle`; JSON default, `--text` on request | Task 6 (status), Task 7 (collect); both JSON-first then `--text` |
| 10 | `docs/spec/cli-output.md` documents both schemas, **including that `unresolvedChildren.length` may be less than `unresolved`** | Task 8 Steps 1-2 (the `## collect` section states the distinction explicitly); Task 7 Step 3 + Step 6 also encode it in the `UnresolvedChildActivity` TSDoc and the Zod `describe` |
| 11 | Adoption from a fresh session via a mutating command clears idle | Task 4 Step 1 (both adoption cases: mutating clears, `status --claim-id` does not) |
| 12 | No machine state, event, expiry, reclaim, or synthesized result | Task 8 Step 3 (explicit diff audit); no task touches `actors/`, the compiler, or any event type |
| 13 | `claim-activity.ts` clears the scoped mutation gate via statically-imported tests | Task 2 Steps 6-8, re-run in Task 8 Step 6 |
| 14 | A corrupt claim record is **contained per child** — reported `unreadable`, siblings still report, no list-level catch, no drop, and never an unhandled error from a read-only command | Task 2 (the typed RD-824 throw the boundaries catch on); Task 6 Step 6 (`status.ts` per-claim containment) + Step 1's corrupt-sibling JSON case + Step 8's builder case; Task 7 Step 4 (`readUnresolvedChildActivity` scopes its catch to the session read ONLY) + Step 4b's core case + Step 7's CLI case |

**Placeholder scan.** No `TBD` / `TODO` / "add appropriate error handling". Every code step shows the exact edit. The steps that resolve a fixture by grep (Task 3 Step 1's forged bearer, Task 4 Step 1's seam fixture, Task 5 Step 1's eight `drive*` helpers, Task 6 Step 1's `findDetailOutput`, Task 7 Step 1's parent setup) each name a concrete existing file and symbol to mirror rather than leaving the setup unspecified — deliberate, because inventing a parallel fixture where the suite already has one is the failure mode those pointers prevent. Task 5's `drive*` helpers are the largest such block and are called out as the substance of that task, not boilerplate.

**Type consistency.** `DurationMs` / `durationMs` / `ClaimActivity` / `ChildActivity` / `claimActivity` / `DEFAULT_IDLE_AFTER_MS` are defined in Task 2 and used with exactly those names in Tasks 4, 6, 7, and 8. `ClaimActivity` is a **readonly interface** (`lastProgressAt`, `idleFor`, `idle`) — every consumer reads `.idle` directly and none narrows, which is precisely why it is not a union. The two unions in this design earn narrowing: `ChildActivity` (`known` | `unreadable`) at the status boundary, and `UnresolvedChildActivity` (`known` | `unreadable`) at the collect boundary — their members carry different data, and an `unreadable` member has no `idleFor` to read. `progressedClaimRecord(record, now)` (Task 3) is distinct from the untouched `refreshedClaimRecord(record, now)` and moves a different field — this asymmetry is the spec's central type-safety argument and must not be collapsed. `ClaimProgressRecordResult` is defined once (Task 3) and referenced by `CollectionSessionService` (Task 4 Step 5). The four core recording call sites all gate on `outcome.kind` ∈ the committed-success members of their own union — `applied` (`runTransition`), `applied_claim`/`applied_bare` (`runTerminal`), `delegated`/`retried` (`issueDelegation`), `collection_applied` (collect) — each verified against the union declaration and each excluding the no-op members (`already_terminal`, `terminal_claim_confirmed`, `already_delegated`, `already_collected`). `ActiveStatusOptions.activityByChildRunId` (Task 6 Step 5) is keyed by `childRunId` string, matching the sibling `claimKeyByChildRunId` exactly and populated in the same loop (Task 6 Step 6). `UnresolvedChildActivity`'s `known` member (Task 7 Step 3) carries `idleFor: DurationMs`, which serialises to a plain number in JSON — the brand is compile-time only, so `output.json` needs no conversion, and `UnresolvedChildActivitySchema`'s `known` member correctly validates `z.number()`. `listOpenClaimsForParent` returns `ClaimRecord[]` whose `delegation?.parentStepId` supplies `substep`; the `.filter((claim) => claim.delegation !== undefined)` before the `!` narrows it, and `listOpenClaimsForParent` only ever returns claims with a `delegation` anyway (`session-service.ts:647` skips the rest) — the filter is the type-level proof, not a behavioural guard.

**The predicate is "changes runbook workflow state", not "mutates" — do not collapse it back.** This is the single most load-bearing sentence in the plan, and the one a future reader is most likely to "simplify". `stash` and `pop` ARE claim-authenticated mutations, so the shorter phrasing sweeps them in and silently reopens the anti-fooling hole. They are **not exceptions** to the rule — that framing is also wrong, and also invites someone to "clean up the carve-out". They fail the predicate. The rule genuinely has no exception list; it has a predicate that three of the eleven commands do not satisfy. Task 5 pins all three, and probe 4 proves the pin is real.

**Previously-flagged items, all now resolved by spec revisions `2013cbcbf` and `12146f9b3`** (retained so a reader of an earlier plan version can see they were closed, not dropped):

1. **`complete`/`stop`/`abort` omitted from recording** — the spec was wrong; now the workflow-state predicate covers all eight (Task 4 + Task 5).
2. **`goto` (and `abort`) recording from the CLI** — approach stands, now spec-backed: their core services are authorization gates that mutate nothing, restructuring them is out of scope for #519, and the drift guard is what makes the differing seams safe.
3. **Corrupt timestamp throws** — now AC6.
4. **`unresolvedChildren.length` may be `<` `unresolved`** — now specified, and required in the docs by AC10.
5. **`stash`/`pop` classification** — surfaced while designing the guard; the owner ruled they are excluded, and the spec now carries the sharper predicate and the decisive anti-fooling argument. Task 5's negative-direction coverage exists because of this.

**One remaining implementation choice, unchanged and unflagged by the spec:** the status activity fields are optional-when-claimed, not required-when-claimed (unlike `claimKey`, which the #531 schema made required). The join is a read-model lookup that can legitimately miss; the "present together" refine is what keeps the trio coherent.

---

## Review round 2: what four reviewers found, and what changed

Every item below was **verified against the tree** before the plan was edited. Recorded because several are traps a fresh implementer would otherwise re-enter — the plan previously asserted each as checked.

**Two criticals, both fixed:**

1. **The drift guard could not fail.** Anchor B built its Commander program by registering the very tables it then compared against, so both sides always shrank together and a new `--claim-id` command was never registered, never classified, never caught. The plan's own probe ("comment out `status`") could not fail either. **Fixed:** the scan now comes from the real `createProgram()` (`cli.ts:72`); Step 3 probe 2 adds a throwaway `--claim-id` command to prove the left side is independent. This mattered beyond the guard: spec `:103` and this plan stake the acceptability of the CLI-side `goto`/`abort` seams **entirely** on the guard, so an inert guard meant no guarantee at all and the CLI silently owning the recording policy.
2. **The fail-open AC6 forbids, reintroduced at the collect boundary.** `try { … } catch { return []; }` around the whole derivation meant one corrupt timestamp erased **every** unresolved child, including genuinely idle ones — worse than the NaN comparison AC6 exists to reject. Reachable, since `z.string().min(1)` admits `'not-a-date'` and Task 1's guard only checks key presence. Status had no containment at all, so the throw escaped a read-only command as a stack trace. **Fixed:** containment is now **per child** on both surfaces, with an `unreadable` union member that keeps siblings visible; both paths are now tested.

**Four "I checked the tree" claims that were false — each dead-ends a fresh agent:**

- `state-schema-version.test.ts` has **zero** `loadSession` occurrences. The real tests are `state.test.ts:820-858`.
- The fixture grep missed **shorthand** properties: **12** files break, not 9, and `delegation-exposure.test.ts` fails at **runtime** via `safeParse`, so a green typecheck is not the completeness guard Step 11 claimed.
- `packages/claude-code-plugin/src/rdpath.ts:70-76` allow-lists session errors by substring and does not match the new message — `rdpath` would lose graceful degradation on exactly the sessions this change invalidates. The plan never mentioned the package.
- The `--text` delegations renderer is `text-renderer.ts:296-314` (with its own duplicate entry shape at `:62-71`), **not** the two files the plan named (zero hits in both). It is a **line** format, so the prescribed "IDLE column with UPPERCASE headers" was inapplicable.

**Plus:** Task 7's core tests were structurally impossible (the double's `listOpenClaimsForParent` returns `[]` unconditionally — now configurable in Step 4b), and Task 6 Step 7 claimed a green for a `--text` test no step had implemented (now Step 7b renders it; Step 7 expects three JSON cases).

**Type and test weaknesses, all addressed:** `ClaimActivity` was a boolean in union costume (identical variants, no caller narrowing) → now a `readonly interface`, matching the spec's own `idle: boolean` naming table. The AC6 throw was a bare `Error` distinguishable from `durationMs`'s bare `Error` — thrown in the same function — only by substring, so a reword would silently gut it → now `RundownError` with `CLAIM_PROGRESS_UNREADABLE` (RD-824), asserted on the code. Three of four property tests restated the implementation and survived any mutation of `>` → replaced with an independent oracle, threshold monotonicity, and skew safety. `test:mutate:core` lacks the trailing `--` that `test:mutate:cli` has, so the AC13 gate silently ran **unscoped** → Task 2 Step 8 now uses the direct filter form.

**What the reviewers confirmed holds** (do not "fix" these): the RD-102 non-masking design genuinely works — wrapping `withLock` captures both acquire failures and `parseClaimBearer` throws, so `recordClaimProgress` is total as advertised; the lock ordering checks out against the documented ABBA proof; claim tombstones survive every terminal path, so the no-exceptions rule has no hole; the #541 static-import mitigation is correct; and all acceptance criteria map to tasks (13 at review time; the spec's rev-3 amendment adds AC14 for per-child containment, mapped above). The CLI-side `goto`/`abort` seam is defensible — both core services really are gates, no cleaner seam exists without restructuring, and recording inside the gate would violate "recorded on success, not on attempt" — **provided the guard is fixed**, which is why the guard's construction is now spelled out at such length.
