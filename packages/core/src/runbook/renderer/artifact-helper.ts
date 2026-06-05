/**
 * Pure render-only projectors for ARTIFACTS variable values.
 *
 * The artifact directive resolver (`artifact-directive-resolver.ts`) is the
 * sole writer to the manifest. These projectors derive URI, path, and full
 * record renderings from already-resolved `ArtifactRecord` / `ArtifactRecord[]`
 * values without touching the filesystem. They do not append manifest rows,
 * create directories, create files, or mutate runbook state.
 *
 * @module
 */

import type { ArtifactRecord } from '../artifact-schema.js';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { artifactUriToPath, buildArtifactUri, type ArtifactPathOptions } from '../artifact-uri.js';
import type { RunId } from '../run-id.js';
import type { ArtifactVarValue } from '../types.js';

const PREPARED_LITERAL_PATH_VALIDATION_RUN_ID = 'rd_00000000000000000000000000000000';

/**
 * Narrowing helper for `ArtifactVarValue`. `Array.isArray` does not reliably
 * narrow `readonly T[]` unions in strict mode — see TypeScript issue #17002 —
 * so callers route through this guard to expose `value` as either
 * `ArtifactRecord` or `readonly ArtifactRecord[]` to the body.
 *
 * @param value - Artifact variable value to test
 * @returns `true` when the value is an `ArtifactRecord[]` (readonly)
 */
function isArtifactRecordArray(value: ArtifactVarValue): value is readonly ArtifactRecord[] {
  return Array.isArray(value);
}

/**
 * Required render-frame fields for projecting a literal artifact key.
 *
 * Record-shaped projectors read identity from the record itself. The
 * literal-key `path` helper has no record, so callers must provide the
 * current run identity explicitly.
 */
export interface RenderArtifactOptions extends ArtifactPathOptions {
  /** Current context identifier. */
  readonly contextId: string;
  /** Current run identifier, when rendering for a concrete run. */
  readonly runId?: RunId;
}

/**
 * Render an artifact variable value as it appears via direct alias `{{ Var }}`.
 *
 * - `ArtifactRecord` -> local artifact path.
 * - `ArtifactRecord[]` -> JSON array of local artifact paths; empty array renders as `"[]"`.
 *
 * @param value - Artifact variable value
 * @param options - Project root and work path for local path projection
 * @returns Rendered string
 * @throws {Error} When any record's URI fails path validation
 */
export function renderArtifactValue(value: ArtifactVarValue, options: ArtifactPathOptions): string {
  return renderArtifactPathValue(value, options);
}

/**
 * Render an artifact variable value as a local path projection (`{{ path Var }}`).
 *
 * - `ArtifactRecord` -> local artifact path under `<cwd>/<workPath>/.rd-<ctx>/<run>/<key>`.
 * - `ArtifactRecord[]` -> JSON array of local paths; empty array renders as `"[]"`.
 *
 * Pure: does not create directories or files. Phase 2's directive resolver is
 * responsible for ensuring the parent directory exists for exact declarations
 * before commands run; this projector does not duplicate that work.
 *
 * @param value - Artifact variable value
 * @param options - Render options carrying project root and work path
 * @returns Rendered string
 * @throws {Error} When any record's URI fails path validation
 */
export function renderArtifactPathValue(
  value: ArtifactVarValue,
  options: ArtifactPathOptions,
): string {
  if (isArtifactRecordArray(value)) {
    if (value.length === 0) return '[]';
    return JSON.stringify(value.map((record) => renderSingleArtifactPath(record, options)));
  }
  return renderSingleArtifactPath(value, options);
}

function renderSingleArtifactPath(record: ArtifactRecord, options: ArtifactPathOptions): string {
  switch (record.kind) {
    case 'artifact-record':
      return artifactUriToPath(record.uri, options);
    case 'file-artifact-record':
      return fileURLToPath(record.uri);
  }
}

/**
 * Render an artifact variable value as URI(s) for the `{{ artifact Var }}` form.
 *
 * - `ArtifactRecord` -> the canonical artifact URI string.
 * - `ArtifactRecord[]` -> JSON array of URI strings; empty array renders as `"[]"`.
 *
 * @param value - Artifact variable value
 * @param _options - Deprecated compatibility parameter; artifact URI rendering reads from records
 * @returns Rendered string
 */
export function renderArtifactRecordValue(
  value: ArtifactVarValue,
  _options?: ArtifactPathOptions,
): string {
  if (isArtifactRecordArray(value)) {
    if (value.length === 0) return '[]';
    return JSON.stringify(value.map((record) => record.uri));
  }
  return value.uri;
}

/**
 * Render a local path projection from a literal artifact key
 * (`{{ path "plan.json" }}`).
 *
 * Runnable renders include the run identifier:
 * `<cwd>/<workPath>/.rd-<contextId>/<runId>/<key>`.
 *
 * Prepared renders omit it because no run has been allocated yet:
 * `<cwd>/<workPath>/.rd-<contextId>/<key>`.
 *
 * Both paths validate the key using the same safe-id and path containment
 * rules as exact artifact URI path projection. Does NOT register an artifact,
 * append a manifest row, or create the artifact file (spec §327). The artifact
 * need not exist on disk.
 *
 * @param key - Quoted literal artifact key from the helper call
 * @param options - Render options including current `contextId` and `runId`
 * @returns Local artifact path string
 * @throws {Error} When the key is empty, contains unsafe characters, or fails URI/path assembly
 */
export function renderLiteralArtifactPath(key: string, options: RenderArtifactOptions): string {
  if (key === '') {
    throw new Error('renderLiteralArtifactPath: key must not be empty');
  }
  const uri = buildArtifactUri({
    contextId: options.contextId,
    runId: options.runId ?? PREPARED_LITERAL_PATH_VALIDATION_RUN_ID,
    key,
  });
  const runScopedPath = artifactUriToPath(uri, options);
  if (options.runId !== undefined) {
    return runScopedPath;
  }
  return path.join(path.dirname(path.dirname(runScopedPath)), key);
}
