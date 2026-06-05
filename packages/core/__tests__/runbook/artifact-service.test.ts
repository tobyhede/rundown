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
});
