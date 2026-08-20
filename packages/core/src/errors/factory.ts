import { truncateDelegationToken } from '../runbook/delegation-token.js';
import { RundownError, type InvalidRunStateDefect } from './rundown-error.js';

/**
 * Factory functions for creating typed errors.
 * Provides better IDE autocomplete and type safety.
 */
export const Errors = {
  // File/IO
  fileNotFound: (file: string): RundownError => new RundownError('FILE_NOT_FOUND', { file }),

  fileNotReadable: (file: string): RundownError => new RundownError('FILE_NOT_READABLE', { file }),

  stateDirNotAccessible: (path: string): RundownError =>
    new RundownError('STATE_DIR_NOT_ACCESSIBLE', { file: path }),

  // Parse/Syntax
  emptyRunbook: (file: string): RundownError => new RundownError('EMPTY_RUNBOOK', { file }),

  noStepsFound: (file: string): RundownError => new RundownError('NO_STEPS_FOUND', { file }),

  invalidFrontmatter: (file: string, message?: string): RundownError =>
    new RundownError('INVALID_FRONTMATTER', { file, message }),

  syntaxError: (message: string, file?: string, line?: number): RundownError =>
    new RundownError('SYNTAX_ERROR', { file, line, message }),

  // State
  noActiveRunbook: (): RundownError => new RundownError('NO_ACTIVE_RUNBOOK'),

  stateParseError: (file: string, message?: string): RundownError =>
    new RundownError('STATE_PARSE_ERROR', { file, message }),

  runbookCompleted: (file?: string): RundownError =>
    new RundownError('RUNBOOK_COMPLETED', { file }),

  runbookStopped: (file?: string): RundownError => new RundownError('RUNBOOK_STOPPED', { file }),

  incompatibleStateSchema: (foundVersion: number, expectedVersion: number): RundownError =>
    new RundownError('INCOMPATIBLE_STATE_SCHEMA', {
      foundVersion,
      expectedVersion,
      message:
        `found version ${String(foundVersion)}, expected ${String(expectedVersion)}. ` +
        `Any in-flight runs in this database are unrecoverable — delete ` +
        `.rundown/rundown.db and restart your runbooks from source`,
    }),

  // The candidate causes are spelled into the MESSAGE, not left to the code's
  // `description`: the description reaches an operator only through `--text
  // --verbose`, and never appears in the JSON envelope that is the default
  // output. Listing them without asserting one is the whole point — a temporary
  // database and an in-transaction connection reach the same fallback, so naming
  // a network filesystem as THE cause sends an operator on local disk looking in
  // the wrong place.
  //
  // The list must match `WalJournalModeUnavailableError`'s own message, and every
  // entry on it must be a condition under which `PRAGMA journal_mode = WAL`
  // ANSWERS with a non-WAL mode — that answer is the only thing that reaches this
  // code. A read-only file or directory is therefore excluded and said to be
  // excluded: measured on Node 24.18.1 / SQLite 3.53.1 both THROW instead
  // (errcode 8 `SQLITE_READONLY`, errcode 1544 `SQLITE_READONLY_DIRECTORY`), so
  // they surface as RD-307, whose description lists them. Naming them here sent
  // an operator to `chmod` for a fault that cannot produce this error.
  walJournalModeUnavailable: (effectiveMode: string | undefined): RundownError => {
    const modeOutcome =
      effectiveMode === undefined
        ? 'The pragma returned no readable journal mode.'
        : 'SQLite returned the non-WAL mode it kept instead of failing.';
    return new RundownError('WAL_JOURNAL_MODE_UNAVAILABLE', {
      effectiveMode,
      message:
        `effective mode: ${effectiveMode ?? 'unknown'}. WAL mode is required for ` +
        `supported multi-process operation. SQLite still serializes cross-process ` +
        `writers using file locks in rollback-journal mode, but rollback-journal ` +
        `mode does not provide WAL's reader/writer concurrency and is not a ` +
        `validated Rundown deployment mode. ${modeOutcome} This narrows the cause ` +
        `to one of: a ` +
        `filesystem whose VFS provides no shared memory (a network mount such as ` +
        `NFS or SMB is the common one), a temporary database opened with no ` +
        `filename, or a connection already inside a write transaction. A read-only ` +
        `database file or directory is NOT among them — that fails the pragma ` +
        `outright and surfaces as RD-307`,
    });
  },

  // The store-open refusals reach every command that accesses persisted run
  // state, including read-only state commands. Commands such as `rundown check`
  // do not open the store and cannot reach this factory arm. The driver's own
  // message is the only thing that distinguishes a read-only file from a locked
  // database from a missing `node:sqlite`, so it rides in `message` where the
  // default JSON envelope carries it; the code's `description` reaches an
  // operator only under `--text --verbose`.
  stateStoreUnavailable: (detail: string, driverCode?: string, cause?: Error): RundownError =>
    new RundownError('STATE_STORE_UNAVAILABLE', { message: detail, driverCode }, cause),

  concurrentStateModification: (runId: string, detail: string): RundownError =>
    new RundownError('CONCURRENT_STATE_MODIFICATION', { runId, message: detail }),

  // The one post-commit failure a collect can suffer. Spelled with the run id in
  // context so an operator can name the run whose bearers were lost without
  // parsing the message, and with the render failure's own text as `message` so
  // the cause (usually a `--helpers` helper raising) is not swallowed by the
  // envelope.
  // Stryker disable next-line ArrowFunction: undetectable, not uncovered. Every
  // member of this literal is evaluated at module load, so replacing this body
  // with `() => undefined` is a STATIC mutant — jest's module registry has
  // already cached `Errors` by the time the mutant is applied, and the mutated
  // arrow is never the one the test calls. Verified by hand: editing the source
  // to `() => undefined` DOES fail the RD-833 factory test. The two mutants on
  // the same line that Stryker can observe (the code string and the context
  // literal) are both killed by it.
  frontierDisclosureFailed: (runId: string, detail: string): RundownError =>
    new RundownError('DELEGATION_FRONTIER_DISCLOSURE_FAILED', { runId, message: detail }),

  // The recovery is spelled into the MESSAGE, not left to the code's
  // `description`, for the same reason `walJournalModeUnavailable` spells its
  // candidate causes there: the description reaches an operator only through
  // `--text --verbose` and never appears in the default JSON envelope, which is
  // the agent-facing surface. CLAUDE.md requires this condition to "prompt the
  // user to finish or prune"; a prompt that only renders under a flag agents are
  // told never to pass is not a prompt.
  //
  // `detail` is the store's own diagnosis ("invalid schemaVersion", "missing
  // templateVars", "schema validation failed", the legacy-snapshot wording) and
  // is preserved verbatim ahead of the recovery — it is what identifies WHICH
  // run and WHY, and the recovery alone cannot be acted on without it.
  //
  // The prune form names `--inactive` because the bare command cannot clear the
  // run this error is about: an unfiltered `rundown prune` selects completed and
  // stopped runs out of `RunbookStateManager.list`, which swallows the
  // validation failure and skips every invalid row, so the run reaches
  // `prune.ts` only through the invalid-id path gated on `--inactive` / `--all`.
  // The bare form therefore exits 0 having pruned nothing. `--inactive` also
  // discards other orphaned runs — see docs/reference/cli.md's RD-309 row.
  //
  // `defect` carries the same facts as FIELDS. RD-309 is the only 3xx state
  // error scoped to a single run, and it was the only one whose `context` held
  // nothing but `message` — its siblings already do better (RD-306
  // `effectiveMode`, RD-307 `driverCode`, RD-308 `runId`), so a consumer
  // wanting to know which run had to parse English out of `error`. The found
  // schema version is not even in the prose. The values are threaded from the
  // throw site rather than pattern-matched back out of `detail`, which is the
  // shape this exists to remove.
  //
  // None of the defect keys is on `RundownError.formatMessage`'s render
  // whitelist, so this is purely additive: the rendered message is byte-for-byte
  // what it was before the defect existed (pinned in `factory.test.ts`).
  invalidPersistedRunState: (detail: string, defect?: InvalidRunStateDefect): RundownError => {
    const cause = detail.trim();
    const terminated = cause.endsWith('.') ? cause : `${cause}.`;
    return new RundownError('INVALID_PERSISTED_RUN_STATE', {
      ...(defect === undefined
        ? {}
        : {
            runId: defect.runId,
            reason: defect.reason,
            // Omitted rather than emitted as `null` when the refusal is not a
            // version mismatch: an absent key says "not applicable", where a
            // null would claim the row asserts nothing.
            ...(defect.schemaVersion === undefined ? {} : { schemaVersion: defect.schemaVersion }),
          }),
      message:
        `${terminated} Rundown never migrates persisted state, so this run ` +
        `cannot be resumed: finish it with "rundown complete", stop it with ` +
        `"rundown stop", or discard it with "rundown prune --inactive", then ` +
        `re-run the runbook from source.`,
    });
  },

  // Validation
  gotoTargetNotFound: (step: string, substep?: string): RundownError =>
    new RundownError('GOTO_TARGET_NOT_FOUND', { step, substep }),

  invalidStepSequence: (expected: number, found: number, line?: number): RundownError =>
    new RundownError('INVALID_STEP_SEQUENCE', {
      expected: String(expected),
      found: String(found),
      line,
    }),

  // Execution
  engineInitFailed: (cause?: Error): RundownError =>
    new RundownError('ENGINE_INIT_FAILED', {}, cause),

  runbookHasNoSteps: (file?: string): RundownError =>
    new RundownError('RUNBOOK_HAS_NO_STEPS', { file }),

  childRunbookActive: (childId?: string): RundownError =>
    new RundownError('CHILD_RUNBOOK_ACTIVE', { childId }),

  // Command
  invalidStepFormat: (value: string): RundownError =>
    new RundownError('INVALID_STEP_FORMAT', { value }),

  missingRequiredArg: (argName: string): RundownError =>
    new RundownError('MISSING_REQUIRED_ARG', { argName }),

  scenarioNotFound: (scenario: string, file?: string): RundownError =>
    new RundownError('SCENARIO_NOT_FOUND', { scenario, file }),

  // Delegation
  delegationStepNotFound: (step: string): RundownError =>
    new RundownError('DELEGATION_STEP_NOT_FOUND', { step }),

  delegationStepNotCurrent: (step: string, current: string): RundownError =>
    new RundownError('DELEGATION_STEP_NOT_CURRENT', { step, current }),

  delegationSubstepRequired: (step: string, substeps: string[]): RundownError =>
    new RundownError('DELEGATION_SUBSTEP_REQUIRED', { step, substeps: substeps.join(', ') }),

  delegationAlreadyExists: (step: string, message?: string): RundownError =>
    new RundownError('DELEGATION_ALREADY_EXISTS', { step, message }),

  delegationRunbookNotFound: (runbook: string): RundownError =>
    new RundownError('DELEGATION_RUNBOOK_NOT_FOUND', { runbook }),

  delegationRunbookMismatch: (step: string, requested: string, authored: string): RundownError =>
    new RundownError('DELEGATION_RUNBOOK_MISMATCH', {
      step,
      requested,
      authored,
      message: `requested ${requested}, authored ${authored}`,
    }),

  delegationSubstepNotFound: (substep: string, step: string, available: string[]): RundownError =>
    new RundownError('DELEGATION_SUBSTEP_NOT_FOUND', {
      substep,
      step,
      available: available.join(', '),
    }),

  // The three bearer-carrying factories truncate HERE rather than at their call
  // sites. `RundownError.context` is serialised verbatim into the CLI's stdout
  // error envelope (`wrapper.ts` → `details.context`), and the credentials
  // addendum binds redaction to *every* refusal and error envelope. Redacting in
  // the factory closes the class: no caller can reintroduce the leak by passing
  // the raw value, which is exactly how it was introduced.
  invalidToken: (token: string): RundownError =>
    new RundownError('INVALID_TOKEN', { token: truncateDelegationToken(token) }),

  tokenNotFound: (token: string): RundownError =>
    new RundownError('TOKEN_NOT_FOUND', { token: truncateDelegationToken(token) }),

  tokenCancelled: (token: string): RundownError =>
    new RundownError('TOKEN_CANCELLED', { token: truncateDelegationToken(token) }),

  delegationAlreadyClaimed: (step: string, childRunId: string): RundownError =>
    new RundownError('DELEGATION_ALREADY_CLAIMED', { step, childRunId }),

  delegationInFlight: (step: string, childRunId: string): RundownError =>
    new RundownError('DELEGATION_IN_FLIGHT', {
      step,
      childRunId,
      message: `child run ${childRunId} is still linked; run "rundown abort <token> --claim-id <claim_id> --force" before retrying`,
    }),

  delegationReplacementConsumed: (
    step: string,
    reason: 'claimed' | 'cancelled' | 'entry_superseded',
  ): RundownError =>
    new RundownError('DELEGATION_REPLACEMENT_CONSUMED', {
      step,
      // `reason` is a closed discriminant naming which remedy applies, so it
      // rides as a structured key and not only inside the sentence. Like
      // `claimSeenUnreadable`'s `childId` below, it is OUTSIDE
      // `formatMessage`'s fixed key list, so it reaches the agent through
      // `context` (the CLI envelope's `details.context`) and leaves the
      // rendered message unchanged — `message` still names it in prose.
      reason,
      message: `the replacement for this bearer shows committed evidence of use (${reason})`,
    }),

  delegationRetryIdentityUnmatched: (step: string): RundownError =>
    new RundownError('DELEGATION_RETRY_IDENTITY_UNMATCHED', {
      step,
      message: 'the named bearer matches neither the current delegation nor one it superseded',
    }),

  delegationSupersessionAmbiguous: (step: string): RundownError =>
    new RundownError('DELEGATION_SUPERSESSION_AMBIGUOUS', {
      step,
      message: 'more than one delegation attempt records this bearer as superseded',
    }),

  delegationIndexNotActive: (step: string, requested: number, active: number): RundownError =>
    new RundownError('DELEGATION_INDEX_NOT_ACTIVE', {
      // Both coordinates ride as structured keys AND in the prose. They are
      // outside `formatMessage`'s fixed key list, so `context` is the only way
      // an agent reads them without parsing English — the same shape
      // `delegationReplacementConsumed` uses for its `reason`.
      requested,
      active,
      step,
      message: `--index ${String(requested)} names a FOR iteration the parent has not entered; iteration ${String(active)} is active`,
    }),

  claimSeenUnreadable: (claimKey: string, lastSeenAt: string): RundownError =>
    new RundownError('CLAIM_SEEN_UNREADABLE', {
      // These keys are NOT arbitrary — `RundownError.formatMessage` renders a
      // fixed twelve-key list (rundown-error.ts:99-134) and a key outside it lands
      // in `context`, reachable only via toJSON() and INVISIBLE in `error.message`.
      // `ErrorContext`'s index signature (:32) means TypeScript will not warn you.
      //
      // `value` renders as the quoted primary identifier. `childId` does NOT also
      // render: the primary identifier is `value ?? scenario ?? argName ?? childId
      // ?? agentId`, so only ONE wins and `value` shadows it. It is kept as the
      // conventional structured correlation slot (readable via toJSON), and the
      // claim key reaches the MESSAGE via `message` — the same shape the sibling
      // delegation factories use. Without it, AC6's "loud" error would name the
      // corrupt value with nothing to correlate it to, on the very surface plan 3
      // renders to agents.
      value: lastSeenAt,
      childId: claimKey,
      message: `claim ${claimKey}`,
    }),

  delegationAlreadyResolved: (step: string): RundownError =>
    new RundownError('DELEGATION_ALREADY_RESOLVED', { step }),

  delegationNoDelegatableSubstep: (step: string): RundownError =>
    new RundownError('DELEGATION_NO_DELEGATABLE_SUBSTEP', { step }),

  delegationSubstepNoRunbook: (substep: string, step: string): RundownError =>
    new RundownError('DELEGATION_SUBSTEP_NO_RUNBOOK', { substep, step }),

  delegationStepNoSubsteps: (step: string): RundownError =>
    new RundownError('DELEGATION_STEP_NO_SUBSTEPS', { step }),

  delegationSnapshotStale: (substepId: string, step: string): RundownError =>
    new RundownError('DELEGATION_SNAPSHOT_STALE', { substepId, step }),

  delegationOwnerLostSubsteps: (substepId: string, step: string): RundownError =>
    new RundownError('DELEGATION_OWNER_LOST_SUBSTEPS', { substepId, step }),

  delegationNestedForbidden: (runId: string): RundownError =>
    new RundownError('DELEGATION_NESTED_FORBIDDEN', { runId }),

  delegationInvariantViolated: (reason: string): RundownError =>
    new RundownError('DELEGATION_INVARIANT_VIOLATED', { reason }),

  retryHookStaleSubstep: (substepId: string, parentStep: string): RundownError =>
    new RundownError('RETRY_HOOK_STALE_SUBSTEP', { substepId, parentStep }),

  retryHookMissingRunId: (parentStep: string): RundownError =>
    new RundownError('RETRY_HOOK_MISSING_RUN_ID', { step: parentStep }),

  // Generic
  unknown: (message: string, cause?: Error): RundownError =>
    new RundownError('UNKNOWN_ERROR', { message }, cause),
};
