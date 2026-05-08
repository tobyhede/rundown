import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ArtifactDeclaration } from '@rundown-org/parser';
import {
  appendArtifactManifestRecord,
  readArtifactManifest,
  resolveArtifactDeclarations,
  type ArtifactRunEligibility,
} from '../../src/runbook/index.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import type { RunId } from '../../src/runbook/run-id.js';
import { brandRunIdForTest } from '../helpers/effective-vars.js';

const CURRENT_RUN: RunId = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CHILD_RUN: RunId = brandRunIdForTest('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const OTHER_CONTEXT_RUN: RunId = brandRunIdForTest('rd_cccccccccccccccccccccccccccccccc');
const CONTEXT_ID = 'ctx1';
const WORK_PATH = '.rundown/work';
const RUNBOOK = { source: 'project' as const, path: 'planning/write-plan.runbook.md' };
const CHILD_RUNBOOK = { source: 'project' as const, path: 'planning/review.runbook.md' };

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function tempCwd(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-directive-'));
  tempDirs.push(cwd);
  return cwd;
}

function exact(name: string, key: string): ArtifactDeclaration {
  return { name, key, kind: 'exact' };
}

function wildcard(name: string, key: string): ArtifactDeclaration {
  return { name, key, kind: 'wildcard' };
}

function record(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  const runId = overrides.runId ?? CHILD_RUN;
  const contextId = overrides.contextId ?? CONTEXT_ID;
  const key = overrides.key ?? 'review-plan-a.json';
  return {
    uri: `rd://artifacts/${contextId}/runs/${runId}/${key}`,
    runId,
    contextId,
    runbook: overrides.runbook ?? CHILD_RUNBOOK,
    key,
    timestamp: overrides.timestamp ?? '2026-05-07T00:00:00.000Z',
  };
}

async function touchArtifact(cwd: string, row: ArtifactRecord): Promise<void> {
  const file = path.join(cwd, WORK_PATH, `.rd-${row.contextId}`, 'runs', row.runId, row.key);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '{}');
}

function eligibility(states: ReadonlyMap<string, ArtifactRunEligibility | null>) {
  return async (runId: RunId): Promise<ArtifactRunEligibility | null> => states.get(runId) ?? null;
}

describe('resolveArtifactDeclarations', () => {
  it('registers an exact artifact once and creates only its parent directory', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([exact('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      now: () => '2026-05-07T01:00:00.000Z',
      loadRunEligibility: eligibility(new Map()),
    });

    expect(result.PlanPath).toEqual({
      uri: `rd://artifacts/${CONTEXT_ID}/runs/${CURRENT_RUN}/plan.json`,
      runId: CURRENT_RUN,
      contextId: CONTEXT_ID,
      runbook: RUNBOOK,
      key: 'plan.json',
      timestamp: '2026-05-07T01:00:00.000Z',
    });
    const runDirStat = await fsp.stat(
      path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, 'runs', CURRENT_RUN),
    );
    expect(runDirStat.isDirectory()).toBe(true);
    await expect(
      fsp.stat(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, 'runs', CURRENT_RUN, 'plan.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID),
    ).resolves.toHaveLength(1);
  });

  it('reuses an existing coalesced exact record instead of appending', async () => {
    const cwd = await tempCwd();
    const existing = record({
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, existing);

    const result = await resolveArtifactDeclarations([exact('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      now: () => '2026-05-07T01:00:00.000Z',
      loadRunEligibility: eligibility(new Map()),
    });

    expect(result.PlanPath).toEqual(existing);
    await expect(readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID)).resolves.toEqual([
      existing,
    ]);
  });

  it('wildcards match current-run files and completed sibling runbook files in the same context', async () => {
    const cwd = await tempCwd();
    const current = record({
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      key: 'review-plan-current.json',
    });
    const completedChild = record({ key: 'review-plan-child.json' });
    const otherContext = record({
      runId: OTHER_CONTEXT_RUN,
      contextId: 'ctx2',
      key: 'review-plan-other.json',
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, completedChild);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, current);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, otherContext);
    await Promise.all(
      [current, completedChild, otherContext].map((row) => touchArtifact(cwd, row)),
    );

    const result = await resolveArtifactDeclarations([wildcard('Reviews', 'review-plan-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      now: () => '2026-05-07T01:00:00.000Z',
      loadRunEligibility: eligibility(
        new Map([
          [CHILD_RUN, { runId: CHILD_RUN, terminalAt: '2026-05-07T02:00:00.000Z' }],
          [OTHER_CONTEXT_RUN, { runId: OTHER_CONTEXT_RUN, terminalAt: '2026-05-07T02:00:00.000Z' }],
        ]),
      ),
    });

    expect(result.Reviews).toEqual(
      [current, completedChild].sort((a, b) => a.uri.localeCompare(b.uri)),
    );
  });

  it('wildcards ignore incomplete other runs and missing files', async () => {
    const cwd = await tempCwd();
    const incomplete = record({ key: 'review-plan-incomplete.json' });
    const missingFile = record({
      runId: 'rd_dddddddddddddddddddddddddddddddd',
      key: 'review-plan-missing.json',
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, incomplete);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, missingFile);
    await touchArtifact(cwd, incomplete);

    const result = await resolveArtifactDeclarations([wildcard('Reviews', 'review-plan-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      now: () => '2026-05-07T01:00:00.000Z',
      loadRunEligibility: eligibility(
        // Incomplete sibling run signalled by `null`; the resolver's null-check
        // filters it out of wildcard matches.
        new Map([[CHILD_RUN, null]]),
      ),
    });

    expect(result.Reviews).toEqual([]);
  });

  it('wildcards ignore symlinked artifact files', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const target = path.join(outside, 'review-plan-a.json');
    const row = record({ key: 'review-plan-symlink.json' });
    await fsp.writeFile(target, '{}');
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    const artifactPath = path.join(
      cwd,
      WORK_PATH,
      `.rd-${row.contextId}`,
      'runs',
      row.runId,
      row.key,
    );
    await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
    try {
      await fsp.symlink(target, artifactPath);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        return;
      }
      throw error;
    }

    const result = await resolveArtifactDeclarations([wildcard('Reviews', 'review-plan-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      now: () => '2026-05-07T01:00:00.000Z',
      loadRunEligibility: eligibility(
        new Map([[CHILD_RUN, { runId: CHILD_RUN, terminalAt: '2026-05-07T02:00:00.000Z' }]]),
      ),
    });

    expect(result.Reviews).toEqual([]);
  });

  it('wildcards ignore artifact paths whose parent directory is a symlink', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const row = record({ key: 'review-plan-parent-symlink.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await fsp.writeFile(path.join(outside, row.key), '{}');
    const runDir = path.join(cwd, WORK_PATH, `.rd-${row.contextId}`, 'runs', row.runId);
    await fsp.mkdir(path.dirname(runDir), { recursive: true });
    try {
      await fsp.symlink(outside, runDir, 'dir');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        return;
      }
      throw error;
    }

    const result = await resolveArtifactDeclarations([wildcard('Reviews', 'review-plan-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      now: () => '2026-05-07T01:00:00.000Z',
      loadRunEligibility: eligibility(
        new Map([[CHILD_RUN, { runId: CHILD_RUN, terminalAt: '2026-05-07T02:00:00.000Z' }]]),
      ),
    });

    expect(result.Reviews).toEqual([]);
  });

  it('resolves exact declarations before wildcards in the same block', async () => {
    const cwd = await tempCwd();
    await fsp.mkdir(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, 'runs', CURRENT_RUN), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, 'runs', CURRENT_RUN, 'plan.json'),
      '{}',
    );

    const result = await resolveArtifactDeclarations(
      [wildcard('Plans', 'plan*.json'), exact('PlanPath', 'plan.json')],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        now: () => '2026-05-07T01:00:00.000Z',
        loadRunEligibility: eligibility(new Map()),
      },
    );

    expect(result.PlanPath).toMatchObject({ key: 'plan.json' });
    expect(result.Plans).toEqual([result.PlanPath]);
  });

  it('exact resolution adds a manifest row that a same-block wildcard observes (file NOT pre-created)', async () => {
    // Isolates the manifest-update ordering from the file-existence check.
    // The exact appends a new manifest row during this call; the wildcard
    // (declared first in source order) sees the row because resolution runs
    // exacts before wildcards. The file is never written, so the wildcard's
    // hardened file-existence filter rejects the row — what we assert is the
    // manifest row count growing from 0 to 1 inside one call.
    const cwd = await tempCwd();
    const before = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(before).toHaveLength(0);

    const result = await resolveArtifactDeclarations(
      [wildcard('Plans', 'plan*.json'), exact('PlanPath', 'plan.json')],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        now: () => '2026-05-07T01:00:00.000Z',
        loadRunEligibility: eligibility(new Map()),
      },
    );

    expect(result.PlanPath).toMatchObject({ key: 'plan.json' });
    expect(result.Plans).toEqual([]);

    const after = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(after).toHaveLength(1);
  });

  it('coalesces concurrent duplicate appends on the next resolver read', async () => {
    // Two appends with identical (contextId, runId, runbook, key) — simulating
    // a race between two writers in the same context. coalesceManifestRecords
    // is invoked during the next resolver call and reduces them to one row.
    const cwd = await tempCwd();
    const first = record({
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    });
    const duplicate = { ...first, timestamp: '2026-05-07T00:00:00.000Z' };
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, first);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, duplicate);

    const raw = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(raw).toHaveLength(2);

    const result = await resolveArtifactDeclarations([exact('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      now: () => '2026-05-07T01:00:00.000Z',
      loadRunEligibility: eligibility(new Map()),
    });

    expect(result.PlanPath).toEqual(first);
    const afterRaw = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(afterRaw).toHaveLength(2);
  });
});
