// packages/cli/src/helpers/terminal-command.ts
//
// Shared front end for the terminal (`complete` / `stop`) commands. Routes both
// through the core `RunbookLifecycleCommandService.runTerminal` seam and renders
// its typed outcome. The seam owns target resolution, policy gating, the inline
// FORCE cascade, record-before-release child propagation, and retained-tombstone
// release; this module keeps only Category-A work: build typed caller evidence,
// stream observation events, and set the exit code.

import {
  RunbookStateManager,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  SessionService,
  ExecutionLifecycleService,
  type ClaimId,
  type CommandTargetSelector,
  type LifecycleTerminalOutcome,
  type RunbookEventInput,
  type RunbookEventV1,
  type RunbookRef,
  type RunId,
  type TerminalCommandName,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { getRunbookFromState } from './runbook-loader.js';
import { readLifecycleCallerEvidence } from './caller-evidence.js';
import { emitDelegationCollectionPendingError } from './transitions.js';
import { cleanupOrphanedActiveStack } from './active-runbook-cleanup.js';
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
  /** Explicit claim-id target (`--claim-id`). */
  readonly claimId?: ClaimId;
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
      output.error(outcome.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
      return true;
    case 'actor_context_required':
      output.error(`Actor context is required to ${command} this run.`, 'ACTOR_CONTEXT_REQUIRED', {
        targetRunId: outcome.targetRunId,
      });
      return true;
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
      if (output.isJson()) {
        output.json({
          kind: 'action',
          action: command,
          status: 'already-resolved',
          claimId: outcome.claimId,
          lifecycle: outcome.lifecycle,
        });
      } else {
        output.message(
          `ALREADY ${command.toUpperCase()}  claim ${outcome.claimId} (child ${outcome.lifecycle})`,
        );
      }
      return false;
    case 'terminal_claim_conflict':
      output.error(
        `Claim ${outcome.claimId} already resolved as ${outcome.expectedCommand}; cannot ${outcome.requestedCommand} it.`,
        'DELEGATION_RESULT_CONFLICT',
      );
      return true;
    case 'already_terminal':
      output.noActiveRunbook(command, 'RUNBOOK_NOT_RUNNING');
      return false;
    case 'inline_plan_unavailable':
      // All three reasons (missing-inline-parent / inline-cycle / root-unavailable)
      // exit non-zero; the core-attached code is rendered as a flat passthrough.
      output.error(outcome.message, outcome.code);
      return true;
    case 'applied-claim': {
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
    case 'applied-bare': {
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
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
  const seam = new RunbookLifecycleCommandService({
    sessionService,
    actorService,
    lifecycleService,
    completionService,
    loadRun: async (id) => (await manager.load(id)) ?? undefined,
    loadSteps: (state) => getRunbookFromState(state, cwd),
    // `runTerminal` drives complete/stop only and never issues delegations, so the
    // three issuance deps are guarded stubs (copied from `runSeamTransition`) —
    // keeping this front end off the runbook-resolver import graph.
    resolveChildRunbook: () => {
      throw new Error('runSeamTerminal seam does not issue delegations');
    },
    persistIssuedSubstep: () => {
      throw new Error('runSeamTerminal seam does not issue delegations');
    },
    findDelegationByToken: () => {
      throw new Error('runSeamTerminal seam does not issue delegations');
    },
  });

  const targetSelector: CommandTargetSelector = options.claimId
    ? { kind: 'claim', claimId: options.claimId }
    : { kind: 'default' };

  const outcome = await seam.runTerminal({
    command,
    callerEvidence: readLifecycleCallerEvidence(),
    targetSelector,
    ...(options.message !== undefined ? { message: options.message } : {}),
    computeActionResult:
      command === 'complete'
        ? (actionType) => actionType !== 'RETRY' && actionType !== 'STOP'
        : () => false,
  });

  // Bare path only: a `none` outcome can mean an orphaned active stack (the top
  // entry's state file is missing on disk) rather than a genuinely empty stack.
  // Attempt Category-A orphan cleanup; a real orphan is popped and reported as a
  // removal (exit 0). A genuinely empty stack cleans nothing and falls through to
  // the normal `no active runbook` rendering.
  if (outcome.kind === 'none' && options.claimId === undefined) {
    const orphanId = await cleanupOrphanedActiveStack(manager, sessionService);
    if (orphanId !== null) {
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
