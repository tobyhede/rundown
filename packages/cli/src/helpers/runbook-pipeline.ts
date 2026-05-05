/**
 * Business logic for the run command.
 *
 * Extracts the runbook preparation pipeline, runbook starting,
 * and delegation claim/launch logic from commands/run.ts.
 *
 * @module helpers/runbook-pipeline
 */

import * as fsSync from 'node:fs';
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
  type RunbookRef,
  RunbookRefSchema,
  type DelegationLinkage,
  type ParentLinkage,
  type ClaimId,
  RUNS_DIR,
  runbooksDir,
  DelegationScanService,
  DelegationLock,
  DelegationLockTimeoutError,
  reconstituteContextVars,
  extractInheritedUserVars,
  hashDelegationToken,
  truncateDelegationToken,
  DELEGATION_TOKEN_PREFIX,
  ErrorCodes,
  getErrorMessage,
  type TemplateVarValue,
  isJsonArray,
  isJsonArrayStream,
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
import type { ResolvedRunbook as ResolvedRunbookFile } from './resolve-runbook.js';
import { runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { getBundledRunbooksPath } from './bundled-runbooks.js';
import { FileSourcePolicyError, resolveVariables } from '../services/variable-discovery.js';
import {
  substituteRunbookVariables,
  resolveForBounds,
  collectUnresolvedRunbookVariables,
} from '../services/template-renderer.js';
import { getPolicyEvaluator, getPolicyPrompter } from '../services/policy-context.js';
import { validateOutputsDeclarations } from './validate-frontmatter-vars.js';
import { getHelperRegistry, detectHelperCollisions } from '../services/helper-registry.js';

/**
 * Input options from CLI flags.
 */
export interface InputOptions {
  /** Paths to YAML files containing variable definitions (repeatable) */
  inputFile?: string[];
  /** Inline key=value variable overrides (repeatable) */
  input?: string[];
  /** Inline key=json variable overrides with JSON values (repeatable) */
  inputJson?: string[];
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
  /** Canonical runbook reference for events and artifact metadata */
  runbookRef: RunbookRef;
  /** Raw markdown content of the runbook file */
  rawContent: string;
  /** Parsed and variable-substituted runbook AST (all FOR bounds resolved) */
  runbook: ResolvedRunbook;
  /** Merged template variables from all sources */
  mergedVariables: Record<string, TemplateVarValue>;
  /** Step and substep counts */
  stats: { steps: number; substeps: number };
  /** Validated frontmatter, or null if absent/invalid */
  frontmatter: RunbookFrontmatter | null;
}

/** Failure produced while initializing a runbook launch. */
export interface RunbookStartFailure {
  ok: false;
  reason: 'launch-failed';
  error: string;
  code: typeof ErrorCodes.LAUNCH_FAILED.code;
  details: { runbookName: string };
}

/** Result of starting a runbook execution loop via {@link startRunbook}. */
export type RunbookStartResult =
  | { ok: true; loopResult: 'done' | 'stopped' | 'waiting'; stateId: string }
  | RunbookStartFailure;

type LaunchSessionActivation = { readonly kind: 'default-stack' } | { readonly kind: 'none' };

/** Failure variants from claiming and launching a delegated child runbook. */
export type ClaimFailure =
  | { readonly reason: 'invalid-token'; readonly token: string }
  | { readonly reason: 'token-not-found'; readonly token: string }
  | { readonly reason: 'parent-missing'; readonly parentRunId: string }
  | {
      readonly reason: 'parent-ended';
      readonly parentRunId: string;
      readonly lifecycle: 'stopped' | 'completed';
    }
  | { readonly reason: 'delegation-removed'; readonly parentRunId: string; readonly stepId: string }
  | {
      readonly reason: 'delegation-cancelled';
      readonly parentRunId: string;
      readonly stepId: string;
      readonly cancelledAt: string;
    }
  | {
      readonly reason: 'delegation-resolved';
      readonly parentRunId: string;
      readonly stepId: string;
      readonly childRunId: string;
    }
  | {
      /**
       * The parent's substep references a `childRunId` that no longer exists
       * on disk. Transient — pruning + restarting the parent typically
       * resolves it. Rendered as `CHILD_RUN_MISSING`.
       */
      readonly reason: 'child-missing';
      readonly parentRunId: string;
      readonly stepId: string;
      readonly childRunId: string;
    }
  | {
      /**
       * The child's persisted `parentLinkage` disagrees with the freshly
       * token-validated linkage. Indicates state corruption (manual edits,
       * stale linkage from a prior delegation, cross-host state merge);
       * operator intervention required — inspect
       * `.rundown/runs/<childRunId>.json`. Rendered as
       * `CHILD_LINKAGE_MISMATCH`.
       */
      readonly reason: 'linkage-mismatch';
      readonly parentRunId: string;
      readonly stepId: string;
      readonly childRunId: string;
    }
  | { readonly reason: 'lock-timeout'; readonly parentRunId: string }
  | {
      readonly reason: 'prepare-failed';
      readonly runbook: string;
      readonly code: PrepareFailure['code'];
      readonly cause: string;
      readonly details: PrepareFailure['details'];
    }
  | {
      readonly reason: 'launch-failed';
      readonly runbook: string;
      readonly code: RunbookStartFailure['code'] | typeof ErrorCodes.CLAIM_INVARIANT_VIOLATED.code;
      readonly cause: string;
      readonly details: RunbookStartFailure['details'] & { readonly runbook: string };
    };

/** Result of claiming a delegation token and launching the child runbook. */
export type ClaimResult =
  | {
      /** Discriminator indicating success. */
      ok: true;
      /** Unique identifier of the launched (or idempotently returned) child run. */
      childRunId: string;
      /** Claim id for explicit child targeting. */
      claimId: ClaimId;
      /** Unique identifier of the parent run that owns the delegation. */
      parentRunId: string;
      /** Step (or substep) ID on the parent that holds the delegation. */
      stepId: string;
      /** Terminal state of the child execution loop. */
      loopResult: 'done' | 'stopped' | 'waiting';
    }
  | ({ readonly ok: false } & ClaimFailure);

/**
 * Validate that all sourced FOR clauses reference defined iterable variables.
 *
 * @param steps - Resolved runbook steps (all FOR bounds already resolved)
 * @param vars - Template variables (must include JsonArray or JsonArrayStream for sources)
 * @throws {Error} if any step references an undefined or non-iterable variable
 */
export function validateForVariables(
  steps: readonly ResolvedStep[],
  vars: Readonly<Partial<Record<string, TemplateVarValue>>>,
): void {
  for (const step of steps) {
    if (step.kind === 'for' && isSourced(step.forClause)) {
      const name = step.forClause.source;
      const value = vars[name];
      if (value === undefined) {
        throw new Error(
          `FOR loop references undefined variable "{{${name}}}". ` +
            `Define "${name}" as an array in .rundown/config.yaml or pass --input-file with an array value.`,
        );
      }
      if (!isJsonArray(value) && !isJsonArrayStream(value)) {
        throw new Error(
          `FOR loop variable "{{${name}}}" is not iterable (got ${typeof value}). ` +
            `Define "${name}" as an array in .rundown/config.yaml or pass --input-file with an array value.`,
        );
      }
    }
  }
}

/**
 * Build a canonical runbook reference from a resolved file and source root.
 *
 * @param resolved - Resolved runbook file and discovery source
 * @param cwd - Project working directory used for project-relative paths
 * @returns Validated canonical runbook reference
 * @throws {Error} If the resolved file cannot be represented canonically
 */
export function buildRunbookRef(resolved: ResolvedRunbookFile, cwd: string): RunbookRef {
  const rootRelativePath = sourceRelativeRunbookPath(resolved, cwd);
  return RunbookRefSchema.parse({
    source: resolved.source,
    path: toCanonicalRunbookRefPath(toPosixPath(rootRelativePath)),
  });
}

function sourceRelativeRunbookPath(resolved: ResolvedRunbookFile, cwd: string): string {
  switch (resolved.source) {
    case 'project': {
      const projectRunbooksRelative = pathRelativeWithin(runbooksDir(cwd), resolved.path);
      return projectRunbooksRelative ?? pathRelativeRequired(cwd, resolved.path);
    }
    case 'plugin': {
      const pluginRunbooksRoot = findRunbooksAncestor(resolved.path);
      if (!pluginRunbooksRoot) {
        throw new Error(`Plugin runbook is not beneath a runbooks directory: ${resolved.path}`);
      }
      return pathRelativeRequired(pluginRunbooksRoot, resolved.path);
    }
    case 'bundled':
      return pathRelativeRequired(getBundledRunbooksPath(), resolved.path);
    default: {
      const _exhaustive: never = resolved.source;
      throw new Error(`Unhandled runbook source: ${String(_exhaustive)}`);
    }
  }
}

function pathRelativeRequired(root: string, target: string): string {
  const relativePath = pathRelativeWithin(root, target);
  if (relativePath === null) {
    throw new Error(`Resolved runbook path escapes source root: ${target}`);
  }
  return relativePath;
}

function pathRelativeWithin(root: string, target: string): string | null {
  const relativePath = path.relative(resolveComparablePath(root), resolveComparablePath(target));
  if (relativePath === '' || escapesRoot(relativePath)) {
    return null;
  }
  return relativePath;
}

function resolveComparablePath(value: string): string {
  try {
    return fsSync.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function escapesRoot(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function findRunbooksAncestor(filePath: string): string | null {
  let current = path.dirname(path.resolve(filePath));
  while (true) {
    if (path.basename(current) === 'runbooks') {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function toCanonicalRunbookRefPath(value: string): string {
  if (value.endsWith('.runbook.md')) {
    return value;
  }
  if (value.endsWith('.md')) {
    return `${value.slice(0, -'.md'.length)}.runbook.md`;
  }
  return value;
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
    statePath: `${RUNS_DIR}/${runbookState.id}.json`,
  });
}

/**
 * Build canonical current-context variable aliases for static template substitution.
 *
 * @param vars - User/config template variables to namespace under `context.vars.*`
 * @returns Record mapping `context.vars.{key}` to corresponding values
 */
export function buildContextVars(
  vars: Readonly<Record<string, TemplateVarValue>>,
): Record<string, TemplateVarValue> {
  const contextVars: Record<string, TemplateVarValue> = {};
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
  localVars: Readonly<Record<string, TemplateVarValue>>,
  options?: {
    inheritedUserVars?: Readonly<Record<string, TemplateVarValue>>;
    inheritedContextVars?: Readonly<Record<string, TemplateVarValue>>;
  },
): Record<string, TemplateVarValue> {
  const effectiveUserVars: Record<string, TemplateVarValue> = {
    ...(options?.inheritedUserVars ?? {}), // parent --input (overridable)
    ...localVars, // child frontmatter + claim --input (overrides)
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

interface PrepareFailureBase {
  readonly ok: false;
  readonly error: string;
  /** Partial results — available when pipeline progressed past parse */
  readonly variables?: Record<string, TemplateVarValue>;
  readonly stats?: { steps: number; substeps: number };
  readonly diagnostics?: readonly ValidationDiagnostic[];
  readonly warnings?: readonly string[];
}

/** Failure result from {@link prepareRunbook}. */
export type PrepareFailure =
  | (PrepareFailureBase & {
      readonly code: 'RUNBOOK_NOT_FOUND' | 'PARSE_ERROR' | 'VARIABLE_RESOLUTION_ERROR';
      readonly details: { readonly runbook: string };
    })
  | (PrepareFailureBase & {
      readonly code: 'POLICY_DENIED';
      readonly details: {
        readonly runbook: string;
        readonly variable: string;
        readonly filePath: string;
        readonly reason: string;
      };
    })
  | (PrepareFailureBase & {
      readonly code: 'VALIDATION_ERROR';
      readonly details: { readonly runbook: string };
    })
  | (PrepareFailureBase & {
      readonly code: 'MISSING_REQUIRED_VARS';
      readonly details: { readonly runbook: string; readonly missing: readonly string[] };
    });

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
  /** Source where the runbook was discovered from */
  source: 'project' | 'plugin' | 'bundled';
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
  /** Canonical runbook reference for events and artifact metadata */
  runbookRef: RunbookRef;
}

/**
 * Failure result from {@link loadAndParseRunbook}.
 *
 * Returned when the runbook file cannot be found or when parsing throws.
 */
export interface LoadAndParseFailure {
  ok: false;
  error: string;
  code: 'RUNBOOK_NOT_FOUND' | 'PARSE_ERROR';
  details: { runbook: string };
}

/** Discriminated union result of {@link loadAndParseRunbook}. */
export type LoadAndParseResult = LoadAndParseSuccess | LoadAndParseFailure;

/**
 * Load a runbook file, parse it, and run structural validation.
 *
 * Performs:
 * 1. File discovery via `resolveRunbookFile`
 * 2. File read
 * 3. Parse (returns `parseDiagnostics` as data, not exceptions)
 * 4. Validate frontmatter `outputs` declarations with `validateOutputsDeclarations`
 * 5. Merge `parseDiagnostics` and `outputsDiagnostics` into `diagnostics`
 * 6. Substep counting
 *
 * Frontmatter variable validation is no longer performed here; the resulting
 * `diagnostics` array combines parser diagnostics with outputs validation only.
 *
 * @param file - Runbook file path or namespace:name
 * @param cwd - Current working directory for resolution
 * @returns Discriminated union: ok with loaded data, or error with message
 */
export async function loadAndParseRunbook(file: string, cwd: string): Promise<LoadAndParseResult> {
  const resolved = await resolveRunbookFile(cwd, file);

  if (!resolved) {
    return {
      ok: false,
      error: `Runbook not found: ${file}. Try 'rd ls --all' to list available runbooks.`,
      code: 'RUNBOOK_NOT_FOUND',
      details: { runbook: file },
    };
  }

  const { path: filePath, source } = resolved;
  const runbookRef = buildRunbookRef(resolved, cwd);

  try {
    const rawContent = await fs.readFile(filePath, 'utf8');
    const {
      runbook,
      frontmatter,
      diagnostics: parseDiagnostics,
    } = parseRunbookDocument(rawContent, path.basename(filePath));

    const outputsDiagnostics = validateOutputsDeclarations(frontmatter?.outputs);
    const diagnostics: readonly ValidationDiagnostic[] = [
      ...parseDiagnostics,
      ...outputsDiagnostics,
    ];

    const stats = {
      steps: runbook.steps.length,
      substeps: countSubsteps(runbook.steps),
    };

    return {
      ok: true,
      filePath,
      source,
      rawContent,
      runbook,
      frontmatter,
      diagnostics,
      stats,
      runbookRef,
    };
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
 * @param inputOpts - Input options from CLI flags
 * @param cwd - Current working directory
 * @param options - Optional settings including inherited variables from parent runbook
 * @param options.inheritedContextVars - Context variables inherited from a parent delegation
 * @param options.inheritedUserVars - User variables inherited from a parent delegation
 * @returns PrepareResult — success with full data, or failure with partial results
 * @throws {Error} On unexpected errors during variable resolution or parsing
 */
export async function prepareRunbook(
  file: string,
  inputOpts: InputOptions,
  cwd: string,
  options?: {
    inheritedContextVars?: Readonly<Record<string, TemplateVarValue>>;
    inheritedUserVars?: Readonly<Record<string, TemplateVarValue>>;
  },
): Promise<PrepareResult> {
  // Phase 1-2: Parse + Validate
  const parsed = await loadAndParseRunbook(file, cwd);
  if (!parsed.ok) return parsed;
  const {
    filePath,
    runbookRef,
    source,
    rawContent,
    runbook: rawRunbook,
    frontmatter,
    diagnostics,
    stats,
  } = parsed;

  // Derive CLAUDE_PLUGIN_ROOT from resolved path when source is plugin
  let pluginRoot: string | undefined;
  if (source === 'plugin') {
    const runbooksSep = `${path.sep}runbooks${path.sep}`;
    const runbooksIdx = filePath.indexOf(runbooksSep);
    if (runbooksIdx !== -1) {
      pluginRoot = filePath.slice(0, runbooksIdx + 1); // include trailing separator
    }
  }

  // Inherited user vars pass through untouched here. Context OUTPUTS are
  // inherited after variable resolution (stage 3.5 below), once the child's
  // final ContextId is known. Merging context outputs before resolution would
  // mark their keys as "provided" against the child's own ContextId override
  // (e.g. `claim --input ContextId=...`) and prevent the correct outputs from
  // being loaded from the new context.
  const inheritedUserVars = options?.inheritedUserVars ?? {};

  // Variable resolution
  let mergedVariables: Record<string, TemplateVarValue>;
  let providedKeys: ReadonlySet<string>;
  const allWarnings: string[] = [];
  try {
    const resolvedVariables = await resolveVariables(
      {
        inputFile: inputOpts.inputFile,
        input: inputOpts.input,
        inputJson: inputOpts.inputJson,
        inheritedVars: inheritedUserVars,
      },
      cwd,
      {
        evaluator: getPolicyEvaluator(),
        prompter: getPolicyPrompter(),
      },
    );
    mergedVariables = { ...resolvedVariables.vars };
    providedKeys = resolvedVariables.providedKeys;
    // Inject CLAUDE_PLUGIN_ROOT for plugin-sourced runbooks (below CLI flags in precedence)
    if (pluginRoot && !('CLAUDE_PLUGIN_ROOT' in mergedVariables)) {
      mergedVariables.CLAUDE_PLUGIN_ROOT = pluginRoot;
    }
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
      stats,
      diagnostics,
    };
  }
  const templateVars = buildTemplateVars(mergedVariables, options);

  // Bail early if there are structural errors — don't pass a broken AST to transform passes
  // This must run before the missing-required check so that malformed `required` entries
  // (invalid identifiers, reserved names, duplicates) surface as VALIDATION_ERROR
  // rather than being misreported as MISSING_REQUIRED_VARS.
  const earlyErrors = diagnostics.filter((d) => d.severity === 'error');
  if (earlyErrors.length > 0) {
    return {
      ok: false,
      error: earlyErrors[0].message,
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
      variables: templateVars,
      stats,
      diagnostics,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };
  }

  // Helper-collision detection runs only after structural validation passes.
  // Surfacing "Variable shadowed by helper" warnings on a runbook with parse/frontmatter
  // errors would be noise the user can't act on yet.
  const helperCollisions = detectHelperCollisions(getHelperRegistry(), templateVars);
  for (const name of helperCollisions) {
    allWarnings.push(
      `Variable "${name}" is shadowed by a registered helper. Use {{ ./${name} }} to access the variable.`,
    );
  }

  // Inherit OUTPUTS from the child's resolved ContextId.
  //
  // Loads outputs published under the **resolved** ContextId (so child
  // overrides via `claim --input ContextId=...` are respected) and injects keys
  // that were not already provided by a VARS channel.
  // Validate required variables are provided by an external layer
  const requiredVars = frontmatter?.required;
  if (requiredVars && requiredVars.length > 0) {
    const missing = requiredVars.filter((name: string) => !providedKeys.has(name));
    if (missing.length > 0) {
      const names = missing.map((n: string) => `"${n}"`).join(', ');
      return {
        ok: false,
        error: `Missing required variable${missing.length > 1 ? 's' : ''}: ${names}. Provide via --input, --input-file, config.yaml, RD_INPUT_* environment variable, or prior runbook OUTPUTS.`,
        code: 'MISSING_REQUIRED_VARS',
        details: { runbook: file, missing },
        variables: templateVars,
        stats,
        diagnostics,
        warnings: allWarnings.length > 0 ? allWarnings : undefined,
      };
    }
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
      stats,
      diagnostics,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };
  }

  // Substitute variables into parsed AST
  const runbook = substituteRunbookVariables(resolvedRunbook, templateVars);
  const unresolvedNames = [...collectUnresolvedRunbookVariables(runbook)];

  // Validate sourced FOR clauses reference defined iterable variables
  try {
    validateForVariables(runbook.steps, templateVars);
  } catch (err) {
    return {
      ok: false,
      error: getErrorMessage(err),
      code: 'VALIDATION_ERROR',
      details: { runbook: file },
      variables: templateVars,
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
      stats,
      diagnostics,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };
  }

  return {
    ok: true,
    prepared: {
      filePath,
      runbookRef,
      rawContent,
      runbook,
      mergedVariables: templateVars,
      stats,
      frontmatter,
    },
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
 * @param options.parentLinkage - Optional parent linkage for child runs (delegation or inline)
 * @param options.sessionActivation - Session activation mode for the launched runbook
 * @param options.afterInit - Optional callback invoked after state initialization with the new state ID
 * @returns RunbookStartResult
 */
async function launchRunbook(
  ctx: RunPipelineContext,
  prepared: PreparedRunbook,
  options: {
    runbookName: string;
    prompted: boolean;
    parentLinkage?: ParentLinkage;
    sessionActivation?: LaunchSessionActivation;
    afterInit?: (stateId: string) => Promise<void>;
  },
): Promise<RunbookStartResult> {
  const { output, manager, actorService, sessionService, lifecycleService, cwd } = ctx;
  const { filePath, rawContent, runbook, mergedVariables } = prepared;

  const runbookPath = path.relative(cwd, filePath);

  // Init phase: state creation through start-event emission. Failures here
  // produce a structured launch failure so callers (notably claimAndLaunch)
  // can release locks and report cleanly. The loop itself is outside the
  // try/catch — loop failures still propagate as exceptions.
  let stateId: string;
  let runbookSteps: ResolvedStep[];
  let emitter: ExecutionEventEmitter;
  try {
    const state = await manager.create(options.runbookName, runbook, {
      runbookPath,
      prompted: options.prompted,
      parentLinkage: options.parentLinkage,
      runbookSrc: rawContent,
      templateVars: mergedVariables,
      frontmatterOutputs: prepared.frontmatter?.outputs ?? [],
    });
    stateId = state.id;

    // Initialize actor state (populates forStack for first step)
    await actorService.initializeState(state.id, [...runbook.steps]);
    await lifecycleService.ensureActiveEntry(state.id);

    // Optional post-init hook (e.g., linking delegation childRunId)
    if (options.afterInit) {
      await options.afterInit(state.id);
    }

    const sessionActivation = options.sessionActivation ?? { kind: 'default-stack' as const };
    switch (sessionActivation.kind) {
      case 'default-stack':
        await sessionService.pushRunbook(state.id);
        break;
      case 'none':
        break;
      default: {
        const _exhaustive: never = sessionActivation;
        throw new Error(
          `Unhandled session activation kind: ${(_exhaustive as LaunchSessionActivation).kind}`,
        );
      }
    }

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
    emitter = createBridgedEmitter(state, output, prepared.runbookRef);

    // Emit RUNBOOK_STARTED
    emitRunbookStarted(emitter, state, options.prompted);

    runbookSteps = [...runbook.steps];
  } catch (err) {
    return {
      ok: false,
      reason: 'launch-failed',
      error: getErrorMessage(err),
      code: ErrorCodes.LAUNCH_FAILED.code,
      details: { runbookName: options.runbookName },
    };
  }

  const loopResult = await runExecutionLoop(
    manager,
    stateId,
    runbookSteps,
    cwd,
    options.prompted,
    emitter,
    {
      terminalReleaseMode:
        options.sessionActivation?.kind === 'none' ? 'release-runbook' : 'stack-pop',
    },
  );

  return { ok: true, loopResult, stateId };
}

/**
 * Mode 2: Start a runbook from a prepared file.
 *
 * @param ctx - Pipeline context
 * @param prepared - Prepared runbook data
 * @param options - Start options
 * @param options.file - Runbook file path or name
 * @param options.prompted - Whether to run in prompted mode
 * @param options.parentLinkage - Optional parent linkage for child runs (delegation or inline)
 * @param options.afterInit - Optional callback invoked after state initialization with the new state ID
 * @returns RunbookStartResult
 * @throws {Error} On state persistence or machine initialization failures
 */
export async function startRunbook(
  ctx: RunPipelineContext,
  prepared: PreparedRunbook,
  options: {
    file: string;
    prompted?: boolean;
    parentLinkage?: ParentLinkage;
    afterInit?: (stateId: string) => Promise<void>;
  },
): Promise<RunbookStartResult> {
  return launchRunbook(ctx, prepared, {
    runbookName: options.file,
    prompted: !!options.prompted,
    parentLinkage: options.parentLinkage,
    afterInit: options.afterInit,
  });
}

/**
 * Infer entry number from persisted frame state when not explicitly set.
 *
 * @param state - Current runbook state containing frame entry history
 * @param frameKey - Frame key to look up (`step|iteration` format)
 * @returns The inferred entry number, or undefined if no history exists
 */
export function inferEntryFromState(state: RunbookState, frameKey: FrameKey): number | undefined {
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
      const { token: _claimedToken, ...claimedDelegation } = ss.delegation;
      return {
        ...ss,
        delegation: { ...claimedDelegation, childRunId },
      };
    }
    return ss;
  });

  await manager.update(runId, { substepStates: updated });
}

/** Outcome of {@link claimChildForPipeline}. */
type ClaimChildResult =
  | { readonly ok: true; readonly claimId: ClaimId; readonly childRunId: string }
  | {
      readonly ok: false;
      readonly reason: 'child-missing' | 'linkage-mismatch';
      readonly childRunId: string;
    };

async function claimChildForPipeline(
  ctx: RunPipelineContext,
  childRunId: string,
  linkage: DelegationLinkage,
): Promise<ClaimChildResult> {
  const claim = await ctx.sessionService.claimRunbook(childRunId, linkage);
  switch (claim.status) {
    case 'claimed':
      return {
        ok: true,
        claimId: claim.claim.claimId,
        childRunId: (claim.claim as { readonly childRunId?: string }).childRunId ?? childRunId,
      };
    case 'missing-child':
      return { ok: false, reason: 'child-missing', childRunId: claim.childRunId };
    case 'linkage-mismatch':
      return { ok: false, reason: 'linkage-mismatch', childRunId: claim.childRunId };
    default: {
      const _exhaustive: never = claim;
      throw new Error(
        `Unhandled claimRunbook status: ${(_exhaustive as { status: string }).status}`,
      );
    }
  }
}

/**
 * Convert a {@link claimChildForPipeline} failure into a {@link ClaimResult}
 * envelope carrying the surrounding parent context.
 *
 * @param result - The failure variant returned by {@link claimChildForPipeline}
 * @param parentRunId - Parent run id at the call site
 * @param stepId - Parent step (or substep) id where the claim was attempted
 * @returns A failure {@link ClaimResult} ready to bubble up from claimAndLaunch
 */
function claimResultToFailure(
  result: Extract<ClaimChildResult, { ok: false }>,
  parentRunId: string,
  stepId: string,
): ClaimResult {
  return {
    ok: false,
    reason: result.reason,
    parentRunId,
    stepId,
    childRunId: result.childRunId,
  };
}

/**
 * Structured payload emitted alongside a successful `rd claim`.
 *
 * Stable JSON shape returned by the `rd claim` CLI on success. Field names
 * use snake_case to match other CLI outputs (`run_id`, `parent_run_id`).
 */
export interface ClaimedOutputPayload {
  /** Discriminator: always `'claimed'` on success. */
  readonly action: 'claimed';
  /** Redacted display form of the delegation token (safe to log). */
  readonly token: string;
  /** Branded claim id for subsequent `--claim-id` commands. */
  readonly claim_id: ClaimId;
  /** Run id of the launched (or idempotently returned) child runbook. */
  readonly run_id: string;
  /** Source path of the child runbook. */
  readonly runbook: string;
  /** Run id of the parent runbook that issued the delegation. */
  readonly parent_run_id: string;
  /** Parent step at-position (e.g. for FOR-loop iterations); `undefined` for bare-step delegations without an at-qualifier. */
  readonly parent_step: string | undefined;
}

function emitClaimedOutput(
  output: OutputEmitter,
  message: string,
  data: ClaimedOutputPayload,
): void {
  output.status('claimed', message, data);
}

/**
 * Build the structured payload emitted alongside a successful claim.
 *
 * Centralizes the shape used by the three claim sites in {@link claimAndLaunch}
 * (idempotent return, orphan adoption, fresh launch) so the field set stays in
 * lock-step across call sites.
 *
 * @param args - Claim payload inputs
 * @param args.truncatedToken - Redacted display form of the delegation token (safe for output)
 * @param args.claimId - Branded claim id identifying this claim record
 * @param args.childRunId - Run id of the launched child runbook state
 * @param args.childRunbookPath - Source path of the child runbook
 * @param args.parentRunId - Run id of the parent runbook state that issued the delegation
 * @param args.parentStepAt - Parent step at-position (e.g. for FOR-loop iterations); undefined when not applicable
 * @returns Structured payload suitable for {@link emitClaimedOutput}
 */
function buildClaimedPayload(args: {
  readonly truncatedToken: string;
  readonly claimId: ClaimId;
  readonly childRunId: string;
  readonly childRunbookPath: string;
  readonly parentRunId: string;
  readonly parentStepAt: string | undefined;
}): ClaimedOutputPayload {
  return {
    action: 'claimed',
    token: args.truncatedToken,
    claim_id: args.claimId,
    run_id: args.childRunId,
    runbook: args.childRunbookPath,
    parent_run_id: args.parentRunId,
    parent_step: args.parentStepAt,
  };
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
 * @param inputOpts - Input options from CLI flags
 * @returns ClaimResult with child run details or error
 */
export async function claimAndLaunch(
  ctx: RunPipelineContext,
  rawToken: string,
  inputOpts: InputOptions,
): Promise<ClaimResult> {
  const { output, manager, cwd } = ctx;
  const truncatedToken = truncateDelegationToken(rawToken);

  // 1. Validate token format
  if (!rawToken.startsWith(DELEGATION_TOKEN_PREFIX)) {
    return {
      ok: false,
      reason: 'invalid-token',
      token: truncatedToken,
    };
  }

  // 2. Scan for matching token
  const scanner = new DelegationScanService(manager);
  const scanResult = await scanner.findByToken(rawToken);

  if (!scanResult) {
    return {
      ok: false,
      reason: 'token-not-found',
      token: truncatedToken,
    };
  }

  const { parentState, stepId, substepId, delegation: _delegation } = scanResult;
  const lock = new DelegationLock(cwd);

  // 3. Acquire delegation lock
  try {
    await lock.acquire(parentState.id);
  } catch (err) {
    // acquire() throws DelegationLockTimeoutError on deadline expiry.
    // Re-throw anything else (EACCES, EIO, etc.) as an unexpected error.
    if (err instanceof DelegationLockTimeoutError) {
      return {
        ok: false,
        reason: 'lock-timeout',
        parentRunId: parentState.id,
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
        reason: 'parent-missing',
        parentRunId: parentState.id,
      };
    }

    // Reject claims against stopped or completed parents — the run has ended
    if (freshParent.lifecycle === 'stopped' || freshParent.lifecycle === 'completed') {
      const reason = freshParent.lifecycle === 'completed' ? 'completed' : 'stopped';
      return {
        ok: false,
        reason: 'parent-ended',
        parentRunId: freshParent.id,
        lifecycle: reason,
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
        reason: 'delegation-removed',
        parentRunId: parentState.id,
        stepId,
      };
    }

    // 4b. Idempotent return if already claimed
    if (freshDelegation.childRunId) {
      const existingChild = await manager.load(freshDelegation.childRunId);
      if (!existingChild) {
        // Parent points at a child run that no longer exists on disk. Fail
        // closed rather than minting a claim against a missing run.
        return {
          ok: false,
          reason: 'child-missing',
          parentRunId: freshParent.id,
          stepId,
          childRunId: freshDelegation.childRunId,
        };
      }
      if (existingChild.lifecycle === 'completed' || existingChild.lifecycle === 'stopped') {
        return {
          ok: false,
          reason: 'delegation-resolved',
          parentRunId: freshParent.id,
          stepId,
          childRunId: freshDelegation.childRunId,
        };
      }
      const delegationFrameKey = freshSubstep.frameKey;
      const freshLinkage: DelegationLinkage = {
        kind: 'delegation',
        parentRunId: freshParent.id,
        parentStepId: substepId ?? stepId,
        tokenHash,
        parentStep: freshParent.step,
        parentFrameKey: delegationFrameKey,
        parentEntry: inferEntryFromState(freshParent, delegationFrameKey),
      };
      const claimResult = await claimChildForPipeline(
        ctx,
        freshDelegation.childRunId,
        freshLinkage,
      );
      if (!claimResult.ok) {
        return claimResultToFailure(claimResult, freshParent.id, stepId);
      }
      const claimId = claimResult.claimId;
      emitClaimedOutput(
        output,
        `Claimed ${truncatedToken} -> ${freshDelegation.childRunbookPath}`,
        buildClaimedPayload({
          truncatedToken,
          claimId,
          childRunId: freshDelegation.childRunId,
          childRunbookPath: freshDelegation.childRunbookPath,
          parentRunId: freshParent.id,
          parentStepAt: freshDelegation.contextSnapshot.at,
        }),
      );

      return {
        ok: true,
        childRunId: freshDelegation.childRunId,
        claimId,
        parentRunId: freshParent.id,
        stepId,
        loopResult: 'waiting',
      };
    }

    // 4c. Check for cancellation
    if (freshDelegation.cancelledAt) {
      return {
        ok: false,
        reason: 'delegation-cancelled',
        parentRunId: freshParent.id,
        stepId,
        cancelledAt: freshDelegation.cancelledAt,
      };
    }

    // 4d. Orphan reconciliation: scan for child run with matching tokenHash
    const orphan = await scanner.findOrphanedChild(tokenHash);
    if (orphan) {
      const orphanLinkage: DelegationLinkage = {
        kind: 'delegation',
        parentRunId: freshParent.id,
        parentStepId: substepId ?? stepId,
        tokenHash,
        parentStep: freshParent.step,
        parentFrameKey: freshSubstep.frameKey,
        parentEntry: inferEntryFromState(freshParent, freshSubstep.frameKey),
      };
      const claimResult = await claimChildForPipeline(ctx, orphan.id, orphanLinkage);
      if (!claimResult.ok) {
        return claimResultToFailure(claimResult, freshParent.id, stepId);
      }
      const adoptedChildRunId = claimResult.childRunId;
      // Adopt the orphan only after claim validation confirms its persisted
      // child linkage belongs to this delegation.
      await updateStepDelegationChildRunId(
        manager,
        freshParent.id,
        substepId ?? stepId,
        adoptedChildRunId,
        tokenHash,
      );
      const claimId = claimResult.claimId;
      emitClaimedOutput(
        output,
        `Claimed ${truncatedToken} -> ${freshDelegation.childRunbookPath}`,
        buildClaimedPayload({
          truncatedToken,
          claimId,
          childRunId: adoptedChildRunId,
          childRunbookPath: freshDelegation.childRunbookPath,
          parentRunId: freshParent.id,
          parentStepAt: freshDelegation.contextSnapshot.at,
        }),
      );
      return {
        ok: true,
        childRunId: adoptedChildRunId,
        claimId,
        parentRunId: freshParent.id,
        stepId,
        loopResult: 'waiting',
      };
    }

    // Build delegation linkage for the child.
    // Use the delegation's stored frame key — not the parent's current frame.
    // The parent may have advanced past the iteration where the delegation was created.
    const delegationFrameKey = freshSubstep.frameKey;
    const delegationLinkage: DelegationLinkage = {
      kind: 'delegation' as const,
      parentRunId: freshParent.id,
      parentStepId: substepId ?? stepId,
      tokenHash,
      parentStep: freshParent.step,
      parentFrameKey: delegationFrameKey,
      parentEntry: inferEntryFromState(freshParent, delegationFrameKey),
    };

    const sessionServiceWithOptionalLookup = ctx.sessionService as Partial<
      Pick<SessionService, 'findClaimForDelegation'>
    >;
    const existingClaim = sessionServiceWithOptionalLookup.findClaimForDelegation
      ? await sessionServiceWithOptionalLookup.findClaimForDelegation(delegationLinkage)
      : null;
    if (existingClaim !== null) {
      const existingChild = await manager.load(existingClaim.childRunId);
      if (!existingChild) {
        return {
          ok: false,
          reason: 'child-missing',
          parentRunId: freshParent.id,
          stepId,
          childRunId: existingClaim.childRunId,
        };
      }
      if (existingChild.lifecycle === 'completed' || existingChild.lifecycle === 'stopped') {
        return {
          ok: false,
          reason: 'delegation-resolved',
          parentRunId: freshParent.id,
          stepId,
          childRunId: existingClaim.childRunId,
        };
      }
      await updateStepDelegationChildRunId(
        manager,
        freshParent.id,
        substepId ?? stepId,
        existingClaim.childRunId,
        tokenHash,
      );
      emitClaimedOutput(
        output,
        `Claimed ${truncatedToken} -> ${freshDelegation.childRunbookPath}`,
        buildClaimedPayload({
          truncatedToken,
          claimId: existingClaim.claimId,
          childRunId: existingClaim.childRunId,
          childRunbookPath: freshDelegation.childRunbookPath,
          parentRunId: freshParent.id,
          parentStepAt: freshDelegation.contextSnapshot.at,
        }),
      );
      return {
        ok: true,
        childRunId: existingClaim.childRunId,
        claimId: existingClaim.claimId,
        parentRunId: freshParent.id,
        stepId,
        loopResult: 'waiting',
      };
    }

    // 4e. Reconstitute context vars from frozen snapshot
    const inheritedContextVars = reconstituteContextVars(freshDelegation.contextSnapshot);
    const inheritedUserVars = extractInheritedUserVars(freshDelegation.contextSnapshot);

    // 4f. Prepare child runbook
    const prepResult = await prepareRunbook(freshDelegation.childRunbookPath, inputOpts, cwd, {
      inheritedContextVars,
      inheritedUserVars,
    });
    if (!prepResult.ok) {
      return {
        ok: false,
        reason: 'prepare-failed',
        runbook: freshDelegation.childRunbookPath,
        code: prepResult.code,
        cause: prepResult.error,
        details: prepResult.details,
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

    const parentPrompted = freshParent.prompted ?? false;

    // 4g. Launch child runbook
    let capturedChildRunId: string | undefined;
    let capturedClaimId: ClaimId | undefined;
    // Captures a write-side claim invariant violation in `afterInit` so we
    // can surface it as a structured launch-failed result instead of an
    // anonymous thrown Error. Should never trigger in practice — the child
    // was just created with the same delegationLinkage being validated.
    let invariantViolation: Extract<ClaimChildResult, { ok: false }> | undefined;

    const launchResult = await launchRunbook(ctx, prepResult.prepared, {
      runbookName: freshDelegation.childRunbookPath,
      prompted: parentPrompted,
      parentLinkage: delegationLinkage,
      sessionActivation: { kind: 'none' },
      afterInit: async (childStateId) => {
        // Set childRunId on parent delegation (tokenHash for precise matching)
        const claimResult = await claimChildForPipeline(ctx, childStateId, delegationLinkage);
        if (!claimResult.ok) {
          // Capture and bail; the outer block translates this into a typed
          // launch-failed envelope with CLAIM_INVARIANT_VIOLATED so
          // post-mortem from CLI output reveals the cause.
          invariantViolation = claimResult;
          return;
        }
        await updateStepDelegationChildRunId(
          manager,
          freshParent.id,
          substepId ?? stepId,
          claimResult.childRunId,
          tokenHash,
        );
        capturedClaimId = claimResult.claimId;
        capturedChildRunId = claimResult.childRunId;
      },
    });

    if (invariantViolation !== undefined) {
      return {
        ok: false,
        reason: 'launch-failed',
        runbook: freshDelegation.childRunbookPath,
        code: ErrorCodes.CLAIM_INVARIANT_VIOLATED.code,
        cause: `Claim invariant violated for fresh child ${invariantViolation.childRunId}: ${invariantViolation.reason}`,
        details: {
          runbookName: freshDelegation.childRunbookPath,
          runbook: freshDelegation.childRunbookPath,
        },
      };
    }

    if (!launchResult.ok) {
      return {
        ok: false,
        reason: 'launch-failed',
        runbook: freshDelegation.childRunbookPath,
        code: launchResult.code,
        cause: launchResult.error,
        details: { ...launchResult.details, runbook: freshDelegation.childRunbookPath },
      };
    }

    const claimId = capturedClaimId;
    if (claimId === undefined) {
      return {
        ok: false,
        reason: 'launch-failed',
        runbook: freshDelegation.childRunbookPath,
        code: ErrorCodes.LAUNCH_FAILED.code,
        cause: 'Claim id was not created for delegated child.',
        details: {
          runbookName: freshDelegation.childRunbookPath,
          runbook: freshDelegation.childRunbookPath,
        },
      };
    }
    // capturedClaimId and capturedChildRunId are assigned together in afterInit
    // (see the launch-result handler above); a defined claim id implies a defined
    // child run id. The defensive check below preserves the invariant explicitly.
    if (capturedChildRunId === undefined) {
      return {
        ok: false,
        reason: 'launch-failed',
        runbook: freshDelegation.childRunbookPath,
        code: ErrorCodes.LAUNCH_FAILED.code,
        cause: 'Child run id was not captured for delegated child.',
        details: {
          runbookName: freshDelegation.childRunbookPath,
          runbook: freshDelegation.childRunbookPath,
        },
      };
    }
    const childRunId = capturedChildRunId;

    // Emit claimed output
    emitClaimedOutput(
      output,
      `Claimed ${truncatedToken} -> ${freshDelegation.childRunbookPath}`,
      buildClaimedPayload({
        truncatedToken,
        claimId,
        childRunId,
        childRunbookPath: freshDelegation.childRunbookPath,
        parentRunId: freshParent.id,
        parentStepAt: freshDelegation.contextSnapshot.at,
      }),
    );

    return {
      ok: true,
      childRunId,
      claimId,
      parentRunId: freshParent.id,
      stepId,
      loopResult: launchResult.loopResult,
    };
  } finally {
    // 5. Always release lock
    await lock.release(parentState.id);
  }
}
