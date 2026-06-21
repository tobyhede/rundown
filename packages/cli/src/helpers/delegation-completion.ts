/**
 * Report or advance a terminal child run's outcome to its delegating run.
 *
 * When a child run reaches a terminal state (complete or stopped), its result
 * must propagate back to the delegating run's substep. The two linkage kinds
 * propagate differently — this is the type-driven split at the heart of Plan 5,
 * dispatched centrally by {@link propagateChildTerminal}:
 *
 * - **Delegation** children (`rd delegate` / `rd claim`) are asynchronous and
 *   run in a separate worker agent. Their close is REPORT-ONLY
 *   ({@link reportTerminalToDelegatingRun}): it records the outcome and stops,
 *   leaving the delegating run collection pending. Applying the outcome
 *   (advancing the delegating run) is the COLLECT half and lives entirely
 *   behind `rd collect` (core's `collectDelegationOutcomes`).
 * - **Inline** children (`rd run --step`, or an auto-launched `- child.runbook.md`
 *   substep) are synchronous and single-agent: the same orchestrator that ran
 *   the child continues the parent. Their close DRAINS AND ADVANCES the parent
 *   immediately ({@link advanceParentForInlineChild}) — there is no separate
 *   `rd collect` for inline composition.
 *
 * @module helpers/delegation-completion
 */

import {
  RunbookStateManager,
  ExecutionLifecycleService,
  RunbookCompletionService,
  type RunbookState,
  type ParentLinkage,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import type { TransitionOrchestrationPolicy } from './transition-orchestrator.js';

/**
 * Extract the discriminated parent linkage from a child state.
 *
 * Returns the full {@link ParentLinkage} union (carrying the `kind`
 * discriminant) so callers — chiefly {@link propagateChildTerminal} — can
 * dispatch on inline vs delegation. A child carries exactly one linkage.
 *
 * @param state - The child run's state
 * @returns The parent linkage (inline or delegation), or undefined if none
 */
export function extractParentLinkage(state: RunbookState): ParentLinkage | undefined {
  return state.parentLinkage;
}

/**
 * Report a delegation child's terminal outcome to its immediate delegating run.
 *
 * This is the REPORT half of report-then-collect (Plan 5). It records ONE
 * delegation outcome row on the immediate delegating run (via core's
 * `recordChildCompletion`) and returns. It does NOT collect, drain, apply, or
 * advance the delegating run, and it does NOT recurse to ancestors. The
 * delegating run is left collection pending; its orchestrator must run
 * `rd collect` to apply the outcome.
 *
 * Inline children do NOT use this path — see {@link advanceParentForInlineChild}.
 *
 * @param childState - The terminal child run's state (must carry parentLinkage)
 * @param result - Terminal result of the child ('pass' or 'fail')
 * @param cwd - Current working directory
 * @param output - Output emitter for CLI output
 * @returns 'reported' when an outcome row was recorded (or was already present,
 *          or the slot was ordinarily cancelled so nothing needed reporting),
 *          'not-applicable' when the child has no parent linkage
 * @throws {Error} If state I/O fails.
 */
export async function reportTerminalToDelegatingRun(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
): Promise<'reported' | 'not-applicable'> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';

  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);

  const recorded = await completionService.recordChildCompletion({ childState, result });
  // 'not-applicable' means the child had no linkage to report against (the
  // early guard above already handled the common case; core re-checks). Every
  // other outcome — 'recorded', 'duplicate', and 'cancelled' — means there is
  // nothing more for the close path to do: 'recorded'/'duplicate' leave the
  // delegating run collection pending, and 'cancelled' (ordinary cancel
  // short-circuit) preserves the cancellation split by writing no fail outcome.
  if (recorded === 'not-applicable') return 'not-applicable';
  output.flush();
  return 'reported';
}

/**
 * Advance the composing (parent) run when an INLINE child reaches terminal.
 *
 * This is the inline-composition flow-back path. Unlike delegation
 * (report-then-collect), inline composition (`rd run --step` or an auto-launched
 * `- child.runbook.md` substep) is synchronous and single-agent: the same
 * orchestrator that ran the child continues the parent, so the child's outcome
 * is recorded AND immediately drained/advanced here — there is no separate
 * `rd collect` step for inline composition.
 *
 * Single-level (Plan 4/5): if advancing the parent drives IT to a terminal
 * state and it itself carries a delegation linkage (e.g. an inline child inside
 * a claimed parent), the parent's outcome is REPORTED upward report-only via
 * {@link reportTerminalToDelegatingRun} — leaving that delegating run
 * collection pending — it is NOT recursively drained.
 *
 * The heavy CLI orchestration dependencies (execution loop, transition configs,
 * bridged emitter, runbook loader) and the core `SessionService`/`exactFrame`
 * are imported LAZILY so this module's static surface stays minimal: that keeps
 * the report-only unit boundary small and avoids a static
 * delegation-completion <-> execution import cycle (execution.ts already imports
 * this module dynamically for the same reason).
 *
 * @param childState - The terminal inline child's state (must carry parentLinkage)
 * @param result - Terminal result of the child ('pass' or 'fail')
 * @param cwd - Current working directory
 * @param output - Output emitter for CLI output
 * @returns 'handled' when the parent was advanced (or is waiting on siblings),
 *          'stopped' when advancing the parent reached a STOP terminal,
 *          'not-applicable' when the child has no parent linkage
 * @throws {Error} If parent state I/O fails or drain execution fails.
 */
export async function advanceParentForInlineChild(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
): Promise<'handled' | 'stopped' | 'not-applicable'> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';

  const { SessionService, exactFrame } = await import('@rundown-org/core');
  const { drainResolvedCompletions, runExecutionLoop } = await import('../services/execution.js');
  const { getRunbookFromState } = await import('./runbook-loader.js');
  const { createBridgedEmitter } = await import('./execution-emitter.js');
  const { createPassTransitionConfig, createFailTransitionConfig } = await import(
    './transitions.js'
  );

  const { parentRunId, parentFrameKey } = linkage;

  const manager = new RunbookStateManager(cwd);
  const parentActorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(
    manager,
    lifecycleService,
    parentActorService,
  );
  const recorded = await completionService.recordChildCompletion({ childState, result });
  if (recorded === 'not-applicable') return 'not-applicable';
  if (recorded === 'cancelled') return 'handled';

  // Drain resolved completions on the parent after core-owned recording.
  const transitionConfig =
    result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();

  // Inline advance: never release during drain. Session release is handled
  // explicitly on the terminal branches below and by runExecutionLoop.
  const inlinePolicy: TransitionOrchestrationPolicy = {
    onComplete: { releaseRunbook: false },
    onStopped: { releaseRunbook: false },
  };

  const parentState = await manager.load(parentRunId);
  if (!parentState) return 'not-applicable';

  const parentSteps = [...getRunbookFromState(parentState, cwd)];
  const emitter = createBridgedEmitter(parentState, output);
  const drained = await drainResolvedCompletions({
    actorService: parentActorService,
    manager,
    sessionService,
    lifecycleService,
    emitter,
    runbookId: parentRunId,
    steps: parentSteps,
    currentState: parentState,
    transitionPolicy: inlinePolicy,
    computeActionResult: transitionConfig.computeActionResult,
    frameOverride: exactFrame(parentFrameKey, linkage.parentEntry),
  });

  // Parent reached a terminal state during drain. Release it and report ONE
  // outcome upward (single-level — report-only, no recursion into the
  // grandparent). reportTerminalToDelegatingRun self-guards when the parent has
  // no linkage of its own.
  if (drained.status === 'stopped') {
    await sessionService.releaseRunbook(parentRunId);
    const freshParent = await manager.load(parentRunId);
    if (freshParent) await reportTerminalToDelegatingRun(freshParent, 'fail', cwd, output);
    output.flush();
    return 'stopped';
  }
  if (drained.status === 'done') {
    await sessionService.releaseRunbook(parentRunId);
    const freshParent = await manager.load(parentRunId);
    if (freshParent) await reportTerminalToDelegatingRun(freshParent, 'pass', cwd, output);
    output.flush();
    return 'handled';
  }
  if (drained.status === 'failed') {
    throw new Error(drained.message);
  }
  if (drained.status === 'not_active') {
    output.flush();
    return 'handled';
  }

  // Completions were applied but the parent is still active: advance past the
  // resolved step via the execution loop, then handle any terminal it reaches.
  if (drained.applied > 0) {
    const freshParent = await manager.load(parentRunId);
    const loopState = freshParent ?? drained.state;
    const loopSteps = [...getRunbookFromState(loopState, cwd)];
    const loopResult = await runExecutionLoop(
      manager,
      parentRunId,
      loopSteps,
      cwd,
      !!loopState.prompted,
      emitter,
      { terminalReleaseMode: 'release-runbook', output },
    );
    output.flush();

    if (loopResult === 'stopped') {
      const terminalParent = await manager.load(parentRunId);
      if (terminalParent) await reportTerminalToDelegatingRun(terminalParent, 'fail', cwd, output);
      return 'stopped';
    }
    if (loopResult === 'done') {
      const terminalParent = await manager.load(parentRunId);
      if (terminalParent) await reportTerminalToDelegatingRun(terminalParent, 'pass', cwd, output);
    }
    return 'handled';
  }

  // applied === 0: waiting for other substeps to resolve.
  output.flush();
  return 'handled';
}

/**
 * Propagate a terminal child run's outcome to its parent, dispatching on the
 * linkage kind.
 *
 * This is the SINGLE entry point every terminal-close seam uses
 * (`transition-command`, `complete`, `stop`, `claim`, `run`,
 * `services/execution`). The propagation behaviour is decided by the child's
 * linkage discriminant, NOT by which command closed the child:
 *
 * - **Inline** (`kind: 'inline'`) -> {@link advanceParentForInlineChild}: drain
 *   and advance the composing parent synchronously (no `rd collect`).
 * - **Delegation** (`kind: 'delegation'`) -> {@link reportTerminalToDelegatingRun}:
 *   record the outcome report-only and stop; the delegating run is left
 *   collection pending until its orchestrator runs `rd collect`.
 *
 * Routing on the type (rather than on the call site) is what keeps inline
 * children correct no matter how they close — e.g. a launched-and-waiting inline
 * child closed via bare `rd pass` (transition-command) still drains and advances
 * its parent, while a delegated child closed the same way still reports only.
 *
 * @param childState - The terminal child run's state
 * @param result - Terminal result of the child ('pass' or 'fail')
 * @param cwd - Current working directory
 * @param output - Output emitter for CLI output
 * @returns 'not-applicable' when the child has no parent linkage; for inline,
 *          'handled' or 'stopped' (advancing the parent reached a STOP terminal);
 *          for delegation, 'reported' (the delegating run is collection pending)
 * @throws {Error} If state I/O fails or drain execution fails.
 */
export async function propagateChildTerminal(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
): Promise<'reported' | 'handled' | 'stopped' | 'not-applicable'> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';
  return linkage.kind === 'inline'
    ? advanceParentForInlineChild(childState, result, cwd, output)
    : reportTerminalToDelegatingRun(childState, result, cwd, output);
}
