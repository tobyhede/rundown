/**
 * Scenario-harness artifact capture resolution.
 *
 * Resolves the `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` grammar — the harness's sole
 * artifact mechanism — for both the in-process jest scenario runner and the
 * standalone `rd scenario run` command, so the two harnesses share one
 * implementation instead of drifting. A scenario that needs a pre-existing
 * artifact runs a real producer runbook first (see
 * `runbooks/artifacts/scenario-seed-artifacts.runbook.md`) and captures the
 * `rd://` URI that producer emitted; the harness never fabricates a URI or
 * hand-writes a manifest row. Scenario-harness only — never part of runbook
 * execution.
 *
 * @module helpers/scenario-artifacts
 */

import { readAllArtifactManifestRecords } from '@rundown-org/core';

/** Workspace location used to resolve the artifact manifest and backing files. */
export interface ScenarioArtifactLocation {
  /** Absolute path to the scenario workspace root. */
  readonly cwd: string;
}

const WORK_PATH = '.rundown/work';

/**
 * Resolve a `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` placeholder from the workspace
 * manifest for rows produced by a prior scenario command.
 *
 * Returns the latest matching `rd://artifacts/...` URI (scalar) or a JSON array
 * of all matching URIs (array). Recency is determined by the manifest row
 * `timestamp`. Within a single context, manifest append order is real write
 * order, so the last-appended row legitimately wins a timestamp tie. Across
 * contexts there is no recorded write-order signal, so a scalar pick where the
 * rows sharing the maximum timestamp span more than one context is ambiguous and
 * raises an error rather than returning an order-dependent guess.
 *
 * Manifest reading, parsing, and schema validation are owned by core's
 * {@link readAllArtifactManifestRecords}, so the manifest row shape lives in
 * exactly one place; this resolver only applies the harness-specific key filter,
 * recency selection, and cross-context ambiguity guard.
 *
 * @param location - The scenario workspace location
 * @param key - The captured artifact key to resolve
 * @param asArray - When true, return a JSON array of all matching URIs
 * @returns Promise of the resolved URI (scalar) or JSON array of URIs (array)
 * @throws {Error} When no matching manifest row exists for a scalar lookup, or
 *   when the latest scalar pick is ambiguous across contexts (equal-timestamp
 *   rows in more than one context, where cross-context write order is unknowable)
 */
export async function resolveCapturedArtifactFromManifest(
  location: ScenarioArtifactLocation,
  key: string,
  asArray: boolean,
): Promise<string> {
  // The core reader returns validated records in a deterministic (sorted-context,
  // then append-order) sequence. The array index (`seq`) therefore tracks real
  // write order ONLY within a single context — across contexts it reflects
  // lexicographic context sorting, not when the rows were actually written.
  const matches = (
    await readAllArtifactManifestRecords({
      cwd: location.cwd,
      workPath: WORK_PATH,
    })
  )
    .map((record, seq) => ({
      uri: record.uri,
      timestamp: record.timestamp,
      key: record.key,
      contextId: record.contextId,
      seq,
    }))
    // The artifact boundary channel only rehydrates `rd://artifacts/...` URIs.
    // Manifest rows can also be file artifact records, so ignore any non-artifact
    // URI here rather than substituting it into `--artifacts` (which would fail
    // later in a less targeted path).
    .filter((m) => m.key === key && m.uri.startsWith('rd://artifacts/'));
  // Order by recency (timestamp, then within-context append order) so "latest" is
  // meaningful for the single-context case.
  matches.sort((a, b) =>
    a.timestamp === b.timestamp ? a.seq - b.seq : a.timestamp < b.timestamp ? -1 : 1,
  );
  if (asArray) return JSON.stringify(matches.map((m) => m.uri));
  if (matches.length === 0) {
    throw new Error(`No manifest row found for captured artifact key "${key}"`);
  }
  // The scalar "latest" pick must reflect a real write order. Within one context,
  // append order (`seq`) is that order, so the last-appended tied row wins. Across
  // contexts there is no recorded sequence, so an equal-timestamp tie spanning
  // more than one context is ambiguous — fail loudly rather than return a value
  // that only depends on lexicographic context sorting.
  const maxTimestamp = matches[matches.length - 1].timestamp;
  const tied = matches.filter((m) => m.timestamp === maxTimestamp);
  const tiedContexts = new Set(tied.map((m) => m.contextId));
  if (tiedContexts.size > 1) {
    throw new Error(
      `Ambiguous latest artifact for captured key "${key}": ${String(tied.length)} rows share the latest timestamp "${maxTimestamp}" across ${String(tiedContexts.size)} contexts (${[...tiedContexts].join(', ')}), and cross-context write order is unknowable`,
    );
  }
  return tied[tied.length - 1].uri;
}
