import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendArtifactManifestRecord } from '../../src/runbook/artifact-manifest.js';
import {
  getArtifactByAlias,
  inspectArtifactReference,
  listArtifactAliases,
  projectArtifactPath,
  projectArtifactUri,
} from '../../src/runbook/artifact-service.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import type { RunbookState } from '../../src/runbook/types.js';

let cwd: string;
const workPath = '.rundown/work';
const runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const artifact = {
  kind: 'artifact-record' as const,
  uri: `rd://artifacts/ctx1/${runId}/plan.json`,
  runId,
  contextId: 'ctx1',
  runbook: { source: 'project' as const, path: 'workflow.runbook.md' },
  key: 'plan.json',
  timestamp: '2026-06-05T00:00:00.000Z',
};
const state = {
  templateVars: { WorkPath: workPath },
  variables: { PlanPath: artifact },
} as unknown as RunbookState;

const secondArtifact = {
  kind: 'artifact-record' as const,
  uri: `rd://artifacts/ctx1/${runId}/review.json`,
  runId,
  contextId: 'ctx1',
  runbook: { source: 'project' as const, path: 'workflow.runbook.md' },
  key: 'review.json',
  timestamp: '2026-06-05T00:00:00.000Z',
};
const arrayState = {
  templateVars: { WorkPath: workPath },
  variables: { Reviews: [artifact, secondArtifact] },
} as unknown as RunbookState;

function expectedPath(key = 'plan.json'): string {
  return path.join(cwd, '.rundown/work', '.rd-ctx1', runId, key);
}

describe('artifact service', () => {
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'rundown-artifact-service-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('lists artifact aliases from effective vars', () => {
    expect(listArtifactAliases(state, { cwd, workPath })).toEqual([
      expect.objectContaining({
        alias: 'PlanPath',
        kind: 'artifact-record',
        uri: artifact.uri,
        path: expectedPath(),
      }),
    ]);
  });

  it('gets an artifact by alias', () => {
    expect(getArtifactByAlias(state, 'PlanPath', { cwd, workPath })).toEqual(
      expect.objectContaining({ alias: 'PlanPath', uri: artifact.uri }),
    );
  });

  it('projects alias to path and uri', async () => {
    await expect(projectArtifactPath(state, 'PlanPath', { cwd, workPath })).resolves.toEqual(
      expect.objectContaining({
        alias: 'PlanPath',
        uri: artifact.uri,
        path: expectedPath(),
      }),
    );
    expect(projectArtifactUri(state, 'PlanPath', { cwd, workPath })).toEqual(
      expect.objectContaining({
        alias: 'PlanPath',
        uri: artifact.uri,
        path: expectedPath(),
      }),
    );
  });

  it('inspects an exact URI through the manifest without requiring an alias', async () => {
    await appendArtifactManifestRecord(
      { cwd, workPath },
      {
        uri: artifact.uri,
        runId,
        contextId: 'ctx1',
        runbook: { source: 'project', path: 'workflow.runbook.md' },
        key: 'plan.json',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
    );

    await expect(inspectArtifactReference(state, artifact.uri, { cwd, workPath })).resolves.toEqual(
      expect.objectContaining({
        uri: artifact.uri,
        key: 'plan.json',
        runbook: { source: 'project', path: 'workflow.runbook.md' },
        timestamp: '2026-06-05T00:00:00.000Z',
      }),
    );
  });

  it('fails exact URI inspection when the URI is not manifest-backed', async () => {
    await expect(
      inspectArtifactReference(state, `rd://artifacts/ctx1/${runId}/missing.json`, {
        cwd,
        workPath,
      }),
    ).rejects.toThrow('Artifact URI not found in manifest');
  });

  it('projects exact URI path through the manifest', async () => {
    await appendArtifactManifestRecord(
      { cwd, workPath },
      {
        uri: artifact.uri,
        runId,
        contextId: 'ctx1',
        runbook: { source: 'project', path: 'workflow.runbook.md' },
        key: 'plan.json',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
    );

    await expect(projectArtifactPath(state, artifact.uri, { cwd, workPath })).resolves.toEqual(
      expect.objectContaining({
        uri: artifact.uri,
        path: expectedPath(),
      }),
    );
  });

  it('throws when projecting a uri for an unknown alias', () => {
    expect(() => projectArtifactUri(state, 'Missing', { cwd, workPath })).toThrow(
      'Artifact alias not found: Missing',
    );
  });

  it('throws when projecting a path for an unknown alias', async () => {
    await expect(projectArtifactPath(state, 'Missing', { cwd, workPath })).rejects.toThrow(
      'Artifact alias not found: Missing',
    );
  });

  it('throws when inspecting a non-uri reference that matches no alias', async () => {
    await expect(inspectArtifactReference(state, 'Missing', { cwd, workPath })).rejects.toThrow(
      'Artifact alias not found: Missing',
    );
  });

  it('throws when projecting a path for an unknown manifest-backed uri', async () => {
    await expect(
      projectArtifactPath(state, `rd://artifacts/ctx1/${runId}/missing.json`, { cwd, workPath }),
    ).rejects.toThrow('Artifact URI not found in manifest');
  });

  it('lists an array-bound alias as items', () => {
    expect(listArtifactAliases(arrayState, { cwd, workPath })).toEqual([
      {
        kind: 'artifact-array',
        alias: 'Reviews',
        items: [
          expect.objectContaining({ uri: artifact.uri, path: expectedPath() }),
          expect.objectContaining({ uri: secondArtifact.uri, path: expectedPath('review.json') }),
        ],
      },
    ]);
  });

  it('tags an array-bound alias with the artifact-array discriminant', () => {
    const [entry] = listArtifactAliases(arrayState, { cwd, workPath });
    expect(entry).toHaveProperty('kind', 'artifact-array');
  });

  it('tags a scalar alias with the underlying record kind, not artifact-array', () => {
    const [entry] = listArtifactAliases(state, { cwd, workPath });
    expect(entry).toHaveProperty('kind', 'artifact-record');
    expect(entry.kind).not.toBe('artifact-array');
  });

  it('listArtifactAliases returns kind: artifact-array only for array-bound entries', () => {
    const mixedState = {
      templateVars: { WorkPath: workPath },
      variables: {
        PlanPath: artifact,
        Reviews: [artifact, secondArtifact],
      },
    } as unknown as typeof state;

    const entries = listArtifactAliases(mixedState, { cwd, workPath });
    const planEntry = entries.find((e) => e.alias === 'PlanPath');
    const reviewsEntry = entries.find((e) => e.alias === 'Reviews');

    expect(planEntry).toHaveProperty('kind', 'artifact-record');
    expect(reviewsEntry).toHaveProperty('kind', 'artifact-array');
  });

  it('gets an array-bound alias by name', () => {
    expect(getArtifactByAlias(arrayState, 'Reviews', { cwd, workPath })).toEqual({
      kind: 'artifact-array',
      alias: 'Reviews',
      items: [
        expect.objectContaining({ uri: artifact.uri }),
        expect.objectContaining({ uri: secondArtifact.uri }),
      ],
    });
  });

  it('getArtifactByAlias returns null for a missing alias', () => {
    expect(getArtifactByAlias(state, 'NonExistent', { cwd, workPath })).toBeNull();
  });

  it('getArtifactByAlias for array-bound alias carries kind: artifact-array', () => {
    const entry = getArtifactByAlias(arrayState, 'Reviews', { cwd, workPath });
    expect(entry).not.toBeNull();
    expect(entry?.kind).toBe('artifact-array');
  });

  it('getArtifactByAlias for scalar alias carries the record kind', () => {
    const entry = getArtifactByAlias(state, 'PlanPath', { cwd, workPath });
    expect(entry).not.toBeNull();
    expect(entry?.kind).toBe('artifact-record');
  });

  it('projects an array-bound alias to items for path and uri', async () => {
    const expected = {
      kind: 'artifact-array',
      alias: 'Reviews',
      items: [
        expect.objectContaining({ uri: artifact.uri, path: expectedPath() }),
        expect.objectContaining({ uri: secondArtifact.uri, path: expectedPath('review.json') }),
      ],
    };
    await expect(projectArtifactPath(arrayState, 'Reviews', { cwd, workPath })).resolves.toEqual(
      expected,
    );
    expect(projectArtifactUri(arrayState, 'Reviews', { cwd, workPath })).toEqual(expected);
  });

  it('projectArtifactPath for array-bound alias returns kind: artifact-array', async () => {
    const result = await projectArtifactPath(arrayState, 'Reviews', { cwd, workPath });
    expect(result).toHaveProperty('kind', 'artifact-array');
  });

  it('projectArtifactUri for array-bound alias returns kind: artifact-array', () => {
    const result = projectArtifactUri(arrayState, 'Reviews', { cwd, workPath });
    expect(result).toHaveProperty('kind', 'artifact-array');
  });

  it('projectArtifactPath for scalar alias returns the record kind', async () => {
    const result = await projectArtifactPath(state, 'PlanPath', { cwd, workPath });
    expect(result).toHaveProperty('kind', 'artifact-record');
  });

  it('projectArtifactUri for scalar alias returns the record kind', () => {
    const result = projectArtifactUri(state, 'PlanPath', { cwd, workPath });
    expect(result).toHaveProperty('kind', 'artifact-record');
  });

  it('kind discriminant is present on every entry returned by listArtifactAliases', () => {
    const entries = listArtifactAliases(arrayState, { cwd, workPath });
    for (const entry of entries) {
      expect(entry).toHaveProperty('kind');
      expect(typeof entry.kind).toBe('string');
    }
  });
});
