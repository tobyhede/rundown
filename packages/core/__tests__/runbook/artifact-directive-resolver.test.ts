import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ArtifactDeclaration } from '@rundown-org/parser';
import {
  appendArtifactManifestRecord,
  readArtifactManifest,
  resolveArtifactDeclarations,
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

function decl(name: string, rawToken: string | null): ArtifactDeclaration {
  return { name, rawToken };
}

function record(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  const runId = overrides.runId ?? CHILD_RUN;
  const contextId = overrides.contextId ?? CONTEXT_ID;
  const key = overrides.key ?? 'review-plan-a.json';
  return {
    kind: 'artifact-record',
    uri: `rd://artifacts/${contextId}/${runId}/${key}`,
    runId,
    contextId,
    runbook: overrides.runbook ?? CHILD_RUNBOOK,
    key,
    timestamp: overrides.timestamp ?? '2026-05-07T00:00:00.000Z',
  };
}

async function touchArtifact(cwd: string, row: ArtifactRecord): Promise<void> {
  const file = path.join(cwd, WORK_PATH, `.rd-${row.contextId}`, row.runId, row.key);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '{}');
}

describe('resolveArtifactDeclarations — bare key (producer form)', () => {
  it('builds the exact URI for the current context and current run', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([decl('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.PlanPath).toMatchObject({
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      key: 'plan.json',
      runbook: RUNBOOK,
    });
  });

  it('returns a single ArtifactRecord (not an array)', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([decl('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(Array.isArray(result.PlanPath)).toBe(false);
  });

  it('appends a manifest row for the producer identity tuple', async () => {
    const cwd = await tempCwd();

    await resolveArtifactDeclarations([decl('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    const manifest = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      key: 'plan.json',
      runbook: RUNBOOK,
    });
    expect(typeof manifest[0]?.timestamp).toBe('string');
  });

  it('creates the artifact parent directory for a bare-key producer', async () => {
    const cwd = await tempCwd();

    await resolveArtifactDeclarations([decl('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    await expect(
      fsp.stat(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN)),
    ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it('rejects bare keys that fail exact_artifact_key validation', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('PlanPath', 'plans/plan.json')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/exact_artifact_key|invalid key/);
  });

  it('repeated declarations of the same key write exactly one manifest row', async () => {
    // Issue 2 fix: the write layer is now idempotent on the identity tuple
    // `(uri, contextId, runId, key, runbook.{source,path})`. Two declarations
    // pointing at the same producer key emit one row, regardless of how many
    // times the resolver fires through re-entries on `__parent-entry::*`.
    const cwd = await tempCwd();

    await resolveArtifactDeclarations([decl('PlanA', 'plan.json'), decl('PlanB', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    const raw = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(raw).toHaveLength(1);
    const identities = new Set(
      raw.map((r) => [r.contextId, r.runId, r.runbook.source, r.runbook.path, r.key].join('\0')),
    );
    expect(identities.size).toBe(1);
  });
});

describe('resolveArtifactDeclarations — bare key with glob (selector form)', () => {
  it('returns an array when the glob matches multiple records', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-a.json' });
    const b = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-b.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, a);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, b);
    await Promise.all([a, b].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual([a, b].sort((l, r) => l.uri.localeCompare(r.uri)));
  });

  it('returns a single ArtifactRecord when the glob matches exactly one record', async () => {
    const cwd = await tempCwd();
    const row = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-plan-a.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await touchArtifact(cwd, row);

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-plan-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual(row);
  });

  it('returns an empty array when no manifest row matches the glob', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual([]);
  });

  it('does NOT write to the manifest when resolving a bare-key glob', async () => {
    const cwd = await tempCwd();
    const before = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(before).toHaveLength(0);

    await resolveArtifactDeclarations([decl('Reviews', 'review-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    const after = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(after).toHaveLength(0);
  });

  it('rejects recursive bare-key globs', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Reviews', '**')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/wildcard_artifact_key|invalid key|recursive/);
  });

  it('rejects bare-key globs containing slashes', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Reviews', 'dir/*.json')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/wildcard_artifact_key|invalid key/);
  });

  it('matches both current-run records and completed sibling-run records in the same context', async () => {
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
    await Promise.all([current, completedChild, otherContext].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-plan-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual(
      [current, completedChild].sort((a, b) => a.uri.localeCompare(b.uri)),
    );
  });

  it('matches dotfile artifact keys via the bare-key glob', async () => {
    const cwd = await tempCwd();
    const hidden = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: '.review-plan.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, hidden);
    await touchArtifact(cwd, hidden);

    const result = await resolveArtifactDeclarations([decl('Reviews', '*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual(hidden);
  });

  it('ignores manifest rows whose keys do not match the glob', async () => {
    const cwd = await tempCwd();
    const matching = record({
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      key: 'review-plan-current.json',
    });
    const nonmatching = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'notes.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, nonmatching);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, matching);
    await Promise.all([matching, nonmatching].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-plan-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual(matching);
  });

  it('ignores symlinked artifact files', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const target = path.join(outside, 'review-plan-a.json');
    const row = record({ key: 'review-plan-symlink.json' });
    await fsp.writeFile(target, '{}');
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    const artifactPath = path.join(cwd, WORK_PATH, `.rd-${row.contextId}`, row.runId, row.key);
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

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-plan-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual([]);
  });

  it('later same-name declarations overwrite earlier ones in the alias slot', async () => {
    const cwd = await tempCwd();
    const planRecord = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'plan.json' });
    const reviewRecord = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, planRecord);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, reviewRecord);
    await touchArtifact(cwd, planRecord);
    await touchArtifact(cwd, reviewRecord);

    const result = await resolveArtifactDeclarations(
      [decl('Out', 'plan*'), decl('Out', 'review*')],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      },
    );

    expect(result.Out).toMatchObject({ key: 'review.json' });
  });

  it('observes a same-pass producer write through the cache invalidation', async () => {
    const cwd = await tempCwd();
    // Touch the producer file so the selector can match the freshly-written row.
    await fsp.mkdir(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN, 'plan.json'),
      '{}',
    );

    // Producer first, selector second — the selector MUST observe the producer's
    // append by way of the cache invalidation in resolveArtifactDeclarations.
    const result = await resolveArtifactDeclarations(
      [decl('PlanProd', 'plan.json'), decl('PlanSel', 'plan*')],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      },
    );

    expect(result.PlanProd).toMatchObject({
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      key: 'plan.json',
    });
    // Selector observed the producer-written row via the invalidated cache.
    expect(result.PlanSel).toMatchObject({
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      key: 'plan.json',
    });
  });

  it('returns an empty result map for an empty declarations array', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result).toEqual({});
  });
});

describe('resolveArtifactDeclarations — URI literal', () => {
  it('writes a manifest row for an exact URI in the current ctx + current run', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations(
      [decl('Plan', `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`)],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      },
    );

    expect(result.Plan).toMatchObject({
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      key: 'plan.json',
      runbook: RUNBOOK,
    });

    const manifest = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      key: 'plan.json',
    });
  });

  it('reads an existing row for an exact URI in the current ctx + a DIFFERENT run', async () => {
    const cwd = await tempCwd();
    const row = record({ runId: CHILD_RUN, runbook: CHILD_RUNBOOK, key: 'plan.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await touchArtifact(cwd, row);

    const result = await resolveArtifactDeclarations(
      [decl('Plan', `rd://artifacts/${CONTEXT_ID}/${CHILD_RUN}/plan.json`)],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      },
    );

    expect(result.Plan).toEqual(row);

    // No new row written.
    const manifest = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toEqual(row);
  });

  it('errors when an exact URI for a different run has no matching manifest row', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations(
        [decl('Plan', `rd://artifacts/${CONTEXT_ID}/${CHILD_RUN}/plan.json`)],
        {
          cwd,
          workPath: WORK_PATH,
          contextId: CONTEXT_ID,
          runId: CURRENT_RUN,
          runbook: RUNBOOK,
        },
      ),
    ).rejects.toThrow(/other-run|does not exist|selector/);
  });

  it('resolves a selector URI literal that names the current context (read-only)', async () => {
    const cwd = await tempCwd();
    const row = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'plan.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await touchArtifact(cwd, row);

    const before = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(before).toHaveLength(1);

    const result = await resolveArtifactDeclarations(
      [decl('Plan', `rd://artifacts/${CONTEXT_ID}/*/plan.json`)],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      },
    );

    expect(result.Plan).toEqual(row);
    // Selector did not write a new row.
    const after = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(after).toHaveLength(1);
  });

  it('creates the artifact parent directory for an exact current-run URI producer', async () => {
    const cwd = await tempCwd();

    await resolveArtifactDeclarations(
      [decl('Plan', `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`)],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      },
    );

    await expect(
      fsp.stat(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN)),
    ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it('throws when the URI literal targets a different context', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plan', 'rd://artifacts/other-ctx/*/plan.json')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/cross-context flow is not supported/);
  });
});

describe('resolveArtifactDeclarations — naked assertion form', () => {
  it('passes through an ArtifactRecord bound in scope', async () => {
    const cwd = await tempCwd();
    const planRecord = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'plan.json' });

    const result = await resolveArtifactDeclarations([decl('Plan', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plan: planRecord },
    });

    expect(result.Plan).toEqual(planRecord);
  });

  it('rejects an ArtifactRecord bound in scope from a different context', async () => {
    const cwd = await tempCwd();
    const planRecord = record({
      runId: OTHER_CONTEXT_RUN,
      contextId: 'ctx2',
      key: 'plan.json',
    });

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plan: planRecord },
      }),
    ).rejects.toThrow(/cross-context flow is not supported/);
  });

  it('passes through an ArtifactRecord[] bound in scope', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    const b = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'b.json' });

    const result = await resolveArtifactDeclarations([decl('Plans', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plans: [a, b] },
    });

    expect(result.Plans).toEqual([a, b]);
  });

  it('rejects an ArtifactRecord[] bound in scope when any record is from a different context', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    const b = record({
      runId: OTHER_CONTEXT_RUN,
      contextId: 'ctx2',
      key: 'b.json',
    });

    await expect(
      resolveArtifactDeclarations([decl('Plans', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plans: [a, b] },
      }),
    ).rejects.toThrow(/cross-context flow is not supported/);
  });

  it('resolves a URI string bound in scope against the manifest', async () => {
    const cwd = await tempCwd();
    const row = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'plan.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await touchArtifact(cwd, row);

    const result = await resolveArtifactDeclarations([decl('Plan', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plan: row.uri },
    });

    expect(result.Plan).toEqual(row);
  });

  it('resolves a URI[] bound in scope into ArtifactRecord[]', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    const b = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'b.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, a);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, b);
    await Promise.all([a, b].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations([decl('Plans', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plans: [a.uri, b.uri] },
    });

    expect(result.Plans).toEqual([a, b]);
  });

  it('resolves a JSON string URI array bound in scope into ArtifactRecord[]', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    const b = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'b.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, a);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, b);
    await Promise.all([a, b].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations([decl('Plans', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plans: JSON.stringify([a.uri, b.uri]) },
    });

    expect(result.Plans).toEqual([a, b]);
  });

  it('errors `unbound` when the variable is not present in scope', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      }),
    ).rejects.toThrow(/unbound/);
  });

  it('errors `unbound` when scopeVars is not provided at all', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/unbound/);
  });

  it('errors `not-an-artifact` when the bound value is not artifact-shaped', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plan: 42 },
      }),
    ).rejects.toThrow(/not-an-artifact/);
  });

  it('errors `unresolvable-uri` when the URI string does not parse', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plan: 'not-a-uri' },
      }),
    ).rejects.toThrow(/unresolvable-uri/);
  });

  it('errors `unresolvable-uri` when the URI parses but matches no manifest row', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plan: `rd://artifacts/${CONTEXT_ID}/*/missing.json` },
      }),
    ).rejects.toThrow(/unresolvable-uri/);
  });

  it('errors `partial-resolve` when one URI in a URI[] fails to resolve', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, a);
    await touchArtifact(cwd, a);

    await expect(
      resolveArtifactDeclarations([decl('Plans', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plans: [a.uri, `rd://artifacts/${CONTEXT_ID}/*/missing.json`] },
      }),
    ).rejects.toThrow(/partial-resolve/);
  });

  it('errors `partial-resolve` when one URI in a JSON string URI array fails to resolve', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, a);
    await touchArtifact(cwd, a);

    await expect(
      resolveArtifactDeclarations([decl('Plans', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {
          Plans: JSON.stringify([a.uri, `rd://artifacts/${CONTEXT_ID}/*/missing.json`]),
        },
      }),
    ).rejects.toThrow(/partial-resolve/);
  });

  it('does not accept JSON string arrays containing non-rd URI values as URI arrays', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plans', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plans: JSON.stringify([`rd://artifacts/${CONTEXT_ID}/*/plan.json`, 42]) },
      }),
    ).rejects.toThrow(/unresolvable-uri/);
  });
});

describe('resolveArtifactDeclarations — bare-key glob validation', () => {
  it('rejects bare-key globs with parent-traversal segments', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Reviews', '../foo*.json')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/wildcard_artifact_key|invalid glob/);
  });

  it('accepts a single-char bare-key glob (`?`) — no regression', async () => {
    const cwd = await tempCwd();
    const row = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-1.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await touchArtifact(cwd, row);

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-?.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual(row);
  });

  it('accepts a normal `*` bare-key glob — no regression after gating', async () => {
    const cwd = await tempCwd();
    const row = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-x.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await touchArtifact(cwd, row);

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual(row);
  });
});

describe('resolveArtifactDeclarations — parent dir creation error propagation', () => {
  it('propagates mkdir failure when the artifact parent path is blocked by a regular file', async () => {
    const cwd = await tempCwd();
    // Pre-create a regular file at the location the resolver expects to make
    // a directory (the per-run artifact directory). `mkdir(recursive: true)`
    // fails with ENOTDIR / EEXIST when an intermediate path component is a
    // non-directory regular file.
    const blocker = path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN);
    await fsp.mkdir(path.dirname(blocker), { recursive: true });
    await fsp.writeFile(blocker, 'not-a-dir');

    await expect(
      resolveArtifactDeclarations([decl('PlanPath', 'plan.json')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/ENOTDIR|EEXIST|not a directory|file already exists/i);

    // The manifest must NOT have an orphan row from a failed-mkdir producer:
    // a failed parent-dir creation must short-circuit before append.
    const manifestPath = path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, 'manifest.jsonl');
    await expect(fsp.stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
