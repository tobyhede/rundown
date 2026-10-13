/**
 * The human escape hatch for a lost top-level Owner Token (#906, ADR 0005).
 *
 * A run id authorizes nothing — except here. When the Owner Token of a
 * top-level run is lost, nothing else can end the run: a lost Claim Ticket or
 * child token is recovered by `retry` and `release`, but a top-level run has
 * no parent to cancel it. So a human may stop it by id, through an
 * interactive, audited `rundown stop --run <id>`. The front end decides that a
 * human is at a terminal and has confirmed (Category A); this module decides
 * what the id may stop, and stops it through the lifecycle seam's own
 * `runTerminal`, whose one conditional save also writes the
 * {@link HumanStopAudit} on the run.
 *
 * The hatch stops exactly the run it names, never descending to a running
 * Inline Child as the Owner Token's own `stop` does: the human confirmed a
 * stop of that run, and stopping a child would let the parent Collect it and
 * carry on. An Inline Child left running beneath it is unreachable (its
 * authority was the stopped root's token) and goes when the root is pruned.
 * Only a top-level run can be named: an Inline Child runs on its root's token,
 * and a Delegation has its own recoveries.
 *
 * Front ends that cannot prove a human is present — MCP, the scenario
 * harness, an agent's shell — must not reach this module.
 *
 * @module runbook/human-stop
 */

import type {
  LifecycleTerminalOutcome,
  RunbookLifecycleCommandService,
  RunFinishedRefusal,
} from './lifecycle-command-service.js';
import type { OwnedRun } from './run-authority.js';
import { RUN_TARGET_UNAVAILABLE_CODE } from './delegation-recovery.js';
import type { RunId } from './run-id.js';
import type { RunbookStateManager } from './state.js';
import type { HumanStopAudit } from './types.js';

/** Code of the refusal of a run id that names a Child Run. */
export const NOT_A_TOP_LEVEL_RUN_CODE = 'NOT_A_TOP_LEVEL_RUN';

/** A refusal of the run id the human named: nothing was asked or written. */
export type HumanStopTargetRefusal =
  | RunFinishedRefusal
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
    }
  | HumanStopTargetRefusal;

/** Outcome of {@link stopByHuman}. */
export type HumanStopOutcome =
  | Exclude<LifecycleTerminalOutcome, { readonly kind: 'unknown_token' }>
  | Extract<HumanStopTargetRefusal, { readonly kind: 'unknown_run' }>;

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

/**
 * Decide whether the escape hatch may stop the run a human named, before the
 * human is asked to confirm it.
 *
 * Refuses an id that names no run, a finished run, and a Child Run — naming
 * the recovery that applies to it. A target carries the version it was read
 * at: if the run moves while the human decides, the stop is refused rather
 * than applied to a state they did not see.
 *
 * @param manager - State manager the run is read from.
 * @param runId - The run the human named.
 * @returns The target, or the refusal.
 */
export async function resolveHumanStopTarget(
  manager: RunbookStateManager,
  runId: RunId,
): Promise<HumanStopTargetResolution> {
  const run = await manager.loadWithVersion(runId);
  if (run === null) return unknownRun(runId);
  const linkage = run.linkage;
  if (linkage !== null) {
    const remedy =
      linkage.kind === 'inline'
        ? `it runs on its root's token; stop the root with \`rundown stop --run ${linkage.parentRunId}\` if that token is lost`
        : "its claiming agent ends it with `rundown release`, or its parent's owner cancels it with `rundown retry`";
    return {
      kind: 'not_top_level',
      code: NOT_A_TOP_LEVEL_RUN_CODE,
      runId,
      message: `Run ${runId} is a child run, which the escape hatch never stops; ${remedy}. Nothing was stopped.`,
    };
  }
  const lifecycle = run.state.lifecycle ?? 'running';
  if (lifecycle !== 'running') return { kind: 'run_finished', runId, lifecycle };
  return { kind: 'target', run };
}

/**
 * Stop a top-level run by id, for a human who lost its Owner Token and
 * confirmed the stop.
 *
 * The seam's own `stop`, with every refusal that carries — an attempt In
 * Progress (an Interrupted one is cleared, as `stop` always clears it), a
 * write since the target was read, never retried — and the audit written by
 * the same save.
 *
 * @param seam - The lifecycle seam that applies the stop.
 * @param target - The run {@link resolveHumanStopTarget} resolved.
 * @param audit - Who confirmed the stop, when, and their message.
 * @returns The refusal, or the applied stop.
 */
export async function stopByHuman(
  seam: RunbookLifecycleCommandService,
  target: Extract<HumanStopTargetResolution, { readonly kind: 'target' }>,
  audit: HumanStopAudit,
): Promise<HumanStopOutcome> {
  const outcome = await seam.runTerminal({
    command: 'stop',
    run: target.run,
    humanStop: audit,
    ...(audit.message !== undefined ? { message: audit.message } : {}),
  });
  return outcome.kind === 'unknown_token' ? unknownRun(target.run.state.id) : outcome;
}
