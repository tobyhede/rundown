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
  projectDelegationTerminalOutcome,
  type RunbookState,
  type ParentLinkage,
  type CommandExecutionStreamOptions,
  type DelegationOutcome,
  type RunId,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import type { TransitionOrchestrationPolicy } from './transition-orchestrator.js';

/** Inline flow-back propagation outcomes ({@link advanceParentForInlineChild}). */
export type InlinePropagationResult = 'handled' | 'stopped' | 'blocked' | 'not-applicable';
/** Delegation report-only propagation outcomes ({@link reportTerminalToDelegatingRun}). */
export type DelegationPropagationResult = 'reported' | 'blocked' | 'not-applicable';
/**
 * Result returned after attempting to propagate a terminal child run to its
 * parent — the union of the two disjoint linkage subsets (same five members as
 * before, so flat `=== 'stopped'` / `=== 'blocked'` callers stay valid).
 */
export type TerminalPropagationResult = InlinePropagationResult | DelegationPropagationResult;

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
  result: 'pass' | 'fail' | undefined,
  cwd: string,
  output: OutputEmitter,
): Promise<DelegationPropagationResult> {
  const linkage = extractParentLinkage(childState);
  if (linkage?.kind !== 'delegation') return 'not-applicable';

  const projection = projectDelegationTerminalOutcome(childState, result);
  if (projection.kind === 'not_terminal') return 'not-applicable';
  if (projection.kind === 'command_infrastructure') {
    output.flush();
    return 'blocked';
  }

  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);

  const recorded = await completionService.recordChildCompletion({
    childState,
    result: projection.result,
  });
  if (recorded === 'blocked') {
    output.flush();
    return 'blocked';
  }
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
 * @param commandStreamOptions - Runtime-only routing for command subprocess
 * stdout/stderr while inline propagation continues the parent
 * @returns 'handled' when the parent was advanced (or is waiting on siblings),
 *          'stopped' when advancing the parent reached a STOP terminal,
 *          'not-applicable' when the child has no parent linkage
 * @throws {Error} If parent state I/O fails or drain execution fails.
 */
export async function advanceParentForInlineChild(
  childState: RunbookState,
  result: 'pass' | 'fail' | undefined,
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
): Promise<InlinePropagationResult> {
  const linkage = extractParentLinkage(childState);
  // This is the INLINE flow-back path only. Delegation linkage shares the same
  // base fields (parentRunId/parentFrameKey/parentEntry), so a delegation-linked
  // child would otherwise be drained and advanced here — bypassing the
  // report-then-collect contract that leaves a delegating parent collection
  // pending until `rd collect`. Narrow to inline and refuse anything else.
  if (linkage?.kind !== 'inline') return 'not-applicable';

  const projection = projectDelegationTerminalOutcome(childState, result);
  if (projection.kind === 'not_terminal') return 'not-applicable';
  if (projection.kind === 'command_infrastructure') {
    output.flush();
    return 'blocked';
  }

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
  const recorded = await completionService.recordChildCompletion({
    childState,
    result: projection.result,
  });
  if (recorded === 'not-applicable') return 'not-applicable';
  if (recorded === 'cancelled') return 'handled';
  if (recorded === 'blocked') {
    output.flush();
    return 'blocked';
  }

  // Drain resolved completions on the parent after core-owned recording.
  const transitionConfig =
    projection.result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();

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
    const propagated = freshParent
      ? await propagateChildTerminal(freshParent, undefined, cwd, output, commandStreamOptions)
      : 'not-applicable';
    output.flush();
    return propagated === 'blocked' ? 'blocked' : 'stopped';
  }
  if (drained.status === 'done') {
    await sessionService.releaseRunbook(parentRunId);
    const freshParent = await manager.load(parentRunId);
    const propagated = freshParent
      ? await propagateChildTerminal(freshParent, undefined, cwd, output, commandStreamOptions)
      : 'not-applicable';
    output.flush();
    if (propagated === 'blocked') return 'blocked';
    if (propagated === 'stopped') return 'stopped';
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
      { terminalReleaseMode: 'release-runbook', output, commandStreamOptions },
    );
    output.flush();

    if (loopResult === 'stopped') {
      const terminalParent = await manager.load(parentRunId);
      const propagated = terminalParent
        ? await propagateChildTerminal(terminalParent, undefined, cwd, output, commandStreamOptions)
        : 'not-applicable';
      return propagated === 'blocked' ? 'blocked' : 'stopped';
    }
    if (loopResult === 'done') {
      const terminalParent = await manager.load(parentRunId);
      const propagated = terminalParent
        ? await propagateChildTerminal(terminalParent, undefined, cwd, output, commandStreamOptions)
        : 'not-applicable';
      if (propagated === 'blocked') return 'blocked';
      if (propagated === 'stopped') return 'stopped';
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
 * @param commandStreamOptions - Runtime-only routing for command subprocess
 * stdout/stderr while inline propagation continues the parent
 * @returns 'not-applicable' when the child has no parent linkage; for inline,
 *          'handled' or 'stopped' (advancing the parent reached a STOP terminal);
 *          for delegation, 'reported' (the delegating run is collection pending)
 * @throws {Error} If state I/O fails or drain execution fails.
 */
export async function propagateChildTerminal(
  childState: RunbookState,
  result: 'pass' | 'fail' | undefined,
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
): Promise<TerminalPropagationResult> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';
  return linkage.kind === 'inline'
    ? advanceParentForInlineChild(childState, result, cwd, output, commandStreamOptions)
    : reportTerminalToDelegatingRun(childState, result, cwd, output);
}

/**
 * Whether the driving command authored an operator RESULT (`pass`/`fail`) or
 * relies on lifecycle inference. Making this a required discriminated param —
 * not a positional-optional `explicitResult` — encodes the operator-result vs
 * loop-inferred contract in the type: a loop driver cannot accidentally author a
 * result, and an operator-result command cannot forget to (SHOULD-FIX 5).
 */
export type PropagationTrigger =
  | { readonly kind: 'operator-result'; readonly result: DelegationOutcome }
  | { readonly kind: 'loop-inferred' };

/**
 * Outcome of {@link propagateDrivenRunTerminal}.
 *
 * `skipped` — the driven run was missing, non-terminal, or unlinked; the caller
 * MUST leave its exit code untouched. `inline-advanced` / `delegation-reported`
 * lift the linkage kind INTO the discriminant, so a caller branches on `kind`
 * alone and its `result` is already the narrow subset that branch can produce —
 * no `linkage:'delegation', result:'stopped'` dead pairs (SHOULD-FIX 4).
 */
export type DrivenRunPropagation =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'inline-advanced'; readonly result: InlinePropagationResult }
  | { readonly kind: 'delegation-reported'; readonly result: DelegationPropagationResult };

/**
 * Whether a propagation outcome must drive a non-zero process exit under the
 * **any-linkage** rule: the driven run propagated to a parent (inline OR
 * delegation) that stopped or blocked.
 *
 * This is the exit shape used by drivers that treat ANY non-skipped propagation
 * as exit-worthy — `rundown goto` (via
 * {@link gotoResultRequiresFailureExit}) and the `rundown run --step` inline
 * launch. It fires on a `delegation-reported` `blocked` too; `run --step` only
 * ever produces inline linkages so that arm is unreachable there, but `goto` can
 * drive a delegation child, and preserving the any-linkage semantics keeps its
 * pre-consolidation behaviour intact.
 *
 * Contrast {@link inlineAdvanceRequiresFailureExit}, the **inline-only** rule used
 * by `collect` and `pass`/`fail`, where delegation reporting is report-only and
 * never flips the exit code. Naming both shapes keeps the two exit semantics from
 * silently drifting back into open-coded copies.
 *
 * @param propagation - Outcome of {@link propagateDrivenRunTerminal}.
 * @returns `true` when the caller should exit non-zero.
 */
export function propagationRequiresFailureExit(propagation: DrivenRunPropagation): boolean {
  return (
    propagation.kind !== 'skipped' &&
    (propagation.result === 'stopped' || propagation.result === 'blocked')
  );
}

/**
 * Whether a propagation outcome must drive a non-zero process exit under the
 * **inline-only** rule: an inline child's drain-and-advance stopped or blocked the
 * composing parent.
 *
 * Used by `rundown collect` and `rundown pass`/`fail`, whose exit contract flips
 * only when advancing an INLINE parent reaches a STOP/blocked terminal. A
 * `delegation-reported` outcome is report-only (the delegating run collects later)
 * and never flips the exit here — so, unlike
 * {@link propagationRequiresFailureExit}, this returns `false` for every
 * non-`inline-advanced` kind.
 *
 * @param propagation - Outcome of {@link propagateDrivenRunTerminal}.
 * @returns `true` when the caller should exit non-zero.
 */
export function inlineAdvanceRequiresFailureExit(propagation: DrivenRunPropagation): boolean {
  return (
    propagation.kind === 'inline-advanced' &&
    (propagation.result === 'stopped' || propagation.result === 'blocked')
  );
}

/**
 * Trigger parent propagation for a run this command just drove, if it reached
 * terminal and carries a parent linkage.
 *
 * This is the SINGLE post-drive trigger every top-level driver uses (goto, run,
 * claim, collect, pass/fail). It reloads the driven run, and — only when that
 * run is terminal AND linked — dispatches on the linkage kind to
 * {@link advanceParentForInlineChild} / {@link reportTerminalToDelegatingRun}
 * directly (rather than through {@link propagateChildTerminal}) so each branch's
 * `result` keeps its narrow subtype without a cast. Consolidating the
 * reload-and-check here is what gives every driver, including `goto`,
 * propagation by construction rather than by each command remembering to do it.
 * {@link propagateChildTerminal} remains the single dispatcher for the
 * non-migrated seams (`terminal-command`, `execution.ts`) and the internal
 * inline recursion.
 *
 * The discriminated {@link DrivenRunPropagation} return is load-bearing: a bare
 * `'not-applicable'` sentinel let each caller conflate "nothing to propagate,
 * keep my exit code" with a real propagation outcome, and each hand-rolled its
 * own terminal guard around the exit mapping. Returning `{ kind: 'skipped' }`
 * forces every caller to narrow before touching the exit code, so the guard can
 * no longer be dropped (Task 3, Correction 2).
 *
 * The `trigger`'s authored result (for `operator-result`) is forwarded into
 * `projectDelegationTerminalOutcome`, which short-circuits on an explicit result
 * and otherwise infers from lifecycle. Operator-result commands (`pass`/`fail`)
 * MUST author their RESULT; loop-driven callers (goto/run/claim/collect) use
 * `loop-inferred` and rely on lifecycle inference (Correction 1).
 *
 * The propagation EXECUTION stays CLI-side because advancing an inline parent
 * runs the execution loop (spawns subprocesses — Category A); only this trigger
 * predicate (terminal + linked) is pure.
 *
 * Do NOT call this from inside {@link advanceParentForInlineChild} or from
 * `execution.ts`'s inline-launch propagation — those propagate a DIFFERENT run
 * (the parent being advanced / a downward-launched child) and routing them here
 * would double-propagate and break the single-level upward-report contract.
 *
 * The parameters stay positional (not an options bag) to match the sibling
 * dispatchers {@link advanceParentForInlineChild} /
 * {@link reportTerminalToDelegatingRun}; the distinct param types make a silent
 * argument swap a type error, so the options-object indirection buys nothing here.
 *
 * @param manager - State manager bound to `cwd`.
 * @param runId - The run this command just drove.
 * @param cwd - Current working directory.
 * @param output - Output emitter for CLI output.
 * @param trigger - Operator-result (authored `pass`/`fail`) or loop-inferred.
 * @param commandStreamOptions - Runtime-only routing for command subprocess I/O.
 * @returns `{ kind: 'skipped' }` when the run is missing, non-terminal, or
 *   unlinked; otherwise `inline-advanced` / `delegation-reported`.
 * @throws {Error} If parent state I/O fails or drain execution fails.
 */
export async function propagateDrivenRunTerminal(
  manager: RunbookStateManager,
  runId: RunId,
  cwd: string,
  output: OutputEmitter,
  trigger: PropagationTrigger,
  commandStreamOptions?: CommandExecutionStreamOptions,
): Promise<DrivenRunPropagation> {
  const driven = await manager.load(runId);
  if (!driven) return { kind: 'skipped' };
  if (driven.lifecycle !== 'completed' && driven.lifecycle !== 'stopped') {
    return { kind: 'skipped' };
  }
  const linkage = extractParentLinkage(driven);
  if (!linkage) return { kind: 'skipped' };
  const explicitResult = trigger.kind === 'operator-result' ? trigger.result : undefined;
  if (linkage.kind === 'inline') {
    const result = await advanceParentForInlineChild(
      driven,
      explicitResult,
      cwd,
      output,
      commandStreamOptions,
    );
    return { kind: 'inline-advanced', result };
  }
  const result = await reportTerminalToDelegatingRun(driven, explicitResult, cwd, output);
  return { kind: 'delegation-reported', result };
}
