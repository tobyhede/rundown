import type { RunId, TemplateRenderContext } from '@rundown-org/core';

/**
 * Build runnable template helper context from persisted run state variables.
 *
 * @param input - Run identity, project directory, and effective variable map
 * @param input.runId - Current run identifier
 * @param input.cwd - Project directory used for helper path containment
 * @param input.vars - Effective variable map containing built-in runtime values
 * @returns Runnable template render context for helper invocation
 * @throws {Error} if persisted state lacks required runtime context fields
 */
export function buildRunnableRenderContext(input: {
  readonly runId: RunId;
  readonly cwd: string;
  readonly vars: Readonly<Record<string, unknown>>;
}): TemplateRenderContext {
  const contextId = input.vars.ContextId;
  if (typeof contextId !== 'string') {
    throw new Error(
      `Runbook state ${input.runId} is missing ContextId. Delete state and re-run the runbook.`,
    );
  }

  const workPath = input.vars.WorkPath;
  if (typeof workPath !== 'string') {
    throw new Error(
      `Runbook state ${input.runId} is missing WorkPath. Delete state and re-run the runbook.`,
    );
  }

  return {
    kind: 'runnable',
    cwd: input.cwd,
    workPath,
    contextId,
    runId: input.runId,
  };
}
