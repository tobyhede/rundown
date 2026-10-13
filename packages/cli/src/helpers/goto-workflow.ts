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
  CLIErrorCodes,
  CONCURRENT_MODIFICATION_CODE,
  parseStepIdFromString,
  stepIdToString,
  deriveGotoActionBlock,
  type RunbookStateManager,
  type LifecycleNavigationOutcome,
  type CommandTargetResolution,
  type OwnerToken,
  type ResolvedStep,
  type StepId,
  type RunbookState,
  type CommandExecutionStreamOptions,
  type RunbookLifecycleCommandService,
  type LifecycleNavigationCapability,
  type RunProgressionOutcome,
} from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { resolveIndexOption, IndexOptionError } from './index-option.js';
import { buildLifecycleSeam } from './lifecycle-seam-factory.js';
import { resolveCommandTarget } from './command-target.js';
import { driveRunProgression, progressionFailedClosed } from './run-progression-adapters.js';
import {
  UNKNOWN_TOKEN_MESSAGE,
  renderExecutionLeaseRefusal,
  renderOwnedRunRefusal,
  renderRunFinished,
} from './token-option.js';

/**
 * Context for executing a goto operation.
 */
export interface GotoContext {
  /** Output emitter for rendering status and error messages */
  output: OutputEmitter;
  /** State manager for persisting runbook state changes */
  manager: RunbookStateManager;
  /** Core lifecycle seam that owns the decisive GOTO mutation. */
  seam: RunbookLifecycleCommandService;
  /** The owned run's state at resolution time */
  state: RunbookState;
  /** Current working directory for file resolution */
  cwd: string;
  /** Runtime-only routing for command subprocess stdout/stderr. */
  commandStreamOptions?: CommandExecutionStreamOptions;
  /**
   * Core-verified run, authority and graph for the navigation. Passed WHOLE
   * to `runNavigationMutation` so none of the three can travel apart.
   */
  navigation: LifecycleNavigationCapability;
}

/**
 * Result of goto target validation.
 */
export type GotoValidationResult =
  | { ok: true; target: StepId }
  | {
      ok: false;
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

/**
 * Result of goto execution.
 */
export type GotoExecutionResult =
  | { ok: true; progression: RunProgressionOutcome }
  | { ok: false; error: string; code: string };

/**
 * Whether the shared Run Progression outcome fails the GOTO command closed.
 *
 * Shared by `rundown goto` and the `run --prompted --step` launch-local jump so
 * their exit decisions cannot drift.
 *
 * @param result - A successful ({@link GotoExecutionResult} `ok: true`) result.
 * @returns `true` when the caller should exit non-zero.
 */
export function gotoResultRequiresFailureExit(
  result: Extract<GotoExecutionResult, { ok: true }>,
): boolean {
  return progressionFailedClosed(result.progression);
}

/**
 * Result of resolving the owned run and building goto execution context.
 *
 * The refusal members are the refusing arms of core's token resolution
 * (`unknown_token`, `finished`) and of the navigation seam (`run_finished`),
 * derived via `Exclude` so a new core refusal is a compile error in the
 * exhaustive switch rather than a silent fall-through.
 */
export type BuildGotoContextResult =
  | { readonly kind: 'ready'; readonly ctx: GotoContext }
  | Exclude<CommandTargetResolution, { kind: 'running' }>
  | Exclude<LifecycleNavigationOutcome, { kind: 'allowed' }>;

/** A {@link BuildGotoContextResult} narrowed to its non-`ready` variants. */
export type GotoRefusal = Exclude<BuildGotoContextResult, { kind: 'ready' }>;

/**
 * Commands that render a navigation refusal.
 *
 * Closed at the two call sites: standalone `goto`, and `run`'s launch-local
 * `--step` jump.
 */
export type NavigationRefusalCommand = 'goto' | 'run';

/**
 * Render a non-`ready` goto context result and report whether it exits non-zero.
 *
 * The navigation counterpart to `renderRefusal` (pass/fail, `transitions.ts`)
 * and `renderTerminalOutcome` (complete/stop, `terminal-command.ts`): each
 * command family's helper owns one named dispatcher over its outcome union,
 * returning `true` when the outcome requests a non-zero exit.
 *
 * Exit-code-to-process mapping stays with the caller (Category A) — this
 * function decides only the polarity.
 *
 * @param output - Output emitter for CLI output.
 * @param refusal - The non-`ready` result returned by {@link buildGotoContext}.
 * @param commandName - Command named in the rendered refusal: `'goto'`, or
 *   `'run'` when a run's own `GOTO` resolution is refused.
 * @returns `true`: every navigation refusal requests a non-zero exit code.
 */
export function renderNavigationRefusal(
  output: OutputEmitter,
  refusal: GotoRefusal,
  commandName: NavigationRefusalCommand = 'goto',
): boolean {
  switch (refusal.kind) {
    case 'unknown_token':
    case 'finished':
    case 'settle_refused':
    case 'delegation_cancelled':
    case 'parent_run_finished':
      return renderOwnedRunRefusal(output, commandName, refusal);
    case 'run_finished':
      renderRunFinished(output, commandName, refusal.runId, refusal.lifecycle);
      return true;
    case 'execution_in_progress':
      return renderExecutionLeaseRefusal(output, refusal);
    default: {
      // Assigning to `never` keeps the compile-time totality check — adding a
      // navigation refusal without an arm here is a build error. Returning a
      // real `true` rather than the `never` value keeps the runtime honest to
      // the declared `boolean`, so an unrecognized kind from an untyped
      // frontend still fails closed instead of handing the caller an object.
      const _exhaustive: never = refusal;
      void _exhaustive;
      return true;
    }
  }
}

/**
 * Build context for goto command execution.
 *
 * Resolves the Owner Token through core to its target (the deepest running
 * Inline Child, #903; `resolveCommandTarget`), then dispatches
 * the owned run into the core navigation seam (`resolveRunNavigation`) —
 * exactly as pass/fail dispatch into `runTransition` — and keeps only
 * Category-A work here: assembling the execution context from the seam's
 * `allowed` outcome.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param options - The parsed Owner Token and stream routing
 * @param options.token - Owner Token naming the run to navigate
 * @param options.commandStreamOptions - Runtime-only routing for command
 * subprocess stdout/stderr while goto continues execution
 * @returns `{ kind: 'ready'; ctx }` when the token owns a running run, or a
 *   typed refusal: `unknown_token`, `finished`, or `run_finished`
 */
export async function buildGotoContext(
  output: OutputEmitter,
  cwd: string,
  options: {
    readonly token: OwnerToken;
    readonly commandStreamOptions?: CommandExecutionStreamOptions;
  },
): Promise<BuildGotoContextResult> {
  const { manager, seam } = buildLifecycleSeam(cwd);

  const resolution = await resolveCommandTarget(
    {
      seam,
      manager,
      cwd,
      output,
      ...(options.commandStreamOptions !== undefined
        ? { commandStreamOptions: options.commandStreamOptions }
        : {}),
    },
    options.token,
    'goto',
  );
  if (resolution.kind !== 'running') return resolution;

  const outcome = await seam.resolveRunNavigation({ run: resolution.run });
  if (outcome.kind !== 'allowed') {
    return outcome;
  }

  return {
    kind: 'ready',
    ctx: {
      output,
      manager,
      seam,
      state: outcome.state,
      cwd,
      commandStreamOptions: options.commandStreamOptions,
      navigation: outcome.navigation,
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
 * Execute a GOTO mutation, render its observation, then forward core's opaque
 * continuation directive to shared Run Progression.
 *
 * @param ctx - Goto context with resolved state and services
 * @param target - Validated step target
 * @returns Execution result indicating success or failure
 */
export async function executeGoto(ctx: GotoContext, target: StepId): Promise<GotoExecutionResult> {
  const { output, manager, seam, state, navigation, cwd } = ctx;

  const mutation = await seam.runNavigationMutation({
    navigation,
    target,
  });
  // A refusal travels back to the caller as a structured result.
  if (mutation.kind === 'concurrent_modification') {
    return { ok: false, error: mutation.message, code: CONCURRENT_MODIFICATION_CODE };
  }
  if (mutation.kind === 'unknown_token') {
    // The run was pruned between token resolution and the save.
    return { ok: false, error: UNKNOWN_TOKEN_MESSAGE, code: CLIErrorCodes.UNKNOWN_TOKEN };
  }

  output.action(
    deriveGotoActionBlock({
      steps: navigation.steps,
      previousState: mutation.previousState,
      updatedState: mutation.updatedState,
      target,
    }),
  );

  // Create emitter bridged to unified output
  const emitter = createBridgedEmitter(state, output);

  const progression = await driveRunProgression(mutation.progression, {
    manager,
    cwd,
    output,
    sink: emitter,
    ...(ctx.commandStreamOptions === undefined
      ? {}
      : { commandStreamOptions: ctx.commandStreamOptions }),
  });
  return { ok: true, progression };
}
