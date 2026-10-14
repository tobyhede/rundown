/**
 * Business logic for the run command.
 *
 * Extracts the runbook preparation pipeline and runbook starting
 * from commands/run.ts.
 *
 * @module helpers/runbook-pipeline
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type RunbookStateManager,
  type RunbookActorService,
  type RunbookState,
  type ExecutionEventEmitter,
  type ResolvedRunbook,
  type RunbookRef,
  type RunbookSource,
  type RunId,
  type OwnerToken,
  ErrorCodes,
  getErrorMessage,
  type IterationBinding,
  type TemplateVarValue,
  type VariableValue,
  type RoutedVariableValue,
  type CommandExecutionStreamOptions,
  type RunProgressionDirective,
  type RunProgressionOutcome,
  progressionDirectiveForStartedRun,
  RunbookCompositionUnsupportedError,
  generateOwnerToken,
  generateRunId,
  hashRunSecret,
  partitionVariables,
  prepareParsedRunbook,
  redactRunSecret,
  type PreparedTemplateVariables as CorePreparedTemplateVariables,
  type RunnableTemplateVariables as CoreRunnableTemplateVariables,
} from '@rundown-org/core';
export { buildContextVars, buildTemplateVars } from '@rundown-org/core';
import {
  parseRunbookDocument,
  stepHasSubsteps,
  type Step,
  type ResolvedStep,
  type ValidationDiagnostic,
  type RunbookFrontmatter,
  type Runbook,
} from '@rundown-org/parser';
import {
  buildRunbookRef,
  resolveRunbookFile,
  type ResolveRunbookFileOptions,
} from './resolve-runbook.js';
import type { ResolvedRunbook as ResolvedRunbookFile } from './resolve-runbook.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import {
  ArtifactChannelError,
  FileSourcePolicyError,
  resolveVariables,
} from '../services/variable-discovery.js';
import { getPolicyEvaluator, getPolicyPrompter } from '../services/policy-context.js';
import { validateOutputsDeclarations } from './validate-frontmatter-vars.js';
import { getHelperRegistry } from '../services/helper-registry.js';

/**
 * Raw input-supplying CLI flags collected before variable resolution.
 *
 * Carries both boundary channels: the variable channel (`inputFile` / `input` /
 * `inputJson`) and the artifact channel (`artifacts` / `artifactsJson`). Values
 * are unparsed flag strings; the resolution pipeline routes each field to its
 * channel and validates it there.
 */
export interface InputOptions {
  /** Paths to YAML files containing variable definitions (repeatable) */
  inputFile?: string[];
  /** Inline key=value variable overrides (repeatable) */
  input?: string[];
  /** Inline key=json variable overrides with JSON values (repeatable) */
  inputJson?: string[];
  /** Inline key=rd:// artifact-channel overrides (repeatable) */
  artifacts?: string[];
  /** Inline key=json artifact-channel overrides (JSON array of rd:// URIs, repeatable) */
  artifactsJson?: string[];
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
  /** Current working directory for file resolution */
  cwd: string;
  /** Runtime-only routing for command subprocess stdout/stderr. */
  commandStreamOptions?: CommandExecutionStreamOptions;
}

/** Template variables available after runbook resolution but before execution starts. */
export type PreparedTemplateVariables = CorePreparedTemplateVariables;

/** Template variables available to a runnable runbook execution. */
export type RunnableTemplateVariables = CoreRunnableTemplateVariables;

/**
 * A resolved, validated, template-substituted runbook.
 *
 * This shape is safe for `rd resolve`: it contains resolver-owned identity
 * (`RunbookRef`) but never mints execution-owned identity (`RunId`).
 */
export interface PreparedRunbook {
  /** Absolute path to the resolved runbook file */
  filePath: string;
  /** Source where the runbook was discovered from */
  source: RunbookSource;
  /** Source root used to derive persisted runbook identity */
  sourceRoot: string;
  /** Canonical runbook reference for events and artifact metadata */
  runbookRef: RunbookRef;
  /** Raw markdown content of the runbook file */
  rawContent: string;
  /** Parsed and variable-substituted runbook AST (all FOR bounds resolved) */
  runbook: ResolvedRunbook;
  /** Merged template variables from all sources */
  mergedVariables: PreparedTemplateVariables;
  /** Runtime variables from artifact-shaped inputs and inherited values */
  runtimeVars: Readonly<Record<string, VariableValue>>;
  /** Step and substep counts */
  stats: { steps: number; substeps: number };
  /** Validated frontmatter, or null if absent/invalid */
  frontmatter: RunbookFrontmatter | null;
}

/**
 * A prepared runbook with execution identity allocated.
 *
 * Only `rd run`, fresh `rd claim`, and other state-creating paths should
 * accept this type. `runId` must be passed into `RunbookStateManager.create()`.
 */
export interface RunnableRunbook extends PreparedRunbook {
  readonly runId: RunId;
  readonly mergedVariables: RunnableTemplateVariables;
}

function deriveClaudePluginRoot(sourceRoot: string): string {
  const normalized = sourceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  const pluginRoot = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '.';
  return `${pluginRoot}/`;
}

/** Failure produced while initializing a runbook launch. */
export type RunbookStartFailure =
  | {
      ok: false;
      reason: 'launch-failed';
      error: string;
      code: typeof ErrorCodes.ENGINE_INIT_FAILED.code;
      details: { runbookName: string };
    }
  | {
      /**
       * Core refused to create the run: the runbook composes other runbooks
       * in a form this build does not run (a substep listing more than one
       * runbook). No run row was written.
       */
      ok: false;
      reason: 'composition-unsupported';
      error: string;
      code: 'RUNBOOK_COMPOSITION_UNSUPPORTED';
      details: { runbook: string; substeps: readonly string[] };
    };

/** Result of starting a runbook execution loop via {@link startRunbook}. */
export type RunbookStartResult =
  | {
      ok: true;
      /** Closed outcome of the required Run Progression activation. */
      progression: RunProgressionOutcome;
      stateId: RunId;
      /**
       * The run's Owner Token, printed once on `runbook_started` and never
       * persisted in plaintext. The caller uses it for a launch-local jump.
       */
      ownerToken: OwnerToken;
    }
  | RunbookStartFailure;

/** Activate a freshly started run through the public Run Progression seam. */
export type StartedRunProgression = (
  directive: Extract<RunProgressionDirective, { kind: 'activate' }>,
  sink: ExecutionEventEmitter,
) => Promise<RunProgressionOutcome>;

/**
 * Emit RUNBOOK_STARTED event with metadata.
 *
 * The SOLE delivery channel for a run's Owner Token: the launch pipeline
 * emits it once, and nothing else ever carries the plaintext.
 *
 * @param emitter - Event emitter for publishing execution events
 * @param runbookState - Current runbook state with title and description
 * @param prompted - Whether the runbook is running in prompted mode
 * @param ownerToken - The run's Owner Token, carried on the event exactly once
 * @param parent - The parent of a Delegation started by `rundown claim` (#904)
 * @param parent.runId - The parent run
 * @param parent.step - The parent unit (`step.substep`) the child runs for
 */
export function emitRunbookStarted(
  emitter: ExecutionEventEmitter,
  runbookState: RunbookState,
  prompted: boolean,
  ownerToken?: OwnerToken,
  parent?: { readonly runId: string; readonly step: string },
): void {
  emitter.emit({
    type: 'RUNBOOK_STARTED',
    payload: {
      title: runbookState.title,
      description: runbookState.description,
      prompted,
      ...(ownerToken !== undefined ? { ownerToken } : {}),
      ...(parent !== undefined ? { parent } : {}),
    },
  });
}

/** Options that influence runbook preparation and context inheritance. */
export interface PrepareRunbookOptions {
  /** Context variables inherited from a parent run (composition, #903/#904). */
  readonly inheritedContextVars?: Readonly<Record<string, VariableValue>>;
  /** User variables inherited from a parent run (composition, #903/#904). */
  readonly inheritedUserVars?: Readonly<Record<string, VariableValue>>;
  /**
   * Typed FOR iteration binding inherited from the delegating parent
   * (language spec §10.4). Forwarded to `prepareParsedRunbook`, which surfaces
   * it into the child gated on the child's declared `inputs`.
   */
  readonly iterationBinding?: IterationBinding;
  /** Optional execution identity supplied by a parent inline launch intent. */
  readonly runId?: RunId;
  /**
   * Absolute path of the runbook composing this one (a Child Run's parent).
   * A child reference no search root holds is then tried beside it.
   */
  readonly composedFrom?: string;
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
      readonly code:
        | 'RUNBOOK_NOT_FOUND'
        | 'PARSE_ERROR'
        | 'RUNBOOK_REF_RESOLUTION_ERROR'
        | 'VARIABLE_RESOLUTION_ERROR';
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
    })
  | (PrepareFailureBase & {
      readonly code: 'ARTIFACT_CHANNEL_COLLISION' | 'INVALID_ARTIFACT_INPUT';
      readonly details: { readonly runbook: string; readonly variable: string };
    })
  | (PrepareFailureBase & {
      /** Core refused a non-artifact value bound to a name the runbook requires as an artifact. */
      readonly code: 'ARTIFACT_INPUT_REQUIRED';
      readonly details: {
        readonly runbook: string;
        readonly variable: string;
        readonly step?: string;
      };
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
  source: RunbookSource;
  /** Source root used to derive persisted runbook identity */
  sourceRoot: string;
  /** Canonical runbook reference derived from the resolved file identity. */
  runbookRef: RunbookRef;
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
  code: 'RUNBOOK_NOT_FOUND' | 'PARSE_ERROR' | 'RUNBOOK_REF_RESOLUTION_ERROR';
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
 * @returns Discriminated union: ok with loaded data, or error with message
 */
function runbookNotFound(file: string): LoadAndParseFailure {
  return {
    ok: false,
    error: `Runbook not found: ${file}. Try 'rundown ls --all' to list available runbooks.`,
    code: 'RUNBOOK_NOT_FOUND',
    details: { runbook: file },
  };
}

/**
 * Describe a runbook's unsupported composing substeps, shared by the
 * `rundown run` refusal and the `rundown check` warning so the two never
 * disagree. Inline (#903) and delegated (#904) runbook-list substeps run;
 * only a substep listing more than one runbook is named.
 *
 * @param composing - Qualified substep ids from `findUnsupportedComposition`
 * @returns A sentence fragment (no trailing period) naming those substeps
 */
export function describeUnsupportedComposition(composing: readonly string[]): string {
  return `Runbook composes other runbooks at ${composing.join(', ')} in a form this build does not run (a substep listing more than one runbook: each substep composes one child)`;
}

/** Request for preparing an already-resolved runbook identity. */
export interface ResolvedRunbookRequest {
  /** Filesystem resolution result. */
  readonly resolved: ResolvedRunbookFile;
  /** Canonical persisted runbook identity expected for the resolved file. */
  readonly runbookRef: RunbookRef;
  /** User-facing name or path used in diagnostics. */
  readonly displayName: string;
}

/**
 * Resolve, load, and parse a runbook file.
 *
 * @param file - Runbook file path or namespace:name
 * @param cwd - Current working directory for resolution
 * @param resolveOptions - Resolution options, such as the composing runbook's path
 * @returns Loaded runbook data or a structured load failure
 */
export async function loadAndParseRunbook(
  file: string,
  cwd: string,
  resolveOptions: ResolveRunbookFileOptions = {},
): Promise<LoadAndParseResult> {
  const resolved = await resolveRunbookFile(cwd, file, resolveOptions);

  if (!resolved) {
    return runbookNotFound(file);
  }

  let runbookRef: RunbookRef;
  try {
    runbookRef = await buildRunbookRef(resolved);
  } catch (error: unknown) {
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'RUNBOOK_REF_RESOLUTION_ERROR',
      details: { runbook: file },
    };
  }

  return loadAndParseResolvedRunbook({
    resolved,
    runbookRef,
    displayName: file,
  });
}

/**
 * Load and parse a runbook from an already-resolved request.
 *
 * @param request - Resolved runbook request carrying source metadata and identity
 * @returns Loaded runbook data or a structured load failure
 */
export async function loadAndParseResolvedRunbook(
  request: ResolvedRunbookRequest,
): Promise<LoadAndParseResult> {
  const { resolved, displayName } = request;
  const { path: filePath, source, sourceRoot } = resolved;
  const runbookRef = request.runbookRef;

  let derivedRunbookRef: RunbookRef;
  try {
    derivedRunbookRef = await buildRunbookRef({ path: filePath, source, sourceRoot });
  } catch (error: unknown) {
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'RUNBOOK_REF_RESOLUTION_ERROR',
      details: { runbook: displayName },
    };
  }

  if (
    derivedRunbookRef.source !== runbookRef.source ||
    derivedRunbookRef.path !== runbookRef.path
  ) {
    return {
      ok: false,
      error: `Resolved runbook identity ${derivedRunbookRef.source}:${derivedRunbookRef.path} does not match requested ${runbookRef.source}:${runbookRef.path}`,
      code: 'RUNBOOK_REF_RESOLUTION_ERROR',
      details: { runbook: displayName },
    };
  }

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
      sourceRoot,
      runbookRef,
      rawContent,
      runbook,
      frontmatter,
      diagnostics,
      stats,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'PARSE_ERROR',
      details: { runbook: displayName },
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
  options?: PrepareRunbookOptions,
): Promise<PrepareResult> {
  const parsed = await loadAndParseRunbook(file, cwd);
  return prepareLoadedRunbook(parsed, file, inputOpts, cwd, { kind: 'prepared' }, options);
}

/** Success/failure result from preparing a runnable execution. */
export type RunnablePrepareResult =
  | (Omit<PrepareSuccess, 'prepared'> & { readonly prepared: RunnableRunbook })
  | PrepareFailure;

/**
 * Prepare a runbook for execution, minting a fresh `RunId`.
 *
 * @param file - Runbook file path or name
 * @param inputOpts - Input options from CLI flags
 * @param cwd - Current working directory
 * @param options - Optional settings including inherited variables from parent runbook
 * @returns Runnable preparation result with execution identity on success
 */
export async function prepareRunnableRunbook(
  file: string,
  inputOpts: InputOptions,
  cwd: string,
  options?: PrepareRunbookOptions,
): Promise<RunnablePrepareResult> {
  const parsed = await loadAndParseRunbook(
    file,
    cwd,
    options?.composedFrom !== undefined ? { composedFrom: options.composedFrom } : {},
  );
  return prepareLoadedRunbook(
    parsed,
    file,
    inputOpts,
    cwd,
    { kind: 'runnable', runId: options?.runId ?? generateRunId() },
    options,
  );
}

/**
 * Prepare an already-resolved runbook for execution, minting a fresh `RunId`.
 *
 * @param request - Resolved runbook request carrying source metadata and identity
 * @param inputOpts - Input options from CLI flags
 * @param cwd - Current working directory
 * @param options - Optional settings including inherited variables from parent runbook
 * @returns Runnable preparation result with execution identity on success
 */
export async function prepareResolvedRunnableRunbook(
  request: ResolvedRunbookRequest,
  inputOpts: InputOptions,
  cwd: string,
  options?: PrepareRunbookOptions,
): Promise<RunnablePrepareResult> {
  const parsed = await loadAndParseResolvedRunbook(request);
  return prepareLoadedRunbook(
    parsed,
    request.displayName,
    inputOpts,
    cwd,
    { kind: 'runnable', runId: options?.runId ?? generateRunId() },
    options,
  );
}

type PreparedIdentity = { readonly kind: 'prepared' };
type RunnableIdentity = { readonly kind: 'runnable'; readonly runId: RunId };

function prepareLoadedRunbook(
  parsed: LoadAndParseResult,
  displayName: string,
  inputOpts: InputOptions,
  cwd: string,
  identity: PreparedIdentity,
  options?: PrepareRunbookOptions,
): Promise<PrepareResult>;
function prepareLoadedRunbook(
  parsed: LoadAndParseResult,
  displayName: string,
  inputOpts: InputOptions,
  cwd: string,
  identity: RunnableIdentity,
  options?: PrepareRunbookOptions,
): Promise<RunnablePrepareResult>;
async function prepareLoadedRunbook(
  parsed: LoadAndParseResult,
  displayName: string,
  inputOpts: InputOptions,
  cwd: string,
  identity: PreparedIdentity | RunnableIdentity,
  options?: PrepareRunbookOptions,
): Promise<PrepareResult | RunnablePrepareResult> {
  if (!parsed.ok) return parsed;
  const {
    filePath,
    source,
    sourceRoot,
    runbookRef,
    rawContent,
    runbook: rawRunbook,
    frontmatter,
    diagnostics,
    stats,
  } = parsed;

  const pluginRoot = source === 'plugin' ? deriveClaudePluginRoot(sourceRoot) : undefined;

  // Inherited user vars pass through untouched here. Context OUTPUTS are
  // inherited after variable resolution (stage 3.5 below), once the child's
  // final ContextId is known. Merging context outputs before resolution would
  // mark their keys as "provided" against the child's own ContextId override
  // (e.g. `claim --input ContextId=...`) and prevent the correct outputs from
  // being loaded from the new context.
  const inheritedUserVars = options?.inheritedUserVars ?? {};

  // Variable resolution
  // RoutedVariableValue, not VariableValue: this holds the post-routing,
  // pre-partition values (which may include forged artifact-shaped JSON).
  // partitionVariables(resolvedVariableMap) converts to the trusted shape.
  let resolvedVariableMap: Record<string, RoutedVariableValue>;
  let providedKeys: ReadonlySet<string>;
  const allWarnings: string[] = [];
  try {
    const resolvedVariables = await resolveVariables(
      {
        inputFile: inputOpts.inputFile,
        input: inputOpts.input,
        inputJson: inputOpts.inputJson,
        artifacts: inputOpts.artifacts,
        artifactsJson: inputOpts.artifactsJson,
        inheritedVars: inheritedUserVars,
      },
      cwd,
      {
        evaluator: getPolicyEvaluator(),
        prompter: getPolicyPrompter(),
      },
    );
    resolvedVariableMap = { ...resolvedVariables.vars };
    providedKeys = resolvedVariables.providedKeys;
    // Inject CLAUDE_PLUGIN_ROOT for plugin-sourced runbooks (below CLI flags in precedence)
    if (pluginRoot && !('CLAUDE_PLUGIN_ROOT' in resolvedVariableMap)) {
      resolvedVariableMap.CLAUDE_PLUGIN_ROOT = pluginRoot;
    }
    allWarnings.push(...resolvedVariables.warnings);
  } catch (error) {
    if (error instanceof FileSourcePolicyError) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
        details: {
          runbook: displayName,
          variable: error.variable,
          filePath: error.filePath,
          reason: error.reason,
        },
        stats,
        diagnostics,
      };
    }
    if (error instanceof ArtifactChannelError) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
        details: {
          runbook: displayName,
          variable: error.key,
        },
        stats,
        diagnostics,
      };
    }
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'VARIABLE_RESOLUTION_ERROR',
      details: { runbook: displayName },
      variables: {},
      stats,
      diagnostics,
    };
  }
  const partitions = partitionVariables(resolvedVariableMap);
  const contextPartitions = partitionVariables(options?.inheritedContextVars ?? {});
  const parsedPreparation = prepareParsedRunbook({
    rawRunbook,
    frontmatter,
    diagnostics,
    cwd,
    templateVars: partitions.templateVars,
    runtimeVars: { ...partitions.runtimeVars, ...contextPartitions.runtimeVars },
    providedKeys,
    inheritedContextVars: contextPartitions.templateVars,
    iterationBinding: options?.iterationBinding,
    runbookRef,
    helperRegistry: getHelperRegistry(),
    identity:
      identity.kind === 'runnable'
        ? { kind: 'runnable', runId: identity.runId }
        : { kind: 'prepared' },
  });

  allWarnings.push(...parsedPreparation.warnings);

  if (!parsedPreparation.ok) {
    if (parsedPreparation.code === 'MISSING_REQUIRED_VARS') {
      const missing = Array.isArray(parsedPreparation.details.missing)
        ? parsedPreparation.details.missing.filter(
            (name): name is string => typeof name === 'string',
          )
        : [];
      return {
        ok: false,
        error: parsedPreparation.error,
        code: 'MISSING_REQUIRED_VARS',
        details: { runbook: displayName, missing },
        variables: parsedPreparation.templateVars,
        stats,
        diagnostics,
        warnings: allWarnings.length > 0 ? allWarnings : undefined,
      };
    }

    if (parsedPreparation.code === 'ARTIFACT_INPUT_REQUIRED') {
      return {
        ok: false,
        error: parsedPreparation.error,
        code: parsedPreparation.code,
        details: { runbook: displayName, ...parsedPreparation.details },
        variables: parsedPreparation.templateVars,
        stats,
        diagnostics,
        warnings: allWarnings.length > 0 ? allWarnings : undefined,
      };
    }

    return {
      ok: false,
      error: parsedPreparation.error,
      code: 'VALIDATION_ERROR',
      details: { runbook: displayName },
      variables: parsedPreparation.templateVars,
      stats,
      diagnostics,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };
  }

  const runbook = parsedPreparation.runbook;
  const templateVars = parsedPreparation.templateVars;
  const unresolvedNames = parsedPreparation.unresolved;

  const preparedBaseFields = {
    filePath,
    source,
    sourceRoot,
    runbookRef,
    rawContent,
    runbook,
    stats,
    frontmatter,
  };

  if (identity.kind === 'runnable') {
    const prepared: RunnableRunbook = {
      ...preparedBaseFields,
      runId: identity.runId,
      mergedVariables: templateVars as RunnableTemplateVariables,
      runtimeVars: parsedPreparation.runtimeVars,
    };

    return {
      ok: true,
      prepared,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
      diagnostics,
      unresolved: unresolvedNames,
    };
  }

  const prepared: PreparedRunbook = {
    ...preparedBaseFields,
    mergedVariables: templateVars,
    runtimeVars: parsedPreparation.runtimeVars,
  };

  return {
    ok: true,
    prepared,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    diagnostics,
    unresolved: unresolvedNames,
  };
}

/**
 * Launch a prepared runbook as a new run owned by a fresh Owner Token.
 *
 * Mints the token, creates the run row carrying the token's hash,
 * initializes the machine, emits `RUNBOOK_STARTED` carrying the plaintext
 * token (the one time it is ever printed), and drives the first Run
 * Progression turn under the directive core mints for a started run.
 *
 * @param ctx - Pipeline context
 * @param prepared - Prepared runbook data
 * @param options - Launch options
 * @param options.runbookName - Name identifier for the runbook being launched
 * @param options.prompted - Whether to run in prompted mode (no auto-execution)
 * @param options.initialVariables - Runtime variables to persist before actor initialization
 * @param options.driveProgression - Public activation callback for the fresh run
 * @returns RunbookStartResult
 */
async function launchRunbook(
  ctx: RunPipelineContext,
  prepared: RunnableRunbook,
  options: {
    runbookName: string;
    prompted: boolean;
    initialVariables?: Readonly<Record<string, VariableValue>>;
    driveProgression: StartedRunProgression;
  },
): Promise<RunbookStartResult> {
  const { output, manager, actorService, cwd } = ctx;
  const { filePath, rawContent, runbook, mergedVariables } = prepared;

  const runbookPath = path.relative(cwd, filePath);
  const ownerToken = generateOwnerToken();

  // Init phase: state creation through start-event emission. Failures here
  // produce a structured launch failure; the run row is removed so a half
  // started run does not linger. Progression failures propagate as outcomes.
  let stateId: RunId | undefined;
  let launch: {
    state: RunbookState;
    runbookSteps: ResolvedStep[];
    emitter: ExecutionEventEmitter;
  };
  try {
    const state = await manager.create(prepared.runbookRef, runbook, {
      runId: prepared.runId,
      ownerTokenHash: hashRunSecret(ownerToken),
      runbookPath,
      prompted: options.prompted,
      runbookSrc: rawContent,
      templateVars: mergedVariables,
      initialVariables: {
        ...prepared.runtimeVars,
        ...(options.initialVariables ?? {}),
      },
      frontmatterOutputs: prepared.frontmatter?.outputs ?? [],
    });
    stateId = state.id;

    const initializedState = await actorService.initializeState(state.id, runbook.steps);
    if (!initializedState) {
      throw new Error('Failed to initialize runbook engine');
    }

    const emitter = createBridgedEmitter(initializedState, output);
    emitRunbookStarted(emitter, initializedState, options.prompted, ownerToken);

    launch = { state: initializedState, runbookSteps: [...runbook.steps], emitter };
  } catch (err) {
    // Core's refusal to create a composing run: no row exists, so there is
    // nothing to clean up; the CLI only renders the substeps core names.
    if (err instanceof RunbookCompositionUnsupportedError) {
      return {
        ok: false,
        reason: 'composition-unsupported',
        error: `${describeUnsupportedComposition(err.substeps)}.`,
        code: 'RUNBOOK_COMPOSITION_UNSUPPORTED',
        details: { runbook: options.runbookName, substeps: err.substeps },
      };
    }
    if (stateId !== undefined) {
      try {
        await manager.delete(stateId);
      } catch {
        // Preserve the launch error; cleanup is best effort.
      }
    }
    return {
      ok: false,
      reason: 'launch-failed',
      error: redactRunSecret(getErrorMessage(err)),
      code: ErrorCodes.ENGINE_INIT_FAILED.code,
      details: { runbookName: options.runbookName },
    };
  }

  const progression = await options.driveProgression(
    progressionDirectiveForStartedRun(launch.state, launch.runbookSteps),
    launch.emitter,
  );
  return { ok: true, progression, stateId: launch.state.id, ownerToken };
}

/**
 * Start a runbook from a prepared file.
 *
 * @param ctx - Pipeline context
 * @param prepared - Prepared runbook data
 * @param options - Start options
 * @param options.file - Runbook file path or name
 * @param options.prompted - Whether to run in prompted mode
 * @param options.initialVariables - Runtime variables to persist before actor initialization
 * @param options.driveProgression - Public activation callback for the fresh run.
 * @returns RunbookStartResult
 */
export async function startRunbook(
  ctx: RunPipelineContext,
  prepared: RunnableRunbook,
  options: {
    file: string;
    prompted?: boolean;
    initialVariables?: Readonly<Record<string, VariableValue>>;
    driveProgression: StartedRunProgression;
  },
): Promise<RunbookStartResult> {
  return launchRunbook(ctx, prepared, {
    runbookName: options.file,
    prompted: !!options.prompted,
    initialVariables: options.initialVariables,
    driveProgression: options.driveProgression,
  });
}
