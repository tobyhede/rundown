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
  type RunbookState,
  type ExecutionEventEmitter,
  type ResolvedRunbook,
  type RunbookRef,
  type RunbookSource,
  type RunId,
  type DelegationLinkage,
  type ParentLinkage,
  type ClaimId,
  type SessionMutationRefusalOutcome,
  type DelegationRuntimeCapabilities,
  DelegationScanService,
  DEFAULT_MUTATE_ATTEMPTS,
  mutateBackoffMs,
  reconstituteContextVars,
  extractInheritedUserVars,
  hashDelegationToken,
  isDelegationToken,
  truncateDelegationToken,
  ErrorCodes,
  getErrorMessage,
  type IterationBinding,
  type TemplateVarValue,
  type VariableValue,
  type RoutedVariableValue,
  type CommandExecutionStreamOptions,
  generateRunId,
  partitionVariables,
  prepareParsedRunbook,
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
import { buildRunbookRef, resolveRunbookFile, resolveRunbookRef } from './resolve-runbook.js';
import type { ResolvedRunbook as ResolvedRunbookFile } from './resolve-runbook.js';
import { runExecutionLoop } from '../services/execution.js';
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
import { getRunbookFromState } from './runbook-loader.js';

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
  /** Session service for tracking active/stashed runbooks */
  sessionService: SessionService;
  /** Lifecycle service for managing pending steps and transitions */
  lifecycleService: ExecutionLifecycleService;
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
export interface RunbookStartFailure {
  ok: false;
  reason: 'launch-failed';
  error: string;
  code: typeof ErrorCodes.LAUNCH_FAILED.code;
  details: { runbookName: string };
}

/**
 * Refusal arm shared by launch and claim: a session mutation the pipeline needed
 * was refused for execution ownership.
 *
 * The core refusal is carried whole rather than spread into sibling fields, so
 * the run id, epoch, and operator text reach the renderer exactly as core wrote
 * them and no front end re-synthesizes any of the three.
 */
export interface SessionRefusedFailure {
  readonly ok: false;
  readonly reason: 'session-refused';
  /** The typed ownership refusal, forwarded verbatim to the CLI renderer. */
  readonly refusal: SessionMutationRefusalOutcome;
}

/** Result of starting a runbook execution loop via {@link startRunbook}. */
export type RunbookStartResult =
  | {
      ok: true;
      loopResult: 'done' | 'stopped' | 'waiting';
      stateId: RunId;
      claimId?: ClaimId;
      /** Process-only capabilities bound to the exact run-control claim. */
      delegationRuntime?: DelegationRuntimeCapabilities;
    }
  | RunbookStartFailure
  | SessionRefusedFailure;

type LaunchSessionActivation = { readonly kind: 'default-stack' } | { readonly kind: 'none' };

/** Failure variants from claiming and launching a delegated child runbook. */
export type ClaimFailure =
  | Omit<SessionRefusedFailure, 'ok'>
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
      readonly reason: 'delegation-already-claimed';
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
       * operator intervention required — inspect the child row in
       * `.rundown/rundown.db`. Rendered as
       * `CHILD_LINKAGE_MISMATCH`.
       */
      readonly reason: 'linkage-mismatch';
      readonly parentRunId: string;
      readonly stepId: string;
      readonly childRunId: string;
    }
  | {
      /**
       * The parent moved past this delegation (advanced, ended, reset, or
       * reissued its token) before the claim committed. The durable latch
       * refuses it; the token must not be retried. `childRunId` is present
       * whenever the refused claim named a child — replay of a linked child,
       * orphan adoption, or reuse of an existing claim, each of which carries
       * it through `claimResultToFailure`. It is absent only on the fresh
       * launch, where the delegation records no child and the run this claim
       * just created is about to be removed by launch cleanup; none is ever
       * synthesized. Rendered as `DELEGATION_SUPERSEDED`.
       */
      readonly reason: 'delegation-superseded';
      readonly parentRunId: string;
      readonly stepId: string;
      readonly childRunId?: string;
    }
  | {
      /**
       * The parent changed between deriving and committing the delegated-child
       * link. Nothing was written, so the claim is safe to retry. Rendered as
       * `CONCURRENT_MODIFICATION`.
       */
      readonly reason: 'concurrent-modification';
      readonly parentRunId: string;
      readonly stepId: string;
      readonly childRunId: string;
    }
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
      childRunId: RunId;
      /** Bearer claim id for newly claimed children. */
      claimId: ClaimId;
      /** Unique identifier of the parent run that owns the delegation. */
      parentRunId: RunId;
      /** Step (or substep) ID on the parent that holds the delegation. */
      stepId: string;
      /** Terminal state of the child execution loop. */
      loopResult: 'done' | 'stopped' | 'waiting';
    }
  | ({ readonly ok: false } & ClaimFailure);

/**
 * Emit RUNBOOK_STARTED event with metadata.
 *
 * Exported because it is the SOLE delivery channel for a run-control bearer,
 * and two sites now start a run's execution: this launch pipeline, and the
 * resumed inline-child continuation that adopts a fresh bearer for an orphaned
 * run. A second transcription of the payload would let the two disagree about
 * which field carries the credential.
 *
 * @param emitter - Event emitter for publishing execution events
 * @param runbookState - Current runbook state with title and description
 * @param prompted - Whether the runbook is running in prompted mode
 * @param claimId - Optional run-control bearer minted for the orchestrator
 */
export function emitRunbookStarted(
  emitter: ExecutionEventEmitter,
  runbookState: RunbookState,
  prompted: boolean,
  claimId?: ClaimId,
): void {
  emitter.emit({
    type: 'RUNBOOK_STARTED',
    payload: {
      title: runbookState.title,
      description: runbookState.description,
      prompted,
      ...(claimId !== undefined ? { claimId } : {}),
    },
  });
}

/** Options that influence runbook preparation for delegation and context inheritance. */
export interface PrepareRunbookOptions {
  /** Context variables inherited from a parent delegation. */
  readonly inheritedContextVars?: Readonly<Record<string, VariableValue>>;
  /** User variables inherited from a parent delegation. */
  readonly inheritedUserVars?: Readonly<Record<string, VariableValue>>;
  /**
   * Typed FOR iteration binding inherited from the delegating parent
   * (language spec §10.4). Forwarded to `prepareParsedRunbook`, which surfaces
   * it into the child gated on the child's declared `inputs`.
   */
  readonly iterationBinding?: IterationBinding;
  /** Optional execution identity supplied by a parent inline launch intent. */
  readonly runId?: RunId;
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
 * @returns Loaded runbook data or a structured load failure
 */
export async function loadAndParseRunbook(file: string, cwd: string): Promise<LoadAndParseResult> {
  const resolved = await resolveRunbookFile(cwd, file);

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
  const parsed = await loadAndParseRunbook(file, cwd);
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
 * @param options.initialVariables - Runtime variables to persist before actor initialization
 * @param options.afterCreate - Optional callback invoked after state creation and before initialization
 * @param options.afterCreateRollback - Optional best-effort rollback for afterCreate side effects
 * @param options.afterInit - Optional callback invoked after state initialization with the new state ID
 * @param options.afterInitRollback - Optional best-effort rollback for afterInit side effects
 * @param options.afterStarted - Optional callback invoked after RUNBOOK_STARTED is emitted
 * @returns RunbookStartResult
 */
async function launchRunbook(
  ctx: RunPipelineContext,
  prepared: RunnableRunbook,
  options: {
    runbookName: string;
    prompted: boolean;
    parentLinkage?: ParentLinkage;
    sessionActivation?: LaunchSessionActivation;
    initialVariables?: Readonly<Record<string, VariableValue>>;
    afterCreate?: (stateId: RunId) => Promise<void>;
    afterCreateRollback?: (stateId: RunId) => Promise<void>;
    afterInit?: (stateId: RunId) => Promise<void>;
    afterInitRollback?: (stateId: RunId) => Promise<void>;
    afterStarted?: (stateId: RunId) => Promise<void>;
  },
): Promise<RunbookStartResult> {
  const { output, manager, actorService, sessionService, cwd } = ctx;
  const { filePath, rawContent, runbook, mergedVariables } = prepared;

  const runbookPath = path.relative(cwd, filePath);

  // Init phase: state creation through start-event emission. Failures here
  // produce a structured launch failure so callers (notably claimAndLaunch)
  // can report cleanly. The loop itself is outside the try/catch — loop
  // failures still propagate as exceptions.
  let stateId: RunId | undefined;
  let launch: {
    stateId: RunId;
    runbookSteps: ResolvedStep[];
    emitter: ExecutionEventEmitter;
  };
  let sessionActivated = false;
  let afterCreateAttempted = false;
  let afterInitAttempted = false;
  let issuedRunControlClaimId: ClaimId | undefined;
  // Set when session activation is refused for execution ownership. The refusal
  // is raised as a throw so the shared cleanup path runs exactly as it does for
  // any other init failure, then replaces the generic launch-failed envelope.
  let activationRefusal: SessionMutationRefusalOutcome | undefined;
  const sessionActivation = options.sessionActivation ?? { kind: 'default-stack' as const };
  const preparedRunControlClaim =
    sessionActivation.kind === 'default-stack'
      ? sessionService.prepareRunControlClaim(prepared.runId)
      : undefined;
  const cleanupCreatedRun = async (): Promise<void> => {
    if (!stateId) return;
    if (afterInitAttempted && options.afterInitRollback) {
      try {
        await options.afterInitRollback(stateId);
      } catch {
        // Preserve the launch error; exact-coordinate rollback is best effort.
      }
    }
    if (afterCreateAttempted && options.afterCreateRollback) {
      try {
        await options.afterCreateRollback(stateId);
      } catch {
        // Preserve the launch error; cleanup is best effort.
      }
    }
    if (sessionActivated) {
      try {
        const release = await sessionService.releaseRunbook(stateId);
        // A refusal here is the same class of event as the swallowed rejection:
        // cleanup is best effort and must not replace the launch error.
        switch (release.kind) {
          case 'committed':
          case 'execution_in_progress':
          case 'recovery_required':
            break;
          default: {
            const _exhaustive: never = release;
            return _exhaustive;
          }
        }
      } catch {
        // Preserve the launch error; cleanup is best effort.
      }
    }
    try {
      await manager.delete(stateId);
    } catch {
      // Preserve the launch error; cleanup is best effort.
    }
  };
  try {
    const state = await manager.create(prepared.runbookRef, runbook, {
      runId: prepared.runId,
      runbookPath,
      prompted: options.prompted,
      parentLinkage: options.parentLinkage,
      runbookSrc: rawContent,
      templateVars: mergedVariables,
      initialVariables: {
        ...prepared.runtimeVars,
        ...(options.initialVariables ?? {}),
      },
      frontmatterOutputs: prepared.frontmatter?.outputs ?? [],
    });
    stateId = state.id;

    if (options.afterCreate) {
      afterCreateAttempted = true;
      await options.afterCreate(state.id);
    }

    const initializedState = await actorService.initializeState(
      state.id,
      runbook.steps,
      preparedRunControlClaim === undefined
        ? undefined
        : {
            issueDelegationCredential:
              preparedRunControlClaim.delegationRuntime.issueDelegationCredential,
          },
    );
    if (!initializedState) {
      throw new Error('Failed to initialize runbook engine');
    }

    // Optional post-init hook (e.g., linking delegation childRunId)
    if (options.afterInit) {
      afterInitAttempted = true;
      await options.afterInit(state.id);
    }

    switch (sessionActivation.kind) {
      case 'default-stack': {
        // Push + run-control claim mint as one atomic session mutation: run-start
        // is never persisted in a pushed-but-unclaimed state, and it takes a
        // single session transaction instead of two (removing the double-cycle
        // contention that made run-start flaky under heavy parallel load).
        if (preparedRunControlClaim === undefined) {
          throw new Error('Default-stack activation is missing its prepared run-control claim');
        }
        const activation = await sessionService.pushRunbookWithPreparedRunControlClaim(
          state.id,
          preparedRunControlClaim,
        );
        if (activation.kind !== 'committed') {
          activationRefusal = activation;
          throw new Error(activation.message);
        }
        sessionActivated = true;
        issuedRunControlClaimId = activation.value.claimId;
        break;
      }
      case 'none':
        break;
      default: {
        const _exhaustive: never = sessionActivation;
        throw new Error(
          `Unhandled session activation kind: ${(_exhaustive as LaunchSessionActivation).kind}`,
        );
      }
    }

    // Create emitter bridged to unified output
    const emitter = createBridgedEmitter(initializedState, output);

    // Emit RUNBOOK_STARTED
    emitRunbookStarted(emitter, initializedState, options.prompted, issuedRunControlClaimId);

    launch = { stateId: state.id, runbookSteps: [...runbook.steps], emitter };
  } catch (err) {
    // Best-effort cleanup: if the run was created before the failure, delete
    // it so an unclaimed run doesn't linger with no session entry.
    await cleanupCreatedRun();
    if (activationRefusal !== undefined) {
      return { ok: false, reason: 'session-refused', refusal: activationRefusal };
    }
    return {
      ok: false,
      reason: 'launch-failed',
      error: getErrorMessage(err),
      code: ErrorCodes.LAUNCH_FAILED.code,
      details: { runbookName: options.runbookName },
    };
  }

  const { stateId: launchedStateId, runbookSteps, emitter } = launch;

  if (options.afterStarted) {
    try {
      await options.afterStarted(launchedStateId);
    } catch (err) {
      await cleanupCreatedRun();
      return {
        ok: false,
        reason: 'launch-failed',
        error: getErrorMessage(err),
        code: ErrorCodes.LAUNCH_FAILED.code,
        details: { runbookName: options.runbookName },
      };
    }
  }

  const loopResult = await runExecutionLoop(
    manager,
    launchedStateId,
    runbookSteps,
    cwd,
    options.prompted,
    emitter,
    {
      terminalReleaseMode:
        options.sessionActivation?.kind === 'none' ? 'release-runbook' : 'stack-pop',
      output,
      commandStreamOptions: ctx.commandStreamOptions,
      ...(preparedRunControlClaim === undefined
        ? {}
        : {
            delegationRuntime: preparedRunControlClaim.delegationRuntime,
          }),
    },
  );

  return {
    ok: true,
    loopResult,
    stateId: launchedStateId,
    ...(issuedRunControlClaimId !== undefined ? { claimId: issuedRunControlClaimId } : {}),
    ...(preparedRunControlClaim === undefined
      ? {}
      : { delegationRuntime: preparedRunControlClaim.delegationRuntime }),
  };
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
 * @param options.initialVariables - Runtime variables to persist before actor initialization
 * @param options.afterInit - Optional callback invoked after state initialization with the new state ID
 * @param options.afterStarted - Optional callback invoked after RUNBOOK_STARTED is emitted
 * @returns RunbookStartResult
 * @throws {Error} On state persistence or machine initialization failures
 */
export async function startRunbook(
  ctx: RunPipelineContext,
  prepared: RunnableRunbook,
  options: {
    file: string;
    prompted?: boolean;
    parentLinkage?: ParentLinkage;
    initialVariables?: Readonly<Record<string, VariableValue>>;
    afterInit?: (stateId: RunId) => Promise<void>;
    afterStarted?: (stateId: RunId) => Promise<void>;
  },
): Promise<RunbookStartResult> {
  return launchRunbook(ctx, prepared, {
    runbookName: options.file,
    prompted: !!options.prompted,
    parentLinkage: options.parentLinkage,
    initialVariables: options.initialVariables,
    afterInit: options.afterInit,
    afterStarted: options.afterStarted,
  });
}

/** Outcome of {@link claimChildForPipeline}. */
type ClaimChildResult =
  | { readonly ok: true; readonly claimId: ClaimId; readonly childRunId: RunId }
  | {
      readonly ok: false;
      readonly reason:
        | 'child-missing'
        | 'delegation-resolved'
        | 'delegation-already-claimed'
        | 'delegation-superseded'
        | 'concurrent-modification'
        | 'linkage-mismatch';
      readonly childRunId: RunId;
    }
  // The parent vanished between the 3a re-read and the claim transaction. Named
  // by the parent, not the child: no child fact explains it, and the existing
  // `parent-missing` envelope already says exactly this.
  | { readonly ok: false; readonly reason: 'parent-missing'; readonly parentRunId: RunId }
  // The claim transaction was refused: some run it touches is under execution.
  | SessionRefusedFailure;

/**
 * Outcome of one {@link deriveAndCommitInitialLink} cycle.
 *
 * `refused` is decided during preparation and is terminal for the whole cycle;
 * `committed` is the atomic claim transaction's own typed result, which
 * {@link claimChildForPipeline} classifies alongside the non-initial-link path.
 */
type InitialLinkOutcome =
  | { readonly committed: Awaited<ReturnType<SessionService['claimAndInitialLink']>> }
  | { readonly refused: Extract<ClaimChildResult, { readonly ok: false }> };

/**
 * Derive the delegated-child parent link and commit it, re-deriving while the
 * parent keeps moving underneath the capture.
 *
 * The derivation cannot be folded into the commit's callback the way the
 * retired core lock sites folded theirs: `claimAndInitialLink` commits inside a
 * synchronous session transaction (`SyncWork`), and preparing the link is
 * async. So the read-derive-write gap stays open by construction and the loop
 * closes it from outside instead — a loser re-derives against the row the
 * winner committed, which is what turns an uninformative version mismatch into
 * the permanent `already_linked` the parent state now actually shows.
 *
 * Only the commit's `concurrent_modification` is retried. Every preparation
 * refusal is permanent: re-reading cannot free an occupied delegation or
 * un-supersede a moved one, so retrying those would only spend the budget
 * before reporting the same fact. Exhausting the budget returns the genuine
 * `concurrent_modification` rather than guessing at a permanent cause.
 *
 * The cycle re-runs capture, preparation, and commit — never child creation,
 * which the caller performed before invoking this and must not repeat.
 * Preparation is safe to repeat: `DELEGATION_CHILD_LINKED` is a root-level
 * handler with no `target`, so the transition is internal — nothing is exited
 * or entered and no `invoke` starts.
 *
 * @param ctx - Run pipeline context carrying the manager, actor, and session services
 * @param childRunId - Child run being linked to the parent's delegation
 * @param linkage - Exact delegation coordinates the link is derived against
 * @returns The atomic claim result to classify, or a terminal preparation refusal
 */
async function deriveAndCommitInitialLink(
  ctx: RunPipelineContext,
  childRunId: RunId,
  linkage: DelegationLinkage,
): Promise<InitialLinkOutcome> {
  for (let attempt = 0; ; attempt++) {
    const captured = await ctx.manager.captureRunAuthorityState(linkage.parentRunId);
    if (captured.kind === 'missing') {
      return {
        refused: { ok: false, reason: 'parent-missing', parentRunId: linkage.parentRunId },
      };
    }
    if (captured.kind === 'claim_superseded') {
      return { refused: { ok: false, reason: 'delegation-superseded', childRunId } };
    }
    const prepared = await ctx.actorService.prepareDelegationChildLink(
      captured.state,
      getRunbookFromState(captured.state, ctx.cwd),
      childRunId,
      linkage,
    );
    if (prepared.kind === 'delegation_superseded') {
      return { refused: { ok: false, reason: 'delegation-superseded', childRunId } };
    }
    // The delegation names a different child. That is permanent — it is the
    // same fact the 3c already-linked path reports — so it must reach the user
    // as the no-retry `DELEGATION_ALREADY_CLAIMED`, never as the retryable
    // `CONCURRENT_MODIFICATION` whose message tells them to try again. It names
    // the occupying child, not the one being linked: on the fresh-launch path
    // the rejected child is a run this claim's own cleanup is about to delete.
    if (prepared.kind === 'already_linked') {
      return {
        refused: {
          ok: false,
          reason: 'delegation-already-claimed',
          childRunId: prepared.occupyingChildRunId,
        },
      };
    }
    if (prepared.kind === 'concurrent_modification') {
      return { refused: { ok: false, reason: 'concurrent-modification', childRunId } };
    }
    const committed = await ctx.sessionService.claimAndInitialLink({
      childRunId,
      linkage,
      capturedParent: captured.authority,
      preparedParent: prepared.prepared,
    });
    if (committed.kind !== 'concurrent_modification' || attempt + 1 >= DEFAULT_MUTATE_ATTEMPTS) {
      return { committed };
    }
    await new Promise((resolve) => setTimeout(resolve, mutateBackoffMs(attempt)));
  }
}

/**
 * Claim or refresh a delegated child through {@link SessionService.claimRunbook}.
 *
 * `claimRunbook` owns the idempotent delegation contract: for a matching
 * parent linkage it refreshes an existing claim before validating the incoming
 * child id, and returns discriminated failures for missing, terminal, or
 * linkage-divergent children. The 3b already-linked branch in
 * {@link claimAndLaunch} intentionally relies on those source-of-truth
 * semantics instead of re-loading the child locally.
 *
 * @param ctx - Run pipeline context carrying the session service
 * @param childRunId - Child run id linked from the delegation or orphan scan
 * @param linkage - Fresh linkage rebuilt from token-validated parent state
 * @param initialLink - Whether to atomically establish the parent link with the claim
 * @returns Claim id and child id on success, or a mapped failure variant
 */
async function claimChildForPipeline(
  ctx: RunPipelineContext,
  childRunId: RunId,
  linkage: DelegationLinkage,
  initialLink = false,
): Promise<ClaimChildResult> {
  let result:
    | Awaited<ReturnType<SessionService['claimRunbook']>>
    | Awaited<ReturnType<SessionService['claimAndInitialLink']>>;
  if (initialLink) {
    const outcome = await deriveAndCommitInitialLink(ctx, childRunId, linkage);
    if ('refused' in outcome) return outcome.refused;
    result = outcome.committed;
  } else {
    result = await ctx.sessionService.claimRunbook(childRunId, linkage);
  }
  if (result.kind !== 'committed') {
    switch (result.kind) {
      case 'execution_in_progress':
      case 'recovery_required':
        return { ok: false, reason: 'session-refused', refusal: result };
      case 'missing':
        return result.runId === linkage.parentRunId
          ? { ok: false, reason: 'parent-missing', parentRunId: linkage.parentRunId }
          : { ok: false, reason: 'child-missing', childRunId };
      case 'claim_superseded':
        return { ok: false, reason: 'delegation-superseded', childRunId };
      case 'concurrent_modification':
        return { ok: false, reason: 'concurrent-modification', childRunId };
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }
  const claim = result.value;
  switch (claim.status) {
    case 'claimed':
      return {
        ok: true,
        claimId: claim.claimId,
        childRunId: claim.claim.controlledRunId,
      };
    case 'already-claimed':
      return {
        ok: false,
        reason: 'delegation-already-claimed',
        childRunId: claim.childRunId,
      };
    case 'missing-child':
      return { ok: false, reason: 'child-missing', childRunId: claim.childRunId };
    case 'terminal-child':
      return { ok: false, reason: 'delegation-resolved', childRunId: claim.childRunId };
    case 'linkage-mismatch':
      return { ok: false, reason: 'linkage-mismatch', childRunId: claim.childRunId };
    case 'delegation-superseded':
      // Core is authoritative for this refusal, and on this path it is the only
      // thing that classifies liveness at all: a parent that had already moved
      // past the delegation, or that moved between the 3a re-read and the claim
      // transaction, is refused inside that transaction. Use the pipeline's
      // known child id — core omits it on the fresh-launch path, where the
      // child it would name is the one this claim just created.
      return { ok: false, reason: 'delegation-superseded', childRunId };
    case 'missing-parent':
      // Core refuses an unreadable parent with a typed result rather than
      // throwing; it maps onto the refusal 3a already emits for the same fact.
      return { ok: false, reason: 'parent-missing', parentRunId: claim.parentRunId };
    default: {
      const _exhaustive: never = claim;
      throw new Error(
        `Unhandled claimRunbook status: ${(_exhaustive as { status: string }).status}`,
      );
    }
  }
}

/**
 * Name the run a claim failure is about, for post-mortem diagnostic text.
 *
 * Most failures name the child; `parent-missing` has no child to name, so it
 * names the parent instead of interpolating `undefined` into the message.
 *
 * @param result - The claim failure being described.
 * @returns A run id with enough context to identify what failed.
 */
function describeClaimFailureTarget(result: Extract<ClaimChildResult, { ok: false }>): string {
  if (result.reason === 'parent-missing') return `(parent ${result.parentRunId} missing)`;
  if (result.reason === 'session-refused') return result.refusal.runId;
  return result.childRunId;
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
  if (result.reason === 'parent-missing') {
    // Carries no child or step: the parent is what is missing, and the envelope
    // for that fact takes only the parent run id.
    return { ok: false, reason: 'parent-missing', parentRunId: result.parentRunId };
  }
  if (result.reason === 'session-refused') {
    // The refusal already names its own run; parent/step context would add a
    // second, possibly different run id to a single-run fact.
    return result;
  }
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
  /** Branded claim id for subsequent `--claim-id` commands, when freshly minted. */
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
  readonly childRunId: RunId;
  readonly childRunbookPath: string;
  readonly parentRunId: RunId;
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

function emitClaimedSuccess(args: {
  readonly output: OutputEmitter;
  readonly truncatedToken: string;
  readonly claimId: ClaimId;
  readonly childRunId: RunId;
  readonly childRunbookPath: string;
  readonly parentRunId: RunId;
  readonly stepId: string;
  readonly parentStepAt: string | undefined;
  readonly loopResult: 'done' | 'stopped' | 'waiting';
}): Extract<ClaimResult, { ok: true }> {
  const payload = buildClaimedPayload(args);
  emitClaimedOutput(
    args.output,
    `Claimed ${args.truncatedToken} -> ${args.childRunbookPath}`,
    payload,
  );

  return {
    ok: true,
    childRunId: args.childRunId,
    claimId: args.claimId,
    parentRunId: args.parentRunId,
    stepId: args.stepId,
    loopResult: args.loopResult,
  };
}

/**
 * Claim a delegation token, reconstitute inherited context, and launch the child runbook.
 *
 * Algorithm (per design doc section 6.2):
 * 1. Validate token format (must be a canonical rdtk_ token)
 * 2. Scan all run states for matching token hash
 * 3. Re-load parent, check idempotency/cancellation, reconstitute context
 * 4. Prepare and launch child runbook
 * 5. Link the parent delegation to the child run inside core's claim transaction
 *
 * No lock spans any of it. Every refusal the steps above can produce is decided
 * inside the transaction that commits the fact it depends on, so a concurrent
 * claimer of the same token re-derives against the committed row and reports the
 * winner's outcome rather than overwriting it.
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
  if (!isDelegationToken(rawToken)) {
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

  // `stepId` is the DELEGATING step (`contextSnapshot.step`), not the parent's
  // cursor. Every `DelegationLinkage` built below carries it as `parentStep`,
  // and none may substitute the freshly-read `parentState.step` /
  // `freshParent.step`. `classifyDelegationLiveness` decides liveness by
  // comparing the parent cursor it reads inside the deciding transaction
  // against `linkage.parentStep`; sourcing that field from a read of the same
  // cursor makes the comparison self-fulfilling, so it could only ever fire on
  // the narrow window between the read and the commit — never on a cursor that
  // had already advanced before the claim began. The two values coincide
  // whenever the parent is still sitting on its delegating step, which is why
  // the difference is invisible outside the superseded case the latch exists
  // for. The same field is persisted onto the claim, so it also decides the
  // parent-side half in `RunbookStore.invalidateClosedDelegatedClaims`.
  //
  // This is now load-bearing rather than belt-and-braces: the CLI no longer
  // pre-classifies liveness of its own, so core's in-transaction
  // classification is the sole owner of the `delegation-superseded` refusal on
  // this path, and it can only be as correct as the linkage it is handed.
  const { parentState, stepId, substepId, delegation: _delegation } = scanResult;

  // 3a. Re-load parent state (freshness check)
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

  // Every linkage below takes its entry from the credential, never from a live
  // read of the parent's frame history (#738). The credential is stamped once
  // when the delegation is issued and survives frame re-entry, so it names the
  // entry the CHILD was stamped with; the parent's live entry names wherever
  // the cursor has since got to. Recomputing here made the two
  // indistinguishable and every downstream gate self-satisfying — the claim
  // minted authority for the current entry against a child stamped with the
  // issuance entry, and `grantAllows` then dropped that child's terminal report
  // in silence. Read from the row and core's liveness classifier can see the
  // disagreement.
  //
  // The re-derive loop in `deriveAndCommitInitialLink` needs this read for a
  // second, independent reason. The linkage is built here, once, and every one
  // of that loop's attempts is judged against it: `delegationParentEntryRefusal`
  // re-infers the entry from each freshly captured parent and compares it
  // against `linkage.parentEntry`. Sourcing that field from a live read would
  // pin the CLI's own observation of the same field as the value all eight
  // attempts compare against — the loop would re-read the parent every time and
  // never once check it against the entry the delegation was issued at. The
  // credential is that stamp, so each attempt's comparison is a real one.
  const issuedParentEntry = freshDelegation.credential.parentEntry;

  // The linkage every claim route below presents — replay (3c), orphan
  // adoption (3d), existing-claim reuse, and the fresh launch. One value, not
  // four copies of the same seven fields: `grantAllows` compares all of them at
  // the point of use, so a coordinate that drifts between two of these sites is
  // a claim that passes every gate on the way in and then silently refuses to
  // report (#738). Every input is `const` and nothing between here and the
  // launch mutates them.
  //
  // The frame key is the delegation's stored one, never the parent's current
  // frame: the parent may have advanced past the iteration that created the
  // delegation. `parentStep` is the delegation's own step (`stepId`), never
  // `freshParent.step`, for the reason recorded above the destructure — with no
  // CLI-side pre-classification left on this path, core's in-transaction
  // classifier is the sole owner of the supersession verdict, and it can only
  // be as correct as the coordinates it is handed.
  const delegationLinkage: DelegationLinkage = {
    kind: 'delegation',
    parentRunId: freshParent.id,
    parentStepId: substepId ?? stepId,
    tokenHash,
    parentStep: stepId,
    parentFrameKey: freshSubstep.frameKey,
    parentEntry: issuedParentEntry,
  };

  // 3b. Check for cancellation before replaying a linked child.
  if (freshDelegation.cancelledAt) {
    return {
      ok: false,
      reason: 'delegation-cancelled',
      parentRunId: freshParent.id,
      stepId: substepId ?? stepId,
      cancelledAt: freshDelegation.cancelledAt,
    };
  }

  // 3c. Refuse replay if already claimed
  if (freshDelegation.childRunId) {
    const claimResult = await claimChildForPipeline(
      ctx,
      freshDelegation.childRunId,
      delegationLinkage,
    );
    if (!claimResult.ok) {
      return claimResultToFailure(claimResult, freshParent.id, substepId ?? stepId);
    }
    return emitClaimedSuccess({
      output,
      truncatedToken,
      childRunId: claimResult.childRunId,
      claimId: claimResult.claimId,
      childRunbookPath: freshDelegation.childRunbookPath,
      parentRunId: freshParent.id,
      stepId: substepId ?? stepId,
      parentStepAt: freshDelegation.contextSnapshot.at,
      loopResult: 'waiting',
    });
  }

  // 3d. Orphan reconciliation: scan for child run with matching tokenHash
  const orphan = await scanner.findOrphanedChild(tokenHash);
  if (orphan) {
    const claimResult = await claimChildForPipeline(ctx, orphan.id, delegationLinkage, true);
    if (!claimResult.ok) {
      return claimResultToFailure(claimResult, freshParent.id, substepId ?? stepId);
    }
    const adoptedChildRunId = claimResult.childRunId;
    return emitClaimedSuccess({
      output,
      truncatedToken,
      childRunId: adoptedChildRunId,
      claimId: claimResult.claimId,
      childRunbookPath: freshDelegation.childRunbookPath,
      parentRunId: freshParent.id,
      stepId: substepId ?? stepId,
      parentStepAt: freshDelegation.contextSnapshot.at,
      loopResult: 'waiting',
    });
  }

  const existingClaim = await ctx.sessionService.findClaimForDelegation(delegationLinkage);
  if (existingClaim !== null) {
    const existingChild = await manager.load(existingClaim.controlledRunId);
    if (!existingChild) {
      return {
        ok: false,
        reason: 'child-missing',
        parentRunId: freshParent.id,
        stepId: substepId ?? stepId,
        childRunId: existingClaim.controlledRunId,
      };
    }
    if (existingChild.lifecycle === 'completed' || existingChild.lifecycle === 'stopped') {
      return {
        ok: false,
        reason: 'delegation-resolved',
        parentRunId: freshParent.id,
        stepId: substepId ?? stepId,
        childRunId: existingClaim.controlledRunId,
      };
    }
    const claimResult = await claimChildForPipeline(
      ctx,
      existingClaim.controlledRunId,
      delegationLinkage,
      true,
    );
    if (!claimResult.ok) {
      return claimResultToFailure(claimResult, freshParent.id, substepId ?? stepId);
    }
    return emitClaimedSuccess({
      output,
      truncatedToken,
      childRunId: claimResult.childRunId,
      claimId: claimResult.claimId,
      childRunbookPath: freshDelegation.childRunbookPath,
      parentRunId: freshParent.id,
      stepId: substepId ?? stepId,
      parentStepAt: freshDelegation.contextSnapshot.at,
      loopResult: 'waiting',
    });
  }

  // 3e. Reconstitute context vars from frozen snapshot
  const inheritedContextVars = reconstituteContextVars(freshDelegation.contextSnapshot);
  const inheritedUserVars = extractInheritedUserVars(freshDelegation.contextSnapshot);

  // 3f. Prepare child runbook from persisted source identity
  const childRunbookRef = freshDelegation.childRunbookRef;
  const childDisplayPath = freshDelegation.childRunbookPath;
  const childResolution = await resolveRunbookRef(cwd, childRunbookRef);
  if (!childResolution.ok) {
    if (childResolution.reason === 'plugin-context-missing') {
      return {
        ok: false,
        reason: 'prepare-failed',
        runbook: childDisplayPath,
        code: 'RUNBOOK_REF_RESOLUTION_ERROR',
        cause: `Plugin runbook context is unavailable for ${childRunbookRef.source}:${childRunbookRef.path}. Set CLAUDE_PLUGIN_ROOT or install the Rundown Claude Code plugin alongside the CLI.`,
        details: { runbook: childDisplayPath },
      };
    }
    return {
      ok: false,
      reason: 'prepare-failed',
      runbook: childDisplayPath,
      code: 'RUNBOOK_NOT_FOUND',
      cause: `Runbook not found: ${childRunbookRef.source}:${childRunbookRef.path}`,
      details: { runbook: childDisplayPath },
    };
  }
  const childResolved = childResolution.resolved;

  const prepResult = await prepareResolvedRunnableRunbook(
    {
      resolved: childResolved,
      runbookRef: childRunbookRef,
      displayName: childDisplayPath,
    },
    inputOpts,
    cwd,
    {
      inheritedContextVars,
      inheritedUserVars,
      iterationBinding: freshDelegation.contextSnapshot.iterationBinding,
    },
  );
  if (!prepResult.ok) {
    return {
      ok: false,
      reason: 'prepare-failed',
      runbook: childDisplayPath,
      code: prepResult.code,
      cause: prepResult.error,
      details: { ...prepResult.details, runbook: childDisplayPath },
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

  // 3g. Launch child runbook
  let capturedClaim: { readonly claimId: ClaimId; readonly childRunId: RunId } | undefined;
  let initialLinkCommitted = false;
  // Captures a write-side claim invariant violation in `afterInit` so we
  // can surface it as a structured launch-failed result instead of an
  // anonymous thrown Error. Should never trigger in practice — the child
  // was just created with the same delegationLinkage being validated.
  let invariantViolation: Extract<ClaimChildResult, { ok: false }> | undefined;

  const launchResult = await launchRunbook(ctx, prepResult.prepared, {
    runbookName: childDisplayPath,
    prompted: parentPrompted,
    parentLinkage: delegationLinkage,
    sessionActivation: { kind: 'none' },
    afterInit: async (childStateId) => {
      const claimResult = await claimChildForPipeline(ctx, childStateId, delegationLinkage, true);
      if (!claimResult.ok) {
        // Capture and bail; the outer block translates this into a typed
        // launch-failed envelope with CLAIM_INVARIANT_VIOLATED so
        // post-mortem from CLI output reveals the cause.
        invariantViolation = claimResult;
        throw new Error(
          `Claim invariant violated for fresh child ${describeClaimFailureTarget(claimResult)}: ${claimResult.reason}`,
        );
      }
      capturedClaim = { claimId: claimResult.claimId, childRunId: claimResult.childRunId };
      initialLinkCommitted = true;
    },
    afterInitRollback: async (childStateId) => {
      if (!initialLinkCommitted) return;
      capturedClaim = undefined;
      const warnUnlinkRefusal = (reason: string): void => {
        output.warning(
          `Could not unlink delegated child ${childStateId} from parent ${delegationLinkage.parentRunId}: ${reason}`,
        );
      };
      try {
        const captured = await manager.captureRunAuthorityState(delegationLinkage.parentRunId);
        if (captured.kind !== 'captured') {
          warnUnlinkRefusal(captured.message);
          return;
        }
        const prepared = await ctx.actorService.prepareDelegationChildUnlink(
          captured.state,
          getRunbookFromState(captured.state, ctx.cwd),
          childStateId,
          delegationLinkage,
        );
        if (prepared.kind !== 'prepared') {
          warnUnlinkRefusal(prepared.message);
          return;
        }
        const rollback = await ctx.sessionService.rollbackInitialLink({
          childRunId: childStateId,
          linkage: delegationLinkage,
          capturedParent: captured.authority,
          preparedParent: prepared.prepared,
        });
        if (rollback.kind !== 'committed') {
          warnUnlinkRefusal(rollback.message);
          return;
        }
        initialLinkCommitted = false;
      } catch (error: unknown) {
        warnUnlinkRefusal(getErrorMessage(error));
      }
    },
  });

  if (invariantViolation !== undefined) {
    // The durable latch (R2) is not an invariant violation — it is the ONLY
    // place a supersession is decided on this path. `claimRunbook` re-reads
    // the parent inside its own transaction and classifies liveness against
    // the linkage built above, so a parent that had already advanced, or that
    // advanced, terminalized, or reissued its token after the 3a re-read,
    // legitimately refuses here. Reporting that as CLAIM_INVARIANT_VIOLATED
    // blames Rundown for a real supersession and drops the no-retry signal
    // the bearer holder needs. The child created moments ago is removed by
    // launch cleanup; the atomic transaction wrote nothing.
    if (invariantViolation.reason === 'delegation-superseded') {
      return {
        ok: false,
        reason: 'delegation-superseded',
        parentRunId: freshParent.id,
        stepId: substepId ?? stepId,
        // No child is named, and none may be synthesized. This arm is reached
        // only from the fresh-launch `afterInit`, which 3c already guarantees
        // has `freshDelegation.childRunId === null` — the delegation names no
        // child, and the one this claim just created is about to be removed by
        // launch cleanup. The routes that DO have a child to name carry it
        // through `claimResultToFailure` instead.
      };
    }
    // Same reasoning for a parent deleted between the 3a re-read and the
    // claim transaction: a race, not a broken invariant. `claimResultToFailure`
    // already owns the mapping, and 3a emits this very refusal earlier for the
    // same fact — so the outcome must not change just because the race lost
    // later.
    //
    // `delegation-already-claimed` is the same class and the reason this arm
    // matters most: a second claimer of one token that got past 3c before the
    // winner committed lands here, and the fact it must report is the winner's
    // — the delegation is taken, permanently, by the child the refusal names.
    // Reporting CLAIM_INVARIANT_VIOLATED instead blamed Rundown for a race it
    // handled correctly, and named this claimer's own about-to-be-deleted
    // child.
    if (
      invariantViolation.reason === 'parent-missing' ||
      invariantViolation.reason === 'concurrent-modification' ||
      invariantViolation.reason === 'delegation-already-claimed'
    ) {
      return claimResultToFailure(invariantViolation, freshParent.id, substepId ?? stepId);
    }
    // An ownership refusal is likewise a race, not a broken invariant: the
    // claim transaction refused before writing anything.
    if (invariantViolation.reason === 'session-refused') {
      return invariantViolation;
    }
    return {
      ok: false,
      reason: 'launch-failed',
      runbook: childDisplayPath,
      code: ErrorCodes.CLAIM_INVARIANT_VIOLATED.code,
      cause: `Claim invariant violated for fresh child ${describeClaimFailureTarget(invariantViolation)}: ${invariantViolation.reason}`,
      details: {
        runbookName: childDisplayPath,
        runbook: childDisplayPath,
      },
    };
  }

  if (!launchResult.ok) {
    if (launchResult.reason === 'session-refused') return launchResult;
    return {
      ok: false,
      reason: 'launch-failed',
      runbook: childDisplayPath,
      code: launchResult.code,
      cause: launchResult.error,
      details: { ...launchResult.details, runbook: childDisplayPath },
    };
  }

  if (capturedClaim === undefined) {
    return {
      ok: false,
      reason: 'launch-failed',
      runbook: childDisplayPath,
      code: ErrorCodes.LAUNCH_FAILED.code,
      cause: 'Claim id was not created for delegated child.',
      details: {
        runbookName: childDisplayPath,
        runbook: childDisplayPath,
      },
    };
  }
  return emitClaimedSuccess({
    output,
    truncatedToken,
    childRunId: capturedClaim.childRunId,
    claimId: capturedClaim.claimId,
    childRunbookPath: childDisplayPath,
    parentRunId: freshParent.id,
    stepId: substepId ?? stepId,
    parentStepAt: freshDelegation.contextSnapshot.at,
    loopResult: launchResult.loopResult,
  });
}
