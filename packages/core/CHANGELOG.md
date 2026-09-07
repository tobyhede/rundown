# @rundown-org/core

## 2.0.0

### Major Changes

- 91a2dab: # BREAKING: the resolved-completion drain becomes a single-apply
  primitive

  `RunbookCompletionService.drainResolvedCompletions` and its unlocked twin are
  replaced by `applyNextResolvedCompletion`, which applies exactly one
  completion per call. `RunbookCompletionService.recordManualCompletion` and
  `ExecutionLifecycleService.listResolvedCompletions` are removed, as are the
  `DrainResolvedCompletionsArgs` / `DrainResolvedCompletionsResult` types.
  `RunbookCompletionService`'s constructor no longer takes an
  `ExecutionLifecycleService`.

  The drain selected a completion against a caller-supplied `currentState` and
  then let `sendAndSync` load its own state to apply against. The
  compare-and-swap underneath prevented a lost update, but not a stale
  derivation: if the cursor moved between the two, the drain consumed the row
  for the substep the caller had captured while raising its PASS on the substep
  the machine had since advanced to. The completion landed on the wrong substep,
  its own substep stayed `running`, and the passed-over row was left stranded.

  `applyNextResolvedCompletion` runs selection, cursor validation, the actor
  transition, and the commit inside one `mutateStateReturning` cycle, so the row
  it applies is chosen against the exact version the write commits onto and a
  losing attempt re-derives rather than replaying a stale pick. It takes no
  `currentState` — a caller-supplied state is stale by construction at that
  seam. It also retires the last `CompletionLock` acquisition in core.

  Callers that drained a frame to exhaustion now loop the primitive until it
  stops reporting `applied`. The CLI already did exactly that, one apply at a
  time, so that its execution loop could observe and emit each transition before
  deriving the next one; it no longer threads state between calls, so a
  completion recorded by another process mid-drain is picked up rather than
  missed.

  `RunbookStateManager.mutateStateReturning` is added: a compare-and-swap whose
  callback derives the whole next `RunbookState` rather than a patch, for
  derivations that already produce one.

  The CLI's own contract — commands, flags, JSON envelopes, exit codes — is
  unchanged.

- 8695941: # Delete the completion and delegation domain locks

  The two surviving core domain locks are gone, along with the error surface
  that existed only to report their timeouts. Every production acquisition had
  already been retired site by site under #690, so **no runtime behaviour
  changes** — by the time they were deleted the modules were dead code with a
  live public export.

  **The public API does change, and that is the breaking part of this major.**
  Six exported symbols, one error code, and two path helpers leave
  `@rundown-org/core`'s surface, so a consumer that imports any removed name no
  longer compiles. Each removal is enumerated below.

  **Removed from `@rundown-org/core`'s public surface** (six symbols):

  - `DelegationLock`, `DelegationLockTimeoutError`, `DelegationLockLike`
  - `CompletionLock`, `CompletionLockTimeoutError`, `CompletionLockLike`

  **Removed error code:** `DELEGATION_LOCK_TIMEOUT` / `RD-810`, together with
  the `Errors.delegationLockTimeout` factory and the code's Zod enum member. No
  producer of RD-810 remained in any package — the last emit sites went with the
  inline-launch and claim-and-launch retirements — so no envelope that a caller
  could previously observe stops being emitted. A consumer that pattern-matched
  on the literal `'RD-810'` will now never match, which is the intended outcome:
  the condition it named cannot arise.

  **Removed path helpers:** `delegationLockPath` and `completionLockPath`.
  `LOCKS_DIR`, `locksDir`, and `ensureStateDirs` are unchanged — the
  artifact-manifest append lock and the sql.js durable-replacement lock still
  occupy `.rundown/locks/`.

  The `file-lock.ts` primitives are untouched and remain public:
  `acquireFileLock` / `releaseFileLock`, `heldLock` / `heldLockSync`, and the
  `ScopedLock` / `ScopedLockSync` scoped-release types. File-based exclusive
  locks remain the correct mechanism for concurrent writes to a file-backed
  artifact; what is gone is using one to fence run or session state, which lives
  in SQLite and is fenced by transactions and execution leases.

  Nothing replaces the locks because every span they protected now derives its
  decision inside the compare-and-swap that commits it, rather than excluding
  other writers from the gap between the two.

- 2e0b7d7: # BREAKING: Move runbook state storage from `.claude/rundown/` to
  `.rundown/`

  State files, session tracking, and delegation locks are now stored under
  `.rundown/` instead of `.claude/rundown/`. No automatic migration is
  performed.

  **Upgrade instructions:**

  1. Complete or abort any in-flight runbooks _before_ upgrading.
  2. Update `.gitignore` — replace `.claude/rundown/` entries with:

     ```text
     .rundown/work/
     .rundown/runs/
     .rundown/session.json
     .rundown/locks/
     ```

  3. Move any project-local runbooks from `.claude/rundown/runbooks/` to
     `.rundown/runbooks/`.
  4. After confirming no in-flight runs, remove the old `.claude/rundown/`
     directory.

  The CLI will print a warning on startup if state is detected in the legacy
  location.

- 2d03652: BREAKING: Raise minimum Node.js version to >=24.0.0. This enables use
  of `Error.isError()` (TC39) and other Node 24 features across the codebase.
- d9f22a0: # Move the positional pop out of product reach

  `SessionService.popRunbook` has had zero product callers since the execution
  loop's terminal release moved onto `releaseRunbook(runbookId)`. What remained
  was a public method that authorizes on **position** rather than identity: it
  re-reads the stack inside its own transaction and releases whatever is on top
  by then, so a run pushed between a caller's decision and this write is the run
  that gets removed. Because the release deletes every claim controlling what it
  removes, a foreign run pushed-and-claimed by `rundown run` loses the
  run-control bearer its orchestrator still holds — and re-minting is refused
  once that run has issued a delegation. Leaving the method reachable leaves
  that defect one call site away.

  Moved to `@rundown-org/core/testing/session-fixtures` as
  `popTopOfStackUnverified`, following `stashRunbookUnverified` verbatim: the
  same "test-only, and here is exactly which defect living here prevents" shape,
  for the same reason.

  Each alternative was worse. `@deprecated` leaves it callable, which is the one
  thing this move is for. A lint fence fences a method that should not exist.
  Deleting it outright would push several core tests onto `releaseRunbook` and
  quietly change what they assert — they set up multi-level stacks and unwind
  them to a known depth, where naming no id is the point.

  Both production shapes name their run, and the doc comments now say which to
  reach for: `popRunbookIfActive` for an undo of an activation the caller
  performed, `releaseRunbook` for a terminal release that must reach its run
  wherever it now sits. `topOfStack` stays — `stash` uses it whole and
  `popRunbookIfActive` narrows it — with its comment corrected, since it named
  two positional callers and there is now one.

  This is a breaking change only for a consumer calling
  `SessionService.popRunbook` directly. Nothing in this repo does, and the
  method's whole problem was that calling it was unsafe.

- 4f90417: # Atomic Run Release, and a finished run keeps its claim

  An already-terminal `rundown run` entry revoked the run-control claim it had
  minted moments earlier. The orchestrator holding that bearer was told
  `CLAIMED_RUNBOOK_UNAVAILABLE` — "was released or replaced and is no longer
  authority" — about a rotation that never happened, and could not learn the
  run's outcome at all.

  The cause was a vocabulary that spelled three independent facts as one word.
  `stack-pop | release-runbook | defer-to-caller` conflated **who** releases,
  **whether** release fires, and **what happens to the claims**, and the CLI
  derived which arm to use from session contents that no longer described any of
  the three. `stack-pop` — the default — meant "this run is unclaimed, so
  revoke", while `rundown run` mints a run-control claim for every default-stack
  root. The arm asserted the exact inverse of the truth.

  ## What replaces it

  No release owner crosses execution frames. A transition capable of
  terminalizing the addressed run arms its transaction-owned Run Release;
  `ReleaseRole` decides claim disposition. Three session-derived modes are
  deleted:

  - `runbook-pipeline`'s activation-kind ternary,
  - `goto-workflow`'s `resolveTerminalReleaseModeForRunbook`, which read the
    session's claims,
  - `transitions`' restatement of core's resolution kind.

  `LifecycleTerminalReleaseMode` goes with them. Core derived it, threaded it
  through four private drive methods, and returned it on three outcomes without
  ever branching on it — a CLI decision that had taken up residence in the seam.

  ## What changes for a caller
  - An already-terminal loop entry resolves its run-control claim `terminal`,
    with the run's own lifecycle, rather than `superseded` / `claim-rotated`.
  - Frontier and drain refusals apply no terminal transition, leave the running
    run targeted, and preserve its authority for retry/recovery. Refusal
    Hand-back changes reporting only; it never claims terminality or releases
    the run.
  - A drain that reaches terminal now projects its addressed release atomically.
    It used to be gated on the `release-runbook` arm alone, so on `stack-pop`
    nothing released at all: the drain writes no session state of its own, and
    no healing path removes a loadable terminal run, so a finished run kept
    resolving as the session default. The third arm was never part of that
    defect — `defer-to-caller` was migration scaffolding and is removed by the
    atomic fold.

  ## Shape

  Terminal state and addressed release commit together. Re-entrant inline
  flow-back returns `handled` or fail-closed `blocked`, which makes enclosing
  frames stand down without repeating the upward walk. The public execution-loop
  result carries progression only, never a release disposition.

  Closes #781 and #789. No deprecated aliases, compatibility adapters or lint
  bans were added; the old names are simply gone.

- c082109: # One Run Release interface for both release seams

  Releasing a run from session targeting had two routes and five spellings of
  one policy. `SessionService.releaseRunbook` / `releaseRunbooks` took a
  `retainClaimsAsTerminal` boolean — or a `retainClaimsAsTerminalRunId` naming
  the one batch member that keeps its claims — while the transaction-folded
  route carried the same boolean into the mutation runner and projected it
  directly. Sixteen call sites each converted "what did I just do to this run?"
  into "should its claims survive?" for themselves, and omitting the option
  meant revoke, so a site that said nothing chose the destructive direction by
  accident.

  Both seams now take the same fact:

  ```ts
  export type ReleaseRole = 'addressed' | 'collateral' | 'discarded';
  export interface RunRelease { readonly runId: RunId; readonly role: ReleaseRole; }
  export function projectRunReleases(session: SessionData, releases: readonly RunRelease[]): void;
  ```

  `addressed` is the run the caller acted on and keeps its claims as terminal
  evidence; `collateral` is a run swept up so an addressed run could close;
  `discarded` is a run being destroyed. The mapping from role to claim
  disposition is module-private, so a caller states what it did and cannot
  restate the policy.

  `projectRunReleases` is batch-first, synchronous and in-place — the
  transaction route projects through a session callback that accepts nothing
  else — validates the whole batch before mutating, rejects a repeated run id as
  a programmer error, treats an absent run as a no-op, and returns nothing. The
  old `ReleaseRunbookResult` / `ReleaseRunbooksResult` payloads are removed; the
  only reader of either was the batch method building a list nobody read.

  `SessionService.releaseRunbook` and `releaseRunbooks` collapse into
  `releaseRuns(releases)`. On the transaction route,
  `EffectfulActorMutationRunnerInput.terminalRelease` becomes `{ role }`,
  present when this mutation projects release on terminal and absent when it
  does not, and `AggregateTerminalRelease` becomes `AggregateRunRelease`
  carrying a role beside its existing `when` trigger. `runAll` now also refuses
  a release batch that names one owned run twice, before it captures authority.
  `LifecycleTerminalReleasePolicy`'s equal `onComplete` / `onStopped` switches
  collapse to one `releaseOnTerminal` flag.

  The CLI's `transition-orchestrator` loses its terminal-release branch rather
  than migrating it. Terminal release moved inside core's fenced mutation some
  time ago, and both production callers had been passing `releaseRunbook: false`
  ever since; with the branch goes the refusal-downgrade that turned a refused
  release into a `stopped`, which no production path could reach.
  `orchestrateTransition` is now synchronous — it renders events and nothing
  else.

  Every release keeps its present claim disposition, including the
  already-terminal loop path, which stays `collateral` and so still revokes the
  claim of a run it addressed. That is #781, and it is fixed on top of this
  interface rather than inside it, so a regression in either is traceable to one
  of them.

- 25251a6: # BREAKING: SQLite is the sole run and session authority

  `.rundown/rundown.db` is now the only run and session authority. Every
  production JSON authority reader and writer is removed, and the path helpers,
  lock classes, and event field that described the old JSON layout are removed
  with them. `.rundown/runs/<run-id>/outputs/` remains for captured outputs.

  Pre-cutover JSON state (`.rundown/session.json`, `.rundown/runs/<id>.json`,
  `.claude/rundown/session.json`) is ignored entirely — not detected, parsed,
  migrated, warned about, refused, deleted, or rewritten. Those files are left
  byte-identical and their presence never prevents opening or creating the
  store. In-flight pre-cutover runs do not carry over: complete or abort them
  before upgrading, then start fresh.

  ## Removed from `@rundown-org/core`'s public API

  | Symbol                                   | Replacement                                                                                         |
  | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
  | `SESSION_FILE`                           | `DB_FILE` — session rows live in SQLite                                                             |
  | `sessionPath(cwd)`                       | `dbPath(cwd)`                                                                                       |
  | `statePath(cwd, id)`                     | none — run state is a row, not a file                                                               |
  | `LEGACY_SESSION_FILE`                    | none — the legacy location is not recognised                                                        |
  | `runStateLockPath(cwd, runId)`           | none — replaced by the `RunbookStore.mutateState` compare-and-swap                                  |
  | `sessionLockPath(cwd)`                   | none — replaced by `BEGIN IMMEDIATE` transactions                                                   |
  | `SessionLock`, `SessionLockTimeoutError` | as above                                                                                            |
  | `RunbookStartedEvent.statePath`          | `RunbookMetadata.runId` for run identity; `RunbookMetadata.state` now reports `.rundown/rundown.db` |

  `RunStateLock` was internal and is deleted without a public-API impact.
  `CompletionLock` and `DelegationLock` are deleted too — #690 moved every
  refusal they fenced into the transaction or compare-and-swap that commits the
  fact it depends on, leaving nothing for the locks to exclude.

  **`RunbookState.templateVars` is now required.** It was optional. `create`
  always writes it (`{}` at minimum) and `load` rejects a persisted row without
  it, because readers substitute `runbookSrc` against it on every resume and
  there is no sanctioned way to reconstruct one. A row lacking it is
  incompatible state whose only recovery is prune and restart — never a re-parse
  of the stored source. Callers constructing a `RunbookState` literal must now
  supply the field.

  **Default write policy no longer grants `.rundown/session.json`.** The grant
  for `.rundown/runs/**`, the database, its WAL/SHM sidecars, and
  `.rundown/locks/**` is unchanged.

  ## Added to `@rundown-org/core`'s public API

  Four error classes are now exported so a consumer can classify a storage or
  state failure with `instanceof` instead of matching a message or a class name
  as a string. Every one of them previously escaped to the CLI's top-level
  wrapper unclassified and rendered as `RD-999` / "Unknown error" — on **every**
  command, read-only ones included, because opening the database precedes all of
  them.

  - `WalJournalModeUnavailableError` — a file-backed connection did not enter
    WAL journal mode. Only WAL serializes writes across processes, so a silent
    rollback-journal fallback would leave the driver advertising
    `capabilities.multiProcess` over a connection that no longer provides it.
  - `NativeSqliteUnavailableError` and `SqljsUnavailableError` — the two halves
    of the store-open failure surface (WebContainer takes the sql.js path, every
    other host the native one). Both classes already existed; only the exports
    are new. A consumer needs both arms or it still falls through to `RD-999` on
    one class of host.
  - `ConcurrentStateModificationError`, with the
    `isConcurrentStateModificationError` guard — the throwing face of the
    `mutateState` compare-and-swap exhausting its optimistic retry budget.
    Carries the `runId`.
  - `InvalidRunIdError`, carrying the offending `value` — see the behaviour note
    below.

  Four new error codes, with a factory for each: `RD-306`
  `WAL_JOURNAL_MODE_UNAVAILABLE`, `RD-307` `STATE_STORE_UNAVAILABLE`, `RD-308`
  `CONCURRENT_STATE_MODIFICATION`, and `RD-309` `INVALID_PERSISTED_RUN_STATE`
  (`Errors.walJournalModeUnavailable`, `Errors.stateStoreUnavailable`,
  `Errors.concurrentStateModification`, `Errors.invalidPersistedRunState`).
  `RD-308` is deliberately **not** collapsed into the CLI's existing symbolic
  `CONCURRENT_MODIFICATION`: they are the same condition on two surfaces, one
  narrowed from a returned result and one thrown.

  Also added:

  - `DB_SIDECAR_SUFFIXES` — the `-wal`/`-shm` tuple, declared once so file-mode
    hardening, the default write policy, state teardown, and the site's path
    parity assertion all derive from one definition. It is a `readonly` tuple of
    string literals and must stay one; the parity assertion compares literal
    types.
  - `RunbookMetadata.runId` (optional) — run identity now travels here, since
    `state` is the same constant path for every run. Run ids are a read-only
    correlation handle: no read command accepts one as a mutation selector, and
    refusal envelopes never echo the target run id.
  - An optional `runId` on `RunbookContextSchema`, `ActionResponseSchema`,
    `StatusResponseSchema`, `StashResponseSchema`, and `PopResponseSchema`, so
    output carrying it validates against the published `--schema` contract.

  ## Behaviour change: `assertRunId` throws a typed error

  `assertRunId` now throws `InvalidRunIdError` rather than a bare `Error`. The
  class extends `Error`, so every `catch` narrowing with `instanceof Error` is
  unaffected, and all 21 production call sites were checked: none catches it and
  none matches its message.

  The message keeps its original prefix —
  `Invalid run id: expected rd_<32 lowercase hex chars>` — and appends the
  offending value, so a **substring or prefix** match still succeeds while an
  **exact-equality** match on the whole message no longer does. That is
  announced here rather than treated as internal because a consumer outside this
  repo could be doing the latter. Match the class, not the text.

  ## Also fixed: a cold-start WAL race

  `PRAGMA journal_mode = WAL` takes an EXCLUSIVE lock, and `PRAGMA busy_timeout`
  does not cover that acquisition. Two `rundown` invocations racing to create
  the database on a fresh project could leave one dead with
  `database is locked`, reported as a false "Native SQLite is unavailable"
  diagnosis. The conversion is now retried on `SQLITE_BUSY` under the driver's
  own bounded budget. A genuine non-WAL fallback still refuses immediately,
  without consuming the budget.

  A note on which faults produce which code, since the two are easily confused:
  a non-WAL journal mode reaches `RD-306` only when SQLite **answers** the
  pragma with the mode it kept instead of failing. A read-only database file or
  directory does not do that — it fails the pragma outright and surfaces as
  `RD-307`. Reach for `chmod` on `RD-307`, not on `RD-306`.

### Minor Changes

- a350173: # A refused already-terminal chain cleanup is no longer reported as
  success

  The bare `complete` / `stop` path reports `already_terminal` when the resolved
  inline-cascade root was already terminal on entry. Such a run has no terminal
  state write left to make, so the fenced chain release is the _only_ effect the
  command owes: it drops the chain out of `session.defaultStack` and revokes the
  descendant claims.

  Two of the three call sites of `SessionService.releaseAlreadyTerminal`
  discarded that release's answer. Both checked only that the envelope was
  `committed` and then returned `already_terminal` regardless of the value
  inside it — so a committed `claim_rotated` or `determination_lost` (the fence
  refusals, which commit _nothing_) was silently dropped. The whole inline chain
  stayed targeted with its descendant claims un-revoked, and the caller was told
  the command had succeeded. On the capture-time arm the outcome was worse than
  misleading: that arm's aggregate returns write-free, so on a lapsed fence
  nothing at all happened for the command — no force, no release — yet the
  result was byte-for-byte a clean teardown.

  The rotation window is reachable in practice, not just in tests: run control
  is re-minted for a resumed inline child, and a concurrent `rundown prune`
  removes claims for pruned children. `determination_lost` is not an authority
  question at all — an _ambient_ caller with no claim can hit it when the root
  is pruned between plan resolution and the release transaction, and was then
  told `already_terminal` for a run that no longer exists, at exit 0.

  The disposition is now part of the outcome. The `already_terminal` member of
  `LifecycleTerminalOutcome` carries a required
  `cleanup: AlreadyTerminalCleanup` — `released`, `not_attempted`, or `refused`
  with the fence refusal passed through as itself. Being required is the point:
  dropping it is a compile error rather than a review finding, and the
  aggregate's generic is narrowed to a `cleanup`-free outcome so the
  `beforeEffect` boundary — which runs before the release is attempted and
  genuinely cannot know the answer — cannot assert one.

  `not_attempted` also closes a pre-existing blind spot of the same shape: an
  unauthorized bearer's cleanup skip was just as invisible in the outcome as the
  new refusals, and now reads as its own disposition.

  CLI behaviour changes for the refused arm only. `rundown complete` /
  `rundown stop` now render a refused cleanup as an error envelope with a
  non-zero exit — `CLAIMED_RUNBOOK_UNAVAILABLE` for a rotated claim,
  `RUN_TARGET_UNAVAILABLE` for a lost determination. Both are permanent for the
  presented authority, so neither uses the `CONCURRENT_MODIFICATION` "Retry."
  vocabulary, which would be a lie for a claim that can never be authority again
  or a run that no longer exists as resolved. `released` and `not_attempted`
  keep the previous idempotent exit-0 `RUNBOOK_NOT_RUNNING` rendering.

- fb67bab: Refuse a caller/target claim-bearer divergence instead of authorizing
  as the target (#613).

  `RunbookLifecycleCommandService.runTransition`, `runTerminal`, and
  `resolveRunNavigation` took caller evidence and a target selector as
  independent inputs, derived authority from the **target's** verified claim,
  and silently ignored a mismatch. A claim id carries its own live secret
  segment, so naming one is an act of presentation rather than mere selection:
  the two fields are one fact. Each seam now reconciles them at entry, before
  resolving anything from the claim, and refuses with the new
  `CLAIM_BEARER_MISMATCH` code.

  **Behaviour change for programmatic consumers.** No `rundown` CLI path can
  produce this refusal — `--claim-id` populates both the evidence and the target
  at all three call sites, so they cannot disagree. A consumer driving the
  exported core seam directly, and populating the two fields independently, will
  now receive a `claim_bearer_mismatch` refusal where it previously succeeded.
  That path was always authorizing on authority the caller had not demonstrated
  it held, so the refusal is the fix rather than a regression — but it is
  observable, hence the minor bump rather than a patch.

  `CLAIM_BEARER_MISMATCH` is registered in `CLISymbolicErrorCodeValues` and
  `CLIErrorCodes`, so error envelopes carrying it validate against the published
  `--schema` output. It is deliberately distinct from `ACTOR_CONTEXT_REQUIRED`,
  whose remediation ("pass `--claim-id`") would misdiagnose a caller that
  already presented one.

- 271b92b: # Permanent refusals reach the operator as themselves, not as
  TOKEN_NOT_FOUND or RD-999

  Two refusals that were fully diagnosed inside the codebase arrived at the
  caller wearing a code that named something else.

  ## `rundown claim` collapsed four permanent refusals onto `TOKEN_NOT_FOUND`

  `claim` distinguishes `token-not-found`, `parent-missing`, `parent-ended`, and
  `delegation-removed` correctly and then rendered all four as
  `TOKEN_NOT_FOUND`. Three of them are not about the token — it was found, and
  it was valid — so the holder was sent to check the one thing that was not
  wrong. Two are caused by a concurrent actor, the category that must be passed
  through as itself.

  Worse, two of them disagreed with core about the same fact. `claim` re-reads
  the parent before preparing the child, so an ended parent (or a delegation
  that has left the parent's step) is seen by that pre-read as often as by the
  claim transaction — and core's in-transaction `classifyDelegationLiveness`
  reports both as `DELEGATION_SUPERSEDED`. Which code a claimer received
  depended on where in that window the call landed.

  Core is now the single classification owner for all three:

  - `parent-ended` and `delegation-removed` report `DELEGATION_SUPERSEDED`, the
    code core already reports for `parent-ended` / `cursor-advanced` /
    `token-reissued`, and the code `docs/reference/cli.md` already documented
    for a parent that has "ended". The envelope names the specific fact first
    (`lifecycle`, `stepId` in `details`) and then carries RD-825's own no-retry
    instruction verbatim from the registry.
  - `parent-missing` reports the new `PARENT_RUN_MISSING` — the sibling of
    `CHILD_RUN_MISSING` at the other end of the same linkage, matching the
    `parent-unreadable` corruption signal core's classifier produces. Its
    recovery is `rundown prune` and a restart from source, not a report to the
    orchestrator.

  `TOKEN_NOT_FOUND` now belongs to the one reason that is about the token.

  ## A diagnosed cursor mismatch arrived as RD-999 "Unknown error"

  Core refuses a persisted completion that is not for the active cursor with a
  typed `target_mismatch` carrying its own message. Both consumers re-threw it
  as a bare `Error`: the inline parent-advance callable and the execution loop.
  The throw unwound past the frontend's renderer and past `output.flush()`, so
  the buffered parent stream was discarded, the reason was dropped at the throw,
  and the operator was told "Unknown error" — an envelope that says nothing was
  diagnosed, for a permanent condition whose only implied remedy is a retry that
  cannot work.

  The refusal now travels as data, the shape the neighbouring linkage-cycle trip
  already uses:

  - `AdvanceInlineParentOutcome` gains a `refused` arm carrying an
    `InlineParentAdvanceRefusal`, and `InlineUpwardPropagationResult` /
    `TerminalUpwardPropagationResult` gain `advance-refused`. The seam performs
    no release and no recursion on it, because nothing was applied.
  - The CLI adapters and `rundown collect` render it through
    `emitAdvanceRefusalDiagnostic` before their flush, then collapse it onto the
    pre-existing fail-closed `blocked`.
  - The execution loop emits a coded `ERROR_OCCURRED` plus a positioned
    `RUNBOOK_STOPPED` and takes its terminal release, matching the three
    frontier refusals beside it — so the refused run no longer strands on the
    session stack.

  Both report the new `COMPLETION_TARGET_MISMATCH`, exported from core as
  `COMPLETION_TARGET_MISMATCH_CODE`. It names the condition rather than the
  command, so the two paths cannot describe the same fact differently.
  `rundown collect` keeps `COLLECT_OPERATION_FAILED`: that surface reports the
  collection that failed, not the cursor fact underneath it.

- 7755171: # `rundown collect` emits the same `STEP_ENTERED` as `rundown run`

  Entering substep `1.1` via `rundown run` produced a `STEP_ENTERED` carrying
  its description and prompt. Entering the same substep of the same runbook via
  the RETRY re-entry `rundown collect` drives produced one carrying neither. Two
  functions built the payload's `StepEntryMetadata` and they disagreed: the CLI
  execution loop rendered every field, and the collection service hand-built
  ids, position, name and flags with every rendered field absent. All four are
  optional on the type, which is what let the disagreement compile.

  The collect path now enters through the same core seam the loop does. The
  hand-built entry is gone, along with the Stryker equivalence annotations that
  existed only because half the fields it built were never observed.

  Three assertions flip with it, each pinned by #816 against the old behaviour:

  - The rendered fields. `description` and `prompt` are present on the collect
    payload, end to end, and equal to the run payload's for the same unit.
  - `prompted`. The collect path read `!!state.prompted` alone; it now composes
    the persisted flag with the step kind, so a prompted-FOR step reports `true`
    on both paths.
  - `substepId`. It came off the raw cursor while `isSubstep` came off the
    resolved unit, so a cursor naming no live substep produced a populated
    `substepId` beside `isSubstep: false`. Both answer one question and both now
    come off the resolved unit — which matters beyond tidiness, because the
    frontier seams gate credential disclosure on `isSubstep`.

  **The fenced frontier seam sheds its `entry` parameter**, as its unfenced twin
  already had. `prepareReEntryFrontierConsume` derives the substep question from
  the state it holds and returns the projected bearers rather than an entry, so
  there is no longer any route by which a caller can hand either seam an entry
  that disagrees with the run.

  **Two guards are deleted rather than left unreachable.**
  `deriveStepEnteredEffect` refused an entry whose `stepId` / `substepId`
  disagreed with the snapshot. Those existed because the entry was a parameter;
  with one producer that reads the cursor and the snapshot off the same
  `RunbookState`, the mismatch is unrepresentable.
  `RunbookActorService.observeExecutionUnitEntry` goes with them — its last
  caller was the collect path — and `StepEntryMetadata` becomes a local passed
  between two core functions rather than a parameter of anything.

  **A new failure surface, named.** A collect that has committed can now fail to
  RENDER the entry its bearers ride on — typically a `--helpers` helper raising
  — where before it emitted a thinner event that needed no rendering. Nothing
  recovers the bearers (the consume is durable, so a retry answers the
  idempotent no-op), so the collect still rejects rather than reporting a
  phantom success with an empty observation list. It rejects with a code of its
  own, `DELEGATION_FRONTIER_DISCLOSURE_FAILED` (RD-833), instead of escaping
  bare as RD-999 "Unknown error" — an envelope that cannot carry this
  condition's recovery, which is "fix the helper, then re-delegate". A render
  refusal that is `InvalidRunbookStateError` keeps its own class, so the CLI's
  RD-309 arm still prints finish/stop/prune for a run that cannot describe
  itself.

  Bearer-disclosure ordering is unchanged and still asserted: the commit lands
  before the entry is derived, so a refused transaction consumes nothing and
  discloses nothing.

  **The persisted-snapshot guards are now typed too, and RD-833 depends on it.**
  `assertFreshSnapshotValue` and `compileMachineFromState` refuse an unreadable
  `snapshot.value`, a transient parent-entry state, a cursor naming a step the
  runbook no longer declares, and a missing `frontmatterOutputs` — all one run's
  corrupt persisted state, and every message already spelled RD-309's
  remediation ("Prune invalid runbook state and restart execution"). They threw
  a bare `Error`, which reached the CLI as RD-999. They now raise
  `InvalidRunbookStateError` with a typed reason, which is what keeps them off
  RD-833: without it, a collect whose committed target carried an unparseable
  `stateValue` would have told the operator to fix a helper and re-issue
  delegations when the real recovery is prune/restart. Every other caller of
  those guards gains the RD-309 envelope with them.

  One narrowing worth knowing. The artifact-path projection used to fall back to
  `WORK_DIR` when a run carried no `WorkPath`, while the render context the same
  entry expands helper paths against refused a missing `WorkPath` outright — so
  the fallback could only ever produce an entry whose artifact paths and helper
  paths named different roots. There is one read now, and a run with no
  `WorkPath` is refused as corrupt persisted state on both paths.

- 13de29a: # Enter an execution unit through core, not by rendering it in the
  CLI

  The CLI execution loop used to render the unit it was about to enter — merge
  effective variables, build the step frame, pick which expander applied to
  which field, assemble a `StepEntryMetadata` — and then read its own rendered
  command back out to decide what to do next.
  `expandedCommandCode === undefined` was the loop's control-flow signal for
  "nothing to run". Rendering precedence is a language-level concern the spec
  owns, so it belongs behind the machine (#799); `undefined`-as-signal is a
  missing type.

  `RunbookActorService.enterExecutionUnit({ state, steps })` now does all three
  — render, observe, classify — and returns `ExecutionUnitEntry`, a three-arm
  union:

  - **`awaiting`** — nothing for this process to run. One arm for the three
    conditions the loop used to spell out itself: a prompted run, a prompted-FOR
    step, and a unit that declares no command.
  - **`runnable`** — carries a `RenderedUnitCommand`: the expanded code, its
    display projection, and the `RD_*` environment for the child process.
  - **`inline-launch`** — carries the one-shot intent the machine prepared.

  The loop sends state and steps and reads back a classified entry. It renders
  nothing, and it derives exactly one fact for itself — whether the cursor is on
  a substep — because the missing-deriver authority precondition has to answer
  that before any entry exists.

  **The command is one value, and that is the point.** The string announced in
  `STEP_ENTERED.commandCode` and the string handed to `EXECUTE_COMMAND` come
  from one expansion, so a non-deterministic `--helpers` helper cannot make a
  runbook run something other than what it announced. That property used to be
  held by statement ordering in the loop; it is now held by construction.

  The comment that ordering carried was wrong and is not carried forward. It
  claimed artifact-producing helpers "append a manifest row per call, so a
  second expansion would duplicate the entries". `expandLoopVariablesForCommand`
  is synchronous and reduces to `substituteText`, which imports neither `fs` nor
  the manifest module; the manifest append is idempotent by identity anyway. The
  real constraint is helper determinism, which is what the docs now say.

  `RenderedUnitCommand` is nominally branded — tier 1 of the doctrine in
  `effective-vars.ts`, a `declare const` `unique symbol`, minted only inside
  `deriveExecutionUnitEntry`. Tier 1 is right here because the record is
  consumed by typed functions and never round-trips through JSON:
  `EXECUTE_COMMAND` targets `__execute-command`, whose `invoke.input` reads the
  event with no `assign`, so a rendered command never reaches persisted context.

  The brand is load-bearing rather than decorative, and two things keep it that
  way. `RenderedUnitCommand` is **not** re-exported from `@rundown-org/core`, so
  outside core the type cannot be named — and a type that cannot be named cannot
  be asserted to, aliased, or reached through a namespace import. Inside core,
  where a relative import puts the name back in scope, a type-aware ESLint rule
  (`local/no-rendered-unit-command-cast`,
  `eslint-rules/no-rendered-unit-command-cast.mjs`) bans every assertion that
  can mint one. Tier 1 means the assertion IS the mint, so the set of assertion
  SYNTAXES is the whole surface — but a selector that matches syntax has to
  enumerate every spelling, and an import rename
  (`RenderedUnitCommand as Local`) produces a spelling no enumeration
  anticipates. The rule instead resolves the asserted-to TYPE through the
  checker and walks its symbol, base types, and union/intersection members, so a
  rename, an alias two hops away, or an interface that inherits the brand all
  resolve to the same declared symbol and get caught the same as a direct cast.
  `scripts/__tests__/eslint-brand-cast-guard.test.mjs` lints one committed
  fixture per laundering route through the real config, because a bug in the
  rule's type resolution matches nothing and otherwise reads as passing. The
  fixtures are real `.ts` files under
  `packages/core/__tests__/fixtures/brand-cast/` — a type-aware rule needs
  ESLint and the checker to be reading the same bytes, which `lintText` against
  a borrowed `filePath` does not guarantee, and a file this test writes and
  sweeps is visible to everything else that reads the working tree while it
  exists. Separately, the CLI, MCP and plugin `src/**` may no longer import
  `buildStepVariables`, `expandLoopVariables`, `expandLoopVariablesForCommand`,
  or `deriveExecutionUnitEntry` from core at all.

  **The entry seam's internals came off the public barrel** on the same
  reasoning. `deriveStepEnteredEffect` used to carry two cursor-mismatch guards,
  refusing an entry whose `stepId` / `substepId` disagreed with the snapshot;
  they are deleted because the entry now has exactly ONE producer, which reads
  the cursor and the snapshot off the same `RunbookState`. That argument only
  holds while a front end cannot reach the deriver with a hand-built entry, and
  a wildcard `export * from './execution-observation.js'` was putting the
  deriver, `StepEntryMetadata` and `StepEntryObservationInput` on
  `@rundown-org/core` without any file naming them. The barrel names its exports
  now.

  **`hasCommand` is now a field on the entry, derived from the parsed unit.** It
  used to be computed as `commandCode !== undefined` inside
  `deriveStepEnteredEffect`, which made a payload flag an accident of which
  builder produced the entry — the collect-side builder renders nothing, so
  every entry it produced reported `hasCommand: false` regardless of the unit. A
  command that renders to the empty string is now correctly `hasCommand: true`.

  **Both re-entry frontier seams shed their `entry` parameter.** Each read
  exactly one field off it — `isSubstep` — and both now derive that from the
  state they already hold, through the same `resolveCurrentExecutionUnit` the
  entry seam uses. A caller-supplied entry was the wrong shape for it anyway:
  the field describes the cursor, so taking it from the caller let an entry
  describing one cursor decide a question about another.

  The unfenced seam (`projectAndConsumeReEntryFrontier`) enters through
  `enterExecutionUnit` with the verified bearers attached, and its `projected`
  arm returns the whole classified entry rather than bare observations, so the
  caller gets the same classification on the re-entry path as on an ordinary
  one. The ordering guarantee is untouched: the consume still commits before the
  entry is returned, so a failed consume discloses no bearers. The fenced twin
  (`prepareReEntryFrontierConsume`, which `rundown collect` drives) returns the
  prepared state and the projected frontier, leaving the commit and the
  disclosure to the caller's transaction — `RunbookCollectionService` enters
  through `enterExecutionUnit` after its commit lands.

  **`enterExecutionUnit` is declared `async`.** Its body is synchronous today,
  but three refusals run before the derivation returns — the snapshot freshness
  gate, the machine compile, and the render itself — and without the keyword all
  three threw in the CALLER's tick rather than rejecting the promise the
  signature advertises. A caller that attached `.catch(...)` to the returned
  promise, or collected the call in `Promise.all`, observed none of them.
  `await` callers are unaffected.

  **Behaviour notes.** Helper path containment now resolves against
  `manager.cwd` rather than the `cwd` argument threaded into the loop — the
  canonicalised directory the actor service already used for artifact path
  projection, so the two can no longer disagree. (The CLI always passes
  `process.cwd()`, which Node returns already resolved, so the two values are
  identical in production; the canonicalisation only bites a caller that
  supplies a symlinked path, and containment wants the resolved one anyway.)

  Three refusals are now typed `InvalidRunbookStateError` rather than bare,
  which is what routes each onto the CLI's existing RD-309 finish/stop/prune
  recovery rather than an envelope carrying the wrong instruction:

  - A run whose `templateVars` carry no string `ContextId` or `WorkPath`
    (`reason: 'missing_render_context'`).
  - A cursor naming a step the parsed runbook does not define
    (`reason: 'cursor_step_not_in_runbook'`, raised by `findStepOrThrow`, which
    now takes the run id for the defect). This one was a live misclassification:
    the collect path wraps any non-`InvalidRunbookStateError` rejection out of
    the entry seam as RD-833, whose recovery reads "fix the helper and
    re-delegate" — the wrong instruction entirely for corrupt persisted state.
  - A persisted row carrying no `prompted` (`reason: 'missing_prompted'`).
    `RunbookState.prompted` is required now and `create` always writes it,
    exactly as `templateVars` already worked, so the `?? false` at each read
    site is gone rather than unreachable. The field decides whether a run
    announces its commands or executes them, and is the value a composing parent
    inherits down into a fresh inline child, so defaulting it silently adapted
    an incompatible row into an executing run.

  **Five branches came out as provably dead** while mutation-testing the new
  module to 100%, and each was a second spelling of a fact the types already
  carried: `currentStep.kind === 'command'` and `currentStep.kind === 'for'`
  (`command` is declared on `Substep` and `StepWithCommand` only, `forClause` on
  `ResolvedStepWithFor` only — both are now structural `in` checks); two of the
  five identity checks in the inline-intent projection (`entry.stepId` IS
  `state.step` by construction, and the entry's `substepId` check subsumes the
  raw cursor's); and an outer `typeof state.snapshot` guard the optional chain
  already answered. The cursor overlay that used to sit in `snapshotForEntry`
  went with them — it existed to satisfy `deriveStepEnteredEffect`'s guards,
  which this work deletes, so nothing read it any more.

  **The #816 divergence is closed rather than characterised.** `rundown collect`
  used to build its own partial entry — ids, position, name and flags, and none
  of the four rendered fields — while the CLI execution loop's builder filled
  all of them, so the same cursor produced two different `STEP_ENTERED` payloads
  depending on which command reached it. There is one builder now and nothing
  left to disagree, so the characterisation assertions are inverted rather than
  deleted: what was `toBeUndefined()` is the rendered value, and what was
  `false` is the composed one. They read the emitted payload, because the
  argument they used to capture is core-private. The end-to-end contrast is
  pinned in the CLI's `integration/step-entered-run-collect-agreement.test.ts`,
  and the two loop-half assertions moved from the CLI's mocked loop onto the
  real derivation in
  `packages/core/__tests__/runbook/execution-unit-entry.test.ts`, asserting the
  same values on the same fixtures.

  Behaviour is otherwise unchanged.

- a903483: # Refuse an occupied delegation as already-claimed, not as a
  retryable race

  `deriveDelegationChildLinkedSubsteps` classified "this delegation is already
  linked to a different child" as `concurrent_modification`. That is a permanent
  condition, not a version race: a delegation names one child for the life of
  the entry, so re-reading can never free it. The misclassification reached the
  user through `rundown claim` as `CONCURRENT_MODIFICATION`, whose message is
  "The parent changed while the delegated child claim was being committed.
  Retry." — a claim that can never succeed, told to retry.

  The derivation now raises a new `already_linked` reason, and the claim
  pipeline maps it to the existing `DELEGATION_ALREADY_CLAIMED` refusal — the
  same no-retry outcome the already-linked re-read path reports for the same
  fact. `concurrent_modification` is unchanged and still names the genuine
  compare-and-swap race; the two reasons stay distinct.

  `PrepareDelegationChildLinkResult` and `PrepareDelegationChildUnlinkResult`
  gain an `already_linked` arm, exported as the shared
  `PrepareDelegationChildLinkRefusal`. Consumers that switch exhaustively on
  `kind` must handle it.

  Until now the misclassification was masked by the `DelegationLock` serialising
  concurrent claims, so the loser re-read and took the already-claimed path
  instead. Fixing it is a prerequisite for retiring that lock (#690).

- 562bd61: # The completion drain releases in the transaction that commits its
  terminal

  A run that the completion drain drove to terminal committed its terminal state
  in one transaction and left the session's targeting structures in another,
  four stack frames later. A process that died in between left a finished run
  the session still resolved to — and nothing heals that: no path removes a
  loadable terminal run, so every later bare command kept selecting it.

  The command fence has never had this gap. It folds its release into the same
  owned commit as the state write, and `collect` does the same through the
  aggregate seam. The drain was the one terminal path still doing it in two
  steps, because it does not run under an execution lease — its whole
  read-derive-write span is one optimistic compare-and-swap, and that seam had
  no way to write the session at all.

  ## What changed

  `RunbookStore.mutateState` now accepts a `releaseOnCommit` derivation, applied
  inside the transaction that performs the compare-and-swap write, after the
  state lands and only on the attempt that commits.
  `RunbookStateManager.mutateStateReturning` threads it through, and
  `applyNextResolvedCompletion` takes a `terminalRelease` that uses it: an apply
  whose prepared state reaches a terminal lifecycle projects
  `{ runId, role: 'addressed' }` before the transaction closes. Either both
  writes land or neither does.

  Ordering inside the transaction matches the fence's, and for one of the
  fence's two reasons: the state write goes first, because it invalidates closed
  delegated claims in that same transaction — a session read before it would
  project onto a claim set the write is about to change. The fence's other
  reason does not carry over. Its owned write clears execution ownership; the
  compare-and-swap only requires `exec_token IS NULL`, which is why the refusal
  below is subsumed rather than relocated.

  The option is release-shaped rather than the free-form session projection the
  owned-commit methods take. This cycle owns exactly ONE run, so the store
  states and enforces the owned-set rule itself instead of trusting each caller
  to restate it. It also makes an empty answer free: the session is read and
  rewritten only when there is something to project, so a caller arms the option
  once for a whole drain and every non-terminal iteration still touches no
  session row — and cannot fail on one either, since a corrupt claim row
  elsewhere in the session is only ever read when a release is actually due.

  ## Atomic projection, not predicted terminality

  Every terminalizing driver arms `terminalRelease`; the inline upward seam owns
  no later cleanup. An armed release is inert on every non-terminal apply, so a
  drain arms it once and lets each transaction decide.

  The trigger cannot be spelled the same way. Whether an apply reaches terminal
  is decided by the transition prepared inside the transaction, long after the
  argument is built, so it is read from the state being committed rather than
  asserted by the caller.

  ## What a caller sees
  - The drain's `done` and `stopped` arms take no second release. Idempotence is
    a safety property, not permission to issue the operation twice.
  - A refused release can no longer downgrade a `'done'` to `'stopped'`, because
    there is no second operation left to refuse: a projection that throws rolls
    the terminal state back with it, so the apply never reports terminal at all.
  - The corrective `RUNBOOK_STOPPED` those arms emitted on a refused release is
    gone with them, and so is the re-read that named its position. Nothing else
    passed a corrective position, so `applyAddressedRunRelease` and
    `releaseTerminalRun` lost that parameter. The drain's cursor-mismatch
    refusal still re-reads the committed cursor for its own stop — that arm
    leaves the run RUNNING and has no transaction to fold into.
  - Two refusals `SessionService.releaseRuns` could return on this path are
    retired rather than relocated. `execution_in_progress` is now unreachable
    because the same transaction's compare-and-swap already requires
    `exec_token IS NULL`, and `recovery_required` because an abandoned run keeps
    its `exec_token`, so the apply refuses before a release is even considered.

  The entry-time terminal checks still release through
  `SessionService.releaseRuns`. An already-terminal run has no state write to
  fold a release into; fencing that one against captured authority is #734.

  ## Inline progression uses the same atomic boundary

  The inline parent-advance drain also arms `terminalRelease`. If it reaches
  terminal, parent state and addressed release commit together; the upward seam
  then reloads and continues progression without a standalone release.
  Re-entrant flow-back returns an ownership-neutral handled/blocked status so an
  enclosing frame stands down without losing failure severity.

  Closes #794. Part of #781.

- f504fe9: # Re-derive a delegated child's initial link so a lost claim race is
  permanent, not retryable

  `rundown claim` derived the parent link for a delegated child **outside** the
  transaction that commits it: `captureRunAuthorityState` read the parent at
  version _v_, `prepareDelegationChildLink` derived against _v_, and
  `claimAndInitialLink` fenced the write on _v_. When a second claimer of one
  token captured before the winner committed, the fence saw a moved version and
  refused `concurrent_modification` — surfaced as `CONCURRENT_MODIFICATION`,
  whose message is "Retry." The delegation was in fact permanently taken, and no
  retry could ever succeed. A bare version mismatch carries no reason for the
  move, so only re-deriving can tell the two apart.

  The claim pipeline now re-derives capture → prepare → commit while the commit
  keeps losing, on the store's own optimistic budget (`DEFAULT_MUTATE_ATTEMPTS`
  attempts, `mutateBackoffMs` jittered pacing — both now exported from
  `@rundown-org/core` so the budget has one definition). A loser re-derives
  against the row the winner committed and reports the permanent
  `DELEGATION_ALREADY_CLAIMED`. Only the commit's `concurrent_modification` is
  retried; every preparation refusal is permanent and returns immediately.
  Exhausting the budget still reports `CONCURRENT_MODIFICATION`, which by then
  is a genuine sustained race rather than a guess.

  The refusal also names the right run. `already_linked` now carries
  `occupyingChildRunId` — the child that _holds_ the delegation — and
  `DELEGATION_ALREADY_CLAIMED` reports it. Previously this arm named the
  claimer's own freshly launched child, a run its launch cleanup then deleted.
  On the fresh-launch path that arm was additionally reported as
  `CLAIM_INVARIANT_VIOLATED` (RD-820), blaming Rundown for a race it handled
  correctly; it is now the typed `DELEGATION_ALREADY_CLAIMED`, alongside the
  `parent-missing` and `concurrent-modification` races already treated that way.

  `DelegationChildLinkPreparationError` now takes a discriminated
  `DelegationChildLinkRefusal` payload in place of a bare `reason` string, so
  the occupying child cannot be omitted from the one arm that has one. Consumers
  reading `error.reason` read `error.refusal.reason`.

  Closing this gap was the prerequisite for retiring the `DelegationLock` held
  over `rundown claim`, which #690 has since deleted.

- 981dd79: # Activate an inline child only once its launch is won

  Core's bare inline-child reactivation seam pushed the child onto the session
  before returning the parent for the CLI's loop to drive. That push was
  speculative. The seam matches on a running child whose linkage names the
  parent's current frame, and it does not consult the launch latch — so it
  cannot distinguish an interrupted launch from a live owner mid-launch. The two
  are one process's launch at two moments, and the seam had already activated
  the child by the time the launch span discovered which one it was looking at.

  Only one of the launch span's six outcomes undid it. `already-latched` popped
  the activation back off; `missing`, `inactive`, `superseded`,
  `linkage-refused` and `unrecorded` all returned with the child still targeted
  by a session belonging to a process that had just refused to execute it. The
  CLI also mirrored the store's push decision in a local boolean, read back
  later to decide whether to roll the activation back — a decision derived from
  an unlocked `getActive` that a concurrent push could invalidate before the
  rollback read it.

  The fix is not to undo the push five more times. It is to not make it: the
  seam now activates only on the arm where the launch is already finished, and
  the launch span activates once the latch has told it the launch is its own.
  Four leaking arms stop leaking because there is nothing left to leak, and —
  the part five undo calls would not have bought — an arm added later inherits
  the same property without doing anything. `releaseStoodDownInlineChild` is
  deleted.

  New `SessionService.pushRunbookIfNotActive` replaces the `getActive`-then-push
  pair at both activation sites. It decides "is this run already the top?"
  inside the transaction that acts on the answer and returns which way it went,
  so the launch span rolls back only an activation it performed itself and the
  local boolean is gone.

  That method is deliberately unguarded, matching `pushRunbook`. The session
  ownership preflight refuses on `runs.exec_token IS NOT NULL` alone, and the
  dead-owner probe that reclaims a SIGKILLed owner's lease lives on the
  execution-lease acquisition path, never on a session mutation. The caller this
  exists for is a span finishing a launch whose owner died, and a child
  abandoned mid-execution is precisely the run still holding a lease naming a
  dead pid — guarding the write would refuse `execution_in_progress` on exactly
  the recovery it is part of. Adding a stack entry also takes nothing away from
  a run under execution, which is what the guard protects.

  The `superseded` stand-down also gains the diagnostic its `already-latched`
  sibling has. Both end the turn as `waiting` having written nothing, and a wait
  that never resolves has to be distinguishable from nothing happening.

  The invariant is stated in the seam and in `docs/internal/architecture.md` §5,
  which documented the old contract: the child is activated only by the launch
  span that wins it. It is load-bearing in the other direction too — a winning
  arm that executed a child without pushing would leave it running unactivated,
  and the operator's next bare command would address the parent instead.

- dfdcae8: # Release the inline launch latch on every failed launch span

  `INLINE_LAUNCH_CONSUMED` was the only thing that released the inline launch
  latch, so every exit between winning the latch and consuming the intent left
  it set: a child that would not prepare, a ref that resolved at intent time and
  not at launch time, a consume that threw.

  That is not a crash the liveness probe can recover. The record names a pid
  that is still running, and `classifyInlineLaunchOwnership` deliberately has no
  self-pid exemption — a nested observer inside a live span is also "self" and
  must stand down — so the **same process** re-observing its own failed launch
  stood down against itself. Permanently: nothing ever cleared the record, and
  the diagnostic named the operator's own pid as the process to wait for. This
  is what made the inline stand-down reachable single-process, and why a
  long-lived host — the MCP server, the plugin, the integration harness — could
  strand itself on one bad launch.

  New root-level `INLINE_LAUNCH_ABANDONED` event, the mirror of
  `INLINE_LAUNCH_CONSUMED`. The asymmetry is the point: consumption drops the
  latch **and** the intent, because the launch is over; abandonment drops only
  the latch and keeps the intent, because the launch is not over and the
  surviving intent is exactly what makes it re-observable. Clearing it here
  would trade a permanently-latched launch for a permanently-lost one.

  The event carries the latch record its sender wrote, and the machine releases
  only while the substep row still holds that exact record — owner pid, owner
  start id and instant. `INLINE_LAUNCH_CONSUMED` needs no such gate, because it
  is sent by the launch span itself, in its own control flow, having just
  succeeded. Abandonment is sent from a disposer: best-effort, fire-and-forget,
  running after an arbitrary failure, which is the shape of a sender that may
  have fallen behind the state it is acting on. Ungated, the machine would be
  trusting a rule only the CLI enforces — that nothing but the winner abandons a
  launch — and a second front end would have to rediscover it. The reclaim the
  gate refuses is not one the CLI can reach today (a reclaimer must first prove
  the previous owner dead, and a dead process runs no disposer), which is the
  point: the exactly-once launch stops depending on that being true.

  The CLI holds the latch with `await using`. `latchInlineLaunch`'s `won` arm
  now carries a `ScopedInlineLatch` — an `AsyncDisposable` with `keep()` — built
  by the arm that took the latch, so a `won` the caller could receive without a
  scope, and therefore forget to release, is unrepresentable. `keep()` disarms
  the disposer after a successful consume, which has already released the latch.
  Disposal mirrors `heldLock`: best-effort, idempotent, and never propagating,
  so a failed release cannot mask the outcome of the span it wrapped.

  This is the one place in the launch path a disposer belongs. The latch has an
  owner, an acquire/release lifetime and liveness-based reclamation, and scope
  exit covers the failure paths a hand-rolled release would have to enumerate —
  including the ones a later change adds. The session activation deliberately
  does not use one: its undo is right on failure only, so a forgotten `keep()`
  there would pop a running child on the common path.

  Releasing on failure does not reopen the exactly-once hazard. The latch is
  still taken inside the compare-and-swap, so two observers cannot both win it;
  and either the span failed before creating the child — `startRunbook` deletes
  a run it created on every failure path through `afterStarted` — or the child
  exists with matching linkage and the surviving intent still names it, so the
  next observer reads `unlatched` with an `existingChild`, wins, and adopts
  rather than creating a second run. The loser of a genuine race still reports
  `already-latched`, which is permanent and answers `waiting`, never
  `concurrent_modification`.

  Covered end to end by an integration test that fails a launch past the latch
  and then recovers it in the same process — `runCliInProcess` shares this pid,
  so the second gesture is exactly the self-stand-down — and finally performs
  the launch once the child's missing input is supplied.

- 1f591ef: # Give the inline-launch latch its own interface

  The latch that makes an inline child launch exactly-once was a private
  function inside a 2,100-line CLI service. That is not a style complaint: the
  module had no seam of its own, so its test surface fell back to the package
  boundary beneath it, and the only test claiming to exercise contention mocked
  `@rundown-org/core` wholesale and drove a second observer by re-entry from
  inside the first's launch span. A sequential implementation passed it. The
  exactly-once property — the one thing stopping two observers racing a bare
  `INSERT INTO runs` for the intent's fixed child run id — had never been tested
  against a real store.

  `latchInlineLaunch` now lives in `services/inline-launch-latch.ts` with the
  linkage classification, the ownership read and the compare-and-swap cycle
  behind it: the semantic intent plus its injected dependencies in, one outcome
  union out. Contention is driven through that interface — two state managers
  over one real SQLite store, each held inside its build callback until both
  have read, so the commit that lands second is genuinely stale. Exactly one
  observer wins, the loser stands down naming the live owner, and one child run
  is created.

  Three changes to the interface itself, none of them behavioural:

  - The outcome is one union. `Promise<InlineLaunchLatch | null>` gained a
    `missing` arm, so "may this launch proceed, and if not, why not" is answered
    in one value a caller can narrow exhaustively rather than partly through a
    nullable second channel. The caller still routes `missing` and `inactive` to
    the same refusal, deliberately — a run that vanished mid-launch is no more
    launchable than one that ended.
  - The intent is the only semantic argument. `latchInlineLaunch` still receives
    its injected dependencies — `manager`, `actorService` and `steps` — but the
    parent run, the child run id and the linkage no longer travel beside the
    intent, because all three are projections of it and accepting them
    separately made "an intent and a child id that disagree" representable. Both
    call sites derive the linkage through one exported
    `inlineLinkageFromIntent`.
  - The persisted-intent shape check is core's, not a CLI copy.
    `isInlineLaunchIntentWithoutParentEntry` is now re-exported from
    `@rundown-org/core`; core drives it from a field-guard map keyed by
    `keyof InlineLaunchIntentWithoutParentEntry`, so the runtime check breaks
    compilation when the intent grows a field — a property the hand-rolled `&&`
    chain in the CLI would have lost the first time that happened.

  Also closes a second gap of the same kind at the run-start `afterInit` cycle.
  Its contention test injected the interleaved write before the compare-and-swap
  opened, so no losing attempt was ever created; the added variant lands the
  write inside the cycle and pins that the derivation re-runs against the
  committed row and the unrelated substep survives.

- 526ea44: # Derive the OUTPUTS scope behind the state machine, not in the CLI

  The CLI used to decide which OUTPUTS an execution unit captures and where
  those channels live, then ship both conclusions to the machine on
  `EXECUTE_COMMAND`. `deriveOutputScope` and `extractUnitOutputs` are gone from
  `packages/cli/src/services/execution.ts`; `outputScope` and `nakedOutputs` are
  gone from the event. Core now derives both inside the `commandExecActor`
  invoke-input closure. `commandExecActor` itself is untouched — only the source
  of its input changed.

  Every input to that derivation was already machine-owned, and OUTPUTS capture
  is Category B by name in CLAUDE.md's side-effect table, so nothing external
  had to move with it. The two halves enter through different doors, which is
  the whole point of the placement: `nakedOutputs` is **compile-time-bound** —
  which names a unit captures is fixed by the parsed runbook, so the leaf-state
  builder resolves it once and closes over it — while `outputScope` is
  **event-time-bound**, because its iteration tier comes from `context.forStack`
  and changes per FOR iteration, so it is read from context at fire time. This
  is the same split `buildArtifactResolveInput` already applies one function
  away in `compiler.ts`, for the sibling ARTIFACTS directive over the same
  `forStack`; core carried two parallel derivations of one concept and drove
  only one of them from the machine.

  The scope is now built from the leaf state's own `stepName`/`substepId` rather
  than from a cursor the sender reports, which closes a real gap: a persisted
  `substep` naming a substep that no longer exists on the step used to fall back
  through `resolveCurrentExecutionUnit` to a step-level scope, while the machine
  sat wherever the machine actually sat. A leaf state exists only for a substep
  the compiled runbook defines, so the position and the scope can no longer
  disagree.

  Core gains `deriveOutputScope(stepId, substepId, forStack)` from
  `output-channels.js`, beside the `OutputScope` type it constructs, and
  `extractUnitOutputs(step, substepId)` from `execution-units.js`, beside
  `resolveCurrentExecutionUnit`. Both drop the CLI versions' separate
  `isSubstep` boolean: a defined `substepId` **is** the substep tier, so the two
  can no longer be passed in disagreement, and the two test cases that exercised
  the contradictory combinations are unrepresentable rather than deleted.

  Two mutants survive on the leaf builder's `owningStep === undefined` guard.
  They are equivalent, not a coverage gap: `config.stepName` always names a step
  in `steps`, so the arm is unreachable, and the guard mirrors the shape the
  adjacent `needsIteration` line already uses on the same variable. The two
  mutants on that line that do encode real behaviour are killed by
  `compiler-command-exec.test.ts`.

  No new source-text guard accompanies this. The three `readFile`-plus-regex
  tests in the CLI exist because those seams cannot state their invariant in
  types; this one now can — the event fields are gone, so a re-added CLI
  derivation has nowhere to send its result and fails to compile.

- 68c59ec: # Move CURRENT_SCHEMA_VERSION, and pin the persisted run-state shape
  to it

  `CURRENT_SCHEMA_VERSION` sat at `1` while the persisted run-state shape gained
  a required field three separate times: `StepInlineChild.startedAt` (#746),
  `StepInlineChild.started` replacing it (#772), and `RunbookState.prompted`
  (#827). Nothing connected the shape in `schemas.ts` to the version in
  `runbook/persisted-state-guards.ts`, so nothing failed when the two drifted
  apart (#775).

  ## What actually breaks when the shape moves and the version does not

  Measured on `main` against a run persisted mid-inline-launch on a pre-#772
  build (`inline.startedAt`, no `inline.started`):

  - `RunbookStateManager.load` → `InvalidRunbookStateError` with
    `reason: 'schema_validation_failed'`. Classified correctly, and
    `finish`/`stop`/`prune` clear it.
  - `RunbookStore.readRun` — the in-transaction reader behind every
    `ctx.readState`, and so behind `rundown stash` / `pop` — → an unclassified
    `ZodError`. That is neither of the classes `isRecoverableActiveStackError`
    accepts, so it reaches the CLI as RD-999 "Unknown error" and a `--claim-id`
    bearer cannot finish, stop, or prune out of it. Tracked as #828, together
    with the same escape for a same-version parse failure (corruption, a
    hand-edited `state_json`) — a distinct, pre-existing gap in `readRun`'s bare
    `.parse()` that a version move does not close on its own, and is
    deliberately not fixed here.

  Moving `CURRENT_SCHEMA_VERSION` to `2` would route both readers onto the
  version-gate's `invalid_schema_version` / RD-309 before either reaches its
  parse, closing the `readRun` escape for this specific trigger. **We chose not
  to move it.** Per CLAUDE.md § Active Development Stance, no
  `.rundown/rundown.db` outside a local clone or CI run holds state worth
  protecting with the nicer error path, and the documented hard reset — delete
  the file — clears a stuck run the same as any other. The constant now stays
  `1`; the fixture below is recorded against the shape as it stands today, not a
  new epoch.

  ## The fixtures were the reason nobody noticed

  Every fixture wrote `schemaVersion: 1` as a literal, so a stale constant could
  not break anything, and "foreign version" fixtures wrote `schemaVersion: 2` —
  a literal the constant could one day reach and silently turn into valid
  current state, asserting nothing. Both are now derived:
  `CURRENT_SCHEMA_VERSION` for state meant to be readable,
  `CURRENT_SCHEMA_VERSION + 1` (as `FOREIGN_SCHEMA_VERSION`) for state meant to
  be refused. The constant is barrelled from `@rundown-org/core` so front-end
  fixtures can name it too.

  ## The shape is now pinned

  `packages/core/__tests__/runbook/persisted-state-shape.test.ts` renders both
  persisted run-state schemas as a canonical structural string and compares them
  against a fixture named for the version they belong to
  (`__tests__/fixtures/persisted-state-shape/schema-v1.txt`). Change the shape
  and it fails, naming the fields that moved. The remedy is a judgment call, not
  an automatic bump — see `CURRENT_SCHEMA_VERSION`'s TSDoc — and for an ordinary
  shape edit (a required field added or removed, a narrowed constraint) it is to
  re-record this same version's fixture, because the Zod structural parse
  already refuses state an older build wrote either way. Verified by reverting
  the #772 field in `schemas.ts`: the guard fails, and passes again when
  restored.

  It covers narrowing as well as addition — `z.string()` and `z.string().min(3)`
  now render differently, where they previously rendered identically — because a
  tightened constraint changes the fingerprint the same way a new required field
  does. It does **not** cover the opaque `snapshot` blob (declared
  `z.unknown()`, so a machine-context change is invisible to it) or the body of
  a `.refine()`; both are named as hand-decided triggers for an actual version
  move in the fixture README and in `CURRENT_SCHEMA_VERSION`'s own TSDoc, rather
  than left as an implied guarantee.

  No test can force a developer to move a number — rewriting the fixture in
  place would work whether or not a move was warranted — but the moment is no
  longer silent, and the fixture's own doc comments now say what does and does
  not require it.

  `SCHEMA_VERSION` in `runbook/storage/schema.ts` stays at `2` and needs no
  move: it gates the DDL, `state_json` is opaque TEXT to that DDL, and no commit
  has touched the file since before #746. Both constants now carry a note saying
  which half of persisted state each one gates, because they are easy to
  conflate.

- 529c1f5: # Add the ReleaseRole vocabulary, and characterise today's terminal
  claim disposition

  New in core, with no callers yet: `ReleaseRole`
  (`addressed | collateral | discarded`), `ClaimDisposition`
  (`retain-as-terminal-evidence | revoke`), `claimDisposition(role)`,
  `RunRelease` and `projectRunRelease(session, release)`, in
  `packages/core/src/runbook/session-release.ts`.

  The session release primitive currently asks each caller for a **conclusion**
  — `retainClaimsAsTerminal`, a boolean meaning "should this claim survive?" —
  which is domain logic, performed independently at sixteen call sites. Fifteen
  of them agree, and they agree on a rule none of them states: the run the
  caller acted _on_ keeps its claim as terminal evidence, and a run swept up so
  that the addressed run could close does not. The sixteenth omits the option,
  and omission reads as the destructive direction, so a run that reached
  terminal has its run-control claim revoked and its holder is told to re-claim
  a delegation that was never issued.

  The new vocabulary asks for the **fact** the caller already holds instead — "I
  addressed this run" — and owns the conclusion itself, which makes that whole
  bug class unrepresentable: there is no option left to omit. `discarded` is a
  distinct arm rather than a synonym for `collateral` because the destroy paths
  must never be spelled `addressed`, which would retain claims over a run that
  is about to stop existing.

  `claimDisposition` takes the role alone, and a property test pins the
  invariant that makes that safe: a run's disposition depends only on its own
  role, never on ordering and never on the other members of a batch. That is
  what lets it widen to `claimDisposition(role, claim)` later — when a
  run-control claim and a delegated bearer over the same run want different
  treatment — without touching a caller. `projectRunRelease` is synchronous and
  mutates in place by requirement, because several dispositions reach the
  projection through a session callback that accepts nothing else.

  Also adds CLI integration tests characterising today's disposition at the
  resolution seam, so the behaviour change that follows is visible as a one-line
  diff. They record that an already-terminal loop entry resolves `superseded` /
  `claim-rotated`, that a run completing through a fenced command resolves
  `terminal`, and that both survive a process boundary. Nothing calls the new
  vocabulary yet, so no behaviour changes here.

### Patch Changes

- bc12503: Fold inline-composed parent Run Release into the transaction that
  commits each parent terminal, so process death cannot leave a terminal run
  targeted and re-entrant inline flow-back cannot repeat the upward walk.
- 408eb0b: # Guard the `--claim-id` arm against a racing child claim

  `rundown pass --claim-id` / `rundown fail --claim-id` now reach the same
  in-transaction open-delegated-children guard that bare and `--run` transitions
  already used. Previously the claim arm computed its guard flag from the
  resolution shape and excluded claim-shaped resolutions entirely, so it
  committed through the unguarded path: a child claim that landed after the
  resolver's pre-check and before the decisive write was not seen, and the
  parent advanced over an open child.

  This is the arm that matters in practice. On a delegation-exposed run a bare
  mutation is refused `ACTOR_CONTEXT_REQUIRED` and `--run` cannot carry a
  bearer, so `--claim-id` is the only invocation the post-R1 protocol leaves an
  orchestrator — the guarded shapes were the ones it could not reach.

  A delegated-child bearer stays exempt, mirroring the existing pre-check
  exemption: the guard reads `claims WHERE parent_run_id = <target>`, and RD-819
  refuses nested delegation, so that set is provably empty.

  No new error code and no output-schema change: `OPEN_DELEGATED_CHILDREN`
  already surfaced on this arm via the non-transactional pre-check. What changes
  is that a claim committing inside the window is now refused rather than
  silently overwritten. The refusal is write-free — the guard aborts the
  transaction before its first UPDATE, so the run is left usable and is not
  parked in recovery.

  Closes the last of #608's seven atomicity paths.

- 07d998d: # Move the completion recorders off their domain locks

  `RunbookCompletionService.recordManualCompletion` and `recordChildCompletion`
  no longer acquire `CompletionLock` / `DelegationLock`. Each held its lock
  across a read-derive-write span — load state, classify the target, commit a
  patch derived from that earlier read — and the lock existed only to keep
  another writer out of the gap between the decision and the commit. The
  classification now runs inside the `mutateState` build callback, so it is
  derived from the exact version the compare-and-swap commits onto and a writer
  that loses the race re-derives against the committed row and reports
  `duplicate` instead of overwriting it.

  This removes the `DelegationLock → CompletionLock` ordering edge rather than
  documenting it. The child recorder used to record through the manual recorder,
  acquiring the second lock inside the first; it now commits its own patch from
  a shared decision owner, `classifyChildCompletionTarget`, which the fenced
  `prepareChildCompletion` also uses so the two can never disagree.

  Removed public methods, all of which existed only to expose the locked
  recorders' unlocked halves:

  - `recordManualCompletionUnlocked` — the locked wrapper was its only caller.
  - `recordChildCompletionUnlocked` — same.
  - `supersedeDelegationOutcomeUnlocked` — zero callers, and its documented
    contract ("caller must already hold the parent run's DelegationLock") named
    a lock no surviving path takes.

  `RunbookStateManager.updateWithStateReturning` gained an optional `guard`
  write option, matching its `update` / `updateWithState` siblings, so the
  manual recorder can keep forwarding its parent-advance guard.

  Behaviour change: `recordManualCompletion` now throws when the parent run does
  not exist, in every case. It previously threw only when the target classified
  as recordable, and reported `duplicate` for a missing run whose
  caller-supplied state looked already-resolved.

  `drainResolvedCompletions` keeps its `CompletionLock`. Its per-completion
  commit is deliberate — only the first apply carries the parent-advance guard —
  so folding it into a single cycle is a design change, not a refactor.

  Refs #690.

- da52ad6: # Refuse a thenable `releaseOnCommit`, and pin the ordering its
  correctness rests on

  Follow-up to the completion drain's transactional Run Release (#794, merged in
  #839), from a second review round over the same diff.

  `RunbookStore.mutateState`'s `releaseOnCommit` derivation is declared
  `SyncWork`, but only the type half of that contract was enforced. The driver's
  runtime half, `assertSyncWorkResult`, never saw this result: it runs at the
  two driver boundaries, and the outer transaction callback returns the write
  outcome rather than the derivation's value. An untyped caller returning a
  promise therefore left `releases.length` `undefined`, failed the emptiness
  guard, and **skipped the release while committing the terminal state** — the
  exact defect #794 exists to prevent, restored with no error raised. It is now
  guarded, so the refusal is loud and rolls the state write back with it.

  Two properties the design leans on were documented but unasserted, and both
  are invisible to mutation testing because statement reordering is not a
  mutation operator:

  - **An empty release reads no session.** The test named for it observed only
    the session _write_. `readSession` deserializes every active claim, so a
    read hoisted above the emptiness guard would make one corrupt claim row
    anywhere in the session fail _every_ non-terminal apply, on runs unrelated
    to it — while the whole suite stayed green.
  - **The owned-set refusal precedes the session read.** The rollback makes the
    existing state and stack assertions blind to it, so moving the ownership
    check below the projection changed nothing observable, and turned a
    programmer error naming the wrong run into an `InvalidPersistedClaimError`
    telling the operator their database is inconsistent, with a prune recovery
    that cannot fix it.

  Both are now pinned by `readSession` spies, each verified by making the defect
  and watching only the new assertion fail, plus a positive control on the happy
  path so neither can pass vacuously.

  Also corrected: the transaction-ordering rationale claimed the ordering was
  forced by claim invalidation. It is not. `invalidateClosedDelegatedClaims`
  tombstones rather than deletes, and `applySession` builds `persisted` from all
  rows but `stale` from active ones only, so a claim superseded inside the
  transaction lands identically whichever side of the write the session was read
  on. The order is kept for symmetry with `commitOwnedState`, and the comment
  now says so instead of crediting it with an invariant it does not carry. The
  previous round removed a different false clause from the same comment.

  `RunbookStateManager.mutateStateReturning` now takes
  `Pick<MutateStateOptions, 'releaseOnCommit'>` instead of re-spelling the
  signature it forwards whole, and the drain's process-test fixture derives its
  report types from the service's own result union rather than typing them as
  `string`.

- d6fa167: Fence the three already-terminal Run Release arms (claim confirm,
  claim conflict, bare inline chain): the terminal determination and the
  presented claim's authority are revalidated inside the session transaction
  that projects the release, so a claim rotated between resolution and commit is
  refused as `stale_claim` — or, on the bare chain, the cleanup is skipped with
  the `already_terminal` outcome preserved — instead of being released under.
- 1596d86: Fence the inline-launch parent mutation under the parent's claim
  generation (ADR 0002, #714). `rundown run --step` was the one remaining path
  where a same-cwd process could mutate another actor's run with no authority
  check: it resolved the active parent and wrote its `substepStates` under a
  version-only compare-and-swap. The launch now captures the parent's
  controlling run-control claim at linkage determination — refusing before any
  child run is created when no live claim controls the parent — and the substep
  mark commits through a new core seam (`markInlineSubstepLaunched`) whose every
  attempt re-captures under the original claim key and commits
  compare-and-swapped against BOTH the state version and the captured claim
  generation. A parent re-claimed in the window refuses permanently with the new
  registered code `INLINE_PARENT_CLAIM_SUPERSEDED` (RD-834), rolling the child
  back and leaving the parent to its current orchestrator; version contention
  alone still re-derives inside the store's budget. The fence records which
  authority was current, not that the caller held it — the residual same-cwd
  trust boundary is now stated in `docs/reference/security.md`.
- 58fc4f1: # Reclaim an inline-launch latch whose owner is no longer running

  The inline-launch latch is committed before the child run is created — that
  ordering is what makes the launch exactly-once — and it opened a window: a
  process that died between the latch and `manager.create` left the launch
  latched with no child, and every later observer classified itself
  `already-latched` and reported `waiting`. Indefinitely, and with no diagnostic
  naming the condition.

  This is best read as a property the compare-and-latch **dropped**, not a
  hazard it introduced. The `DelegationLock` it replaced already recovered a
  crashed holder, through PID-aware stale reclamation. The fix is to give the
  latch the same property, on the same terms the file locks state: reclamation
  is a liveness decision and **never** an age-based one.

  The latch therefore records who holds it, for exactly as long as it holds it.
  `substepStates[].inline.started` is now `{ at, ownerPid, ownerStartId }` — one
  value rather than a bare timestamp, so a start with no owner to check is
  unrepresentable — and `INLINE_CHILD_STARTED` carries the same. It is
  **released when the launch finishes**: `INLINE_LAUNCH_CONSUMED` clears it in
  the same commit that clears the one-shot intent, which is the lifetime the
  file lock had. A latch that outlived its span would be worse than none at all
  — every later visit to the frame would read a completed launch as one in
  progress, so a re-entry from the same process would find its own live pid on
  the latch and stand down against itself forever, and one from a later process
  would report "reclaiming" a launch nobody crashed out of.
  `classifyInlineLaunchOwnership` (new, exported from `@rundown-org/core`) reads
  it as `unlatched`, `held` or `reclaimable`, over the same `isOwnerAlive` probe
  the execution lease uses. A **start id**, not a bare pid: a recycled pid would
  otherwise read as a live owner and the latch would never be reclaimed. Every
  unknown answers "alive", so a host that supplies no start id degrades to the
  pid-only decision rather than reclaiming on a guess.

  An observer that finds a dead owner takes the launch over, records **itself**
  as the new owner in the same commit — so a third observer finds it held rather
  than reclaiming a launch now in progress — and warns that it did so. An
  observer that finds a live owner stands down with `waiting`, and now names the
  process holding the launch instead of waiting opaquely.

  **A live owner's launch is now left entirely alone, including its child.**
  Previously an observer that found the latch taken still adopted the child run
  if one existed — which was the only sane reading before the owner's liveness
  was knowable, because that state was indistinguishable from a crashed
  launcher. Those are one process's launch at two moments, and taking the second
  over pushed a run its owner was about to execute onto the observer's session,
  consumed the one-shot intent out from under it, and rotated the bearer it
  still held. The crash case is now reached through reclamation instead, so the
  adoption branch runs only when this observer owns the latch.

  Absence of the child run row is deliberately not the signal, and the reasoning
  is worth recording because the cheap fix looks sound: an observer that has
  latched and is still resolving the child runbook presents _exactly_ the state
  a crashed one does. Reclaiming on absence would send both into
  `manager.create` and reproduce the `SQLITE_CONSTRAINT` race the latch exists
  to prevent. Only liveness separates _dead_ from _not there yet_.

  One window is narrowed rather than closed, and is worth stating plainly: a
  launch span that FAILS after latching — an unresolvable child ref, a
  preparation error — reaches no consume, so it leaves the latch set. Its owner
  is alive, so it reports as held for the rest of that process's life; the next
  process reclaims it, where before this change no process ever would. A
  short-lived CLI invocation therefore self-heals on the next gesture.

  Persisted state carrying the old bare-timestamp `startedAt` no longer
  validates. Per the no-migration rule, finish, stop, or prune an affected run
  rather than expecting it to load. Closes #753.

- a6ee531: # Undo a stood-down inline activation with a conditional pop, not a
  pre-read

  Standing down from an inline launch another process owns has to undo the
  session push core's reactivation seam may have made. It did that by resolving
  the stack top with `getActive` and then calling the positional `popRunbook` —
  the #666 check-then-act shape, which `stash` was fixed for and which this path
  reintroduced.

  The two steps read different snapshots. `getActive` is an unguarded
  `loadSession` + `load`; `popRunbook` re-reads the session inside its own
  `BEGIN IMMEDIATE` and pops whatever `defaultStack` ends in **by then**. So a
  run pushed in between is the run that gets popped.

  That is not a leaked activation, which is what the swallowed-error policy on
  this path is licensed for. `projectRunbookRelease` deletes every claim
  controlling the run it removes, and `rundown run` pushes-and-mints atomically
  precisely so a stack entry never exists without its controlling claim — so the
  wrongly popped run loses the run-control bearer its orchestrator is still
  holding, and every later `--claim-id` resolves `missing`. There is no gesture
  that puts it back.

  The arm's own precondition is what makes this reachable rather than
  theoretical: it runs only when a **live** process owns the launch, so a
  concurrent writer is guaranteed, and the default stack is one project-global
  row every `rundown` process in the cwd shares. `mutateSessionGuarded` narrows
  the window — an execution-owned top refuses `execution_in_progress` — but a
  top that is pushed and not yet leased, or never leased, goes straight through.

  `SessionService.popRunbookIfActive(expected)` (new, exported from
  `@rundown-org/core`) decides the whole question inside the guarded transaction
  and removes the run only while it is still the top, returning `popped` or a
  domain `not-active` carrying whatever displaced it. Its affected-run selector
  names `expected` only when `expected` already holds the top, so a mismatch
  degrades to `not-active` rather than to an `execution_in_progress` refusal
  naming a foreign run the call was never going to touch.

  `not-active` carries `activeRunbookId` for diagnosis, and because it is what
  lets a test assert the decision was made against the post-push snapshot; no
  caller renders it today, and both inline sites treat every committed answer
  alike.

  `releaseRunbook` is deliberately not the fix: it filters the id out of the
  stack at **any** depth, so an undo meant as "only if still active" would still
  reach a child a concurrent push has since buried.

  Both inline sites move over — the `already-latched` stand-down and the
  consume-failure rollback, which carried the same two-call shape.

  Not every positional pop, though: the execution loop's terminal `stack-pop`
  still calls `popRunbook()` with the run it means to release in scope and never
  compared. It has no pre-read, so it is not this defect, but it can remove a
  foreign run pushed-and-minted and not yet leased. Tracked separately.

  Pinned by a real two-process race in `session-service.process.test.ts`: with
  the push holding the transaction and the conditional pop contending, the
  previous shape pops the **foreign** run, and the new one declines. Per this
  repo's own note, only a real multi-process test observes this — every
  sequential test stays green either way — so the CLI adds structural assertions
  that the `getActive` + `popRunbook` pair is absent.

- 5e58b8b: # `runExecutionLoop` reads `prompted` off the run, not off a
  parameter

  `runExecutionLoop` took `prompted: boolean` as its fifth argument. Every one
  of its six call sites passed the run's own persisted flag — four of them
  spelled `!!state.prompted` or the equivalent, and the other two
  (`transitions.ts`, `runbook-pipeline.ts`) passed a value core had already
  derived from `Boolean(state.prompted)` or written to the row with
  `manager.create`. The loop loads that same state on its first line.

  So the parameter was never a way to configure the loop. It was a way for a
  caller to disagree with state about a fact state owns, and nothing in the tree
  used it that way. It is gone; the loop derives `prompted` once from the state
  it loads, above the `while`, because the flag is fixed at run creation and
  cannot vary across iterations.

  `launchInlineChildFromIntent` keeps its own `prompted` parameter, and that is
  not the same fact: on the fresh-child branch it is the value the composing
  parent _inherits down_ into a child run that does not exist yet and therefore
  has no persisted flag to read. The resumed-child branch beside it already read
  `!!existingChild.prompted` rather than the parameter.

  Behaviour-neutral prefactor for #799: the entry seam that follows derives
  `prompted` from state, so the parameter had to go either way, and removing it
  first keeps that change to one concern.

  `LifecycleLoopDirective`'s `prompted` field goes with it. It existed only to
  feed that argument from `runSeamTransition`; with the argument gone it is a
  second copy of a persisted flag, and a second copy is a way to disagree. The
  directive now says only whether to run the loop, which is the one thing the
  frontend cannot decide for itself.

- e20b2e2: # Back off between contended `mutateState` retries

  `RunbookStore.mutateState` now pauses between optimistic retries for a
  jittered interval scaled by attempt number (25–50ms × attempt), instead of
  replaying its read-modify-write cycle with no delay at all.

  Without a pause, every writer that lost a round re-read at the same instant
  and they replayed in lockstep: the writer at the back of an N-way queue burned
  one attempt per predecessor, so the 8-attempt budget capped the number of
  _concurrent writers_ rather than the retry _depth_. Twelve concurrent writers
  on one run produced four `concurrent_modification` refusals; they now all
  commit.

  `concurrent_modification` remains a reachable arm — this is still an
  optimistic CAS, not a lock, and sustained contention still spends the budget.
  The added wait is bounded by the budget at roughly 1.4s, inside the 5s
  deadline the file lock this path replaced would have waited, and no pause is
  taken after the final attempt.

  The `build` callback contract is unchanged: it runs once per attempt and must
  stay free of external side effects.

  Precondition for the domain-lock deletion in #690, where these paths lose the
  file locks that currently serialise them.

- 2a6073d: # Undoing an inline-child activation no longer revokes the child's
  claim

  `SessionService.popRunbookIfActive` undid a stack push by calling the general
  release primitive, `projectRunbookRelease`, with no options — so
  `retainClaimsAsTerminal` was falsy and every claim controlling the run was
  revoked. But the operation being undone is `defaultStack.push(id)`, which
  mints nothing and never reads `session.claims`. The undo disposed of authority
  the push never created (#788).

  That was irrecoverable, not merely wrong. The pop's one caller is the inline
  launch rollback in the CLI, reached only when a process reclaims an
  interrupted launch from a dead owner and the intent consume then throws. The
  child at that moment is live, non-terminal, and survives the rollback — the
  next attempt resumes it. But `adoptRunControlClaim` refuses to re-mint once
  that child has issued a delegation, because the replacement could not
  reproduce the credentials. So the child ran unarmed, the machine's
  `actor_context_required` refusal stood permanently, and nothing addressed the
  run again. The holder was not even told the truth about it: a revoked claim is
  tombstoned `superseded` and resolves as `claim-rotated`, a rotation that never
  happened.

  The fix is a new `projectStackPop` beside `projectRunbookRelease`, and its
  narrowness is the guarantee rather than a style choice. It takes the stack
  array alone, not `SessionData`, so it cannot revoke a claim or clear a stash
  slot — today, or after a later edit that forgets why it must not. A release
  policy carried as an option can be omitted, and omission reads as the
  destructive direction; that is the same failure mode the `ReleaseRole`
  vocabulary removes from the sixteen terminal-release call sites, applied here
  by deleting the parameter instead of defaulting it.

  It removes the **topmost** occurrence only. `session_stack` has no uniqueness
  constraint and cannot gain one — an existing session carrying a duplicate
  would become impossible to load, with `prune` as the only recovery, which the
  no-migration rule forbids — so a run can legitimately sit lower in the stack,
  and undoing one push must leave that entry alone. `projectRunbookRelease`
  filters every occurrence, which is right for a release and wrong for an undo.

  The method stays `mutateGuarded`. A stack-only projection issues no guarded
  statement, so `execution_in_progress` and `recovery_required` are now
  unreachable through this path, and the argument for deleting them is strong:
  the preflight refuses on `exec_token IS NOT NULL` with no liveness probe, and
  this method's only caller is the crash-recovery path where the child provably
  holds a lease naming a dead pid — so the guard can only refuse where the undo
  must run, leaving the child pushed after a failed launch. It is held back
  deliberately. Both refusals come from one loop in `mutateSessionGuarded`, so
  the seam cannot keep one and drop the other, and `recovery_required` is the
  arm the symmetry argument covers least well. It wants a stale-lease test and a
  multi-process test, not more argument. This projection is what makes that
  removal a no-op rather than a lossy edit.

- 6be11e7: # Refuse a schema-invalid run row in the loader's taxonomy at both
  readers

  `packages/core/src/runbook/persisted-state-guards.ts` claims its two callers
  "share one order, one taxonomy, and one message by construction rather than by
  convention". That held for the three pre-parse gates and stopped holding one
  line later, at the parse itself:

  - `RunbookStateManager.load` used `safeParse` and reframed a failure as
    `InvalidRunbookStateError` with `reason: 'schema_validation_failed'`.
  - `RunbookStore.readRun` used `stateSchema.parse(raw)`, which throws a bare
    `ZodError`.

  `readRun` is the store's only validating read, so every in-transaction reader
  went through it — `ctx.readState`, and so `rundown stash` / `pop` on both
  their bare and `--claim-id` paths. `ZodError` is neither class
  `isRecoverableActiveStackError` accepts nor an arm `toRundownError`
  classifies, so it reached the operator as RD-999 "Unknown error" carrying a
  schema dump, and `complete` / `stop` / `prune` — which all branch on refusal
  class — could not clear the run it named. That is the exact failure mode the
  gates exist to prevent, surviving one line past them (#828).

  ## What changed

  `parsePersistedRunState` is the structural parse both readers now call, and it
  raises `InvalidRunbookStateError` / `schema_validation_failed` for the run it
  refuses. `loadRun`, `listRuns`, and `readRunWithVersion` no longer document a
  `ZodError` escape, because they no longer have one.

  The two named-field refusals that lived in `load` — `missing_template_vars`
  and `missing_prompted` — moved into `assertLoadablePersistedRun` alongside the
  three gates, so the store reports them by name too. Neither is a new refusal
  at that seam: both fields are required by the schema, so those rows were
  already refused there, just as the unclassified `ZodError`. `load`'s own order
  and messages are unchanged.

  ## What this does not change

  No migration, fallback parse, or default is introduced: a refused row is left
  exactly as persisted, and the recovery path is still explicit user action —
  finish, stop, prune, or restart (CLAUDE.md § State Persistence). The
  population that reaches the parse is unchanged too; only the shape of its
  refusal moved.

- 14dcd01: Fix the re-entry frontier seam's render ordering, deduplicate
  `findStepOrThrow`, let the entry seam accept a caller-precomputed position,
  and correct a misleading comment (code review follow-up on #817/#819/#820).

  - **`projectAndConsumeReEntryFrontier` (core)**: rendering the execution unit
    — which can invoke non-idempotent `--helpers` JS — now happens AFTER
    `DELEGATE_FRONTIER_CONSUMED` commits, not before. Previously a failed commit
    still ran the render's side effects; the next retry re-projects the
    still-persisted frontier and would run them again. The render now runs
    against the committed state, mirroring the pattern `collection-service.ts`'s
    `finishCollection` already used for the fenced twin.
  - **`findStepOrThrow` (core, cli)**: the CLI (`services/execution.ts`) and two
    core modules (`collection-service.ts`, `completion-service.ts`) each carried
    their own copy of this lookup. All three now import the canonical
    implementation from `execution-units.ts`.
  - **`deriveExecutionUnitEntry` (core)**: accepts an optional
    caller-precomputed `position`, used instead of re-deriving one via
    `countNumberedSteps` + `buildStepPosition`. The CLI execution loop already
    computes this value once per iteration for its own error-reporting events;
    it now forwards it to `enterExecutionUnit` instead of paying for the
    identical derivation twice.
  - **`runExecutionLoop`'s `prompted` fallback comment (cli)**: corrected.
    `RunbookState.prompted` and `CreateOptions.prompted` are genuinely optional
    at the type level (unlike `templateVars`, `load()` carries no fail-closed
    guard for a missing one). The fallback is unreachable only because of
    call-site discipline, not because the type forbids `undefined`.

- 23f11b9: Keep running runs targeted when execution refuses without applying a
  terminal transition, and hand inline-parent refusals back as typed data
  instead of reporting a false stop upward.
- 39cb1ac: # An already-terminal chain cleanup no longer strands a still-running
  inline descendant

  `rundown complete` / `rundown stop` report `already_terminal` when the
  resolved inline-cascade root was already terminal on entry, and the fenced
  chain release is then the only effect the command owes. That release named
  **every** member of the resolved chain, marking each non-root member
  `collateral` — which revokes: `projectOne` deletes every claim controlling the
  run and filters it off `defaultStack`.

  On the forcing path that is exactly right. The aggregate's `compute` prepares
  a terminal mutation for every captured member whose lifecycle is `running`, in
  the same transaction that commits the releases, so by commit every member is
  terminal and `collateral` — "swept up so that an addressed run could close" —
  is true of all of them.

  The already-terminal arms force nothing. The root reached terminal on an
  earlier turn, so each descendant's lifecycle is whatever it already was, and a
  descendant that is still `running` was never forced terminal under this root
  by this command or any other. Naming it `collateral` asserted otherwise and
  revoked its run-control claim, dropping a live run off the default stack while
  its holder was mid-execution. This is the case ADR 0001 names — "a refusal can
  release a still-running run even though it committed no terminal transition" —
  against its own rule that such a path "leaves the running run targeted" and
  can never "remove retry authority".

  Reproduced by `rundown stop --claim-id <root's claim>`, which forces only the
  root (the plan walks _up_ the inline chain, so a descendant below the anchor
  is never in `forceOrder`), followed by any later ambient `rundown stop`: that
  resolves the still-running descendant, walks up to the now-terminal root,
  takes the already-terminal arm, and revokes the descendant it never touched —
  while reporting success at exit 0.

  The two already-terminal call sites now build their batch from a separate
  `releasesForAlreadyTerminalInlineChain`, which keeps the root and only those
  descendants that are already `completed` or `stopped`. A still-running
  descendant is omitted from the batch entirely rather than demoted to a gentler
  role: `addressed` would be a second untruth — the caller did not act on it —
  and there is no role meaning "untouched", because a release _is_ the act of
  finishing with a run. The forcing path keeps the original behaviour under the
  name `releasesForForcedInlineChain`.

  Two named functions rather than one with a flag, because what differs is a
  fact about what the command did to each member — the same reason `ReleaseRole`
  is a fact the caller states and not a policy it chooses. A boolean parameter
  can be omitted, and omission would default to the revoking direction.

  No outcome shape changes. `releaseAlreadyTerminal` reports `released` /
  `claim_rotated` / `determination_lost` and never enumerates the batch, and
  `projectRunReleases` returns nothing, so no caller could observe which members
  were named. The only difference is the session that results — which is the
  fix.

- Updated dependencies [2e0b7d7]
- Updated dependencies [2d03652]
  - @rundown-org/parser@2.0.0
