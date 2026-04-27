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
 * A single output channel that was successfully pre-created.
 *
 * Used as the input to {@link readCapturedOutputs}. The pairing of `name` to
 * `path` is established by {@link prepareOutputChannels}, removing the need
 * for the caller to track parallel arrays.
 */
export interface PreparedChannel {
  /** Stable output name, used to map the channel back to a runbook variable. */
  readonly name: string;
  /** Absolute file path for the channel, e.g. `.rundown/runs/<id>/outputs/<step>/<VarName>`. */
  readonly path: string;
}

/**
 * Scope at which a captured output is collected.
 *
 * Three valid tier compositions:
 * - `{ stepId }` → `<stepId>/<VarName>`
 * - `{ stepId, substep: { id } }` → `<stepId>/<substepId>/<VarName>`
 * - `{ stepId, substep: { id, iteration } }` → `<stepId>/<substepId>/<iteration>/<VarName>`
 *
 * By construction, iteration cannot appear without a substep tier — the
 * impossible `<stepId>/<iteration>/<VarName>` shape is unrepresentable.
 * FOR loops always execute their commands inside substeps, so nesting
 * `iteration` inside `substep` is the correct structural encoding.
 */
export interface OutputScope {
  /** Owning step identifier, such as `1` or `Cleanup`. */
  readonly stepId: string;
  /** Optional nested substep scope. */
  readonly substep?: {
    /** Substep identifier, such as `1` or `Validate`. */
    readonly id: string;
    /** Optional FOR-loop iteration index for the nested substep. */
    readonly iteration?: number;
  };
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
 * Composes optional `substep` and `iteration` tiers from the scope:
 * - bare step: `<outputsDir>/<stepId>/<varName>`
 * - substep only: `<outputsDir>/<stepId>/<substepId>/<varName>`
 * - substep + iteration: `<outputsDir>/<stepId>/<substepId>/<iteration>/<varName>`
 *
 * @param cwd - Project root
 * @param runId - Validated run id
 * @param scope - Step + optional substep (with optional iteration) tiers
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
  if (scope.substep !== undefined) {
    assertSafeId(scope.substep.id, 'substepId');
    segments.push(scope.substep.id);
    if (scope.substep.iteration !== undefined) {
      if (!Number.isInteger(scope.substep.iteration) || scope.substep.iteration <= 0) {
        throw new Error(`Invalid iteration index: ${String(scope.substep.iteration)}`);
      }
      segments.push(String(scope.substep.iteration));
    }
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
 * @param scope - Step + optional substep (with optional iteration) tiers
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
 * @returns The injectable env map and the list of successfully-prepared channels (each carrying its name and absolute path)
 */
export async function prepareOutputChannels(args: PrepareOutputChannelsArgs): Promise<{
  readonly env: Record<string, string>;
  readonly prepared: readonly PreparedChannel[];
}> {
  const env: Record<string, string> = {};
  const prepared: PreparedChannel[] = [];
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
      prepared.push({ name: entry.name, path: filePath });
    } catch (err) {
      void logger.warn('prepareOutputChannels: failed to create channel file, skipping', {
        name: entry.name,
        path: filePath,
        error: String(err),
      });
    }
  }
  return { env, prepared };
}

/**
 * Read captured outputs from previously-created channel files.
 *
 * UTF-8 only, trailing whitespace and newlines trimmed. Files that are
 * missing, empty after trim, non-UTF-8, or unreadable are logged and omitted
 * from the result. The caller decides what to do with the returned record;
 * the spec mandates merging into `context.variables` via `SET_VARIABLES`.
 *
 * @param prepared - Channels returned by `prepareOutputChannels`, each carrying its name and absolute path
 * @returns Record `{ <VarName>: <trimmedValue> }` for every successful read
 */
export async function readCapturedOutputs(
  prepared: readonly PreparedChannel[],
): Promise<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const channel of prepared) {
    const { name, path: filePath } = channel;
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
