import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ARTIFACT_ERROR_TEXT,
  formatArtifactManifestLineError,
} from '../../src/runbook/artifact-errors.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import {
  appendArtifactManifestRecord,
  appendArtifactManifestRecordSync,
  coalesceManifestRecords,
  findArtifactMatches,
  manifestPathForContext,
  readArtifactManifest,
} from '../../src/runbook/artifact-manifest.js';
import type { ArtifactPathOptions } from '../../src/runbook/artifact-uri.js';

const RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_RUN_ID = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const THIRD_RUN_ID = 'rd_cccccccccccccccccccccccccccccccc';

const record = {
  kind: 'artifact-record' as const,
  uri: `rd://artifacts/ctx1/${RUN_ID}/review.json`,
  runId: RUN_ID,
  contextId: 'ctx1',
  runbook: {
    source: 'plugin',
    path: 'planning/review/review-plan-risk-safety.runbook.md',
  },
  key: 'review.json',
  timestamp: '2026-05-04T03:15:24.000Z',
} satisfies ArtifactRecord;

const fileRecord = {
  kind: 'file-artifact-record' as const,
  uri: 'file:///tmp/rundown-audit-source.json',
  runId: RUN_ID,
  contextId: 'ctx1',
  runbook: {
    source: 'plugin',
    path: 'planning/review/review-plan-risk-safety.runbook.md',
  },
  key: './source.json',
  timestamp: '2026-05-04T03:15:24.000Z',
} satisfies ArtifactRecord;

const manifestRecord = {
  uri: record.uri,
  runId: record.runId,
  contextId: record.contextId,
  runbook: record.runbook,
  key: record.key,
  timestamp: record.timestamp,
};

function asManifestRecord(row: ArtifactRecord) {
  return {
    uri: row.uri,
    runId: row.runId,
    contextId: row.contextId,
    runbook: row.runbook,
    key: row.key,
    timestamp: row.timestamp,
  };
}

const optionsFor = (cwd: string): ArtifactPathOptions => ({ cwd, workPath: '.rundown/work' });
const manifestPath = (cwd: string, contextId = 'ctx1'): string =>
  path.join(cwd, '.rundown/work', `.rd-${contextId}`, 'manifest.jsonl');
const runDir = (cwd: string, contextId: string, runId: string): string =>
  path.join(cwd, '.rundown/work', `.rd-${contextId}`, runId);
const artifactFile = (cwd: string, contextId: string, runId: string): string =>
  path.join(runDir(cwd, contextId, runId), 'review.json');

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { force: true, recursive: true })));
  tempDirs = [];
});

async function tempCwd(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-manifest-'));
  tempDirs.push(cwd);
  return cwd;
}

function withRunId(runId: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  const key = overrides.key ?? record.key;
  const contextId = overrides.contextId ?? record.contextId;
  return {
    ...record,
    ...overrides,
    runId,
    contextId,
    key,
    uri: overrides.uri ?? `rd://artifacts/${contextId}/${runId}/${key}`,
  };
}

async function writeManifest(
  cwd: string,
  records: readonly unknown[],
  contextId = 'ctx1',
): Promise<void> {
  const file = manifestPath(cwd, contextId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${records.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

async function touchArtifact(cwd: string, row: ArtifactRecord): Promise<void> {
  const file = path.join(runDir(cwd, row.contextId, row.runId), row.key);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '{}');
}

function finderOptions(
  cwd: string,
  states: ReadonlyMap<string, { lifecycle?: string; terminalAt?: string } | null>,
) {
  return {
    ...optionsFor(cwd),
    loadRunState: async (runId: string) => states.get(runId) ?? null,
  };
}

describe('artifact manifest storage', () => {
  it('builds context manifest paths and rejects unsafe context ids', () => {
    expect(manifestPathForContext(optionsFor('/repo'), 'ctx1')).toBe(
      path.join('/repo', '.rundown/work', '.rd-ctx1', 'manifest.jsonl'),
    );
    expect(() => manifestPathForContext(optionsFor('/repo'), '../escape')).toThrow(
      /Invalid contextId/,
    );
    expect(() => manifestPathForContext(optionsFor('/repo'), 'ctx/slash')).toThrow(
      /Invalid contextId/,
    );
  });

  it('appends one JSONL record asynchronously', async () => {
    const cwd = await tempCwd();

    await appendArtifactManifestRecord(optionsFor(cwd), record);

    await expect(fsp.readFile(manifestPath(cwd), 'utf8')).resolves.toBe(
      `${JSON.stringify(manifestRecord)}\n`,
    );
  });

  it('reads documented six-field manifest rows without requiring kind', async () => {
    const cwd = await tempCwd();
    await writeManifest(cwd, [manifestRecord]);

    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).resolves.toEqual([record]);
  });

  it('appends one JSONL record synchronously', async () => {
    const cwd = await tempCwd();

    appendArtifactManifestRecordSync(optionsFor(cwd), record);

    await expect(fsp.readFile(manifestPath(cwd), 'utf8')).resolves.toBe(
      `${JSON.stringify(manifestRecord)}\n`,
    );
  });

  it('appendArtifactManifestRecord is idempotent on equivalent identities', async () => {
    // Issue 2 regression: re-entries through __parent-entry::* re-run the
    // producer resolver. Without write-layer idempotency every retry/PASS/
    // GOTO/RETRY/NEXT/BREAK traversal would multiply manifest rows for the
    // same `(uri, contextId, runId, key, runbook)` identity. Equivalence
    // is defined WITHOUT `timestamp` — the pre-existing row's timestamp
    // wins so downstream coalescing sees stable output.
    const cwd = await tempCwd();
    const later = { ...record, timestamp: '2026-05-04T04:15:24.000Z' };

    const first = await appendArtifactManifestRecord(optionsFor(cwd), record);
    const second = await appendArtifactManifestRecord(optionsFor(cwd), later);

    expect(first).toEqual(manifestRecord);
    expect(second).toEqual(manifestRecord);
    await expect(fsp.readFile(manifestPath(cwd), 'utf8')).resolves.toBe(
      `${JSON.stringify(manifestRecord)}\n`,
    );
    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).resolves.toEqual([record]);
  });

  it('appendArtifactManifestRecordSync is idempotent on equivalent identities', async () => {
    const cwd = await tempCwd();
    const later = { ...record, timestamp: '2026-05-04T04:15:24.000Z' };

    const firstSync = appendArtifactManifestRecordSync(optionsFor(cwd), record);
    const secondSync = appendArtifactManifestRecordSync(optionsFor(cwd), later);

    expect(firstSync).toEqual(manifestRecord);
    expect(secondSync).toEqual(manifestRecord);
    await expect(fsp.readFile(manifestPath(cwd), 'utf8')).resolves.toBe(
      `${JSON.stringify(manifestRecord)}\n`,
    );
  });

  it('appendArtifactManifestRecord is safe under concurrent writes to same identity', async () => {
    // Concurrency regression: multiple simultaneous appends of equivalent records
    // must result in a single persisted row. Lock-protected idempotency check
    // prevents both writers from missing the existing row and both appending.
    const cwd = await tempCwd();
    const later = { ...record, timestamp: '2026-05-04T04:15:24.000Z' };
    const muchLater = { ...record, timestamp: '2026-05-04T05:15:24.000Z' };

    const promises = await Promise.all([
      appendArtifactManifestRecord(optionsFor(cwd), record),
      appendArtifactManifestRecord(optionsFor(cwd), later),
      appendArtifactManifestRecord(optionsFor(cwd), muchLater),
    ]);

    // All concurrent callers must receive the same canonical row (whichever was first)
    const [first, second, third] = promises;
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // Manifest file must contain exactly one row
    const manifestContent = await fsp.readFile(manifestPath(cwd), 'utf8');
    const lines = manifestContent.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    // Read-back must return the single row with the timestamp from the first writer
    const readBack = await readArtifactManifest(optionsFor(cwd), 'ctx1');
    expect(readBack).toHaveLength(1);
    expect(readBack[0].timestamp).toEqual(first.timestamp);
  });

  it('appendArtifactManifestRecord still appends rows with distinct identities', async () => {
    const cwd = await tempCwd();
    const different = withRunId(SECOND_RUN_ID, {
      timestamp: '2026-05-04T04:15:24.000Z',
    });

    await appendArtifactManifestRecord(optionsFor(cwd), record);
    await appendArtifactManifestRecord(optionsFor(cwd), different);

    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).resolves.toEqual([
      record,
      different,
    ]);
  });

  it('sync appends newline-delimited JSONL and reads records back', async () => {
    const cwd = await tempCwd();
    const secondRecord = withRunId(SECOND_RUN_ID, {
      timestamp: '2026-05-04T04:15:24.000Z',
    });

    appendArtifactManifestRecordSync(optionsFor(cwd), record);
    appendArtifactManifestRecordSync(optionsFor(cwd), secondRecord);

    await expect(fsp.readFile(manifestPath(cwd), 'utf8')).resolves.toBe(
      `${JSON.stringify(manifestRecord)}\n${JSON.stringify(asManifestRecord(secondRecord))}\n`,
    );
    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).resolves.toEqual([
      record,
      secondRecord,
    ]);
  });

  it('coalesces duplicate context, run, and key records by newest timestamp', () => {
    const newer = { ...record, timestamp: '2026-05-04T04:15:24.000Z' };

    expect(coalesceManifestRecords([record, newer])).toEqual([newer]);
  });

  it('keeps the newest duplicate even when it appears before an older row', () => {
    const newer = { ...record, timestamp: '2026-05-04T04:15:24.000Z' };
    const older = { ...record, timestamp: '2026-05-04T03:15:24.000Z' };

    const result = coalesceManifestRecords([newer, older]);

    expect(result).toEqual([newer]);
    expect(result[0]).toBe(newer);
  });

  it('does not coalesce identities that only collide without field separators', () => {
    const first = withRunId(RUN_ID, {
      runbook: { source: 'plugin', path: 'a.md' },
      key: 'b.md-c',
    });
    const second = withRunId(RUN_ID, {
      runbook: { source: 'plugin', path: 'a.mdb.md' },
      key: '-c',
      timestamp: '2026-05-04T04:15:24.000Z',
    });

    expect(coalesceManifestRecords([first, second])).toEqual([first, second]);
  });

  it('does not coalesce records from different runbook refs', () => {
    const sameRunAndKeyDifferentRunbook = withRunId(RUN_ID, {
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      timestamp: '2026-05-04T04:15:24.000Z',
    });

    expect(coalesceManifestRecords([record, sameRunAndKeyDifferentRunbook])).toEqual([
      record,
      sameRunAndKeyDifferentRunbook,
    ]);
  });

  it('breaks coalescing timestamp ties by later manifest row', () => {
    const first = withRunId(RUN_ID, { timestamp: '2026-05-04T03:15:24.000Z' });
    const later = withRunId(RUN_ID, {
      timestamp: '2026-05-04T03:15:24.000Z',
      uri: first.uri,
    });

    const result = coalesceManifestRecords([first, later]);
    expect(result).toEqual([later]);
    expect(result[0]).toBe(later);
  });

  it('keeps file records distinct when raw declaration keys differ', () => {
    const sameFileDifferentKey = {
      ...fileRecord,
      key: './nested/../source.json',
      timestamp: '2026-05-04T04:15:24.000Z',
    };

    expect(coalesceManifestRecords([fileRecord, sameFileDifferentKey])).toEqual([
      fileRecord,
      sameFileDifferentKey,
    ]);
  });

  it('keeps file records distinct when run ids differ', () => {
    const sameFileDifferentRun = {
      ...fileRecord,
      runId: SECOND_RUN_ID,
      timestamp: '2026-05-04T04:15:24.000Z',
    };

    expect(coalesceManifestRecords([fileRecord, sameFileDifferentRun])).toEqual([
      fileRecord,
      sameFileDifferentRun,
    ]);
  });

  it('coalesces file records only when run id, key, and uri all match', () => {
    const newer = { ...fileRecord, timestamp: '2026-05-04T04:15:24.000Z' };

    expect(coalesceManifestRecords([fileRecord, newer])).toEqual([newer]);
  });

  it('skips duplicate file-row appends only for the same audit identity', async () => {
    const cwd = await tempCwd();
    const sameIdentityNewer = {
      ...fileRecord,
      timestamp: '2026-05-04T04:15:24.000Z',
    };
    const differentKey = {
      ...fileRecord,
      key: './nested/../source.json',
      timestamp: '2026-05-04T05:15:24.000Z',
    };
    const differentRun = {
      ...fileRecord,
      runId: SECOND_RUN_ID,
      timestamp: '2026-05-04T06:15:24.000Z',
    };

    appendArtifactManifestRecordSync(optionsFor(cwd), fileRecord);
    appendArtifactManifestRecordSync(optionsFor(cwd), sameIdentityNewer);
    appendArtifactManifestRecordSync(optionsFor(cwd), differentKey);
    appendArtifactManifestRecordSync(optionsFor(cwd), differentRun);

    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).resolves.toEqual([
      fileRecord,
      differentKey,
      differentRun,
    ]);
  });

  it('returns an empty manifest for missing, empty, and whitespace-only files', async () => {
    const missingCwd = await tempCwd();
    await expect(readArtifactManifest(optionsFor(missingCwd), 'ctx1')).resolves.toEqual([]);

    const emptyCwd = await tempCwd();
    await fsp.mkdir(path.dirname(manifestPath(emptyCwd)), { recursive: true });
    await fsp.writeFile(manifestPath(emptyCwd), '');
    await expect(readArtifactManifest(optionsFor(emptyCwd), 'ctx1')).resolves.toEqual([]);

    const whitespaceCwd = await tempCwd();
    await fsp.mkdir(path.dirname(manifestPath(whitespaceCwd)), { recursive: true });
    await fsp.writeFile(manifestPath(whitespaceCwd), ' \n\t\n');
    await expect(readArtifactManifest(optionsFor(whitespaceCwd), 'ctx1')).resolves.toEqual([]);
  });

  it('throws a line error for non-JSON manifest lines', async () => {
    const cwd = await tempCwd();
    const file = manifestPath(cwd);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(record)}\nnot-json\n`);

    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).rejects.toThrow(
      formatArtifactManifestLineError(file, 2, ARTIFACT_ERROR_TEXT.INVALID_MANIFEST_JSON),
    );
  });

  it('throws a line error for URI and context mismatches', async () => {
    const cwd = await tempCwd();
    const file = manifestPath(cwd);
    await writeManifest(cwd, [{ ...record, contextId: 'ctx2' }]);

    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).rejects.toThrow(
      formatArtifactManifestLineError(file, 1, ARTIFACT_ERROR_TEXT.URI_CONTEXT_MISMATCH),
    );
  });

  it('throws a line error for records stored in the wrong context manifest', async () => {
    const cwd = await tempCwd();
    const file = manifestPath(cwd);
    const otherContext = withRunId(RUN_ID, { contextId: 'ctx2' });
    await writeManifest(cwd, [otherContext], 'ctx1');

    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).rejects.toThrow(
      formatArtifactManifestLineError(file, 1, ARTIFACT_ERROR_TEXT.INVALID_MANIFEST_RECORD),
    );
  });

  it('throws a line error for JSON records missing required fields', async () => {
    const cwd = await tempCwd();
    const file = manifestPath(cwd);
    await writeManifest(cwd, [{ uri: record.uri }]);

    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).rejects.toThrow(
      formatArtifactManifestLineError(file, 1, ARTIFACT_ERROR_TEXT.INVALID_MANIFEST_RECORD),
    );
  });

  it('rejects invalid append records before writing', async () => {
    const cwd = await tempCwd();
    const options = optionsFor(cwd);

    expect(() => {
      appendArtifactManifestRecordSync(options, { ...record, contextId: '../escape' });
    }).toThrow(/Invalid contextId/);
    await expect(
      appendArtifactManifestRecord(options, { ...record, contextId: 'ctx/slash' }),
    ).rejects.toThrow(/Invalid contextId/);
    expect(() => {
      appendArtifactManifestRecordSync(options, { ...record, runId: SECOND_RUN_ID });
    }).toThrow(ARTIFACT_ERROR_TEXT.URI_RUN_ID_MISMATCH);
    await expect(
      appendArtifactManifestRecord(options, {
        ...record,
        key: 'nested/review.json',
        uri: `rd://artifacts/ctx1/${RUN_ID}/${encodeURIComponent('nested/review.json')}`,
      }),
    ).rejects.toThrow(/Invalid ArtifactKey/);
    await expect(readArtifactManifest(options, '../escape')).rejects.toThrow(/Invalid contextId/);
    expect(fs.existsSync(manifestPath(cwd))).toBe(false);
  });

  it('rejects symlinked manifest context directories', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const workRoot = path.join(cwd, '.rundown/work');
    await fsp.mkdir(workRoot, { recursive: true });
    try {
      await fsp.symlink(outside, path.join(workRoot, '.rd-ctx1'), 'dir');
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

    expect(() => {
      appendArtifactManifestRecordSync(optionsFor(cwd), record);
    }).toThrow(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
    expect(fs.existsSync(path.join(outside, 'manifest.jsonl'))).toBe(false);
  });

  it('rejects symlinked work roots before writing manifests', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    await fsp.mkdir(path.join(cwd, '.rundown'), { recursive: true });
    try {
      await fsp.symlink(outside, path.join(cwd, '.rundown/work'), 'dir');
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

    expect(() => {
      appendArtifactManifestRecordSync(optionsFor(cwd), record);
    }).toThrow(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);
    expect(fs.existsSync(path.join(outside, '.rd-ctx1/manifest.jsonl'))).toBe(false);
  });
});

describe('artifact selector resolution', () => {
  it('filters selector matches by exact runbook, completed status, file existence, and latest', async () => {
    const cwd = await tempCwd();
    const older = withRunId(SECOND_RUN_ID, {
      timestamp: '2026-05-04T03:20:24.000Z',
    });
    const newer = withRunId(THIRD_RUN_ID, {
      timestamp: '2026-05-04T03:25:24.000Z',
    });
    const wrongRunbook = withRunId('rd_dddddddddddddddddddddddddddddddd', {
      runbook: { source: 'plugin', path: 'ops/deploy.runbook.md' },
      timestamp: '2026-05-04T03:30:24.000Z',
    });
    const incomplete = withRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', {
      timestamp: '2026-05-04T03:35:24.000Z',
    });
    const missingFile = withRunId('rd_ffffffffffffffffffffffffffffffff', {
      timestamp: '2026-05-04T03:40:24.000Z',
    });
    await writeManifest(cwd, [older, newer, wrongRunbook, incomplete, missingFile]);
    await Promise.all(
      [older, newer, wrongRunbook, incomplete].map((row) => touchArtifact(cwd, row)),
    );

    const states = new Map([
      [older.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T04:00:00.000Z' }],
      [newer.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T05:00:00.000Z' }],
      [wrongRunbook.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T06:00:00.000Z' }],
      [incomplete.runId, { lifecycle: 'active', terminalAt: '2026-05-04T07:00:00.000Z' }],
      [missingFile.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T08:00:00.000Z' }],
    ]);

    await expect(
      findArtifactMatches(
        `rd://artifacts/ctx1/*/review.json?runbook=${encodeURIComponent('planning/review/review-plan-risk-safety.runbook.md')}&latest=true`,
        finderOptions(cwd, states),
      ),
    ).resolves.toEqual([
      {
        record: newer,
        path: artifactFile(cwd, newer.contextId, newer.runId),
        terminalAt: '2026-05-04T05:00:00.000Z',
      },
    ]);
  });

  it('breaks latest manifest timestamp ties by highest lexicographic URI', async () => {
    const cwd = await tempCwd();
    const lower = withRunId(RUN_ID, { timestamp: '2026-05-04T03:20:24.000Z' });
    const higher = withRunId(SECOND_RUN_ID, { timestamp: '2026-05-04T03:20:24.000Z' });
    await writeManifest(cwd, [lower, higher]);
    await Promise.all([lower, higher].map((row) => touchArtifact(cwd, row)));
    const terminalAt = '2026-05-04T05:00:00.000Z';

    await expect(
      findArtifactMatches(
        'rd://artifacts/ctx1/*/review.json?latest=true',
        finderOptions(
          cwd,
          new Map([
            [lower.runId, { lifecycle: 'completed', terminalAt }],
            [higher.runId, { lifecycle: 'completed', terminalAt }],
          ]),
        ),
      ),
    ).resolves.toMatchObject([{ record: higher, terminalAt }]);
  });

  it('uses URI tie-breaker when accepted latest timestamp strings represent the same instant', async () => {
    const cwd = await tempCwd();
    const lower = withRunId(RUN_ID, {
      timestamp: '2026-05-04T03:20:24Z',
    });
    const higher = withRunId(SECOND_RUN_ID, {
      timestamp: '2026-05-04T03:20:24.000Z',
    });
    await writeManifest(cwd, [lower, higher]);
    await Promise.all([lower, higher].map((row) => touchArtifact(cwd, row)));

    await expect(
      findArtifactMatches(
        'rd://artifacts/ctx1/*/review.json?latest=true',
        finderOptions(
          cwd,
          new Map([
            [lower.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T04:00:00.000Z' }],
            [higher.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T05:00:00.000Z' }],
          ]),
        ),
      ),
    ).resolves.toMatchObject([{ record: higher, terminalAt: '2026-05-04T05:00:00.000Z' }]);
  });

  it('keeps the latest completed run per runbook source, runbook path, and key', async () => {
    const cwd = await tempCwd();
    const pluginOlder = withRunId(RUN_ID);
    const pluginNewer = withRunId(SECOND_RUN_ID, {
      timestamp: '2026-05-04T03:20:24.000Z',
    });
    const projectLatest = withRunId(THIRD_RUN_ID, {
      runbook: { source: 'project', path: record.runbook.path },
      timestamp: '2026-05-04T03:25:24.000Z',
    });
    await writeManifest(cwd, [pluginOlder, pluginNewer, projectLatest]);
    await Promise.all(
      [pluginOlder, pluginNewer, projectLatest].map((row) => touchArtifact(cwd, row)),
    );

    const matches = await findArtifactMatches(
      'rd://artifacts/ctx1/*/review.json?latest=true',
      finderOptions(
        cwd,
        new Map([
          [pluginOlder.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T04:00:00.000Z' }],
          [pluginNewer.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T05:00:00.000Z' }],
          [projectLatest.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T06:00:00.000Z' }],
        ]),
      ),
    );

    expect(matches.map((match) => match.record)).toEqual([pluginNewer, projectLatest]);
  });

  it('keeps distinct latest groups that share one artifact URI', async () => {
    const cwd = await tempCwd();
    const firstRunbook = withRunId(RUN_ID, {
      runbook: { source: 'plugin', path: 'planning/review-a.runbook.md' },
      timestamp: '2026-05-04T03:20:24.000Z',
    });
    const secondRunbook = withRunId(RUN_ID, {
      runbook: { source: 'plugin', path: 'planning/review-b.runbook.md' },
      timestamp: '2026-05-04T03:25:24.000Z',
    });
    await writeManifest(cwd, [firstRunbook, secondRunbook]);
    await touchArtifact(cwd, firstRunbook);
    const terminalAt = '2026-05-04T05:00:00.000Z';

    const matches = await findArtifactMatches(
      'rd://artifacts/ctx1/*/review.json?latest=true',
      finderOptions(cwd, new Map([[RUN_ID, { lifecycle: 'completed', terminalAt }]])),
    );

    expect(matches).toMatchObject([
      { record: firstRunbook, terminalAt },
      { record: secondRunbook, terminalAt },
    ]);
  });

  it('filters repeated runbook and source query params as OR selectors', async () => {
    const cwd = await tempCwd();
    const pluginMatch = withRunId(RUN_ID);
    const projectMatch = withRunId(SECOND_RUN_ID, {
      runbook: { source: 'project', path: 'ops/deploy1.runbook.md' },
      timestamp: '2026-05-04T03:20:24.000Z',
    });
    const bundledMiss = withRunId(THIRD_RUN_ID, {
      runbook: { source: 'bundled', path: 'planning/review/review-plan-risk-safety.runbook.md' },
      timestamp: '2026-05-04T03:25:24.000Z',
    });
    await writeManifest(cwd, [pluginMatch, projectMatch, bundledMiss]);
    await Promise.all(
      [pluginMatch, projectMatch, bundledMiss].map((row) => touchArtifact(cwd, row)),
    );
    const states = new Map(
      [pluginMatch, projectMatch, bundledMiss].map((row) => [
        row.runId,
        { lifecycle: 'completed', terminalAt: '2026-05-04T05:00:00.000Z' },
      ]),
    );

    const matches = await findArtifactMatches(
      `rd://artifacts/ctx1/*/review.json?runbook=${encodeURIComponent('planning/review/review-plan-risk-safety.runbook.md')}&runbook=${encodeURIComponent('ops/deploy1.runbook.md')}&source=plugin&source=project`,
      finderOptions(cwd, states),
    );

    expect(matches.map((match) => match.record)).toEqual([pluginMatch, projectMatch]);
  });

  it('filters selector matches by created timestamp using strict bounds', async () => {
    const cwd = await tempCwd();
    const beforeLowerBound = withRunId(RUN_ID, {
      key: 'review-a.json',
      timestamp: '2026-05-04T03:59:59.999Z',
    });
    const onLowerBound = withRunId(SECOND_RUN_ID, {
      key: 'review-b.json',
      timestamp: '2026-05-04T04:00:00.000Z',
    });
    const insideWindow = withRunId(THIRD_RUN_ID, {
      key: 'review-c.json',
      timestamp: '2026-05-04T04:30:00.000Z',
    });
    const onUpperBound = withRunId('rd_dddddddddddddddddddddddddddddddd', {
      key: 'review-d.json',
      timestamp: '2026-05-04T05:00:00.000Z',
    });
    await writeManifest(cwd, [beforeLowerBound, onLowerBound, insideWindow, onUpperBound]);
    await Promise.all(
      [beforeLowerBound, onLowerBound, insideWindow, onUpperBound].map((row) =>
        touchArtifact(cwd, row),
      ),
    );
    const states = new Map(
      [beforeLowerBound, onLowerBound, insideWindow, onUpperBound].map((row) => [
        row.runId,
        { lifecycle: 'completed', terminalAt: '2026-05-04T06:00:00.000Z' },
      ]),
    );

    const matches = await findArtifactMatches(
      `rd://artifacts/ctx1/*/review-*.json?createdAfter=${encodeURIComponent('2026-05-04T04:00:00.000Z')}&createdBefore=${encodeURIComponent('2026-05-04T05:00:00.000Z')}`,
      finderOptions(cwd, states),
    );

    expect(matches.map((match) => match.record)).toEqual([insideWindow]);
  });

  it('filters selector matches by modified time before applying latest', async () => {
    const cwd = await tempCwd();
    const newerCreatedOlderModified = withRunId(RUN_ID, {
      timestamp: '2026-05-04T05:00:00.000Z',
    });
    const olderCreatedNewerModified = withRunId(SECOND_RUN_ID, {
      timestamp: '2026-05-04T04:00:00.000Z',
    });
    const onUpperModifiedBound = withRunId(THIRD_RUN_ID, {
      timestamp: '2026-05-04T06:00:00.000Z',
    });
    await writeManifest(cwd, [
      newerCreatedOlderModified,
      olderCreatedNewerModified,
      onUpperModifiedBound,
    ]);
    await Promise.all(
      [newerCreatedOlderModified, olderCreatedNewerModified, onUpperModifiedBound].map((row) =>
        touchArtifact(cwd, row),
      ),
    );
    await fsp.utimes(
      artifactFile(cwd, newerCreatedOlderModified.contextId, newerCreatedOlderModified.runId),
      new Date('2026-05-04T03:30:00.000Z'),
      new Date('2026-05-04T03:30:00.000Z'),
    );
    await fsp.utimes(
      artifactFile(cwd, olderCreatedNewerModified.contextId, olderCreatedNewerModified.runId),
      new Date('2026-05-04T04:30:00.000Z'),
      new Date('2026-05-04T04:30:00.000Z'),
    );
    await fsp.utimes(
      artifactFile(cwd, onUpperModifiedBound.contextId, onUpperModifiedBound.runId),
      new Date('2026-05-04T05:00:00.000Z'),
      new Date('2026-05-04T05:00:00.000Z'),
    );
    const states = new Map(
      [newerCreatedOlderModified, olderCreatedNewerModified, onUpperModifiedBound].map((row) => [
        row.runId,
        { lifecycle: 'completed', terminalAt: '2026-05-04T06:00:00.000Z' },
      ]),
    );

    const matches = await findArtifactMatches(
      `rd://artifacts/ctx1/*/review.json?modifiedAfter=${encodeURIComponent('2026-05-04T04:00:00.000Z')}&modifiedBefore=${encodeURIComponent('2026-05-04T05:00:00.000Z')}&latest=true`,
      finderOptions(cwd, states),
    );

    expect(matches.map((match) => match.record)).toEqual([olderCreatedNewerModified]);
  });

  it('matches wildcard-key selector URIs', async () => {
    const cwd = await tempCwd();
    const review = withRunId(RUN_ID, { key: 'review-a.json' });
    const notes = withRunId(SECOND_RUN_ID, { key: 'notes.json' });
    await writeManifest(cwd, [review, notes]);
    await Promise.all([review, notes].map((row) => touchArtifact(cwd, row)));
    const terminalAt = '2026-05-04T05:00:00.000Z';

    const matches = await findArtifactMatches(
      'rd://artifacts/ctx1/*/review-*.json?source=plugin',
      finderOptions(
        cwd,
        new Map([
          [review.runId, { lifecycle: 'completed', terminalAt }],
          [notes.runId, { lifecycle: 'completed', terminalAt }],
        ]),
      ),
    );

    expect(matches).toMatchObject([{ record: review, terminalAt }]);
  });

  it('filters concrete-run selectors with query params by that run id', async () => {
    const cwd = await tempCwd();
    const first = withRunId(RUN_ID);
    const second = withRunId(SECOND_RUN_ID, { timestamp: '2026-05-04T03:20:24.000Z' });
    await writeManifest(cwd, [first, second]);
    await Promise.all([first, second].map((row) => touchArtifact(cwd, row)));
    const states = new Map(
      [first, second].map((row) => [
        row.runId,
        { lifecycle: 'completed', terminalAt: '2026-05-04T05:00:00.000Z' },
      ]),
    );

    await expect(
      findArtifactMatches(
        `rd://artifacts/ctx1/${SECOND_RUN_ID}/review.json?source=plugin`,
        finderOptions(cwd, states),
      ),
    ).resolves.toMatchObject([{ record: second }]);
  });

  it('excludes non-completed runs', async () => {
    const cwd = await tempCwd();
    await writeManifest(cwd, [record]);
    await touchArtifact(cwd, record);
    const states = new Map([
      [record.runId, { lifecycle: 'active', terminalAt: '2026-05-04T05:00:00.000Z' }],
    ]);

    await expect(
      findArtifactMatches('rd://artifacts/ctx1/*/review.json', finderOptions(cwd, states)),
    ).resolves.toEqual([]);
  });

  it('rejects exact artifact URIs passed to selector matching', async () => {
    const cwd = await tempCwd();

    await expect(findArtifactMatches(record.uri, finderOptions(cwd, new Map()))).rejects.toThrow(
      ARTIFACT_ERROR_TEXT.EXACT_URI_NOT_SELECTOR,
    );
  });

  it('does not match records from another context', async () => {
    const cwd = await tempCwd();
    const otherContext = withRunId(RUN_ID, {
      contextId: 'ctx2',
      uri: `rd://artifacts/ctx2/${RUN_ID}/review.json`,
    });
    await writeManifest(cwd, [otherContext], 'ctx2');
    await touchArtifact(cwd, otherContext);

    await expect(
      findArtifactMatches(
        'rd://artifacts/ctx1/*/review.json',
        finderOptions(
          cwd,
          new Map([
            [
              otherContext.runId,
              { lifecycle: 'completed', terminalAt: '2026-05-04T05:00:00.000Z' },
            ],
          ]),
        ),
      ),
    ).resolves.toEqual([]);
  });

  it('skips records with missing artifact files or missing run state', async () => {
    const cwd = await tempCwd();
    const missingState = withRunId(RUN_ID);
    const missingArtifact = withRunId(SECOND_RUN_ID, { timestamp: '2026-05-04T03:20:24.000Z' });
    await writeManifest(cwd, [missingState, missingArtifact]);
    await touchArtifact(cwd, missingState);

    await expect(
      findArtifactMatches(
        'rd://artifacts/ctx1/*/review.json',
        finderOptions(
          cwd,
          new Map([
            [
              missingArtifact.runId,
              { lifecycle: 'completed', terminalAt: '2026-05-04T05:00:00.000Z' },
            ],
          ]),
        ),
      ),
    ).resolves.toEqual([]);
  });

  it('skips symlinked artifact files', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const target = path.join(outside, 'review.json');
    await fsp.writeFile(target, '{}');
    await writeManifest(cwd, [record]);
    await fsp.mkdir(path.dirname(artifactFile(cwd, record.contextId, record.runId)), {
      recursive: true,
    });
    try {
      await fsp.symlink(target, artifactFile(cwd, record.contextId, record.runId));
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
      findArtifactMatches(
        'rd://artifacts/ctx1/*/review.json',
        finderOptions(
          cwd,
          new Map([
            [record.runId, { lifecycle: 'completed', terminalAt: '2026-05-04T05:00:00.000Z' }],
          ]),
        ),
      ),
    ).resolves.toEqual([]);
  });
});

describe('isExistingRegularArtifactFile — file URI containment', () => {
  it('returns true for a real regular file inside cwd (baseline)', async () => {
    const { isExistingRegularArtifactFile } = await import(
      '../../src/runbook/artifact-manifest.js'
    );
    const { pathToFileURL } = await import('node:url');
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'art-existing-'));
    tempDirs.push(cwd);
    const filePath = path.join(cwd, 'x.json');
    await fsp.writeFile(filePath, '{}');
    const canonical = await fsp.realpath(filePath);
    expect(
      isExistingRegularArtifactFile(pathToFileURL(canonical).href, {
        cwd,
        workPath: '.rundown/work',
        fileArtifactSearchRoots: [cwd],
      }),
    ).toBe(true);
  });

  it('returns false for a file URI whose realpath is outside the configured search roots', async () => {
    const { isExistingRegularArtifactFile } = await import(
      '../../src/runbook/artifact-manifest.js'
    );
    const { pathToFileURL } = await import('node:url');
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'art-existing-cwd-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'art-existing-outside-'));
    tempDirs.push(cwd, outside);
    const filePath = path.join(outside, 'secret.json');
    await fsp.writeFile(filePath, '{}');
    const canonical = await fsp.realpath(filePath);
    expect(
      isExistingRegularArtifactFile(pathToFileURL(canonical).href, {
        cwd,
        workPath: '.rundown/work',
        fileArtifactSearchRoots: [cwd],
      }),
    ).toBe(false);
  });

  it('returns false for a symlink under cwd whose target is outside the search roots', async () => {
    const { isExistingRegularArtifactFile } = await import(
      '../../src/runbook/artifact-manifest.js'
    );
    const { pathToFileURL } = await import('node:url');
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'art-existing-cwd-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'art-existing-outside-'));
    tempDirs.push(cwd, outside);
    const target = path.join(outside, 'secret.json');
    await fsp.writeFile(target, '{}');
    const link = path.join(cwd, 'link.json');
    try {
      await fsp.symlink(target, link);
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
    // Note: the URI may name the symlink path; isExistingRegularArtifactFile
    // must realpath it and reject because the target is outside the roots.
    expect(
      isExistingRegularArtifactFile(pathToFileURL(link).href, {
        cwd,
        workPath: '.rundown/work',
        fileArtifactSearchRoots: [cwd],
      }),
    ).toBe(false);
  });

  it('returns false when the file URI resolves to a directory', async () => {
    const { isExistingRegularArtifactFile } = await import(
      '../../src/runbook/artifact-manifest.js'
    );
    const { pathToFileURL } = await import('node:url');
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'art-existing-dir-'));
    tempDirs.push(cwd);
    const dirPath = path.join(cwd, 'a-dir');
    await fsp.mkdir(dirPath);
    expect(
      isExistingRegularArtifactFile(pathToFileURL(dirPath).href, {
        cwd,
        workPath: '.rundown/work',
        fileArtifactSearchRoots: [cwd],
      }),
    ).toBe(false);
  });

  it('returns false (no throw) for a malformed file: URI', async () => {
    const { isExistingRegularArtifactFile } = await import(
      '../../src/runbook/artifact-manifest.js'
    );
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'art-existing-bad-uri-'));
    tempDirs.push(cwd);
    // `file:%` is a malformed file URI: fileURLToPath throws URIError
    // ("URI malformed") on Node. The check must fail-closed by returning
    // false, not propagate the throw.
    expect(() =>
      isExistingRegularArtifactFile('file:%', {
        cwd,
        workPath: '.rundown/work',
        fileArtifactSearchRoots: [cwd],
      }),
    ).not.toThrow();
    expect(
      isExistingRegularArtifactFile('file:%', {
        cwd,
        workPath: '.rundown/work',
        fileArtifactSearchRoots: [cwd],
      }),
    ).toBe(false);
  });
});
