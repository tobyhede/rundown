/**
 * The human escape hatch for a lost top-level Owner Token (#906, ADR 0005).
 *
 * A run id authorizes nothing — except here. When the Owner Token of a
 * top-level run is lost, nothing else can end the run: a lost Claim Ticket or
 * child token is recovered by `retry` and `release`, but a top-level run has
 * no parent to cancel it. So a human may stop it by id, through an
 * interactive, audited `rundown stop --run <id>`. The front end decides that a
 * human is at a terminal and has confirmed (Category A); this module decides
 * what the id may stop, and stops it.
 *
 * A human stopping a run means the whole run. The running Inline Children it
 * composes — its Current Inline Child, transitively — have no Owner Token of
 * their own: the lost token was their only authority, so once the root is
 * stopped nothing could reach them. They stop with it, each through its own
 * machine's `FORCE_STOP`, in one conditional write that commits every run at
 * the version it was read at or none — the pattern `release` uses (#905). The
 * execution-lease rule applies to each before the human is asked: an attempt
 * In Progress anywhere in the chain refuses the stop. The audit
 * ({@link HumanStopAudit}) is written on the root by the same write. Only a
 * top-level run can be named: an Inline Child runs on its root's token, and a
 * Delegation has its own recoveries.
 *
 * Front ends that cannot prove a human is present — MCP, the scenario
 * harness, an agent's shell — must not reach this module.
 *
 * @module runbook/human-stop
 */

import { deriveTransitionObservation } from '../events/transition-observation.js';
import type { TransitionObservationEvent } from '../events/transition-observation.js';
import { delegationStandingOf } from './delegation-progression.js';
import { RUN_TARGET_UNAVAILABLE_CODE, runningInlineChain } from './delegation-recovery.js';
import { refuseUnderLease, type ExecutionLeaseRefusal } from './execution-lease.js';
import { MAX_INLINE_CHILD_DEPTH } from './inline-progression.js';
import type {
  ConcurrentModificationRefusal,
  RunbookLifecycleCommandServiceDependencies,
  RunFinishedRefusal,
} from './lifecycle-command-service.js';
import type { OwnedRun } from './run-authority.js';
import type { RunId } from './run-id.js';
import type { RunbookRef } from './runbook-ref.js';
import type { VersionedRunState } from './storage/runbook-store.js';
import type { HumanStopAudit, RunbookState } from './types.js';

/** Code of the refusal of a run id that names a Child Run. */
export const NOT_A_TOP_LEVEL_RUN_CODE = 'NOT_A_TOP_LEVEL_RUN';

/** The core services the escape hatch drives: the lifecycle seam's own. */
export type HumanStopDeps = RunbookLifecycleCommandServiceDependencies;

/** A refusal of the run id the human named: nothing was asked or written. */
export type HumanStopTargetRefusal =
  | RunFinishedRefusal
  | ExecutionLeaseRefusal
  | {
      /** No run carries the id, or it was pruned before the stop landed. */
      readonly kind: 'unknown_run';
      readonly code: typeof RUN_TARGET_UNAVAILABLE_CODE;
      readonly runId: RunId;
      readonly message: string;
    }
  | {
      /** The id names a Child Run, which the escape hatch never stops. */
      readonly kind: 'not_top_level';
      readonly code: typeof NOT_A_TOP_LEVEL_RUN_CODE;
      readonly runId: RunId;
      readonly message: string;
    };

/** Outcome of {@link resolveHumanStopTarget}. */
export type HumanStopTargetResolution =
  | {
      /** A running top-level run, as read: the human is asked about this. */
      readonly kind: 'target';
      readonly run: OwnedRun;
      /** The running Inline Children it composes, nearest first, stopped with it. */
      readonly inline: readonly VersionedRunState[];
    }
  | HumanStopTargetRefusal;

/** One run a human stop ended, with the observation its machine produced. */
export interface HumanStoppedRun {
  readonly runId: RunId;
  readonly runbook: RunbookRef;
  /** Terminal observation events for the frontend to render. */
  readonly events: readonly TransitionObservationEvent[];
}

/** Outcome of {@link stopByHuman}. */
export type HumanStopOutcome =
  | ConcurrentModificationRefusal
  | Extract<HumanStopTargetRefusal, { readonly kind: 'unknown_run' }>
  | {
      readonly kind: 'applied';
      /** The root, stopped with the audit. */
      readonly root: HumanStoppedRun;
      /** The running Inline Children stopped with it, nearest first. */
      readonly inline: readonly HumanStoppedRun[];
    };

/** Read a run of one store by id: the store itself, or one listing of it. */
export type RunLookup = (
  runId: RunId,
) => VersionedRunState | null | undefined | Promise<VersionedRunState | null | undefined>;

/**
 * The refusal of a run id that names no run.
 *
 * @param runId - The id the human named.
 * @returns The refusal.
 */
function unknownRun(
  runId: RunId,
): Extract<HumanStopTargetRefusal, { readonly kind: 'unknown_run' }> {
  return {
    kind: 'unknown_run',
    code: RUN_TARGET_UNAVAILABLE_CODE,
    runId,
    message: `No run ${runId} exists; nothing was stopped. List runs with \`rundown status\`.`,
  };
}

/** What {@link childRunRemedy} reads to name the recoveries that reach a child. */
export interface ChildRunContext {
  /** Reads the runs above the child. */
  readonly lookup: RunLookup;
  /**
   * Whether a Delegation's parent still counts it — the one case its parent's
   * owner can cancel it with `retry`.
   */
  readonly counted: (delegation: VersionedRunState) => boolean | Promise<boolean>;
}

/**
 * The recoveries that can still reach a Delegation.
 *
 * @param run - The Delegation, live or orphaned.
 * @param counted - Whether its parent still counts it.
 * @returns The remedy clause.
 */
function delegationRemedy(run: VersionedRunState, counted: boolean): string {
  const own = `its owner stops it with \`rundown stop --token <owner_token>\`, or its claiming agent ends it with \`rundown release ${run.state.id}\` (with the \`--agent-id\` it claimed with, if any)`;
  const linkage = run.linkage;
  if (linkage?.kind === 'orphaned_delegation') {
    return `its parent run was pruned, so nothing cancels it: ${own}`;
  }
  if (linkage?.kind !== 'delegation' || !counted) return own;
  return `${own}, or the owner of run ${linkage.parentRunId} cancels it with \`rundown retry --step ${linkage.parentStep} --token <owner_token>\``;
}

/**
 * How a running Child Run can still be ended, naming only recoveries that
 * reach it (#906).
 *
 * An Inline Child runs on the Owner Token of the run at the top of its inline
 * chain — a top-level run, or a Delegation — so the remedy names that run,
 * never an intermediate Inline Child (which is itself refused). A Delegation
 * is ended by its own token or its claiming agent's `release`, and, while its
 * parent still counts it, by its parent's owner's `retry`; an orphaned one
 * has no parent to ask.
 *
 * @param run - The Child Run.
 * @param context - Reads the runs above it, and whether a parent counts it.
 * @returns The remedy clause.
 * @throws {Error} When the inline chain above is deeper than any run can
 *   compose — a defect, not an operator condition.
 */
export async function childRunRemedy(
  run: VersionedRunState,
  context: ChildRunContext,
): Promise<string> {
  let holder = run;
  for (let level = 0; level <= MAX_INLINE_CHILD_DEPTH; level++) {
    if (holder.linkage?.kind !== 'inline') {
      const remedy = delegationRemedy(holder, await context.counted(holder));
      if (holder === run) return remedy;
      const id = holder.state.id;
      return holder.linkage === null
        ? `it is an inline child, which runs on the owner token of run ${id} and goes with it: stop run ${id} with \`rundown stop --token <owner_token>\`, or with \`rundown stop --run ${id}\` if that token is lost, which stops its inline children with it`
        : `it is an inline child, which runs on the owner token of delegation ${id} and goes with it: ${remedy}`;
    }
    const parent = await context.lookup(holder.linkage.parentRunId);
    // Deleting a run deletes its Inline Children, so a listed one has a parent.
    if (parent === null || parent === undefined) {
      return 'it is an inline child, which runs on the owner token of the run that composed it and goes with it';
    }
    holder = parent;
  }
  throw new Error(
    `Inline chain above run ${run.state.id} is deeper than ${String(MAX_INLINE_CHILD_DEPTH)}`,
  );
}

/**
 * Decide whether the escape hatch may stop the run a human named, before the
 * human is asked to confirm it.
 *
 * Refuses an id that names no run, a finished run, and a Child Run — naming
 * the recovery that applies to it — and applies the execution-lease rule to
 * the run and each running Inline Child it composes: an attempt In Progress
 * anywhere in the chain refuses the stop, so the human is never asked to
 * confirm a stop that would be refused. A target carries every run at the
 * version it was read at: if any moves while the human decides, the stop is
 * refused rather than applied to a state they did not see.
 *
 * @param deps - Store, graph loader and process identity.
 * @param runId - The run the human named.
 * @returns The target, or the refusal.
 * @throws {Error} When the inline chain is deeper than any run can drive.
 */
export async function resolveHumanStopTarget(
  deps: Pick<HumanStopDeps, 'manager' | 'loadSteps' | 'processIdentity'>,
  runId: RunId,
): Promise<HumanStopTargetResolution> {
  const run = await deps.manager.loadWithVersion(runId);
  if (run === null) return unknownRun(runId);
  if (run.linkage !== null) {
    const remedy = await childRunRemedy(run, {
      lookup: (id) => deps.manager.loadWithVersion(id),
      counted: async (delegation) =>
        (await delegationStandingOf(deps, delegation)).kind === 'current',
    });
    return {
      kind: 'not_top_level',
      code: NOT_A_TOP_LEVEL_RUN_CODE,
      runId,
      message: `Run ${runId} is a child run, which the escape hatch never stops; ${remedy}. Nothing was stopped.`,
    };
  }
  const lifecycle = run.state.lifecycle ?? 'running';
  if (lifecycle !== 'running') return { kind: 'run_finished', runId, lifecycle };
  const inline = await runningInlineChain(deps, run.state);
  for (const listed of [run, ...inline]) {
    const leased = refuseUnderLease(
      listed.state.id,
      listed.state,
      listed.lease,
      'stop',
      deps.processIdentity,
    );
    if (leased) return leased;
  }
  return { kind: 'target', run, inline };
}

/**
 * Stop a top-level run, and the running Inline Children it composes, by id,
 * for a human who lost its Owner Token and confirmed the stop.
 *
 * Each run takes its own machine's `FORCE_STOP`; the root's state also takes
 * the audit. One conditional write commits them all at the versions
 * {@link resolveHumanStopTarget} read, clearing an Interrupted attempt's lease
 * as `stop` always does, or writes nothing: a write since the read — an
 * attempt taken, a child launched, a step moved — is refused, never retried.
 *
 * @param deps - Store, actor service and graph loader.
 * @param target - The run {@link resolveHumanStopTarget} resolved.
 * @param audit - Who confirmed the stop, when, and their message.
 * @returns The refusal, or the stopped runs with their observations.
 * @throws {Error} When a committed run is not `stopped` — the machine ignored
 *   `FORCE_STOP`, which is a defect — or its cursor names a step its runbook
 *   does not define.
 */
export async function stopByHuman(
  deps: HumanStopDeps,
  target: Extract<HumanStopTargetResolution, { readonly kind: 'target' }>,
  audit: HumanStopAudit,
): Promise<HumanStopOutcome> {
  const runs = [target.run, ...target.inline];
  const prepared = await Promise.all(
    runs.map(async (run) => {
      const steps = await deps.loadSteps(run.state);
      const mutation = await deps.actorService.prepareActorMutation(
        run.state.id,
        run.state,
        steps,
        {
          type: 'FORCE_STOP',
          ...(audit.message !== undefined ? { message: audit.message } : {}),
        },
      );
      return { run, steps, mutation };
    }),
  );
  const saved = await deps.manager.saveRuns(
    prepared.map(({ run, mutation }, index) => ({
      // The audit lands on the root, in the same write as every stop.
      state: index === 0 ? { ...mutation.nextState, humanStop: audit } : mutation.nextState,
      expectedVersion: run.stateVersion,
    })),
  );
  if (saved.kind === 'missing' && saved.runId === target.run.state.id) {
    return unknownRun(saved.runId);
  }
  if (saved.kind !== 'committed') {
    return {
      kind: 'concurrent_modification',
      runId: saved.runId,
      message: `Run ${saved.runId} changed after it was read (a write, an attempt started, a child launched or pruned), so nothing was stopped. Re-read it with \`rundown status --run ${target.run.state.id}\` and re-issue the stop if it still applies.`,
    };
  }
  const stopped = prepared.map(({ run, steps, mutation }, index): HumanStoppedRun => {
    const updatedState: RunbookState = saved.runs[index].state;
    if (updatedState.lifecycle !== 'stopped') {
      throw new Error(
        `Run ${run.state.id} was not stopped by the human stop of ${target.run.state.id}`,
      );
    }
    const currentStep = steps.find((step) => step.name === run.state.step);
    if (currentStep === undefined) {
      throw new Error(`Step "${run.state.step}" not found in runbook definition`);
    }
    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState: run.state,
      updatedState,
      snapshot: mutation.snapshot,
      result: 'fail',
      computeActionResult: () => false,
    });
    return { runId: run.state.id, runbook: run.state.runbook, events: observation.events };
  });
  const [root, ...inline] = stopped;
  return { kind: 'applied', root, inline };
}
