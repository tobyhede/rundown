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
  buildStepPosition,
  derivePositionAt,
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  parseStepIdFromString,
  stepIdToString,
  countNumberedSteps,
  type ResolvedStep,
  type StepId,
  type RunbookState,
  type ClaimId,
  type RunId,
} from '@rundown-org/core';
import { runExecutionLoop, type ExecutionTerminalReleaseMode } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { resolveIndexOption, IndexOptionError } from './index-option.js';
import { getRunbookFromState } from './runbook-loader.js';
import { resolveActiveRunbook, type ActiveRunbookResolution } from './active-runbook-resolver.js';

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
  | Extract<ActiveRunbookResolution, { kind: 'none' | 'stale_claim' }>;

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
 * @param options - Optional explicit claim-id target
 * @param options.claimId - Claim id to resolve instead of the default stack
 * @returns Discriminated union: `{ kind: 'ready'; ctx }` when an active runbook
 *   was resolved and a goto context is available; `{ kind: 'none' }` when no
 *   active runbook exists; or `{ kind: 'stale_claim' }` when the supplied
 *   claim id no longer maps to an active child.
 */
export async function buildGotoContext(
  output: OutputEmitter,
  cwd: string,
  options: { readonly claimId?: ClaimId } = {},
): Promise<BuildGotoContextResult> {
  const manager = new RunbookStateManager(cwd);
  const sessionService = new SessionService(manager);
  const active = await resolveActiveRunbook(sessionService, options);

  switch (active.kind) {
    case 'claim':
    case 'default':
      break;
    case 'none':
    case 'stale_claim':
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
  const actorService = new RunbookActorService(manager);

  return {
    kind: 'ready',
    ctx: { output, manager, actorService, sessionService, state, steps, cwd, terminalReleaseMode },
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

  const prevStep = state.step;
  const prevSubstep = state.substep;

  const syncResult = await actorService.sendAndSync(state.id, steps, {
    type: 'GOTO',
    target,
  });
  if (!syncResult) {
    return { ok: false, error: 'Failed to initialize runbook engine', code: 'ENGINE_INIT_FAILED' };
  }

  // Update lastAction and CLEAR lastResult (prevent stale PASS/FAIL leaking)
  await manager.update(state.id, {
    lastAction: {
      type: 'GOTO',
      target: target.step,
      ...(target.substep && { substep: target.substep }),
    },
    lastResult: undefined, // CRITICAL: Clear stale result on manual goto
  });

  // Compute new position (the target of the goto)
  const totalSteps = countNumberedSteps(steps);
  const newPos = buildStepPosition(
    syncResult.state.step,
    totalSteps,
    syncResult.state.substep,
    syncResult.state.forStack,
  );
  const prevPos = buildStepPosition(prevStep, totalSteps, prevSubstep, state.forStack);

  // Build action data for goto
  const actionData = {
    action: `GOTO ${stepIdToString(target)}`,
    from: derivePositionAt(prevPos),
    at: derivePositionAt(newPos),
  };

  // Emit structured action output
  output.action(actionData);

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
    { terminalReleaseMode: ctx.terminalReleaseMode },
  );

  return { ok: true, loopResult };
}
