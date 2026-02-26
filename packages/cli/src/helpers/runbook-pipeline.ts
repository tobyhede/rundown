/**
 * Business logic for the run command.
 *
 * Extracts the runbook preparation pipeline, step queuing, runbook starting,
 * and agent binding logic from commands/run.ts. The duplicated prepare-and-start
 * pipeline (Mode 2 / Mode 3) is unified into shared functions.
 *
 * @module helpers/runbook-pipeline
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type RunbookStateManager,
  type RunbookActorService,
  type SessionService,
  type ExecutionLifecycleService,
  deriveExecutionAt,
  getActiveForContext,
  parseRunbookDocument,
  stepIdToString,
  parseStepIdFromString,
  type PendingStep,
  type RunbookState,
  type ExecutionEventEmitter,
  type Runbook,
  type DataSource,
  type StepId,
  STATE_DIR,
} from '@rundown-org/core';
import { isSourced, type ForClause } from '@rundown-org/parser';
import { resolveRunbookFile } from './resolve-runbook.js';
import { getRunbookFromState } from './runbook-loader.js';
import { buildStepVariables, runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { extractVarsFromMarkdown, resolveVariables } from '../services/variable-discovery.js';
import {
  substituteRunbookVariables,
  expandForClauseVariables,
  expandLoopVariables,
} from '../services/template-renderer.js';

/**
 * Variable options from CLI flags.
 */
export interface VarOptions {
  /** Path to a YAML file containing variable definitions */
  varFile?: string;
  /** Inline key=value variable overrides (repeatable) */
  var?: string[];
}

/**
 * Context for running the pipeline.
 */
export interface RunPipelineContext {
  /** Output emitter for rendering status and error messages */
  output: OutputEmitter;
  /** State manager for persisting runbook state changes */
  manager: RunbookStateManager;
  /** Actor service for managing XState actor lifecycle */
  actorService: RunbookActorService;
  /** Session service for tracking active/stashed runbooks */
  sessionService: SessionService;
  /** Lifecycle service for managing pending steps and transitions */
  lifecycleService: ExecutionLifecycleService;
  /** Current working directory for file resolution */
  cwd: string;
}

/**
 * A fully prepared runbook ready for state creation.
 */
export interface PreparedRunbook {
  /** Absolute path to the resolved runbook file */
  filePath: string;
  /** Raw markdown content of the runbook file */
  rawContent: string;
  /** Parsed and variable-substituted runbook AST */
  runbook: Runbook;
  /** Merged template variables from all sources */
  mergedVariables: Record<string, string>;
  /** Resolved data sources for FOR loop iteration */
  sources: Record<string, DataSource>;
}

/**
 * Result of queuing a step for agent binding.
 *
 * On success, returns the resolved step ID and optional child runbook path.
 * On failure, returns an error message with a machine-readable code.
 */
export type StepQueueResult =
  | {
      ok: true;
      stepId: string;
      runbook?: string;
      /** Qualified execution location (e.g., `"2"`, `"2.3.1"`). */
      targetAt?: string;
    }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> };

/** Result of starting a runbook execution loop via {@link startRunbook}. */
export type RunbookStartResult =
  | { ok: true; loopResult: 'done' | 'stopped' | 'waiting' }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> };

/** Result of binding an agent to a child runbook via {@link bindAgent}. */
export type AgentBindResult =
  | { ok: true; loopResult?: 'done' | 'stopped' | 'waiting' }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> };

/**
 * Validate that all sourced FOR clauses reference defined data sources.
 *
 * @param steps - Parsed runbook steps
 * @param sources - Resolved data sources
 * @throws Error if any step references an undefined source
 */
export function validateSources(
  steps: readonly { forClause?: ForClause }[],
  sources: Readonly<Record<string, unknown>>,
): void {
  for (const step of steps) {
    if (step.forClause && isSourced(step.forClause)) {
      const name = step.forClause.source;
      if (!(name in sources)) {
        throw new Error(
          `FOR loop references undefined data source "{{${name}}}". ` +
            `Define "${name}" in .rundown/config.yaml or pass --var-file with an array value.`,
        );
      }
    }
  }
}

/**
 * Emit RUNBOOK_STARTED event with metadata.
 */
function emitRunbookStarted(
  emitter: ExecutionEventEmitter,
  runbookState: RunbookState,
  prompted: boolean,
): void {
  emitter.emit('RUNBOOK_STARTED', {
    title: runbookState.title,
    description: runbookState.description,
    prompted,
    statePath: `${STATE_DIR}/${runbookState.id}.json`,
  });
}

/**
 * Build canonical current-context variable aliases for static template substitution.
 */
function buildContextVars(vars: Readonly<Record<string, string>>): Record<string, string> {
  const contextVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    contextVars[`context.vars.${key}`] = value;
  }
  return contextVars;
}

const MAX_INHERITED_CONTEXT_LINEAGE_DEPTH = 32;

class InheritedContextBuildError extends Error {
  readonly code = 'STATE_CORRUPTION';
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'InheritedContextBuildError';
    this.details = details;
  }
}

interface FrameSnapshot {
  step: string;
  substep?: string;
  index?: number;
  at: string;
}

function snapshotFrame(state: RunbookState): FrameSnapshot {
  const activeFor = getActiveForContext(state.forStack, state.step);
  return {
    step: state.step,
    substep: state.substep,
    index: activeFor?.iteration,
    at: deriveExecutionAt(state.step, state.substep, activeFor?.iteration),
  };
}

function writeFrameContext(
  target: Record<string, string>,
  prefix: string,
  frame: FrameSnapshot,
): void {
  target[`${prefix}.step`] = frame.step;
  target[`${prefix}.at`] = frame.at;
  if (frame.substep) {
    target[`${prefix}.substep`] = frame.substep;
  }
  if (frame.index !== undefined) {
    target[`${prefix}.index`] = String(frame.index);
  }
}

/**
 * Build frozen ancestry context variables for child runbook launches.
 *
 * Produces:
 * - context.parent.*
 * - context.parent.parent.* (chain form)
 * - context.ancestors.N.* (array-like addressing)
 */
async function buildInheritedContextVars(
  manager: RunbookStateManager,
  parentState: RunbookState,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  const lineage: RunbookState[] = [];
  const lineageIds: string[] = [];
  const visited = new Set<string>();

  let cursor: RunbookState | null = parentState;
  while (cursor) {
    if (visited.has(cursor.id)) {
      throw new InheritedContextBuildError(
        `Detected parent runbook cycle while building inherited context at runbook "${cursor.id}".`,
        {
          reason: 'PARENT_CYCLE',
          repeatedRunbookId: cursor.id,
          lineage: lineageIds,
        },
      );
    }
    if (lineage.length >= MAX_INHERITED_CONTEXT_LINEAGE_DEPTH) {
      throw new InheritedContextBuildError(
        `Parent runbook lineage exceeds maximum depth (${String(MAX_INHERITED_CONTEXT_LINEAGE_DEPTH)}).`,
        {
          reason: 'PARENT_LINEAGE_DEPTH_EXCEEDED',
          maxDepth: MAX_INHERITED_CONTEXT_LINEAGE_DEPTH,
          lineage: lineageIds,
        },
      );
    }
    visited.add(cursor.id);
    lineageIds.push(cursor.id);
    lineage.push(cursor);
    if (!cursor.parentRunbookId) break;
    cursor = await manager.load(cursor.parentRunbookId);
  }

  for (let i = 0; i < lineage.length; i += 1) {
    const frame = snapshotFrame(lineage[i]);
    writeFrameContext(vars, `context.ancestors.${String(i)}`, frame);
  }

  let parentPath = 'context.parent';
  for (let i = 0; i < lineage.length; i += 1) {
    const frame = snapshotFrame(lineage[i]);
    writeFrameContext(vars, parentPath, frame);
    parentPath += '.parent';
  }

  return vars;
}

/**
 * Prepare a runbook from file: resolve, load, parse, substitute variables.
 *
 * This is the shared pipeline used by both Mode 2 (file start) and
 * Mode 3 (agent child runbook).
 *
 * @param file - Runbook file path or name
 * @param varOpts - Variable options from CLI flags
 * @param cwd - Current working directory
 * @returns PreparedRunbook or error result
 */
export async function prepareRunbook(
  file: string,
  varOpts: VarOptions,
  cwd: string,
  options?: {
    inheritedContextVars?: Readonly<Record<string, string>>;
  },
): Promise<
  | { ok: true; prepared: PreparedRunbook }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> }
> {
  const filePath = await resolveRunbookFile(cwd, file);

  if (!filePath) {
    return {
      ok: false,
      error: `Runbook not found: ${file}. Try 'rd ls --all' to list available runbooks.`,
      code: 'RUNBOOK_NOT_FOUND',
      details: { runbook: file },
    };
  }

  const rawContent = await fs.readFile(filePath, 'utf8');
  const frontmatterVars = extractVarsFromMarkdown(rawContent);
  const { vars: mergedVariables, sources } = await resolveVariables(
    { varFile: varOpts.varFile, var: varOpts.var, frontmatterVars },
    cwd,
  );
  const templateVars: Record<string, string> = {
    ...mergedVariables,
    ...buildContextVars(mergedVariables),
    ...(options?.inheritedContextVars ?? {}),
  };

  // Pre-expand FOR clause bounds (parser needs numeric values)
  const forExpandedContent = expandForClauseVariables(
    rawContent,
    templateVars,
    new Set(Object.keys(sources)),
  );

  // Parse markdown
  const rawRunbook = parseRunbookDocument(forExpandedContent, path.basename(filePath));

  // Substitute variables into parsed AST
  const runbook = substituteRunbookVariables(rawRunbook, templateVars);

  // Validate sourced FOR clauses reference defined data sources
  try {
    validateSources(runbook.steps, sources);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
    };
  }

  if (runbook.steps.length === 0) {
    return {
      ok: false,
      error: 'Runbook has no steps',
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
    };
  }

  return {
    ok: true,
    prepared: { filePath, rawContent, runbook, mergedVariables: templateVars, sources },
  };
}

/**
 * Mode 1: Queue a step for agent binding.
 *
 * @param ctx - Pipeline context
 * @param stepStr - Step ID string (e.g., "3" or "3.1")
 * @param file - Optional runbook file for the pending step
 * @returns StepQueueResult
 */
export async function queueStep(
  ctx: RunPipelineContext,
  stepStr: string,
  file?: string,
): Promise<StepQueueResult> {
  const { sessionService, lifecycleService } = ctx;

  const loadedState = await sessionService.getActive();
  if (!loadedState) {
    return { ok: false, error: 'No active runbook', code: 'NO_ACTIVE_RUNBOOK' };
  }

  const ensured = await lifecycleService.ensureActiveEntry(loadedState.id, undefined, loadedState);
  const state = ensured.state;

  const stepId = parseStepIdFromString(stepStr);
  if (!stepId) {
    return {
      ok: false,
      error: `Invalid step ID format: ${stepStr}. Expected format: "3" or "3.1"`,
      code: 'INVALID_SYNTAX',
      details: { provided: stepStr },
    };
  }

  // Only the current step may be queued.
  if (stepId.step !== state.step) {
    const activeFor = getActiveForContext(state.forStack, state.step);
    const currentAt = deriveExecutionAt(state.step, state.substep, activeFor?.iteration);
    return {
      ok: false,
      error:
        `Cannot queue step ${stepIdToString(stepId)} from current cursor ${currentAt}. ` +
        'Only active steps may be dispatched.',
      code: 'VALIDATION_ERROR',
      details: {
        current: currentAt,
        requested: stepIdToString(stepId),
      },
    };
  }

  const runbookSteps = state.runbookSrc ? getRunbookFromState(state, ctx.cwd) : [];
  const currentStep = runbookSteps.find((s) => s.name === state.step);
  const hasSubsteps = (currentStep?.substeps?.length ?? 0) > 0;

  if (hasSubsteps && !stepId.substep && !state.substep) {
    const available = currentStep?.substeps?.map((s) => `${state.step}.${s.id}`) ?? [];
    return {
      ok: false,
      error:
        `Step ${state.step} has substeps. Dispatch requires an explicit substep identifier ` +
        `(for example ${available[0] ?? `${state.step}.1`}).`,
      code: 'VALIDATION_ERROR',
      details: {
        current: state.step,
        available,
      },
    };
  }

  const targetSubstep = stepId.substep ?? state.substep;
  if (targetSubstep && runbookSteps.length === 0) {
    return {
      ok: false,
      error: `Cannot validate substep ${state.step}.${targetSubstep} without runbook source context`,
      code: 'VALIDATION_ERROR',
    };
  }
  if (targetSubstep && !hasSubsteps) {
    return {
      ok: false,
      error: `Step ${state.step} has no substeps; cannot dispatch ${state.step}.${targetSubstep}`,
      code: 'STEP_NOT_FOUND',
      details: {
        current: state.step,
        requested: `${state.step}.${targetSubstep}`,
      },
    };
  }
  if (
    targetSubstep &&
    hasSubsteps &&
    currentStep?.substeps?.some((s) => s.id === targetSubstep) !== true
  ) {
    return {
      ok: false,
      error: `Substep ${state.step}.${targetSubstep} is not available from the current step`,
      code: 'STEP_NOT_FOUND',
      details: {
        current: state.step,
        requested: `${state.step}.${targetSubstep}`,
      },
    };
  }

  let inferredRunbook = file;
  if (!inferredRunbook && targetSubstep && hasSubsteps) {
    const substep = currentStep?.substeps?.find((s) => s.id === targetSubstep);
    const workflows = substep?.workflows ?? [];
    if (workflows.length === 1) {
      const stepVars = buildStepVariables(
        state.step,
        targetSubstep,
        state.forStack,
        currentStep?.forClause,
        state.sources,
        state.templateVars,
      );
      let expanded = expandLoopVariables(workflows[0], stepVars);
      // Resolve workflow reference relative to the parent runbook's directory
      const parentDir = state.runbookPath ? path.dirname(state.runbookPath) : '';
      if (parentDir && parentDir !== '.') {
        expanded = path.join(parentDir, expanded);
      }
      inferredRunbook = expanded;
    } else if (workflows.length > 1) {
      return {
        ok: false,
        error:
          `Substep ${state.step}.${targetSubstep} references multiple child runbooks. ` +
          'Specify the runbook path explicitly with `rd run --step <id> <runbook>`.',
        code: 'VALIDATION_ERROR',
        details: {
          requested: `${state.step}.${targetSubstep}`,
          workflows,
        },
      };
    }
  }

  const activeFor = getActiveForContext(state.forStack, state.step);
  const targetAt = deriveExecutionAt(state.step, targetSubstep, activeFor?.iteration);
  const targetFrameKey = lifecycleService.buildTargetFrameKey(state.step, activeFor?.iteration);
  const targetEntry = state.activeEntry ?? ensured.entry;
  const pendingStep: PendingStep = {
    stepId,
    runbook: inferredRunbook,
    targetStep: state.step,
    ...(targetSubstep ? { targetSubstep } : {}),
    ...(activeFor ? { targetIteration: activeFor.iteration } : {}),
    targetFrameKey,
    targetEntry,
  };
  await lifecycleService.pushPendingStep(state.id, pendingStep);

  return {
    ok: true,
    stepId: stepIdToString(stepId),
    runbook: inferredRunbook,
    targetAt,
  };
}

/**
 * Shared launch logic for starting a runbook (or child runbook).
 *
 * Creates state, initializes actor, pushes to session, sets up emitter,
 * and runs the execution loop. Used by both `startRunbook` and `bindAgent`.
 *
 * @param ctx - Pipeline context
 * @param prepared - Prepared runbook data
 * @param options - Launch options including optional parent context
 * @returns RunbookStartResult
 */
async function launchRunbook(
  ctx: RunPipelineContext,
  prepared: PreparedRunbook,
  options: {
    runbookName: string;
    prompted: boolean;
    agentId?: string;
    parentRunbookId?: string;
    parentStepId?: StepId;
    afterInit?: (stateId: string) => Promise<void>;
  },
): Promise<RunbookStartResult> {
  const { output, manager, actorService, sessionService, lifecycleService, cwd } = ctx;
  const { filePath, rawContent, runbook, mergedVariables, sources } = prepared;

  const runbookPath = path.relative(cwd, filePath);
  const state = await manager.create(options.runbookName, runbook, {
    runbookPath,
    prompted: options.prompted,
    agentId: options.agentId,
    parentRunbookId: options.parentRunbookId,
    parentStepId: options.parentStepId,
    runbookSrc: rawContent,
    templateVars: mergedVariables,
    sources,
  });

  // Initialize actor state (populates forStack for first step)
  await actorService.initializeState(state.id, [...runbook.steps]);
  await lifecycleService.ensureActiveEntry(state.id);

  // Optional post-init hook (e.g., updateAgentBinding for child runbooks)
  if (options.afterInit) {
    await options.afterInit(state.id);
  }

  await sessionService.pushRunbook(state.id, options.agentId);

  if (runbook.steps[0].substeps && runbook.steps[0].substeps.length > 0) {
    await manager.initializeSubsteps(state.id, runbook.steps[0].substeps);
    await manager.update(state.id, { substep: runbook.steps[0].substeps[0].id });
  }

  // Update lastAction
  await manager.update(state.id, { lastAction: { type: 'START' } });

  // Create emitter bridged to unified output
  const emitter = createBridgedEmitter(state, output);

  // Emit RUNBOOK_STARTED
  emitRunbookStarted(emitter, state, options.prompted);

  // Run execution loop
  const loopResult = await runExecutionLoop(
    manager,
    state.id,
    [...runbook.steps],
    cwd,
    options.prompted,
    emitter,
    options.agentId,
  );

  return { ok: true, loopResult };
}

/**
 * Mode 2: Start a runbook from a prepared file.
 *
 * @param ctx - Pipeline context
 * @param prepared - Prepared runbook data
 * @param options - Start options
 * @returns RunbookStartResult
 */
export async function startRunbook(
  ctx: RunPipelineContext,
  prepared: PreparedRunbook,
  options: { file: string; prompted?: boolean; agentId?: string },
): Promise<RunbookStartResult> {
  return launchRunbook(ctx, prepared, {
    runbookName: options.file,
    prompted: !!options.prompted,
    agentId: options.agentId,
  });
}

/**
 * Infer entry number from persisted frame state when not explicitly set.
 */
function inferEntryFromState(state: RunbookState, frameKey: string): number | undefined {
  const known = state.frameEntries?.[frameKey];
  if (state.activeFrameKey === frameKey && state.activeEntry) return state.activeEntry;
  if (known && known > 0) return known;
  return undefined;
}

/**
 * Mode 3: Bind agent to pending step, optionally starting child runbook.
 *
 * @param ctx - Pipeline context
 * @param agentId - Agent ID to bind
 * @param varOpts - Variable options from CLI flags
 * @returns AgentBindResult
 */
export async function bindAgent(
  ctx: RunPipelineContext,
  agentId: string,
  varOpts: VarOptions,
): Promise<AgentBindResult> {
  const { output, manager, sessionService, lifecycleService, cwd } = ctx;

  const state = await sessionService.getActive();
  if (!state) {
    return { ok: false, error: 'No active runbook', code: 'NO_ACTIVE_RUNBOOK' };
  }

  const pending = await lifecycleService.popPendingStep(state.id);
  if (!pending) {
    return {
      ok: false,
      error: 'No pending step to bind',
      code: 'AGENT_BINDING_ERROR',
      details: { agent: agentId },
    };
  }

  if (!pending.targetStep) {
    return {
      ok: false,
      error:
        `Pending step ${stepIdToString(pending.stepId)} is missing canonical target identity. ` +
        'Re-queue the step from the active frontier before binding.',
      code: 'AGENT_BINDING_ERROR',
      details: { agent: agentId, stepId: stepIdToString(pending.stepId) },
    };
  }

  const normalizedFrameKey =
    pending.targetFrameKey ??
    lifecycleService.buildTargetFrameKey(pending.targetStep, pending.targetIteration);
  const normalizedEntry = pending.targetEntry ?? inferEntryFromState(state, normalizedFrameKey);
  if (!normalizedEntry) {
    return {
      ok: false,
      error:
        `Pending step ${stepIdToString(pending.stepId)} is missing target entry metadata. ` +
        'Re-queue from the active frontier and bind again.',
      code: 'AGENT_BINDING_ERROR',
      details: { agent: agentId, stepId: stepIdToString(pending.stepId) },
    };
  }

  const normalizedPending: PendingStep = {
    ...pending,
    targetFrameKey: normalizedFrameKey,
    targetEntry: normalizedEntry,
  };
  await manager.bindAgent(state.id, agentId, normalizedPending);
  const targetAt = deriveExecutionAt(
    pending.targetStep,
    normalizedPending.targetSubstep,
    normalizedPending.targetIteration,
  );

  output.status(true, 'agent_bound', `Agent ${agentId} bound to step ${targetAt}`, {
    agent: agentId,
    stepId: stepIdToString(normalizedPending.stepId),
    targetAt,
    targetFrameKey: normalizedFrameKey,
    targetEntry: normalizedEntry,
  });
  output.flush();

  // If pending step has a runbook, start child runbook
  if (normalizedPending.runbook) {
    let inheritedContextVars: Record<string, string>;
    try {
      inheritedContextVars = await buildInheritedContextVars(manager, state);
    } catch (error) {
      if (error instanceof InheritedContextBuildError) {
        return {
          ok: false,
          error: error.message,
          code: error.code,
          details: { agent: agentId, runbookId: state.id, ...error.details },
        };
      }
      throw error;
    }
    const prepResult = await prepareRunbook(normalizedPending.runbook, varOpts, cwd, {
      inheritedContextVars,
    });
    if (!prepResult.ok) {
      // Adjust error message for child context
      const error =
        prepResult.code === 'RUNBOOK_NOT_FOUND'
          ? `Runbook file not found: ${normalizedPending.runbook}`
          : prepResult.code === 'VALIDATION_ERROR'
            ? 'Child runbook has no steps'
            : prepResult.error;
      return {
        ok: false,
        error,
        code: prepResult.code,
        details: { runbook: normalizedPending.runbook, ...prepResult.details },
      };
    }

    // Use prompted flag directly from parent state (already loaded)
    const parentPrompted = state.prompted ?? false;

    return launchRunbook(ctx, prepResult.prepared, {
      runbookName: normalizedPending.runbook,
      prompted: parentPrompted,
      agentId,
      parentRunbookId: state.id,
      parentStepId: normalizedPending.stepId,
      afterInit: (childStateId) =>
        manager.updateAgentBinding(state.id, agentId, {
          childRunbookId: childStateId,
        }),
    });
  }

  return { ok: true };
}
