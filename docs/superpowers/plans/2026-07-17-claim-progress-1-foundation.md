# Claim Progress: Foundation — Claim Shape, Pure Derivation, Recording API (#519, plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three foundations idle detection is built on — the required `ClaimRecord.lastProgressAt` field (with the no-migration rejection guard), the pure `claim-activity.ts` derivation module, and the best-effort `SessionService.recordClaimProgress` API — so that plan 2 can wire recording into commands and plan 3 can surface it.

**Architecture:** Three independent seams, no machine state, no behaviour change visible to a user yet. (1) `ClaimRecord` gains one **required** field `lastProgressAt`, set to `issuedAt` at creation by `createClaimRecord`; sessions whose persisted claims lack it are **rejected** by a structural guard in `loadSession` with the existing finish/prune/restart error shape — no migration, no hydration, no shim. (2) A new pure module `claim-activity.ts` derives `ClaimActivity` from `(record, now, idleAfter)` with `now` injected — no I/O, no clock read — and throws a typed `RundownError` on a corrupt timestamp rather than failing open. (3) A new `SessionService.recordClaimProgress(claimId)` refreshes exactly one claim — the one whose bearer the caller presented — inside the existing session-lock scope, and never throws, so it cannot mask an already-committed mutation (RD-102).

**What this plan deliberately does NOT do.** Nothing calls `recordClaimProgress` yet — that is plan 2 — and nothing reads activity yet — that is plan 3. `recordClaimProgress` ships as a tested, unused core API. That is the intended seam, not an oversight: the field change is the one breaking, un-revertable-in-place part of #519 and it ships **once**, on its own, where a reviewer can see it whole.

**This plan is 1 of 3. Task numbers are retained from the original single plan (Tasks 1–3 here, 4–5 in plan 2, 6–8 in plan 3)** so that every cross-reference in all three documents stays valid. Do not renumber them.

- Plan 1 (this): `docs/superpowers/plans/2026-07-17-claim-progress-1-foundation.md` — AC1, AC2, AC6, AC7, AC8, AC13
- Plan 2: `docs/superpowers/plans/2026-07-17-claim-progress-2-recording.md` — AC3, AC4, AC5, AC11
- Plan 3: `docs/superpowers/plans/2026-07-17-claim-progress-3-surfaces.md` — AC9, AC10, AC12, AC14

**Task index across the three plans** — cross-references below (and in the shared Global Constraints and Background) use these numbers. A task that is not in this plan is in the plan named beside it.

| Task | Subject | Plan |
| ---- | ------- | ---- |
| 1 | `ClaimRecord.lastProgressAt` — required field, set at creation, rejected when absent | 1 foundation |
| 2 | `claim-activity.ts` — the pure derivation seam | 1 foundation |
| 3 | `SessionService.recordClaimProgress` — bearer-scoped, best-effort, non-masking | 1 foundation |
| 4 | Wire recording into the eight workflow-state commands | 2 recording |
| 5 | Fail-closed drift guard over the recording set (**Step 0 extracts fixtures plan 3 needs**) | 2 recording |
| 6 | `rundown status` surfaces the activity | 3 surfaces |
| 7 | `rundown collect` surfaces unresolved-child activity | 3 surfaces |
| 8 | Document both output schemas and verify the whole change | 3 surfaces |

**Ship order is fixed: 1 -> 2 -> 3.** Plan 2 consumes `recordClaimProgress` (Task 3) and `ClaimActivity` (Task 2); plan 3 consumes both plus the fixtures plan 2 extracts.

**Tech Stack:** TypeScript, Zod (persisted schemas), Jest (unit + integration), fast-check (property), Stryker (scoped mutation), pnpm workspaces. Packages: `@rundown-org/core` (claim shape, pure activity module, recording seam), `@rundown-org/claude-code-plugin` (one line: `rdpath`'s session-error allow-list).


## Acceptance Criteria owned by this plan

Verbatim from `docs/superpowers/specs/2026-07-16-claim-progress-idle-detection-design.md`. The others (AC3/4/5/9/10/11/12/14) belong to plans 2 and 3 and must NOT be attempted here.

- **AC1** — `ClaimRecord.lastProgressAt` exists, is required, and is set to `issuedAt` at claim creation. *(Task 1)*
- **AC2** — Sessions whose claims lack `lastProgressAt` are rejected with a finish/prune/restart error; no migration path exists. *(Task 1)*
- **AC6** — An unparseable `lastProgressAt` throws `CLAIM_PROGRESS_UNREADABLE` rather than classifying as not idle. *(Task 2)*
- **AC7 (TOTALITY HALF ONLY)** — A failure to record progress never fails and never masks the committed mutation. *(Task 3.)* **Tick only the first half here.** Task 3 proves totality — `recordClaimProgress` returns `record-failed` and never throws, under every failure mode. It **cannot** prove "never masks the committed mutation": masking requires a caller whose mutation has committed, and there is no call site until plan 2. Do not read a green Task 3 as AC7 satisfied; plan 2 pins the masking half at each of the eight call sites.
- **AC8** — `claimActivity` is pure and takes an injected `now`. *(Task 2)*
- **AC13** — `claim-activity.ts` clears the scoped mutation gate via statically-imported tests. *(Task 2)*

**AC5** ("a command refreshes only the claim whose bearer it presented") is *begun* here — Task 3 pins that `recordClaimProgress` touches only the presented claim — but is not **satisfied** until plan 2 proves each of the eight call sites passes `callerEvidence.claimId` rather than `target.claimId`. Do not tick AC5 in this plan.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `docs/superpowers/specs/2026-07-16-claim-progress-idle-detection-design.md` (APPROVED — do not redesign, do not soften).

> **These constraints are project-wide across all three plans, and are reproduced identically in each** — #519 is one design, and a constraint you cannot see is a constraint you will violate. So some of them describe work that lands in a *different* plan: the wire-union and `ChildActivity` constraints are discharged by plan 3, the drift guard by plan 2, the field's required-ness by plan 1. **They are here as binding context, not as a work list.** For what THIS plan builds, the File Structure and the task bodies are authoritative — if a constraint describes something no task here touches, that is by design; do not build it early to satisfy the constraint. The `Task N` references resolve via the task index above.

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
- **The `known` | `unreadable` union reaches the JSON on BOTH surfaces — never flattened into optionals.** Containment that stops at the type boundary is not containment. **JSON is the agent-facing contract and the agent has no compiler**, so the wire shape is the only thing that can force the distinction. Flattened into independent optionals, `idle === undefined` means three different things (not claimed / no claim record / corrupt record) and `delegations.filter((d) => d.idle)` — the obvious thing an agent writes — silently skips the corrupt child, the one most worth checking: the same fail-open AC6 rejects, arriving through the wire format instead of a `NaN` comparison. `--text` loudness does not answer this; `--text` is the human format. Both surfaces carry a `z.discriminatedUnion('kind', …)`: `activity` on a status delegation entry (Task 6), `unresolvedChildren[]` on a collect outcome (Task 7). Each union's `known` member spreads its fields **inline** so the core type IS the wire shape and no mapping step can drop `kind` in between.
- **An unparseable `lastProgressAt` THROWS — as a typed `RundownError`, not a bare `Error`.** Never classify it as `progressing`: "every `NaN` comparison is false — so `idleFor > idleAfter` would be false and a dead claim would silently classify as `progressing`. That is the single worst failure this design can have: a safety signal that fails *open*, quietly, in exactly the case it exists to catch." The throw carries `ErrorCodes.CLAIM_PROGRESS_UNREADABLE` (RD-824, added by Task 2) so callers and tests discriminate **on the code**. A bare `Error` would be distinguishable from `assertDurationMs`'s throw — out of the same function — only by message substring, so a harmless reword would silently gut AC6 with every test still green. `assertDurationMs` throws a **`RangeError`** and the `now` precondition throws a `RangeError` too, so plan 3's read boundary sorts all three by TYPE: `RundownError` -> contain as `unreadable`, `RangeError` -> rethrow (caller bug), anything else -> rethrow.
- **`ClaimActivity` is a `readonly interface`, not a union.** A two-member union whose variants carry **identical** fields is a boolean in costume: no caller narrows, both consumers flatten it straight back to `activity.kind === 'idle'`, and the spec's own naming table says `idle: boolean`. Type-driven dispatch means unions that force narrowing — not ceremony that doesn't. The union that **does** earn its keep is `ChildActivity` at the read boundary (`known` | `unreadable`), whose members differ in the data they carry and which callers genuinely must narrow.
- **Recorded on success, not on attempt.** A failed mutation records nothing. "A live-but-erroring child correctly reads as idle — a true positive worth surfacing."
- **A command refreshes only the claim whose bearer it presented.** Never another claim. `collect --claim-id <orchestrator-claim>` refreshes the orchestrator's own claim, **not** the children's. "A parent cannot vouch for a child's liveness, and must not appear to."
- **Recording is best-effort and never masks the mutation.** Ordering is fixed: verify bearer → authorize grant → commit mutation → best-effort record progress. `recordClaimProgress` never throws and never propagates (RD-102 policy).
- **`recordClaimProgress` SELF-ACQUIRES the session lock, and the file lock is NOT reentrant. Never call it from inside a held session lock.** This is a hazard the totality contract actively *hides*, which is why it is a constraint and not a footnote. `withLock` (`session-service.ts:247`) calls `this.lock.acquire()` unconditionally, and `acquireFileLock` reclaims a lock only when its owner is **dead** (`kill(pid, 0)` → ESRCH) — "a well-formed lock owned by a live process is NOT [reclaimed]" (`file-lock.ts:112-114`). Call it from within an existing `withLock` scope and the holder is *yourself*: PID-aware stale detection cannot help, the acquire spins its jittered backoff to the full `LOCK_DEADLINE_MS = 5_000` (`file-lock.ts:23`, `:318-320`), throws `SessionLockTimeoutError` — and `recordClaimProgress`'s outer `catch` silently converts that into `{ kind: 'record-failed' }`. The symptom is a **5-second stall on every affected command plus a claim that silently under-reports progress**, with no error anywhere: totality masking a deadlock instead of exposing it. Plan 2's call sites must invoke it **after** the mutation's lock scope has closed, never nested inside one. `collect` is the live risk — `collection-service.ts:517-525` already calls `sessionService.releaseRunbook`, itself a `withLock` (`session-service.ts:856`).
- **`claimActivity` is pure.** No I/O, no clock read — `now` is injected. `DEFAULT_IDLE_AFTER_MS = 60 * 60 * 1000` (one hour). **No configuration surface in this change.**
- **Advisory only (AC12).** No expiry, no reclaim, no auto-abort, no synthesized child PASS/FAIL, **no machine state, no events**, no `rundown heartbeat` command, no probing. Nothing under `packages/core/src/runbook/compiler*.ts`, `actors/`, or any event type is touched by this plan.
- **`idle` iff `idleFor > idleAfter` — strictly greater.** Exactly at the threshold is `progressing`.
- **JSON is the contract and the default.** `idleFor` is milliseconds in JSON; `--text` renders it humanised. CLI tests exercise the default JSON path first; `--text` is covered separately (CLAUDE.md Testing Conventions).
- **Mutation gate imports must be STATIC.** Per #541's lesson, `claim-activity.test.ts` must import `claim-activity.js` with a top-level static `import`, or Stryker's static related-tests graph will not see the module and it will score 0.00%.
- **Stryker's `--mutate` / `--testFiles` globs are PACKAGE-RELATIVE, not repo-relative.** `pnpm --filter <pkg> exec` runs with cwd = the package dir, so `--mutate packages/core/src/x.ts` matches **nothing** and Stryker reports `Instrumented 0 source file(s) with 0 mutant(s)` and **exits 0** — a gate that cannot fail. Verified by running it. Pass `src/x.ts` / `__tests__/x.test.ts`. `.github/workflows/mutation-pr.yml:96` strips the prefix (`sed "s#^${PKG_DIR}/##"`) for the same reason, and each `stryker.config.mjs`'s own `mutate` array is package-relative (`'src/**/*.ts'`). **Always check the `Instrumented N source file(s)` line before reading a score** — `incremental: true` means a stale baseline can print a plausible score over a zero-mutant run. **Core is excluded from the per-PR mutation matrix** (`mutation-pr.yml:34-42`) and that workflow is `continue-on-error` regardless, so a scoped gate you run by hand is the only mutation signal these plans get on core.
- **TSDoc on every exported symbol** (description, `@param`, `@returns`, `@throws`) per CLAUDE.md TSDoc Standards.
- **Branch: `claim-progress-idle-detection`** — you are already on it; do not switch or create branches within this plan. It carries all three plan documents. **This is plan 1 of three sequential PRs**, so the branch story does not end here: plan 2 cuts a fresh branch from `main` after this PR merges. Do not try to stack plan 2's work on this branch.

---

## Background: what exists today

- `ClaimRecord` (`packages/core/src/runbook/claim-id.ts:89`) has `claimKey`, `secretHash`, `controlledRunId`, `delegation?`, `grants`, `issuedAt`, `updatedAt`.
- `createClaimRecord` (`claim-id.ts:402`) takes `{ ..., now }` and sets `issuedAt: input.now, updatedAt: input.now`. It has exactly **two** production call sites, both in `session-service.ts` (`:335` `mintRunControlClaim`, `:544` the delegated-child mint). Setting `lastProgressAt: input.now` there satisfies AC1 for both.
- `refreshedClaimRecord` (`claim-id.ts:428`) is `{ ...record, updatedAt: now }`. Its only caller is `unstashForClaimId` (`session-service.ts:1060`).
- `SessionService.withLock` (`session-service.ts:247`) is `acquire` + `await using this.lock.held()` + `fn()`. **It is NOT reentrant** — see the Global Constraint on lock reentrancy.
- `SessionService`'s constructor is `constructor(manager: RunbookStateManager, lock?: SessionLock)` (`session-service.ts:230-235`) and defaults to `new SessionLock(manager.cwd)`. A test that wants to spy the lock **passes its own instance** — no DI change, no prototype spy needed.
- `sessionLockPath` is exported from `packages/core/src/paths.ts:211` — **not** from `session-lock.ts`, which only imports it aliased and re-exports `SessionLock` / `SessionLockTimeoutError`.
- `FileLockTimeoutError`'s constructor is `(lockFile: string, message?: string)` (`file-lock.ts:74`). The second argument is a **message override**, not a timeout number.
- **The repo's branded-primitive convention is `declare const … : unique symbol`, NOT `__brand`.** Verified: `__brand` on a primitive appears exactly once in `packages/core/src` (`targeting.ts:20`, `FrameKey`), and in that same file `__brand` is also used as a **runtime property** on `OpenFrames` (`:259`, `:290`) — so it is not even purely a type brand there. Every other brand uses a unique symbol, including all three in `claim-id.ts` (`:7-9`), the module `claim-activity.ts` sits beside: `runIdBrand` (`run-id.ts:1`), `delegationTokenHashBrand` (`delegation-token.ts:13`), `effectiveVarsBrand` (`effective-vars.ts:15`), `flattenedTemplateVarsBrand` (`output-evaluator.ts:53`). **A symbol brand crosses the package boundary fine** — `run-id.ts:1` writes `export declare const runIdBrand: unique symbol` precisely so `RunId` survives into `@rundown-org/cli`, which it does today. `effective-vars.ts:8-14` documents the "purely compile-time" rationale.
- **Production code never calls `new RundownError(...)` directly.** Verified: the only two files in `packages/core/src` containing it are `errors/rundown-error.ts` (the class itself) and `errors/factory.ts`, which holds **42** of them behind the `Errors` object. Every production throw goes through a factory function shaped `name: (args) => new RundownError('CODE', { … })` (`factory.ts:7`).
- **`RundownError.formatMessage` renders a FIXED key list** (`rundown-error.ts:99-134`): `file, step, substep, line, message, expected, found, value, scenario, argName, childId, agentId`. Any other context key lands in `context` (reachable only via `toJSON()`) and is **invisible in `error.message`**. `ErrorContext`'s index signature (`:32`) means TypeScript will not warn you. `value` renders as the primary identifier (quoted); `childId` is the conventional correlation slot.
- `RundownError` exposes a `code` getter (`rundown-error.ts:78`) returning `errorCode.code`, and assigns `errorCode = ErrorCodes[codeKey]` **by reference** (`:60`, `:66`) — so `error.errorCode === ErrorCodes.X` is reference-identity and immune to renumbering.
- `errors.ts:54` ships `isNodeErrorCode(error, code)` — the naming and shape template for a `RundownError` equivalent. No code in the repo discriminates a `RundownError` by code today.
- `assertPositiveEntry` (`targeting.ts:44-48`) throws a **`RangeError`** for a caller-precondition violation — the repo's precedent for "this is a code bug, not bad data".
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
- There was no `DurationMs` type and no duration humaniser in the repo before #519 (verified: no ms-formatting math repo-wide, no `pretty-ms` dependency; `durationMs` exists only as an unbranded *field name* in `command-sequence.ts:94`). **`DurationMs` is introduced by plan 1** (Task 2, in its **own** module `packages/core/src/runbook/duration.ts` — NOT in `claim-activity.ts`); **the humaniser by plan 3** (Task 6, `packages/cli/src/helpers/duration.ts`). The original single-plan draft said "both are introduced by this plan", which is now true of neither plan 2 nor plan 3 — check the task index before assuming either is yours to build. The branded-primitive convention to follow is the **unique-symbol** form used by `run-id.ts:1` / `claim-id.ts:7-9` / `delegation-token.ts:13` — **not** `targeting.ts`'s `__brand`, which is the repo's lone outlier (see the Global Constraint).
- **`packages/core/__tests__/helpers/` is the established shared-test-fixture seam.** `step-factories.ts` (`makeBaseStep`, `makeSubstep`, `makeTransitions`, `makeContextSnapshot`, …) is imported by 18 suites — **including three of this plan's twelve fixture files** (`command-target-resolver.test.ts`, `delegation-exposure.test.ts`, `delegation-exposure.properties.test.ts`). Siblings: `resolved-completion-seed.ts`, `canonical-paths.ts`, `parse-helpers.ts`.
- **Cross-package test fixtures already have a sanctioned route.** `packages/core/src/testing/effective-vars.ts` ships under a dedicated `"./testing/effective-vars"` export subpath (`packages/core/package.json`), consumed by `packages/cli/__tests__/helpers/brand-helpers.ts`. That file's own header states the convention: production goes through the real brand seam, and "tests need ergonomic constructors that route through the same brand seam **so the brand contract stays in one place**." That is the argument for Task 1's `makeClaimRecord`.
- **Eight of the twelve fixture files already hand-roll a local `ClaimRecord` factory, under four different names** — `openClaim` (`command-policy.properties.test.ts:86`, `delegation-exposure.test.ts:92`), `claimRecord` (`command-policy.test.ts:56`, `transitions-seam.test.ts:168`, `runbook-pipeline.test.ts:73`, `claim-and-launch.test.ts:56`), `makeClaim` (`command-target-resolver.test.ts:69`), `makeOpenClaim` (`delegation-exposure.properties.test.ts:99`). The duplication is what makes a required-field change a twelve-file manual sweep.

---


## File Structure

**Created:**

- `packages/core/src/runbook/duration.ts` — the duration primitive **on its own**: `DurationMs`, `assertDurationMs()`. Nothing claim-specific. It lives here rather than inside `claim-activity.ts` because it is a **general** primitive with a non-claim consumer already scheduled: plan 3 Task 6 builds a *generic* duration humaniser (`packages/cli/src/helpers/duration.ts`) that must import this type, and importing a duration primitive out of a claim-activity module is the wrong seam. The repo's precedent is one primitive, one module — `run-id.ts`, `delegation-token.ts`. The barrel (`runbook/index.ts`) makes the consumer-visible import path identical either way, so this split is free now and awkward later.
- `packages/core/__tests__/runbook/duration.test.ts` — unit tests for `assertDurationMs`. **Statically** imports `duration.js` (Stryker gate).
- `packages/core/src/runbook/claim-activity.ts` — the pure derivation seam: `ClaimActivity`, `claimActivity()`, `DEFAULT_IDLE_AFTER_MS`, `isClaimProgressUnreadable()`. Imports `DurationMs` / `assertDurationMs` from `./duration.js`. No I/O, no clock read, no imports from `session-service.ts`. Separate from `claim-id.ts` because that module owns bearer/hashing/grant/authorization primitives and this is a distinct concern with its own seam (spec § Derived Activity). **Plan 3 Task 6 later adds the `ChildActivity` read-boundary union to this same file** — leave room for it, but do not add it here: it has no consumer until the status surface exists, and an unused exported union is a type nobody narrows.
- `packages/core/__tests__/helpers/claim-factories.ts` — `makeClaimRecord(overrides?)`, the shared `ClaimRecord` fixture factory (Task 1 Step 0). This is what stops the next required-field change from being another twelve-file manual sweep.
- `packages/core/src/testing/claim-fixtures.ts` + a `"./testing/claim-fixtures"` export subpath in `packages/core/package.json` — the cross-package route for the CLI's two Tier 1 fixture files, mirroring the existing `"./testing/effective-vars"` precedent exactly.
- `packages/core/__tests__/runbook/claim-activity.test.ts` — unit tests. **Statically** imports `claim-activity.js` (Stryker gate, AC13).
- `packages/core/__tests__/runbook/claim-activity.properties.test.ts` — fast-check property tests. Also a static import.
- `packages/core/__tests__/runbook/claim-progress.test.ts` — the recording API's core integration tests (bearer scoping, RD-102 non-masking, totality). **Plan 2 extends this same file** with the adoption and anti-fooling cases that need real commands.

**Modified:**

- `packages/core/src/runbook/claim-id.ts` — add required `ClaimRecord.lastProgressAt`; set it in `createClaimRecord`; add `progressedClaimRecord()`. Leave `refreshedClaimRecord` alone.
- `packages/core/src/schemas.ts` — add `lastProgressAt` to `ClaimRecordSchema`.
- `packages/core/src/runbook/state.ts` — the structural rejection guard in `loadSession`.
- `packages/core/src/runbook/session-service.ts` — `recordClaimProgress()` + `ClaimProgressRecordResult`.
- `packages/core/src/errors/codes.ts` — `CLAIM_PROGRESS_UNREADABLE` (RD-824).
- `packages/core/src/errors/factory.ts` — `Errors.claimProgressUnreadable()`. Production code does not call `new RundownError` directly; all 42 existing throws go through this factory.
- `packages/core/src/errors.ts` — `isRundownErrorCode()`, the generic code-discriminating predicate, mirroring `isNodeErrorCode` (`:54`).
- `packages/core/src/runbook/index.ts` — export `duration.js` and `claim-activity.js`.
- `packages/core/package.json` — the `"./testing/claim-fixtures"` export subpath.
- `packages/claude-code-plugin/src/rdpath.ts:70-76` — add the new session-error message to the substring allow-list, or `rdpath` loses graceful degradation on exactly the sessions this plan invalidates.
- **Twelve `ClaimRecord` test fixtures across `@rundown-org/core` and `@rundown-org/cli`** — the three-tier table below is the enumeration. Task 1 Step 10 works it.
- `packages/core/__tests__/runbook/state.test.ts` — the `loadSession` rejection tests (Task 1 Step 6) extend the three existing `Legacy session ownership format` cases at `:820-858`.
- `packages/claude-code-plugin/__tests__/rdpath-find-integration.test.ts` — Task 1 Step 10b mirrors the existing legacy-message case (`:472`, `:544`) for the new message.

---

**Test fixtures that BREAK on the required-field change — TWELVE files, but only THREE stay hand-maintained.** Task 1 Step 0 introduces `makeClaimRecord`, and Step 10 routes the nine files that *should* use it onto it. Read the tier table below for what breaks and why, then the factory split for what to actually do with each tier.

> **The tiers are a diagnosis, not the treatment.** They were derived empirically and they are accurate — but Tier 3 exists *only because* each fixture is an independent literal that nothing centrally defines. The fix is to remove that condition, not to document it at length: **a shared factory dissolves Tier 3 rather than guarding it.** With `makeClaimRecord`, adding a required field is one edit in one file, and the nine files that route through it cannot rot because they no longer spell the shape out. What remains hand-maintained is three literals that must *stay* raw (see "The factory split" below) — and that is a floor, not a failure.

Find every site with **both** grep forms, because the shorthand-property sites (`{ secretHash, ... }`, no colon) are invisible to the obvious one:

```bash
grep -rln "secretHash:" packages/core/__tests__ packages/cli/__tests__          # explicit-property files
grep -rln "secretHash,\|secretHash$" packages/core/__tests__ packages/cli/__tests__  # shorthand files
```

**What determines whether a fixture is caught is TYPE ANNOTATION — not shorthand-vs-colon.** An earlier draft had this exactly backwards: it warned that the three "shorthand" files were the dangerous runtime-only ones. They are not. All three annotate their factory (`function openClaim(): ClaimRecord` in `command-policy.properties.test.ts:86` and `delegation-exposure.test.ts:92`; `function makeOpenClaim(index: number): ClaimRecord` in `delegation-exposure.properties.test.ts:99`), so TypeScript checks them like any other. The draft aimed its only completeness warning at files the compiler already protects, and left the genuinely invisible ones unmarked. Shorthand is a **grep** problem (which files you find), never a **visibility** problem (which files break loudly). Classify by the table below, not by punctuation.

The three tiers below were derived empirically — the field was added, `check:types` and both suites were run, and the results recorded. Do not re-reason them from first principles; re-derive them the same way if the tree has moved.

**Tier 1 — compile-visible.** `pnpm run check:types` names the file and line. Add the field; nothing else to think about. **(But see Step 11: the two CLI files are only visible after `packages/core` is REBUILT.)**

| File | Line | Why visible |
| --- | --- | --- |
| `packages/core/__tests__/runbook/command-target-resolver.test.ts` | 53, 69 | `const claimWithoutMutateGrant: ClaimRecord` + `function makeClaim(id): ClaimRecord` |
| `packages/core/__tests__/runbook/command-policy.test.ts` | 56 | `function claimRecord(): ClaimRecord` |
| `packages/core/__tests__/runbook/command-policy.properties.test.ts` | 86 | `function openClaim(): ClaimRecord` — **shorthand, and fully compile-visible** |
| `packages/core/__tests__/runbook/delegation-exposure.test.ts` | 92 | `function openClaim(): ClaimRecord` — **shorthand, and fully compile-visible** |
| `packages/core/__tests__/runbook/delegation-exposure.properties.test.ts` | 99 | `function makeOpenClaim(index): ClaimRecord` — **shorthand, and fully compile-visible** |
| `packages/cli/__tests__/helpers/claim-and-launch.test.ts` | 56 | `function claimRecord(...): ClaimRecord`. The `...overrides` spread of `Record<string, unknown>` does **not** mask the missing property — verified |
| `packages/cli/__tests__/helpers/runbook-pipeline.test.ts` | 73 | `function claimRecord(...): ClaimRecord` |

**Tier 2 — compile-invisible, but the SUITE catches it.** Untyped literals that reach a real `SessionDataSchema` / `ClaimRecordSchema` parse. A green `check:types` proves nothing here; Step 12 is what catches them.

| File | Line | Why the suite catches it |
| --- | --- | --- |
| `packages/cli/__tests__/commands/prune.test.ts` | 716 | Untyped literal inside `JSON.stringify({...})`; `loadSession` validates it for real |
| `packages/cli/__tests__/commands/stash-pop.test.ts` | 683 | Same shape (`hashClaimSecret(parsedClaim.secret)`) |
| `packages/core/__tests__/runbook/delegation-schemas.test.ts` | 335 (`validClaim`) | Untyped literal fed to `safeParse` asserting `success === true` — fails loudly. Line 384 mutates `validClaim` and inherits the fix |

**Tier 3 — NOTHING catches these. They rot silently, and they are the reason Steps 11 and 12 are not a completeness guard.** Verified: with the field required and these fixtures untouched, `check:types` is clean **and** `goto-workflow.test.ts` reports 28/28 passed, `transitions-seam.test.ts` 32/32 passed, and `delegation-schemas.test.ts` fails **only** its one `success === true` case. **Steps 11 and 12 both go green with all four of these wrong.** You must fix them by hand, from this table.

| File | Line | Why invisible | What rots |
| --- | --- | --- | --- |
| `packages/cli/__tests__/helpers/goto-workflow.test.ts` | 646-665 | `} as unknown as never` (`:665`) erases the check, and `loadSession` is a `mockFn` — so no schema ever validates it | The fixture silently stops representing a real claim record. The test keeps asserting `release-runbook` against a shape the session could no longer persist |
| `packages/cli/__tests__/helpers/transitions-seam.test.ts` | 168-185 | `} as unknown as ClaimRecord` (`:185`) erases the check despite the `: ClaimRecord` return annotation; the whole suite is mocked, so nothing parses it | Same: a fixture that no longer matches the type it claims to be |
| `packages/core/__tests__/runbook/delegation-schemas.test.ts` | 459-474 | Untyped literal asserting **`success === false`** | **Stays green for the WRONG reason.** It claims to test "map key differs from claimKey"; omit `lastProgressAt` and it is rejected for the missing field instead, silently voiding the invariant it exists to pin |
| `packages/core/__tests__/runbook/delegation-schemas.test.ts` | 476-497 | Untyped literal (`record()` helper) asserting **`success === false`** | Same class: claims to test "two claim records controlling the same run", would be rejected on the missing field instead |

> **The `success === false` cases are the subtlest failure in this task.** A test that keeps passing is invisible to *every* backstop the plan has: Step 11 is green, Step 12 is green, and Step 12's own guidance ("any remaining failure is a fixture") is addressed to failures that never come. The only thing that catches them is adding the field **because this table told you to**. After adding it, confirm each still asserts what its name says — `success === false` must be caused by the invariant under test, not by a missing field. To prove it, temporarily restore the correct field and delete the invariant-breaking part (make the map key match `claimKey`); the case must then go **green**, showing the rejection was really about the key.
>
> A `as unknown as` cast on a `ClaimRecord` fixture is what makes Tier 3 possible. Neither cast is introduced by this plan and neither is in scope to remove here — but do not add a third, and do not "fix" a Tier 1 compile error by reaching for one. That converts a loud failure into a silent one.

Tests that mint claims through `SessionService.issueRunControlClaim` / the delegated-child mint (e.g. `lifecycle-command-service.test.ts`, the `delegation-*` suites) do **not** break — `createClaimRecord` supplies the field for them. `packages/core/.stryker-tmp/**` and `packages/*/dist/**` are build artefacts; ignore them.

### The factory split: which of the twelve route through `makeClaimRecord`, and which must not

**Nine route onto the factory** — all seven Tier 1 files, plus Tier 3's two `as unknown as` cast sites. Each already hand-rolls a local `ClaimRecord` factory (under four different names — see Background), so this *removes* code rather than adding it. After Step 10 these files never spell a `ClaimRecord` shape out, so the next required-field change cannot rot them.

**Three MUST stay raw untyped literals. Do not "helpfully" route them through the factory — doing so silently voids the test.**

| File | Line | Why it must stay raw |
| --- | --- | --- |
| `packages/cli/__tests__/commands/prune.test.ts` | 716 | It writes a session file that `loadSession` validates **for real**. A typed factory would make the fixture valid by construction and the test would stop exercising the persistence boundary it exists to exercise. |
| `packages/cli/__tests__/commands/stash-pop.test.ts` | 683 | Same. |
| `packages/core/__tests__/runbook/delegation-schemas.test.ts` | 335, 459-474, 476-497 | These feed `safeParse` and assert on validation *outcomes* — including two `success === false` cases. The whole point is to hand the schema a shape the type system would have rejected; a factory defeats it. |

That is the honest floor: **three hand-maintained sites instead of twelve**, and the two subtlest (the `success === false` pair) are precisely the ones that had to stay raw regardless. Their guard is Step 12b's **permanent positive control** — not a one-shot manual ritual.


---

## Task 1: `ClaimRecord.lastProgressAt` — required field, set at creation, rejected when absent (AC1, AC2)

**Files:**

- Modify: `packages/core/src/runbook/claim-id.ts:89-102` (interface), `:402-420` (`createClaimRecord`)
- Modify: `packages/core/src/schemas.ts:634-643` (`ClaimRecordSchema`)
- Modify: `packages/core/src/runbook/state.ts:759-787` (`loadSession`)
- Modify: the **twelve** fixture files listed in the File Structure table — worked by **tier** (compile-visible / suite-caught / silently-rotting), not by grep punctuation. The four Tier 3 sites must be done by hand: no step in this task will fail if you skip them
- Modify: `packages/claude-code-plugin/src/rdpath.ts:70-76` (error allow-list)
- Test: `packages/core/__tests__/runbook/delegation-schemas.test.ts` (schema), `packages/core/__tests__/runbook/state.test.ts:820-858` (structural guard — the `Legacy session ownership format` cases there are the suite that owns `loadSession` rejection behaviour)

**Interfaces:**

- Consumes: nothing new.
- Produces: `ClaimRecord.lastProgressAt: string` (required, ISO). `createClaimRecord(input)` unchanged in signature — it now also sets `lastProgressAt: input.now`. `loadSession` throws `'Legacy claim record format detected. Finish or prune active runbooks and restart.'` for a session whose claims lack the field.

- [ ] **Step 0: Add the shared `makeClaimRecord` fixture factory**

Do this FIRST. It is what turns Step 10 from a twelve-file manual sweep into a three-file one, and it is why Tier 3 stops being a standing hazard rather than a documented one.

Create `packages/core/src/testing/claim-fixtures.ts` (in `src/`, not `__tests__/`, so the CLI can import it through an export subpath — this mirrors `src/testing/effective-vars.ts` exactly):

```typescript
// packages/core/src/testing/claim-fixtures.ts

import {
  assertClaimLookupKey,
  assertClaimSecretHash,
  type ClaimRecord,
} from '../runbook/claim-id.js';
import { assertRunId } from '../runbook/run-id.js';

const DEFAULT_RUN_ID = assertRunId(`rd_${'0'.repeat(32)}`);
const DEFAULT_AT = '2026-01-01T00:00:00.000Z';

/**
 * Build a `ClaimRecord` fixture for tests.
 *
 * Mirrors the precedent in `src/testing/effective-vars.ts`: tests need an
 * ergonomic constructor that routes through the same brand seam as production,
 * **so the claim-record shape stays in one place**. Before this factory, twelve
 * suites each spelled the shape out independently, which is what made a required
 * field addition a twelve-file manual sweep — and what let fixtures behind
 * `as unknown as` casts rot silently (#519).
 *
 * NOT for tests that assert on schema validation outcomes or feed a real
 * `loadSession`: those must hand the parser a shape the type system would have
 * rejected, so they keep their raw literals deliberately.
 *
 * @param overrides - Fields to override on the default valid record.
 * @returns A structurally valid `ClaimRecord`.
 */
export function makeClaimRecord(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claimKey: assertClaimLookupKey(`rdclk_${'a'.repeat(32)}`),
    secretHash: assertClaimSecretHash(`sha256:${'b'.repeat(64)}`),
    controlledRunId: DEFAULT_RUN_ID,
    grants: [{ action: 'mutate-run', runId: DEFAULT_RUN_ID }],
    issuedAt: DEFAULT_AT,
    updatedAt: DEFAULT_AT,
    lastProgressAt: DEFAULT_AT,
    ...overrides,
  };
}
```

> `lastProgressAt` is in the factory from the start — this file is written in the same commit that makes the field required, so there is no window where it is absent.

Add the export subpath to `packages/core/package.json`, directly after the existing `"./testing/effective-vars"` entry (copy its shape verbatim):

```json
    "./testing/claim-fixtures": {
      "import": "./dist/testing/claim-fixtures.js",
      "types": "./dist/testing/claim-fixtures.d.ts"
    }
```

Core suites import it as `../../src/testing/claim-fixtures.js`; CLI suites as `@rundown-org/core/testing/claim-fixtures` (which requires core to be **built** — see Step 11).

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

> **Copy the neighbours' setup EXACTLY — the three cases at `:820-858` use `testDir`, not `cwd`, and each calls `await mkdir(join(testDir, '.rundown'), { recursive: true })` before `writeFile`, and passes NO encoding argument.** Verified against the file. The code below matches them; an earlier draft of this step used `join(cwd, …)` with no `mkdir` and an `'utf8'` arg, which does not compile against this suite.

```typescript
  it('rejects a session whose claim records predate lastProgressAt (#519)', async () => {
    // A pre-#519 claim record: structurally a valid claim in every other respect,
    // but with no `lastProgressAt`. CLAUDE.md forbids migrating persisted state —
    // the guard REJECTS it with the finish/prune/restart recovery path, exactly as
    // the legacy-ownership guard does. It is never hydrated, defaulted, or shimmed.
    await mkdir(join(testDir, '.rundown'), { recursive: true });
    const claimKey = `rdclk_${'a'.repeat(32)}`;
    const runId = `rd_${'0'.repeat(32)}`;
    await writeFile(
      join(testDir, '.rundown', 'session.json'),
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
    );

    await expect(manager.loadSession()).rejects.toThrow(
      'Legacy claim record format detected. Finish or prune active runbooks and restart.',
    );
  });

  it('accepts a session whose claim records carry lastProgressAt (#519)', async () => {
    // The guard's NEGATIVE case, and it is not symmetry for its own sake: without
    // it, `.some(...)` -> `.every(...)`, dropping the `!Array.isArray(rawClaims)`
    // check, and dropping the `claim !== null` check are all mutants that the
    // rejection case above CANNOT kill — a guard that throws unconditionally
    // passes it. This is the case that proves the guard discriminates rather than
    // merely fires. Core is excluded from the PR mutation matrix (see Step 8), so
    // there is no mutation run to catch this for us.
    await mkdir(join(testDir, '.rundown'), { recursive: true });
    const claimKey = `rdclk_${'a'.repeat(32)}`;
    const runId = `rd_${'0'.repeat(32)}`;
    await writeFile(
      join(testDir, '.rundown', 'session.json'),
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
            lastProgressAt: '2026-07-01T00:00:00.000Z',
          },
        },
      }),
    );

    const session = await manager.loadSession();
    expect(session.claims[claimKey]?.lastProgressAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rejects a session with no claims at all without tripping the claim guard (#519)', async () => {
    // `claims: {}` must load cleanly: `.some()` over an empty object is false. This
    // kills the `.some` -> `.every` mutant specifically — `.every` over an empty
    // object is TRUE, so the mutant would throw on every claimless session, which
    // is the overwhelmingly common case.
    await mkdir(join(testDir, '.rundown'), { recursive: true });
    await writeFile(
      join(testDir, '.rundown', 'session.json'),
      JSON.stringify({ defaultStack: [], claims: {} }),
    );

    const session = await manager.loadSession();
    expect(session.claims).toEqual({});
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

Find them all — do not rely on the table alone if the tree has moved. **Both** greps, because shorthand sites are invisible to the first:

```bash
grep -rn "secretHash:" packages/core/__tests__ packages/cli/__tests__
grep -rn "secretHash,\|secretHash$" packages/core/__tests__ packages/cli/__tests__
```

Every hit that is a `ClaimRecord` object literal (not a `ClaimRecordSchema.safeParse({ ...validClaim, secretHash: ... })` spread, which inherits the field) needs the line.

**Route the nine onto `makeClaimRecord` (Step 0); hand-edit only the three that must stay raw.** See "The factory split" in the File Structure section for the full rationale.

**The nine that route onto the factory.** Each of these already has a local `ClaimRecord` factory — delete it and call the shared one. This is a net deletion, and it is what makes these files immune to the *next* required-field change:

```typescript
// core suites, e.g. packages/core/__tests__/runbook/command-policy.test.ts
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';

// Replace the local `function claimRecord(): ClaimRecord { … }` with call sites:
const claim = makeClaimRecord();
const claimWithoutMutateGrant = makeClaimRecord({ grants: [] });
const scoped = makeClaimRecord({ controlledRunId: childRunId });
```

```typescript
// CLI suites (claim-and-launch.test.ts, runbook-pipeline.test.ts, transitions-seam.test.ts,
// goto-workflow.test.ts) — through the export subpath, which needs core BUILT (Step 11):
import { makeClaimRecord } from '@rundown-org/core/testing/claim-fixtures';
```

- Tier 1's seven: `command-target-resolver.test.ts:53,69`, `command-policy.test.ts:56`, `command-policy.properties.test.ts:86`, `delegation-exposure.test.ts:92`, `delegation-exposure.properties.test.ts:99`, `claim-and-launch.test.ts:56`, `runbook-pipeline.test.ts:73`. Preserve each local factory's parameters as `overrides` (e.g. `makeOpenClaim(index)` becomes `makeClaimRecord({ claimKey: assertClaimLookupKey(\`rdclk_${String(index).padStart(32, '0')}\`) })` — keep whatever made each fixture distinct).
- Tier 3's two cast sites: `goto-workflow.test.ts:646-665` and `transitions-seam.test.ts:168-185`. **Routing these through the factory lets the `as unknown as` cast go away on its own** — the value is now genuinely a `ClaimRecord`, so nothing needs erasing. That is a strict improvement over the earlier draft's "add the field inside the literal, above the cast", which preserved the exact mechanism that made these rot. If a cast is still needed for an unrelated reason, keep it; do not add a new one.

**The three that stay raw — hand-edit these, and only these:**

- `packages/core/__tests__/runbook/delegation-schemas.test.ts` — `validClaim` (`:335`, already done in Step 1), plus `:459-474` and `:476-497`, which assert `success === false`. Add `lastProgressAt` to each literal so it is rejected for the reason its name claims, not for a missing property. Step 12b makes this permanent.
- `packages/cli/__tests__/commands/prune.test.ts:716` and `stash-pop.test.ts:683` — untyped literals inside `JSON.stringify({...})` that a real `loadSession` validates. Add the field to the literal. Step 12 catches these if you miss them.

- [ ] **Step 10b: Keep `rdpath` degrading gracefully on the sessions this change invalidates**

`packages/claude-code-plugin/src/rdpath.ts:70-76` allow-lists session-load failures **by message substring** so `rdpath` degrades instead of exploding. It already lists `'Legacy session ownership format detected'`. The new message is not matched, so without this line `rdpath` would hard-fail on precisely the sessions this change invalidates — the plugin package is in scope for exactly this one line.

Add to that `||` chain, next to the sibling legacy message:

```typescript
    message.includes('Legacy session ownership format detected') ||
    message.includes('Legacy claim record format detected') ||
```

Then pin it. Add to `packages/claude-code-plugin/__tests__/` alongside the existing legacy-message case (find it with `grep -rn "Legacy session ownership" packages/claude-code-plugin/__tests__`), mirroring that case exactly with the new message.

- [ ] **Step 11: Typecheck — REBUILD CORE FIRST, and treat it as necessary, NOT sufficient**

**Build core before typechecking, or the CLI fixtures are invisible:**

```bash
pnpm --filter @rundown-org/core run build
pnpm run check:types
```

Expected: PASS, after you have added the field everywhere. TypeScript flags every **annotated** literal still missing it.

> **The rebuild is load-bearing, not hygiene.** `packages/cli` resolves `@rundown-org/core` through its package `exports` to `dist/index.d.ts` — the **built** core, not `src/`. Edit the interface in core's `src` and run `check:types` without rebuilding and the CLI typechecks against the OLD `.d.ts`, where `lastProgressAt` does not exist yet. Verified: with a stale `dist`, `packages/cli` reports **0 errors**; after `pnpm --filter @rundown-org/core run build`, the same tree reports **2** (`claim-and-launch.test.ts:57`, `runbook-pipeline.test.ts:75`). Without the rebuild you get a green CLI and conclude, wrongly, that its fixtures are fine.
>
> `check:types` runs `tsc -p tsconfig.test.json` per package (`include: ["src/**/*", "__tests__/**/*"]`), so test files ARE checked. If you typecheck by hand, use `tsconfig.test.json` — plain `tsconfig.json` is `src`-only and will silently skip every fixture in this task.

Do not silence any error with `as ClaimRecord` or `as unknown as`. That is precisely how Tier 3 came to exist: a cast converts a loud compile failure into a fixture that rots in silence.

> **A green typecheck does NOT mean you found them all — and neither does a green suite.** Verified: with the four Tier 3 fixtures untouched, `check:types` is clean and Step 12 is clean too. Tiers 2 and 3 are why both greps in Step 10 are mandatory, and why Tier 3 must be worked by hand from the table.

- [ ] **Step 12: Run both packages' full suites**

Run: `pnpm --filter @rundown-org/core exec jest`
Run: `pnpm --filter @rundown-org/cli exec jest`

Expected: PASS. Any remaining **failure** is a Tier 2 fixture Step 10 missed — fix the fixture, never the requiredness.

> **This step cannot catch a Tier 3 fixture, by construction.** Its guidance addresses failures; Tier 3's whole character is that it keeps *passing*. Verified: with all four Tier 3 fixtures stale, `goto-workflow.test.ts` reports 28/28 green, `transitions-seam.test.ts` 32/32 green, and `delegation-schemas.test.ts` fails only its single `success === true` case — the two `success === false` cases stay green while no longer testing what they claim. Do not read a green Step 12 as "Step 10 was complete".
>
> **This is why Step 0 and Step 12b exist, and between them Tier 3 is now closed rather than merely documented.** Step 0's factory removes the two cast sites from the hand-maintained set entirely — they no longer spell out a `ClaimRecord`, so they cannot drift from one. Step 12b's positive controls turn the two `success === false` literals from "invisible if they rot" into "red if they rot", permanently. What is left is `prune.test.ts` and `stash-pop.test.ts`, which are Tier 2 — this step catches those loudly.

- [ ] **Step 12b: Pin the two `success === false` cases with a PERMANENT positive control**

The two raw literals at `delegation-schemas.test.ts:459-474` and `:476-497` assert `success === false`. If `lastProgressAt` is missing from either, it still returns `false` — **rejected for the wrong reason** — and the invariant the test names ("map key differs from claimKey", "two claim records controlling the same run") is silently no longer tested. Nothing catches this: Step 11 is green, Step 12 is green, and Step 12's own guidance addresses failures that never come.

The earlier draft's answer was a manual ritual: temporarily remove the invariant, observe green, revert. **That is not good enough** — it protects the fixture only on the day someone performs it, leaves no artefact, and will have to be re-derived from scratch on the next required-field change. Replace it with a positive control that lives in the suite forever.

For **each** of the two cases, add a sibling asserting that the very same record shape parses **successfully** once the invariant under test is removed:

```typescript
  it('accepts the same claim record shape when the map key MATCHES claimKey (positive control)', () => {
    // The negative control's twin. `rejects claim records whose map key differs
    // from claimKey` asserts success === false — which a record missing ANY
    // required field also satisfies, so on its own it cannot tell "rejected for
    // the key mismatch" from "rejected because the fixture rotted". This case is
    // the discriminator: identical shape, key mismatch removed, MUST parse. If a
    // required field goes missing from the fixture, THIS case goes red and names
    // the real cause. Do not delete it to "reduce duplication" — the duplication
    // is the mechanism (#519).
    const result = SessionDataSchema.safeParse({
      defaultStack: [PARENT_RUN_ID],
      claims: {
        rdclk_11111111111111111111111111111111: {
          claimKey: 'rdclk_11111111111111111111111111111111', // matches the map key
          secretHash: `sha256:${'a'.repeat(64)}`,
          controlledRunId: CHILD_RUN_ID,
          grants: [{ action: 'mutate-run', runId: CHILD_RUN_ID }],
          issuedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:01.000Z',
          lastProgressAt: '2026-05-01T00:00:01.000Z',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts two claim records controlling DIFFERENT runs (positive control)', () => {
    // Twin of `rejects two claim records controlling the same run`, for the same
    // reason: proves that rejection is caused by the shared controlledRunId and
    // not by a fixture that quietly stopped being a valid claim record.
    const record = (claimKey: string, runId: RunId) => ({
      claimKey,
      secretHash: `sha256:${'a'.repeat(64)}`,
      controlledRunId: runId,
      grants: [{ action: 'mutate-run', runId }],
      issuedAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:01.000Z',
      lastProgressAt: '2026-05-01T00:00:01.000Z',
    });
    const result = SessionDataSchema.safeParse({
      defaultStack: [PARENT_RUN_ID],
      claims: {
        rdclk_11111111111111111111111111111111: record(
          'rdclk_11111111111111111111111111111111',
          CHILD_RUN_ID,
        ),
        rdclk_22222222222222222222222222222222: record(
          'rdclk_22222222222222222222222222222222',
          OTHER_CHILD_RUN_ID,
        ),
      },
    });
    expect(result.success).toBe(true);
  });
```

> `OTHER_CHILD_RUN_ID` may not exist in the file — check the existing constants (`grep -n "CHILD_RUN_ID\|PARENT_RUN_ID" packages/core/__tests__/runbook/delegation-schemas.test.ts`) and add a second child run-id constant in the same style if needed. Do not reuse `PARENT_RUN_ID`: the schema's `superRefine` may have its own opinion about a claim controlling the parent run, which would reintroduce exactly the "red for an unrelated reason" ambiguity these cases exist to remove.

Run: `pnpm --filter @rundown-org/core exec jest delegation-schemas.test.ts`

Expected: PASS, including both new positive controls. **If a positive control is red, a required field is missing from that literal** — fix the fixture, and note that its negative twin has been asserting nothing.

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/runbook/claim-id.ts \
  packages/core/src/schemas.ts \
  packages/core/src/runbook/state.ts \
  packages/core/src/testing/claim-fixtures.ts \
  packages/core/package.json \
  packages/claude-code-plugin/src/rdpath.ts \
  packages/core/__tests__ packages/cli/__tests__ packages/claude-code-plugin/__tests__
git commit -m "feat(core)!: add required ClaimRecord.lastProgressAt and reject sessions without it (#519)"
```

---

## Task 2: `claim-activity.ts` — the pure derivation seam (AC6, AC8, AC13)

**Files:**

- Create: `packages/core/src/runbook/duration.ts` (the duration primitive, on its own)
- Create: `packages/core/src/runbook/claim-activity.ts` (the claim derivation)
- Modify: `packages/core/src/errors/codes.ts` (add `CLAIM_PROGRESS_UNREADABLE`, RD-824 — the next free code in the DELEGATION 8xx block, which currently ends at RD-823)
- Modify: `packages/core/src/errors/factory.ts` (add `Errors.claimProgressUnreadable` — production never calls `new RundownError` directly)
- Modify: `packages/core/src/errors.ts` (add `isRundownErrorCode`, mirroring `isNodeErrorCode` at `:54`)
- Modify: `packages/core/src/runbook/index.ts:60` (add both exports next to `claim-id.js`)
- Test: `packages/core/__tests__/runbook/duration.test.ts` (create), `packages/core/__tests__/runbook/claim-activity.test.ts` (create), `packages/core/__tests__/runbook/claim-activity.properties.test.ts` (create)

**Interfaces:**

- Consumes: `ClaimRecord` from `./claim-id.js` (type-only import); `RundownError` / `Errors` / `ErrorCodes` from the errors modules.
- Produces — later tasks rely on these exact names and types:
  - `type DurationMs` (in `duration.ts`) — branded with a `unique symbol`, matching `RunId` / `ClaimLookupKey` / `DelegationTokenHash`. **Not** `__brand`: that form appears exactly once in core (`targeting.ts:20`), where it is also a runtime property, and it is structurally forgeable by any module declaring the same literal. `run-id.ts:1` proves a symbol brand crosses into `@rundown-org/cli` intact.
  - `function assertDurationMs(value: number): DurationMs` (in `duration.ts`) — throws `RangeError` on non-finite / negative. **Named `assertDurationMs`, not `durationMs`.** Every repo function that takes an unbranded primitive, validates it, throws on failure, and returns the identical value branded is named `assert*`: `assertRunId` (`run-id.ts:29`), `assertClaimBearer` (`claim-id.ts:205`), `assertClaimLookupKey` (`:234`), `assertClaimSecretHash` (`:248`), `assertDelegationTokenHash` (`delegation-token.ts:137`). This is public API of `@rundown-org/core` the moment plan 1 lands, so the name is permanent — get it right now.
  - `interface ClaimActivity { readonly lastProgressAt: string; readonly idleFor: DurationMs; readonly idle: boolean }` — a **readonly interface, not a union**. See the Global Constraint: identical union variants that no caller narrows are a boolean in costume, and both consumers flatten straight back to `idle`. The spec's own naming table says `idle: boolean`.
  - `function claimActivity(record: ClaimRecord, now: Date, idleAfter: DurationMs): ClaimActivity` — throws `RundownError(CLAIM_PROGRESS_UNREADABLE)` on a corrupt `record.lastProgressAt`, and a `RangeError` on an Invalid Date `now` (a caller precondition, deliberately not contained).
  - `function isClaimProgressUnreadable(error: unknown): error is RundownError` — the ONE predicate both read boundaries use. Callers never compare `'RD-824'` themselves. Implemented **on top of** the generic `isRundownErrorCode`, not by hand.
  - `function isRundownErrorCode(error: unknown, code: string): boolean` (in `errors.ts`) — the generic discriminator. No code in the repo discriminates a `RundownError` by code today, so this is first-of-kind; `isNodeErrorCode` (`errors.ts:54`) is the template it copies.
  - `const DEFAULT_IDLE_AFTER_MS: DurationMs` (in `claim-activity.ts` — a claim *policy* constant, so it stays with the claim module, not with the primitive).

- [ ] **Step 1: Write the failing unit test**

Create `packages/core/__tests__/runbook/claim-activity.test.ts`.

> **Static import is load-bearing (AC13).** The `import` below MUST stay a top-level static import of `../../src/runbook/claim-activity.js`. Per #541, a dynamic-only (`await import(...)`) import leaves the module out of Stryker's static related-tests graph and it scores 0.00% regardless of how good the assertions are.

```typescript
// packages/core/__tests__/runbook/claim-activity.test.ts

import { describe, expect, it } from '@jest/globals';
import {
  claimActivity,
  isClaimProgressUnreadable,
  DEFAULT_IDLE_AFTER_MS,
} from '../../src/runbook/claim-activity.js';
import { assertDurationMs } from '../../src/runbook/duration.js';
import { getErrorMessage } from '../../src/errors.js';
import { Errors } from '../../src/errors/factory.js';
import { RundownError } from '../../src/errors/rundown-error.js';
import type { ClaimRecord } from '../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';

// Reuses Task 1 Step 0's shared factory rather than spelling the record shape out
// again — this suite would otherwise be a thirteenth hand-maintained fixture, i.e.
// exactly the problem that factory exists to end.
function claimAt(lastProgressAt: string): ClaimRecord {
  return makeClaimRecord({ lastProgressAt });
}

const ONE_HOUR = assertDurationMs(60 * 60 * 1000);

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

  it('reports zero idle when now EQUALS lastProgressAt', () => {
    // Distinct from the skew clamp above: that one exercises Math.max's negative
    // branch, this one its identity path. Together they pin both sides of the clamp.
    const activity = claimActivity(
      claimAt('2026-07-16T00:00:00.000Z'),
      new Date('2026-07-16T00:00:00.000Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(0);
  });

  it('treats every non-zero elapsed as idle when idleAfter is zero', () => {
    // `assertDurationMs(0)` is legal, so a zero threshold is a reachable input. This is a
    // SECOND, independent killer of `>` -> `>=`: at zero, the mutant reports idle
    // for a claim whose progress is this instant. The at-threshold case above kills
    // it at one hour; this kills it at the degenerate boundary the property suite
    // generates but never asserts a `kind` for.
    const zero = assertDurationMs(0);
    expect(
      claimActivity(claimAt('2026-07-16T00:00:00.000Z'), new Date('2026-07-16T00:00:00.000Z'), zero)
        .idle,
    ).toBe(false);
    expect(
      claimActivity(claimAt('2026-07-16T00:00:00.000Z'), new Date('2026-07-16T00:00:00.001Z'), zero)
        .idle,
    ).toBe(true);
  });

  it('parses a non-Zulu ISO offset rather than treating it as unreadable', () => {
    // `lastProgressAt` is `z.string().min(1)` on disk — nothing constrains it to
    // Zulu, and `Date.parse` accepts offsets. The property suite generates ONLY
    // Zulu (it builds via `.toISOString()`), so this input class is unreachable
    // there. A lexical comparison, or a parser that rejected offsets, would send a
    // healthy claim down the RD-824 path and report it `unreadable` — the fail-open's
    // mirror image: a live claim libelled as corrupt.
    // 2026-07-16T10:00:00+10:00 IS 2026-07-16T00:00:00Z — exactly at the threshold
    // from 2026-07-15T23:00:00Z, so a broken parse cannot coincidentally pass.
    const activity = claimActivity(
      claimAt('2026-07-16T10:00:00.000+10:00'),
      new Date('2026-07-16T01:00:00.000Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(3_600_000);
  });

  it('behaves at the boundary of DEFAULT_IDLE_AFTER_MS itself, not just a local ONE_HOUR', () => {
    // Every other case drives the local `ONE_HOUR` literal; the default is only
    // asserted equal to 3_600_000 elsewhere. If the default were re-pointed at a
    // different value, no test would exercise the SHIPPED threshold at its own
    // boundary — the one an operator actually gets.
    expect(
      claimActivity(
        claimAt('2026-07-16T00:00:00.000Z'),
        new Date('2026-07-16T01:00:00.000Z'),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(false);
    expect(
      claimActivity(
        claimAt('2026-07-16T00:00:00.000Z'),
        new Date('2026-07-16T01:00:00.001Z'),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(true);
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
    // Asserted on the CODE, not a message substring: `assertDurationMs` throws out
    // of this same function, so a substring match is the only thing separating them
    // — and a harmless reword would gut this test while it stays green. The code is
    // the contract the read boundary catches on too.
    let thrown: unknown;
    try {
      claimActivity(claimAt('not-a-date'), new Date(), ONE_HOUR);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RundownError);
    // The predicate the read boundaries actually use — pinned on the same throw
    // they contain, so the guard and the containment cannot drift apart.
    expect(isClaimProgressUnreadable(thrown)).toBe(true);
    // The code literal is pinned HERE and nowhere else in the codebase: production
    // asks `isClaimProgressUnreadable`. This line is the deliberate place a
    // renumber has to be acknowledged.
    expect((thrown as RundownError).code).toBe('RD-824');
  });

  it('renders the corrupt value and the claim key INTO the error message (AC6 loudness)', () => {
    // Not a duplicate of the case above, and not cosmetic. `RundownError.formatMessage`
    // renders a FIXED twelve-key list (rundown-error.ts:99-134); any other context key
    // lands in `context`, reachable only via toJSON(), and is invisible in `.message`.
    // `ErrorContext`'s index signature means TypeScript will NOT catch the mistake —
    // so nothing but this assertion stands between a "loud" error and one whose
    // message is the bare title with no corrupt value and nothing to correlate.
    // AC6's whole purpose is that the corrupt child is loud, and plan 3 renders this
    // to agents. An earlier draft passed `{ claimKey, lastProgressAt }` — both inert.
    let thrown: unknown;
    try {
      claimActivity(claimAt('not-a-date'), new Date(), ONE_HOUR);
    } catch (error) {
      thrown = error;
    }
    const message = getErrorMessage(thrown);
    expect(message).toContain('not-a-date');
    expect(message).toContain(makeClaimRecord().claimKey);
  });

  it('rejects an Invalid Date `now` as a CALLER error, not as an unreadable record', () => {
    // A broken clock is a code bug, not corrupt persisted data. Two things must
    // hold, and both are load-bearing:
    //  1. It must NOT be CLAIM_PROGRESS_UNREADABLE — that would blame this child's
    //     record for the caller's bug and send the reader to the wrong place (and
    //     the read boundaries would silently swallow it as `unreadable`).
    //  2. It must be discriminable BY TYPE, not by message. `RangeError` is the
    //     repo's precedent for a caller precondition (assertPositiveEntry,
    //     targeting.ts:44-48), and it is what lets plan 3's read boundary sort the
    //     three throws — RundownError (contain), RangeError (rethrow), other
    //     (rethrow) — with no substring matching anywhere.
    let thrown: unknown;
    try {
      claimActivity(claimAt('2026-07-16T00:00:00.000Z'), new Date('nonsense'), ONE_HOUR);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RangeError);
    expect(isClaimProgressUnreadable(thrown)).toBe(false);
  });

  it('isClaimProgressUnreadable rejects unrelated errors', () => {
    // Guards the guard: it must not swallow an assertDurationMs RangeError or a
    // plain Error, or the read boundaries would contain bugs as though they were
    // corrupt data.
    expect(isClaimProgressUnreadable(new RangeError('DurationMs must be a non-negative finite number'))).toBe(
      false,
    );
    expect(isClaimProgressUnreadable(new Error('unrelated'))).toBe(false);
    expect(isClaimProgressUnreadable(undefined)).toBe(false);
  });

  it('is a RundownError with a DIFFERENT code, and the predicate still says no', () => {
    // The predicate must discriminate on the CODE, not merely on `instanceof
    // RundownError`. Without this case, `error instanceof RundownError && <code
    // check>` -> `error instanceof RundownError` survives: every RundownError would
    // report as claim-progress-unreadable, and plan 3's read boundary would contain
    // unrelated failures as though a child's record were corrupt.
    expect(isClaimProgressUnreadable(Errors.noActiveRunbook())).toBe(false);
  });

  it('defaults the idle threshold to one hour', () => {
    expect(DEFAULT_IDLE_AFTER_MS).toBe(3_600_000);
  });
});
```

Create `packages/core/__tests__/runbook/duration.test.ts` — the primitive's own suite, beside its own module. Static import (Stryker gate):

```typescript
// packages/core/__tests__/runbook/duration.test.ts

import { describe, expect, it } from '@jest/globals';
import { assertDurationMs, type DurationMs } from '../../src/runbook/duration.js';

describe('assertDurationMs (#519)', () => {
  it('accepts zero and positive finite values', () => {
    expect(assertDurationMs(0)).toBe(0);
    expect(assertDurationMs(1234)).toBe(1234);
  });

  it('rejects negative values with a RangeError', () => {
    // RangeError, not a bare Error: a caller-precondition violation, per
    // assertPositiveEntry (targeting.ts:44-48). The TYPE is the contract —
    // claimActivity's read boundary in plan 3 sorts throws by type, never by
    // message substring.
    expect(() => assertDurationMs(-1)).toThrow(RangeError);
    expect(() => assertDurationMs(-1)).toThrow('DurationMs must be a non-negative finite number');
  });

  it('rejects non-finite values with a RangeError', () => {
    expect(() => assertDurationMs(Number.NaN)).toThrow(RangeError);
    expect(() => assertDurationMs(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// Type-level pin: `DurationMs` is branded, so a bare number is NOT assignable.
//
// `@ts-expect-error` is the whole mechanism: it fails the build if the error it
// expects STOPS occurring — i.e. the moment the brand is deleted and `DurationMs`
// decays to `number`, this line reports "Unused '@ts-expect-error' directive" and
// `check:types` goes red. An earlier draft wrote `const _typePin: DurationMs =
// DEFAULT_IDLE_AFTER_MS;` and claimed it pinned the brand; it did not — the RHS is
// already `DurationMs`, so that line compiles identically with or without the
// brand and could never fail.
// @ts-expect-error - a bare number must not be assignable to the branded DurationMs
const _brandPin: DurationMs = 5;
void _brandPin;
```

> Confirm the helper names before writing: `grep -n "export function assertClaimLookupKey\|export function assertClaimSecretHash" packages/core/src/runbook/claim-id.ts` and `grep -n "export function assertRunId" packages/core/src/runbook/run-id.ts`. If a name differs, use the real one — do not invent a helper.
>
> The `describe/expect/it` import from `@jest/globals` matches the sibling suites (e.g. `delegation-exposure.properties.test.ts:1`) — confirm with `head -3` on a neighbour and match whatever it does.

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

> A typed code, not a bare `Error`, is what lets the read boundary (Tasks 6 and 7) and AC6's test discriminate this from `assertDurationMs`'s `RangeError` — thrown out of the very same function — without matching on a message substring that a reword would silently break.

- [ ] **Step 2c: Add the generic `isRundownErrorCode` predicate**

In `packages/core/src/errors.ts`, directly after `isNodeErrorCode` (`:54-56`), whose shape and naming this copies:

```typescript
/**
 * Check whether an error is a {@link RundownError} carrying a specific code.
 *
 * The `RundownError` counterpart to {@link isNodeErrorCode}. Callers discriminate
 * on the CODE rather than on a message substring, which a harmless reword would
 * silently break. Generic rather than one bespoke predicate per code, so RD-824's
 * successors get the same guarantee for free (#519).
 *
 * `instanceof` is correct here and is not a lint violation: `RundownError` is a
 * same-realm custom error class, which CLAUDE.md's Testing Conventions exempt
 * explicitly. `Error.isError()` is for cross-realm NATIVE errors and would not
 * answer this question.
 *
 * @param error - Any thrown value.
 * @param code - The `RD-xxx` code string to match (pass `ErrorCodes.X.code`).
 * @returns True when `error` is a `RundownError` whose code matches.
 */
export function isRundownErrorCode(error: unknown, code: string): boolean {
  return error instanceof RundownError && error.code === code;
}
```

> Uses the `code` **getter** (`rundown-error.ts:78`), not `error.errorCode.code` — one fewer indirection through a field the class already surfaces. Import `RundownError` from `./errors/rundown-error.js` if `errors.ts` does not already; check its existing import block first.

- [ ] **Step 2d: Add the `Errors.claimProgressUnreadable` factory function**

**Production code in this repo never calls `new RundownError(...)` directly.** Verified: the only two files in `packages/core/src` containing it are `errors/rundown-error.ts` (the class) and `errors/factory.ts`, which holds all 42 production throws behind the `Errors` object. `claim-activity.ts` must not be the first exception.

In `packages/core/src/errors/factory.ts`, add to the `Errors` object in the delegation section (match the surrounding style — `grep -n "childRunbookActive\|delegation" packages/core/src/errors/factory.ts` to find the block):

```typescript
  claimProgressUnreadable: (claimKey: string, lastProgressAt: string): RundownError =>
    new RundownError('CLAIM_PROGRESS_UNREADABLE', {
      // `value` and `childId` are NOT arbitrary key choices — they are two of the
      // TWELVE keys `RundownError.formatMessage` actually renders
      // (rundown-error.ts:99-134). A key outside that list lands in `context`,
      // reachable only via toJSON(), and is INVISIBLE in `error.message` — and
      // `ErrorContext`'s index signature (:32) means TypeScript will not warn you.
      // An earlier draft passed `{ claimKey, lastProgressAt }` and would have
      // shipped a "loud" error whose message was the bare title with no corrupt
      // value and nothing to correlate — gutting the very AC6 loudness this code
      // exists to provide, on the surface plan 3 renders to agents.
      // `value` renders as the quoted primary identifier; `childId` is the
      // conventional correlation slot.
      value: lastProgressAt,
      childId: claimKey,
    }),
```

Verify the message actually renders before moving on:

```bash
pnpm --filter @rundown-org/core exec node -e "
  const { Errors } = await import('./dist/errors/factory.js');
  console.log(Errors.claimProgressUnreadable('rdclk_abc', 'not-a-date').message);
" --input-type=module
```

Expected: a message containing **both** `"not-a-date"` and `rdclk_abc` — not the bare title. (Build core first if `dist` is stale.)

- [ ] **Step 3: Write the duration primitive module**

Create `packages/core/src/runbook/duration.ts`. It is deliberately its own module: `DurationMs` is a **general** primitive, and plan 3 Task 6 builds a *generic* CLI duration humaniser that imports this type — importing a duration primitive out of a claim-activity module would be the wrong seam. One primitive, one module, per `run-id.ts` / `delegation-token.ts`.

```typescript
// packages/core/src/runbook/duration.ts

/**
 * Brand for {@link DurationMs}.
 *
 * Declared with `declare const` + `unique symbol` so the brand is purely
 * compile-time and no runtime property exists. Exported (like `runIdBrand` in
 * `run-id.ts:1`) so the brand survives into `@rundown-org/cli`'s view of the
 * built `.d.ts` — plan 3's humaniser consumes `DurationMs` across that boundary.
 *
 * Deliberately NOT the `{ readonly __brand: 'DurationMs' }` form: that appears
 * exactly ONCE in `packages/core/src` (`targeting.ts:20`), where the same file
 * also uses `__brand` as a real RUNTIME property (`:259`, `:290`) — so it is not
 * even a pure type brand there. Every other branded primitive in core uses a
 * unique symbol. A literal brand is also structurally forgeable by any module
 * that declares the same string; a symbol brand is not.
 */
export declare const durationMsBrand: unique symbol;

/**
 * A non-negative duration in milliseconds.
 *
 * Branded so a raw `number` cannot be passed where a duration is meant (and vice
 * versa). Milliseconds is the JSON wire unit for `idleFor`.
 */
export type DurationMs = number & { readonly [durationMsBrand]: true };

/**
 * Assert a raw millisecond count is a valid {@link DurationMs} and brand it.
 *
 * Named `assert*` to match every sibling brand seam — `assertRunId`
 * (`run-id.ts:29`), `assertClaimLookupKey` (`claim-id.ts:234`),
 * `assertDelegationTokenHash` (`delegation-token.ts:137`) — all of which take an
 * unbranded primitive, validate, throw on failure, and return the identical value
 * branded. This does exactly that, so it carries exactly that name.
 *
 * @param value - Non-negative, finite millisecond count.
 * @returns The branded duration.
 * @throws {RangeError} When `value` is negative, `NaN`, or infinite. A `RangeError`
 *   (not a bare `Error`) per `assertPositiveEntry` (`targeting.ts:44-48`), the
 *   repo's precedent for a caller-precondition violation: this is a code bug, not
 *   bad persisted data, and the read boundaries in plan 3 discriminate it from
 *   corrupt data BY TYPE rather than by message substring.
 */
export function assertDurationMs(value: number): DurationMs {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `DurationMs must be a non-negative finite number, received: ${String(value)}`,
    );
  }
  return value as DurationMs;
}
```

- [ ] **Step 3b: Write the claim-activity module**

Create `packages/core/src/runbook/claim-activity.ts`:

```typescript
// packages/core/src/runbook/claim-activity.ts

import { Errors } from '../errors/factory.js';
import type { ClaimRecord } from './claim-id.js';
import { assertDurationMs, type DurationMs } from './duration.js';

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
export const DEFAULT_IDLE_AFTER_MS: DurationMs = assertDurationMs(60 * 60 * 1000);

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
 * @param now - Injected observation time. MUST be a valid Date.
 * @param idleAfter - Threshold past which the claim is reported idle.
 * @returns The derived advisory activity.
 * @throws {RangeError} When `now` is an Invalid Date — a caller precondition
 *   failure, deliberately NOT contained by the read boundaries. Reporting a broken
 *   clock as this child's record being `unreadable` would blame the data for a code
 *   bug and send the reader to the wrong place. A `RangeError` per
 *   `assertPositiveEntry` (`targeting.ts:44-48`), so plan 3's read boundary
 *   discriminates the three throws BY TYPE — `RundownError` (contain), `RangeError`
 *   (rethrow, caller bug), anything else (rethrow) — with no message substring
 *   anywhere. This design rejects message-substring discrimination everywhere else;
 *   leaving one throw hinging on it would be an unforced inconsistency.
 * @throws {RundownError} `CLAIM_PROGRESS_UNREADABLE` when `record.lastProgressAt`
 *   is not a parseable ISO timestamp. Deliberate: `Date.parse` yields `NaN`, every
 *   `NaN` comparison is false, so `idleFor > idleAfter` would be false and a DEAD
 *   claim would silently classify as progressing — a safety signal failing OPEN in
 *   exactly the case it exists to catch. Corrupt persisted state is rejected, never
 *   interpreted. TYPED rather than a bare `Error` because `assertDurationMs` throws
 *   from this same function: with both untyped, only a message substring would tell
 *   them apart, and a harmless reword would silently gut AC6 with every test still
 *   green. Callers contain this PER CHILD (never around a whole list) — see the read
 *   boundary in Tasks 6 and 7.
 */
export function claimActivity(
  record: ClaimRecord,
  now: Date,
  idleAfter: DurationMs,
): ClaimActivity {
  // `now` is a CALLER precondition, not persisted data, so it is checked first and
  // separately. An Invalid Date yields NaN from getTime(), and Math.max(0, NaN) is
  // NaN, so without this guard the failure surfaces from `assertDurationMs` as
  // "DurationMs must be a non-negative finite number" — a message that blames the
  // duration and sends the reader hunting in the wrong place. It must NOT be
  // reported as CLAIM_PROGRESS_UNREADABLE either: that would blame this child's
  // record for the caller's broken clock. A RangeError is right — this is a code
  // bug (every call site injects `new Date()`), and the read boundaries
  // deliberately rethrow it rather than labelling a child `unreadable`.
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('claimActivity requires a valid `now`; received an Invalid Date');
  }
  const lastProgress = Date.parse(record.lastProgressAt);
  if (Number.isNaN(lastProgress)) {
    // Via the factory, never `new RundownError` — see Step 2d. The factory is also
    // where the render-visible context keys (`value`, `childId`) are chosen, so the
    // key-list trap is solved in exactly one place.
    throw Errors.claimProgressUnreadable(record.claimKey, record.lastProgressAt);
  }
  const idleFor = assertDurationMs(Math.max(0, now.getTime() - lastProgress));
  return {
    lastProgressAt: record.lastProgressAt,
    idleFor,
    idle: idleFor > idleAfter,
  };
}

/**
 * Narrow an unknown error to the "claim progress unreadable" case (#519).
 *
 * The read boundaries (Tasks 6 and 7) contain THIS and rethrow everything else, so
 * they need one predicate rather than a hand-rolled `instanceof` plus a literal
 * code comparison at each site. Exported for exactly that reason: this design
 * argues that discrimination must not hinge on a re-wordable message, and a code
 * literal copied into every caller is the same defect one level down — `'RD-824'`
 * is re-numberable, and a renumber would silently turn contained corruption back
 * into an unhandled throw out of a read-only command. The code lives in ONE place
 * (`ErrorCodes.CLAIM_PROGRESS_UNREADABLE`) and callers ask this question instead.
 *
 * Built on the generic {@link isRundownErrorCode} rather than hand-rolling the
 * `instanceof` + code comparison, so the "discriminate on the code, never on a
 * message" guarantee has ONE implementation for RD-824 and every code after it.
 *
 * @param error - Any thrown value.
 * @returns True when `error` is the typed CLAIM_PROGRESS_UNREADABLE RundownError.
 */
export function isClaimProgressUnreadable(error: unknown): error is RundownError {
  return isRundownErrorCode(error, ErrorCodes.CLAIM_PROGRESS_UNREADABLE.code);
}
```

> The narrowing is to `RundownError` — strictly weaker than what the body proves, but it is the narrowing callers need: at a `catch (error: unknown)` site it is what unlocks `.code` / `.context` / `.toJSON()`. A dedicated `ClaimProgressUnreadableError` subclass would narrow more precisely and is deliberately **not** built here: no caller reads a field that only that subclass would carry, so it would be ceremony. Revisit only if plan 3's read boundary turns out to need one.
>
> This file needs three imports it did not have: `Errors` from `../errors/factory.js`, `ErrorCodes` from `../errors/codes.js`, and `isRundownErrorCode` + `RundownError` (type-only, for the predicate's return type) from `../errors.js` / `../errors/rundown-error.js`. Check for an import cycle — `errors.ts` must not import from `runbook/` — and if one exists, import `isRundownErrorCode` from wherever `errors.ts` re-exports it.

- [ ] **Step 4: Export both modules from the core barrel**

In `packages/core/src/runbook/index.ts`, next to the existing `export * from './claim-id.js';` (`:60`):

```typescript
export * from './claim-activity.js';
export * from './claim-id.js';
export * from './duration.js';
```

Both new modules go in the barrel: `duration.ts` because plan 3's CLI humaniser imports `DurationMs` across the package boundary, and `claim-activity.ts` for its consumers in plans 2 and 3.

- [ ] **Step 5: Run both unit suites to verify they pass**

Run: `pnpm --filter @rundown-org/core exec jest claim-activity.test.ts duration.test.ts`

Expected: PASS (all cases in both).

Then confirm the AC6 error message is genuinely loud — the one assertion that stands between a typed code and a contentless message:

Run: `pnpm --filter @rundown-org/core exec jest claim-activity.test.ts -t "renders the corrupt value"`

Expected: PASS. If it fails, the context keys passed in Step 2d are outside `formatMessage`'s twelve-key render list (`rundown-error.ts:99-134`) and the error is landing in `context` where no agent will ever see it.

- [ ] **Step 6: Write the property test**

Create `packages/core/__tests__/runbook/claim-activity.properties.test.ts`. Static import again (AC13).

```typescript
// packages/core/__tests__/runbook/claim-activity.properties.test.ts

import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
// No `type DurationMs` import: `assertDurationMs()` already RETURNS `DurationMs`, so
// every call site here is correctly typed without an annotation or a cast. An
// earlier draft wrote `assertDurationMs(threshold) as DurationMs` throughout and had to
// import the type to do it — but that assertion never changes the type, so
// `@typescript-eslint/no-unnecessary-type-assertion` (an ERROR here: eslint.config.js:112
// enables strictTypeCheckedOnly, and the test override at :298-315 does NOT disable
// this rule) fails `pnpm run verify`. Do not re-add either the casts or the import.
import { claimActivity, isClaimProgressUnreadable } from '../../src/runbook/claim-activity.js';
import { assertDurationMs } from '../../src/runbook/duration.js';
import type { ClaimRecord } from '../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';

function claimAt(lastProgressAt: string): ClaimRecord {
  return makeClaimRecord({ lastProgressAt });
}

// Bounded so every timestamp is a valid ISO string and every difference fits
// comfortably in a safe integer.
const epochMs = fc.integer({ min: 0, max: 4_102_444_800_000 });
const thresholdMs = fc.integer({ min: 0, max: 86_400_000 });

/**
 * `now`, generated RELATIONALLY: an offset around `progressAt + threshold` rather
 * than an independent absolute instant.
 *
 * This is the difference between a property that tests the boundary and one that
 * only looks like it does. Drawing `nowAt` independently from `epochMs`
 * (0–4.1e12) while `threshold` maxes at 8.64e7 means the band where `idleFor` is
 * anywhere near `idleAfter` is sampled with probability ~1e-5 — effectively never
 * in 100 runs. Every draw lands deep in the far field where the answer is
 * unanimous, so such a property kills `>` -> `<`/`true`/`false` only because
 * everything disagrees out there, and NO off-by-one is reachable: `>` -> `>=` is
 * decided by a single instant that is never generated. Centring on the threshold
 * puts every draw within +/-2ms of the decision boundary, so the exact-boundary
 * and one-either-side cases are hit on essentially every run.
 */
const offsetAroundThreshold = fc.integer({ min: -2, max: 2 });

describe('claimActivity properties (#519)', () => {
  it('is total over any valid ISO lastProgressAt and any valid now', () => {
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, (progressAt, nowAt, threshold) => {
        const activity = claimActivity(
          claimAt(new Date(progressAt).toISOString()),
          new Date(nowAt),
          assertDurationMs(threshold),
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
        const idleAfter = assertDurationMs(threshold);
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

  it('agrees with the oracle AT the decision boundary, where off-by-one lives', () => {
    // The property above draws `nowAt` independently across a range ~50,000x the
    // threshold's, so every draw lands in the far field and the boundary is never
    // sampled. This one generates `now` RELATIVE to `progressAt + threshold`, so
    // every draw is within +/-2ms of the decision point.
    //
    // This is what makes the `>` -> `>=` mutant reachable in the property suite:
    // that mutant differs from the original at EXACTLY ONE instant
    // (idleFor === idleAfter), and offset 0 hits it on essentially every run.
    fc.assert(
      fc.property(epochMs, thresholdMs, offsetAroundThreshold, (progressAt, threshold, offset) => {
        const idleAfter = assertDurationMs(threshold);
        const nowAt = progressAt + threshold + offset;
        const activity = claimActivity(
          claimAt(new Date(progressAt).toISOString()),
          new Date(nowAt),
          idleAfter,
        );
        // Strictly greater: offset 0 (exactly at the threshold) is NOT idle.
        expect(activity.idle).toBe(offset > 0);
        expect(activity.idleFor).toBe(Math.max(0, threshold + offset));
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
        const strict = claimActivity(record, new Date(nowAt), assertDurationMs(lower));
        const lenient = claimActivity(record, new Date(nowAt), assertDurationMs(higher));
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
          const idleAfter = assertDurationMs(threshold);
          const earlier = claimActivity(record, new Date(nowAt), idleAfter);
          const later = claimActivity(record, new Date(nowAt + delta), idleAfter);
          // Time only moves forward, so an unrefreshed claim only gets idler.
          expect(later.idleFor).toBeGreaterThanOrEqual(earlier.idleFor);
        },
      ),
    );
  });

  it('ALWAYS throws CLAIM_PROGRESS_UNREADABLE for an unparseable lastProgressAt (AC6)', () => {
    // AC6 is the failure this design calls "the single worst it can have", and every
    // OTHER property here builds its record via `new Date(x).toISOString()` — so
    // every generated timestamp is parseable and the RD-824 branch is UNREACHABLE
    // across the whole property suite. Without this, AC6 is pinned by exactly one
    // string literal ('not-a-date') in the unit suite. This states the invariant over
    // the space it is supposed to hold on: no unparseable string, of any shape, may
    // ever come back as a classification.
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.length > 0 && Number.isNaN(Date.parse(s))),
        epochMs,
        thresholdMs,
        (corrupt, nowAt, threshold) => {
          let thrown: unknown;
          try {
            claimActivity(claimAt(corrupt), new Date(nowAt), assertDurationMs(threshold));
          } catch (error) {
            thrown = error;
          }
          // Never a silent classification: the fail-open this AC exists to prevent
          // is `idle: false` on a dead claim, and `NaN > x` is false, so a missing
          // throw would present exactly as a healthy claim.
          expect(isClaimProgressUnreadable(thrown)).toBe(true);
        },
      ),
    );
  });

  it('passes lastProgressAt through verbatim, never a reformatted or substituted value', () => {
    // The unit suite asserts this at ONE point, where `claimAt` gives `updatedAt` and
    // `lastProgressAt` the SAME string — so that assertion cannot tell the two fields
    // apart, and a `record.updatedAt` mutant survives it. Here they are forced to
    // differ, so the field the implementation reads is observable.
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, (progressAt, nowAt, threshold) => {
        const iso = new Date(progressAt).toISOString();
        const record = makeClaimRecord({
          lastProgressAt: iso,
          // A DIFFERENT instant, so reading the wrong field is observable.
          updatedAt: new Date(progressAt + 1).toISOString(),
        });
        const activity = claimActivity(record, new Date(nowAt), assertDurationMs(threshold));
        expect(activity.lastProgressAt).toBe(iso);
      }),
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
          assertDurationMs(threshold),
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

Run the **direct `exec stryker` form with PACKAGE-RELATIVE paths**:

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate src/runbook/claim-activity.ts,src/runbook/duration.ts \
  --testFiles __tests__/runbook/claim-activity.test.ts,__tests__/runbook/claim-activity.properties.test.ts,__tests__/runbook/duration.test.ts
```

> **THE PATHS ARE PACKAGE-RELATIVE, NOT REPO-RELATIVE. This is the whole trap.** `pnpm --filter … exec` runs with cwd = `packages/core`, and Stryker resolves `--mutate` globs against that cwd. An earlier draft of this step passed `--mutate packages/core/src/runbook/claim-activity.ts`, which matches **nothing** from inside `packages/core`. Verified by running that exact form:
>
> ```
> WARN ProjectReader Glob pattern "packages/core/src/runbook/claim-id.ts" did not result in any files.
> WARN ProjectReader Glob pattern "packages/core/__tests__/runbook/claim-id.test.ts" did not match any test files.
> INFO Instrumenter Instrumented 0 source file(s) with 0 mutant(s)
> EXIT: 0
> ```
>
> **Zero mutants, exit 0, and a WARN rather than an error.** That is a gate that cannot fail — the exact "fails in a way that looks like success" class this step's own callout was written to prevent, reproduced by the callout's own prescription. The repo already proves the correct form: `.github/workflows/mutation-pr.yml:96` strips the package prefix (`sed "s#^${PKG_DIR}/##"`) before passing `--mutate`. The config's own `mutate` array (`packages/core/stryker.config.mjs`) is package-relative for the same reason: `'src/**/*.ts'`.
>
> **Aggravating factor:** the config sets `incremental: true` with `incrementalFile: reports/stryker-incremental.json`. If that file exists from a prior run, a zero-mutant run can still print a plausible aggregate score from the stale baseline — reinforcing the false success. If a score looks right but you did not see a mutant count for your files, distrust it.
>
> **Neither `pnpm run test:mutate:core -- …` NOR `pnpm --filter @rundown-org/core test:mutate -- …` works either**, and both also fail in ways that look like success. Do not "simplify" back to a script invocation:
>
> - `pnpm run test:mutate:core -- --mutate <file>`: the root script (`package.json:28`) has **no trailing `--`** (unlike `test:mutate:cli` at `:29`, which does), so the flags are eaten by the inner `pnpm` and never reach Stryker. The gate silently runs **unscoped** over the whole package — thousands of mutants, and a score that tells you nothing about this module.
> - `pnpm --filter @rundown-org/core test:mutate -- --mutate <file>`: pnpm forwards the **literal `--`** into the script, so Stryker's Commander sees `stryker run -- --mutate <file>` and treats everything after `--` as positional operands. `run` accepts exactly one positional (the config file), so it dies with `error: too many arguments for 'run'. Expected 1 argument but got 2.` Same `--`-forwarding trap as `jest` in Task 1 Step 12.

**Verify the gate actually ran before reading its score.** All three failure modes above are silent, so check the instrumentation line first:

Expected: `Instrumented 2 source file(s) with N mutant(s)` where N is a **handful** — a two-file scope.

- `Instrumented 0 source file(s) with 0 mutant(s)` → the globs matched nothing. Your paths are repo-relative. **AC13 is unverified.**
- Thousands of mutants → the scoping never reached Stryker; it is running the whole package.
- `Expected 1 argument but got 2` → the `--` trap.

> **Core is EXCLUDED from the per-PR mutation matrix** (`.github/workflows/mutation-pr.yml:34-42`, with a comment explaining why: a changed-file core run approaches the 60-minute cap), and that whole workflow is `continue-on-error` regardless. **So this step is the only mutation signal plan 1 will ever get** — nothing in CI will catch it if you skip it or if it silently scores zero. That is why the instrumentation-line check above is mandatory rather than advisory.

Expected: a non-zero score with no surviving mutants — specifically:

- `idleFor > idleAfter` → `>=` is killed by the "reports not-idle EXACTLY at the threshold" unit case **and** by the boundary property at offset 0. It is killed by nothing else: that mutant differs from the original at exactly ONE instant, which the far-field oracle property never generates.
- `idleFor > idleAfter` → `<` / `true` / `false` are killed by the before/at/after triple **and** by both oracle properties (the tautological restatement they replaced would have survived all of these).
- `Number.isNaN(now.getTime())` removal is killed by the Invalid-Date `now` case.
- `Math.max(0, ...)` removal is killed by the clock-skew clamp case and the skew-safety property.
- `!Number.isFinite(value) || value < 0` mutants are killed by the `assertDurationMs` rejection cases in `duration.test.ts`.
- `Number.isNaN(lastProgress)` removal is killed by the unparseable-timestamp case **and** by the AC6 property (Step 6), which states it over the whole space of unparseable strings rather than at the single point `'not-a-date'`.

**If the score is 0.00%, the cause is the import, not the tests.** Confirm both test files import `claim-activity.js` with a top-level static `import` — a dynamic `await import(...)` hides the module from Stryker's static related-tests graph (#541). Do not paper over a surviving mutant: add the input that makes the forced branch observable.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runbook/claim-activity.ts \
  packages/core/src/runbook/duration.ts \
  packages/core/src/errors/codes.ts \
  packages/core/src/errors/factory.ts \
  packages/core/src/errors.ts \
  packages/core/src/runbook/index.ts \
  packages/core/__tests__/runbook/claim-activity.test.ts \
  packages/core/__tests__/runbook/claim-activity.properties.test.ts \
  packages/core/__tests__/runbook/duration.test.ts
git commit -m "feat(core): add pure claimActivity idle derivation (#519)"
```

---

## Task 3: `SessionService.recordClaimProgress` — bearer-scoped, best-effort, non-masking (AC5, AC7)

**Files:**

- Modify: `packages/core/src/runbook/claim-id.ts:428-431` (add `progressedClaimRecord` beside `refreshedClaimRecord`)
- Modify: `packages/core/src/runbook/session-service.ts` (add `recordClaimProgress` after `verifyClaimId` at `:361`; add the result type near the file's other result types)
- Test: `packages/core/__tests__/runbook/claim-progress.test.ts` (create)

**Interfaces:**

- Consumes: `parseClaimBearer`, `verifyClaimSecret`, `refreshedClaimRecord`'s sibling shape (all already imported in `session-service.ts:18`), `SessionService.withLock` (`:247`), `progressedClaimRecord` (new, this task); `claimActivity` + `DEFAULT_IDLE_AFTER_MS` from Task 2 (the seam round-trip test only).
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

  it('refreshes ONLY the presented claim, never another (AC5)', async () => {
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

  it('never throws when the session write fails — it returns record-failed (AC7)', async () => {
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

  it('never throws when the session LOCK cannot be acquired (AC7)', async () => {
    // The `try` wraps `withLock`, not just its callback — this is the case that
    // pins that choice, and it is the only one of the three that exercises the
    // OUTER path. The other two throw from INSIDE the callback (saveSession
    // rejects; parseClaimBearer throws), so narrowing the try to the body would
    // keep both of them green while silently breaking the documented contract.
    //
    // Operationally the most likely of the three: SessionLock retries with
    // jittered backoff bounded to 5s before failing, so a contended session is a
    // real source of acquisition failure — and it must cost one under-reported
    // progress mark, never a failed `rundown pass` whose mutation already committed.
    const acquireSpy = jest
      .spyOn(sessionLock, 'acquire')
      .mockRejectedValue(new FileLockTimeoutError(sessionLockPath(cwd)));

    const { claimId } = await sessionService.issueRunControlClaim(runId);
    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('record-failed');
    acquireSpy.mockRestore();
  });

  it('never throws when loading the session fails (AC7)', async () => {
    // The fourth throw site, and the one most likely to fire in practice: THIS VERY
    // PLAN makes `loadSession` throw on a class of sessions it previously accepted
    // (Task 1's structural guard). A recorder that survives a save failure but dies
    // on a load failure would surface as a failed `rundown pass` whose mutation had
    // already committed — the exact RD-102 defect, arriving through the one door
    // this plan just installed.
    const { claimId } = await sessionService.issueRunControlClaim(runId);
    const loadSpy = jest
      .spyOn(manager, 'loadSession')
      .mockRejectedValue(new Error('Legacy claim record format detected.'));

    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('record-failed');
    loadSpy.mockRestore();
  });

  it('writes a lastProgressAt that claimActivity can read back (seam round-trip)', async () => {
    // The ONLY end-to-end evidence available in plan 1: Task 2 derives activity and
    // Task 3 records it, but nothing else in this plan ever connects the two, and
    // plan 2 is a separate PR. If `recordClaimProgress` wrote a format `claimActivity`
    // could not parse, EVERY test in both tasks would still pass — and the failure
    // would surface as RD-824 on a healthy claim, i.e. a live child libelled as
    // corrupt, only once plan 3 shipped a surface to see it on.
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    const result = await sessionService.recordClaimProgress(claimId);
    expect(result.kind).toBe('recorded');

    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    const activity = claimActivity(stored, new Date(), DEFAULT_IDLE_AFTER_MS);
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBeLessThan(1_000);
  });

  it('sets lastProgressAt to issuedAt on BOTH real minting paths (AC1)', async () => {
    // AC1 says "set at claim creation". Task 1 tests `createClaimRecord` directly, but
    // production never calls it directly — these two are its only call sites
    // (session-service.ts:335, :544). A record built correctly by a function nobody
    // calls that way satisfies nothing.
    const { claim: runControl } = await sessionService.issueRunControlClaim(runId);
    expect(runControl.lastProgressAt).toBe(runControl.issuedAt);

    const { claim: delegated } = await mintDelegatedChildClaim();
    expect(delegated.lastProgressAt).toBe(delegated.issuedAt);
  });
});
```

> `mintDelegatedChildClaim` is a stand-in — there is no such helper. Find the delegated-child mint's real entry point (`session-service.ts:544` is the `createClaimRecord` call; walk up to the public method that reaches it) and drive it the way an existing suite does: `grep -rln "claimRunbook\|issueDelegated" packages/core/__tests__/runbook | head`. Copy that suite's setup rather than inventing one.

> **The lock-acquisition case needs a handle on the lock instance — and it already has one.** `SessionService`'s constructor is `constructor(manager: RunbookStateManager, lock?: SessionLock)` (`session-service.ts:230-235`), defaulting to `new SessionLock(manager.cwd)`. So the suite **constructs the lock and passes it in**, then spies that instance:
>
> ```typescript
> const sessionLock = new SessionLock(cwd);
> const sessionService = new SessionService(manager, sessionLock);
> ```
>
> No prototype spy, no DI change, no seam reshaping. An earlier draft hedged over whether the constructor took the lock and offered a `SessionLock.prototype` fallback — it does, so the first branch resolves and the fallback is dead guidance.
>
> **Exact signatures, verified — the earlier draft got both wrong:**
>
> - `sessionLockPath` is exported from **`packages/core/src/paths.ts:211`**, NOT from `session-lock.ts` (which only imports it aliased and re-exports `SessionLock` / `SessionLockTimeoutError`).
> - `FileLockTimeoutError`'s constructor is **`(lockFile: string, message?: string)`** (`file-lock.ts:74`). The second argument is a message override, so the draft's `new FileLockTimeoutError(sessionLockPath(cwd), 5000)` is a **type error**. Pass the path alone.
> - `SessionLock.acquire()` actually throws `SessionLockTimeoutError` (`session-lock.ts:16`), a `FileLockTimeoutError` subclass. Either works for this test — the assertion is on totality, not the error's identity.

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
   * CALL ONLY OUTSIDE A HELD SESSION LOCK. This method self-acquires the session
   * lock via `withLock`, and the underlying file lock is NOT reentrant: it reclaims
   * a lock only when its owner is DEAD (`kill(pid, 0)` -> ESRCH). Call it from
   * inside an existing `withLock` scope and the live owner is you — the acquire
   * spins its jittered backoff to the full 5s deadline, throws, and the totality
   * contract below silently converts that into `record-failed`. The symptom is a
   * 5-second stall on every affected command plus a claim that under-reports
   * progress, with no error anywhere: totality MASKING a deadlock rather than
   * exposing it. Plan 2's call sites record AFTER the mutation's lock scope closes.
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

> The `try` wraps `withLock`, not just the body, so a lock-acquisition failure and a `parseClaimBearer` throw on a malformed bearer are also swallowed. That is deliberate: totality is the contract. The outer `catch` is safe rather than an RD-102 defect in its own right because **the `heldLock` disposer never throws** — so the catch can only ever see a genuine body/acquire error, never a release failure.
>
> **`no-claim` deliberately collapses "key not in session" and "secret did not verify".** A reader will notice that the adjacent `ClaimVerificationResult` (`claim-id.ts:183-186`) distinguishes them (`missing` / `invalid-secret`) and may try to "restore" the distinction. Do not: `unstashForClaimId` already collapses the same pair into `missing-claim` (`session-service.ts:1027`, `:1032`) — the template this method follows — and a best-effort recorder has no use for the difference. Both mean "nothing to record", and neither is reported to anyone.
>
> **The bearer-verify preamble is now the FOURTH copy** (`verifyClaimId:361-368`, `getActiveForClaimId:579-585`, `unstashForClaimId:1024-1031`, and this). The duplication is *forced* here — `verifyClaimId` loads its own session outside the lock, while this must read-modify-write the session it already holds — so it is not a defect to fix in this task. But it is an auth-shaped path copied four times: if a future task touches this cluster, a private `#resolveVerifiedClaim(session, parsed): ClaimRecord | undefined` is the obvious extraction, and it is cheaper to do while adding a copy than after.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest claim-progress.test.ts`

Expected: PASS (all **eleven** cases — the eight totality/scoping cases plus the loadSession-failure, seam round-trip, and both-minting-paths cases).

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

## Task 3b: Ship plan 1 (verify gate + PR)

**Files:** none — this task runs gates and opens the PR.

**Interfaces:**

- Consumes: everything Tasks 1–3 landed.
- Produces: a merged plan-1 PR. **Plan 2 cannot start until this merges** — it consumes `recordClaimProgress` and `ClaimActivity`.

- [ ] **Step 1: Run the pre-PR verification gate**

Run: `pnpm run verify`

Expected: PASS (format, spell, lint, build, typecheck, tests across all packages). **Mandatory before every push** per CLAUDE.md — this plan is its own PR, so it needs its own gate; do not defer it to plan 3.

- [ ] **Step 2: Confirm the scoped mutation gate still holds (AC13)**

Task 2 Step 8 already ran it. Re-run it here only if you touched `claim-activity.ts` or `duration.ts` after that step:

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate src/runbook/claim-activity.ts,src/runbook/duration.ts \
  --testFiles __tests__/runbook/claim-activity.test.ts,__tests__/runbook/claim-activity.properties.test.ts,__tests__/runbook/duration.test.ts
```

Expected: `Instrumented 2 source file(s) with N mutant(s)` and no survivors. **Check that instrumentation line, not just the score** — paths here are **package-relative** (cwd is `packages/core`), and the repo-relative form silently instruments **0 files and exits 0**. **Not** `pnpm run test:mutate:core -- …` and **not** `pnpm --filter … test:mutate -- …`. See Task 2 Step 8: all three failure modes look like success, and core is excluded from the PR mutation matrix, so nothing else will catch a gate that never ran.

- [ ] **Step 3: Sanity-check what this PR does and does not claim**

Confirm before writing the PR body — a reviewer will ask, and the honest answer is the point of this seam:

- `recordClaimProgress` is **shipped but uncalled**. That is intended: plan 2 supplies its call sites. Say so in the PR body rather than letting a reviewer discover an unused export and assume it was forgotten.
- This PR **breaks active runbook sessions** whose claims predate `lastProgressAt`. Per CLAUDE.md that is acceptable and preferred over compatibility code; the recovery path is finish, prune, or restart. Say this in the PR body too — it is the only user-visible effect of the whole PR.
- No user-visible behaviour otherwise: nothing records, nothing reports idle.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin claim-progress-idle-detection
gh pr create --title "feat(core): claim progress foundation — required lastProgressAt, pure activity module, recording API (#519)" --body "$(cat <<'BODY'
Plan 1 of 3 for #519 (see docs/superpowers/plans/2026-07-17-claim-progress-1-foundation.md).

Lands the three foundations, with no behaviour change visible to a user:

- `ClaimRecord.lastProgressAt`, **required**, set to `issuedAt` at creation, with a structural `loadSession` guard that **rejects** sessions whose claims lack it (finish/prune/restart — no migration, per CLAUDE.md).
- `duration.ts` + `claim-activity.ts` — the duration primitive and the pure derivation seam. `now` is injected; a corrupt timestamp throws `CLAIM_PROGRESS_UNREADABLE` (RD-824) rather than failing open as `progressing`.
- `SessionService.recordClaimProgress` — bearer-scoped, best-effort, **never throws** (RD-102), so it cannot mask an already-committed mutation.

**`recordClaimProgress` has no call sites yet — that is plan 2**, deliberately: the field change is the one breaking, un-revertable-in-place part of #519 and it ships once, on its own, where it can be reviewed whole.

**Breaking:** active sessions with pre-existing claims are rejected on load. Recovery is finish, prune, or restart.

AC1, AC2, AC6, AC8, AC13, and AC7's totality half (the masking half needs a call site — plan 2).
BODY
)"
```

---

## Self-Review

**Spec coverage.** AC1, AC2 (Task 1); AC6, AC8, AC13 (Task 2); **AC7's totality half only** (Task 3 — the masking half needs a committed mutation to mask, which plan 2 supplies; do not tick AC7 whole). AC5 is deliberately **not** ticked — Task 3 pins that `recordClaimProgress` touches only the presented claim, but AC5 is not satisfied until plan 2 proves each of the eight call sites passes `callerEvidence.claimId` rather than `target.claimId`. AC13's `humaniseDurationMs` half belongs to plan 3 Task 6 Steps 4b/4c, and plan 3's AC section claims it. AC3/4/9/10/11/12/14 are out of scope here and no task attempts them.

**Placeholder scan.** No `TBD` / `TODO` / "add appropriate error handling". Every code step shows the code. Every named helper resolves: the four invented symbols earlier drafts carried (`findDetailOutput`, `buildSeam`, `applyCollection`, `driveNonRecording`) are gone from all three plans, and the two that exist-but-need-work (`readSession`'s retype, `setupParentWithChildren`'s extraction) are plan 2 Task 5 Step 0, declared as such.

**Type consistency.** `DurationMs` / `assertDurationMs` (in `duration.ts`) / `ClaimActivity` / `claimActivity` / `DEFAULT_IDLE_AFTER_MS` / `isClaimProgressUnreadable` / `progressedClaimRecord` / `ClaimProgressRecordResult` are defined here and consumed under exactly these names by plans 2 and 3. `ClaimActivity` is a **readonly interface**, not a union — a two-variant union with identical fields is a boolean in costume that no caller narrows. The union that earns narrowing is `ChildActivity`, added by **plan 3** Task 6 to this same module; do not add it here, it has no consumer until the status surface exists. `progressedClaimRecord` (moves `lastProgressAt`) stays distinct from the untouched `refreshedClaimRecord` (moves `updatedAt`) — one field, one meaning, and collapsing them is the conflation this design exists to prevent.

## Findings retained from review — do not re-derive, do not reintroduce

**The fixture thesis was INVERTED, and the correction is the File Structure's three-tier table.** Shorthand-vs-colon determines which files your **grep** finds; **type annotation** determines whether the compiler catches them. An earlier draft warned about the three "shorthand" files — all of which are annotated and fully compile-visible — and left the genuinely invisible ones unmarked. The tiers were derived **empirically** (field added, `check:types` + both suites run, results recorded): Steps 11 and 12 both go green with four fixtures wrong. Work the table; do not re-reason it from punctuation.

**But the tiers are a DIAGNOSIS, not the treatment — that was the next draft's error, and Step 0 is the correction.** Having established that Tier 3 rots invisibly, an earlier draft's answer was to *document it harder*: forty lines of prose, a hand-worked table, and a one-shot manual ritual (Step 12b) to be performed once and leave no artefact. That is a plan that explains a hazard rather than removing one. The condition that CREATES Tier 3 is that twelve suites each spell the `ClaimRecord` shape out independently — eight of them already hand-rolling a local factory under four different names. Remove that condition and nine of the twelve can no longer rot, because they no longer name the shape. What must stay raw (three literals that test the validation boundary itself) is a genuine floor, and the two subtlest of those get a **permanent positive control** rather than a ritual. **When a plan finds itself writing at length about why its own backstops cannot catch something, the finding is usually that the structure is wrong, not that the prose is insufficient.**

**Confirmed sound by review — do not "fix" these.** The RD-102 non-masking design genuinely works: wrapping `withLock` (not just its callback) captures both acquire failures and `parseClaimBearer` throws, so `recordClaimProgress` is total as advertised — which is why Task 3 tests the lock-acquisition path specifically, as it is the only one of the three exercising the outer `try`. It works for a reason worth stating, because it is what makes the outer `catch` safe rather than an RD-102 defect in its own right: **the `heldLock` disposer never throws**, so the `catch` can only ever observe genuine body/acquire errors — never a release failure masquerading as one. The lock ordering checks out against the documented ABBA proof at `lifecycle-command-service.ts:2174-2192`. The #541 static-import mitigation is correct.

**`ClaimActivity` as a readonly interface is CORRECT — reviewed twice, do not turn it into a union.** CLAUDE.md's "type-driven dispatch" asks for unions that make invalid states unrepresentable. A two-variant union with identical payloads makes nothing unrepresentable — `idle: true` alongside `idleFor <= idleAfter` is equally constructible in both shapes — and no caller narrows it. The union that genuinely earns narrowing is `ChildActivity` (`known` | `unreadable`) at plan 3's read boundary, whose members carry different data.

**`lastProgressAt` stays a bare `string`, and here is the argument the earlier draft never made.** The tension is real and a reviewer will raise it: AC6 calls corrupt timestamps *the* central hazard, yet this design brands `idleFor` while leaving the corrupt-prone field unbranded, and the plan itself notes the hole (`z.string().min(1)` admits `'not-a-date'`) without closing it. A stronger type is available — `z.string().refine(isIsoTimestamp)` in `ClaimRecordSchema` would make `CLAIM_PROGRESS_UNREADABLE` **unrepresentable**. It is deliberately not taken, because schema-level rejection is **wholesale**: one corrupt claim would fail the entire `loadSession`, erasing every healthy sibling from the report and leaving the parent to conclude nothing needs checking. That is precisely the fail-open-by-erasure this design rejects in the Global Constraints ("a boundary that catches around the **whole list** and returns `[]` is a **worse fail-open** than the NaN it exists to prevent") — arriving through the parser instead of through a `NaN` comparison. **Per-child containment REQUIRES the corrupt value to survive parsing.** Consistency with `issuedAt` / `updatedAt` (`claim-id.ts:100-103`, both bare `string`) points the same way.

**A claim to distrust:** "claim tombstones survive every terminal path" is **false**, and it survived four review rounds on plausibility. `releaseRunbook` **deletes** a run's claim records unless the caller passes `retainClaimsAsTerminal` (`session-service.ts:907-917`). It matters here because it is why `ClaimProgressRecordResult` needs a `no-claim` member at all: a claim can legitimately be gone by the time a record is attempted. Plan 2 carries the full retraction.

**Editing these plans? The signature failure mode is a repair that cannot execute.** Five review rounds on the single-plan draft found the same shape repeatedly: a fix that was sound in reasoning and broken in mechanics — a drift guard whose scan was fed by its own tables, a `expect(actual, reason)` that is Vitest syntax under Jest, a mutation gate whose flags never reached Stryker, a pointer to a helper that did not exist. Each looked right and could not run. **A repair that cannot execute is worth less than the defect it replaces, because it also spends the reader's trust.** If you change a command, a probe, or a fixture pointer here, run it.
