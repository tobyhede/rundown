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
 * Post-RD-598, the DECISION + single-level upward-report orchestration for both
 * linkage kinds lives in `@rundown-org/core`'s
 * {@link propagateTerminalChildUpward}. The functions here are thin adapters over
 * that seam: they narrow the child's linkage, build the deps bag, and map the
 * seam's union onto each adapter's pre-existing return type. The CLI supplies
 * only the Category-A execution callable ({@link buildAdvanceInlineParent}) —
 * loading the parent, draining, and running the execution loop (subprocess
 * spawn). Release is owned solely by the core seam.
 *
 * @module helpers/delegation-completion
 */

import {
  RunbookStateManager,
  ExecutionLifecycleService,
  RunbookCompletionService,
  type AdvanceInlineParent,
  type OnLinkageCycle,
  type PropagateTerminalChildUpwardDeps,
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
 * Build the CLI-supplied inline parent-advance callable (Category A execution).
 *
 * This is the extracted execution body of the former
 * {@link advanceParentForInlineChild}: it loads the parent, drains resolved
 * completions on the target frame, and — when completions applied but the parent
 * is still active — runs the execution loop (spawning command subprocesses). It
 * collapses the drain/loop statuses into the seam's `AdvanceInlineParentOutcome`.
 * It performs NO terminal session release on ANY path — the core seam is the SOLE
 * release owner and releases parentRunId once, with `retainClaimsAsTerminal: true`,
 * on terminal. The drain uses a non-releasing policy, and the execution loop is
 * invoked with `terminalReleaseMode: 'defer-to-caller'` (Task 3) so it too skips
 * release. This closes the ownership gap: there is exactly one release site with
 * one deliberate claim disposition, so the tombstone-destruction hazard the old
 * two-owner code carried (drain deleted, loop retained) cannot recur (RD-598).
 *
 * The heavy CLI collaborators are imported LAZILY to avoid a static
 * delegation-completion ↔ execution import cycle.
 *
 * @param cwd - Current working directory.
 * @param output - Output emitter for streamed parent events.
 * @param commandStreamOptions - Runtime-only routing for command subprocess I/O.
 * @returns The runtime callable the core seam invokes.
 * @throws {Error} If drain reports a hard failure (`target_mismatch`).
 */
export function buildAdvanceInlineParent(
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
): AdvanceInlineParent {
  return async ({ parentRunId, parentFrameKey, parentEntry, result }) => {
    // Core symbols used ONLY on this execution path are imported lazily too, so
    // the module's static surface stays minimal — test doubles that mock
    // `@rundown-org/core` need not supply `SessionService` / `exactFrame`.
    const { SessionService, exactFrame } = await import('@rundown-org/core');
    const { drainResolvedCompletions, runExecutionLoop } = await import('../services/execution.js');
    const { getRunbookFromState } = await import('./runbook-loader.js');
    const { createBridgedEmitter } = await import('./execution-emitter.js');
    const { createPassTransitionConfig, createFailTransitionConfig } = await import(
      './transitions.js'
    );

    const manager = new RunbookStateManager(cwd);
    const parentActorService = createCliRunbookActorService(manager);
    const sessionService = new SessionService(manager);
    const lifecycleService = new ExecutionLifecycleService(manager);

    const transitionConfig =
      result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();
    // Never release during drain — the core seam owns the single terminal release.
    const inlinePolicy: TransitionOrchestrationPolicy = {
      onComplete: { releaseRunbook: false },
      onStopped: { releaseRunbook: false },
    };

    const parentState = await manager.load(parentRunId);
    // Defensive: core already recorded against this parent, so it existed then.
    // If it has since vanished, there is nothing to advance and nothing to
    // release — report `active` (the seam treats it as handled).
    if (!parentState) return { status: 'active' };

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
      frameOverride: exactFrame(parentFrameKey, parentEntry),
    });

    if (drained.status === 'stopped') {
      output.flush();
      return { status: 'stopped' };
    }
    if (drained.status === 'done') {
      output.flush();
      return { status: 'done' };
    }
    if (drained.status === 'failed') {
      throw new Error(drained.message);
    }
    if (drained.status === 'not_active') {
      output.flush();
      return { status: 'active' };
    }

    // status === 'continue': completions applied but the parent is still active.
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
        // 'defer-to-caller': the loop does NOT release parentRunId — the core seam
        // is the sole release owner and releases once (with retain) on terminal.
        // See Task 3 for the mode; RD-598 verification for why single-owner.
        { terminalReleaseMode: 'defer-to-caller', output, commandStreamOptions },
      );
      output.flush();
      if (loopResult === 'stopped') return { status: 'stopped' };
      if (loopResult === 'done') return { status: 'done' };
      return { status: 'active' };
    }

    // applied === 0: waiting for sibling substeps to resolve.
    output.flush();
    return { status: 'active' };
  };
}

/**
 * Build the CLI's linkage-guard diagnostic sink (Category A: terminal rendering).
 *
 * Renders only. The message and the `INLINE_PARENT_CYCLE` code are composed by
 * core (#602) — choosing what a corrupt linkage graph says to an operator is
 * runbook logic, and the CLI is a thin wrapper. This mirrors the force-terminal
 * path, where core's `LifecycleTerminalOutcome` already carries both for the same
 * fact and the CLI merely renders them.
 *
 * The adapters call `output.flush()` after the seam returns, so the emitted
 * diagnostic lands with the rest of the command's output.
 *
 * @param output - Output emitter owned by the calling command.
 * @returns The sink to place on the core deps bag.
 */
export function buildLinkageCycleDiagnostic(output: OutputEmitter): OnLinkageCycle {
  return (trip) => {
    output.error(trip.message, trip.code, {
      cause: trip.cause,
      runId: trip.cause === 'repeat' ? trip.repeatedRunId : trip.deepestRunId,
    });
  };
}

/**
 * Construct the core seam deps bag bound to one command's `cwd`, wiring the
 * CLI-supplied {@link buildAdvanceInlineParent} callable.
 *
 * `SessionService` is imported lazily (like the callable's core symbols) so this
 * module keeps a minimal static `@rundown-org/core` surface; the function is
 * therefore async.
 *
 * @param cwd - Current working directory.
 * @param output - Output emitter for streamed parent events.
 * @param commandStreamOptions - Runtime-only routing for command subprocess I/O.
 * @returns Deps for the core `propagateTerminalChildUpward` seam.
 */
export async function buildInlineParentAdvanceDeps(
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
): Promise<PropagateTerminalChildUpwardDeps> {
  const { SessionService } = await import('@rundown-org/core');
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
  const sessionService = new SessionService(manager);
  return {
    manager,
    sessionService,
    completionService,
    advanceInlineParent: buildAdvanceInlineParent(cwd, output, commandStreamOptions),
    onLinkageCycle: buildLinkageCycleDiagnostic(output),
  };
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
  const { propagateTerminalChildUpward } = await import('@rundown-org/core');
  const outcome = await propagateTerminalChildUpward(
    await buildInlineParentAdvanceDeps(cwd, output),
    childState,
    result,
  );
  output.flush();
  // A delegation linkage yields 'reported' | 'duplicate' | 'blocked' |
  // 'linkage-cycle' | 'not-applicable' from the seam. The CLI never distinguished a
  // duplicate from a fresh report, so collapse 'duplicate' back into 'reported'
  // (finding 2), and narrow away the inline-only members — all without a cast.
  if (outcome === 'handled' || outcome === 'stopped') return 'not-applicable';
  if (outcome === 'duplicate') return 'reported';
  // #602: a corrupt linkage graph is fail-closed. 'blocked' is this adapter's
  // pre-existing "could not propagate; exit non-zero" member, so map onto it
  // explicitly rather than inventing a CLI-visible member no caller can act on.
  if (outcome === 'linkage-cycle') return 'blocked';
  return outcome;
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
  const { propagateTerminalChildUpward } = await import('@rundown-org/core');
  const outcome = await propagateTerminalChildUpward(
    await buildInlineParentAdvanceDeps(cwd, output, commandStreamOptions),
    childState,
    result,
  );
  // Flush any buffered parent-stream output the seam produced (the callable
  // flushes on its advance paths, but a record-only short-circuit — e.g. a
  // 'blocked'/'cancelled' record — returns before the callable runs).
  output.flush();
  // An inline linkage never yields the delegation-only 'reported' / 'duplicate';
  // narrow them away without a cast. #602: a tripped linkage guard is fail-closed
  // onto this adapter's pre-existing 'blocked'.
  if (outcome === 'linkage-cycle') return 'blocked';
  return outcome === 'reported' || outcome === 'duplicate' ? 'not-applicable' : outcome;
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
  const { propagateTerminalChildUpward } = await import('@rundown-org/core');
  const outcome = await propagateTerminalChildUpward(
    await buildInlineParentAdvanceDeps(cwd, output, commandStreamOptions),
    childState,
    result,
  );
  // Flush any buffered parent-stream output the seam produced (matches the old
  // dispatch, where both sub-adapters flushed).
  output.flush();
  // TerminalPropagationResult has no 'duplicate' member (the CLI never
  // distinguished it); collapse to 'reported' (finding 2). #602: nor a
  // 'linkage-cycle' member; collapse to the fail-closed 'blocked'. All other
  // members are shared between the seam union and TerminalPropagationResult.
  if (outcome === 'linkage-cycle') return 'blocked';
  return outcome === 'duplicate' ? 'reported' : outcome;
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
