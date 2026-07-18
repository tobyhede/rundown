# Claim Progress: Surfaces — Report Idle on status and collect (#519, plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the recorded progress visible — join `claimActivity` onto claimed delegations on `rundown status` and onto unresolved children on `rundown collect`, derive it **per child** so one corrupt record cannot erase the rest, document both output schemas, and verify the whole of #519 end to end.

**Architecture:** Read-only and derived at read. Nothing is persisted, no machine state is added, no events fire. Both surfaces join the pure `claimActivity` (plan 1) onto data they **already** load — `status` already reads `session.claims` for the #531 `claimKey` join; `collect` already has `listOpenClaimsForParent` on `CommandTargetReader`, which returns exactly the unresolved delegated children. No new read model is needed on either side.

**The one thing this plan must not get wrong.** The `known` | `unreadable` union has to reach the **JSON**, unflattened, on both surfaces. Containment that stops at the type boundary is not containment: **JSON is the agent-facing contract and the agent has no compiler.** Flattened into independent optionals, `idle === undefined` means three different things (not claimed / no claim record / corrupt record), and `delegations.filter((d) => d.idle)` — the obvious thing an agent writes — silently skips the corrupt child, the one most worth checking. That is the same fail-open AC6 rejects, arriving through the wire format instead of a `NaN` comparison. An earlier draft did exactly this on `status` while getting `collect` right; both now carry `z.discriminatedUnion('kind', …)`.

**This plan is 3 of 3. Task numbers are retained from the original single plan (Tasks 1–3 in plan 1, 4–5 in plan 2, 6–8 here)** so every cross-reference across all three documents stays valid. Do not renumber them.

- Plan 1: `docs/superpowers/plans/2026-07-17-claim-progress-1-foundation.md` — AC1, AC2, AC6, AC7, AC8, AC13 — **must be merged first**
- Plan 2: `docs/superpowers/plans/2026-07-17-claim-progress-2-recording.md` — AC3, AC4, AC5, AC11 — **must be merged first**
- Plan 3 (this): `docs/superpowers/plans/2026-07-17-claim-progress-3-surfaces.md` — AC9, AC10, AC12, AC14

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

**Tech Stack:** TypeScript, Zod (output schemas), Jest (CLI JSON-first then `--text`), Stryker (scoped mutation), pnpm workspaces. Packages: `@rundown-org/core` (the `ChildActivity` union, the wire schemas, collect's read model), `@rundown-org/cli` (status/collect rendering, the duration humaniser).


## What plans 1 and 2 must have landed first

This plan does not compile or pass without them. If any is missing, stop and finish the earlier plan.

- **From plan 1:** `claimActivity`, `ClaimActivity`, `DEFAULT_IDLE_AFTER_MS`, `isClaimProgressUnreadable()` (from `claim-activity.ts`), plus `DurationMs` and `assertDurationMs()` (from plan 1's separate `duration.ts` module) — all reachable from `@rundown-org/core`'s barrel. Task 6 **adds** `ChildActivity` to `claim-activity.ts`; plan 1 deliberately left it out because nothing narrowed it until now.
- **From plan 1:** `ClaimRecord.lastProgressAt`, required. Both surfaces read it.
- **From plan 2, and this is the one people miss:** the shared test fixtures from **Task 5 Step 0** — `setupParentWithChildren` exported from `test-utils.ts` (it is nested inside a `describe` in a zero-export `.test.ts` otherwise, and gains an explicit `workspace: TestWorkspace` first parameter in the process, having nothing to close over once extracted), `claimChild(workspace, token)` (wrapping the `claim` + `findActionOutput` pair that `delegate-workflow.test.ts:236-240` open-codes, returning the bearer `claim_id`), `readSession` **retyped** so `claims` is `Record<string, ClaimRecord>` rather than `Record<string, unknown>`, and `backdateClaimProgress`. Without the retype, every test snippet in Tasks 6 and 7 is a compile error (`Date.parse(unknown)` is TS2345). Without the extraction, the imports do not resolve.
- **From plan 2:** recording actually happens at the eight call sites — otherwise a "not idle after a mutation" assertion here would pass or fail for reasons that have nothing to do with these surfaces.

Verify before starting: `pnpm --filter @rundown-org/cli exec jest claim-progress-drift-guard` — expected PASS.

## Acceptance Criteria owned by this plan

Verbatim from `docs/superpowers/specs/2026-07-16-claim-progress-idle-detection-design.md`.

- **AC9** — `rundown status` and `rundown collect` surface `lastProgressAt`, `idleFor` (milliseconds in JSON), and `idle` for claimed/unresolved delegations, in JSON by default and `--text` when asked. *(Task 6 status, Task 7 collect)*
- **AC10** — `docs/spec/cli-output.md` documents both output schemas, including that `unresolvedChildren.length` may be less than `unresolved`. *(Task 8)*
- **AC12** — No machine state, event, expiry, reclaim, or synthesized result is introduced. *(Task 8 Step 3 — a whole-change audit across all three plans, which is why it lands here, last.)*
- **AC14** — A corrupt claim record is contained per child: it is reported as `unreadable`, its healthy siblings still report their activity, and no read boundary catches around a whole list or drops the child. A read-only command never surfaces it as an unhandled error. *(Task 6 status, Task 7 collect)*

**AC13 — partially owned here, and easy to drop.** Plan 1 cleared it for `claim-activity.ts`. This plan owns two further obligations against it: (a) Task 6 **modifies** that module (adding `ChildActivity`), so Task 8 Step 6 **re-runs** the scoped gate — a module clean in plan 1 is not automatically clean once this plan touches it; and (b) `humaniseDurationMs` is a new pure function created here and is held to the **same** standard by Task 6 Steps 4b/4c (branch tests + its own scoped `test:mutate:cli` run). The spec's AC13 wording names only `claim-activity.ts`, so (b) is not literally required by it — but exempting the function next to it, purely because it is small, is the reasoning this plan rejected in review. Small is why the tests are cheap, not why they are unnecessary.

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
- **Branch: cut `claim-progress-surfaces` fresh from an updated `main`** — do NOT reuse `claim-progress-idle-detection` or `claim-progress-recording`. Both carry merged PRs; continuing on either would re-propose their changes here or conflict. The original single-plan draft said "Branch is `claim-progress-idle-detection`. Do not switch or create branches" because it was one PR; three sequential PRs need three branches. Start with:

  ```bash
  git checkout main && git pull            # plans 1 AND 2 must already be merged
  git checkout -b claim-progress-surfaces
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

- `packages/cli/src/helpers/duration.ts` — `humaniseDurationMs(value: DurationMs): string` for `--text`. Milliseconds stay the JSON contract; only the human format humanises.
- `packages/cli/__tests__/helpers/duration.test.ts` — branch + boundary coverage for the above (`59_999`/`60_000`, `3_599_999`/`3_600_000`, the `minutes === 0` arm). **Static import** (Stryker), same reasoning as AC13.
- `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts` — CLI coverage for both surfaces: JSON first per CLAUDE.md Testing Conventions, `--text` separately.

**Modified:**

- `packages/core/src/runbook/claim-activity.ts` — add the `ChildActivity` read-boundary union (`known` | `unreadable`) beside `ClaimActivity`. **This** is the union that earns its keep: its members carry different data, so every consumer must narrow — unlike `ClaimActivity`, whose two-variant draft was a boolean in costume.
- `packages/core/src/output/zod-schemas.ts:390-433` — `DelegationActivitySchema` (a `z.discriminatedUnion`, both members `.strict()`) + the optional `activity` field on `DelegationStatusEntrySchema` + the claimed-only refine.
- `packages/core/src/runbook/command-policy.ts` — `UnresolvedChildActivity` (the collect union) and its plumbing onto the collect outcomes.
- `packages/cli/src/schemas/output-schemas.ts` — `UnresolvedChildActivitySchema` + `unresolvedChildren` on the collect response schemas (Task 7 Step 6).
- `packages/core/src/runbook/collection-service.ts` — derive per child, contained per child.
- `packages/cli/src/helpers/status-builder.ts:46-90`, `:275-283`, `:356-386` — the entry shape, `ActiveStatusOptions.activityByChildRunId`, and the delegations map. Build the activity map in the **same pass** as the existing `claimKeyByChildRunId` sort, or a `controlledRunId` collision can pair one claim's key with another claim's activity.
- `packages/cli/src/services/renderers/text-renderer.ts:62-71` **and** `:296-314` — the renderer carries its **own** structural duplicate of the delegation entry shape at `:62-71`, independent of `status-builder.ts`, so the fields must be added in both or `--text` cannot see them. It is a **line** format, not a table: append to the line; "add a column with UPPERCASE headers" does not apply.
- `packages/cli/src/commands/status.ts:43-52` — extend the existing #531 claim join.
- `packages/cli/src/commands/collect.ts` — carry `unresolvedChildren` onto the JSON and `--text` output.
- `packages/core/__tests__/runbook/delegation-schemas.test.ts` — the schema tests pinning `.strict()` and the claimed-only refine (Task 6 Step 8b). Nothing tested these schemas before this plan.
- `packages/core/__tests__/runbook/collection-service.test.ts` — extend the suite's hand-built double so it can express open claims and observe `recordClaimProgress` (Task 7 Step 1).
- `packages/cli/__tests__/helpers/status-builder.test.ts` — extend.
- `docs/spec/cli-output.md` — the `status` activity fields and a full `## collect` section (Task 8).

---

## Task 6: `rundown status` surfaces `lastProgressAt` / `idleFor` / `idle` (AC9 status)

**Files:**

- Create: `packages/cli/src/helpers/duration.ts`
- Modify: `packages/core/src/runbook/claim-activity.ts` (add the `ChildActivity` read-boundary union beside `ClaimActivity`)
- Modify: `packages/core/src/output/zod-schemas.ts:390-433` (`DelegationStatusEntrySchema` + `DelegationActivitySchema`)
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
     *
     * The `known` member spreads `ClaimActivity` inline rather than nesting it
     * under an `activity` property, so this type IS the wire shape
     * `DelegationActivitySchema` validates (Step 3) and the builder can emit it
     * unmapped. It mirrors `UnresolvedChildActivity` (Task 7) member for member —
     * the two read boundaries expose one shape, not two dialects of it.
     */
    export type ChildActivity =
      | ({ readonly kind: 'known' } & ClaimActivity)
      | { readonly kind: 'unreadable' };
    ```

  - `ActiveStatusOptions.activityByChildRunId?: ReadonlyMap<string, ChildActivity>`.
  - `DelegationStatusEntrySchema` gains a single optional `activity` field carrying the union **on the wire** as a `z.discriminatedUnion('kind', …)` — present only when `state === 'claimed'` and the claim record was found.

**The union survives to the wire — the flattened draft is the original defect relocated.** An earlier draft kept `ChildActivity` a union in core and then flattened it into four independent optionals in the JSON (`lastProgressAt?`, `idleFor?`, `idle?`, `activityUnreadable?`), holding them together with refines. That reintroduces exactly the defect this design rejects, at the boundary that matters most:

- `idle === undefined` would mean **three different things** — not claimed, claimed but no claim record, or claimed with a corrupt record — and nothing in the JSON tells them apart.
- `delegations.filter((d) => d.idle)` — the obvious thing an agent writes — silently skips the corrupt child, which is the one most worth checking. That is the fail-open AC6 exists to reject, arriving through the wire format instead of a `NaN` comparison.
- The "the compiler forces narrowing" defence does not hold here. **The consumer is an agent reading JSON**; it has no compiler. And the loudness the draft pointed at (`IDLE?  (unreadable progress timestamp)`) exists only in `--text` — the human format — and is absent from the agent-facing contract, which CLAUDE.md names as *the* contract.

`collect` already got this right end-to-end (union in core, `z.discriminatedUnion` on the wire, Task 7). `status` uses the same shape, for the same reason. Both boundaries now read identically: narrow on `kind`, or you cannot read `idle` at all.

- [ ] **Step 1: Write the failing CLI JSON test**

Create `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts`. JSON first per CLAUDE.md Testing Conventions.

`setupParentWithChildren`, `claimChild`, and `backdateClaimProgress` come from `test-utils.ts` — **Task 5 Step 0 extracts the first and writes the other two**, so if you are executing tasks out of order, do that step before this one. Do **not** import them from `delegate-workflow.test.ts`: `setupParentWithChildren` is nested inside that file's `describe` and the file has zero exports, so the import cannot resolve, and importing from a `.test.ts` would re-execute its whole suite inside this one.

Two consequences of that extraction, both easy to miss:

- **`setupParentWithChildren` takes `workspace` as its first parameter once extracted.** Inside `delegate-workflow.test.ts` it closes over the suite's `workspace`; a `test-utils.ts` export has nothing to close over.
- **`claimChild(workspace, token)` takes a TOKEN, not a substep id.** Tokens are what `setupParentWithChildren` returns (`token1` / `token2`, read off the `run` event frontier); nothing maps a substep id like `'1.1'` to a claim without re-reading that frontier. It wraps the two-line `claim` + `findActionOutput` dance that `delegate-workflow.test.ts:236-240` open-codes, and returns the bearer `claim_id`.

```typescript
import { claimKeyFromBearer } from '@rundown-org/core';
import { validateStatusOutput } from '../helpers/schema-validator.js';
import {
  backdateClaimProgress,
  claimChild,
  createTestWorkspace,
  readSession,
  runCliInProcess,
  setupParentWithChildren,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * The wire shape of `delegations[].activity` — a discriminated union, mirroring
 * `DelegationActivitySchema`. Declared locally so these tests read the JSON the
 * way an agent would: narrow on `kind`, or you cannot reach `idle` at all.
 */
type WireActivity =
  | { kind: 'known'; lastProgressAt: string; idleFor: number; idle: boolean }
  | { kind: 'unreadable' };

// FILE SCOPE, deliberately: Task 7 appends a second `describe` to this file and
// needs the same binding. A `workspace` declared inside the describe below would
// not be visible there, and re-declaring it per suite would be two temp dirs and
// two cleanup paths for one fixture.
let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await createTestWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

describe('rundown status claim activity (#519)', () => {
  it('surfaces lastProgressAt, idleFor and idle on a claimed delegation (JSON)', async () => {
    const { parentRunId, token1 } = await setupParentWithChildren(workspace);
    const childClaim = await claimChild(workspace, token1);

    const status = await runCliInProcess('status', workspace);
    expect(status.exitCode).toBe(0);

    const output = JSON.parse(status.stdout) as {
      delegations: Array<{
        substep: string;
        state: string;
        claimKey: string;
        activity?: WireActivity;
      }>;
    };
    const entry = output.delegations.find((d) => d.substep === '1.1');
    expect(entry).toBeDefined();
    expect(entry!.state).toBe('claimed');
    // The union reaches the JSON: an agent must narrow on `kind` to read `idle`,
    // exactly as `collect` requires. There is no flat `entry.idle` to reach for.
    expect(entry!.activity?.kind).toBe('known');
    if (entry!.activity?.kind !== 'known') throw new Error('expected known activity');
    // A freshly claimed child has just made progress: idleFor is small and the
    // claim is not idle. `idleFor` is MILLISECONDS in JSON (the DurationMs wire unit).
    expect(typeof entry!.activity.lastProgressAt).toBe('string');
    expect(entry!.activity.idleFor).toBeGreaterThanOrEqual(0);
    expect(entry!.activity.idleFor).toBeLessThan(60 * 60 * 1000);
    expect(entry!.activity.idle).toBe(false);

    // The whole payload still validates against the PUBLISHED status schema.
    // Without this, `status.ts` could emit an `activity` shape that
    // `StatusResponseSchema` rejects and every assertion above would still pass —
    // green here, broken for any agent that validates the envelope. Mirrors the
    // #531 claim-join test at status.test.ts:858-860.
    const validation = validateStatusOutput(output);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    void childClaim;
    void parentRunId;
  });

  it('reports idle:true once lastProgressAt is older than the one-hour threshold (JSON)', async () => {
    const { token1 } = await setupParentWithChildren(workspace);
    const childClaim = await claimChild(workspace, token1);
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim), '2020-01-01T00:00:00.000Z');

    const status = await runCliInProcess('status', workspace);

    const output = JSON.parse(status.stdout) as {
      delegations: Array<{ substep: string; activity?: WireActivity }>;
    };
    const entry = output.delegations.find((d) => d.substep === '1.1');
    if (entry!.activity?.kind !== 'known') throw new Error('expected known activity');
    expect(entry!.activity.idle).toBe(true);
    expect(entry!.activity.idleFor).toBeGreaterThan(60 * 60 * 1000);
  });

  it('omits activity entirely on a pending (unclaimed) delegation (JSON)', async () => {
    // Activity is a property of a CLAIM. A pending delegation has no claim record,
    // so there is nothing to report — and the schema forbids reporting one.
    // ABSENT is a distinct state from `unreadable`: nothing to assess vs. cannot be
    // assessed. Flattened into optionals these would be indistinguishable, which is
    // the reason the union reaches the wire.
    await setupParentWithChildren(workspace);

    const status = await runCliInProcess('status', workspace);

    const output = JSON.parse(status.stdout) as {
      delegations: Array<{ substep: string; state: string; activity?: WireActivity }>;
    };
    const pending = output.delegations.find((d) => d.state === 'pending');
    expect(pending).toBeDefined();
    expect(pending!.activity).toBeUndefined();
  });

  it('keeps other children visible when one claim has a corrupt lastProgressAt (JSON, AC6)', async () => {
    // The fail-open this design must not have. `z.string().min(1)` admits
    // 'not-a-date' and Task 1's guard only checks key PRESENCE, so this state is
    // reachable on disk. A boundary that caught around the whole join and returned
    // nothing would erase the healthy child too, and status would imply all is
    // well — strictly worse than the NaN comparison AC6 rejects.
    const { token1, token2 } = await setupParentWithChildren(workspace);
    const corruptChild = await claimChild(workspace, token1);
    const healthyChild = await claimChild(workspace, token2);
    await backdateClaimProgress(workspace, claimKeyFromBearer(corruptChild), 'not-a-date');
    await backdateClaimProgress(workspace, claimKeyFromBearer(healthyChild), '2020-01-01T00:00:00.000Z');

    const status = await runCliInProcess('status', workspace);

    // A read-only command must not die on corrupt advisory data...
    expect(status.exitCode).toBe(0);
    const output = JSON.parse(status.stdout) as {
      delegations: Array<{ substep: string; activity?: WireActivity }>;
    };

    // ...the corrupt child is reported as unreadable, never as a guessed value...
    const corrupt = output.delegations.find((d) => d.substep === '1.1');
    expect(corrupt!.activity).toEqual({ kind: 'unreadable' });

    // ...and its sibling is still fully visible and still reads idle.
    const healthy = output.delegations.find((d) => d.substep === '1.2');
    if (healthy!.activity?.kind !== 'known') throw new Error('expected known activity');
    expect(healthy!.activity.idle).toBe(true);
    expect(healthy!.activity.idleFor).toBeGreaterThan(60 * 60 * 1000);
  });

  it('a naive agent-style filter cannot skip the corrupt child (JSON, AC6)', async () => {
    // The decisive wire-format case. Flattened into optionals, `idle === undefined`
    // would mean three different things and `filter((d) => d.idle)` — the obvious
    // thing an agent writes — would silently drop the corrupt child, the one most
    // worth checking. With the union, `kind` is present on EVERY reported activity,
    // so the same one-liner over `kind` catches both.
    const { token1, token2 } = await setupParentWithChildren(workspace);
    const corruptChild = await claimChild(workspace, token1);
    const healthyChild = await claimChild(workspace, token2);
    await backdateClaimProgress(workspace, claimKeyFromBearer(corruptChild), 'not-a-date');
    await backdateClaimProgress(workspace, claimKeyFromBearer(healthyChild), '2020-01-01T00:00:00.000Z');

    const status = await runCliInProcess('status', workspace);

    const output = JSON.parse(status.stdout) as {
      delegations: Array<{ substep: string; activity?: WireActivity }>;
    };
    const needsAttention = output.delegations
      .filter((d) => d.activity !== undefined && (d.activity.kind === 'unreadable' || d.activity.idle))
      .map((d) => d.substep)
      .sort();
    expect(needsAttention).toEqual(['1.1', '1.2']);
  });

  it('renders humanised idle time in --text', async () => {
    const { token1 } = await setupParentWithChildren(workspace);
    const childClaim = await claimChild(workspace, token1);
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim), '2020-01-01T00:00:00.000Z');

    const status = await runCliInProcess('status --text', workspace);

    // Assert the string the renderer ACTUALLY emits: the suffix is `IDLE`, upper
    // case (Step 7b). `toContain('idle')` would be the substring-guessing
    // anti-pattern this plan stamps out elsewhere — and it would pass on the word
    // "idle" appearing anywhere at all, including in a field name.
    expect(status.stdout).toContain('IDLE');
    // `--text` is the human format: humanised, never raw milliseconds and never
    // the JSON field name.
    expect(status.stdout).toMatch(/IDLE\s+\(\d+h( \d+m)?\)/);
    expect(status.stdout).not.toContain('idleFor');
  });

  it('renders the unreadable marker in --text', async () => {
    const { token1 } = await setupParentWithChildren(workspace);
    const childClaim = await claimChild(workspace, token1);
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim), 'not-a-date');

    const status = await runCliInProcess('status --text', workspace);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('IDLE?  (unreadable progress timestamp)');
  });
});
```

> **`findDetailOutput` does not exist — do not grep for it, and do not write it.** An earlier draft told you to find "the existing status-detail reader" in `test-utils.ts`. There is none: the only match for `export function find` is `findActionOutput` (`test-utils.ts:658`), which returns `null` unless `'action' in output` — status detail JSON has no `action` field, so it returns `null` and every `detail!` dereference throws. That pointer was a dead end.
>
> **The real precedent is `packages/cli/__tests__/commands/status.test.ts:778-860`**, the #531 claim-join test — the same test whose `delegations` row this task extends. It parses directly and validates against the published schema:
>
> ```typescript
> const output = JSON.parse(result.stdout) as {
>   delegations?: Array<{ substep: string; state: string; claimKey?: string; activity?: WireActivity }>;
> };
> const entry = output.delegations?.find((d) => d.substep === '1.1');
> // …assertions…
> const validation = validateStatusOutput(output);   // schema-validator.ts:173
> expect(validation.errors).toEqual([]);
> expect(validation.valid).toBe(true);
> ```
>
> The tests above already use that shape — `JSON.parse(status.stdout) as { … }`, never a `findDetailOutput` helper. **Call `validateStatusOutput` in at least the first JSON case and the unreadable case** (imported in Step 1's block). It is what proves the new `activity` field is actually in the published `StatusResponseSchema` rather than merely present on the object — without it, `status.ts` could emit a field the schema rejects and every assertion here would still pass, while a real agent validating the envelope would break. `status.test.ts:858-860` already does exactly this for `claimKey`; follow it.
>
> `claimChild` runs `rundown claim <token>` against the pending substep's token from `status` output and returns the **bearer** — hence `claimKeyFromBearer(…)` at the `backdateClaimProgress` call sites (that helper takes a lookup key, never a bearer; see Task 5's note). Import it from `@rundown-org/core` (`claim-id.ts:282`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/cli exec jest claim-idle-surfaces.test.ts -t "rundown status claim activity"`

Expected: FAIL — the `delegations` entries carry no `activity`, so `entry!.activity?.kind` is `undefined` and the narrowing guard throws `expected known activity`.

- [ ] **Step 3: Add the activity fields to `DelegationStatusEntrySchema`**

In `packages/core/src/output/zod-schemas.ts`, define the wire union above `DelegationStatusEntrySchema` — the same shape `collect` uses (Task 7 Step 6), because it is the same problem:

```typescript
/**
 * A claimed delegation's advisory activity, on the wire (#519).
 *
 * A DISCRIMINATED UNION, not a bag of independent optionals. JSON is the
 * agent-facing contract and the agent has no compiler, so the wire format is the
 * only thing that can force the distinction: flattened, `idle === undefined`
 * would mean three different things (not claimed / no claim record / corrupt
 * record), and `delegations.filter((d) => d.idle)` would silently skip the
 * corrupt child — the child most worth checking. That is the same fail-open AC6
 * rejects, reached through the wire format instead of a NaN comparison. Here,
 * `activity` is either absent (nothing to report) or a member you must narrow.
 */
const DelegationActivitySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('known'),
      /** ISO timestamp when the claim's holder last advanced the child run */
      lastProgressAt: z
        .string()
        .describe("ISO timestamp of the claim holder's last recorded progress"),
      /** Milliseconds elapsed since that progress (DurationMs wire unit) */
      idleFor: z
        .number()
        .int()
        .nonnegative()
        .describe('Milliseconds elapsed since the last recorded progress'),
      /** Advisory: no progress recorded for longer than the idle threshold */
      idle: z
        .boolean()
        .describe('Advisory idle label; nothing expires or is reclaimed at this boundary'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unreadable'),
    })
    .strict(),
]);
```

> **`.strict()` on both members is load-bearing — it is what makes the union a union on the wire.** Zod **strips** unknown keys by default, so a plain `z.object({ kind: z.literal('unreadable') })` would parse `{ kind: 'unreadable', idle: true }` **successfully**, silently discarding `idle`. That is the exact fail-open this design rejects: a producer bug that attaches a fabricated idle label to an unreadable record would validate clean, and the schema — the thing an agent trusts to tell it the member carries no label — would have rubber-stamped it. With `.strict()` it is a validation error, which is the only answer that matches the `unreadable` member's meaning. The sibling `DelegationStatusEntrySchema` is already `.strict()` (`zod-schemas.ts:416`); this matches it.

Then add one field inside the entry object (`:390-416`), after `claimKey`:

```typescript
    /** Advisory activity of the claim holding this delegation (#519) */
    activity: DelegationActivitySchema.optional().describe(
      'Advisory claim activity; present only on a claimed delegation with a claim record. Narrow on `kind` — an `unreadable` member carries no idle label rather than a guessed one.',
    ),
```

Add one refine after the existing `claimKey` refines (`:426-433`), keeping the same style:

```typescript
  .refine((entry) => entry.state === 'claimed' || entry.activity === undefined, {
    message: 'claim activity is only available when state is claimed',
    path: ['activity'],
  })
```

> **One refine, not three.** The flattened draft needed a "present together" refine and an "unreadable cannot also report idle" refine to hold four optionals in a coherent shape. The union makes both states unrepresentable, so the refines have nothing left to check — which is the test that the union is carrying its weight rather than being ceremony.
>
> `activity` is optional-when-claimed rather than required-when-claimed (unlike `claimKey`): the join is a read-model lookup, and a claimed delegation whose claim record has been released still renders correctly with no activity at all. That absence is a distinct state from `unreadable`, and the union keeps them distinct.

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

- [ ] **Step 4b: Test the humaniser directly (it has four branches and no coverage)**

Create `packages/cli/__tests__/helpers/duration.test.ts`. **Static import**, same Stryker reasoning as `claim-activity.test.ts` (AC13, #541).

> **Why this step exists.** An earlier draft shipped `humaniseDurationMs` with **zero** direct tests: its `<60s` and `<60m` branches were never executed by anything, since the only `--text` case backdates to 2020 and always lands in the `h`/`h m` branch. The plan holds `claimActivity` to a mutation gate and every branch, then exempted the function next to it — for no reason other than that it is small. Small is why the tests are cheap, not why they are unnecessary.

```typescript
// packages/cli/__tests__/helpers/duration.test.ts

import { describe, expect, it } from '@jest/globals';
import { assertDurationMs } from '@rundown-org/core';
import { humaniseDurationMs } from '../../src/helpers/duration.js';

// Routes through plan 1's real brand seam rather than casting `value as DurationMs`.
// The convention is stated verbatim in `packages/cli/__tests__/helpers/brand-helpers.ts`:
// tests use ergonomic constructors that go through the same seam as production, "so
// the brand contract stays in one place". A local cast helper would also silently
// accept a negative or non-finite input that `assertDurationMs` rejects — i.e. it
// would let this suite feed the humaniser values production cannot produce.
const ms = assertDurationMs;

describe('humaniseDurationMs (#519)', () => {
  it.each([
    [0, '0s'],
    [999, '0s'], // sub-second floors to 0s, never "0.999s"
    [1_000, '1s'],
    [59_999, '59s'], // last instant of the seconds branch
    [60_000, '1m'], // first instant of the minutes branch
    [3_599_999, '59m'], // last instant of the minutes branch
    [3_600_000, '1h'], // exactly one hour: no trailing "0m"
    [3_660_000, '1h 1m'],
    [7_200_000, '2h'], // whole hours stay bare
    [11_520_000, '3h 12m'], // the value the docs example renders
    [86_400_000, '24h'], // no day unit by design — coarse, not clever
  ])('renders %ims as %s', (value, expected) => {
    expect(humaniseDurationMs(ms(value))).toBe(expected);
  });

  it('never renders raw milliseconds or a decimal point', () => {
    // `--text` is the human format; JSON is the contract that carries raw ms.
    for (const value of [1, 1_500, 90_061_000]) {
      expect(humaniseDurationMs(ms(value))).not.toContain('.');
    }
  });
});
```

The boundary rows are the point: `59_999`/`60_000` and `3_599_999`/`3_600_000` kill the `<` -> `<=` mutants on both branch guards, and `3_600_000` -> `'1h'` (not `'1h 0m'`) kills the `minutes === 0` branch removal.

- [ ] **Step 4c: Run the humaniser tests and add the file to the mutation gate**

Run: `pnpm --filter @rundown-org/cli exec jest duration.test.ts`

Expected: PASS.

Then run the CLI mutation gate scoped to it. **Use the `exec` form with PACKAGE-RELATIVE paths:**

```bash
pnpm --filter @rundown-org/cli exec stryker run \
  --mutate src/helpers/duration.ts \
  --testFiles __tests__/helpers/duration.test.ts
```

> **An earlier draft of this step claimed `pnpm run test:mutate:cli -- --mutate <file>` "works here" because `test:mutate:cli` has the trailing `--` that `test:mutate:core` lacks (`package.json:29`). That claim is FALSE — verified by running it:**
>
> ```text
> error: too many arguments for 'run'. Expected 1 argument but got 5.
> ```
>
> The root script is already `pnpm --filter @rundown-org/cli test:mutate --`, so appending your own `--` yields a **doubled** `--` forwarded literally into Stryker's Commander, which then treats every flag as a positional operand. `run` accepts one. The trailing `--` in the script does not rescue the form; it is what breaks it. **CLAUDE.md's Development Commands section already documents this correctly** — it recommends the `exec` form and names this one as a known trap, so there is nothing to fix there.
>
> Paths are **package-relative** for the same reason as core's gate (see the Global Constraint): `pnpm --filter … exec` runs with cwd = `packages/cli`, and `packages/cli/stryker.config.mjs`'s own `mutate` array is `'src/**/*.ts'`. Verified working: `--mutate src/helpers/table-formatter.ts` reports `Instrumented 1 source file(s) with 47 mutant(s)`; the repo-relative form instruments **0** and exits 0.

**Check the `Instrumented 1 source file(s) with N mutant(s)` line before reading any score.** `Instrumented 0` means the globs matched nothing and the gate did not run; `too many arguments for 'run'` means the `--` trap.

Expected: no surviving mutants. If `Math.floor` removal survives, add a fractional-boundary row; if a `<` -> `<=` survives, the paired boundary rows above are missing.

- [ ] **Step 5: Extend the status builder**

In `packages/cli/src/helpers/status-builder.ts`, add to the `delegations` entry type in `StatusOutputData` (`:77-84`), after `claimKey?: string;`:

```typescript
    /**
     * Advisory activity of the claim holding this delegation (#519).
     *
     * The union reaches the JSON intact — see `DelegationActivitySchema`. Not
     * flattened into optionals: the consumer is an agent with no compiler, so the
     * wire shape is the only thing that can stop `filter((d) => d.idle)` from
     * silently skipping the corrupt child.
     */
    activity?: ChildActivity;
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
        // The union passes through UNFLATTENED. There is deliberately nothing to
        // map here: `ChildActivity` is already the wire shape, so no code between
        // the derivation and the JSON can quietly drop `kind` and turn a corrupt
        // child into an absent field.
        ...(activity != null ? { activity } : {}),
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
                ...claimActivity(claim, now, DEFAULT_IDLE_AFTER_MS),
              });
            } catch (error) {
              // ONE predicate, no code literal. `'RD-824'` is re-numberable, and a
              // renumber would silently turn contained corruption back into an
              // unhandled throw out of a read-only command. An invalid `now` is a
              // bare Error and rethrows here BY DESIGN — a broken clock is a code
              // bug, not this child's record being corrupt.
              if (!isClaimProgressUnreadable(error)) throw error;
              activityByChildRunId.set(claim.controlledRunId, { kind: 'unreadable' });
            }
          }
          const statusOptions = { claimKeyByChildRunId, activityByChildRunId };
```

Extend the `@rundown-org/core` import at `:4`:

```typescript
import {
  RunbookStateManager,
  SessionService,
  resolveCommandTarget,
  claimActivity,
  isClaimProgressUnreadable,
  DEFAULT_IDLE_AFTER_MS,
  type ChildActivity,
} from '@rundown-org/core';
```

- [ ] **Step 7: Run the JSON tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli exec jest claim-idle-surfaces.test.ts -t "(JSON)"`

Expected: PASS — the **five JSON cases only**.

> **The two `--text` cases are still RED here, and that is correct.** An earlier draft claimed "PASS (all four, including `--text`)" at this point while no step had touched a renderer — a green asserted for work not yet done, which trains the implementer to disbelieve the plan's expectations. `--text` goes green in Step 7b, the step that actually renders it.

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
    /** Advisory activity of the claim holding this delegation (#519). */
    activity?: ChildActivity;
    token?: string;
  }[];
```

(Import `type ChildActivity` from `@rundown-org/core` here too — this file's shape is a structural duplicate of the builder's, so it must name the same type or the renderer cannot see the field.)

Then extend the line at `:312`. **This is a LINE format, not a table** — `` `  ${d.substep}  ${d.runbook}  DELEGATED  ${stateLabel}` `` — so the CLI Output Standards' "UPPERCASE headers, 2-space columns" guidance does not apply here; there are no headers to add a column to. Append a suffix instead:

```typescript
        // #519: advisory idle suffix. JSON carries raw `idleFor` milliseconds (the
        // agent-facing contract); `--text` is the human format and gets it
        // humanised. An unreadable record says so rather than showing a number it
        // does not have.
        // Narrowing on `kind` is REQUIRED — the `unreadable` member has no
        // `idleFor` to read, so reaching for one does not compile.
        const activitySuffix =
          d.activity?.kind === 'unreadable'
            ? '  IDLE?  (unreadable progress timestamp)'
            : d.activity?.kind === 'known' && d.activity.idle
              ? `  IDLE  (${humaniseDurationMs(d.activity.idleFor)})`
              : '';
        this.writer.writeLine(`  ${d.substep}  ${d.runbook}  DELEGATED  ${stateLabel}${activitySuffix}`);
```

Import `humaniseDurationMs` from `../../helpers/duration.js` (confirm the relative depth from `src/services/renderers/` before writing it). No `as DurationMs` cast is needed: narrowing to the `known` member gives `idleFor` its `DurationMs` brand already, which is the union paying for itself a second time.

- [ ] **Step 7c: Run the `--text` test to verify it now passes**

Run: `pnpm --filter @rundown-org/cli exec jest claim-idle-surfaces.test.ts -t "rundown status claim activity"`

Expected: PASS — all seven now, including both `--text` cases.

- [ ] **Step 8: Add a status-builder unit test for the join and pin `--text` rendering**

Add to `packages/cli/__tests__/helpers/status-builder.test.ts`, mirroring the file's existing `claimKeyByChildRunId` cases (`grep -n "claimKeyByChildRunId" packages/cli/__tests__/helpers/status-builder.test.ts`):

```typescript
  // The `known` member spreads ClaimActivity inline, so it IS the wire shape.
  const knownActivity: ChildActivity = {
    kind: 'known',
    lastProgressAt: '2020-01-01T00:00:00.000Z',
    idleFor: 99_999_999 as DurationMs,
    idle: true,
  };

  it('attaches claim activity to a claimed delegation (#519)', () => {
    const data = buildActiveStatus(stateWithClaimedDelegation, cwd, undefined, undefined, {
      claimKeyByChildRunId: new Map([[childRunId, claimKey]]),
      activityByChildRunId: new Map([[childRunId, knownActivity]]),
    });

    const entry = data.delegations!.find((d) => d.childRunId === childRunId);
    // The union passes through intact — the builder must not flatten it.
    expect(entry!.activity).toEqual(knownActivity);
  });

  it('reports an unreadable claim record without a guessed idle label (#519 AC6)', () => {
    // The corrupt case must be VISIBLE and must not carry a fabricated idle value.
    // Reporting `idle: false` here would be the fail-open AC6 exists to prevent —
    // and the union makes that state unrepresentable rather than merely untested.
    const data = buildActiveStatus(stateWithClaimedDelegation, cwd, undefined, undefined, {
      claimKeyByChildRunId: new Map([[childRunId, claimKey]]),
      activityByChildRunId: new Map([[childRunId, { kind: 'unreadable' }]]),
    });

    const entry = data.delegations!.find((d) => d.childRunId === childRunId);
    expect(entry!.activity).toEqual({ kind: 'unreadable' });
  });

  it('never attaches claim activity to a cancelled-after-claim delegation (#519)', () => {
    // A cancelled delegation retains childRunId; attaching activity would fail the
    // DelegationStatusEntrySchema refine.
    const data = buildActiveStatus(stateWithCancelledDelegation, cwd, undefined, undefined, {
      activityByChildRunId: new Map([[childRunId, knownActivity]]),
    });

    const entry = data.delegations!.find((d) => d.childRunId === childRunId);
    expect(entry!.state).toBe('cancelled');
    expect(entry!.activity).toBeUndefined();
  });
```

> Import `type ChildActivity` and `type DurationMs` from `@rundown-org/core` in this test file. The `--text` rendering is already done in Step 7b. **Do not go looking for a delegations table in `output-emitter.ts` or `table-formatter.ts`** — an earlier draft sent readers there, and both have **zero** delegation-rendering hits. The renderer is `text-renderer.ts:296-314`, it is a **line** format with no headers, and "add an `IDLE` column with UPPERCASE headers" is inapplicable to it.

- [ ] **Step 8b: Pin the schema itself — the union must reject a fabricated label**

The builder tests above prove `buildActiveStatus` *emits* the right shape. They do **not** prove the schema *rejects* the wrong one — and the `unreadable` member's entire value is that it cannot carry an idle label. Without this step nothing pins `.strict()`, and a future edit dropping it would silently restore the fail-open (zod would strip `idle` and validate clean).

Add to `packages/core/__tests__/runbook/delegation-schemas.test.ts`, inside the existing `describe('DelegationStatusEntrySchema')` (`:693`) which already owns 8+ refine cases at `:705-770`:

```typescript
  it('rejects an unreadable activity that also carries an idle label (#519)', () => {
    // THE POINT OF `.strict()`. Zod strips unknown keys by default, so without it
    // this parses SUCCESSFULLY with `idle` silently dropped — the schema
    // rubber-stamping a fabricated label on the one member that must never carry
    // one. `unreadable` means "this claim cannot be assessed"; an idle label on it
    // is a contradiction, and the schema is where that becomes unrepresentable.
    const result = DelegationStatusEntrySchema.safeParse({
      ...validClaimedEntry,
      activity: { kind: 'unreadable', idle: true },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed unreadable activity (#519)', () => {
    // The companion to the case above: `.strict()` must reject the EXTRA key, not
    // the member itself. Without this, deleting the `unreadable` member entirely
    // would still pass the rejection test.
    const result = DelegationStatusEntrySchema.safeParse({
      ...validClaimedEntry,
      activity: { kind: 'unreadable' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects claim activity on a delegation that is not claimed (#519)', () => {
    // Pins the refine added in Step 3. A pending delegation has no holder, so it
    // has no progress to report; activity on one is a producer bug.
    const result = DelegationStatusEntrySchema.safeParse({
      ...validPendingEntry,
      activity: { kind: 'known', lastProgressAt: '2026-07-16T00:00:00.000Z', idleFor: 0, idle: false },
    });
    expect(result.success).toBe(false);
  });
```

> `validClaimedEntry` / `validPendingEntry` are the suite's existing entry fixtures — `grep -n "state: 'claimed'\|state: 'pending'" packages/core/__tests__/runbook/delegation-schemas.test.ts` and reuse the nearest passing literal rather than inventing one. **Annotate any new fixture's type** so it stays compile-visible (Task 1's Tier 1).

- [ ] **Step 9: Run the status suites**

Run: `pnpm --filter @rundown-org/cli exec jest status`
Run: `pnpm --filter @rundown-org/core exec jest delegation-schemas`

Expected: PASS.

> **Not `jest zod-schemas`.** An earlier draft ran that; jest's positional argument is a regex over **test file paths**, and there is no core test file matching `zod-schemas` — `zod-schemas.ts` is *source*. The pattern matches **zero** files, so the command reports no tests and proves nothing. The schema's tests live in `delegation-schemas.test.ts`.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/runbook/claim-activity.ts \
  packages/core/src/output/zod-schemas.ts \
  packages/cli/src/helpers/duration.ts \
  packages/cli/src/helpers/status-builder.ts \
  packages/cli/src/commands/status.ts \
  packages/cli/src/services/renderers/text-renderer.ts \
  packages/cli/__tests__/commands/claim-idle-surfaces.test.ts \
  packages/cli/__tests__/helpers/status-builder.test.ts
git commit -m "feat(cli): surface claim idle activity on rundown status (#519)"
```

---

## Task 7: `rundown collect` surfaces unresolved-child activity (AC9 collect, AC14 containment)

**Files:**

- Modify: `packages/core/src/runbook/command-policy.ts:218-232` (`collection_applied`) and the `collection_frame_not_active` member
- Modify: `packages/core/src/runbook/collection-service.ts:440-600` (`applyCollection`)
- Modify: `packages/cli/src/commands/collect.ts:~250` (`renderAppliedOutcome`) and the `not-active` arm
- Modify: `packages/cli/src/schemas/output-schemas.ts:129-165` (`CollectAppliedResponseSchema`, `CollectNotActiveResponseSchema`)
- Test: `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts` (extend), `packages/core/__tests__/runbook/collection-service.test.ts` (extend)

**Interfaces:**

- Consumes: `CommandTargetReader.listOpenClaimsForParent(parentRunId): Promise<readonly ClaimRecord[]>` (already on `CollectionSessionService` via `command-target-resolver.ts:253`; implemented at `session-service.ts:640`). It returns exactly the non-terminal, not-yet-`done` delegated child claims for a parent — the unresolved children. `claimActivity` / `DEFAULT_IDLE_AFTER_MS` (Task 2).
- Produces:
  - `type UnresolvedChildActivity` — a **discriminated union on `kind`**, exported from `command-policy.ts` next to `DelegationPolicyOutcome`. Declared exactly once (Step 3); there is deliberately no flat `interface UnresolvedChildActivity` beside it:

    ```typescript
    type UnresolvedChildIdentity = {
      readonly substep: string;
      readonly childRunId: RunId;
      readonly claimKey: ClaimLookupKey;
    };
    type UnresolvedChildActivity =
      | (UnresolvedChildIdentity & {
          readonly kind: 'known';
          readonly lastProgressAt: string;
          readonly idleFor: DurationMs;
          readonly idle: boolean;
        })
      | (UnresolvedChildIdentity & { readonly kind: 'unreadable' });
    ```

  - `collection_applied` and `collection_frame_not_active` each gain `readonly unresolvedChildren: readonly UnresolvedChildActivity[]`.

- [ ] **Step 1: Make the suite's test double able to express this, THEN write the failing core tests**

**Read this before writing a line.** `collection-service.test.ts` does **not** drive a real session-backed `SessionService`. Its `sessionService` is a hand-built object literal (`:150-197`) whose `listOpenClaimsForParent()` returns `[]` **unconditionally** (`:193-195`) and which has **no** `recordClaimProgress` at all. Two earlier drafts each foundered on this and contradicted each other:

- One wrote tests that backdated `manager.loadSession()` claims and expected `unresolvedChildren` to reflect them. The double ignores the session entirely, so the list is always `[]` and the assertions can never pass.
- The other called `await applyCollection(collectionInput())`. **`applyCollection` is module-private** (`collection-service.ts:440` — declared `async function`, never exported) and **`collectionInput` does not exist** in the suite (0 occurrences). It does not compile, let alone run.

There is one public entry point and the suite already uses it everywhere: **`collectionService.collectDelegationOutcomes(...)`**. Everything below drives that.

First extend the double — two edits, both preserving current behaviour for every existing case:

```typescript
  // #519: tests that assert unresolvedChildren must supply the claims. Defaults to
  // [] so every pre-existing case in this suite behaves exactly as before.
  let openClaimsForParent: ClaimRecord[] = [];
  // #519: the presented claims this collect recorded progress for, in call order.
  // A SPY, not session state: this double is not session-backed, so "the child was
  // not refreshed" is proven by what recordClaimProgress was CALLED with — which is
  // the sharper assertion anyway, since it pins the bearer scoping directly.
  let recordedProgressFor: ClaimId[] = [];
```

Reset both in `beforeEach` (`recordedProgressFor = []; openClaimsForParent = [];`) and add to the `sessionService` literal, replacing the unconditional `listOpenClaimsForParent`:

```typescript
      async listOpenClaimsForParent() {
        return openClaimsForParent;
      },
      // Task 4 Step 5 adds recordClaimProgress to CollectionSessionService. Without
      // it here the double no longer satisfies the interface and every collect test
      // in this file dies on `sessionService.recordClaimProgress is not a function`.
      async recordClaimProgress(claimId: ClaimId) {
        recordedProgressFor.push(claimId);
        return { kind: 'no-claim' } as const;
      },
```

Now the tests:

```typescript
  it('reports each unresolved child claim with its activity (#519)', async () => {
    await manager.save(state());
    openClaimsForParent = [claimRecordFor('1.2', '2020-01-01T00:00:00.000Z')];

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: state(),
      steps,
      callerEvidence: { kind: 'claim_bearer', claimId },
    });

    if (outcome.kind !== 'collection_applied') {
      throw new Error(`expected collection_applied, got ${outcome.kind}`);
    }
    // The parent resuming after its child's turn sees WHICH children are not
    // progressing, without issuing a second command.
    const child = outcome.unresolvedChildren.find((c) => c.substep === '1.2');
    expect(child).toBeDefined();
    // `claimKey` is on the shared identity, so it reads without narrowing...
    // `openClaimsForParent[0]` needs no `!`: no tsconfig in this repo sets
    // `noUncheckedIndexedAccess`, so index access is `T`, not `T | undefined`, and
    // a `!` here would be an UNNECESSARY assertion — an ESLint error under
    // strictTypeCheckedOnly, failing `pnpm run verify`. `child!` IS necessary:
    // `.find()` genuinely returns `T | undefined`.
    expect(child!.claimKey).toBe(openClaimsForParent[0].claimKey);
    // ...but `idle`/`lastProgressAt` live only on the `known` member, so the test
    // MUST narrow to read them. A test that reached past `kind` would refute the
    // very type it exists to pin.
    if (child!.kind !== 'known') throw new Error(`expected a known child, got ${child!.kind}`);
    expect(child!.idle).toBe(true);
    expect(child!.lastProgressAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('keeps healthy children visible when one child has a corrupt timestamp (#519 AC6/AC14)', async () => {
    // THE decisive containment case. A list-level catch would return [] here and
    // erase the healthy child, telling the parent nothing needs checking — a worse
    // fail-open than the NaN comparison AC6 rejects. Containment is per child
    // precisely so that cannot happen.
    await manager.save(state());
    openClaimsForParent = [
      claimRecordFor('1.1', 'not-a-date'),
      claimRecordFor('1.2', '2020-01-01T00:00:00.000Z'),
    ];

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: state(),
      steps,
      callerEvidence: { kind: 'claim_bearer', claimId },
    });

    if (outcome.kind !== 'collection_applied') {
      throw new Error(`expected collection_applied, got ${outcome.kind}`);
    }
    expect(outcome.unresolvedChildren).toHaveLength(2);
    // Sorted by substep, so 1.1 (corrupt) is first and 1.2 (healthy) second.
    // No `!` on the destructured bindings: without `noUncheckedIndexedAccess`
    // (unset in every tsconfig here) these are `T`, not `T | undefined`, so a `!`
    // would be an unnecessary assertion and an ESLint error under
    // strictTypeCheckedOnly — `pnpm run verify` would fail. The `toHaveLength(2)`
    // above is what makes the bindings safe.
    const [corrupt, healthy] = outcome.unresolvedChildren;
    expect(corrupt.kind).toBe('unreadable');
    expect(corrupt.substep).toBe('1.1');
    if (healthy.kind !== 'known') throw new Error(`expected a known child, got ${healthy.kind}`);
    expect(healthy.substep).toBe('1.2');
    expect(healthy.idle).toBe(true);
  });

  it("reports the CHILDREN's activity while refreshing only the orchestrator's own claim (#519 AC5)", async () => {
    await manager.save(state());
    const openChild = claimRecordFor('1.2', '2020-01-01T00:00:00.000Z');
    openClaimsForParent = [openChild];

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: state(),
      steps,
      callerEvidence: { kind: 'claim_bearer', claimId },
    });

    if (outcome.kind !== 'collection_applied') {
      throw new Error(`expected collection_applied, got ${outcome.kind}`);
    }
    // The collect refreshes the ORCHESTRATOR's claim — the bearer the caller
    // PRESENTED — and nothing else. The child is REPORTED ON, never refreshed: a
    // parent cannot vouch for a child's liveness, and must not appear to.
    // Stated as exact equality, not `toContain`: "recorded the parent" and "recorded
    // ONLY the parent" are different claims, and only the second is AC5. A loop over
    // the session's claims, or a call passing `target.claimId` alongside
    // `callerEvidence.claimId`, fails here and passes `toContain`.
    //
    // Deliberately NOT followed by `expect(recordedProgressFor).not.toContain(openChild.claimKey)`:
    // an earlier draft added that line believing it strengthened the assertion. It
    // cannot fail under ANY implementation, correct or broken — `recordedProgressFor`
    // holds `ClaimId` bearers (`rdclm_…`) and `claimKey` is a `ClaimLookupKey`
    // (`rdclk_…`), disjoint value spaces that can never compare equal. The
    // `toEqual([claimId])` above already IS the AC5 assertion; the extra line was
    // decoration that read as rigour.
    expect(recordedProgressFor).toEqual([claimId]);
  });
```

> `claimRecordFor(substep, lastProgressAt)` is a local helper you write in this file: a `ClaimRecord` whose `delegation.parentStepId` is `substep`, carrying the given `lastProgressAt`, with a `claimKey` distinct per substep. Build it from the suite's existing claim shape (`grep -n "claimKey\|tokenHash" packages/core/__tests__/runbook/collection-service.test.ts | head`), or mirror `command-target-resolver.test.ts:69`. Annotate its return type `: ClaimRecord` so it stays compile-visible (Task 1's Tier 1 — an un-annotated fixture here would rot silently).
>
> `state()`, `steps`, `claimId`, and `claimKey` are the suite's own existing fixtures — it already calls `collectDelegationOutcomes({ targetState: state(), steps, callerEvidence: { kind: 'claim_bearer', claimId } })` at `:228`, `:248`, `:266`, `:296`, and `:357`. Copy the arrangement from the nearest passing `collection_applied` case rather than inventing `setupPartiallyResolvedParent` / `requireState` / `collectionInput`, none of which exist. Import `type ClaimId` and `type ClaimRecord` if the file does not already.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest collection-service.test.ts -t "unresolved child"`

Expected: FAIL — `outcome.unresolvedChildren` does not exist (TypeScript error).

- [ ] **Step 3: Add `UnresolvedChildActivity` to the policy outcome**

In `packages/core/src/runbook/command-policy.ts`, above `DelegationPolicyOutcome` (`:136`), declare the type **once** — a **union**, because an unreadable child genuinely has different data (it has no `idleFor` to report) and callers must narrow rather than read a fabricated value:

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
 * Reports the CHILD's activity. The orchestrator's own claim is refreshed by the
 * collect itself; a child's claim is never refreshed by its parent's command.
 * `unresolvedChildren.length` may be LESS than `unresolved`: `unresolved` counts
 * unresolved substeps, while this lists only those with a claimed child (a pending,
 * unclaimed delegation has no claim record and therefore no activity to report).
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

Then add the field to the `collection_applied` member (`:220-232`), after `unresolved`:

```typescript
      /** Number of outcomes still unresolved after this collection. */
      readonly unresolved: number;
      /** Advisory activity for each unresolved child that has a claim (#519). */
      readonly unresolvedChildren: readonly UnresolvedChildActivity[];
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
        // Same single predicate as the status boundary — see isClaimProgressUnreadable.
        if (!isClaimProgressUnreadable(error)) throw error;
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

> Import `claimActivity`, `DEFAULT_IDLE_AFTER_MS`, `isClaimProgressUnreadable` from `./claim-activity.js`, `type ClaimRecord` from `./claim-id.js`, and `type UnresolvedChildActivity` from `./command-policy.js` in this file's existing import block. `RundownError` is NOT needed — `isClaimProgressUnreadable` owns that narrowing. Place the `readUnresolvedChildActivity` call AFTER the drain (so a child resolved by this very collect no longer appears) and after the Step 5 (Task 4) `recordClaimProgress` call — the ordering is: commit → record own progress → derive the children's read model.

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
  z
    .object({
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
    })
    .strict(),
  z
    .object({
      kind: z.literal('unreadable'),
      ...UnresolvedChildIdentitySchema,
    })
    .strict(),
]);
```

> **`.strict()` for the same reason as `DelegationActivitySchema`** (Task 6 Step 3): zod strips unknown keys by default, so without it `{ kind: 'unreadable', substep: '1.1', childRunId: …, claimKey: …, idle: true }` parses **clean** with `idle` silently dropped — the schema rubber-stamping a fabricated label on the one member whose entire purpose is carrying no label. `.strict()` turns that into the validation error it should be.

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

Add to `packages/cli/__tests__/commands/claim-idle-surfaces.test.ts` — the file Task 6 Step 1 created, so it already binds `workspace` at **file scope** (which is why Task 6 puts it there rather than inside its `describe` — this suite needs it too) and already imports `backdateClaimProgress` / `claimChild` / `setupParentWithChildren`. Two additions to make before the snippet below compiles:

- **Add `findActionOutput` to the existing `test-utils.js` import.** It is real and exported (`test-utils.ts:658`), typed `findActionOutput<T>(stdout: string): T | null` — it just is not in Task 6's import list.
- **Write the two setups as file-local helpers.** `setupParentWithOneReportedOneOpen(workspace)` and `setupParentWithTwoOpenChildren(workspace)` do not exist anywhere; both are thin compositions of `setupParentWithChildren` + `claimChild`, and both take `workspace` and return the bearer claims they mint (`childClaim11` / `childClaim12`):

```typescript
/** Parent with 1.1 claimed-and-passed and 1.2 claimed but still open. */
async function setupParentWithOneReportedOneOpen(
  workspace: TestWorkspace,
): Promise<{ childClaim11: string; childClaim12: string }> {
  const { token1, token2 } = await setupParentWithChildren(workspace);
  const childClaim11 = await claimChild(workspace, token1);
  const childClaim12 = await claimChild(workspace, token2);
  // 1.1 reports; 1.2 is left open so it is the one `collect` reports as unresolved.
  await runCliInProcess(['pass', '--claim-id', childClaim11], workspace);
  return { childClaim11, childClaim12 };
}

/** Parent with BOTH children claimed and neither reported. */
async function setupParentWithTwoOpenChildren(
  workspace: TestWorkspace,
): Promise<{ childClaim11: string; childClaim12: string }> {
  const { token1, token2 } = await setupParentWithChildren(workspace);
  return {
    childClaim11: await claimChild(workspace, token1),
    childClaim12: await claimChild(workspace, token2),
  };
}
```

```typescript
/**
 * The wire shape of `unresolvedChildren[]` — a discriminated union, mirroring
 * `UnresolvedChildActivitySchema`.
 *
 * Declared as a UNION, not as flat optionals with `kind: string`. An earlier draft
 * wrote the latter and then read `child!.idle` without narrowing — reintroducing
 * the plan's central defect in the one place it is decisive. These tests exist to
 * demonstrate that an agent reading this JSON must narrow on `kind`; a test that
 * types the payload as a bag of optionals is asserting the opposite, and would go
 * on passing if the production union collapsed back into optionals tomorrow.
 */
type WireUnresolvedChild =
  | { kind: 'known'; substep: string; childRunId: string; claimKey: string; lastProgressAt: string; idleFor: number; idle: boolean }
  | { kind: 'unreadable'; substep: string; childRunId: string; claimKey: string };

describe('rundown collect claim activity (#519)', () => {
  it('reports each unresolved child with lastProgressAt, idleFor and idle (JSON)', async () => {
    // Parent with two delegated children; 1.1 reports, 1.2 stays open and idle.
    const { childClaim12 } = await setupParentWithOneReportedOneOpen(workspace);
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim12), '2020-01-01T00:00:00.000Z');

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const action = findActionOutput<{
      unresolved: number;
      unresolvedChildren: WireUnresolvedChild[];
    }>(collected.stdout);
    const child = action!.unresolvedChildren.find((c) => c.substep === '1.2');
    expect(child).toBeDefined();
    // Narrow on `kind` — exactly as an agent consuming this JSON must. There is no
    // `child.idle` to reach for until this line has run.
    if (child!.kind !== 'known') throw new Error(`expected a known child, got ${child!.kind}`);
    expect(child!.idle).toBe(true);
    // Milliseconds in JSON, matching DurationMs.
    expect(child!.idleFor).toBeGreaterThan(60 * 60 * 1000);
  });

  it('keeps healthy children visible when one child has a corrupt timestamp (JSON, AC6)', async () => {
    // The CLI-boundary sibling of the core case: one unreadable child must not
    // erase the report. A list-level catch would return [] and tell the parent
    // nothing needs checking — the fail-open AC6 exists to reject.
    const { childClaim11, childClaim12 } = await setupParentWithTwoOpenChildren(workspace);
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim11), 'not-a-date');
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim12), '2020-01-01T00:00:00.000Z');

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const action = findActionOutput<{ unresolvedChildren: WireUnresolvedChild[] }>(collected.stdout);
    expect(action!.unresolvedChildren).toHaveLength(2);

    // The corrupt child reports `unreadable` and carries NO idle label — asserted
    // by exact shape, so a fabricated `idle: false` sneaking in would fail here.
    const corrupt = action!.unresolvedChildren.find((c) => c.substep === '1.1');
    expect(corrupt!.kind).toBe('unreadable');
    expect(corrupt).not.toHaveProperty('idle');
    expect(corrupt).not.toHaveProperty('idleFor');

    const healthy = action!.unresolvedChildren.find((c) => c.substep === '1.2');
    if (healthy!.kind !== 'known') throw new Error(`expected a known child, got ${healthy!.kind}`);
    expect(healthy!.idle).toBe(true);
  });

  it('a naive agent-style filter cannot skip the corrupt child (JSON, AC6)', async () => {
    // The collect-side sibling of the status case. `kind` is present on EVERY
    // entry, so one predicate over the discriminant catches both the idle child
    // and the one that cannot be assessed. Flat optionals would have let
    // `filter((c) => c.idle)` drop the corrupt child silently.
    const { childClaim11, childClaim12 } = await setupParentWithTwoOpenChildren(workspace);
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim11), 'not-a-date');
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim12), '2020-01-01T00:00:00.000Z');

    const collected = await runCliInProcess('collect', workspace);

    const action = findActionOutput<{ unresolvedChildren: WireUnresolvedChild[] }>(collected.stdout);
    const needsAttention = action!.unresolvedChildren
      .filter((c) => c.kind === 'unreadable' || c.idle)
      .map((c) => c.substep)
      .sort();
    expect(needsAttention).toEqual(['1.1', '1.2']);
  });

  it('reports an empty unresolvedChildren list when every child resolved (JSON)', async () => {
    await setupParentWithAllChildrenReported();

    const collected = await runCliInProcess('collect', workspace);

    const action = findActionOutput<{ unresolvedChildren: WireUnresolvedChild[] }>(collected.stdout);
    expect(action!.unresolvedChildren).toEqual([]);
  });

  it('renders an advisory idle line in --text', async () => {
    const { childClaim12 } = await setupParentWithOneReportedOneOpen(workspace);
    await backdateClaimProgress(workspace, claimKeyFromBearer(childClaim12), '2020-01-01T00:00:00.000Z');

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

> `setupParentWithTwoOpenChildren` is a sibling of the suite's existing parent setup — reuse the `setupParentWithChildren` that **Task 5 Step 0 extracts into `test-utils.ts`** (not the copy still nested in `delegate-workflow.test.ts`, which has no exports to import) and claim both children with `claimChild`, rather than writing a third fixture.

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

Claimed entries MAY additionally carry an advisory `activity` object, present
only when `state` is `claimed` and the claim record was found. It is a
**discriminated union on `kind`** — narrow on it rather than reading a field
directly:

- `{"kind": "known", "lastProgressAt": "<ISO>", "idleFor": <ms>, "idle": <bool>}`
- `{"kind": "unreadable"}` — the claim's `lastProgressAt` is corrupt, so no
  activity can be derived. It carries **no** `idle` label: a guessed one would be
  worse than none. Treat this child as needing attention.

An **absent** `activity` (nothing to assess) is a distinct state from
`"unreadable"` (cannot be assessed). Because `kind` is present on every reported
activity, one predicate covers both children worth checking:
`d.activity && (d.activity.kind === 'unreadable' || d.activity.idle)`.

`lastProgressAt` is refreshed only by a successful claim-authenticated command
that **changes runbook workflow state**, run by that claim's own bearer. The
predicate is workflow state, not "mutation": `rundown status --claim-id`
deliberately does **not** refresh it, so a stuck child polling its own status
cannot mask that it is idle, and `stash` / `pop` do **not** refresh it either —
both are claim-authenticated mutations, but they change session targeting rather
than workflow state. `idle` is
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
      "kind": "known",
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

Each entry is a **discriminated union on `kind`**, the same shape `status` uses:
a `"known"` member carries `lastProgressAt` / `idleFor` / `idle`, and an
`"unreadable"` member carries only the child's identity — a corrupt
`lastProgressAt` is never guessed at, and never silently dropped from the list
either (a shorter list would read as "fewer children need checking").

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

- [ ] **Step 3: Verify AC12 — no machine state, event, expiry, reclaim, or synthesized result ACROSS ALL THREE PLANS**

**`git diff main` is the WRONG base here, and it fails silently.** AC12 is a whole-of-#519 audit, but by the time you run it, plans 1 and 2 are **already merged to `main`** — so `git diff main` shows only plan 3's diff, and every line Tasks 1–5 added (`claim-id.ts`, `session-service.ts`, `claim-activity.ts`, the eight recording call sites) is invisible to it. The audit would narrow to a third of the change while reading exactly like a full sweep, and report a clean result. Anchor the diff to the commit **before plan 1's first commit** instead:

```bash
# The last commit before ANY #519 production code landed. Verify by eye that its
# subject predates plan 1 — do not trust the offset blindly if other work merged
# alongside these three PRs.
BASE=$(git log --oneline --all --format='%H %s' | grep -m1 'docs(specs): fix #519 unsound guard anchors' | cut -d' ' -f1)
git diff "$BASE" --stat
```

Expected: the changed-file list spans all three plans' production files, and contains **no** file under `packages/core/src/runbook/actors/`, no `compiler*.ts`, no `events/` type, and no state-machine definition. **If the list shows only plan 3's files, your base is wrong — fix it before reading the result as a pass.** Then:

```bash
git diff "$BASE" -- packages/core/src packages/cli/src | grep -nE "expire|expiry|reclaim|ttl|TTL|heartbeat|setInterval|setTimeout"
```

Expected: no hits in production code (test-only `setTimeout` waits are fine and are not in this diff scope). If anything matches, it is a design violation — the spec's Non-Goals are explicit: no expiry, no reclaim, no auto-abort, no synthesized child PASS/FAIL, no machine state, no events, no `rundown heartbeat`, no probing, no configuration surface.

- [ ] **Step 4: Format and spell-check the docs and code**

Run: `npx prettier --write docs/spec/cli-output.md docs/superpowers/plans/2026-07-17-claim-progress-3-surfaces.md`
Run: `pnpm run check:spell`

Expected: PASS. If cspell flags a new term (`humanise`, `rdclk`, `Stryker`), add it to the repo's cspell dictionary the same way existing terms are registered — do not reword the doc to dodge the checker.

- [ ] **Step 5: Run the pre-PR verification gate**

Run: `pnpm run verify`

Expected: PASS (format, spell, lint, tests across all packages). **Mandatory before every push** per CLAUDE.md.

- [ ] **Step 6: Re-run the scoped mutation gate (AC13)**

Use the **direct `exec stryker` form with PACKAGE-RELATIVE paths**, exactly as plan 1's Task 2 Step 8. Neither script form works — see that step for why both fail (one runs unscoped, the other dies on `too many arguments for 'run'`). Task 6 adds `ChildActivity` to `claim-activity.ts`, so this re-run is mandatory, not optional:

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate src/runbook/claim-activity.ts,src/runbook/duration.ts \
  --testFiles __tests__/runbook/claim-activity.test.ts,__tests__/runbook/claim-activity.properties.test.ts,__tests__/runbook/duration.test.ts
```

> **The paths are package-relative — `pnpm --filter … exec` runs with cwd = `packages/core`.** An earlier draft passed `--mutate packages/core/src/runbook/claim-activity.ts`, which matches nothing from there: Stryker reports `Instrumented 0 source file(s) with 0 mutant(s)` and **exits 0**. Verified. A gate that cannot fail is worse than no gate, because it is read as a pass. See the Global Constraint.

**Check the `Instrumented 2 source file(s) with N mutant(s)` line before reading the score.** `Instrumented 0` = the globs matched nothing (paths are repo-relative); thousands = the scoping was dropped; `too many arguments for 'run'` = the `--` trap. A 0.00% score with a correct instrumentation count means the test files stopped importing the module statically (#541) — fix the import, not the threshold.

**Core is excluded from the per-PR mutation matrix** (`.github/workflows/mutation-pr.yml:34-42`) and that workflow is `continue-on-error` regardless, so this step is the only mutation signal this PR gets on `claim-activity.ts`.

- [ ] **Step 6b: Re-run the drift guard last (AC4)**

Run: `pnpm --filter @rundown-org/cli exec jest claim-progress-drift-guard.test.ts`

Expected: PASS. Run this **after** every other task has landed: it is the one test that fails if any of the eight commands lost its recording call site during the intervening work, which is exactly the drift it exists to catch.

- [ ] **Step 7: Commit**

```bash
git add docs/spec/cli-output.md
git commit -m "docs(spec): document claim idle activity on status and collect (#519)"
```

- [ ] **Step 8: Close #519 via the PR — this is the LAST of the three**

This is the third and final PR for #519, so this is the one that carries `Closes #519`. Plans 1 and 2 reference the issue but must **not** close it.

Note in the body that this discharges cluster #565's (R4 Capability Tier) third exit criterion — "parent-side liveness or lease behavior" — as a **reframing**: no liveness detection and no lease are possible for a claim held by an agent across transient CLI invocations (there is no process to probe and no daemon to reap), so an advisory progress signal is the most the architecture admits.

**Do not describe this PR as the breaking change** — it is not, and an earlier single-plan draft of this step said so because everything shipped at once. The persisted-session break (`ClaimRecord.lastProgressAt` required; pre-existing sessions rejected with finish/prune/restart rather than migrated, per CLAUDE.md § State Persistence) shipped in **plan 1**. Reference it as already-landed context for anyone reading #519's history end to end; this PR adds two read-only surfaces and touches no persisted shape.

Do NOT edit the epic (#564) or cluster (#565) roadmap status in this PR beyond referencing #519.

```bash
git push -u origin claim-progress-surfaces
gh pr create --title "feat: surface claim idle activity on status and collect (#519)" --body "$(cat <<'BODY'
Plan 3 of 3 for #519 (see docs/superpowers/plans/2026-07-17-claim-progress-3-surfaces.md). Builds on plan 1 (the claim shape, the pure derivation module, the recording API) and plan 2 (recording wired into the eight workflow-state commands, pinned by the drift guard).

Makes the recorded progress visible, read-only and derived at read — nothing persisted, no machine state, no events:

- `rundown status` — each claimed delegation gains `activity`, joined onto the `session.claims` read it already does for the #531 `claimKey`.
- `rundown collect` — each unresolved child gains its activity, sourced from `listOpenClaimsForParent`, which already returns exactly those children.
- Both derive **per child**: one corrupt `lastProgressAt` is reported as its own `unreadable` member and its healthy siblings still report normally. A read-only command never surfaces a corrupt record as an unhandled throw.
- The `known` | `unreadable` union reaches the **JSON** on both surfaces as a `z.discriminatedUnion`, never flattened into optionals. JSON is the agent-facing contract and the agent has no compiler: flattened, `idle === undefined` would mean three different things and `delegations.filter((d) => d.idle)` would silently skip the corrupt child — the one most worth checking.
- `docs/spec/cli-output.md` documents both schemas, including that `unresolvedChildren.length` may be less than `unresolved` (a pending, unclaimed delegation has no holder whose progress could be measured).

Discharges cluster #565's third exit criterion ("parent-side liveness or lease behavior") as a reframing: no liveness detection and no lease are possible for a claim held by an agent across transient CLI invocations — there is no process to probe and no daemon to reap — so an advisory progress signal is the most the architecture admits. Nothing expires, nothing is reclaimed, no result is synthesized.

AC9, AC10, AC12, AC14.

Closes #519
BODY
)"
```

---

---

## Self-Review

**Spec coverage.** AC9 (Tasks 6–7), AC14 (Tasks 6–7), AC10 (Task 8), AC12 (Task 8 Step 3). AC13's second half — `humaniseDurationMs` held to the same mutation standard — is Task 6 Steps 4b/4c, claimed in this plan's AC section; the `claim-activity.ts` half was plan 1's, and Task 8 Step 6 re-runs it because Task 6 modifies that module.

**Placeholder scan.** No `TBD` / `TODO`. `findDetailOutput` — a reader that never existed — is gone; the tests parse with `JSON.parse(stdout)` and validate with `validateStatusOutput`, mirroring the #531 test at `status.test.ts:778-860`.

**Type consistency.** `ChildActivity` is declared **once**, here, in plan 1's `claim-activity.ts`; `UnresolvedChildActivity` once, in `command-policy.ts`. Neither has a flat interface of the same name beside it. Both reach the JSON as `z.discriminatedUnion('kind', …)` with **every member `.strict()`** — without `.strict()`, zod strips unknown keys and `{ kind: 'unreadable', idle: true }` parses **successfully** with `idle` silently dropped, the schema rubber-stamping a fabricated label on the member whose whole purpose is carrying none. Every test that reads a `known`-only field narrows on `kind` first, **including Task 7 Step 7** (the collect wire) — named explicitly because an earlier draft asserted "every test narrows" while Step 7 was the one place violating it.

## Findings retained from review — do not re-derive, do not reintroduce

**The union must reach the wire unflattened — this is the plan's central argument and it was violated once already.** An earlier draft got `collect` right (union in core AND on the wire) and flattened `status` into four independent optionals held together by refines. **JSON is the agent-facing contract and the agent has no compiler.** Flattened, `idle === undefined` means three different things — not claimed / no claim record / corrupt record — and `delegations.filter((d) => d.idle)` silently skips the corrupt child, the one most worth checking: the same fail-open AC6 rejects, arriving through the wire format instead of a `NaN` comparison. `--text` loudness is not an answer; `--text` is the human format.

**Per-child containment, never a catch around the list.** An earlier draft wrapped collect's whole derivation in `catch { return []; }`, so one corrupt timestamp erased **every** unresolved child — including genuinely idle ones — and the parent read an empty list as "nothing to check". That is strictly worse than the `NaN` it replaced. `status` had no containment at all and would have thrown a stack trace out of a read-only command where a JSON envelope is the contract.

**`jest zod-schemas` matches zero test files** — jest's positional is a regex over test *paths*, and `zod-schemas.ts` is source. It read like a gate and proved nothing. The schema tests live in `delegation-schemas.test.ts`.

**The `--text` renderer is `text-renderer.ts`, not `output-emitter.ts` or `table-formatter.ts`** (both have zero delegation hits), it carries its **own** duplicate of the entry shape at `:62-71`, and it is a **line** format — "add a column with UPPERCASE headers" does not apply to it.

**Editing these plans? The signature failure mode is a repair that cannot execute.** Five review rounds on the single-plan draft found the same shape repeatedly: a fix that was sound in reasoning and broken in mechanics — a drift guard whose scan was fed by its own tables, a `expect(actual, reason)` that is Vitest syntax under Jest, a mutation gate whose flags never reached Stryker, a pointer to a helper that did not exist. Each looked right and could not run. **A repair that cannot execute is worth less than the defect it replaces, because it also spends the reader's trust.** If you change a command, a probe, or a fixture pointer here, run it.
