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
    description:
      'The specified runbook file does not exist or cannot be accessed.',
    docSlug: 'file-not-found',
  },
  FILE_NOT_READABLE: {
    code: 'RD-102',
    category: ErrorCategory.FILE_IO,
    title: 'File not readable',
    description:
      'The runbook file exists but cannot be read due to permission restrictions.',
    docSlug: 'file-not-readable',
  },
  STATE_DIR_NOT_ACCESSIBLE: {
    code: 'RD-103',
    category: ErrorCategory.FILE_IO,
    title: 'State directory not accessible',
    description: 'The .claude/rundown directory cannot be accessed or created.',
    docSlug: 'state-dir-not-accessible',
  },

  // Parse/Syntax Errors (2xx)
  EMPTY_WORKFLOW: {
    code: 'RD-201',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Empty runbook file',
    description: 'The runbook file contains no content.',
    docSlug: 'empty-workflow',
  },
  NO_STEPS_FOUND: {
    code: 'RD-202',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'No valid steps found',
    description:
      'The runbook file does not contain any valid step headings (## headers).',
    docSlug: 'no-steps-found',
  },
  INVALID_FRONTMATTER: {
    code: 'RD-203',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Invalid frontmatter',
    description:
      'The YAML frontmatter is malformed or contains invalid syntax.',
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
  NO_ACTIVE_WORKFLOW: {
    code: 'RD-301',
    category: ErrorCategory.STATE,
    title: 'No active runbook',
    description:
      'No runbook is currently running. Start a runbook with "rd run <file>".',
    docSlug: 'no-active-workflow',
  },
  STATE_PARSE_ERROR: {
    code: 'RD-302',
    category: ErrorCategory.STATE,
    title: 'State file parse error',
    description:
      'The runbook state file contains invalid JSON. Try running "rd prune" to clean up.',
    docSlug: 'state-parse-error',
  },
  WORKFLOW_COMPLETED: {
    code: 'RD-303',
    category: ErrorCategory.STATE,
    title: 'Runbook already completed',
    description:
      'This runbook has already been marked as complete. Start a new run.',
    docSlug: 'workflow-completed',
  },
  WORKFLOW_STOPPED: {
    code: 'RD-304',
    category: ErrorCategory.STATE,
    title: 'Runbook stopped',
    description:
      'This runbook was stopped. Start a new run or use "rd pop" to resume if stashed.',
    docSlug: 'workflow-stopped',
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
  GOTO_NEXT_CLI_INVALID: {
    code: 'RD-403',
    category: ErrorCategory.VALIDATION,
    title: 'GOTO NEXT not valid via CLI',
    description:
      'GOTO NEXT is only valid in runbook transitions, not via the CLI.',
    docSlug: 'goto-next-cli-invalid',
  },

  // Execution Errors (5xx)
  ENGINE_INIT_FAILED: {
    code: 'RD-501',
    category: ErrorCategory.EXECUTION,
    title: 'Failed to initialize runbook engine',
    description: 'The XState runbook engine could not be initialized.',
    docSlug: 'engine-init-failed',
  },
  WORKFLOW_HAS_NO_STEPS: {
    code: 'RD-502',
    category: ErrorCategory.EXECUTION,
    title: 'Runbook has no steps',
    description:
      'The runbook file does not contain any executable steps.',
    docSlug: 'workflow-has-no-steps',
  },
  CHILD_WORKFLOW_ACTIVE: {
    code: 'RD-503',
    category: ErrorCategory.EXECUTION,
    title: 'Child runbook still active',
    description:
      'A child runbook is still running. Complete or stop it first.',
    docSlug: 'child-workflow-active',
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

  // Agent Errors (7xx)
  NO_PENDING_STEP: {
    code: 'RD-701',
    category: ErrorCategory.AGENT,
    title: 'No pending step to bind',
    description: 'There is no pending step available for agent binding.',
    docSlug: 'no-pending-step',
  },
  AGENT_NOT_BOUND: {
    code: 'RD-702',
    category: ErrorCategory.AGENT,
    title: 'Agent not bound',
    description: 'This agent is not bound to any step.',
    docSlug: 'agent-not-bound',
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
