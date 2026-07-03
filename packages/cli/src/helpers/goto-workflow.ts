/**
 * Business logic for the goto command.
 *
 * Extracts validation and execution logic from commands/goto.ts into
 * testable functions. The command file becomes a thin shell that
 * parses options, calls these functions, and handles exit codes.
 *
 * @module helpers/goto-workflow
 */

import {
  RunbookStateManager,
  type RunbookActorService,
  SessionService,
  actorContextFromEvidence,
  classifyDelegationExposure,
  parseStepIdFromString,
  stepIdToString,
  deriveGotoActionBlock,
  resolveCommandTarget,
  resolveCommandIntent,
  type CommandTargetResolution,
  type DelegationExposure,
  type ResolvedStep,
  type StepId,
  type RunbookState,
  type ClaimId,
  type RunId,
} from '@rundown-org/core';
import { runExecutionLoop, type ExecutionTerminalReleaseMode } from '../services/execution.js';
import { createCliRunbookActorService } from './actor-service-factory.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { resolveIndexOption, IndexOptionError } from './index-option.js';
import { getRunbookFromState } from './runbook-loader.js';
import { readLifecycleCallerEvidence } from './caller-evidence.js';

/**
 * Context for executing a goto operation.
 */
export interface GotoContext {
  /** Output emitter for rendering status and error messages */
  output: OutputEmitter;
  /** State manager for persisting runbook state changes */
  manager: RunbookStateManager;
  /** Actor service for managing XState actor lifecycle */
  actorService: RunbookActorService;
  /** Session service for tracking active/stashed runbooks */
  sessionService: SessionService;
  /** Current active runbook state */
  state: RunbookState;
  /** Parsed steps from the active runbook */
  steps: ResolvedStep[];
  /** Current working directory for file resolution */
  cwd: string;
  /** How terminal follow-on execution should release this runbook from session targeting. */
  terminalReleaseMode: ExecutionTerminalReleaseMode;
  /**
   * Delegation exposure of the resolved run, computed at context-build time.
   * Held here for the trust-mapping call: the evidence mapping consumes it
   * once `actorContextFromEvidence` becomes exposure-aware; until then it has
   * no consumer beyond the run-navigation policy dispatch.
   */
  exposure: DelegationExposure;
}

/**
 * Result of goto target validation.
 */
export type GotoValidationResult =
  | { ok: true; target: StepId }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> };

/**
 * Result of goto execution.
 */
export type GotoExecutionResult =
  | { ok: true; loopResult: 'done' | 'stopped' | 'waiting' }
  | { ok: false; error: string; code: string };

/** Result of resolving the runbook target and building goto execution context. */
export type BuildGotoContextResult =
  | { readonly kind: 'ready'; readonly ctx: GotoContext }
  | Extract<
      CommandTargetResolution,
      { kind: 'none' | 'stale_claim' | 'terminal_claim' | 'unknown_run' }
    >
  | {
      /** The run-navigation policy gate refused the caller's evidence. */
      readonly kind: 'actor_context_required';
      /** Run the refused navigation would have targeted. */
      readonly targetRunId: RunId;
    };

/**
 * Resolve how terminal execution should remove a specific runbook from session targeting.
 *
 * Used when a command already has the target state and cannot go through
 * {@link buildGotoContext}, for example `run --prompted --step` immediately
 * after launching a runbook.
 *
 * @param manager - State manager used to read session targeting data
 * @param runbookId - Runbook state id that will continue executing after goto
 * @returns Release mode matching the runbook's current session ownership
 */
export async function resolveTerminalReleaseModeForRunbook(
  manager: RunbookStateManager,
  runbookId: RunId,
): Promise<ExecutionTerminalReleaseMode> {
  const session = await manager.loadSession();
  const claimed = Object.values(session.claims).some((claim) => claim.childRunId === runbookId);
  return claimed ? 'release-runbook' : 'stack-pop';
}

/**
 * Build context for goto command execution.
 *
 * Resolves active state, loads runbook steps, and creates required services.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param options - Optional explicit claim-id or run-id target
 * @param options.claimId - Claim id to resolve instead of the default stack
 * @param options.runId - Run id (`--run`) to resolve instead of the default
 *   stack; mutually exclusive with `claimId` (enforced upstream)
 * @returns Discriminated union: `{ kind: 'ready'; ctx }` when an active runbook
 *   was resolved and a goto context is available; `{ kind: 'none' }` when no
 *   active runbook exists; `{ kind: 'stale_claim' | 'terminal_claim' }` when
 *   the supplied claim id cannot be used as a mutable child target;
 *   `{ kind: 'unknown_run' }` for an unresolvable `--run` id; or
 *   `{ kind: 'actor_context_required' }` when the run-navigation policy gate
 *   refuses the caller's evidence.
 */
export async function buildGotoContext(
  output: OutputEmitter,
  cwd: string,
  options: { readonly claimId?: ClaimId; readonly runId?: RunId } = {},
): Promise<BuildGotoContextResult> {
  const manager = new RunbookStateManager(cwd);
  const sessionService = new SessionService(manager);
  const active = await resolveCommandTarget(sessionService, options);

  switch (active.kind) {
    case 'claim':
    case 'default':
    // Explicit `--run` target: behaves like `default` with the named state in
    // hand; the flag itself is parsed by the goto command (`parseRunOption`).
    case 'run':
      break;
    case 'none':
    case 'stale_claim':
    case 'terminal_claim':
    case 'unknown_run':
      return active;
    default: {
      const _exhaustive: never = active;
      return _exhaustive;
    }
  }

  const state = active.state;
  const terminalReleaseMode: ExecutionTerminalReleaseMode =
    active.kind === 'claim' ? 'release-runbook' : 'stack-pop';
  const readonlySteps = getRunbookFromState(state, cwd);
  const steps = [...readonlySteps];
  const actorService = createCliRunbookActorService(manager);

  // Compute the resolved run's delegation exposure and HOLD it on the context.
  // The evidence mapping below still has its pre-exposure (evidence, targetRunId)
  // signature, so the value's only consumer today is the context itself; the
  // exposure-aware mapping consumes it when the direct_cli flip lands.
  const openClaims = await sessionService.listOpenClaimsForParent(state.id);
  const exposure = classifyDelegationExposure({ state, steps, openClaims });

  // Run-navigation policy gate: goto is role-gated like an advance (unknown
  // callers are refused) but exempt from the collection-pending / open-claims
  // guards — navigation is operator control flow, not completion.
  const evidence = readLifecycleCallerEvidence(
    active.kind === 'claim'
      ? {
          claim: {
            claimId: active.claimId,
            tokenHash: active.claim.tokenHash,
            controlledRunId: active.claim.childRunId,
          },
        }
      : options.runId !== undefined
        ? { runId: options.runId }
        : {},
  );
  const actorContext = actorContextFromEvidence(evidence, state.id);
  const policy = resolveCommandIntent({
    actorContext,
    intent: { kind: 'run-navigation', command: 'goto', targeted: true },
    targetSelector:
      active.kind === 'claim'
        ? { kind: 'claim', claimId: active.claimId }
        : active.kind === 'run'
          ? { kind: 'run', runId: active.runId }
          : { kind: 'default' },
    targetState: state,
    openClaims,
  });
  if (policy.kind !== 'allowed') {
    return { kind: 'actor_context_required', targetRunId: state.id };
  }

  return {
    kind: 'ready',
    ctx: {
      output,
      manager,
      actorService,
      sessionService,
      state,
      steps,
      cwd,
      terminalReleaseMode,
      exposure,
    },
  };
}

/**
 * Validate a goto target against the runbook steps.
 *
 * Checks: valid format, step exists, AT only on FOR steps, substep exists.
 * When `indexOption` is provided, it is merged into the target's `at` field
 * via `resolveIndexOption`.
 *
 * @param stepArg - Raw step argument string (e.g., "3" or "3.1")
 * @param steps - Parsed runbook steps
 * @param indexOption - Raw `--index` value from CLI (optional)
 * @returns Validation result with parsed target or error details.
 *   `IndexOptionError` from `resolveIndexOption` is caught and converted to a validation failure.
 * @throws {Error} if an unexpected (non-IndexOptionError) error occurs during index resolution
 */
export function validateGotoTarget(
  stepArg: string,
  steps: readonly ResolvedStep[],
  indexOption?: string,
): GotoValidationResult {
  const parsed = parseStepIdFromString(stepArg);
  if (!parsed) {
    return {
      ok: false,
      error: `Invalid step target: ${stepArg}. Format: N (step) or N.M (step.substep)`,
      code: 'INVALID_SYNTAX',
      details: { provided: stepArg },
    };
  }

  // Merge --index with any AT from the step ID string
  let resolvedAt: number | undefined;
  try {
    resolvedAt = resolveIndexOption(indexOption, parsed.at);
  } catch (error) {
    if (error instanceof IndexOptionError) {
      return { ok: false, error: error.message, code: error.code };
    }
    throw error;
  }

  // Build mutable target with merged AT
  const target: StepId =
    resolvedAt !== undefined
      ? { ...parsed, at: resolvedAt }
      : parsed.at !== undefined
        ? parsed
        : { step: parsed.step, substep: parsed.substep };

  const stepIndex = steps.findIndex((s) => s.name === target.step);
  if (stepIndex === -1) {
    return {
      ok: false,
      error: `Step "${target.step}" does not exist`,
      code: 'STEP_NOT_FOUND',
      details: { requested: target.step, available: steps.map((s) => s.name) },
    };
  }

  if (target.at !== undefined) {
    const step = steps[stepIndex];
    if (step.kind !== 'for') {
      return {
        ok: false,
        error: `GOTO AT is only valid when the target step has a FOR clause (step "${target.step}" has no FOR)`,
        code: 'INVALID_AT_TARGET',
        details: { step: target.step, at: target.at },
      };
    }
  }

  if (target.substep) {
    const step = steps[stepIndex];
    if (step.kind !== 'substeps' && step.kind !== 'for' && step.kind !== 'prompted-for') {
      return {
        ok: false,
        error: `Step ${stepIdToString({ step: target.step })} has no substeps`,
        code: 'STEP_NOT_FOUND',
        details: { step: target.step },
      };
    }
    const substepExists = step.substeps.some((s) => s.id === target.substep);
    if (!substepExists) {
      return {
        ok: false,
        error: `Substep ${stepIdToString(target)} does not exist`,
        code: 'STEP_NOT_FOUND',
        details: {
          requested: stepIdToString(target),
          available: step.substeps.map((s) => s.id),
        },
      };
    }
  }

  return { ok: true, target };
}

/**
 * Execute a goto operation: send GOTO event, update state, emit action, run loop.
 *
 * @param ctx - Goto context with resolved state and services
 * @param target - Validated step target
 * @returns Execution result indicating success or failure
 */
export async function executeGoto(ctx: GotoContext, target: StepId): Promise<GotoExecutionResult> {
  const { output, manager, actorService, state, steps, cwd } = ctx;

  const syncResult = await actorService.sendAndSync(state.id, steps, {
    type: 'GOTO',
    target,
  });
  if (!syncResult) {
    return { ok: false, error: 'Failed to initialize runbook engine', code: 'ENGINE_INIT_FAILED' };
  }

  output.action(
    deriveGotoActionBlock({
      steps,
      previousState: state,
      updatedState: syncResult.state,
      target,
    }),
  );

  // Create emitter bridged to unified output
  const emitter = createBridgedEmitter(state, output);

  // Continue with execution loop
  const loopResult = await runExecutionLoop(
    manager,
    state.id,
    steps,
    cwd,
    !!state.prompted,
    emitter,
    { terminalReleaseMode: ctx.terminalReleaseMode, output },
  );

  return { ok: true, loopResult };
}
