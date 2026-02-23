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
  parseRunbookDocument,
  stepIdToString,
  parseStepIdFromString,
  type PendingStep,
  type RunbookState,
  type ExecutionEventEmitter,
  type Runbook,
  type DataSource,
} from '@rundown-org/core';
import { isSourced, type ForClause } from '@rundown-org/parser';
import { resolveRunbookFile } from './resolve-runbook.js';
import { runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { extractVarsFromMarkdown, resolveVariables } from '../services/variable-discovery.js';
import {
  substituteRunbookVariables,
  expandForClauseVariables,
} from '../services/template-renderer.js';

/**
 * Variable options from CLI flags.
 */
export interface VarOptions {
  varFile?: string;
  var?: string[];
}

/**
 * Context for running the pipeline.
 */
export interface RunPipelineContext {
  output: OutputEmitter;
  manager: RunbookStateManager;
  actorService: RunbookActorService;
  sessionService: SessionService;
  lifecycleService: ExecutionLifecycleService;
  cwd: string;
}

/**
 * A fully prepared runbook ready for state creation.
 */
export interface PreparedRunbook {
  filePath: string;
  rawContent: string;
  runbook: Runbook;
  mergedVariables: Record<string, string>;
  sources: Record<string, DataSource>;
}

/**
 * Result types for pipeline operations.
 */
export type StepQueueResult =
  | { ok: true; stepId: string; runbook?: string }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> };

export type RunbookStartResult =
  | { ok: true; loopResult: 'done' | 'stopped' | 'waiting' }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> };

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
    statePath: `.claude/rundown/runs/${runbookState.id}.json`,
  });
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

  // Pre-expand FOR clause bounds (parser needs numeric values)
  const forExpandedContent = expandForClauseVariables(
    rawContent,
    mergedVariables,
    new Set(Object.keys(sources)),
  );

  // Parse markdown
  const rawRunbook = parseRunbookDocument(forExpandedContent, path.basename(filePath));

  // Substitute variables into parsed AST
  const runbook = substituteRunbookVariables(rawRunbook, mergedVariables);

  // Validate sourced FOR clauses reference defined data sources
  validateSources(runbook.steps, sources);

  if (runbook.steps.length === 0) {
    return {
      ok: false,
      error: 'Runbook has no steps',
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
    };
  }

  return { ok: true, prepared: { filePath, rawContent, runbook, mergedVariables, sources } };
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

  const state = await sessionService.getActive();
  if (!state) {
    return { ok: false, error: 'No active runbook', code: 'NO_ACTIVE_RUNBOOK' };
  }

  const stepId = parseStepIdFromString(stepStr);
  if (!stepId) {
    return {
      ok: false,
      error: `Invalid step ID format: ${stepStr}. Expected format: "3" or "3.1"`,
      code: 'INVALID_SYNTAX',
      details: { provided: stepStr },
    };
  }

  const pendingStep: PendingStep = { stepId, runbook: file };
  await lifecycleService.pushPendingStep(state.id, pendingStep);

  return { ok: true, stepId: stepIdToString(stepId), runbook: file };
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
  const { output, manager, actorService, sessionService, cwd } = ctx;
  const { filePath, rawContent, runbook, mergedVariables, sources } = prepared;

  const runbookPath = path.relative(cwd, filePath);
  const state = await manager.create(options.file, runbook, {
    runbookPath,
    prompted: options.prompted,
    agentId: options.agentId,
    runbookSrc: rawContent,
    templateVars: mergedVariables,
    sources,
  });

  // Initialize actor state (populates forStack for first step)
  await actorService.initializeState(state.id, [...runbook.steps]);

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
  emitRunbookStarted(emitter, state, !!options.prompted);

  // Run execution loop
  const loopResult = await runExecutionLoop(
    manager,
    state.id,
    [...runbook.steps],
    cwd,
    !!options.prompted,
    options.agentId,
    emitter,
  );

  return { ok: true, loopResult };
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
  const { output, manager, actorService, sessionService, lifecycleService, cwd } = ctx;

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

  await manager.bindAgent(state.id, agentId, pending.stepId);

  output.status(
    true,
    'agent_bound',
    `Agent ${agentId} bound to step ${stepIdToString(pending.stepId)}`,
    {
      agent: agentId,
      stepId: stepIdToString(pending.stepId),
    },
  );
  output.flush();

  // If pending step has a runbook, start child runbook
  if (pending.runbook) {
    const prepResult = await prepareRunbook(pending.runbook, varOpts, cwd);
    if (!prepResult.ok) {
      // Adjust error message for child context
      const error =
        prepResult.code === 'RUNBOOK_NOT_FOUND'
          ? `Runbook file not found: ${pending.runbook}`
          : prepResult.code === 'VALIDATION_ERROR'
            ? 'Child runbook has no steps'
            : prepResult.error;
      return {
        ok: false,
        error,
        code: prepResult.code,
        details: { runbook: pending.runbook, ...prepResult.details },
      };
    }

    const { filePath, rawContent, runbook, mergedVariables, sources } = prepResult.prepared;

    // Inherit prompted flag from parent runbook
    const parentState = await manager.load(state.id);
    const parentPrompted = parentState?.prompted ?? false;

    const childRunbookPath = path.relative(cwd, filePath);
    const childState = await manager.create(pending.runbook, runbook, {
      runbookPath: childRunbookPath,
      agentId,
      parentRunbookId: state.id,
      parentStepId: pending.stepId,
      prompted: parentPrompted,
      runbookSrc: rawContent,
      templateVars: mergedVariables,
      sources,
    });

    // Initialize actor state (populates forStack for first step)
    await actorService.initializeState(childState.id, [...runbook.steps]);

    await manager.updateAgentBinding(state.id, agentId, {
      childRunbookId: childState.id,
    });

    await sessionService.pushRunbook(childState.id, agentId);

    // Update lastAction
    await manager.update(childState.id, { lastAction: { type: 'START' } });

    // Create emitter for CHILD runbook
    const emitter = createBridgedEmitter(childState, output);

    // Emit RUNBOOK_STARTED for child
    emitRunbookStarted(emitter, childState, parentPrompted);

    // Run execution loop
    const loopResult = await runExecutionLoop(
      manager,
      childState.id,
      [...runbook.steps],
      cwd,
      parentPrompted,
      agentId,
      emitter,
    );

    return { ok: true, loopResult };
  }

  return { ok: true };
}
