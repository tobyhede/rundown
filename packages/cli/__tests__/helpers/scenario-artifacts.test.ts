import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { appendArtifactManifestRecordSync } from '@rundown-org/core';
import { resolveCapturedArtifactFromManifest } from '../../src/helpers/scenario-artifacts.js';

const WORK_PATH = '.rundown/work';

/** Build a canonical `rd://artifacts/...` URI for a manifest row. */
function artifactUri(contextId: string, runId: string, key: string): string {
  return `rd://artifacts/${contextId}/${runId}/${key}`;
}

/**
 * Seed one managed artifact manifest row directly into a context manifest.
 *
 * Rows for the same key in different contexts have distinct URIs (the URI
 * embeds contextId + runId), so the schema accepts them as separate rows.
 */
function seedRow(
  cwd: string,
  contextId: string,
  runId: string,
  key: string,
  timestamp: string,
): string {
  const uri = artifactUri(contextId, runId, key);
  appendArtifactManifestRecordSync(
    { cwd, workPath: WORK_PATH },
    {
      uri,
      runId,
      contextId,
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key,
      timestamp,
    },
  );
  return uri;
}

describe('resolveCapturedArtifactFromManifest', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rd-scenario-artifacts-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('throws ambiguous for a cross-context same-timestamp scalar pick', async () => {
    const ts = '2026-05-25T00:00:00.000Z';
    seedRow(cwd, 'context-a', 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Report', ts);
    seedRow(cwd, 'context-b', 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Report', ts);

    await expect(resolveCapturedArtifactFromManifest({ cwd }, 'Report', false)).rejects.toThrow(
      /ambiguous/i,
    );
  });

  it('returns the later-appended URI for same-context same-timestamp rows', async () => {
    const ts = '2026-05-25T00:00:00.000Z';
    seedRow(cwd, 'context-a', 'rd_11111111111111111111111111111111', 'Report', ts);
    const later = seedRow(cwd, 'context-a', 'rd_22222222222222222222222222222222', 'Report', ts);

    await expect(resolveCapturedArtifactFromManifest({ cwd }, 'Report', false)).resolves.toBe(
      later,
    );
  });

  it('returns the genuinely-latest URI when timestamps differ across contexts', async () => {
    seedRow(
      cwd,
      'context-a',
      'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'Report',
      '2026-05-25T00:00:00.000Z',
    );
    const latest = seedRow(
      cwd,
      'context-b',
      'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'Report',
      '2026-05-26T00:00:00.000Z',
    );

    await expect(resolveCapturedArtifactFromManifest({ cwd }, 'Report', false)).resolves.toBe(
      latest,
    );
  });

  it('returns all matching URIs as a JSON array for cross-context same-timestamp collisions', async () => {
    const ts = '2026-05-25T00:00:00.000Z';
    const a = seedRow(cwd, 'context-a', 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Report', ts);
    const b = seedRow(cwd, 'context-b', 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Report', ts);

    const result = await resolveCapturedArtifactFromManifest({ cwd }, 'Report', true);
    const uris = JSON.parse(result) as string[];
    expect(uris).toHaveLength(2);
    expect(uris).toEqual(expect.arrayContaining([a, b]));
  });
});
