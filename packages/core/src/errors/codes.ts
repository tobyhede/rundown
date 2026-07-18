/**
 * Error categories for Rundown CLI.
 */
export enum ErrorCategory {
  FILE_IO = 'FILE_IO',
  PARSE_SYNTAX = 'PARSE_SYNTAX',
  STATE = 'STATE',
  VALIDATION = 'VALIDATION',
  EXECUTION = 'EXECUTION',
  COMMAND = 'COMMAND',
  AGENT = 'AGENT',
  DELEGATION = 'DELEGATION',
}

/**
 * Error code definition with metadata.
 */
export interface ErrorCodeDefinition {
  /** Unique error code (e.g., 'RD-101') */
  readonly code: string;
  /** Error category */
  readonly category: ErrorCategory;
  /** Short human-readable title */
  readonly title: string;
  /** Detailed description with resolution guidance */
  readonly description: string;
  /** Documentation URL fragment (e.g., 'file-not-found') */
  readonly docSlug: string;
}

/**
 * All Rundown error codes.
 */
export const ErrorCodes = {
  // File/IO Errors (1xx)
  FILE_NOT_FOUND: {
    code: 'RD-101',
    category: ErrorCategory.FILE_IO,
    title: 'Runbook file not found',
    description: 'The specified runbook file does not exist or cannot be accessed.',
    docSlug: 'file-not-found',
  },
  FILE_NOT_READABLE: {
    code: 'RD-102',
    category: ErrorCategory.FILE_IO,
    title: 'File not readable',
    description: 'The runbook file exists but cannot be read due to permission restrictions.',
    docSlug: 'file-not-readable',
  },
  STATE_DIR_NOT_ACCESSIBLE: {
    code: 'RD-103',
    category: ErrorCategory.FILE_IO,
    title: 'State directory not accessible',
    description: 'The .rundown directory cannot be accessed or created.',
    docSlug: 'state-dir-not-accessible',
  },

  // Parse/Syntax Errors (2xx)
  EMPTY_RUNBOOK: {
    code: 'RD-201',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Empty runbook file',
    description: 'The runbook file contains no content.',
    docSlug: 'empty-runbook',
  },
  NO_STEPS_FOUND: {
    code: 'RD-202',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'No valid steps found',
    description: 'The runbook file does not contain any valid step headings (## headers).',
    docSlug: 'no-steps-found',
  },
  INVALID_FRONTMATTER: {
    code: 'RD-203',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Invalid frontmatter',
    description: 'The YAML frontmatter is malformed or contains invalid syntax.',
    docSlug: 'invalid-frontmatter',
  },
  SYNTAX_ERROR: {
    code: 'RD-204',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Runbook syntax error',
    description: 'The runbook file contains invalid syntax.',
    docSlug: 'syntax-error',
  },

  // State Errors (3xx)
  NO_ACTIVE_RUNBOOK: {
    code: 'RD-301',
    category: ErrorCategory.STATE,
    title: 'No active runbook',
    description: 'No runbook is currently running. Start a runbook with "rundown run <file>".',
    docSlug: 'no-active-runbook',
  },
  STATE_PARSE_ERROR: {
    code: 'RD-302',
    category: ErrorCategory.STATE,
    title: 'State file parse error',
    description:
      'The runbook state file contains invalid JSON. Try running "rundown prune" to clean up.',
    docSlug: 'state-parse-error',
  },
  RUNBOOK_COMPLETED: {
    code: 'RD-303',
    category: ErrorCategory.STATE,
    title: 'Runbook already completed',
    description: 'This runbook has already been marked as complete. Start a new run.',
    docSlug: 'runbook-completed',
  },
  RUNBOOK_STOPPED: {
    code: 'RD-304',
    category: ErrorCategory.STATE,
    title: 'Runbook stopped',
    description:
      'This runbook was stopped. Start a new run or use "rundown pop" to resume if stashed.',
    docSlug: 'runbook-stopped',
  },

  // Validation Errors (4xx)
  GOTO_TARGET_NOT_FOUND: {
    code: 'RD-401',
    category: ErrorCategory.VALIDATION,
    title: 'GOTO target not found',
    description: 'The specified step or substep does not exist in the runbook.',
    docSlug: 'goto-target-not-found',
  },
  INVALID_STEP_SEQUENCE: {
    code: 'RD-402',
    category: ErrorCategory.VALIDATION,
    title: 'Invalid step sequence',
    description: 'Step numbers must be sequential starting from 1.',
    docSlug: 'invalid-step-sequence',
  },
  MISSING_REQUIRED_VARS: {
    code: 'RD-403',
    category: ErrorCategory.VALIDATION,
    title: 'Missing required variables',
    description:
      'One or more required variables declared in frontmatter were not provided via CLI flags, config, environment, or delegation.',
    docSlug: 'missing-required-vars',
  },

  // Execution Errors (5xx)
  ENGINE_INIT_FAILED: {
    code: 'RD-501',
    category: ErrorCategory.EXECUTION,
    title: 'Failed to initialize runbook engine',
    description: 'The XState runbook engine could not be initialized.',
    docSlug: 'engine-init-failed',
  },
  RUNBOOK_HAS_NO_STEPS: {
    code: 'RD-502',
    category: ErrorCategory.EXECUTION,
    title: 'Runbook has no steps',
    description: 'The runbook file does not contain any executable steps.',
    docSlug: 'runbook-has-no-steps',
  },
  CHILD_RUNBOOK_ACTIVE: {
    code: 'RD-503',
    category: ErrorCategory.EXECUTION,
    title: 'Child runbook still active',
    description: 'A child runbook is still running. Complete or stop it first.',
    docSlug: 'child-runbook-active',
  },

  // Command Errors (6xx)
  INVALID_STEP_FORMAT: {
    code: 'RD-601',
    category: ErrorCategory.COMMAND,
    title: 'Invalid step ID format',
    description: 'Step ID must be in format "N" (step) or "N.M" (step.substep).',
    docSlug: 'invalid-step-format',
  },
  MISSING_REQUIRED_ARG: {
    code: 'RD-602',
    category: ErrorCategory.COMMAND,
    title: 'Missing required argument',
    description: 'A required argument was not provided.',
    docSlug: 'missing-required-arg',
  },
  SCENARIO_NOT_FOUND: {
    code: 'RD-603',
    category: ErrorCategory.COMMAND,
    title: 'Scenario not found',
    description: 'The specified scenario does not exist in the runbook.',
    docSlug: 'scenario-not-found',
  },

  // Substep Targeting Errors (8xx) — shared by delegation and inline linkage
  DELEGATION_STEP_NOT_FOUND: {
    code: 'RD-801',
    category: ErrorCategory.DELEGATION,
    title: 'Step not found',
    description: 'The specified step does not exist in the active runbook.',
    docSlug: 'delegation-step-not-found',
  },
  DELEGATION_STEP_NOT_CURRENT: {
    code: 'RD-802',
    category: ErrorCategory.DELEGATION,
    title: 'Step not at execution frontier',
    description: 'The target step must be the current step.',
    docSlug: 'delegation-step-not-current',
  },
  DELEGATION_SUBSTEP_REQUIRED: {
    code: 'RD-803',
    category: ErrorCategory.DELEGATION,
    title: 'Substep ID required',
    description: 'This step has substeps. Specify a substep ID (e.g., --step 2.1).',
    docSlug: 'delegation-substep-required',
  },
  DELEGATION_ALREADY_EXISTS: {
    code: 'RD-804',
    category: ErrorCategory.DELEGATION,
    title: 'Active delegation exists',
    description: 'This substep already has an active (non-cancelled) delegation.',
    docSlug: 'delegation-already-exists',
  },
  DELEGATION_RUNBOOK_NOT_FOUND: {
    code: 'RD-805',
    category: ErrorCategory.DELEGATION,
    title: 'Child runbook not found',
    description: 'The specified child runbook cannot be resolved.',
    docSlug: 'delegation-runbook-not-found',
  },
  DELEGATION_SUBSTEP_NOT_FOUND: {
    code: 'RD-806',
    category: ErrorCategory.DELEGATION,
    title: 'Substep not found',
    description: 'The specified substep ID does not exist in the target step.',
    docSlug: 'delegation-substep-not-found',
  },
  INVALID_TOKEN: {
    code: 'RD-807',
    category: ErrorCategory.DELEGATION,
    title: 'Invalid delegation token',
    description: 'Token format is invalid. Tokens must start with "rdtk_".',
    docSlug: 'invalid-token',
  },
  TOKEN_NOT_FOUND: {
    code: 'RD-808',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation token not found',
    description: 'No active run contains a delegation with this token.',
    docSlug: 'token-not-found',
  },
  TOKEN_CANCELLED: {
    code: 'RD-809',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation token cancelled',
    description: 'This delegation has been cancelled and cannot be claimed.',
    docSlug: 'token-cancelled',
  },
  DELEGATION_LOCK_TIMEOUT: {
    code: 'RD-810',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation lock timeout',
    description: 'Could not acquire delegation lock. Another operation may be in progress.',
    docSlug: 'delegation-lock-timeout',
  },
  DELEGATION_ALREADY_CLAIMED: {
    code: 'RD-811',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation already claimed',
    description:
      'This delegation has been claimed by a child run. Use --force to cancel in-flight.',
    docSlug: 'delegation-already-claimed',
  },
  DELEGATION_ALREADY_RESOLVED: {
    code: 'RD-812',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation already resolved',
    description: 'This delegation has already been resolved. Propagation already completed.',
    docSlug: 'delegation-already-resolved',
  },
  DELEGATION_NO_DELEGATABLE_SUBSTEP: {
    code: 'RD-813',
    category: ErrorCategory.DELEGATION,
    title: 'No delegatable substep',
    description: 'No pending substep with a runbook reference found on the current step.',
    docSlug: 'delegation-no-delegatable-substep',
  },
  DELEGATION_SUBSTEP_NO_RUNBOOK: {
    code: 'RD-814',
    category: ErrorCategory.DELEGATION,
    title: 'Substep has no runbook reference',
    description:
      'The specified substep does not have a runbook reference (e.g., "- child.runbook.md").',
    docSlug: 'delegation-substep-no-runbook',
  },
  DELEGATION_STEP_NO_SUBSTEPS: {
    code: 'RD-815',
    category: ErrorCategory.DELEGATION,
    title: 'Step has no substeps',
    description:
      'Inline linkage requires targeting a substep. The specified step has no substeps to target.',
    docSlug: 'delegation-step-no-substeps',
  },
  LAUNCH_FAILED: {
    code: 'RD-816',
    category: ErrorCategory.DELEGATION,
    title: 'Runbook launch failed',
    description:
      'Failed to initialize runbook state, actor, session, or post-init hook before execution started.',
    docSlug: 'launch-failed',
  },
  DELEGATION_SNAPSHOT_STALE: {
    code: 'RD-817',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation snapshot missing owner step',
    description:
      `Cannot retry: the persisted delegation snapshot does not record an owner step. ` +
      `This indicates the delegation was created by an older schema and cannot be safely re-issued.`,
    docSlug: 'delegation-snapshot-stale',
  },
  DELEGATION_OWNER_LOST_SUBSTEPS: {
    code: 'RD-818',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation owner step lost substeps',
    description:
      `A persisted delegation references a substep, but the resolved runbook no longer ` +
      `declares substeps on the owner step. Silently retargeting the replacement token ` +
      `onto the bare step would corrupt the persisted entry. Resolve by completing or ` +
      `stopping the running runbook and starting a fresh run.`,
    docSlug: 'delegation-owner-lost-substeps',
  },
  DELEGATION_NESTED_FORBIDDEN: {
    code: 'RD-819',
    category: ErrorCategory.DELEGATION,
    title: 'Nested delegation forbidden',
    description:
      'A claimed (delegated) child runbook may not issue further delegations. ' +
      'Delegation is single-level: subagents cannot spawn subagents. Use `rundown run` ' +
      'for runbook composition inside a claimed child.',
    docSlug: 'delegation-nested-forbidden',
  },
  CLAIM_INVARIANT_VIOLATED: {
    code: 'RD-820',
    category: ErrorCategory.DELEGATION,
    title: 'Claim invariant violated during fresh launch',
    description:
      `A freshly launched delegated child failed write-side claim validation. ` +
      `The child was just created with the same delegation linkage now being ` +
      `rejected — indicates internal inconsistency between manager.create() ` +
      `and SessionService.claimRunbook(). State may be corrupted; inspect ` +
      `.rundown/runs/<childRunId>.json and the parent's substep delegation.`,
    docSlug: 'claim-invariant-violated',
  },
  DELEGATION_INVARIANT_VIOLATED: {
    code: 'RD-821',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation invariant violated',
    description:
      `A delegation operation reached an unreachable result branch. This indicates ` +
      `an internal inconsistency in delegation state handling rather than stale ` +
      `runbook source. Inspect the reported reason and the persisted run state.`,
    docSlug: 'delegation-invariant-violated',
  },
  DELEGATION_RUNBOOK_MISMATCH: {
    code: 'RD-822',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation runbook mismatch',
    description:
      'The requested child runbook does not match the runbook authored on the DELEGATE substep.',
    docSlug: 'delegation-runbook-mismatch',
  },
  DELEGATION_IN_FLIGHT: {
    code: 'RD-823',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation child run in flight',
    description:
      'Cannot retry a delegation while its child run is still linked. Use `rundown abort <token> --claim-id <claim_id> --force` first to stop and record the child failure before retrying.',
    docSlug: 'delegation-in-flight',
  },
  CLAIM_SEEN_UNREADABLE: {
    code: 'RD-824',
    category: ErrorCategory.DELEGATION,
    title: 'Claim seen timestamp unreadable',
    description:
      'A claim record has a lastSeenAt that is not a parseable ISO timestamp. The claim activity signal cannot be derived, so it is reported as unreadable rather than guessed. Finish or prune active runbooks and restart.',
    docSlug: 'claim-seen-unreadable',
  },
  // Retry hook (9xx) — sub-range of ErrorCategory.EXECUTION reserved for
  // retry-hook lifecycle failures (delegation re-issuance, frame-key invariants,
  // canonical-at requirements). Kept as EXECUTION rather than a dedicated
  // category because consumers route on the structured RETRY_ERROR LastAction
  // variant, not on category. New 9xx codes must stay scoped to retry-hook
  // semantics — file unrelated runtime failures under 5xx EXECUTION.
  RETRY_HOOK_NO_FRAME: {
    code: 'RD-902',
    category: ErrorCategory.EXECUTION,
    title: 'Retry hook invoked without an active frame key',
    description:
      `The retry hook fired while context.activeFrameKey was undefined and ` +
      `live delegations were present — an invariant violation. Retry transitions ` +
      `only fire from drainResolvedCompletions, which requires an active frame. ` +
      `This indicates upstream state corruption (actor hydration bug, state-file ` +
      `tampering, or missing frame setup in a new feature path).`,
    docSlug: 'retry-hook-no-frame',
  },
  RETRY_HOOK_MISSING_CANONICAL_AT: {
    code: 'RD-904',
    category: ErrorCategory.EXECUTION,
    title: 'Retry delegation produced no canonical execution location',
    description:
      `The fresh delegation snapshot returned by retryDelegation has no ` +
      `contextSnapshot.at value. The retry frontier id would lose FOR-iteration ` +
      `context (e.g. "1.1" instead of "1.2.1"), causing the re-entry frontier ` +
      `to point at the wrong execution location. Rollback is the safe action ` +
      `rather than silently emitting a degraded id.`,
    docSlug: 'retry-hook-missing-canonical-at',
  },
  RETRY_HOOK_STALE_SUBSTEP: {
    code: 'RD-905',
    category: ErrorCategory.EXECUTION,
    title: 'Retry hook references undeclared substep',
    description:
      `An active-frame delegation in persisted state targets a substep that the ` +
      `resolved runbook no longer declares on the parent step. The per-substep ` +
      `loop walks parentStep.substeps only, so silently skipping the orphan would ` +
      `consume the retry transition without re-issuing any token. Resolve by ` +
      `completing or stopping the running runbook and starting a fresh run.`,
    docSlug: 'retry-hook-stale-substep',
  },

  // Generic
  UNKNOWN_ERROR: {
    code: 'RD-999',
    category: ErrorCategory.EXECUTION,
    title: 'Unknown error',
    description: 'An unexpected error occurred.',
    docSlug: 'unknown-error',
  },
} as const;

/**
 * Type for error code keys.
 */
export type ErrorCodeKey = keyof typeof ErrorCodes;
