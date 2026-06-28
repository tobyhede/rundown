import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  BUILTIN_TEMPLATE_HELPER_NAME_SET,
  RESERVED_TEMPLATE_NAMES as PARSER_RESERVED_TEMPLATE_NAMES,
  isReservedTemplateName,
  type Runbook,
  type ResolvedRunbook,
  type RunbookFrontmatter,
  type ValidationDiagnostic,
} from '@rundown-org/parser';
import { CONFIG_FILE, WORK_DIR } from '../paths.js';
import { getErrorMessage } from '../errors.js';
import type { PolicyEvaluator, PolicyPrompter } from '../policy/index.js';
import { TemplateVarValueSchema } from '../schemas.js';
import {
  parseJsonArtifactUriArrayTransport,
  readExactArtifactRecordArrayFromManifest,
  readExactArtifactRecordFromManifest,
} from './artifact-inputs.js';
import {
  isTrustedArtifactValue,
  mergeEffectiveVars,
  type RoutedVariableValue,
  type TrustedArtifactValue,
  type VariableValue,
} from './effective-vars.js';
import type { TemplateHelperRegistry } from './helper-invoke.js';
import type { RunId } from './run-id.js';
import type { RunbookRef } from './runbook-ref.js';
import { surfaceIterationBinding } from './delegation-context.js';
import { buildContextVars, validateForVariables } from './runtime-frame.js';
import {
  collectUnresolvedRunbookVariables,
  resolveForBounds,
  substituteRunbookVariables,
} from './template-renderer.js';
import {
  createJsonArrayStream,
  isJsonValue,
  type IterationBinding,
  type JsonArray,
  type JsonObject,
  type TemplateVarValue,
} from './types.js';

/**
 * Names reserved for built-in render helpers, used to detect variable-name
 * collisions. Parser owns the names; core owns their behavior.
 */
export const RESERVED_TEMPLATE_HELPER_NAMES: ReadonlySet<string> = BUILTIN_TEMPLATE_HELPER_NAME_SET;

/**
 * Detect template variables whose names collide with registered helpers.
 *
 * @param registry - Helper registry to compare against variable names
 * @param variables - Template variables supplied by the caller
 * @returns Variable names shadowed by helper names
 */
export function detectTemplateHelperCollisions(
  registry: TemplateHelperRegistry,
  variables: Readonly<Record<string, unknown>>,
): string[] {
  const collisions: string[] = [];
  for (const name of registry.keys()) {
    if (Object.hasOwn(variables, name)) {
      collisions.push(name);
    }
  }
  return collisions;
}

export const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const POISONED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check whether a variable name is syntactically valid and safe.
 *
 * @param key - Candidate variable name
 * @returns True when the key can be accepted as a template variable
 */
export function isValidVariableName(key: string): boolean {
  return VALID_IDENTIFIER.test(key) && !POISONED_KEYS.has(key);
}

export const RUNTIME_RESERVED_VARIABLES = PARSER_RESERVED_TEMPLATE_NAMES;

/**
 * Check whether a variable name is reserved for runtime use.
 *
 * @param name - Candidate variable name
 * @returns True when the name is reserved by the parser/runtime
 */
export function isRuntimeReservedVariable(name: string): boolean {
  return isReservedTemplateName(name);
}

/**
 * Resolved variables plus warnings and externally provided key tracking.
 *
 * `vars` is `RoutedVariableValue` (not `VariableValue`) because the routing
 * layer that produces this struct does not enforce artifact trust — that
 * happens at the next seam, `partitionVariables`, via a runtime brand check.
 * Forged artifact-shaped values can legitimately appear here; the type
 * signature is honest about that. After partitioning the surviving artifact
 * values carry the runtime brand and are declared as `TrustedArtifactValue`.
 */
export interface ResolvedVariables {
  readonly vars: Readonly<Record<string, RoutedVariableValue>>;
  readonly warnings: readonly string[];
  readonly providedKeys: ReadonlySet<string>;
}

/** Policy hooks used while routing file-backed variable sources. */
export interface VariableSecurityContext {
  readonly evaluator?: PolicyEvaluator;
  readonly prompter?: PolicyPrompter;
}

/** Error thrown when policy blocks a file-backed variable source. */
export class FileSourcePolicyError extends Error {
  readonly code = 'POLICY_DENIED';
  readonly variable: string;
  readonly filePath: string;
  readonly reason: string;

  /**
   * Create a file-source policy error.
   *
   * @param variable - Variable whose file source was denied
   * @param filePath - Canonical path that was denied
   * @param reason - Policy reason for denial
   */
  constructor(variable: string, filePath: string, reason: string) {
    super(`File source "${variable}" blocked by policy: ${reason}`);
    this.name = 'FileSourcePolicyError';
    this.variable = variable;
    this.filePath = filePath;
    this.reason = reason;
  }
}

export const BUILTIN_VARIABLES = {
  Date: 'Date',
  DateTime: 'DateTime',
  Year: 'Year',
  Month: 'Month',
  Day: 'Day',
  Branch: 'Branch',
  WorkPath: 'WorkPath',
  RunId: 'RunId',
  RunbookRef: 'RunbookRef',
  ContextId: 'ContextId',
} as const;

/** Inputs used to create deterministic built-in template variables. */
export interface CreateBuiltinVariablesInput {
  readonly now?: Date;
  readonly branch?: string | null;
  readonly contextId?: string;
}

/**
 * Create built-in template variables from supplied process facts.
 *
 * @param input - Optional process facts used for deterministic output
 * @returns Built-in template variables
 */
export function createBuiltinVariables(
  input: CreateBuiltinVariablesInput = {},
): Record<string, string> {
  const now = input.now ?? new Date();
  return {
    Date: now.toISOString().slice(0, 10),
    DateTime: now.toISOString(),
    Year: String(now.getUTCFullYear()),
    Month: String(now.getUTCMonth() + 1).padStart(2, '0'),
    Day: String(now.getUTCDate()).padStart(2, '0'),
    Branch: input.branch ?? '',
    WorkPath: WORK_DIR,
    ContextId: input.contextId ?? randomBytes(4).toString('hex'),
  };
}

async function loadJsonFile(canonical: string): Promise<JsonObject | JsonArray> {
  const content = await fs.readFile(canonical, 'utf-8');
  const parsed: unknown = JSON.parse(content);
  if (!isJsonValue(parsed) || parsed === null || typeof parsed !== 'object') {
    throw new Error(`File "${canonical}" contains ${typeof parsed}, expected JSON object or array`);
  }
  return parsed;
}

async function resolveProjectRoot(cwd: string): Promise<string> {
  let projectRoot = path.resolve(cwd);
  try {
    projectRoot = await fs.realpath(projectRoot);
  } catch {
    // cwd doesn't exist? — use resolved path
  }
  return projectRoot;
}

async function enforceFileSourcePolicy(
  key: string,
  canonicalPath: string,
  security?: VariableSecurityContext,
): Promise<void> {
  if (!security?.evaluator) {
    return;
  }

  const decision = security.evaluator.checkPath(canonicalPath, 'read');
  if (decision.allowed) {
    return;
  }

  if (decision.requiresPrompt && security.prompter) {
    const prompt = await security.prompter.requestPermission(
      'read',
      canonicalPath,
      decision.reason,
    );
    if (prompt.granted) {
      return;
    }
    throw new FileSourcePolicyError(key, canonicalPath, 'User denied permission');
  }

  throw new FileSourcePolicyError(key, canonicalPath, decision.reason);
}

type RouteVariableResult = 'ignored' | 'routed';

interface ArtifactInputContext {
  readonly cwd: string;
}

interface RouteVariableInput {
  readonly key: string;
  readonly value: unknown;
  // RoutedVariableValue, not VariableValue: post-routing values include both
  // trusted (manifest-resolved, branded) and untrusted (forged JSON, plain
  // artifact-shaped literals) artifact arms. partitionVariables converts to
  // Record<string, VariableValue> after the brand check.
  readonly vars: Record<string, RoutedVariableValue>;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly security?: VariableSecurityContext;
  readonly warnings?: string[];
  /** Boundary channel of the layer this value came from. */
  readonly channel: BoundaryChannel;
}

function isArtifactRecordUriReference(value: unknown): value is { readonly uri: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'artifact-record' && typeof record.uri === 'string';
}

async function resolveArtifactInputValue(
  value: unknown,
  context: ArtifactInputContext,
): Promise<TrustedArtifactValue | null> {
  if (isArtifactRecordUriReference(value)) {
    const artifact = await readExactArtifactRecordFromManifest(value.uri, {
      cwd: context.cwd,
      workPath: WORK_DIR,
    });
    if (artifact !== null) {
      return artifact;
    }
  }

  if (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecordUriReference)) {
    const artifacts = await readExactArtifactRecordArrayFromManifest(
      value.map((entry) => entry.uri),
      {
        cwd: context.cwd,
        workPath: WORK_DIR,
      },
    );
    if (artifacts !== null) {
      return artifacts;
    }
  }

  if (typeof value === 'string' && value.startsWith('rd://artifacts/')) {
    const artifact = await readExactArtifactRecordFromManifest(value, {
      cwd: context.cwd,
      workPath: WORK_DIR,
    });
    if (artifact !== null) {
      return artifact;
    }
  }

  if (typeof value === 'string') {
    const uriArray = parseJsonArtifactUriArrayTransport(value);
    if (uriArray !== null) {
      const artifacts = await readExactArtifactRecordArrayFromManifest(uriArray, {
        cwd: context.cwd,
        workPath: WORK_DIR,
      });
      if (artifacts !== null) {
        return artifacts;
      }
    }
  }

  return null;
}

async function routeVariable(input: RouteVariableInput): Promise<RouteVariableResult> {
  const { key, value, vars, cwd, projectRoot, security, warnings, channel } = input;

  // Artifact channel, scalar/object form. Arrays must fall through to the array
  // branch below: resolveArtifactInputValue returns null for a JS array of URI
  // strings (it only handles scalars and arrays of {kind,uri} objects), so an
  // unguarded throw here would reject valid --artifacts-json values before they
  // reach the array reader.
  if (channel === 'artifact' && !Array.isArray(value)) {
    const artifact = await resolveArtifactInputValue(value, { cwd });
    if (artifact === null) {
      throw new Error(
        `Artifact input "${key}" did not resolve to an existing manifest row. ` +
          `The artifact channel requires an rd://artifacts/... URI (or a JSON array of such URIs); ` +
          `received: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
      );
    }
    vars[key] = artifact;
    return 'routed';
  }

  if (typeof value === 'string' && value.startsWith('file:')) {
    const rawPath = value.slice(5);
    const resolved = path.resolve(cwd, rawPath);

    let canonical = resolved;
    try {
      canonical = await fs.realpath(resolved);
    } catch {
      // File doesn't exist yet — use resolved path for validation.
    }

    const rel = path.relative(projectRoot, canonical);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      warnings?.push(`Ignoring file source "${key}" — path escapes project directory`);
      return 'ignored';
    }

    await enforceFileSourcePolicy(key, canonical, security);

    if (canonical.endsWith('.jsonl')) {
      vars[key] = createJsonArrayStream(canonical);
    } else if (canonical.endsWith('.json')) {
      vars[key] = await loadJsonFile(canonical);
    } else {
      throw new Error(
        `Unsupported file extension for variable "${key}": ${path.extname(canonical) || '(none)'}. ` +
          'Supported: .json, .jsonl',
      );
    }

    return 'routed';
  }

  if (Array.isArray(value)) {
    if (channel === 'artifact') {
      const allStrings =
        value.length > 0 && value.every((entry): entry is string => typeof entry === 'string');
      const artifacts = allStrings
        ? await readExactArtifactRecordArrayFromManifest(value, { cwd, workPath: WORK_DIR })
        : null;
      if (artifacts === null) {
        throw new Error(
          `Artifact input "${key}" did not resolve to existing manifest rows. ` +
            `Every entry must be an rd://artifacts/... URI; received: ${JSON.stringify(value)}`,
        );
      }
      vars[key] = artifacts;
      return 'routed';
    }

    if (value.every(isJsonValue)) {
      vars[key] = value;
    } else {
      warnings?.push(
        `Variable "${key}" array contains non-JSON values; converting items to strings`,
      );
      vars[key] = value.map(String);
    }
    return 'routed';
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (isJsonValue(value)) {
      vars[key] = value;
    } else {
      warnings?.push(`Variable "${key}" contains non-JSON values; converting to string`);
      vars[key] = JSON.stringify(value);
    }
    return 'routed';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      warnings?.push(
        `Variable "${key}" has non-finite numeric value (${String(value)}); converting to string`,
      );
      vars[key] = String(value);
    } else {
      vars[key] = value;
    }
    return 'routed';
  }

  vars[key] = String(value);
  return 'routed';
}

/**
 * Boundary channel through which a variable layer's values were supplied.
 *
 * `'variable'` values route as plain typed values; `'artifact'` values are
 * rehydrated from existing manifest rows into branded `TrustedArtifactValue`s
 * and must resolve or hard-fail. The channel is an explicit discriminant — the
 * artifact-vs-variable boundary is never inferred from a value's shape.
 */
export type BoundaryChannel = 'variable' | 'artifact';

/** Source category for a variable layer. */
export type VariableLayerKind =
  | 'builtins'
  | 'frontend-defaults'
  | 'config'
  | 'inherited'
  | 'env'
  | 'cli'
  | 'artifact-cli';

/**
 * One precedence layer of variable values, discriminated by boundary channel.
 *
 * `kind` encodes precedence/provenance; `channel` drives routing. The union
 * ties them so an illegal combination (e.g. `{ kind: 'cli', channel: 'artifact' }`)
 * is unrepresentable.
 */
export type VariableLayer =
  | {
      readonly kind: 'builtins' | 'frontend-defaults' | 'config' | 'inherited' | 'env' | 'cli';
      readonly channel: 'variable';
      readonly values: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'artifact-cli';
      readonly channel: 'artifact';
      readonly values: Readonly<Record<string, unknown>>;
    };

/** Options for resolving layered variables. */
export interface ResolveVariableLayersOptions {
  readonly cwd: string;
  readonly security?: VariableSecurityContext;
}

const EXTERNAL_PROVIDER_KINDS = new Set<VariableLayerKind>([
  'config',
  'inherited',
  'env',
  'cli',
  'artifact-cli',
]);

/**
 * Resolve variable layers with Rundown precedence and file-source routing.
 *
 * @param layers - Ordered variable layers, from lowest to highest precedence
 * @param options - Project and policy context for routing file sources
 * @returns Resolved variables, warnings, and externally provided keys
 * @throws {Error} if a reserved runtime variable is overridden
 * @throws {FileSourcePolicyError} if policy denies a file-backed source
 */
export async function resolveVariableLayers(
  layers: readonly VariableLayer[],
  options: ResolveVariableLayersOptions,
): Promise<ResolvedVariables> {
  // RoutedVariableValue, not VariableValue: post-routing values include
  // unbranded artifact-shaped JSON arriving via every layer kind (cli,
  // config, env, inherited). Trust is enforced at the partitioning seam
  // via the runtime brand guard, NOT at routing.
  const vars: Record<string, RoutedVariableValue> = {};
  const warnings: string[] = [];
  const providedKeys = new Set<string>();
  const projectRoot = await resolveProjectRoot(options.cwd);

  for (const layer of layers) {
    const entries = Object.entries(layer.values);
    if (layer.kind !== 'builtins') {
      const reservedViolations = entries
        .map(([key]) => key)
        .filter((key) => isValidVariableName(key) && isRuntimeReservedVariable(key));
      if (reservedViolations.length > 0) {
        const keys = reservedViolations.map((key) => `"${key}"`).join(', ');
        throw new Error(
          `Reserved runtime variable${reservedViolations.length > 1 ? 's' : ''} ${keys} cannot be overridden. ` +
            `Reserved names (case-insensitive): ${[...RUNTIME_RESERVED_VARIABLES].join(', ')}`,
        );
      }
    }

    for (const [key, value] of entries) {
      if (!isValidVariableName(key)) {
        warnings.push(`Ignoring variable with invalid key: ${key}`);
        continue;
      }
      const routeResult = await routeVariable({
        key,
        value,
        vars,
        cwd: options.cwd,
        projectRoot,
        security: options.security,
        warnings,
        channel: layer.channel,
      });
      if (EXTERNAL_PROVIDER_KINDS.has(layer.kind) && routeResult !== 'ignored') {
        providedKeys.add(key);
      }
    }
  }

  return { vars, warnings, providedKeys };
}

/**
 * Route ad hoc variables through the same typed value conversion as layers.
 *
 * @param rawVars - Raw variables to route
 * @param cwd - Project directory used to bound file sources
 * @param security - Optional policy hooks for file reads
 * @returns Routed variables and non-fatal warnings
 * @throws {FileSourcePolicyError} if policy denies a file-backed source
 */
export async function routeExtraVars(
  rawVars: Readonly<Record<string, unknown>>,
  cwd: string,
  security?: VariableSecurityContext,
): Promise<{
  vars: Record<string, TemplateVarValue>;
  warnings: string[];
}> {
  const vars: Record<string, TemplateVarValue> = {};
  const warnings: string[] = [];
  const projectRoot = await resolveProjectRoot(cwd);

  for (const [key, value] of Object.entries(rawVars)) {
    if (!isValidVariableName(key)) {
      warnings.push(`Ignoring variable with invalid key: ${key}`);
      continue;
    }
    if (isRuntimeReservedVariable(key)) {
      warnings.push(
        `Ignoring reserved runtime variable "${key}". ` +
          `Reserved names (case-insensitive): ${[...RUNTIME_RESERVED_VARIABLES].join(', ')}`,
      );
      continue;
    }
    await routeVariable({
      key,
      value,
      vars,
      cwd,
      projectRoot,
      security,
      warnings,
      channel: 'variable',
    });
  }

  return { vars, warnings };
}

export { CONFIG_FILE, WORK_DIR };

/** Variables separated by their persisted storage boundary. */
export interface VariablePartition {
  /** Values safe to persist under RunbookState.templateVars. */
  readonly templateVars: Record<string, TemplateVarValue>;
  /** Runtime values to persist under RunbookState.variables. */
  readonly runtimeVars: Record<string, VariableValue>;
}

/** Reserved for future per-call partitioning options. */
export interface PartitionVariablesOptions {
  readonly _reserved?: never;
}

/**
 * Partition mixed logical variables into render-safe and runtime buckets.
 *
 * @param vars - Mixed variable map from input resolution or inheritance
 * @param _options - Reserved for future per-call options
 * @returns Template-safe values and runtime artifact values
 * @throws {Error} When a variable contains an untrusted artifact-shaped value
 */
export function partitionVariables(
  vars: Readonly<Record<string, RoutedVariableValue>>,
  _options: PartitionVariablesOptions = {},
): VariablePartition {
  const templateVars: Record<string, TemplateVarValue> = {};
  const runtimeVars: Record<string, VariableValue> = {};

  for (const [key, value] of Object.entries(vars)) {
    if (isTrustedArtifactValue(value)) {
      runtimeVars[key] = value;
      continue;
    }
    if (isArtifactValueShape(value)) {
      throw new Error(
        `Artifact record input for "${key}" is not trusted. Pass an artifact URI so Rundown can resolve it.`,
      );
    }
    // Keep this validation at the persistence boundary even though routed
    // inputs are typed earlier: prepare paths may also receive inherited state
    // or test-built maps, and templateVars must remain JSON-renderable.
    templateVars[key] = TemplateVarValueSchema.parse(value);
  }

  return { templateVars, runtimeVars };
}

/**
 * Structural check for artifact-shaped values used to reject forged records
 * that lack the trusted-artifact brand at the partitioning boundary.
 *
 * @param value - Candidate value to inspect for artifact-record structure
 * @returns True when the value is an artifact record or a non-empty array of
 * artifact records
 */
function isArtifactValueShape(value: unknown): boolean {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ((value as { readonly kind?: unknown }).kind === 'artifact-record' ||
      (value as { readonly kind?: unknown }).kind === 'file-artifact-record')
  ) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        ((entry as { readonly kind?: unknown }).kind === 'artifact-record' ||
          (entry as { readonly kind?: unknown }).kind === 'file-artifact-record'),
    )
  );
}

/** Template variables for a parsed runbook that is not yet runnable. */
export type PreparedTemplateVariables = Record<string, TemplateVarValue> & {
  readonly RunbookRef: RunbookRef;
};

/** Template variables for a runnable runbook instance. */
export type RunnableTemplateVariables = PreparedTemplateVariables & {
  readonly RunId: RunId;
};

/** Identity mode for parsed runbook preparation. */
export type PrepareParsedRunbookIdentity =
  | { readonly kind: 'prepared' }
  | { readonly kind: 'runnable'; readonly runId: RunId };

/** Inputs required to prepare a parsed runbook for execution or inspection. */
export interface PrepareParsedRunbookInput {
  readonly rawRunbook: Runbook;
  readonly frontmatter: RunbookFrontmatter | null;
  readonly diagnostics: readonly ValidationDiagnostic[];
  readonly cwd: string;
  readonly templateVars: Readonly<Record<string, TemplateVarValue>>;
  readonly runtimeVars?: Readonly<Record<string, VariableValue>>;
  readonly providedKeys: ReadonlySet<string>;
  readonly inheritedUserVars?: Readonly<Record<string, TemplateVarValue>>;
  readonly inheritedContextVars?: Readonly<Record<string, TemplateVarValue>>;
  /**
   * Typed FOR iteration binding inherited from the delegating parent
   * (language spec §10.4). Surfaced into the inherited-user-var layer gated on
   * this runbook's declared `inputs`; ranks below explicit `--input`.
   */
  readonly iterationBinding?: IterationBinding;
  readonly runbookRef: RunbookRef;
  readonly helperRegistry: TemplateHelperRegistry;
  readonly identity: PrepareParsedRunbookIdentity;
}

/** Result of parsed runbook preparation. */
export type PrepareParsedRunbookResult =
  | {
      readonly ok: true;
      readonly runbook: ResolvedRunbook;
      readonly templateVars: PreparedTemplateVariables | RunnableTemplateVariables;
      readonly runtimeVars: Readonly<Record<string, VariableValue>>;
      readonly warnings: readonly string[];
      readonly unresolved: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: 'VALIDATION_ERROR';
      readonly details: Readonly<Record<string, never>>;
      readonly templateVars: Readonly<Record<string, TemplateVarValue>>;
      readonly warnings: readonly string[];
      readonly diagnostics: readonly ValidationDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: 'MISSING_REQUIRED_VARS';
      readonly details: {
        readonly missing: readonly string[];
      };
      readonly templateVars: Readonly<Record<string, TemplateVarValue>>;
      readonly warnings: readonly string[];
      readonly diagnostics: readonly ValidationDiagnostic[];
    };

/**
 * Merge local and inherited variables and expose `context.vars.*` aliases.
 *
 * @param localVars - Variables collected for the current runbook
 * @param options - Optional inherited variable maps from parent context
 * @param options.inheritedUserVars - User variables inherited from a parent runbook
 * @param options.inheritedContextVars - Context aliases inherited from a parent runbook
 * @returns Complete template variable map for runbook preparation
 */
export function buildTemplateVars(
  localVars: Readonly<Record<string, TemplateVarValue>>,
  options?: {
    inheritedUserVars?: Readonly<Record<string, TemplateVarValue>>;
    inheritedContextVars?: Readonly<Record<string, TemplateVarValue>>;
  },
): Record<string, TemplateVarValue> {
  const effectiveUserVars: Record<string, TemplateVarValue> = {
    ...(options?.inheritedUserVars ?? {}),
    ...localVars,
  };
  return {
    ...effectiveUserVars,
    ...buildContextVars(effectiveUserVars),
    ...(options?.inheritedContextVars ?? {}),
  };
}

/**
 * Attach runbook reference metadata to prepared template variables.
 *
 * @param variables - Base template variables
 * @param runbookRef - Reference of the runbook being prepared
 * @returns Prepared template variable map
 */
export function withPreparedVariables(
  variables: Readonly<Record<string, TemplateVarValue>>,
  runbookRef: RunbookRef,
): PreparedTemplateVariables {
  return { ...variables, RunbookRef: runbookRef };
}

/**
 * Attach run identity metadata to prepared template variables.
 *
 * @param variables - Prepared template variables
 * @param runId - Run identifier for the runnable instance
 * @returns Runnable template variable map
 */
export function withRunnableVariables(
  variables: PreparedTemplateVariables,
  runId: RunId,
): RunnableTemplateVariables {
  return { ...variables, RunId: runId };
}

/**
 * Prepare a parsed runbook with variable validation and AST substitution.
 *
 * @param input - Parsed runbook, variables, helper registry, and identity mode
 * @returns Prepared runbook or structured preparation failure
 */
export function prepareParsedRunbook(input: PrepareParsedRunbookInput): PrepareParsedRunbookResult {
  const warnings: string[] = [];
  const runtimeVars = input.runtimeVars ?? {};
  // The surfaced iteration binding overlays inherited parent vars of the same
  // name (mirroring parent render semantics, where the loop var overlays) but
  // still ranks below explicit `--input` (`input.templateVars`), which layers
  // on top in both merge paths below.
  const surfacedIterationVars = surfaceIterationBinding(
    input.iterationBinding,
    input.frontmatter?.inputs,
  );
  const inheritedUserVars: Readonly<Record<string, TemplateVarValue>> = {
    ...(input.inheritedUserVars ?? {}),
    ...surfacedIterationVars,
  };
  // A surfaced binding is a provided value (inherited from the parent's active
  // iteration), so its names satisfy the child's `required` contract below —
  // the same way an explicit `--input` or a prior OUTPUTS would.
  const surfacedKeys = Object.keys(surfacedIterationVars);
  const providedKeys =
    surfacedKeys.length > 0
      ? new Set<string>([...input.providedKeys, ...surfacedKeys])
      : input.providedKeys;
  const baseTemplateVars = buildTemplateVars(input.templateVars, {
    inheritedUserVars,
    inheritedContextVars: input.inheritedContextVars,
  });
  const preparedTemplateVars = withPreparedVariables(baseTemplateVars, input.runbookRef);
  const templateVars =
    input.identity.kind === 'runnable'
      ? withRunnableVariables(preparedTemplateVars, input.identity.runId)
      : preparedTemplateVars;
  const contextId = templateVars.ContextId;
  const workPath = templateVars.WorkPath;
  if (typeof contextId !== 'string' || typeof workPath !== 'string') {
    return {
      ok: false,
      error: 'Template render context requires string ContextId and WorkPath',
      code: 'VALIDATION_ERROR',
      details: {},
      templateVars,
      warnings,
      diagnostics: input.diagnostics,
    };
  }
  const renderContext =
    input.identity.kind === 'runnable'
      ? {
          kind: 'runnable' as const,
          cwd: input.cwd,
          workPath,
          contextId,
          runId: input.identity.runId,
        }
      : {
          kind: 'prepared' as const,
          cwd: input.cwd,
          workPath,
          contextId,
        };
  const effectiveUserVars = mergeEffectiveVars<VariableValue>({
    templateVars: {
      ...inheritedUserVars,
      ...input.templateVars,
    },
    variables: runtimeVars,
  });
  const contextVars = buildContextVars(effectiveUserVars);
  const substitutionVars = mergeEffectiveVars<VariableValue>({
    templateVars: { ...templateVars, ...contextVars },
    variables: runtimeVars,
  });

  const earlyErrors = input.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (earlyErrors.length > 0) {
    return {
      ok: false,
      error: earlyErrors[0].message,
      code: 'VALIDATION_ERROR',
      details: {},
      templateVars,
      warnings,
      diagnostics: input.diagnostics,
    };
  }

  for (const name of detectTemplateHelperCollisions(input.helperRegistry, templateVars)) {
    warnings.push(
      `Variable "${name}" is shadowed by a registered helper. Use {{ ./${name} }} to access the variable.`,
    );
  }

  const requiredVars = input.frontmatter?.required;
  if (requiredVars && requiredVars.length > 0) {
    const missing = requiredVars.filter((name) => !providedKeys.has(name));
    if (missing.length > 0) {
      const names = missing.map((name) => `"${name}"`).join(', ');
      return {
        ok: false,
        error: `Missing required variable${missing.length > 1 ? 's' : ''}: ${names}. Provide via --input, --input-file, config.yaml, RD_INPUT_* environment variable, or prior runbook OUTPUTS.`,
        code: 'MISSING_REQUIRED_VARS',
        details: { missing },
        templateVars,
        warnings,
        diagnostics: input.diagnostics,
      };
    }
  }

  let resolvedRunbook: ResolvedRunbook;
  try {
    const result = resolveForBounds(input.rawRunbook, substitutionVars);
    resolvedRunbook = result.runbook;
    warnings.push(...result.warnings);
  } catch (error) {
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'VALIDATION_ERROR',
      details: {},
      templateVars,
      warnings,
      diagnostics: input.diagnostics,
    };
  }

  const runbook = substituteRunbookVariables(resolvedRunbook, substitutionVars, {
    helpers: input.helperRegistry,
    context: renderContext,
  });
  const unresolved = [...collectUnresolvedRunbookVariables(runbook)];

  try {
    validateForVariables(runbook.steps, substitutionVars);
  } catch (error) {
    return {
      ok: false,
      error: getErrorMessage(error),
      code: 'VALIDATION_ERROR',
      details: {},
      templateVars,
      warnings,
      diagnostics: input.diagnostics,
    };
  }

  if (runbook.steps.length === 0) {
    return {
      ok: false,
      error: 'Runbook has no steps',
      code: 'VALIDATION_ERROR',
      details: {},
      templateVars,
      warnings,
      diagnostics: input.diagnostics,
    };
  }

  return { ok: true, runbook, templateVars, runtimeVars, warnings, unresolved };
}
