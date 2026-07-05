// packages/cli/src/helpers/terminal-command.ts
//
// Shared front end for the terminal (`complete` / `stop`) commands. Routes both
// through the core `RunbookLifecycleCommandService.runTerminal` seam and renders
// its typed outcome. The seam owns target resolution, policy gating, the inline
// FORCE cascade, record-before-release child propagation, and retained-tombstone
// release; this module keeps only Category-A work: build typed caller evidence,
// stream observation events, and set the exit code.

import {
  InvalidRunbookStateError,
  RunbookStateManager,
  SessionService,
  getErrorMessage,
  isError,
  logger,
  parseClaimCapability,
  type ClaimId,
  type ClaimCapability,
  type CommandTargetSelector,
  type LifecycleTerminalOutcome,
  type RunbookEventInput,
  type RunbookEventV1,
  type RunbookRef,
  type RunId,
  type TerminalCommandName,
} from '@rundown-org/core';
import { buildNonDelegatingLifecycleSeam } from './lifecycle-seam-factory.js';
import { readLifecycleCallerEvidence } from './caller-evidence.js';
import { emitDelegationCollectionPendingError } from './transitions.js';
import {
  renderActorContextRequiredRefusal,
  renderStaleClaimRefusal,
  renderTerminalClaimConfirmed,
  renderTerminalClaimConflict,
} from './refusal-renderers.js';
import {
  cleanupOrphanedActiveStack,
  isRecoverableActiveStackError,
  type OrphanCleanupResult,
} from './active-runbook-cleanup.js';
import { buildMetadata } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Command-local bridge that streams force-terminal observation events.
 *
 * Preserves one monotonic `seq` across the whole forced chain while stamping
 * each event with the runbook id and runbook ref of the state that produced it.
 * Exactly one bridge must be created per terminal command — creating one per
 * state would restart `seq` or misattribute descendant events.
 */
export class ForceTerminalEventBridge {
  private seq = 0;

  /**
   * Construct a bridge bound to a single output emitter.
   *
   * @param output - Output emitter that renders each streamed execution event.
   */
  constructor(private readonly output: OutputEmitter) {}

  /**
   * Stamp and stream a single observation event.
   *
   * @param attribution - Id and runbook ref of the run that produced the event.
   * @param attribution.id - Run id of the producing run (stamped as `runbookId`).
   * @param attribution.runbook - Runbook ref of the producing run.
   * @param event - Pre-correlated `{ type, payload }` observation event.
   */
  emit(
    attribution: { readonly id: RunId; readonly runbook: RunbookRef },
    event: RunbookEventInput,
  ): void {
    this.seq += 1;
    const envelope: RunbookEventV1 = {
      v: '1',
      ts: new Date().toISOString(),
      seq: this.seq,
      runbookId: attribution.id,
      runbook: attribution.runbook,
      ...event,
    };
    this.output.executionEvent(envelope);
  }
}

/** CLI options forwarded to a terminal seam command. */
export interface SeamTerminalOptions {
  /** Explicit claim-id target (`--claim-id`). Mutually exclusive with `runId`. */
  readonly claimId?: ClaimId;
  /** Explicit claim capability target (`--claim-capability`). Mutually exclusive with `runId`. */
  readonly claimCapability?: ClaimCapability;
  /**
   * Explicit run target and named authority (`--run`). Mutually exclusive with
   * `claimId` (enforced upstream by `parseRunOption`).
   */
  readonly runId?: RunId;
  /** Optional terminal message forwarded to the machine. */
  readonly message?: string;
}

/**
 * Render a terminal seam outcome to the existing CLI envelopes and report whether
 * the outcome requests a non-zero exit code.
 *
 * Switches exhaustively over {@link LifecycleTerminalOutcome} and reuses the
 * existing renderers / error codes — it invents no new codes. The applied
 * variants load the resolved root, emit metadata, stream the seam's observation
 * events through a single {@link ForceTerminalEventBridge}, then render the
 * complete/stopped envelope (a stopped terminal exits non-zero — No silent
 * mapping).
 *
 * @param output - Output emitter for CLI output.
 * @param command - The terminal command being rendered (`complete` / `stop`).
 * @param manager - State manager used to reload the resolved root for rendering.
 * @param outcome - Typed terminal outcome returned by the seam.
 * @param message - Optional operator-supplied terminal message for the applied
 *   complete/stopped summary; falls back to the default summary when absent.
 * @returns `true` when the outcome requests a non-zero exit code.
 */
export async function renderTerminalOutcome(
  output: OutputEmitter,
  command: TerminalCommandName,
  manager: RunbookStateManager,
  outcome: LifecycleTerminalOutcome,
  message?: string,
): Promise<boolean> {
  switch (outcome.kind) {
    case 'none':
      output.noActiveRunbook(command);
      return false;
    case 'stale_claim':
      return renderStaleClaimRefusal(output, outcome.message);
    case 'actor_context_required':
      return renderActorContextRequiredRefusal(output, command);
    case 'delegation_collection_pending':
      emitDelegationCollectionPendingError(
        output,
        command,
        outcome.parentRunId,
        outcome.outcomeCompletionKeys,
        outcome.message,
      );
      return true;
    case 'terminal_claim_confirmed':
      return renderTerminalClaimConfirmed(output, command, outcome.claimId, outcome.lifecycle);
    case 'terminal_claim_conflict':
      return renderTerminalClaimConflict(
        output,
        outcome.claimId,
        outcome.expectedCommand,
        outcome.requestedCommand,
      );
    case 'already_terminal':
      output.noActiveRunbook(command, 'RUNBOOK_NOT_RUNNING');
      return false;
    case 'unknown_run':
      output.error(outcome.message, 'RUN_TARGET_UNAVAILABLE');
      return true;
    case 'inline_plan_unavailable':
      // All three reasons (missing-inline-parent / inline-cycle / root-unavailable)
      // exit non-zero; the core-attached code is rendered as a flat passthrough.
      output.error(outcome.message, outcome.code);
      return true;
    case 'applied_claim': {
      // Single forced run (the claimed child). Load it for metadata + attribution
      // and stream its events stamped with the child's own id/ref.
      const rootState = await manager.load(outcome.runId);
      if (rootState) output.metadata(buildMetadata(rootState));
      if (outcome.events.length > 0 && rootState) {
        const bridge = new ForceTerminalEventBridge(output);
        for (const event of outcome.events) {
          bridge.emit({ id: rootState.id, runbook: rootState.runbook }, event);
        }
      }
      if (outcome.status === 'stopped') {
        // A claim-path `rd stop --claim-id` is a report-only delegated close: the
        // child's `fail` is reported to the parent as data (via the seam's
        // record-before-release), but the command itself succeeded, so it exits 0.
        output.stopped(message ?? 'Runbook stopped');
        return false;
      }
      output.complete(message ?? 'Runbook completed successfully');
      return false;
    }
    case 'applied_bare': {
      // Multi-run inline cascade: metadata from the root, but each event is
      // streamed stamped with the id/ref of the descendant that produced it
      // (per-descendant attribution across the forced chain).
      const rootState = await manager.load(outcome.rootRunId);
      if (rootState) output.metadata(buildMetadata(rootState));
      if (outcome.events.length > 0) {
        const bridge = new ForceTerminalEventBridge(output);
        for (const { runId, runbook, event } of outcome.events) {
          bridge.emit({ id: runId, runbook }, event);
        }
      }
      if (outcome.status === 'stopped') {
        // A bare `rd stop` is the operator aborting their own run — a failure
        // terminal that exits non-zero (No silent mapping).
        output.stopped(message ?? 'Runbook stopped');
        return true;
      }
      output.complete(message ?? 'Runbook completed successfully');
      return false;
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * Drive a complete/stop terminal command through the core lifecycle seam.
 *
 * Builds the seam over the same core services as `runSeamTransition`, maps the
 * parsed `--claim-id` to a target selector (bare → `default`), calls
 * `runTerminal` with typed caller evidence, and renders the outcome.
 *
 * @param output - Output emitter for CLI output.
 * @param cwd - Current working directory.
 * @param command - The terminal command to run (`complete` / `stop`).
 * @param options - Parsed `--claim-id` target and optional message.
 * @returns The bound state manager and whether the command requests a non-zero exit.
 */
export async function runSeamTerminal(
  output: OutputEmitter,
  cwd: string,
  command: TerminalCommandName,
  options: SeamTerminalOptions = {},
): Promise<{ readonly manager: RunbookStateManager; readonly exitError: boolean }> {
  const { manager, sessionService, seam } = buildNonDelegatingLifecycleSeam(cwd);

  const targetSelector: CommandTargetSelector = options.claimCapability
    ? { kind: 'claim-capability', claimCapability: options.claimCapability }
    : options.claimId
      ? { kind: 'claim', claimId: options.claimId }
      : options.runId !== undefined
        ? { kind: 'run', runId: options.runId }
        : { kind: 'default' };

  const outcome = await seam.runTerminal({
    command,
    callerEvidence: readLifecycleCallerEvidence(
      options.runId !== undefined ? { runId: options.runId } : {},
    ),
    targetSelector,
    ...(options.message !== undefined ? { message: options.message } : {}),
    computeActionResult:
      command === 'complete'
        ? (actionType) => actionType !== 'RETRY' && actionType !== 'STOP'
        : () => false,
  });

  // Bare path only: a `none` outcome can mean an orphaned active stack (the top
  // entry's state file is missing on disk) rather than a genuinely empty stack.
  // Attempt Category-A orphan cleanup; a verified-unusable top is popped and
  // reported as a removal (exit 0). An empty stack or a healthy top cleans
  // nothing and falls through to the normal `no active runbook` rendering. No
  // prior error exists here, so a guard failure may propagate normally.
  // The `runId === undefined` leg is defensive hardening: `--run` targeting
  // never returns `none` today (it refuses `unknown_run`), but if it ever did,
  // default-stack cleanup must not run for a named-run target.
  if (outcome.kind === 'none' && options.claimId === undefined && options.runId === undefined) {
    const cleanup = await cleanupOrphanedActiveStack(manager, sessionService);
    if (cleanup.kind === 'removed') {
      const removalMessage = 'Removed unusable runbook state from session';
      if (command === 'complete') output.complete(removalMessage);
      else output.stopped(removalMessage);
      output.flush();
      return { manager, exitError: false };
    }
  }

  const exitError = await renderTerminalOutcome(output, command, manager, outcome, options.message);
  output.flush();
  return { manager, exitError };
}

/** Explicit target the failed terminal command was invoked with. */
export interface TerminalRecoveryTarget {
  /** Explicit claim id when the command targeted a claimed child (`--claim-id`). */
  readonly claimId?: string;
  /** Explicit claim capability when the command targeted a claimed child (`--claim-capability`). */
  readonly claimCapability?: ClaimCapability;
  /** Explicit run id when the command named its target (`--run`). */
  readonly runId?: RunId;
}

/**
 * Recover from an unusable persisted snapshot surfaced by a terminal command.
 *
 * The only CLI-owned logic that survives a terminal command (Category A): when
 * the machine fails to rehydrate inside the seam, the bare path attempts orphan
 * cleanup and reports a clean removal, while the claim path maps the same
 * failure per command — `complete` to a `CLAIMED_RUNBOOK_UNAVAILABLE` error
 * (exit 1), `stop` to "no active runbook" (a claimed child that is no longer
 * usable is nothing to stop). A `--run`-targeted failure NEVER runs
 * default-stack orphan cleanup: the operator named a specific run, and popping
 * whatever happens to sit on the default stack would report success without
 * terminating the named run — the failure is surfaced against the named run
 * instead (fail closed). Any other error is rethrown for the outer
 * `withErrorHandling` to render.
 *
 * @param command - The terminal command that failed (`complete` / `stop`).
 * @param error - The error thrown by the seam.
 * @param output - Output emitter for the recovery message.
 * @param cwd - Current working directory (used to build the cleanup manager).
 * @param target - Explicit `--claim-id` / `--run` target the command carried.
 * @throws {unknown} Rethrows any error that is not a recoverable snapshot failure.
 */
export async function handleTerminalRecovery(
  command: TerminalCommandName,
  error: unknown,
  output: OutputEmitter,
  cwd: string,
  target: TerminalRecoveryTarget = {},
): Promise<void> {
  // Claim path: orphan cleanup (a bare-command recovery) never applies to a
  // claim target, so an unusable snapshot maps to the command's claim outcome.
  const recoveryClaimId =
    target.claimId ??
    (target.claimCapability ? parseClaimCapability(target.claimCapability).claimId : undefined);
  if (recoveryClaimId !== undefined) {
    if (error instanceof InvalidRunbookStateError) {
      if (command === 'complete') {
        output.error(
          `Claimed runbook ${recoveryClaimId} is unavailable`,
          'CLAIMED_RUNBOOK_UNAVAILABLE',
        );
        output.flush();
        process.exitCode = 1;
      } else {
        output.noActiveRunbook('stop');
        output.flush();
      }
      return;
    }
    throw error;
  }

  // Run-targeted path: the operator NAMED the failing run, so default-stack
  // orphan cleanup must never run — the default top may be a different run,
  // and popping it would exit 0 without terminating the named run. Surface
  // the failure against the named run instead (echoing only the id the caller
  // themselves supplied).
  if (target.runId !== undefined) {
    if (
      error instanceof InvalidRunbookStateError ||
      (isError(error) && isRecoverableActiveStackError(error))
    ) {
      output.error(
        `Run ${target.runId} has unusable persisted state; cannot ${command} it.`,
        'RUN_TARGET_UNAVAILABLE',
      );
      output.flush();
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (
    error instanceof InvalidRunbookStateError ||
    (isError(error) && isRecoverableActiveStackError(error))
  ) {
    // Orphan cleanup needs only a manager + session service — not the full seam
    // (building it in this failure path would touch policy/helper singletons the
    // recovery has no business reading).
    const manager = new RunbookStateManager(cwd);
    const sessionService = new SessionService(manager);
    let cleanup: OrphanCleanupResult;
    try {
      cleanup = await cleanupOrphanedActiveStack(manager, sessionService);
    } catch (cleanupError) {
      void logger.warn(
        `terminal recovery: orphan-cleanup probe failed: ${getErrorMessage(cleanupError)}`,
      );
      // Rethrow the ORIGINAL error with the probe failure attached — the probe
      // failure is never surfaced in place of the operator's original diagnostic.
      if (isError(error) && error.cause === undefined) {
        (error as Error & { cause?: unknown }).cause = cleanupError;
      }
      throw error;
    }
    if (cleanup.kind === 'removed') {
      const removalMessage = 'Removed unusable runbook state from session';
      if (command === 'complete') output.complete(removalMessage);
      else output.stopped(removalMessage);
      output.flush();
      return;
    }
    // empty-stack / healthy-top: the failure did not come from an orphaned top —
    // fall through and surface the original error rather than swallowing it.
  }
  throw error;
}
