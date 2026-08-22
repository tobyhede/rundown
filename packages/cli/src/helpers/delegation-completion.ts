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
 * Every refusal these adapters can receive travels as DATA on the seam's return
 * value and is rendered here, where the emitter lives — the tripped linkage
 * guard (#603) and, since #802, a drain that refused a persisted completion not
 * meant for the active cursor. Neither is thrown: an exception escaping the
 * Category-A callable unwinds past the renderer AND past `output.flush()`, so
 * the buffered parent stream is discarded and a fully diagnosed, permanent
 * refusal reaches the operator as RD-999 "Unknown error" — an envelope that
 * says nothing was diagnosed and whose only implied remedy is a retry that
 * cannot work. A throw from here means an UNDIAGNOSED failure and nothing else.
 *
 * @module helpers/delegation-completion
 */

import {
  RunbookStateManager,
  RunbookCompletionService,
  type AdvanceInlineParent,
  type InlineParentAdvanceRefusal,
  type LinkageCycleTrip,
  type PropagateTerminalChildUpwardDeps,
  type RunbookState,
  type ParentLinkage,
  type TerminalUpwardPropagationResult,
  type CommandExecutionStreamOptions,
  type DelegationOutcome,
  type DelegationRuntimeCapabilities,
  type RunId,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import type { OutputEmitter } from '../services/output-emitter.js';

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
 * Verified claim-bound delegation capabilities, named with the ONE run they may
 * be used for.
 *
 * `createDelegationCredentialIssuer` / `createDelegationTokenDeriver` close over
 * a single verified claim bearer, and the deriver throws
 * (`Delegation credential belongs to a different issuer claim`) for any
 * descriptor another claim issued. Carrying `runId` alongside the callables is
 * what lets a continuation that walks MORE than one run — the core inline
 * upward-propagation seam recurses up the whole composing chain — apply them to
 * the run whose authority they actually are, and to no other. Runtime-only: this
 * never enters persisted context (CLAUDE.md § Actor dependencies).
 */
export interface RunScopedDelegationRuntime {
  /** The only run these capabilities may be exercised for. */
  readonly runId: RunId;
  /**
   * The branded issuer/deriver pair, when the caller holds one for `runId`.
   *
   * One field rather than two independently optional callables: both halves
   * bind to the same verified authority by construction, so scoping them is one
   * decision about one value rather than two decisions that could disagree.
   */
  readonly runtime?: DelegationRuntimeCapabilities;
}

/**
 * Narrow a run-scoped delegation runtime to the run currently being advanced.
 *
 * @param runtime - Capabilities bound to one run, when the caller holds any.
 * @param runId - Run the continuation is about to drive.
 * @returns The capabilities when they belong to `runId`, otherwise `undefined`.
 */
function delegationRuntimeFor(
  runtime: RunScopedDelegationRuntime | undefined,
  runId: RunId,
): DelegationRuntimeCapabilities | undefined {
  return runtime?.runId === runId ? runtime.runtime : undefined;
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
 * release owner and releases parentRunId once, as `addressed`, on terminal. The
 * drain performs no release of its own, and the execution loop is
 * invoked with `terminalReleaseMode: 'defer-to-caller'` (Task 3) so it too skips
 * release — and, in that mode, hands back its own drain refusal as data rather
 * than a `'stopped'` this callable would forward as a terminal (#802). This closes the ownership gap: there is exactly one release site with
 * one deliberate claim disposition, so the tombstone-destruction hazard the old
 * two-owner code carried (drain deleted, loop retained) cannot recur (RD-598).
 *
 * The heavy CLI collaborators are imported LAZILY to avoid a static
 * delegation-completion ↔ execution import cycle.
 *
 * Both halves of the continuation — the drain and the loop — can step the
 * composing parent INTO a DELEGATE step: the drain's aggregation transition is
 * what enters the next step, and the loop's command transitions are what enter
 * later ones. Machine-owned delegation issuance needs a verified issuer at that
 * moment, and the following loop turn needs the same-issuer deriver to project
 * the persisted frontier. `parentDelegationRuntime` carries both, scoped by
 * {@link delegationRuntimeFor} to the exact run they were minted for — the core
 * seam recurses up the whole inline chain through this one callable, and an
 * ancestor advanced under a descendant's authority would be refused RD-821
 * rather than helped.
 *
 * @param cwd - Current working directory.
 * @param output - Output emitter for streamed parent events.
 * @param commandStreamOptions - Runtime-only routing for command subprocess I/O.
 * @param parentDelegationRuntime - Verified capabilities the caller holds for one
 *   specific run; applied only when the seam advances that run.
 * @returns The runtime callable the core seam invokes.
 */
export function buildAdvanceInlineParent(
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
  parentDelegationRuntime?: RunScopedDelegationRuntime,
): AdvanceInlineParent {
  return async ({ parentRunId, parentFrameKey, parentEntry, result }) => {
    // Core symbols used ONLY on this execution path are imported lazily too, so
    // the module's static surface stays minimal — test doubles that mock
    // `@rundown-org/core` need not supply `exactFrame`.
    const { exactFrame } = await import('@rundown-org/core');
    const { drainResolvedCompletions, refusalFromDrainFailure, runExecutionLoop } = await import(
      '../services/execution.js'
    );
    const { getRunbookFromState } = await import('./runbook-loader.js');
    const { createBridgedEmitter } = await import('./execution-emitter.js');
    const { createPassTransitionConfig, createFailTransitionConfig } = await import(
      './transitions.js'
    );

    const manager = new RunbookStateManager(cwd);
    const parentActorService = createCliRunbookActorService(manager);

    const transitionConfig =
      result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();

    const parentState = await manager.load(parentRunId);
    // Defensive: core already recorded against this parent, so it existed then.
    // If it has since vanished, there is nothing to advance and nothing to
    // release — report `active` (the seam treats it as handled).
    if (!parentState) return { status: 'active' };

    const delegationRuntime = delegationRuntimeFor(parentDelegationRuntime, parentRunId);

    const parentSteps = [...getRunbookFromState(parentState, cwd)];
    const emitter = createBridgedEmitter(parentState, output);
    const drained = await drainResolvedCompletions({
      actorService: parentActorService,
      manager,
      emitter,
      runbookId: parentRunId,
      steps: parentSteps,
      currentState: parentState,
      computeActionResult: transitionConfig.computeActionResult,
      frameOverride: exactFrame(parentFrameKey, parentEntry),
      issueDelegationCredential: delegationRuntime?.issueDelegationCredential,
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
      // A DIAGNOSED, permanent refusal: core rejected a persisted completion
      // that is not for the active cursor. It travels back as data (#802) — the
      // `refused` arm of the seam's outcome — for the same reason the linkage
      // trip does. Thrown, it unwound past the adapter's renderer AND past this
      // flush, so the operator lost both the buffered parent stream and the
      // reason, and was handed RD-999 "Unknown error" telling them to retry
      // something a retry cannot fix.
      output.flush();
      // Built by the drain's own module, never spelled here: two literals of
      // this object left the loop and this callable free to describe one fact
      // differently, which is the property the shared code exists to guarantee.
      return { status: 'refused', refusal: refusalFromDrainFailure(parentRunId, drained) };
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
        emitter,
        // 'defer-to-caller': the loop does NOT release parentRunId — the core seam
        // is the sole release owner and releases once (with retain) on terminal.
        // See Task 3 for the mode; RD-598 verification for why single-owner.
        {
          terminalReleaseMode: 'defer-to-caller',
          output,
          commandStreamOptions,
          delegationRuntime,
        },
      );
      output.flush();
      // The loop's own drain can refuse the same way this callable's did, and
      // in `defer-to-caller` it hands the refusal back rather than reporting a
      // `'stopped'` this callable would forward as a terminal — which would
      // have the seam release a still-running parent and recurse upward on a
      // terminal that never happened.
      //
      //
      // The three TERMINAL statuses are exhausted first and the refusal is what
      // is left, rather than the refusal being picked off by a `typeof` test. A
      // shape test says only "not one of these strings", so a second
      // object-shaped arm added to the deferred result would be swallowed and
      // forwarded as `{status: 'refused', refusal: undefined}` with no compile
      // error. Reaching the refusal by exclusion makes that a type error at
      // `.refusal` instead — and, unlike an explicit `kind === 'refused'`
      // check, it does not read as a redundant test of the union's only object
      // member.
      if (loopResult === 'stopped') return { status: 'stopped' };
      if (loopResult === 'done') return { status: 'done' };
      if (loopResult === 'waiting') return { status: 'active' };
      return { status: 'refused', refusal: loopResult.refusal };
    }

    // applied === 0: waiting for sibling substeps to resolve.
    output.flush();
    return { status: 'active' };
  };
}

/**
 * Render a tripped linkage guard (Category A: terminal rendering).
 *
 * Renders only. The message and the `INLINE_PARENT_CYCLE` code are composed by
 * core (#602) — choosing what a corrupt linkage graph says to an operator is
 * runbook logic, and the CLI is a thin wrapper. This mirrors the force-terminal
 * path, where core's `LifecycleTerminalOutcome` already carries both for the same
 * fact and the CLI merely renders them.
 *
 * Called by whichever frontend holds the trip, at the point it collapses the
 * refusal onto its own fail-closed member (#603) — the three adapters below, and
 * `rundown collect`, which receives the trip on `terminalInlineAdvance`. It is
 * NOT a core dependency: core cannot express "render once, only on a refusal" in
 * a `void` callback's type, and the callers that never walk had to stub one.
 *
 * Each adapter renders BEFORE its `output.flush()`, which is exactly where the
 * former sink's output landed, so the emitted stream is unchanged.
 *
 * @param output - Output emitter owned by the calling command.
 * @param trip - The core-composed trip: cause, the run it found, message, code.
 */
export function emitLinkageCycleDiagnostic(output: OutputEmitter, trip: LinkageCycleTrip): void {
  output.error(trip.message, trip.code, {
    cause: trip.cause,
    runId: trip.cause === 'repeat' ? trip.repeatedRunId : trip.deepestRunId,
  });
}

/**
 * Render a refused inline parent-advance (Category A: terminal rendering).
 *
 * The sibling of {@link emitLinkageCycleDiagnostic}, and it exists for the same
 * three reasons: core composed the message and the code, the adapter that owns
 * the emitter is the only place that knows when a refusal is terminal for this
 * command, and rendering here puts the envelope ahead of the `output.flush()`
 * that the previous `throw` skipped entirely (#802).
 *
 * `reason` and `runId` ride in `details` — the same pair of jobs
 * {@link emitLinkageCycleDiagnostic}'s `cause`/`runId` do. The reason lets an
 * agent route on the diagnosis rather than re-deriving it from the prose, and
 * the run id is the only place the refusing run is named: neither of core's
 * `target_mismatch` messages carries one, and the walk recurses, so the run
 * that refused is routinely an ancestor rather than the one the operator
 * invoked.
 *
 * @param output - Output emitter owned by the calling command.
 * @param refusal - The core-diagnosed refusal: reason, message, code.
 */
export function emitAdvanceRefusalDiagnostic(
  output: OutputEmitter,
  refusal: InlineParentAdvanceRefusal,
): void {
  output.error(refusal.message, refusal.code, {
    reason: refusal.reason,
    runId: refusal.runId,
  });
}

/**
 * Whether the seam refused, on either of the two arms that carry a refusal.
 *
 * The ONE place that answers this question. Four sites need it — the three
 * adapters below and `rundown collect` — and each needs it twice, once to
 * render and once to decide the exit. Spelling the arm set at each of the eight
 * points is how the two arms would come to be handled differently: `collect`
 * would keep rendering a trip it no longer failed closed on, or an adapter
 * would fail closed on a refusal it never rendered.
 *
 * @param outcome - A propagation outcome, or `undefined` when the walk never ran.
 * @returns True when the outcome is a refusal the caller must fail closed on.
 */
export function isInlinePropagationRefusal(
  outcome: TerminalUpwardPropagationResult | undefined,
): outcome is Extract<
  TerminalUpwardPropagationResult,
  { readonly kind: 'linkage-cycle' | 'advance-refused' }
> {
  return outcome?.kind === 'linkage-cycle' || outcome?.kind === 'advance-refused';
}

/**
 * Render whichever refusal the seam returned, and say whether it refused.
 *
 * The shared refusal-renderer protocol (`refusal-renderers.ts`,
 * `session-mutation-result.ts`): render and return `true` on a refusal, render
 * nothing and return `false` otherwise, so a caller decides its exit from the
 * same call that produced the operator's diagnostic. Callers still own their
 * `output.flush()` — its POSITION differs between the adapters (which flush
 * unconditionally) and `collect` (which must flush here to keep the applied
 * action object last), and that difference is theirs to state.
 *
 * @param output - Output emitter owned by the calling command.
 * @param outcome - A propagation outcome, or `undefined` when the walk never ran.
 * @returns True when a refusal was rendered.
 */
export function renderInlinePropagationRefusal(
  output: OutputEmitter,
  outcome: TerminalUpwardPropagationResult | undefined,
): boolean {
  if (!isInlinePropagationRefusal(outcome)) return false;
  if (outcome.kind === 'linkage-cycle') {
    emitLinkageCycleDiagnostic(output, outcome.trip);
    return true;
  }
  emitAdvanceRefusalDiagnostic(output, outcome.refusal);
  return true;
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
 * @param parentDelegationRuntime - Verified delegation capabilities bound to one
 *   run, forwarded to {@link buildAdvanceInlineParent}.
 * @returns Deps for the core `propagateTerminalChildUpward` seam.
 */
export async function buildInlineParentAdvanceDeps(
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
  parentDelegationRuntime?: RunScopedDelegationRuntime,
): Promise<PropagateTerminalChildUpwardDeps> {
  const { SessionService } = await import('@rundown-org/core');
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const completionService = new RunbookCompletionService(manager, actorService);
  const sessionService = new SessionService(manager);
  return {
    manager,
    sessionService,
    completionService,
    advanceInlineParent: buildAdvanceInlineParent(
      cwd,
      output,
      commandStreamOptions,
      parentDelegationRuntime,
    ),
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
  // #603/#802: a refusal rides the seam's return value, so render it here —
  // this adapter owns the emitter — before the flush the sink's output used to
  // precede. `advance-refused` is unreachable through a delegation linkage,
  // which takes the seam's report-only arm; it is still narrowed away here so
  // the member cannot be silently dropped into a `return outcome.kind` that has
  // no member to receive it.
  renderInlinePropagationRefusal(output, outcome);
  output.flush();
  // A delegation linkage yields 'reported' | 'duplicate' | 'blocked' |
  // 'linkage-cycle' | 'not-applicable' from the seam. The CLI never distinguished a
  // duplicate from a fresh report, so collapse 'duplicate' back into 'reported'
  // (finding 2), and narrow away the inline-only members — all without a cast.
  if (outcome.kind === 'handled' || outcome.kind === 'stopped') return 'not-applicable';
  if (outcome.kind === 'duplicate') return 'reported';
  // #602/#802: a refusal is fail-closed. 'blocked' is this adapter's
  // pre-existing "could not propagate; exit non-zero" member, so map onto it
  // explicitly rather than inventing a CLI-visible member no caller can act on.
  if (isInlinePropagationRefusal(outcome)) return 'blocked';
  return outcome.kind;
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
 *          'blocked' when the walk or the advance refused (the refusal is
 *          rendered here first), 'not-applicable' when the child has no parent
 *          linkage
 * @throws {Error} If parent state I/O fails, or the advance fails for a reason
 *   it has not diagnosed. The drain's own `target_mismatch` is NOT a throw: it
 *   is rendered and collapsed onto 'blocked' (#802).
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
  // #603/#802: render the returned refusal before the flush (see the delegation
  // adapter). For `advance-refused` — the drain refusal the callable used to
  // throw — that ordering is the fix: the reason reaches the operator under its
  // own code, and the buffered parent stream is not discarded on the way out.
  renderInlinePropagationRefusal(output, outcome);
  // Flush any buffered parent-stream output the seam produced (the callable
  // flushes on its advance paths, but a record-only short-circuit — e.g. a
  // 'blocked'/'cancelled' record — returns before the callable runs).
  output.flush();
  // An inline linkage never yields the delegation-only 'reported' / 'duplicate';
  // narrow them away without a cast. #602/#802: a refusal is fail-closed onto
  // this adapter's pre-existing 'blocked'.
  if (isInlinePropagationRefusal(outcome)) return 'blocked';
  return outcome.kind === 'reported' || outcome.kind === 'duplicate'
    ? 'not-applicable'
    : outcome.kind;
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
 * @param parentDelegationRuntime - Verified delegation capabilities the caller
 *   holds for one specific run. The inline flow-back caller in
 *   `services/execution.ts` is running the composing parent's own loop, so it
 *   holds that parent's run-control authority and must hand it on: without it a
 *   parent whose next step is a DELEGATE step is refused
 *   `actor_context_required` rather than advanced. Scoped by run id, so the
 *   seam's walk up the rest of the inline chain does not inherit it.
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
  parentDelegationRuntime?: RunScopedDelegationRuntime,
): Promise<TerminalPropagationResult> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';
  const { propagateTerminalChildUpward } = await import('@rundown-org/core');
  const outcome = await propagateTerminalChildUpward(
    await buildInlineParentAdvanceDeps(cwd, output, commandStreamOptions, parentDelegationRuntime),
    childState,
    result,
  );
  // #603/#802: render the returned refusal before the flush (see the delegation
  // adapter) — the diagnosed drain refusal reaches the operator here rather
  // than escaping as a throw past this flush.
  renderInlinePropagationRefusal(output, outcome);
  // Flush any buffered parent-stream output the seam produced (matches the old
  // dispatch, where both sub-adapters flushed).
  output.flush();
  // TerminalPropagationResult has no 'duplicate' member (the CLI never
  // distinguished it); collapse to 'reported' (finding 2). #602/#802: nor a
  // refusal member; collapse those to the fail-closed 'blocked'. All other
  // members are shared between the seam union and TerminalPropagationResult.
  if (isInlinePropagationRefusal(outcome)) return 'blocked';
  return outcome.kind === 'duplicate' ? 'reported' : outcome.kind;
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
