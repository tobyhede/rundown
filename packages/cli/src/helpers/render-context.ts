import type { RunId, TemplateRenderContext } from '@rundown-org/core';

/**
 * Build runnable template helper context from persisted run state variables.
 *
 * A near-twin of core's `buildRunnableRenderContext`, which #799 moved behind
 * the entry seam. The two are deliberately NOT shared yet, and the difference is
 * the error class rather than the value: core's raises
 * `InvalidRunbookStateError`, which `terminal-command.ts` treats as "this run is
 * unusable" — so `rundown stop --claim-id` against such a run would report no
 * active runbook and exit 0 instead of surfacing the failure. That
 * reclassification is a decision about `stop`, not about rendering, so it is not
 * being made here. Collapse the two once it is (#799 follow-up).
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
