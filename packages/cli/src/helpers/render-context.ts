import type { RunId, TemplateRenderContext } from '@rundown-org/core';

/**
 * Build runnable template helper context from persisted run state variables.
 *
 * A near-twin of core's unexported `buildRunnableRenderContext`
 * (`execution-unit-entry.ts:185`). The two build the same context and differ
 * only in the class of their refusal: core's raises `InvalidRunbookStateError`
 * (reason `missing_render_context`), which `toRundownError` (`wrapper.ts`)
 * renders as RD-309; this one raises a bare `Error`, which falls through to
 * RD-999. Either throw exits non-zero, including on the `complete` / `stop` path
 * (`loadSteps` in `lifecycle-command-service.ts`), so collapsing the two changes
 * only the code and recovery hint printed (#799 follow-up).
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
