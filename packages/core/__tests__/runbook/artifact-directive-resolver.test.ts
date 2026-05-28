import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactDeclaration } from '@rundown-org/parser';
import {
  appendArtifactManifestRecord,
  readArtifactManifest,
  resolveArtifactDeclarations,
} from '../../src/runbook/index.js';
import { toStateArtifactRecord } from '../../src/runbook/artifact-directive-resolver.js';
import type {
  ArtifactRecord,
  FileArtifactRecord,
  ManagedArtifactManifestRecord,
} from '../../src/runbook/artifact-schema.js';
import {
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
} from '../../src/runbook/effective-vars.js';
import type { RunId } from '../../src/runbook/run-id.js';
import {
  brandRunIdForTest,
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from '../../src/testing/effective-vars.js';

const CURRENT_RUN: RunId = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CHILD_RUN: RunId = brandRunIdForTest('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const OTHER_CONTEXT_RUN: RunId = brandRunIdForTest('rd_cccccccccccccccccccccccccccccccc');
const CONTEXT_ID = 'ctx1';
const WORK_PATH = '.rundown/work';
const RUNBOOK = { source: 'project' as const, path: 'planning/write-plan.runbook.md' };
const CHILD_RUNBOOK = { source: 'project' as const, path: 'planning/review.runbook.md' };

let tempDirs: string[] = [];
const originalProcessCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalProcessCwd);
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
  it('resolves an existing project file reference and records it in the manifest', async () => {
    const cwd = await tempCwd();
    await fsp.mkdir(path.join(cwd, 'schemas'), { recursive: true });
    const schemaPath = path.join(cwd, 'schemas', 'review.schema.json');
    await fsp.writeFile(schemaPath, '{}');
    const canonicalSchemaPath = await fsp.realpath(schemaPath);

    const result = await resolveArtifactDeclarations(
      [decl('ReviewSchemaPath', 'schemas/review.schema.json')],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      },
    );

    expect(result.ReviewSchemaPath).toMatchObject({
      kind: 'file-artifact-record',
      uri: pathToFileURL(canonicalSchemaPath).href,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      key: 'schemas/review.schema.json',
      runbook: RUNBOOK,
    });
    const manifest = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject(result.ReviewSchemaPath as Record<string, unknown>);
  });

  it('rejects a missing path-like file reference instead of treating it as managed output', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('ReviewSchemaPath', 'schemas/missing.schema.json')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/file reference|not found|missing/i);
  });

  it('resolves plugin file references when no project file matches', async () => {
    const cwd = await tempCwd();
    const pluginRoot = path.join(cwd, 'plugin');
    await fsp.mkdir(path.join(pluginRoot, 'schemas'), { recursive: true });
    const schemaPath = path.join(pluginRoot, 'schemas', 'review.schema.json');
    await fsp.writeFile(schemaPath, '{}');
    const canonicalSchemaPath = await fsp.realpath(schemaPath);

    const result = await resolveArtifactDeclarations(
      [decl('ReviewSchemaPath', 'schemas/review.schema.json')],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        fileArtifactSearchRoots: [pluginRoot],
      },
    );

    expect(result.ReviewSchemaPath).toMatchObject({
      kind: 'file-artifact-record',
      uri: pathToFileURL(canonicalSchemaPath).href,
      key: 'schemas/review.schema.json',
    });
  });

  it('prefers project file references over plugin file references', async () => {
    const cwd = await tempCwd();
    const pluginRoot = path.join(cwd, 'plugin');
    await fsp.mkdir(path.join(cwd, 'schemas'), { recursive: true });
    await fsp.mkdir(path.join(pluginRoot, 'schemas'), { recursive: true });
    const projectSchemaPath = path.join(cwd, 'schemas', 'review.schema.json');
    await fsp.writeFile(projectSchemaPath, '{"source":"project"}');
    await fsp.writeFile(
      path.join(pluginRoot, 'schemas', 'review.schema.json'),
      '{"source":"plugin"}',
    );
    const canonicalProjectSchemaPath = await fsp.realpath(projectSchemaPath);

    const result = await resolveArtifactDeclarations(
      [decl('ReviewSchemaPath', 'schemas/review.schema.json')],
      {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        fileArtifactSearchRoots: [pluginRoot],
      },
    );

    expect(result.ReviewSchemaPath).toMatchObject({
      kind: 'file-artifact-record',
      uri: pathToFileURL(canonicalProjectSchemaPath).href,
      key: 'schemas/review.schema.json',
    });
  });

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

  it('rejects path-like tokens that do not resolve to existing files', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('PlanPath', 'plans/plan.json')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/file reference|not found/i);
  });

  it('resolves an absolute file reference only when read policy allows it', async () => {
    const cwd = await tempCwd();
    const absolute = path.join(cwd, 'allowed.schema.json');
    await fsp.writeFile(absolute, '{}');
    const canonicalAbsolute = await fsp.realpath(absolute);

    const result = await resolveArtifactDeclarations([decl('Schema', absolute)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      allowFileArtifactRead: (candidate) => candidate === canonicalAbsolute,
    });

    expect(result.Schema).toMatchObject({
      kind: 'file-artifact-record',
      uri: pathToFileURL(canonicalAbsolute).href,
      key: absolute,
    });

    await expect(
      resolveArtifactDeclarations([decl('Schema', absolute)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        allowFileArtifactRead: () => false,
      }),
    ).rejects.toThrow(/policy|read/i);
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

  it('does not shadow a managed producer when a same-named file happens to exist at cwd', async () => {
    // Regression: a non-path-like bare token (no '/' or '\\') must dispatch to
    // the managed-artifact producer, not to the file-reference probe. If a
    // file of the same name happens to exist at the search root, the file
    // probe would otherwise silently override the producer intent.
    const cwd = await tempCwd();
    // Seed a real file at cwd whose name collides with a bare-key producer.
    await fsp.writeFile(path.join(cwd, 'plan.json'), '{}');

    const result = await resolveArtifactDeclarations([decl('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.PlanPath).toMatchObject({
      kind: 'artifact-record',
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      key: 'plan.json',
    });
  });

  it('returns the canonical manifest row when a producer write coalesces', async () => {
    const cwd = await tempCwd();
    const canonical = record({
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, canonical);

    const result = await resolveArtifactDeclarations([decl('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.PlanPath).toEqual(canonical);
  });

  it('falls through to managed producer for a bare token even when no file exists', async () => {
    // Pinning baseline: non-path-like bare tokens that do not resolve to any
    // file still flow to the managed-artifact producer (unchanged behaviour).
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([decl('PlanPath', 'plan.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.PlanPath).toMatchObject({
      kind: 'artifact-record',
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      key: 'plan.json',
    });
  });

  it('expands quoted tokens from runtime scope variables before classification', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([decl('PlanPath', '{{PlanKey}}')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { PlanKey: 'plan.json' },
    });

    expect(result.PlanPath).toMatchObject({
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      key: 'plan.json',
    });
  });

  it('dispatches an expanded template to the URI literal resolver', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([decl('Plan', '{{PlanUri}}')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: {
        PlanUri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      },
    });

    expect(result.Plan).toMatchObject({
      kind: 'artifact-record',
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      key: 'plan.json',
    });
  });

  it('dispatches an expanded template to the wildcard selector resolver', async () => {
    const cwd = await tempCwd();
    const row = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-plan-a.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await touchArtifact(cwd, row);

    const result = await resolveArtifactDeclarations([decl('Reviews', '{{ReviewGlob}}')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { ReviewGlob: 'review-*.json' },
    });

    expect(result.Reviews).toEqual(row);
  });

  it('dispatches an expanded template to the path-like file resolver', async () => {
    const cwd = await tempCwd();
    await fsp.mkdir(path.join(cwd, 'schemas'), { recursive: true });
    const schemaPath = path.join(cwd, 'schemas', 'review.schema.json');
    await fsp.writeFile(schemaPath, '{}');
    const canonicalSchemaPath = await fsp.realpath(schemaPath);

    const result = await resolveArtifactDeclarations([decl('Schema', '{{SchemaPath}}')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { SchemaPath: 'schemas/review.schema.json' },
    });

    expect(result.Schema).toMatchObject({
      kind: 'file-artifact-record',
      uri: pathToFileURL(canonicalSchemaPath).href,
      key: 'schemas/review.schema.json',
    });
  });

  it('rejects Windows-style absolute paths on POSIX before resolving against process cwd', async () => {
    if (process.platform === 'win32') return;

    const cwd = await tempCwd();
    const processCwd = await tempCwd();
    const windowsToken = 'C:\\tmp\\plan.json';
    await fsp.writeFile(path.join(processCwd, windowsToken), '{}');
    process.chdir(processCwd);
    let policyConsulted = false;

    await expect(
      resolveArtifactDeclarations([decl('Plan', windowsToken)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        allowFileArtifactRead: () => {
          policyConsulted = true;
          return true;
        },
      }),
    ).rejects.toThrow(/unsupported|absolute|platform/i);
    expect(policyConsulted).toBe(false);
  });

  it('rejects unresolved template markers after expansion', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plan', 'rd://{{Missing}}/file.yaml')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/unresolved template/i);
  });

  it('expands quoted tokens from dotted runtime scope variables', async () => {
    const cwd = await tempCwd();

    const result = await resolveArtifactDeclarations([decl('PlanPath', '{{item.key}}')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { item: { key: 'plan.json' } },
    });

    expect(result.PlanPath).toMatchObject({ key: 'plan.json' });
  });
});

describe('resolveArtifactDeclarations — symlink and traversal containment', () => {
  it('rejects a symlink under cwd whose target lies outside the search roots (Test A)', async () => {
    // The realpath + isPathInside guard in `resolveExistingFileReference` is
    // the load-bearing security boundary for the feature. A symlinked file
    // inside the search root whose realpath escapes the root MUST be rejected
    // as not-found, not silently resolved against the outside target.
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const outsideTarget = path.join(outside, 'secret.json');
    await fsp.writeFile(outsideTarget, '{}');
    await fsp.mkdir(path.join(cwd, 'links'), { recursive: true });
    const link = path.join(cwd, 'links', 'escape');
    try {
      await fsp.symlink(outsideTarget, link);
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

    await expect(
      resolveArtifactDeclarations([decl('Escape', 'links/escape')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
      }),
    ).rejects.toThrow(/file reference|not found/i);
  });

  it('rejects parent-traversal tokens without consulting allowFileArtifactRead (Test B)', async () => {
    // A relative path-like token containing `../..` is rejected by classifier
    // before file probing. The read-policy callable must never be invoked for
    // relative tokens — only for explicit absolute paths.
    const cwd = await tempCwd();
    let policyConsulted = false;

    await expect(
      resolveArtifactDeclarations([decl('Esc', '../../etc/passwd')], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        allowFileArtifactRead: () => {
          policyConsulted = true;
          return true;
        },
      }),
    ).rejects.toThrow(/dot|traversal|invalid token/i);
    expect(policyConsulted).toBe(false);
  });

  it('rejects absolute paths when allowFileArtifactRead is not supplied (Test C)', async () => {
    // Without a read-policy callable, an explicit absolute path must NOT be
    // silently allowed — it has no roots to contain it against.
    const cwd = await tempCwd();
    const target = path.join(cwd, 'allowed.json');
    await fsp.writeFile(target, '{}');

    await expect(
      resolveArtifactDeclarations([decl('Abs', target)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        // No allowFileArtifactRead supplied.
      }),
    ).rejects.toThrow(/policy|read|allowed/i);
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

  it('limits an unprefixed wildcard shorthand to current-run manifest rows', async () => {
    const cwd = await tempCwd();
    const current = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-current.json' });
    const child = record({ runId: CHILD_RUN, runbook: CHILD_RUNBOOK, key: 'review-child.json' });
    const otherContext = record({
      runId: OTHER_CONTEXT_RUN,
      contextId: 'ctx2',
      key: 'review-other.json',
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, current);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, child);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, otherContext);
    await Promise.all([current, child, otherContext].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations([decl('Reviews', 'review-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual(current);
    const manifest = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(manifest).toEqual(
      [current, child].sort((left, right) => left.uri.localeCompare(right.uri)),
    );
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
    ).rejects.toThrow(/selector_artifact_key|invalid|shorthand/);
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

    const result = await resolveArtifactDeclarations([decl('Reviews', '*/review-plan-*.json')], {
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

describe('resolveArtifactDeclarations — cross-run shorthand (*/key)', () => {
  it('resolves an exact-named artifact across runs in the current context', async () => {
    const cwd = await tempCwd();
    const parentRow = record({
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      key: 'end-to-end-test-review.json',
    });
    const childRow = record({
      runId: CHILD_RUN,
      runbook: CHILD_RUNBOOK,
      key: 'end-to-end-test-review.json',
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, parentRow);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, childRow);
    await Promise.all([parentRow, childRow].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations(
      [decl('Reviews', '*/end-to-end-test-review.json')],
      { cwd, workPath: WORK_PATH, contextId: CONTEXT_ID, runId: CURRENT_RUN, runbook: RUNBOOK },
    );

    expect(result.Reviews).toEqual(
      [parentRow, childRow].sort((l, r) => l.uri.localeCompare(r.uri)),
    );
  });

  it('returns identical records to the equivalent rd:// selector URI form', async () => {
    const cwd = await tempCwd();
    const parentRow = record({
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      key: 'end-to-end-test-review.json',
    });
    const childRow = record({
      runId: CHILD_RUN,
      runbook: CHILD_RUNBOOK,
      key: 'end-to-end-test-review.json',
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, parentRow);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, childRow);
    await Promise.all([parentRow, childRow].map((r) => touchArtifact(cwd, r)));

    const options = {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    };
    const shorthand = await resolveArtifactDeclarations(
      [decl('Reviews', '*/end-to-end-test-review.json')],
      options,
    );
    const uriForm = await resolveArtifactDeclarations(
      [decl('Reviews', `rd://artifacts/${CONTEXT_ID}/*/end-to-end-test-review.json`)],
      options,
    );

    expect(shorthand.Reviews).toEqual(uriForm.Reviews);
  });

  it('does NOT write a manifest row for a cross-run shorthand', async () => {
    const cwd = await tempCwd();
    const before = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(before).toHaveLength(0);

    await resolveArtifactDeclarations([decl('Reviews', '*/review.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    const after = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(after).toHaveLength(0);
  });

  it('matches a cross-run wildcard-key shorthand (*/review-*.json)', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-a.json' });
    const b = record({ runId: CHILD_RUN, runbook: CHILD_RUNBOOK, key: 'review-b.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, a);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, b);
    await Promise.all([a, b].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations([decl('Reviews', '*/review-*.json')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Reviews).toEqual([a, b].sort((l, r) => l.uri.localeCompare(r.uri)));
  });
});

describe('resolveArtifactDeclarations — file-reference manifest audit identity', () => {
  it('keeps two file rows with the same canonical URI but different raw tokens', async () => {
    // File-reference rows are audit records. Two declaration tokens can
    // normalise to the same canonical `file://` URI, but the raw declaration
    // token remains part of the manifest identity.
    const cwd = await tempCwd();
    const filePath = path.join(cwd, 'dir', 'x.md');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, '# x');
    const canonical = await fsp.realpath(filePath);
    const canonicalUri = pathToFileURL(canonical).href;

    const baseRow = {
      kind: 'file-artifact-record' as const,
      uri: canonicalUri,
      runId: CURRENT_RUN,
      contextId: CONTEXT_ID,
      runbook: RUNBOOK,
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    await appendArtifactManifestRecord(
      { cwd, workPath: WORK_PATH },
      { ...baseRow, key: 'dir/x.md' },
    );
    await appendArtifactManifestRecord(
      { cwd, workPath: WORK_PATH },
      { ...baseRow, key: 'dir/link.md', timestamp: '2026-05-07T01:00:00.000Z' },
    );

    const { coalesceManifestRecords, readArtifactManifest: readMan } = await import(
      '../../src/runbook/artifact-manifest.js'
    );
    const coalesced = coalesceManifestRecords(
      await readMan({ cwd, workPath: WORK_PATH }, CONTEXT_ID),
    );
    expect(coalesced).toHaveLength(2);
    expect(coalesced).toEqual([
      expect.objectContaining({ kind: 'file-artifact-record', key: 'dir/x.md', uri: canonicalUri }),
      expect.objectContaining({
        kind: 'file-artifact-record',
        key: 'dir/link.md',
        uri: canonicalUri,
      }),
    ]);
  });

  it('appends a second row when resolving the same file under two raw tokens', async () => {
    // Idempotency only applies to the same audit identity. Different raw
    // declaration tokens for the same canonical file must remain distinct.
    const cwd = await tempCwd();
    const dir = path.join(cwd, 'dir');
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'x.md');
    await fsp.writeFile(filePath, '# x');
    const linkPath = path.join(dir, 'link.md');
    try {
      await fsp.symlink(filePath, linkPath);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        await fsp.link(filePath, linkPath);
      } else {
        throw error;
      }
    }

    await resolveArtifactDeclarations([decl('X1', 'dir/x.md')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });
    await resolveArtifactDeclarations([decl('X2', 'dir/link.md')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    const raw = await readArtifactManifest({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    expect(raw).toHaveLength(2);
    expect(raw).toEqual([
      expect.objectContaining({ kind: 'file-artifact-record', key: 'dir/x.md' }),
      expect.objectContaining({ kind: 'file-artifact-record', key: 'dir/link.md' }),
    ]);
  });
});

describe('resolveArtifactDeclarations — selector excludes file records', () => {
  function fileRecord(overrides: Partial<FileArtifactRecord> = {}): FileArtifactRecord {
    const key = overrides.key ?? 'foo.json';
    const filePath = overrides.uri ?? pathToFileURL(path.join('/tmp/never-read', key)).href;
    return {
      kind: 'file-artifact-record',
      uri: filePath,
      runId: overrides.runId ?? CURRENT_RUN,
      contextId: overrides.contextId ?? CONTEXT_ID,
      runbook: overrides.runbook ?? RUNBOOK,
      key,
      timestamp: overrides.timestamp ?? '2026-05-07T00:00:00.000Z',
    };
  }

  it('does not match a file-artifact-record via a bare-key selector pattern (Test A)', async () => {
    // file records carry a declaration token in `key` (not a content-addressable
    // identifier). They MUST be skipped by selector matching so the picomatch
    // shape of the token cannot leak into selector semantics.
    const cwd = await tempCwd();
    const filePath = path.join(cwd, 'review.schema.json');
    await fsp.writeFile(filePath, '{}');
    const canonical = await fsp.realpath(filePath);
    const fileRow = fileRecord({
      key: 'review.schema.json',
      uri: pathToFileURL(canonical).href,
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, fileRow);

    // Selector `review*` would textually match `review.schema.json` if file
    // records were included in selector matching.
    const result = await resolveArtifactDeclarations([decl('Schemas', 'review*')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    expect(result.Schemas).toEqual([]);
  });

  it('returns only managed records when a selector spans a mixed manifest (Test C)', async () => {
    const cwd = await tempCwd();
    const managed = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-plan-a.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, managed);
    await touchArtifact(cwd, managed);

    // Seed a file record whose key would otherwise textually match `*`.
    const filePath = path.join(cwd, 'plan-bravo.json');
    await fsp.writeFile(filePath, '{}');
    const canonical = await fsp.realpath(filePath);
    const fileRow = fileRecord({
      key: 'plan-bravo.json',
      uri: pathToFileURL(canonical).href,
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, fileRow);

    const result = await resolveArtifactDeclarations([decl('Mixed', '*')], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
    });

    // Only the managed record survives selector matching; the file row is
    // excluded by kind.
    expect(result.Mixed).toEqual(managed);
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

  it('does not resolve an exact URI from partial managed identity collisions', async () => {
    const cwd = await tempCwd();
    const sameRunDifferentKey = record({
      runId: CHILD_RUN,
      runbook: CHILD_RUNBOOK,
      key: 'other.json',
    });
    const sameKeyDifferentRun = record({
      runId: OTHER_CONTEXT_RUN,
      runbook: CHILD_RUNBOOK,
      key: 'plan.json',
    });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, sameRunDifferentKey);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, sameKeyDifferentRun);
    await Promise.all(
      [sameRunDifferentKey, sameKeyDifferentRun].map((row) => touchArtifact(cwd, row)),
    );

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

  it('does not resolve an exact managed URI from a file artifact row', async () => {
    const cwd = await tempCwd();
    const filePath = path.join(cwd, 'plan.json');
    await fsp.writeFile(filePath, '{}');
    const fileRow: FileArtifactRecord = {
      kind: 'file-artifact-record',
      uri: pathToFileURL(await fsp.realpath(filePath)).href,
      runId: CHILD_RUN,
      contextId: CONTEXT_ID,
      runbook: CHILD_RUNBOOK,
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, fileRow);

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
    const trustedPlanRecord = brandTrustedArtifactRecordForTest(planRecord);

    const result = await resolveArtifactDeclarations([decl('Plan', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plan: trustedPlanRecord },
    });

    expect(result.Plan).toEqual(planRecord);
  });

  it('accepts naked ARTIFACTS when scope already contains an imported artifact record', async () => {
    const cwd = await tempCwd();
    const planRecord = record({
      runId: OTHER_CONTEXT_RUN,
      contextId: 'ctx2',
      key: 'plan.json',
    });
    const trustedPlanRecord = brandTrustedArtifactRecordForTest(planRecord);

    const result = await resolveArtifactDeclarations([decl('Plan', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plan: trustedPlanRecord },
    });

    expect(result.Plan).toEqual(planRecord);
  });

  it('passes through an ArtifactRecord[] bound in scope', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    const b = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'b.json' });
    const trustedRecords = brandTrustedArtifactArrayForTest([a, b]);

    const result = await resolveArtifactDeclarations([decl('Plans', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plans: trustedRecords },
    });

    expect(result.Plans).toEqual([a, b]);
  });

  it('accepts naked ARTIFACTS when scope already contains imported artifact records', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    const b = record({
      runId: OTHER_CONTEXT_RUN,
      contextId: 'ctx2',
      key: 'b.json',
    });
    const trustedRecords = brandTrustedArtifactArrayForTest([a, b]);

    const result = await resolveArtifactDeclarations([decl('Plans', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Plans: trustedRecords },
    });

    expect(result.Plans).toEqual([a, b]);
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

  it('rejects a naked unbranded artifact-shaped record bound in scope', async () => {
    const cwd = await tempCwd();
    const planRecord = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'plan.json' });

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plan: planRecord },
      }),
    ).rejects.toThrow(/not-an-artifact.*unverified/s);
  });

  it('rejects a naked unbranded artifact-shaped array bound in scope', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'a.json' });
    const b = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'b.json' });

    await expect(
      resolveArtifactDeclarations([decl('Plans', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plans: [a, b] },
      }),
    ).rejects.toThrow(/not-an-artifact.*unverified/s);
  });

  it('rehydrates a naked selector URI with multiple matches into a trusted array', async () => {
    const cwd = await tempCwd();
    const a = record({ runId: CURRENT_RUN, runbook: RUNBOOK, key: 'review-a.json' });
    const b = record({ runId: CHILD_RUN, runbook: CHILD_RUNBOOK, key: 'review-b.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, a);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, b);
    await Promise.all([a, b].map((r) => touchArtifact(cwd, r)));

    const result = await resolveArtifactDeclarations([decl('Reviews', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Reviews: `rd://artifacts/${CONTEXT_ID}/*/review-*.json` },
    });

    expect(isTrustedArtifactArray(result.Reviews)).toBe(true);
    expect(result.Reviews).toEqual([a, b].sort((left, right) => left.uri.localeCompare(right.uri)));
  });

  it('fails naked exact URI rehydration when the manifest has no matching row', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plan: `rd://artifacts/${CONTEXT_ID}/${CHILD_RUN}/missing.json` },
      }),
    ).rejects.toThrow(/unresolvable-uri/);
  });

  it('rehydrates a naked selector URI with exactly one match into one trusted record', async () => {
    const cwd = await tempCwd();
    const row = record({ runId: CHILD_RUN, runbook: CHILD_RUNBOOK, key: 'review-plan.json' });
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, row);
    await touchArtifact(cwd, row);

    const result = await resolveArtifactDeclarations([decl('Review', null)], {
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      runbook: RUNBOOK,
      scopeVars: { Review: `rd://artifacts/${CONTEXT_ID}/*/review-plan.json` },
    });

    expect(isTrustedArtifactRecord(result.Review)).toBe(true);
    expect(result.Review).toEqual(row);
  });

  it('rejects an empty JSON URI array string in naked ARTIFACTS scope', async () => {
    const cwd = await tempCwd();

    await expect(
      resolveArtifactDeclarations([decl('Plans', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plans: '[]' },
      }),
    ).rejects.toThrow(/not-an-artifact/);
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

  it('fails clearly for naked ARTIFACTS when scope contains an unresolved URI string', async () => {
    const cwd = await tempCwd();
    const uri = 'rd://artifacts/missing-context/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json';

    await expect(
      resolveArtifactDeclarations([decl('Plan', null)], {
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { Plan: uri },
      }),
    ).rejects.toThrow(/unresolvable-uri.*Plan/s);
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
    ).rejects.toThrow(/dot|traversal|invalid token|invalid glob/);
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

describe('toStateArtifactRecord — kind-spread guard', () => {
  const MANAGED_ROW: ManagedArtifactManifestRecord = {
    uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
    runId: CURRENT_RUN,
    contextId: CONTEXT_ID,
    runbook: RUNBOOK,
    key: 'plan.json',
    timestamp: '2026-05-07T00:00:00.000Z',
  };

  it('projects a managed manifest row (no kind) into a tagged state record', () => {
    const result = toStateArtifactRecord(MANAGED_ROW);
    expect(result).toEqual({ kind: 'artifact-record', ...MANAGED_ROW });
  });

  it('throws when the input carries any kind field (belt-and-braces guard)', () => {
    const polluted = {
      kind: 'file-artifact-record',
      ...MANAGED_ROW,
    } as unknown as ManagedArtifactManifestRecord;
    expect(() => toStateArtifactRecord(polluted)).toThrow(/managed manifest row without 'kind'/);
  });

  it('throws even when kind matches the target state discriminator', () => {
    const polluted = {
      kind: 'artifact-record',
      ...MANAGED_ROW,
    } as unknown as ManagedArtifactManifestRecord;
    expect(() => toStateArtifactRecord(polluted)).toThrow(/managed manifest row without 'kind'/);
  });
});
