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
  parseStepIdFromString,
  stepIdToString,
  deriveGotoActionBlock,
  type RunbookStateManager,
  type RunbookActorService,
  type SessionService,
  type LifecycleNavigationOutcome,
  type ResolvedStep,
  type StepId,
  type RunbookState,
  type ClaimId,
  type RunId,
  type CommandExecutionStreamOptions,
} from '@rundown-org/core';
import { runExecutionLoop, type ExecutionTerminalReleaseMode } from '../services/execution.js';
import {
  propagateDrivenRunTerminal,
  propagationRequiresFailureExit,
  type DrivenRunPropagation,
} from './delegation-completion.js';
import { createCliRunbookActorService } from './actor-service-factory.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { resolveIndexOption, IndexOptionError } from './index-option.js';
import { buildNonDelegatingLifecycleSeam } from './lifecycle-seam-factory.js';
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
  /** Bearer claim id presented via `--claim-id`, when the caller named one. */
  claimId?: ClaimId;
  /** Current active runbook state */
  state: RunbookState;
  /** Parsed steps from the active runbook */
  steps: ResolvedStep[];
  /** Current working directory for file resolution */
  cwd: string;
  /** How terminal follow-on execution should release this runbook from session targeting. */
  terminalReleaseMode: ExecutionTerminalReleaseMode;
  /** Runtime-only routing for command subprocess stdout/stderr. */
  commandStreamOptions?: CommandExecutionStreamOptions;
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
  | { ok: true; loopResult: 'done' | 'stopped' | 'waiting'; propagation?: DrivenRunPropagation }
  | { ok: false; error: string; code: string };

/**
 * Whether a successful goto execution must drive a non-zero process exit: either
 * the run itself stopped, or its terminal propagated to a parent with a
 * stopped/blocked outcome.
 *
 * Shared by `rundown goto` and the `run --prompted --step` launch-local jump so
 * their exit decisions cannot drift — a bare `loopResult === 'stopped'` check
 * misses a propagation that stopped/blocked the parent (#553).
 *
 * @param result - A successful ({@link GotoExecutionResult} `ok: true`) result.
 * @returns `true` when the caller should exit non-zero.
 */
export function gotoResultRequiresFailureExit(
  result: Extract<GotoExecutionResult, { ok: true }>,
): boolean {
  return (
    result.loopResult === 'stopped' ||
    (result.propagation !== undefined && propagationRequiresFailureExit(result.propagation))
  );
}

/**
 * Result of resolving the runbook target and building goto execution context.
 *
 * The refusal members are exactly the core navigation seam's refusing
 * outcomes (derived via `Exclude` so a new core refusal is a compile error in
 * the goto command's exhaustive switch rather than a silent fall-through).
 * `actor_context_required` deliberately carries no run id (accident barrier —
 * the refusal must not hand a lingering child the id it needs to bypass it).
 */
export type BuildGotoContextResult =
  | { readonly kind: 'ready'; readonly ctx: GotoContext }
  | Exclude<LifecycleNavigationOutcome, { kind: 'allowed' }>;

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
  const claimed = Object.values(session.claims).some(
    (claim) => claim.controlledRunId === runbookId,
  );
  return claimed ? 'release-runbook' : 'stack-pop';
}

/**
 * Build context for goto command execution.
 *
 * Dispatches target resolution and the run-navigation policy gate into the
 * core lifecycle seam (`resolveRunNavigation`) — exactly as pass/fail dispatch
 * into `runTransition` — and keeps only Category-A work here: typed caller
 * evidence from the parsed flags, and assembling the execution context from
 * the seam's `allowed` outcome.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param options - Optional explicit claim-id or run-id target
 * @param options.claimId - Claim id to resolve instead of the default stack
 * @param options.runId - Run id (`--run`) to resolve instead of the default
 *   stack. This selects a target run; bearer authority still comes from
 *   `claimId` when one is supplied.
 * @param options.commandStreamOptions - Runtime-only routing for command
 * subprocess stdout/stderr while goto continues execution
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
  options: {
    readonly claimId?: ClaimId;
    readonly runId?: RunId;
    readonly commandStreamOptions?: CommandExecutionStreamOptions;
  } = {},
): Promise<BuildGotoContextResult> {
  const { manager, sessionService, seam } = buildNonDelegatingLifecycleSeam(cwd);

  const outcome = await seam.resolveRunNavigation({
    command: 'goto',
    callerEvidence: readLifecycleCallerEvidence(
      options.claimId !== undefined ? { claimId: options.claimId } : {},
    ),
    targetSelector:
      options.claimId !== undefined
        ? { kind: 'claim', claimId: options.claimId }
        : options.runId !== undefined
          ? { kind: 'run', runId: options.runId }
          : { kind: 'default' },
  });
  if (outcome.kind !== 'allowed') {
    return outcome;
  }

  return {
    kind: 'ready',
    ctx: {
      output,
      manager,
      actorService: createCliRunbookActorService(manager),
      sessionService,
      ...(options.claimId !== undefined ? { claimId: options.claimId } : {}),
      state: outcome.state,
      steps: [...outcome.steps],
      cwd,
      terminalReleaseMode: outcome.terminalReleaseMode,
      commandStreamOptions: options.commandStreamOptions,
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

  // The GOTO committed. Record the presented bearer's progress via the core
  // SessionService API — best-effort, never throws, so it cannot mask the
  // committed navigation (#519, RD-102). A failed sendAndSync above returned
  // already: recorded on success, not on attempt. `resolveRunNavigation` is an
  // authorization gate that mutates nothing, so this call site is the CLI
  // dispatching into core, not re-implementing it; Task 5's drift guard is what
  // makes that sanctioned rather than debt.
  if (ctx.claimId !== undefined) {
    await ctx.sessionService.recordClaimSeen(ctx.claimId);
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
    {
      terminalReleaseMode: ctx.terminalReleaseMode,
      output,
      commandStreamOptions: ctx.commandStreamOptions,
    },
  );

  // Any driver that takes a run terminal must propagate that terminal to its
  // parent — goto included. goto authors no operator RESULT, so use the
  // `loop-inferred` trigger and let lifecycle inference decide the outcome (same
  // as the natural loop). Without this, `goto` completing an inline child left
  // the parent's substep 'running' forever (#553).
  const propagation = await propagateDrivenRunTerminal(
    manager,
    state.id,
    cwd,
    output,
    { kind: 'loop-inferred' },
    ctx.commandStreamOptions,
  );

  return { ok: true, loopResult, propagation };
}
