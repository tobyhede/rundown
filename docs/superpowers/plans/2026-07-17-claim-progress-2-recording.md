# Claim Progress: Recording — Wire the Rule, Guard the Drift (#519, plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make progress actually get recorded — call `SessionService.recordClaimProgress` from every one of the eight claim-authenticated commands that change runbook workflow state — and pin the classification of all eleven `--claim-id` commands with a fail-closed drift guard that is proven to bite.

**Architecture:** No new production types. Plan 1 shipped `recordClaimProgress` as a tested but unused core API; this plan supplies its call sites and its enforcement. Six commands record from core seams (`runTransition`, `runTerminal`, `issueDelegation`, collect); `goto` and `abort` record from the CLI because their core services are authorization **gates** that return `authorized`/`refused` and mutate nothing — the CLI invokes the core API rather than re-implementing it, which the spec sanctions **explicitly and only because the drift guard exists**. Recording is always last: verify bearer → authorize grant → commit mutation → best-effort record. It never throws and never masks the committed mutation.

**Why the guard is a task and not a test file.** Spec `:103` stakes the acceptability of the two CLI-side seams **entirely** on it: "the guard, not the seam's uniformity, is the guarantee." An inert guard means no guarantee at all and the CLI silently owning the policy of when progress is recorded. An earlier draft of this guard could not fail — its scan was built by registering the same tables it then compared against, so both sides shrank together and a new `rundown foo --claim-id` was never registered, never classified, and never noticed. That history is why the guard's construction is spelled out at length in Task 5, and why Step 3 makes you prove each probe bites.

**This plan is 2 of 3. Task numbers are retained from the original single plan (Tasks 1–3 in plan 1, 4–5 here, 6–8 in plan 3)** so every cross-reference across all three documents stays valid. Do not renumber them.

- Plan 1: `docs/superpowers/plans/2026-07-17-claim-progress-1-foundation.md` — AC1, AC2, AC6, AC7, AC8, AC13 — **must be merged before this plan starts**
- Plan 2 (this): `docs/superpowers/plans/2026-07-17-claim-progress-2-recording.md` — AC3, AC4, AC5, AC11
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

**Tech Stack:** TypeScript, Jest (integration), pnpm workspaces, Commander (the guard scans the real program). Packages: `@rundown-org/core` (six recording call sites), `@rundown-org/cli` (the `goto`/`abort` call sites, the drift guard, the shared test fixtures).


## What plan 1 must have landed first

This plan does not compile without them. If any is missing, stop and finish plan 1.

- **`SessionService.recordClaimProgress(claimId: ClaimId): Promise<ClaimProgressRecordResult>`** — never throws; returns `recorded` / `no-claim` / `record-failed`. Every task here is a call site for it.
- **`ClaimRecord.lastProgressAt`** — required, set to `issuedAt` at creation. The guard backdates it to detect movement.
- **`claimActivity` / `DEFAULT_IDLE_AFTER_MS`** from `@rundown-org/core` — Task 5's stash/pop anti-fooling loop asserts a backdated claim still reads idle after the loop.
- **`packages/core/__tests__/runbook/claim-progress.test.ts`** — plan 1 created it; Task 4 extends it with the adoption cases (AC11), which need real command seams and so could not live in plan 1.

Verify before starting: `pnpm --filter @rundown-org/core exec jest claim-progress claim-activity` — expected PASS.

## Acceptance Criteria owned by this plan

Verbatim from `docs/superpowers/specs/2026-07-16-claim-progress-idle-detection-design.md`.

- **AC3** — Every successful claim-authenticated command that changes runbook workflow state refreshes `lastProgressAt` — `pass`, `fail`, `complete`, `stop`, `collect`, `delegate`, `goto`, `abort`. Commands that change only session targeting (`stash`, `pop`), that change nothing (`status`), and mutations that fail, do not. *(Task 4, pinned by Task 5)*
- **AC4** — A fail-closed drift guard classifies all eleven claim-authenticated commands and pins the set in both directions, so a command added later cannot silently miss recording or silently start. Its scan is sourced from the real `createProgram()`, never from the guard's own tables, and is proven to bite — including against a newly added `--claim-id` command. *(Task 5)*
- **AC5** — A command refreshes only the claim whose bearer it presented, never another claim. *(Task 4 — the call sites must pass `input.callerEvidence.claimId`, never `target.claimId`. Task 5's abort case is the sharpest test of it.)*
- **AC11** — Adopting a claim from a fresh session via a mutating command clears idle. *(Task 4)*

**AC7** was satisfied by plan 1 at the API level; Task 4 re-pins it at the seam — a failed progress write must not fail or mask the committed mutation.

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
- **An unparseable `lastProgressAt` THROWS — as a typed `RundownError`, not a bare `Error`.** Never classify it as `progressing`: "every `NaN` comparison is false — so `idleFor > idleAfter` would be false and a dead claim would silently classify as `progressing`. That is the single worst failure this design can have: a safety signal that fails *open*, quietly, in exactly the case it exists to catch." The throw carries `ErrorCodes.CLAIM_PROGRESS_UNREADABLE` (RD-824, added by Task 2) so callers and tests discriminate **on the code**. A bare `Error` would be distinguishable from `assertDurationMs`'s throw — out of the same function — only by message substring, so a harmless reword would silently gut AC6 with every test still green. `assertDurationMs` throws a **`RangeError`**, and the Invalid-Date `now` precondition throws a `RangeError` too, so a read boundary sorts all three BY TYPE: `RundownError` -> contain as `unreadable`, `RangeError` -> rethrow (caller bug), anything else -> rethrow. No message substring anywhere.
- **`ClaimActivity` is a `readonly interface`, not a union.** A two-member union whose variants carry **identical** fields is a boolean in costume: no caller narrows, both consumers flatten it straight back to `activity.kind === 'idle'`, and the spec's own naming table says `idle: boolean`. Type-driven dispatch means unions that force narrowing — not ceremony that doesn't. The union that **does** earn its keep is `ChildActivity` at the read boundary (`known` | `unreadable`), whose members differ in the data they carry and which callers genuinely must narrow.
- **Recorded on success, not on attempt.** A failed mutation records nothing. "A live-but-erroring child correctly reads as idle — a true positive worth surfacing."
- **A command refreshes only the claim whose bearer it presented.** Never another claim. `collect --claim-id <orchestrator-claim>` refreshes the orchestrator's own claim, **not** the children's. "A parent cannot vouch for a child's liveness, and must not appear to."
- **Recording is best-effort and never masks the mutation.** Ordering is fixed: verify bearer → authorize grant → commit mutation → best-effort record progress. `recordClaimProgress` never throws and never propagates (RD-102 policy).
- **`claimActivity` is pure.** No I/O, no clock read — `now` is injected. `DEFAULT_IDLE_AFTER_MS = 60 * 60 * 1000` (one hour). **No configuration surface in this change.**
- **Advisory only (AC12).** No expiry, no reclaim, no auto-abort, no synthesized child PASS/FAIL, **no machine state, no events**, no `rundown heartbeat` command, no probing. Nothing under `packages/core/src/runbook/compiler*.ts`, `actors/`, or any event type is touched by this plan.
- **`idle` iff `idleFor > idleAfter` — strictly greater.** Exactly at the threshold is `progressing`.
- **JSON is the contract and the default.** `idleFor` is milliseconds in JSON; `--text` renders it humanised. CLI tests exercise the default JSON path first; `--text` is covered separately (CLAUDE.md Testing Conventions).
- **Mutation gate imports must be STATIC.** Per #541's lesson, `claim-activity.test.ts` must import `claim-activity.js` with a top-level static `import`, or Stryker's static related-tests graph will not see the module and it will score 0.00%.
- **TSDoc on every exported symbol** (description, `@param`, `@returns`, `@throws`) per CLAUDE.md TSDoc Standards.
- **Branch: cut `claim-progress-recording` fresh from an updated `main`** — do NOT reuse `claim-progress-idle-detection`. That branch carries plan 1's PR; once it merges (squash-merge especially, which rewrites the commits), continuing on it would re-propose plan-1 changes in plan 2's PR or conflict outright. The original single-plan draft said "Branch is `claim-progress-idle-detection`. Do not switch or create branches" because it was one PR; three sequential PRs need three branches. Start with:
  ```bash
  git checkout main && git pull            # plan 1 must already be merged
  git checkout -b claim-progress-recording
  ```
  Then do not switch or create further branches within this plan.

---

## Background: what exists today

- `ClaimRecord` (`packages/core/src/runbook/claim-id.ts:89`) has `claimKey`, `secretHash`, `controlledRunId`, `delegation?`, `grants`, `issuedAt`, `updatedAt`.
- `createClaimRecord` (`claim-id.ts:402`) takes `{ ..., now }` and sets `issuedAt: input.now, updatedAt: input.now`. It has exactly **two** production call sites, both in `session-service.ts` (`:335` `mintRunControlClaim`, `:544` the delegated-child mint). Setting `lastProgressAt: input.now` there satisfies AC1 for both.
- `refreshedClaimRecord` (`claim-id.ts:428`) is `{ ...record, updatedAt: now }`. Its only caller is `unstashForClaimId` (`session-service.ts:1060`).
- `SessionService.withLock` (`session-service.ts:247`) is `acquire` + `await using this.lock.held()` + `fn()`. **It is NOT reentrant** — see the Global Constraint on lock reentrancy.
- `SessionService`'s constructor is `constructor(manager: RunbookStateManager, lock?: SessionLock)` (`session-service.ts:230-235`), defaulting to `new SessionLock(manager.cwd)`. A test that wants to spy the lock **passes its own instance** — no DI change, no prototype spy.
- `sessionLockPath` is exported from `packages/core/src/paths.ts:211` — **not** from `session-lock.ts`. `FileLockTimeoutError`'s constructor is `(lockFile: string, message?: string)` (`file-lock.ts:74`) — the second argument is a message override, not a timeout number.
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
- There was no `DurationMs` type and no duration humaniser in the repo before #519. **`DurationMs` and `assertDurationMs` are introduced by plan 1** (Task 2) in their **own** module `packages/core/src/runbook/duration.ts` — NOT in `claim-activity.ts`, because a duration primitive is general and plan 3's humaniser is a generic consumer of it. **The humaniser is plan 3's** (Task 6, `packages/cli/src/helpers/duration.ts`). The original single-plan draft said "both are introduced by this plan", which is now true of neither plan 2 nor plan 3 — check the task index before assuming either is yours to build.
- **The branded-primitive convention is `declare const … : unique symbol`, NOT `__brand`.** Verified: `__brand` on a primitive appears exactly once in `packages/core/src` (`targeting.ts:20`, `FrameKey`), and in that same file `__brand` is also a **runtime property** on `OpenFrames` (`:259`, `:290`) — so it is not even a pure type brand there. Every other branded primitive uses a unique symbol, including all three in `claim-id.ts` (`:7-9`). **A symbol brand crosses the package boundary fine** — `run-id.ts:1` writes `export declare const runIdBrand: unique symbol` precisely so `RunId` survives into `@rundown-org/cli`, which it does today. `DurationMs` follows that form; do not copy `targeting.ts`.
- **Production code never calls `new RundownError(...)` directly.** All 42 production throws in core live behind the `Errors` factory (`errors/factory.ts:7`); the only other file containing the constructor is `rundown-error.ts` itself. Plan 1 adds `Errors.claimProgressUnreadable`.
- **`RundownError.formatMessage` renders a FIXED key list** (`rundown-error.ts:99-134`): `file, step, substep, line, message, expected, found, value, scenario, argName, childId, agentId`. Any other context key lands in `context` (reachable only via `toJSON()`) and is **invisible in `error.message`** — and `ErrorContext`'s index signature (`:32`) means TypeScript will not warn you. Plan 1's RD-824 throw uses `value` (the corrupt timestamp) and `childId` (the claim key) for exactly this reason.
- **`recordClaimProgress` SELF-ACQUIRES the session lock, and the file lock is NOT reentrant. Never call it from inside a held session lock.** `withLock` (`session-service.ts:247`) calls `this.lock.acquire()` unconditionally, and `acquireFileLock` reclaims a lock only when its owner is **dead** (`kill(pid, 0)` -> ESRCH; `file-lock.ts:112-114`). Call it from within an existing `withLock` scope and the live owner is *you*: the acquire spins its jittered backoff to the full `LOCK_DEADLINE_MS = 5_000` (`file-lock.ts:23`), throws, and `recordClaimProgress`'s totality contract **silently converts that into `{ kind: 'record-failed' }`**. The symptom is a 5-second stall per command plus a claim that silently under-reports progress, with no error anywhere — totality masking a deadlock instead of exposing it. **Record AFTER the mutation's lock scope closes, never nested inside one.** `collect` is the live risk: `collection-service.ts:517-525` already calls `sessionService.releaseRunbook`, itself a `withLock` (`session-service.ts:856`).
- **Stryker's `--mutate` / `--testFiles` globs are PACKAGE-RELATIVE, not repo-relative.** `pnpm --filter <pkg> exec` runs with cwd = the package dir, so `--mutate packages/core/src/x.ts` matches **nothing** and Stryker reports `Instrumented 0 source file(s) with 0 mutant(s)` and **exits 0** — a gate that cannot fail. Verified by running it. Pass `src/x.ts` / `__tests__/x.test.ts`. `.github/workflows/mutation-pr.yml:96` strips the prefix (`sed "s#^${PKG_DIR}/##"`) for the same reason, and each `stryker.config.mjs`'s own `mutate` array is package-relative (`'src/**/*.ts'`). **Always check the `Instrumented N source file(s)` line before reading a score** — `incremental: true` means a stale baseline can print a plausible score over a zero-mutant run.

---


## File Structure

**Created:**

- `packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts` — the fail-closed guard classifying all eleven claim-authenticated commands and pinning both directions (AC4). Modelled on `run-option.test.ts:50`'s table + `it.each` structure, but — decisively unlike it — sourcing its scan from the **real** `createProgram()`.

**Modified — production call sites (the eight):**

- `packages/core/src/runbook/lifecycle-command-service.ts` — `runTransition` (`pass`/`fail`), `runTerminal` (`complete`/`stop`), `issueDelegation` (`delegate`). Each records only on its own union's committed-success members.
- `packages/core/src/runbook/collection-service.ts` — `collect`, after the collection commits.
- `packages/cli/src/helpers/goto-workflow.ts:309` — `goto` records after `sendAndSync` commits. Core's `resolveRunNavigation` is a gate; this is the CLI invoking the core API, not re-implementing it.
- `packages/cli/src/commands/goto.ts` — thread `claimId` into the goto context so the workflow has the presented bearer to record with.
- `packages/cli/src/commands/abort.ts:203` — `abort` records after `manager.update` commits. Same reasoning; `AbortCommandService.authorizeAbortCommand` is a gate.

**Modified — shared test fixtures (Task 5 Step 0, a prerequisite for this plan AND plan 3):**

- `packages/cli/__tests__/helpers/test-utils.ts` — export the extracted `setupParentWithChildren`; **retype `readSession`'s `claims`** from `Record<string, Record<string, unknown>>` to `Record<string, ClaimRecord>` (without this, every snippet in Tasks 5/6/7 is a compile error); add `backdateClaimProgress`, which must **throw** rather than no-op on a missing key.
- `packages/cli/__tests__/integration/delegate-workflow.test.ts` — `setupParentWithChildren` (`:167`, nested in the `describe` at `:109`, in a file with **zero exports**) moves out to `test-utils.ts` and is imported back.
- `packages/core/__tests__/runbook/claim-progress.test.ts` — extend with the adoption cases (AC11).

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

  The proof that "harmless" is really harmless, which review had to establish and which is easy to lose: the terminal paths that retain claims — `complete`, `stop`, `collect`, and terminal-driving `pass` — all pass `retainClaimsAsTerminal: true`, so **a recording command always finds its own claim** and the write lands on a real record rather than silently hitting `no-claim`. Do not generalise that into "claim tombstones survive every terminal path" — **that broader claim is false**, and it survived four review rounds on plausibility before anyone re-derived it. `releaseRunbook` **deletes** a run's claim records unless the caller passes `retainClaimsAsTerminal` (`session-service.ts:907-917`), and the force-abort cleanup path does **not** pass it (`lifecycle-command-service.ts:1253`, `:1262`). That is precisely why Task 5's abort AC5 test is built around a **bystander** child rather than the aborted one: the aborted child's record is gone either way, so "its mark did not move" is unobservable. If you find yourself reasoning that a terminated claim is still readable, re-derive it from `releaseRunbook` before believing it.
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

  it('a failed progress write neither fails nor masks the committed mutation (AC7, RD-102)', async () => {
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

  it('adoption self-heals: a fresh session mutating with the bearer clears idle (AC11)', async () => {
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
    // `seam` is the suite's own fixture (see the note below for its real name and
    // wiring) — do NOT invent a `buildSeam(cwd)` factory; no such symbol exists.
    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
    });
    expect(outcome.kind).toBe('applied');

    expect(
      claimActivity(
        (await manager.loadSession()).claims[claim.claimKey],
        new Date(),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(false);
  });

  it('adoption does NOT self-heal via `status --claim-id` (AC11)', async () => {
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

> **The real fixture names in `lifecycle-command-service.test.ts` (verified — `buildSeam` does NOT exist; do not grep for it and do not write it):**
>
> - `seam` is **`let`-declared** at `:124` (`let seam: RunbookLifecycleCommandService;`) and assigned in `beforeEach` at `:145` via `new RunbookLifecycleCommandService({ sessionService, actorService, lifecycleService, completionService, loadRun, ... })`. An earlier draft told you to `grep -n "buildSeam\|const seam"` — **both alternatives return nothing** (it is `let`, not `const`, and `buildSeam` is not a symbol in this repo), and since `buildSeam(cwd)` was itself only a placeholder, that grep was the plan's only route to the real name. It was a dead end; this list replaces it.
> - `buildIssuanceSeam(state, steps)` (`:235`) returns `{ seam, deps, manager, state }` — use it when you need a seam wired for delegation issuance.
> - `startSeamOnDelegateStep()` (`:280`) is the async wrapper that activates a delegate-step state and returns `buildIssuanceSeam(...)`'s shape; `:368` shows the `const { seam: localSeam } = await startSeamOnDelegateStep();` call form.
>
> Mirror the `beforeEach` at `:140-150` for a plain seam, or call `startSeamOnDelegateStep()` for a delegation one. `startingStep` is likewise a placeholder for whatever the suite's own starting-step constant is called — take it from the fixture you mirror. `claimActivity` and `DEFAULT_IDLE_AFTER_MS` import statically from `../../src/runbook/claim-activity.js`.

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

> `sessionService` is already destructured at the top of the method (`:1294`). The claim recorded is `input.callerEvidence.claimId` — the bearer the caller PRESENTED — never `target.claimId` or any claim discovered during resolution (AC5).

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
    // Only a COMMITTED issuance/retry advanced the run (#519). `already-delegated`
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

> **The member names are verified — use them as written.** `DelegationIssuanceOutcome` is declared at `packages/core/src/runbook/lifecycle-command-service.ts:281`. Its committed-success members are **`delegated`** and **`retried`**; the echo member is **`already-delegated`** — spelled with a **hyphen**, not the underscore an earlier draft guessed. The remaining members (`token-not-found`, `no-active-runbook`, `unknown_run`, `run_target_mismatch`, `refused`, `error`) commit nothing and record nothing.
>
> To re-read the union if the file has moved: `sed -n '281,330p' packages/core/src/runbook/lifecycle-command-service.ts`. An earlier draft printed `grep -n "readonly kind: '" <file> | sed -n '/281,400p/'`, which is **malformed** — `/281,400p/` is a regex address with no command attached, so sed errors out rather than filtering anything, and piping grep output into a line-range sed would not have selected the union's lines in any case.

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
  // child's liveness and must not appear to (#519 AC5). Best-effort; the callee
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

- [ ] **Step 6c: Prove no call site records inside a held SESSION lock**

`recordClaimProgress` self-acquires the session lock and the file lock is **not reentrant** (see the Global Constraint). A nested call does not fail loudly — it spins to the 5-second deadline, throws, and the totality contract converts that into a silent `record-failed`. So the symptom is a slow command and an under-reported claim, with **no error and no failing test anywhere**. That is a defect that documentation alone cannot prevent, and the reason this step exists.

Walk each of the six call sites and confirm the session lock is not already held on the path in:

```bash
grep -n "recordClaimProgress" packages/core/src packages/cli/src -r
```

For each hit, read outward to the enclosing function and check it is not inside a `sessionService.withLock` / `SessionService` mutation callback. The two that need a real look:

- **collect** — `collection-service.ts:517-525` calls `input.sessionService.releaseRunbook(...)`, itself a `withLock` (`session-service.ts:856`). That is **sequential, not nested**: `releaseRunbook` acquires and releases before returning, so a `recordClaimProgress` *after* it is safe. It would NOT be safe inside a callback passed to a `withLock`.
- **abort** — `packages/cli/src/commands/abort.ts` records after `await _lockGuard.release()`. That guard is the **delegation** lock, a different lock from the session lock, so there is no reentrancy question here either way — but recording after the release is still correct, and Step 6b's comment says why.

Now prove the safe case actually holds rather than assuming it, with a test that would catch a future nesting:

```typescript
  it('records progress without deadlocking on the session lock it already released (#519)', async () => {
    // Guards the reentrancy hazard the totality contract HIDES: if a call site ever
    // records from inside a held session lock, the acquire spins to the 5s deadline
    // and returns `record-failed` — no throw, no failing assertion, just a slow
    // command and a claim that reads idle while it is advancing. A `recorded` result
    // here is the evidence that the lock was genuinely free.
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    await sessionService.releaseRunbook(runId, { retainClaimsAsTerminal: true });

    const started = Date.now();
    const result = await sessionService.recordClaimProgress(claimId);

    // Not `record-failed`: that is what a deadlock degrades to.
    expect(result.kind).toBe('recorded');
    // And it must be prompt — a 5s wall means it contended with a lock it should
    // never have been holding.
    expect(Date.now() - started).toBeLessThan(1_000);
    const session = await manager.loadSession();
    expect(session.claims[claim.claimKey]).toBeDefined();
  });
```

> `retainClaimsAsTerminal: true` is load-bearing: without it `releaseRunbook` **deletes** the claim (`session-service.ts:907-917`) and the result is `no-claim`, which would pass a naive assertion for entirely the wrong reason. See the retraction in the retained findings.

- [ ] **Step 7: Run the seam tests to verify they pass**

Run: `pnpm --filter @rundown-org/core exec jest claim-progress.test.ts`

Expected: PASS — all cases, including the three invariant guards that were already green (the anti-fooling one especially: `verifyClaimId` must still not record) and the reentrancy case from Step 6c.

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
- Modify: `packages/cli/__tests__/helpers/test-utils.ts` — Step 0: export the extracted `setupParentWithChildren`, retype `readSession`'s `claims` to `Record<string, ClaimRecord>`, add `backdateClaimProgress`
- Modify: `packages/cli/__tests__/integration/delegate-workflow.test.ts:167` — Step 0: `setupParentWithChildren` moves out to `test-utils.ts`; import it from there

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

- [ ] **Step 0: Extract the shared fixtures — Tasks 5, 6 and 7 all depend on this**

Three suites need the same three helpers, and none of them can use them as they stand today. Do this first; it is a prerequisite, not a tidy-up.

**1. Extract `setupParentWithChildren`.** It is declared at `packages/cli/__tests__/integration/delegate-workflow.test.ts:167`, **nested inside the `describe` at `:109`**, and that file has **zero exports** — so it cannot be imported, and importing anything from a `.test.ts` would re-execute that entire suite inside the importing file. Lift it (and `issueRunControlClaim`, if it is likewise local) into `packages/cli/__tests__/helpers/test-utils.ts`, export it, and update `delegate-workflow.test.ts` to import it from there. `runCliInProcess` is already exported (`test-utils.ts:431`) — leave it alone.

Run: `pnpm --filter @rundown-org/cli exec jest delegate-workflow`
Expected: PASS — the extraction is behaviour-preserving, so its own suite must stay green before anything else builds on it.

**2. Retype `readSession`'s claims.** It already exists and is already exported (`test-utils.ts:227`) — **do not write a second one**, and ignore any instruction to "factor it into `test-utils.ts`". Its `claims` field is typed `Record<string, Record<string, unknown>>`, which makes every snippet in Tasks 5/6/7 a compile error: `Date.parse(claim.lastProgressAt)` passes `unknown` where `string` is required, and `claimActivity(claim, …)` passes `Record<string, unknown>` where `ClaimRecord` is required. Change the field to `Record<string, ClaimRecord>` and add `ClaimRecord` to the existing `import type { … } from '@rundown-org/core';` at `:32`.

This is safe, and verified: the only callers that dereference `.claims[…]` are `prune.test.ts:588`, `:595` and `:732`, and all three only assert `toBeDefined()` / `toBeUndefined()`, which compile unchanged against the narrower type.

**3. Write `backdateClaimProgress`** in `test-utils.ts` beside `readSession`:

```typescript
/**
 * Rewind a claim's `lastProgressAt` so a test can reach the idle threshold
 * without waiting an hour.
 *
 * @param workspace - Test workspace whose session file is rewritten.
 * @param claimKey - Non-secret claim lookup key. NEVER a bearer (`rdclm_…`) —
 *   convert with `claimKeyFromBearer` at the call site if that is what you hold.
 * @param iso - Timestamp to write, or any string when testing the corrupt path.
 * @throws If `claimKey` is absent from the session — see below.
 */
export async function backdateClaimProgress(
  workspace: TestWorkspace,
  claimKey: ClaimLookupKey,
  iso: string,
): Promise<void> {
  const raw = JSON.parse(await readFile(workspace.sessionPath(), 'utf-8')) as {
    claims?: Record<string, { lastProgressAt: string }>;
  };
  const claim = raw.claims?.[claimKey];
  // THROW, never no-op. A helper that silently does nothing when it cannot find
  // the key would make EVERY idle assertion in Tasks 5, 6 and 7 vacuously green —
  // the single highest-leverage way this feature's test suite could lie to us.
  // An earlier draft called this with a claimKey in one task and a BEARER in two
  // others; with a silent no-op, one of those families would have been asserting
  // nothing at all and no test would have said so.
  if (claim === undefined) {
    throw new Error(
      `backdateClaimProgress: no claim '${claimKey}' in session. ` +
        `Did you pass a bearer (rdclm_…) instead of a lookup key (rdclk_…)? ` +
        `Convert with claimKeyFromBearer().`,
    );
  }
  claim.lastProgressAt = iso;
  await writeFile(workspace.sessionPath(), JSON.stringify(raw, null, 2), 'utf-8');
}
```

- [ ] **Step 1: Write the guard**

Create `packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts`. Match `run-option.test.ts`'s table + `it.each` structure, but source the scanned program from `createProgram()`.

```typescript
// packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts

import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_IDLE_AFTER_MS,
  claimActivity,
  getErrorMessage,
  type RoleSpecificMutationCommand,
} from '@rundown-org/core';
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
 * A claim-authenticated command that must NOT record, and how to drive it.
 *
 * `driveSuccess` is REQUIRED here for the same reason it is on RecordingCase, and
 * it matters more: a refused command records nothing and would pass the
 * non-recording assertion VACUOUSLY, leaving the guard green while pinning
 * nothing. Each driver asserts its own exit code is 0 first.
 */
interface NonRecordingCase {
  /** Why this command fails the workflow-state predicate. Surfaced on failure. */
  readonly reason: string;
  /** Drive this command to a SUCCESSFUL (exit 0) invocation with the bearer. */
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
const NON_RECORDING_CLAIM_COMMANDS: Readonly<Record<string, NonRecordingCase>> = {
  status: {
    reason:
      'Changes nothing (read-only). A stuck child polling its own status must never refresh its own mark.',
    driveSuccess: async (id) => driveClaimStatus(id),
  },
  stash: {
    reason:
      'Changes session targeting only, not the run. IS a claim-authenticated mutation (stash.ts:19) — which is exactly why the predicate is "changes runbook workflow state", not "mutates". Recording it would let a child loop stash/pop to fake liveness without advancing anything.',
    driveSuccess: async (id) => driveClaimStash(id),
  },
  pop: {
    reason:
      'Changes session targeting only, not the run. IS a claim-authenticated mutation (pop.ts:59); see stash. Corroboration: unstashForClaimId already moves updatedAt ("record written"), the field this design deliberately leaves alone.',
    driveSuccess: async (id) => driveClaimPop(id),
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
    // `Record<RoleSpecificMutationCommand, true>`, NOT `readonly
    // RoleSpecificMutationCommand[]`. An array type accepts ANY subset, so a new
    // union member would keep this green and the literal below would be asserting
    // a file against itself — the same tautology the anchor above exists to avoid,
    // reintroduced in the cross-check. As a Record, a new member is a COMPILE
    // ERROR here (missing property), which is the whole point of the cross-check:
    // it makes the union's growth visible to this file. It stays containment-only
    // at runtime because `abort` proves the two concepts are not the same set.
    const union: Record<RoleSpecificMutationCommand, true> = {
      pass: true,
      fail: true,
      delegate: true,
      goto: true,
      complete: true,
      stop: true,
      collect: true,
    };
    for (const name of Object.keys(union)) {
      expect(name in RECORDING_COMMANDS || name in NON_RECORDING_CLAIM_COMMANDS).toBe(true);
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
    async (name, { reason, driveSuccess }) => {
      const { claimId, claimKey } = await arrangeFor(name);
      await backdateClaimProgress(workspace, claimKey, '2020-01-01T00:00:00.000Z');

      // Drives the command to a SUCCESSFUL invocation (exit 0) — a refusal would
      // record nothing for the wrong reason and pass this test vacuously. The
      // driver comes from the table entry, exactly as on the recording side.
      await driveSuccess(claimId);

      // The mark must not move. `reason` documents WHY at the failure site: a
      // reader who broke this needs the anti-fooling argument, not just a diff.
      //
      // Jest's `expect` takes ONE argument — `expect(actual, reason)` is Vitest
      // syntax and does not compile here. This repo is Jest (see the `@jest/globals`
      // import above), so the reason is carried by wrapping the failure instead.
      const after = (await readSession(workspace)).claims[claimKey].lastProgressAt;
      try {
        expect(after).toBe('2020-01-01T00:00:00.000Z');
      } catch (error) {
        throw new Error(
          `${name} moved lastProgressAt but must not record.\nWhy it must not: ${reason}\n\n${getErrorMessage(error)}`,
        );
      }
    },
  );

  it('abort records ONLY the presented parent claim, never a bystander child (AC5)', async () => {
    // THE SHARPEST AC5 CASE, and the one the it.each above structurally cannot
    // express: `arrangeFor` returns a single { claimId, claimKey }, so it has no
    // slot for "and this OTHER claim must not have moved". Every other recording
    // command presents a bearer for the run it mutates; `abort` is the only one
    // where the presented bearer (the parent's) controls a DIFFERENT run from the
    // claims it affects. An implementation that looped over the session's claims —
    // or that recorded `target.claimId` alongside `callerEvidence.claimId` — would
    // pass every generic case in this file, because the parent's mark moves and
    // that is all those cases check.
    //
    // WHY A BYSTANDER, AND NOT THE ABORTED CHILD. The obvious test — "abort child A,
    // assert A's mark did not move" — CANNOT BE WRITTEN, and an earlier draft of this
    // plan shipped it broken in both directions. Verified against source:
    //
    //   1. Aborting a CLAIMED delegation returns `needs_force` and throws
    //      `Errors.delegationAlreadyClaimed` (abort.ts:192-193) -> non-zero exit.
    //      The draft asserted `exitCode === 0` with no `--force`: red on arrival.
    //   2. Add `--force` and the assertion dies instead. The force path calls
    //      `cleanupForceAbortedLinkedChild` (abort.ts:210), which calls
    //      `sessionService.releaseRunbook(childRunId)` (lifecycle-command-service.ts:1253,
    //      :1262) WITHOUT `retainClaimsAsTerminal` — and that DELETES the claim record
    //      (session-service.ts:914-916 `delete session.claims[claimKey]`). So the
    //      aborted child's record is always gone, the draft's `if (child !== undefined)`
    //      guard always skipped, and the "sharpest case" silently degraded into the
    //      parent-only check every generic case already makes. That is exactly the
    //      vacuous-pass this file polices elsewhere.
    //
    // The aborted child's mark is therefore UNOBSERVABLE after the command: deleted
    // is deleted, whether or not it was recorded first. A bystander child is the
    // observable form of the same invariant — it has a live claim record throughout,
    // it is not the abort's target, and no correct implementation has any reason to
    // touch it. A loop-over-all-claims implementation moves it and fails here.
    const { parentClaimId, parentClaimKey, abortedChildClaimKey, bystanderChildClaimKey, token } =
      await arrangeAbortableTrio();
    await backdateClaimProgress(workspace, parentClaimKey, '2020-01-01T00:00:00.000Z');
    await backdateClaimProgress(workspace, bystanderChildClaimKey, '2020-01-01T00:00:00.000Z');

    // `--force` is REQUIRED: the delegation is claimed, so the bare form throws
    // `needs_force` (abort.ts:192). This is not belt-and-braces.
    expect(
      (await runCliInProcess(['abort', token, '--force', '--claim-id', parentClaimId], workspace))
        .exitCode,
    ).toBe(0);

    const session = await readSession(workspace);
    // The parent presented its bearer and advanced the run: its mark moves.
    expect(Date.parse(session.claims[parentClaimKey].lastProgressAt)).toBeGreaterThan(
      Date.parse('2020-01-01T00:00:00.000Z'),
    );
    // The bystander was never presented and is not the target: its mark is frozen.
    // UNCONDITIONAL — no `if (… !== undefined)` guard. If this record has vanished,
    // that is itself a failure worth surfacing, not a reason to skip the assertion.
    expect(session.claims[bystanderChildClaimKey].lastProgressAt).toBe(
      '2020-01-01T00:00:00.000Z',
    );
    // Pins the force-cleanup behaviour the reasoning above depends on. If a future
    // change makes force-abort RETAIN the child's claim as a terminal tombstone,
    // this fails — and that is the signal to add the direct "aborted child not
    // recorded" assertion, which would become observable at that point.
    expect(session.claims[abortedChildClaimKey]).toBeUndefined();
  });

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
    const updatedAtBefore = (await readSession(workspace)).claims[claimKey].updatedAt;

    for (let i = 0; i < 3; i++) {
      expect((await runCliInProcess(['stash', '--claim-id', claimId], workspace)).exitCode).toBe(0);
      expect((await runCliInProcess(['pop', '--claim-id', claimId], workspace)).exitCode).toBe(0);
    }

    const claim = (await readSession(workspace)).claims[claimKey];
    expect(claim.lastProgressAt).toBe('2020-01-01T00:00:00.000Z');
    // Still idle after six successful claim-authenticated mutations: the signal
    // cannot be faked by a holder that never advances the run.
    expect(claimActivity(claim, new Date(), DEFAULT_IDLE_AFTER_MS).idle).toBe(true);

    // THE EMPIRICAL PROOF THAT ONE FIELD COULD NOT HAVE DONE THIS JOB.
    // `unstashForClaimId` moves `updatedAt` on every pop (session-service.ts:1060),
    // so after this loop `updatedAt` HAS moved while `lastProgressAt` has not. Had
    // the design reused `updatedAt` — the "obvious" economy this plan rejects — the
    // same six commands would have refreshed the idle clock and this dead claim
    // would read as live. The two fields mean different things, and this assertion
    // is the only place in the suite that demonstrates it against real behaviour
    // rather than asserting it in prose.
    expect(claim.updatedAt).not.toBe(updatedAtBefore);
  });
});
```

> **The `drive*` / `arrangeFor` helpers are the substance of this task, not boilerplate.** There are **eleven** of them, one per classified command — the eight `driveClaim{Pass,Fail,Complete,Stop,Collect,Delegate,Goto,Abort}` plus `driveClaimStatus` / `driveClaimStash` / `driveClaimPop` for the non-recording table. An earlier draft called an undefined `driveNonRecording(name, claimId)` from the non-recording case and gave that table no driver field at all; both tables now carry `driveSuccess`, so the two halves are symmetric and there is no name to invent.
>
> **`driveClaimPop` must stash first — a single `(name, claimId)` shape could not have expressed this.** `pop` cannot exit 0 in isolation: it requires a prior `stash`, so its driver owns that ordering (`stash --claim-id`, assert 0, then `pop --claim-id`, assert 0). This is the concrete reason the non-recording side needs per-command closures rather than one generic dispatcher — the preconditions differ per command, and `:1770`'s rule that every driver assert exit 0 is unsatisfiable for `pop` without them. Both of `driveClaimPop`'s invocations must be asserted: a stash that silently refused would leave `pop` refusing too, and the case would pass vacuously twice over.
>
> **`arrangeAbortableTrio` is not `arrangeFor('abort')`.** The abort AC5 case needs THREE claims and the pending token — `{ parentClaimId, parentClaimKey, abortedChildClaimKey, bystanderChildClaimKey, token }`. `arrangeFor`'s single-claim return cannot carry that. Two children, not one: the aborted child's record is **deleted** by force-cleanup (see the test's own comment for the source trace), so the bystander is the only claim that survives the command and can carry the "did not move" assertion. `setupParentWithChildren` already stands up a multi-child parent — claim both children, abort the first, leave the second untouched. `token` is the aborted child's pending token, read from `status` output.
>
> Each of the eight recording commands needs a workspace arranged so it reaches a _committed success_ with a bearer — `complete`/`stop` need a running claimed run; `collect` needs a parent with a reported child; `delegate` needs an authored DELEGATE step; `abort` needs a pending token. `arrangeStashablePair` needs a claimed child that is stashable and poppable. Build them on the existing integration fixtures rather than inventing new ones; `packages/cli/__tests__/commands/stash-pop.test.ts` already stands up a claimed stash/pop workspace (`:683`) — mirror it.
>
> **`setupParentWithChildren` must be EXTRACTED before it can be reused — it is not importable today.** It is declared at `packages/cli/__tests__/integration/delegate-workflow.test.ts:167`, **nested inside the `describe` at `:109`**, and that file has **zero exports**. Importing from a `.test.ts` would also re-execute its entire suite inside this file. So Step 0 of this task is: lift `setupParentWithChildren` (and `issueRunControlClaim`, if it is likewise local) into `packages/cli/__tests__/helpers/test-utils.ts`, export it, and update `delegate-workflow.test.ts` to import it. Its suite must stay green — run `pnpm --filter @rundown-org/cli exec jest delegate-workflow` before moving on. `runCliInProcess` is already exported from `test-utils.ts` (`:431`); no work needed there.
>
> **`readSession` already exists and must be RETYPED, not re-created.** `test-utils.ts:227` exports it, and its `claims` field is typed `Record<string, Record<string, unknown>>` — so `Date.parse(session.claims[k].lastProgressAt)` is a **compile error** (`unknown` is not assignable to `string`), and `claimActivity(session.claims[k], …)` is too (`Record<string, unknown>` is not a `ClaimRecord`). Every snippet in Tasks 5, 6 and 7 depends on this being fixed. Retype the field to `Record<string, ClaimRecord>` and add `import type { ClaimRecord } from '@rundown-org/core';` (the file already imports types from core at `:32`). This is safe — verified: the only callers that dereference `.claims[…]` are `prune.test.ts:588`, `:595`, and `:732`, and all three only assert `toBeDefined()` / `toBeUndefined()`, which compile unchanged against the narrower type. Do **not** "factor `readSession` into `test-utils.ts`" as an earlier draft instructed: it is already there, and a second definition would collide with the export.
>
> **`backdateClaimProgress` takes a `ClaimLookupKey`, never a bearer.** This is new; write it in `test-utils.ts` beside `readSession`: read `.rundown/session.json`, set `claims[claimKey].lastProgressAt`, write it back. Signature: `backdateClaimProgress(workspace: TestWorkspace, claimKey: ClaimLookupKey, iso: string): Promise<void>`. **It must throw if the key is absent** — a helper that silently no-ops on a key it cannot find makes every idle assertion in Tasks 5/6/7 vacuously green, which is the single highest-leverage way this whole feature's test suite could lie. An earlier draft called it with a **claimKey** in Task 5 and with the **bearer** returned by `claimChild` in Tasks 6/7 — two incompatible signatures for one shared helper, so one family of call sites was always going to backdate nothing. Tasks 6/7 convert at the call site with `claimKeyFromBearer(bearer)`, exported from core (`claim-id.ts:282`).
>
> `getErrorMessage` (never `Error.isError` directly, per CLAUDE.md Testing Conventions) is imported from `@rundown-org/core` in the block above; it renders the wrapped assertion failure in the non-recording case.
>
> **Every `drive*` helper must assert its own exit code is 0**, on BOTH the recording and non-recording paths. On the recording path, a command that silently starts refusing would record nothing and the guard would report a _recording_ failure, sending the reader hunting in the wrong place. On the non-recording path it matters more: a refused `stash` records nothing and would pass the assertion **vacuously**, so the guard would keep reporting green while pinning nothing at all. Assert success first, then the timestamp.
>
> `claimActivity` / `DEFAULT_IDLE_AFTER_MS` are already in the import block above — used by the stash/pop anti-fooling loop.

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
5. **The cross-check, exhaustiveness direction:** temporarily add a member to `RoleSpecificMutationCommand` in `packages/core/src/runbook/subprocess-mutation-boundary.ts:33` (e.g. `| 'probe-member'`) and run `pnpm run check:types`. Expected: a COMPILE error in this file — `Property 'probe-member' is missing in type ... but required in type 'Record<RoleSpecificMutationCommand, true>'`. Revert. Without this, the cross-check would be `readonly RoleSpecificMutationCommand[]`, which accepts any subset: a new union member would leave it green, and the literal would only be asserting the file against itself.

If any probe does NOT produce its expected failure, the guard is not pinning what it claims. **Fix the guard before proceeding** — this is not a formality: a green suite that cannot go red is worse than no suite, because it is trusted, and this guard is the sole justification for letting `goto`/`abort` record from the CLI.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts \
  packages/cli/__tests__/helpers/test-utils.ts
git commit -m "test(cli): pin the claim-progress recording set with a fail-closed drift guard (#519)"
```

---

## Task 5b: Ship plan 2 (verify gate + PR)

**Files:** none — this task runs gates and opens the PR.

**Interfaces:**

- Consumes: everything Tasks 4–5 landed.
- Produces: a merged plan-2 PR. **Plan 3 cannot start until this merges** — it consumes the fixtures Task 5 Step 0 extracted (`setupParentWithChildren`, the retyped `readSession`, `backdateClaimProgress`), and its surface tests are meaningless until recording actually happens.

- [ ] **Step 1: Run the pre-PR verification gate**

Run: `pnpm run verify`

Expected: PASS (format, spell, lint, build, typecheck, tests across all packages). **Mandatory before every push** per CLAUDE.md — this plan is its own PR and needs its own gate.

- [ ] **Step 2: Run the drift guard LAST, on the finished tree**

Run: `pnpm --filter @rundown-org/cli exec jest claim-progress-drift-guard.test.ts`

Expected: PASS — all eight recording cases, all three non-recording cases, the stash/pop anti-fooling loop, the `RoleSpecificMutationCommand` containment cross-check, and the classification set-equality against the real `createProgram()`.

Run it after everything else has landed: it is the one test that fails if any of the eight commands lost its recording call site during the intervening work, which is exactly the drift it exists to catch.

- [ ] **Step 3: Confirm the guard was proven to bite, not merely observed green**

Task 5 Step 3's five revert-after probes are **not** a formality, and a green guard is not evidence they were run. Before opening the PR, confirm you actually watched each probe fail and reverted it. If you skipped them, go back: a guard that cannot go red is worse than no guard, because it is trusted — and this one is the **sole** justification for letting `goto` and `abort` record from the CLI (spec `:103`: "the guard, not the seam's uniformity, is the guarantee").

State in the PR body that the probes were run. That sentence is what a reviewer has to take on trust, so it should be a claim someone made deliberately.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin claim-progress-recording
gh pr create --title "feat: record claim progress on every workflow-state mutation, pinned by a fail-closed drift guard (#519)" --body "$(cat <<'BODY'
Plan 2 of 3 for #519 (see docs/superpowers/plans/2026-07-17-claim-progress-2-recording.md). Builds on plan 1, which shipped `recordClaimProgress` as a tested but uncalled API.

- Wires recording into the **eight** claim-authenticated commands that change runbook workflow state: `pass`, `fail`, `complete`, `stop`, `collect`, `delegate`, `goto`, `abort`. Always last, always best-effort: verify bearer -> authorize grant -> commit mutation -> record. A failed record never fails or masks the committed mutation.
- Does **not** wire `stash`/`pop` (they change session *targeting*, not the run) or `status` (read-only). These are not carve-outs — they fail the predicate. Recording them would let a child fake liveness without advancing anything, which is the defect that disqualified the rejected verify-path design.
- Adds a **fail-closed drift guard** classifying all eleven `--claim-id` commands and pinning the set in **both** directions. Its scan comes from the real `createProgram()`, never from the guard's own tables — a guard fed by its own classification shrinks on both sides at once and can never fail. Proven to bite via five revert-after probes, including a new `--claim-id` command surfacing as unclassified.

A command refreshes **only** the claim whose bearer it presented — never `target.claimId`, never a child's. A parent cannot vouch for a child's liveness and must not appear to.

Nothing reports idle yet — that is plan 3.

AC3, AC4, AC5, AC11.
BODY
)"
```

---

## Self-Review

**Spec coverage.** AC3, AC4, AC11 (Tasks 4–5); AC5 (Task 4's call sites + Task 5's abort bystander case). AC7 was discharged by plan 1 at the API level and is re-pinned here at each seam. One wrinkle worth knowing: an AC5 assertion also lands in **plan 3** Task 7 Step 1 (collect reports the children's activity while refreshing only the orchestrator's claim) — plan 3 does not claim AC5, which is correct (this plan discharges it), but do not read plan 3's silence as that test being optional.

**Placeholder scan.** No `TBD` / `TODO`. Every `drive*` helper is named and its preconditions stated; `driveClaimPop` must stash first, which is exactly why the non-recording table needs per-command closures rather than one `(name, claimId)` dispatcher. Every fixture pointer resolves or is explicit extraction work (Step 0).

**Type consistency.** Consumes plan 1's `recordClaimProgress` / `ClaimProgressRecordResult` / `claimActivity` / `DEFAULT_IDLE_AFTER_MS` under exactly those names. Produces no production types. The recording call sites gate on each seam's own committed-success union members — `applied` (`runTransition`), `applied_claim`/`applied_bare` (`runTerminal`), `delegated`/`retried` (`issueDelegation`), `collection_applied` (collect) — never on the no-op members (`already_terminal`, `terminal_claim_confirmed`, `already-delegated` — hyphenated, verified — `already_collected`).

## Findings retained from review — do not re-derive, do not reintroduce

**The retraction that matters most in this plan.** A reviewer claim — *"claim tombstones survive every terminal path"* — was carried for four rounds and is **FALSE**. `releaseRunbook` **deletes** a run's claim records unless the caller passes `retainClaimsAsTerminal` (`session-service.ts:907-917`), and the force-abort cleanup path does **not** pass it (`lifecycle-command-service.ts:1253`, `:1262`). It survived because it was plausible and nobody re-derived it. Two consequences live in this plan: (a) the terminal paths that *do* retain make the "no exceptions" rule safe — **a recording command always finds its own claim** — which is the actual justification for not special-casing `complete`/`stop`/`abort` away; and (b) it is why Task 5's abort AC5 test is built around a **bystander** child: the aborted child's record is deleted either way, so "its mark did not move" is unobservable. An earlier draft asserted `exitCode === 0` without `--force` (red on arrival) and guarded the child assertion with `if (child !== undefined)` (always skipped, silently vacuous).

**`backdateClaimProgress` must THROW on a missing key, never no-op.** An earlier draft called it with a `claimKey` in this plan and with a **bearer** in plan 3 — two incompatible signatures for one shared helper — so one family of call sites was always going to backdate nothing. With a silent no-op, **every** idle assertion across three tasks goes vacuously green and no test says so. That is the single highest-leverage way this feature's suite could lie. One signature (`ClaimLookupKey`); plan 3 converts with `claimKeyFromBearer`.

**The guard's anchor is not negotiable.** The scan's left-hand side comes from the real `createProgram()`. An earlier draft built the test's program by registering the very tables it then compared against — both sides shrink together, a new `rundown foo --claim-id` is never registered and never classified, and the suite stays green while the hole opens. `RoleSpecificMutationCommand` is a **subprocess-trust** concept, not the definition of "claim-authenticated workflow mutation" (`abort` records and is outside it) — it appears only as a containment cross-check.

**Editing these plans? The signature failure mode is a repair that cannot execute.** Five review rounds on the single-plan draft found the same shape repeatedly: a fix that was sound in reasoning and broken in mechanics — a drift guard whose scan was fed by its own tables, a `expect(actual, reason)` that is Vitest syntax under Jest, a mutation gate whose flags never reached Stryker, a pointer to a helper that did not exist. Each looked right and could not run. **A repair that cannot execute is worth less than the defect it replaces, because it also spends the reader's trust.** If you change a command, a probe, or a fixture pointer here, run it.
