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
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  parseStepIdFromString,
  stepIdToString,
  countNumberedSteps,
  type Step,
  type StepId,
  type RunbookState,
} from '@rundown-org/core';
import { runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { getRunbookFromState } from './runbook-loader.js';

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
  steps: Step[];
  /** Current working directory for file resolution */
  cwd: string;
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

/**
 * Build context for goto command execution.
 *
 * Resolves active state, loads runbook steps, and creates required services.
 * Returns null if no active runbook is found.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @returns GotoContext or null if no active runbook
 */
export async function buildGotoContext(
  output: OutputEmitter,
  cwd: string,
): Promise<GotoContext | null> {
  const manager = new RunbookStateManager(cwd);
  const sessionService = new SessionService(manager);
  const state = await sessionService.getActive();

  if (!state) {
    return null;
  }

  const readonlySteps = getRunbookFromState(state, cwd);
  const steps = [...readonlySteps];
  const actorService = new RunbookActorService(manager);

  return { output, manager, actorService, sessionService, state, steps, cwd };
}

/**
 * Validate a goto target against the runbook steps.
 *
 * Checks: valid format, step exists, AT only on FOR steps, substep exists.
 *
 * @param stepArg - Raw step argument string (e.g., "3" or "3.1")
 * @param steps - Parsed runbook steps
 * @returns Validation result with parsed target or error details
 */
export function validateGotoTarget(stepArg: string, steps: readonly Step[]): GotoValidationResult {
  const target = parseStepIdFromString(stepArg);
  if (!target) {
    return {
      ok: false,
      error: `Invalid step target: ${stepArg}. Format: N (step) or N.M (step.substep)`,
      code: 'INVALID_SYNTAX',
      details: { provided: stepArg },
    };
  }

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
    if (!step.forClause) {
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
    if (!step.substeps || step.substeps.length === 0) {
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
    from: prevPos,
    at: newPos,
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
    undefined,
  );

  return { ok: true, loopResult };
}
