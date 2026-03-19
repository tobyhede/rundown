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
  buildFrameKey,
  type FrameKey,
  type RunbookState,
  type ExecutionEventEmitter,
  type ResolvedRunbook,
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
  getErrorMessage,
} from '@rundown-org/core';
import {
  parseRunbookDocument,
  isSourced,
  stepHasSubsteps,
  resolvedStepHasSubsteps,
  type Step,
  type ResolvedStep,
  type ValidationDiagnostic,
  type RunbookFrontmatter,
  type Runbook,
} from '@rundown-org/parser';
import { resolveRunbookFile } from './resolve-runbook.js';
import { runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { FileSourcePolicyError, resolveVariables } from '../services/variable-discovery.js';
import {
  substituteRunbookVariables,
  resolveForBounds,
  collectUnresolvedRunbookVariables,
} from '../services/template-renderer.js';
import { getPolicyEvaluator, getPolicyPrompter } from '../services/policy-context.js';
import { validateFrontmatterVars } from './validate-frontmatter-vars.js';

/**
 * Variable options from CLI flags.
 */
export interface VarOptions {
  /** Paths to YAML files containing variable definitions (repeatable) */
  varFile?: string[];
  /** Inline key=value variable overrides (repeatable) */
  var?: string[];
  /** Inline key=json variable overrides with JSON values (repeatable) */
  varJson?: string[];
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
  /** Parsed and variable-substituted runbook AST (all FOR bounds resolved) */
  runbook: ResolvedRunbook;
  /** Merged template variables from all sources */
  mergedVariables: Record<string, string>;
  /** Resolved data sources for FOR loop iteration */
  sources: Record<string, DataSource>;
  /** Step and substep counts */
  stats: { steps: number; substeps: number };
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
 * @param steps - Resolved runbook steps (all FOR bounds already resolved)
 * @param sources - Resolved data sources
 * @throws {Error} if any step references an undefined source
 */
export function validateSources(
  steps: readonly ResolvedStep[],
  sources: Readonly<Record<string, unknown>>,
): void {
  for (const step of steps) {
    if (step.kind === 'for' && isSourced(step.forClause)) {
      const name = step.forClause.source;
      if (!Object.hasOwn(sources, name)) {
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
 * @param emitter - Event emitter for publishing execution events
 * @param runbookState - Current runbook state with title and description
 * @param prompted - Whether the runbook is running in prompted mode
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
export function buildContextVars(vars: Readonly<Record<string, string>>): Record<string, string> {
  const contextVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    contextVars[`context.vars.${key}`] = value;
  }
  return contextVars;
}

/**
 * Build the complete template variable map from all sources.
 *
 * Merges inherited user vars with locally resolved vars, computes `context.vars.*`
 * aliases from the full user-var set, and overlays inherited context vars.
 *
 * @param localVars - Variables resolved from this runbook's frontmatter, config, and CLI flags
 * @param options - Optional inherited variables from parent delegation
 * @param options.inheritedUserVars - User variables inherited from a parent delegation
 * @param options.inheritedContextVars - Context variables inherited from a parent delegation
 * @returns Complete template variable map ready for substitution
 */
export function buildTemplateVars(
  localVars: Readonly<Record<string, string>>,
  options?: {
    inheritedUserVars?: Readonly<Record<string, string>>;
    inheritedContextVars?: Readonly<Record<string, string>>;
  },
): Record<string, string> {
  const effectiveUserVars: Record<string, string> = {
    ...(options?.inheritedUserVars ?? {}), // parent --var (overridable)
    ...localVars, // child frontmatter + claim --var (overrides)
  };
  return {
    ...effectiveUserVars,
    ...buildContextVars(effectiveUserVars), // aliases from FULL user-var set
    ...(options?.inheritedContextVars ?? {}), // context.parent.vars.* etc.
  };
}

/** Success result from {@link prepareRunbook}. */
export interface PrepareSuccess {
  ok: true;
  prepared: PreparedRunbook;
  warnings?: readonly string[];
  /** Structural validation diagnostics from parser + frontmatter */
  diagnostics: readonly ValidationDiagnostic[];
  /** Unresolved template variable names after substitution */
  unresolved: readonly string[];
}

/** Failure result from {@link prepareRunbook}. */
export interface PrepareFailure {
  ok: false;
  error: string;
  code: string;
  details?: Record<string, unknown>;
  /** Partial results — available when pipeline progressed past parse */
  variables?: Record<string, string>;
  sources?: Record<string, DataSource>;
  stats?: { steps: number; substeps: number };
  diagnostics?: readonly ValidationDiagnostic[];
  warnings?: readonly string[];
}

/** Discriminated union result of {@link prepareRunbook}. */
export type PrepareResult = PrepareSuccess | PrepareFailure;

/**
 * Count substeps across all steps in a runbook.
 *
 * @param steps - Parsed runbook steps
 * @returns Total number of substeps
 */
export function countSubsteps(steps: readonly Step[]): number {
  return steps.reduce((count, step) => {
    return count + (stepHasSubsteps(step) ? step.substeps.length : 0);
  }, 0);
}

/**
 * Success result from {@link loadAndParseRunbook}.
 *
 * Contains the parsed runbook AST, validated frontmatter, structural
 * diagnostics, and step/substep counts — everything needed to proceed
 * to variable resolution or to report check results.
 */
export interface LoadAndParseSuccess {
  ok: true;
  /** Absolute path to the resolved runbook file */
  filePath: string;
  /** Raw markdown content */
  rawContent: string;
  /** Parsed runbook AST (before variable substitution) */
  runbook: Runbook;
  /** Validated frontmatter, or null if absent/invalid */
  frontmatter: RunbookFrontmatter | null;
  /** Structural and frontmatter validation diagnostics */
  diagnostics: readonly ValidationDiagnostic[];
  /** Step/substep counts */
  stats: { steps: number; substeps: number };
}

/**
 * Failure result from {@link loadAndParseRunbook}.
 *
 * Returned when the runbook file cannot be found or when parsing throws.
 */
export interface LoadAndParseFailure {
  ok: false;
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

/** Discriminated union result of {@link loadAndParseRunbook}. */
export type LoadAndParseResult = LoadAndParseSuccess | LoadAndParseFailure;

/**
 * Load a runbook file, parse it, and run structural validation.
 *
 * Performs:
 * 1. File discovery via `resolveRunbookFile`
 * 2. File read
 * 3. Parse (returns diagnostics as data, not exceptions)
 * 4. Frontmatter var validation (reserved variable names)
 * 5. Substep counting
 *
 * @param file - Runbook file path or namespace:name
 * @param cwd - Current working directory for resolution
 * @returns Discriminated union: ok with loaded data, or error with message
 */
export async function loadAndParseRunbook(file: string, cwd: string): Promise<LoadAndParseResult> {
  const filePath = await resolveRunbookFile(cwd, file);

  if (!filePath) {
    return {
      ok: false,
      error: `Runbook not found: ${file}. Try 'rd ls --all' to list available runbooks.`,
      code: 'RUNBOOK_NOT_FOUND',
      details: { runbook: file },
    };
  }

  try {
    const rawContent = await fs.readFile(filePath, 'utf8');
    const {
      runbook,
      frontmatter,
      diagnostics: parseDiagnostics,
    } = parseRunbookDocument(rawContent, path.basename(filePath));

    const varDiagnostics = validateFrontmatterVars(frontmatter?.vars);
    const diagnostics: readonly ValidationDiagnostic[] = [...parseDiagnostics, ...varDiagnostics];

    const stats = {
      steps: runbook.steps.length,
      substeps: countSubsteps(runbook.steps),
    };

    return { ok: true, filePath, rawContent, runbook, frontmatter, diagnostics, stats };
  } catch (error: unknown) {
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'PARSE_ERROR',
      details: { runbook: file },
    };
  }
}

/**
 * Prepare a runbook from file: resolve, load, parse, substitute variables.
 *
 * This is the shared pipeline used by file start, delegation claim, and resolve.
 * Returns diagnostics and unresolved variable names alongside the prepared runbook.
 * On failure, partial results (variables, stats, diagnostics) are included when
 * the pipeline progressed past the parse stage.
 *
 * @param file - Runbook file path or name
 * @param varOpts - Variable options from CLI flags
 * @param cwd - Current working directory
 * @param options - Optional settings including inherited variables from parent runbook
 * @param options.inheritedContextVars - Context variables inherited from a parent delegation
 * @param options.inheritedUserVars - User variables inherited from a parent delegation
 * @param options.inheritedSources - Data sources inherited from a parent delegation
 * @returns PrepareResult — success with full data, or failure with partial results
 * @throws {Error} On unexpected errors during variable resolution or parsing
 */
export async function prepareRunbook(
  file: string,
  varOpts: VarOptions,
  cwd: string,
  options?: {
    inheritedContextVars?: Readonly<Record<string, string>>;
    inheritedUserVars?: Readonly<Record<string, string>>;
    inheritedSources?: Readonly<Record<string, DataSource>>;
  },
): Promise<PrepareResult> {
  // Phase 1-2: Parse + Validate
  const parsed = await loadAndParseRunbook(file, cwd);
  if (!parsed.ok) return parsed;
  const { filePath, rawContent, runbook: rawRunbook, frontmatter, diagnostics, stats } = parsed;

  // Variable resolution
  let mergedVariables: Record<string, string>;
  let sources: Record<string, DataSource>;
  const allWarnings: string[] = [];
  try {
    const resolvedVariables = await resolveVariables(
      {
        varFile: varOpts.varFile,
        var: varOpts.var,
        varJson: varOpts.varJson,
        frontmatterVars: frontmatter?.vars,
        inheritedVars: options?.inheritedUserVars,
      },
      cwd,
      {
        evaluator: getPolicyEvaluator(),
        prompter: getPolicyPrompter(),
      },
    );
    mergedVariables = { ...resolvedVariables.vars };
    // Merge inherited sources (lower precedence) with locally resolved sources
    sources = { ...(options?.inheritedSources ?? {}), ...resolvedVariables.sources };
    allWarnings.push(...resolvedVariables.warnings);
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
        stats,
        diagnostics,
      };
    }
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'VARIABLE_RESOLUTION_ERROR',
      details: { runbook: file },
      variables: {},
      sources: {},
      stats,
      diagnostics,
    };
  }
  const templateVars = buildTemplateVars(mergedVariables, options);

  // Bail early if there are structural errors — don't pass a broken AST to transform passes
  const earlyErrors = diagnostics.filter((d) => d.severity === 'error');
  if (earlyErrors.length > 0) {
    return {
      ok: false,
      error: earlyErrors[0].message,
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
      variables: templateVars,
      sources,
      stats,
      diagnostics,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };
  }

  // Resolve FOR clause bounds ({{Max}} → 10)
  let resolvedRunbook: ResolvedRunbook;
  try {
    const result = resolveForBounds(rawRunbook, templateVars);
    resolvedRunbook = result.runbook;
    allWarnings.push(...result.warnings);
  } catch (err) {
    return {
      ok: false,
      error: getErrorMessage(err),
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
      variables: templateVars,
      sources,
      stats,
      diagnostics,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };
  }

  // Substitute variables into parsed AST
  const runbook = substituteRunbookVariables(resolvedRunbook, templateVars);
  const unresolvedNames = [...collectUnresolvedRunbookVariables(runbook)];

  // Validate sourced FOR clauses reference defined data sources
  try {
    validateSources(runbook.steps, sources);
  } catch (err) {
    return {
      ok: false,
      error: getErrorMessage(err),
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
      variables: templateVars,
      sources,
      stats,
      diagnostics,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };
  }

  if (runbook.steps.length === 0) {
    return {
      ok: false,
      error: 'Runbook has no steps',
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
      variables: templateVars,
      sources,
      stats,
      diagnostics,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };
  }

  return {
    ok: true,
    prepared: { filePath, rawContent, runbook, mergedVariables: templateVars, sources, stats },
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    diagnostics,
    unresolved: unresolvedNames,
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
 * @param options.runbookName - Name identifier for the runbook being launched
 * @param options.prompted - Whether to run in prompted mode (no auto-execution)
 * @param options.delegationLinkage - Optional parent delegation linkage for child runs
 * @param options.afterInit - Optional callback invoked after state initialization with the new state ID
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

  if (resolvedStepHasSubsteps(runbook.steps[0]) && runbook.steps[0].substeps.length > 0) {
    const freshState = await manager.load(state.id);
    const frame = freshState ? deriveActiveFrame(freshState) : undefined;
    const frameKey =
      freshState?.activeFrameKey ?? frame?.frameKey ?? buildFrameKey(runbook.steps[0].name);
    await manager.initializeSubsteps(state.id, runbook.steps[0].substeps, frameKey);
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
 * @param options.file - Runbook file path or name
 * @param options.prompted - Whether to run in prompted mode
 * @returns RunbookStartResult
 * @throws {Error} On state persistence or machine initialization failures
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
function inferEntryFromState(state: RunbookState, frameKey: FrameKey): number | undefined {
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
 * @throws {Error} if the parent run is not found
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
    if (Error.isError(err) && err.message.startsWith('Delegation lock timeout')) {
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

    // Reject claims against stopped parents — the run has been aborted
    if (freshParent.variables.stopped) {
      return {
        ok: false,
        error: 'Parent run has been stopped. Delegation cannot be claimed.',
        code: ErrorCodes.TOKEN_NOT_FOUND.code,
        details: { parentRunId: freshParent.id },
      };
    }

    // Re-locate delegation on fresh state (match by tokenHash for precision)
    const tokenHash = hashDelegationToken(rawToken);
    const freshSubstep = (freshParent.substepStates ?? []).find(
      (ss) => ss.id === (substepId ?? stepId) && ss.delegation?.tokenHash === tokenHash,
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

    // Extract parent user-level vars for top-level inheritance in child
    const inheritedUserVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(freshDelegation.contextSnapshot.vars)) {
      if (!key.startsWith('context.') && key !== 'RunId') {
        inheritedUserVars[key] = value;
      }
    }

    // Extract inherited sources from delegation snapshot
    const inheritedSources = freshDelegation.contextSnapshot.sources;

    // 4f. Prepare child runbook
    const prepResult = await prepareRunbook(freshDelegation.childRunbookPath, varOpts, cwd, {
      inheritedContextVars,
      inheritedUserVars,
      inheritedSources,
    });
    if (!prepResult.ok) {
      return {
        ok: false,
        error: prepResult.error,
        code: prepResult.code,
        details: { runbook: freshDelegation.childRunbookPath, ...prepResult.details },
      };
    }

    if (prepResult.warnings?.length) {
      for (const msg of prepResult.warnings) {
        output.warning(msg);
      }
    }
    for (const name of prepResult.unresolved) {
      output.warning(`Undefined variable "{{${name}}}" preserved as literal text`);
    }

    // Build delegation linkage for the child run.
    // Use the delegation's stored frame key — not the parent's current frame.
    // The parent may have advanced past the iteration where the delegation was created.
    const delegationFrameKey = freshSubstep.frameKey;
    const delegationLinkage: DelegationLinkage = {
      parentRunId: freshParent.id,
      parentStepId: substepId ?? stepId,
      tokenHash,
      parentStep: freshParent.step,
      parentFrameKey: delegationFrameKey,
      parentEntry: inferEntryFromState(freshParent, delegationFrameKey),
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
    output.status('claimed', `Claimed ${truncatedToken} -> ${freshDelegation.childRunbookPath}`, {
      action: 'claimed',
      token: truncatedToken,
      run_id: childRunId,
      runbook: freshDelegation.childRunbookPath,
      parent_run_id: freshParent.id,
      parent_step: freshDelegation.contextSnapshot.at,
    });

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
