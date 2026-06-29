/**
 * Scenario-harness artifact seeding and capture resolution.
 *
 * These helpers are the production home of the `seed:` / `${ARTIFACT:<name>}` and
 * `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` machinery used by both the in-process jest
 * scenario runner and the standalone `rd scenario run` command, so the two
 * harnesses share one implementation instead of drifting. Scenario-harness only —
 * never part of runbook execution.
 *
 * @module helpers/scenario-artifacts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendArtifactManifestRecordSync,
  assertRunId,
  readAllArtifactManifestRecords,
} from '@rundown-org/core';
import type { Scenario } from '../schemas/scenarios.js';

/** Workspace location used to resolve the artifact manifest and backing files. */
export interface ScenarioArtifactLocation {
  /** Absolute path to the scenario workspace root. */
  readonly cwd: string;
}

const WORK_PATH = '.rundown/work';

/**
 * Seed manifest rows for a scenario's `seed:` directive.
 *
 * Each `seed` entry writes an `rd://artifacts/...` manifest row (and a backing
 * file at its projected local path, so `exists: true` assertions and
 * `{{ path X }}` projections resolve against a real file) and returns a map of
 * artifact name to its `rd://` URI, consumed by `${ARTIFACT:<name>}` substitution.
 *
 * @param scenario - The scenario whose `seed:` directive to materialise
 * @param location - The scenario workspace location
 * @returns Map of seeded artifact name to its `rd://` URI
 */
export function seedScenarioArtifacts(
  scenario: Scenario,
  location: ScenarioArtifactLocation,
): Record<string, string> {
  const artifactUris: Record<string, string> = {};
  const seedRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const seedContextId = 'scenario-seed-context';
  for (const entry of scenario.seed ?? []) {
    const uri = `rd://artifacts/${seedContextId}/${seedRunId}/${entry.artifact}`;
    appendArtifactManifestRecordSync(
      { cwd: location.cwd, workPath: WORK_PATH },
      {
        uri,
        runId: seedRunId,
        contextId: seedContextId,
        runbook: { source: 'project', path: 'producer.runbook.md' },
        key: entry.artifact,
        timestamp: '2026-05-25T00:00:00.000Z',
      },
    );
    // Also materialise the backing file at the projected local path so an
    // `exists: true` artifact assertion (file-existence) and `{{ path X }}`
    // projection both resolve against a real file.
    const backingDir = join(location.cwd, WORK_PATH, `.rd-${seedContextId}`, seedRunId);
    mkdirSync(backingDir, { recursive: true });
    writeFileSync(join(backingDir, entry.artifact), '{"seeded":true}\n');
    artifactUris[entry.artifact] = uri;
  }
  return artifactUris;
}

/**
 * Resolve a `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` placeholder from the workspace
 * manifest for rows produced by a prior scenario command.
 *
 * Returns the latest matching `rd://artifacts/...` URI (scalar) or a JSON array
 * of all matching URIs (array). Recency is determined by the manifest row
 * `timestamp`, with append order (`seq`) as a deterministic tiebreaker.
 *
 * Manifest reading, parsing, schema validation, and the cross-context append
 * order are owned by core's {@link readAllArtifactManifestRecords}, so the
 * manifest row shape lives in exactly one place; this resolver only applies the
 * harness-specific key filter and recency selection.
 *
 * @param location - The scenario workspace location
 * @param key - The captured artifact key to resolve
 * @param asArray - When true, return a JSON array of all matching URIs
 * @returns Promise of the resolved URI (scalar) or JSON array of URIs (array)
 * @throws {Error} When no matching manifest row exists for a scalar lookup
 */
export async function resolveCapturedArtifactFromManifest(
  location: ScenarioArtifactLocation,
  key: string,
  asArray: boolean,
): Promise<string> {
  // The core reader returns validated records in a deterministic (sorted-context,
  // then append-order) sequence, so each record's array index is a stable `seq`
  // tiebreaker for rows that share a timestamp.
  const matches = (
    await readAllArtifactManifestRecords({
      cwd: location.cwd,
      workPath: WORK_PATH,
    })
  )
    .map((record, seq) => ({ uri: record.uri, timestamp: record.timestamp, key: record.key, seq }))
    // The artifact boundary channel only rehydrates `rd://artifacts/...` URIs.
    // Manifest rows can also be file artifact records, so ignore any non-artifact
    // URI here rather than substituting it into `--artifacts` (which would fail
    // later in a less targeted path).
    .filter((m) => m.key === key && m.uri.startsWith('rd://artifacts/'));
  // Order by recency (timestamp, then append order) so "latest" is meaningful.
  matches.sort((a, b) =>
    a.timestamp === b.timestamp ? a.seq - b.seq : a.timestamp < b.timestamp ? -1 : 1,
  );
  const uris = matches.map((m) => m.uri);
  if (asArray) return JSON.stringify(uris);
  if (uris.length === 0) {
    throw new Error(`No manifest row found for captured artifact key "${key}"`);
  }
  return uris[uris.length - 1];
}
