import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { OutputDeclaration } from '@rundown-org/parser';
import { isReservedTemplateName, NAMED_IDENTIFIER_PATTERN } from '@rundown-org/parser';
import { RUNDOWN_DIR, assertSafeId } from '../paths.js';
import { logger } from '../logger.js';

/**
 * Naked OUTPUTS entry — the name-only form that activates a file-backed
 * output channel. Distinct from the full {@link OutputDeclaration} so naked
 * vs expression intent is encoded in the type.
 */
export interface NakedOutput {
  /** Variable name to capture (must match `NAMED_IDENTIFIER_PATTERN`). */
  readonly name: string;
}

/**
 * Scope at which a captured output is collected.
 *
 * `substepId` and `iteration` are independent optional path tiers and compose
 * when both are present. The path layout matches the spec:
 *
 * - `{ stepId }` → `<stepId>/<VarName>`
 * - `{ stepId, substepId }` → `<stepId>/<substepId>/<VarName>`
 * - `{ stepId, iteration }` → `<stepId>/<iteration>/<VarName>`
 * - `{ stepId, substepId, iteration }` → `<stepId>/<substepId>/<iteration>/<VarName>`
 *
 * The four-segment form is used when a substep with naked OUTPUTS sits inside
 * a FOR loop — the iteration index preserves the per-iteration audit trail.
 */
export interface OutputScope {
  readonly stepId: string;
  readonly substepId?: string;
  readonly iteration?: number;
}

/**
 * Arguments for {@link prepareOutputChannels}.
 */
export interface PrepareOutputChannelsArgs {
  /** Project root directory. */
  readonly cwd: string;
  /** Validated run identifier (matches the `assertSafeId` rules in `paths.ts`). */
  readonly runId: string;
  /** Step + optional substep + optional iteration tiers. */
  readonly scope: OutputScope;
  /** Naked OUTPUTS entries from {@link partitionOutputDeclarations}. */
  readonly naked: readonly NakedOutput[];
}

function assertSafeOutputName(value: string): void {
  if (!NAMED_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid output name: ${JSON.stringify(value)}`);
  }
  if (isReservedTemplateName(value)) {
    throw new Error(`Invalid output name: ${JSON.stringify(value)} is a reserved variable name`);
  }
}

/**
 * Partition an OUTPUTS list into naked (file-backed) and expression entries.
 *
 * Order is preserved within each partition. Naked entries (no `value`) drive
 * `RD_OUTPUTS_*` env injection; expression entries flow through the existing
 * `evaluateStepOutputDeclarations` path unchanged.
 *
 * @param outputs - Parsed declarations from a step or substep
 * @returns Object with `naked` and `expression` arrays
 */
export function partitionOutputDeclarations(outputs: readonly OutputDeclaration[]): {
  readonly naked: readonly NakedOutput[];
  readonly expression: readonly OutputDeclaration[];
} {
  const naked: NakedOutput[] = [];
  const expression: OutputDeclaration[] = [];
  for (const decl of outputs) {
    if (decl.value === undefined) {
      naked.push({ name: decl.name });
    } else {
      expression.push(decl);
    }
  }
  return { naked, expression };
}

/**
 * Absolute path to the per-run outputs directory: `.rundown/runs/<runId>/outputs`.
 *
 * @param cwd - Project root
 * @param runId - Validated run identifier (matches the `assertSafeId` rules in `paths.ts`)
 * @returns Absolute directory path
 * @throws {Error} when `runId` is empty, `..`, or contains unsafe characters
 */
export function outputsDirForRun(cwd: string, runId: string): string {
  assertSafeId(runId, 'runId');
  return path.join(cwd, RUNDOWN_DIR, 'runs', runId, 'outputs');
}

/**
 * Assemble the absolute path of a single output channel file.
 *
 * Composes optional `substepId` and `iteration` tiers from the scope:
 * - bare step: `<outputsDir>/<stepId>/<varName>`
 * - substep only: `<outputsDir>/<stepId>/<substepId>/<varName>`
 * - iteration only: `<outputsDir>/<stepId>/<iteration>/<varName>`
 * - substep + iteration: `<outputsDir>/<stepId>/<substepId>/<iteration>/<varName>`
 *
 * @param cwd - Project root
 * @param runId - Validated run id
 * @param scope - Step + optional substep + optional iteration tiers
 * @param varName - Output variable name (`NAMED_IDENTIFIER_PATTERN`, non-reserved)
 * @returns Absolute file path
 * @throws {Error} when any segment fails its safety / identifier validation
 */
export function outputChannelPath(
  cwd: string,
  runId: string,
  scope: OutputScope,
  varName: string,
): string {
  assertSafeOutputName(varName);
  assertSafeId(scope.stepId, 'stepId');
  const base = outputsDirForRun(cwd, runId);
  const segments: string[] = [base, scope.stepId];
  if (scope.substepId !== undefined) {
    assertSafeId(scope.substepId, 'substepId');
    segments.push(scope.substepId);
  }
  if (scope.iteration !== undefined) {
    if (!Number.isInteger(scope.iteration) || scope.iteration <= 0) {
      throw new Error(`Invalid iteration index: ${String(scope.iteration)}`);
    }
    segments.push(String(scope.iteration));
  }
  segments.push(varName);
  return path.join(...segments);
}

/**
 * Build the `RD_OUTPUTS_*` env-var map for a set of naked outputs.
 *
 * Each entry maps `RD_OUTPUTS_<VarName>` → absolute file path. The caller is
 * responsible for actually creating the files (see `prepareOutputChannels`).
 *
 * @param cwd - Project root
 * @param runId - Validated run id
 * @param scope - Step + optional substep + optional iteration tiers
 * @param naked - Naked OUTPUTS entries from `partitionOutputDeclarations`
 * @returns Record suitable for merging into the rundown-injected env
 * @throws {Error} when a naked entry fails safety validation (propagated from
 *         {@link outputChannelPath})
 */
export function buildOutputChannelEnv(
  cwd: string,
  runId: string,
  scope: OutputScope,
  naked: readonly NakedOutput[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of naked) {
    env[`RD_OUTPUTS_${entry.name}`] = outputChannelPath(cwd, runId, scope, entry.name);
  }
  return env;
}

/**
 * Pre-create empty output-channel files and return the env-var map.
 *
 * Creates the directory tree and writes a zero-byte file per naked output.
 * Idempotent: existing files are truncated to zero bytes so a re-execution
 * doesn't carry forward stale captures from a prior attempt.
 *
 * Best-effort: per-file failures are logged and the entry is dropped from
 * the returned env so the shell sees no `RD_OUTPUTS_<X>` for an output we
 * couldn't actually back with a file.
 *
 * @param args - Project root + run id + scope + naked declarations
 * @returns The injectable env map and the absolute paths that were created
 */
export async function prepareOutputChannels(
  args: PrepareOutputChannelsArgs,
): Promise<{ readonly env: Record<string, string>; readonly createdPaths: readonly string[] }> {
  const env: Record<string, string> = {};
  const createdPaths: string[] = [];
  for (const entry of args.naked) {
    let filePath: string;
    try {
      filePath = outputChannelPath(args.cwd, args.runId, args.scope, entry.name);
    } catch (err) {
      void logger.warn('prepareOutputChannels: invalid output declaration, skipping', {
        name: entry.name,
        error: String(err),
      });
      continue;
    }
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // Truncate to zero bytes so re-runs do not see stale content.
      await fs.writeFile(filePath, '');
      env[`RD_OUTPUTS_${entry.name}`] = filePath;
      createdPaths.push(filePath);
    } catch (err) {
      void logger.warn('prepareOutputChannels: failed to create channel file, skipping', {
        name: entry.name,
        path: filePath,
        error: String(err),
      });
    }
  }
  return { env, createdPaths };
}

/**
 * Read captured outputs from previously-created channel files.
 *
 * UTF-8 only, trailing whitespace and newlines trimmed. Files that are
 * missing, empty after trim, non-UTF-8, or unreadable are logged and omitted
 * from the result. The caller decides what to do with the returned record;
 * the spec mandates merging into `context.variables` via `SET_VARIABLES`.
 *
 * @param createdPaths - Absolute paths returned by `prepareOutputChannels`
 * @param naked - The naked declarations whose names map 1:1 to `createdPaths`
 * @returns Record `{ <VarName>: <trimmedValue> }` for every successful read
 */
export async function readCapturedOutputs(
  createdPaths: readonly string[],
  naked: readonly NakedOutput[],
): Promise<Record<string, string>> {
  if (createdPaths.length !== naked.length) {
    // prepareOutputChannels guarantees pairwise correspondence; a mismatch
    // means a caller composed paths and naked from different sources.
    throw new Error(
      `readCapturedOutputs: paths length (${createdPaths.length}) does not match naked length (${naked.length})`,
    );
  }
  const captured: Record<string, string> = {};
  for (let i = 0; i < createdPaths.length; i++) {
    const filePath = createdPaths[i];
    const name = naked[i].name;
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        void logger.warn('readCapturedOutputs: channel file missing', { name, path: filePath });
      } else {
        void logger.warn('readCapturedOutputs: read failed', {
          name,
          path: filePath,
          error: String(err),
        });
      }
      continue;
    }
    if (raw.includes('\0')) {
      // NUL byte → treat as non-UTF-8 per spec
      void logger.warn('readCapturedOutputs: non-UTF-8 content, omitting', {
        name,
        path: filePath,
      });
      continue;
    }
    // Trim trailing whitespace + newlines (`\s` covers space, tab, \r, \n, etc.)
    const trimmed = raw.replace(/\s+$/u, '');
    if (trimmed.length === 0) {
      void logger.warn('readCapturedOutputs: empty value, omitting', { name, path: filePath });
      continue;
    }
    captured[name] = trimmed;
  }
  return captured;
}
