import { RundownError } from './rundown-error.js';

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

  invalidToken: (token: string): RundownError => new RundownError('INVALID_TOKEN', { token }),

  tokenNotFound: (token: string): RundownError => new RundownError('TOKEN_NOT_FOUND', { token }),

  tokenCancelled: (token: string): RundownError => new RundownError('TOKEN_CANCELLED', { token }),

  delegationLockTimeout: (parentRunId: string): RundownError =>
    new RundownError('DELEGATION_LOCK_TIMEOUT', { parentRunId }),

  delegationAlreadyClaimed: (step: string, childRunId: string): RundownError =>
    new RundownError('DELEGATION_ALREADY_CLAIMED', { step, childRunId }),

  delegationInFlight: (step: string, childRunId: string): RundownError =>
    new RundownError('DELEGATION_IN_FLIGHT', {
      step,
      childRunId,
      message: `child run ${childRunId} is still linked; run "rundown abort <token> --claim-id <claim_id> --force" before retrying`,
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

  // Generic
  unknown: (message: string, cause?: Error): RundownError =>
    new RundownError('UNKNOWN_ERROR', { message }, cause),
};
