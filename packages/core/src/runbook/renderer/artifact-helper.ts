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
import { artifactUriToPath, buildArtifactUri, type ArtifactPathOptions } from '../artifact-uri.js';
import type { ArtifactVarValue } from '../types.js';

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
 * Required render-frame fields for projecting artifact values.
 *
 * `cwd` and `workPath` come from the existing `ArtifactPathOptions` shape;
 * `contextId` and `runId` are needed only by the literal-key `path` helper,
 * which builds a URI on the fly. The record-shaped projectors ignore them
 * because every record carries its own identity.
 *
 * **Empty-array invariant.** Callers projecting an empty `ArtifactRecord[]`
 * MAY pass empty strings (`''`) for both `contextId` and `runId`. The
 * empty-array branch of every projector returns `'[]'` before any URI or
 * path assembly, so the empty values are never read. This is load-bearing:
 * a wildcard `ArtifactRecord[]` with zero matches has no identity to
 * inherit, and forcing the call site to invent fake identifiers would
 * obscure the "no matches" semantics. Do NOT remove the empty-string
 * accepting behaviour without first updating every call site that relies
 * on it (`resolvePathHelperCall`, `resolveArtifactHelperCall`,
 * `renderTemplateValue`).
 */
export interface RenderArtifactOptions extends ArtifactPathOptions {
  /**
   * Current context identifier; required by literal-key `path` helper.
   * Empty string is accepted only for empty `ArtifactRecord[]` projection.
   */
  readonly contextId: string;
  /**
   * Current run identifier; required by literal-key `path` helper.
   * Empty string is accepted only for empty `ArtifactRecord[]` projection.
   */
  readonly runId: string;
}

/**
 * Render an artifact variable value as it appears via direct alias `{{ Var }}`.
 *
 * - `ArtifactRecord` -> the canonical artifact URI string.
 * - `ArtifactRecord[]` -> JSON array of URI strings; empty array renders as `"[]"`.
 *
 * @param value - Artifact variable value
 * @param _options - Render options (unused for direct alias; included for API symmetry with the helper variants)
 * @returns Rendered string
 */
export function renderArtifactValue(
  value: ArtifactVarValue,
  _options: RenderArtifactOptions,
): string {
  if (isArtifactRecordArray(value)) {
    if (value.length === 0) return '[]';
    return JSON.stringify(value.map((record) => record.uri));
  }
  return value.uri;
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
  options: RenderArtifactOptions,
): string {
  if (isArtifactRecordArray(value)) {
    if (value.length === 0) return '[]';
    return JSON.stringify(value.map((record) => renderSingleArtifactPath(record, options)));
  }
  return renderSingleArtifactPath(value, options);
}

function renderSingleArtifactPath(record: ArtifactRecord, options: RenderArtifactOptions): string {
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
 * Per spec §9.3, the `artifact` helper "renders artifact URI values with the
 * same scalar or array shape" — i.e. its output matches direct-alias rendering
 * (`{{ Var }}`). The helper exists as an explicit, type-marked surface for
 * authors who want to assert "render this as an artifact URI" at the call
 * site; the projection itself is identical to `renderArtifactValue`.
 *
 * - `ArtifactRecord` -> the canonical artifact URI string.
 * - `ArtifactRecord[]` -> JSON array of URI strings; empty array renders as `"[]"`.
 *
 * @param value - Artifact variable value
 * @param options - Render options (unused; included for API symmetry)
 * @returns Rendered string
 */
export function renderArtifactRecordValue(
  value: ArtifactVarValue,
  options: RenderArtifactOptions,
): string {
  return renderArtifactValue(value, options);
}

/**
 * Render a current-run local path projection from a literal artifact key
 * (`{{ path "plan.json" }}`).
 *
 * Validates the key (existing safe-id rules from `artifactUriToPath`) and
 * builds the canonical URI for the current run before deriving the local
 * path. Does NOT register an artifact, append a manifest row, or create the
 * artifact file (spec §327). The artifact need not exist on disk.
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
    runId: options.runId,
    key,
  });
  return artifactUriToPath(uri, options);
}
