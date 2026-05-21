import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
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
import type { TemplateHelperRegistry } from './helper-invoke.js';
import type { RunId } from './run-id.js';
import type { RunbookRef } from './runbook-ref.js';
import { buildContextVars, validateForVariables } from './runtime-frame.js';
import {
  collectUnresolvedRunbookVariables,
  resolveForBounds,
  substituteRunbookVariables,
} from './template-renderer.js';
import {
  createJsonArrayStream,
  isJsonValue,
  type JsonArray,
  type JsonObject,
  type TemplateVarValue,
} from './types.js';

export const RESERVED_TEMPLATE_HELPER_NAMES: ReadonlySet<string> = new Set([
  'artifact',
  'path',
  'validateSchema',
]);

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

/** Resolved variables plus warnings and externally provided key tracking. */
export interface ResolvedVariables {
  readonly vars: Readonly<Record<string, TemplateVarValue>>;
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

async function routeVariable(
  key: string,
  value: unknown,
  vars: Record<string, TemplateVarValue>,
  cwd: string,
  projectRoot: string,
  security?: VariableSecurityContext,
  warnings?: string[],
): Promise<boolean> {
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
      return false;
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

    return true;
  }

  if (Array.isArray(value)) {
    if (value.every(isJsonValue)) {
      vars[key] = value;
    } else {
      warnings?.push(
        `Variable "${key}" array contains non-JSON values; converting items to strings`,
      );
      vars[key] = value.map(String);
    }
    return true;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (isJsonValue(value)) {
      vars[key] = value;
    } else {
      warnings?.push(`Variable "${key}" contains non-JSON values; converting to string`);
      vars[key] = JSON.stringify(value);
    }
    return true;
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
    return true;
  }

  vars[key] = String(value);
  return true;
}

/** Source category for a variable layer. */
export type VariableLayerKind =
  | 'builtins'
  | 'frontend-defaults'
  | 'config'
  | 'inherited'
  | 'env'
  | 'cli';

/** One precedence layer of variable values. */
export interface VariableLayer {
  readonly kind: VariableLayerKind;
  readonly values: Readonly<Record<string, unknown>>;
}

/** Options for resolving layered variables. */
export interface ResolveVariableLayersOptions {
  readonly cwd: string;
  readonly security?: VariableSecurityContext;
}

const EXTERNAL_PROVIDER_KINDS = new Set<VariableLayerKind>(['config', 'inherited', 'env', 'cli']);

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
  const vars: Record<string, TemplateVarValue> = {};
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
      const accepted = await routeVariable(
        key,
        value,
        vars,
        options.cwd,
        projectRoot,
        options.security,
        warnings,
      );
      if (EXTERNAL_PROVIDER_KINDS.has(layer.kind) && accepted) {
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
    await routeVariable(key, value, vars, cwd, projectRoot, security, warnings);
  }

  return { vars, warnings };
}

export { CONFIG_FILE, WORK_DIR };

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
  readonly templateVars: Readonly<Record<string, TemplateVarValue>>;
  readonly providedKeys: ReadonlySet<string>;
  readonly inheritedUserVars?: Readonly<Record<string, TemplateVarValue>>;
  readonly inheritedContextVars?: Readonly<Record<string, TemplateVarValue>>;
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
  const baseTemplateVars = buildTemplateVars(input.templateVars, {
    inheritedUserVars: input.inheritedUserVars,
    inheritedContextVars: input.inheritedContextVars,
  });
  const preparedTemplateVars = withPreparedVariables(baseTemplateVars, input.runbookRef);
  const templateVars =
    input.identity.kind === 'runnable'
      ? withRunnableVariables(preparedTemplateVars, input.identity.runId)
      : preparedTemplateVars;

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
    const missing = requiredVars.filter((name) => !input.providedKeys.has(name));
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
    const result = resolveForBounds(input.rawRunbook, templateVars);
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

  const runbook = substituteRunbookVariables(resolvedRunbook, templateVars, {
    helpers: input.helperRegistry,
  });
  const unresolved = [...collectUnresolvedRunbookVariables(runbook)];

  try {
    validateForVariables(runbook.steps, templateVars);
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

  return { ok: true, runbook, templateVars, warnings, unresolved };
}
