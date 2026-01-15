import { RundownError, type ErrorContext } from './rundown-error.js';

/**
 * Factory functions for creating typed errors.
 * Provides better IDE autocomplete and type safety.
 */
export const Errors = {
  // File/IO
  fileNotFound: (file: string) =>
    new RundownError('FILE_NOT_FOUND', { file }),

  fileNotReadable: (file: string) =>
    new RundownError('FILE_NOT_READABLE', { file }),

  stateDirNotAccessible: (path: string) =>
    new RundownError('STATE_DIR_NOT_ACCESSIBLE', { file: path }),

  // Parse/Syntax
  emptyWorkflow: (file: string) =>
    new RundownError('EMPTY_WORKFLOW', { file }),

  noStepsFound: (file: string) =>
    new RundownError('NO_STEPS_FOUND', { file }),

  invalidFrontmatter: (file: string, message?: string) =>
    new RundownError('INVALID_FRONTMATTER', { file, message }),

  syntaxError: (message: string, file?: string, line?: number) =>
    new RundownError('SYNTAX_ERROR', { file, line, message }),

  // State
  noActiveWorkflow: () =>
    new RundownError('NO_ACTIVE_WORKFLOW'),

  stateParseError: (file: string, message?: string) =>
    new RundownError('STATE_PARSE_ERROR', { file, message }),

  workflowCompleted: (file?: string) =>
    new RundownError('WORKFLOW_COMPLETED', { file }),

  workflowStopped: (file?: string) =>
    new RundownError('WORKFLOW_STOPPED', { file }),

  // Validation
  gotoTargetNotFound: (step: string, substep?: string) =>
    new RundownError('GOTO_TARGET_NOT_FOUND', { step, substep }),

  invalidStepSequence: (expected: number, found: number, line?: number) =>
    new RundownError('INVALID_STEP_SEQUENCE', {
      expected: String(expected),
      found: String(found),
      line,
    }),

  gotoNextNotAllowedViaCli: () =>
    new RundownError('GOTO_NEXT_CLI_INVALID'),

  // Execution
  engineInitFailed: (cause?: Error) =>
    new RundownError('ENGINE_INIT_FAILED', {}, cause),

  workflowHasNoSteps: (file?: string) =>
    new RundownError('WORKFLOW_HAS_NO_STEPS', { file }),

  childWorkflowActive: (childId?: string) =>
    new RundownError('CHILD_WORKFLOW_ACTIVE', { childId }),

  // Command
  invalidStepFormat: (value: string) =>
    new RundownError('INVALID_STEP_FORMAT', { value }),

  missingRequiredArg: (argName: string) =>
    new RundownError('MISSING_REQUIRED_ARG', { argName }),

  scenarioNotFound: (scenario: string, file?: string) =>
    new RundownError('SCENARIO_NOT_FOUND', { scenario, file }),

  // Agent
  noPendingStep: () =>
    new RundownError('NO_PENDING_STEP'),

  agentNotBound: (agentId?: string) =>
    new RundownError('AGENT_NOT_BOUND', { agentId }),

  // Generic
  unknown: (message: string, cause?: Error) =>
    new RundownError('UNKNOWN_ERROR', { message }, cause),
};
