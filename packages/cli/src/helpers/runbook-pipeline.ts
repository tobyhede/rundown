/**
 * Business logic for the run command.
 *
 * Extracts the runbook preparation pipeline, runbook starting,
 * and delegation claim/launch logic from commands/run.ts.
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
  deriveActiveFrame,
  parseRunbookDocument,
  type RunbookState,
  type ExecutionEventEmitter,
  type Runbook,
  type DataSource,
  type DelegationLinkage,
  STATE_DIR,
  DelegationScanService,
  DelegationLock,
  reconstituteContextVars,
  hashDelegationToken,
  truncateDelegationToken,
  DELEGATION_TOKEN_PREFIX,
  ErrorCodes,
} from '@rundown-org/core';
import { isSourced, stepHasSubsteps, type Step } from '@rundown-org/parser';
import { resolveRunbookFile } from './resolve-runbook.js';
import { runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import {
  FileSourcePolicyError,
  extractVarsFromMarkdown,
  resolveVariables,
} from '../services/variable-discovery.js';
import {
  substituteRunbookVariables,
  expandForClauseVariables,
} from '../services/template-renderer.js';
import { getPolicyEvaluator, getPolicyPrompter } from '../services/policy-context.js';

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

/** Result of starting a runbook execution loop via {@link startRunbook}. */
export type RunbookStartResult =
  | { ok: true; loopResult: 'done' | 'stopped' | 'waiting' }
  | { ok: false; error: string; code: string; details?: Record<string, unknown> };

/**
 * Result of claiming a delegation token and launching the child runbook.
 *
 * A discriminated union keyed on `ok`. On success, contains identifiers
 * linking parent and child runs. On failure, contains a human-readable
 * error, a machine-readable code, and optional structured details.
 *
 * Possible error codes:
 * - `RD-807` (`INVALID_TOKEN`) -- token format invalid
 * - `RD-808` (`TOKEN_NOT_FOUND`) -- no active run with this token
 * - `RD-809` (`TOKEN_CANCELLED`) -- delegation was cancelled
 * - `RD-810` (`DELEGATION_LOCK_TIMEOUT`) -- could not acquire lock
 *
 * @see claimAndLaunch
 * @see ErrorCodes
 */
export type ClaimResult =
  | {
      /** Discriminator indicating success. */
      ok: true;
      /** Unique identifier of the launched (or idempotently returned) child run. */
      childRunId: string;
      /** Unique identifier of the parent run that owns the delegation. */
      parentRunId: string;
      /** Step (or substep) ID on the parent that holds the delegation. */
      stepId: string;
      /** Terminal state of the child execution loop. */
      loopResult: 'done' | 'stopped' | 'waiting';
    }
  | {
      /** Discriminator indicating failure. */
      ok: false;
      /** Human-readable error description. */
      error: string;
      /** Machine-readable error code (e.g. `'RD-807'`). */
      code: string;
      /** Optional structured details for diagnostics. */
      details?: Record<string, unknown>;
    };

/**
 * Validate that all sourced FOR clauses reference defined data sources.
 *
 * @param steps - Parsed runbook steps
 * @param sources - Resolved data sources
 * @throws Error if any step references an undefined source
 */
export function validateSources(
  steps: readonly Step[],
  sources: Readonly<Record<string, unknown>>,
): void {
  for (const step of steps) {
    if (step.kind === 'for' && isSourced(step.forClause)) {
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
 *
 * @param vars - User/config template variables to namespace under `context.vars.*`
 * @returns Record mapping `context.vars.{key}` to corresponding values
 */
function buildContextVars(vars: Readonly<Record<string, string>>): Record<string, string> {
  const contextVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    contextVars[`context.vars.${key}`] = value;
  }
  return contextVars;
}

/**
 * Prepare a runbook from file: resolve, load, parse, substitute variables.
 *
 * This is the shared pipeline used by file start and delegation claim.
 *
 * @param file - Runbook file path or name
 * @param varOpts - Variable options from CLI flags
 * @param cwd - Current working directory
 * @param options - Optional settings including inherited context variables from parent runbook
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
  let mergedVariables: Record<string, string>;
  let sources: Record<string, DataSource>;
  try {
    const resolvedVariables = await resolveVariables(
      { varFile: varOpts.varFile, var: varOpts.var, frontmatterVars },
      cwd,
      {
        evaluator: getPolicyEvaluator(),
        prompter: getPolicyPrompter(),
      },
    );
    mergedVariables = { ...resolvedVariables.vars };
    sources = { ...resolvedVariables.sources };
  } catch (error) {
    if (error instanceof FileSourcePolicyError) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
        details: {
          runbook: file,
          variable: error.variable,
          filePath: error.filePath,
          reason: error.reason,
        },
      };
    }
    throw error;
  }
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
 * Shared launch logic for starting a runbook (or child runbook).
 *
 * Creates state, initializes actor, pushes to session, sets up emitter,
 * and runs the execution loop. Used by `startRunbook` and `claimAndLaunch`.
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
    delegationLinkage?: DelegationLinkage;
    afterInit?: (stateId: string) => Promise<void>;
  },
): Promise<RunbookStartResult> {
  const { output, manager, actorService, sessionService, lifecycleService, cwd } = ctx;
  const { filePath, rawContent, runbook, mergedVariables, sources } = prepared;

  const runbookPath = path.relative(cwd, filePath);
  const state = await manager.create(options.runbookName, runbook, {
    runbookPath,
    prompted: options.prompted,
    delegation: options.delegationLinkage,
    runbookSrc: rawContent,
    templateVars: mergedVariables,
    sources,
  });

  // Initialize actor state (populates forStack for first step)
  await actorService.initializeState(state.id, [...runbook.steps]);
  await lifecycleService.ensureActiveEntry(state.id);

  // Optional post-init hook (e.g., linking delegation childRunId)
  if (options.afterInit) {
    await options.afterInit(state.id);
  }

  await sessionService.pushRunbook(state.id);

  if (stepHasSubsteps(runbook.steps[0]) && runbook.steps[0].substeps.length > 0) {
    const freshState = await manager.load(state.id);
    const frame = freshState ? deriveActiveFrame(freshState) : { frameKey: undefined };
    await manager.initializeSubsteps(
      state.id,
      runbook.steps[0].substeps,
      freshState?.activeFrameKey ?? frame.frameKey,
    );
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
  options: { file: string; prompted?: boolean },
): Promise<RunbookStartResult> {
  return launchRunbook(ctx, prepared, {
    runbookName: options.file,
    prompted: !!options.prompted,
  });
}

/**
 * Infer entry number from persisted frame state when not explicitly set.
 *
 * @param state - Current runbook state containing frame entry history
 * @param frameKey - Frame key to look up (`step|iteration` format)
 * @returns The inferred entry number, or undefined if no history exists
 */
function inferEntryFromState(state: RunbookState, frameKey: string): number | undefined {
  const known = state.frameEntries?.[frameKey];
  if (state.activeFrameKey === frameKey && state.activeEntry) return state.activeEntry;
  if (known && known > 0) return known;
  return undefined;
}

/**
 * Update a parent step/substep delegation's childRunId after the child run is created.
 *
 * Loads the parent state, locates the delegation on the specified substep, and
 * patches the `childRunId` field to link parent and child runs.
 * Uses tokenHash for precise matching when available (unique per delegation).
 *
 * @param manager - State manager for loading and persisting runbook state
 * @param runId - Parent run ID whose delegation to update
 * @param substepId - Substep ID (or bare step ID) that owns the delegation
 * @param childRunId - The newly created child run ID to set
 * @param tokenHash - Optional token hash for precise matching
 * @throws Error if the parent run is not found
 */
async function updateStepDelegationChildRunId(
  manager: RunbookStateManager,
  runId: string,
  substepId: string,
  childRunId: string,
  tokenHash?: string,
): Promise<void> {
  const state = await manager.load(runId);
  if (!state) throw new Error(`Parent run ${runId} not found`);

  const substepStates = state.substepStates ?? [];
  const updated = substepStates.map((ss) => {
    if (ss.id === substepId && ss.delegation) {
      // When tokenHash is provided, match precisely; otherwise fall back to id match
      if (tokenHash && ss.delegation.tokenHash !== tokenHash) return ss;
      return {
        ...ss,
        delegation: { ...ss.delegation, childRunId },
      };
    }
    return ss;
  });

  await manager.update(runId, { substepStates: updated });
}

/**
 * Claim a delegation token, reconstitute inherited context, and launch the child runbook.
 *
 * Algorithm (per design doc section 6.2):
 * 1. Validate token format (must start with rdtk_)
 * 2. Scan all run states for matching token hash
 * 3. Acquire delegation lock for parent run ID
 * 4. Under lock: re-load parent, check idempotency/cancellation, reconstitute context
 * 5. Prepare and launch child runbook
 * 6. Update parent delegation with child run ID
 *
 * @param ctx - Pipeline context
 * @param rawToken - The plain-text delegation token to claim
 * @param varOpts - Variable options from CLI flags
 * @returns ClaimResult with child run details or error
 */
export async function claimAndLaunch(
  ctx: RunPipelineContext,
  rawToken: string,
  varOpts: VarOptions,
): Promise<ClaimResult> {
  const { output, manager, cwd } = ctx;
  const truncatedToken = truncateDelegationToken(rawToken);

  // 1. Validate token format
  if (!rawToken.startsWith(DELEGATION_TOKEN_PREFIX)) {
    return {
      ok: false,
      error: `Invalid token format. Tokens must start with "${DELEGATION_TOKEN_PREFIX}".`,
      code: ErrorCodes.INVALID_TOKEN.code,
      details: { token: truncatedToken },
    };
  }

  // 2. Scan for matching token
  const scanner = new DelegationScanService(manager);
  const scanResult = await scanner.findByToken(rawToken);

  if (!scanResult) {
    return {
      ok: false,
      error: 'No active run contains a delegation with this token.',
      code: ErrorCodes.TOKEN_NOT_FOUND.code,
      details: { token: truncatedToken },
    };
  }

  const { parentState, stepId, substepId, delegation: _delegation } = scanResult;
  const lock = new DelegationLock(cwd);

  // 3. Acquire delegation lock
  try {
    await lock.acquire(parentState.id);
  } catch (err) {
    // acquire() throws "Delegation lock timeout ..." for deadline expiry.
    // Re-throw anything else (EACCES, EIO, etc.) as an unexpected error.
    if (err instanceof Error && err.message.startsWith('Delegation lock timeout')) {
      return {
        ok: false,
        error: `Could not acquire delegation lock for run ${parentState.id}. Another operation may be in progress.`,
        code: ErrorCodes.DELEGATION_LOCK_TIMEOUT.code,
        details: { parentRunId: parentState.id },
      };
    }
    throw err;
  }

  try {
    // 4a. Re-load parent state (freshness check)
    const freshParent = await manager.load(parentState.id);
    if (!freshParent) {
      return {
        ok: false,
        error: `Parent run ${parentState.id} no longer exists.`,
        code: ErrorCodes.TOKEN_NOT_FOUND.code,
        details: { parentRunId: parentState.id },
      };
    }

    // Re-locate delegation on fresh state (match by tokenHash for precision)
    const freshSubstep = (freshParent.substepStates ?? []).find(
      (ss) =>
        ss.id === (substepId ?? stepId) &&
        ss.delegation?.tokenHash === hashDelegationToken(rawToken),
    );
    const freshDelegation = freshSubstep?.delegation;

    if (!freshDelegation) {
      return {
        ok: false,
        error: 'Delegation no longer exists on parent step.',
        code: ErrorCodes.TOKEN_NOT_FOUND.code,
        details: { parentRunId: parentState.id, stepId },
      };
    }

    // Verify token hash still matches
    const tokenHash = hashDelegationToken(rawToken);
    if (freshDelegation.tokenHash !== tokenHash) {
      return {
        ok: false,
        error: 'Token hash mismatch after re-load.',
        code: ErrorCodes.TOKEN_NOT_FOUND.code,
        details: { parentRunId: parentState.id },
      };
    }

    // 4b. Idempotent return if already claimed
    if (freshDelegation.childRunId) {
      return {
        ok: true,
        childRunId: freshDelegation.childRunId,
        parentRunId: freshParent.id,
        stepId,
        loopResult: 'waiting',
      };
    }

    // 4c. Check for cancellation
    if (freshDelegation.cancelledAt) {
      return {
        ok: false,
        error: 'This delegation has been cancelled and cannot be claimed.',
        code: ErrorCodes.TOKEN_CANCELLED.code,
        details: { parentRunId: freshParent.id, stepId, cancelledAt: freshDelegation.cancelledAt },
      };
    }

    // 4d. Orphan reconciliation: scan for child run with matching tokenHash
    const orphan = await scanner.findOrphanedChild(tokenHash);
    if (orphan) {
      // Adopt the orphan — set childRunId on parent
      await updateStepDelegationChildRunId(
        manager,
        freshParent.id,
        substepId ?? stepId,
        orphan.id,
        tokenHash,
      );
      return {
        ok: true,
        childRunId: orphan.id,
        parentRunId: freshParent.id,
        stepId,
        loopResult: 'waiting',
      };
    }

    // 4e. Reconstitute context vars from frozen snapshot
    const inheritedContextVars = reconstituteContextVars(freshDelegation.contextSnapshot);

    // 4f. Prepare child runbook
    const prepResult = await prepareRunbook(freshDelegation.childRunbookPath, varOpts, cwd, {
      inheritedContextVars,
    });
    if (!prepResult.ok) {
      return {
        ok: false,
        error: prepResult.error,
        code: prepResult.code,
        details: { runbook: freshDelegation.childRunbookPath, ...prepResult.details },
      };
    }

    // Build delegation linkage for the child run
    const parentFrame = deriveActiveFrame(freshParent);
    const delegationLinkage: DelegationLinkage = {
      parentRunId: freshParent.id,
      parentStepId: substepId ?? stepId,
      tokenHash,
      parentStep: freshParent.step,
      parentFrameKey: parentFrame.frameKey,
      parentEntry: inferEntryFromState(freshParent, parentFrame.frameKey),
    };

    const parentPrompted = freshParent.prompted ?? false;

    // 4g. Launch child runbook
    let capturedChildRunId: string | undefined;

    const launchResult = await launchRunbook(ctx, prepResult.prepared, {
      runbookName: freshDelegation.childRunbookPath,
      prompted: parentPrompted,
      delegationLinkage,
      afterInit: async (childStateId) => {
        // Set childRunId on parent delegation (tokenHash for precise matching)
        await updateStepDelegationChildRunId(
          manager,
          freshParent.id,
          substepId ?? stepId,
          childStateId,
          tokenHash,
        );
        capturedChildRunId = childStateId;
      },
    });

    if (!launchResult.ok) {
      return {
        ok: false,
        error: launchResult.error,
        code: launchResult.code,
        details: launchResult.details,
      };
    }

    const childRunId = capturedChildRunId ?? 'unknown';

    // Emit claimed output
    output.status(
      true,
      'claimed',
      `Claimed ${truncatedToken} -> ${freshDelegation.childRunbookPath}`,
      {
        action: 'claimed',
        token: truncatedToken,
        run_id: childRunId,
        runbook: freshDelegation.childRunbookPath,
        parent_run_id: freshParent.id,
        parent_step: substepId ? `${stepId}.${substepId}` : stepId,
      },
    );

    return {
      ok: true,
      childRunId,
      parentRunId: freshParent.id,
      stepId,
      loopResult: launchResult.loopResult,
    };
  } finally {
    // 5. Always release lock
    await lock.release(parentState.id);
  }
}
