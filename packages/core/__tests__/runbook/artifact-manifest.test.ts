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
  uri: `rd://artifacts/ctx1/runs/${RUN_ID}/review.json`,
  runId: RUN_ID,
  contextId: 'ctx1',
  runbook: {
    source: 'plugin',
    path: 'planning/review/review-plan-risk-safety.runbook.md',
  },
  key: 'review.json',
  timestamp: '2026-05-04T03:15:24.000Z',
} satisfies ArtifactRecord;

const optionsFor = (cwd: string): ArtifactPathOptions => ({ cwd, workPath: '.rundown/work' });
const manifestPath = (cwd: string, contextId = 'ctx1'): string =>
  path.join(cwd, '.rundown/work', `.rd-${contextId}`, 'manifest.jsonl');
const runDir = (cwd: string, contextId: string, runId: string): string =>
  path.join(cwd, '.rundown/work', `.rd-${contextId}`, 'runs', runId);
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
    uri: overrides.uri ?? `rd://artifacts/${contextId}/runs/${runId}/${key}`,
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
  const file = artifactFile(cwd, row.contextId, row.runId);
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
      `${JSON.stringify(record)}\n`,
    );
  });

  it('appends one JSONL record synchronously', async () => {
    const cwd = await tempCwd();

    appendArtifactManifestRecordSync(optionsFor(cwd), record);

    await expect(fsp.readFile(manifestPath(cwd), 'utf8')).resolves.toBe(
      `${JSON.stringify(record)}\n`,
    );
  });

  it('sync appends newline-delimited JSONL and reads records back', async () => {
    const cwd = await tempCwd();
    const secondRecord = withRunId(SECOND_RUN_ID, {
      timestamp: '2026-05-04T04:15:24.000Z',
    });

    appendArtifactManifestRecordSync(optionsFor(cwd), record);
    appendArtifactManifestRecordSync(optionsFor(cwd), secondRecord);

    await expect(fsp.readFile(manifestPath(cwd), 'utf8')).resolves.toBe(
      `${JSON.stringify(record)}\n${JSON.stringify(secondRecord)}\n`,
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
        uri: `rd://artifacts/ctx1/runs/${RUN_ID}/${encodeURIComponent('nested/review.json')}`,
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
  it('filters selector matches by runbook glob, completed status, file existence, and latest', async () => {
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
        'rd://artifacts/ctx1/runs/*/review.json?runbook=planning/review/*.runbook.md&latest=true',
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

  it('breaks latest terminalAt ties by highest lexicographic run id', async () => {
    const cwd = await tempCwd();
    const lower = withRunId(RUN_ID);
    const higher = withRunId(SECOND_RUN_ID, { timestamp: '2026-05-04T03:20:24.000Z' });
    await writeManifest(cwd, [lower, higher]);
    await Promise.all([lower, higher].map((row) => touchArtifact(cwd, row)));
    const terminalAt = '2026-05-04T05:00:00.000Z';

    await expect(
      findArtifactMatches(
        'rd://artifacts/ctx1/runs/*/review.json?latest=true',
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
      'rd://artifacts/ctx1/runs/*/review.json?latest=true&status=any',
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
      'rd://artifacts/ctx1/runs/*/review.json?runbook=planning/review/*.runbook.md&runbook=ops/deploy?.runbook.md&source=plugin&source=project',
      finderOptions(cwd, states),
    );

    expect(matches.map((match) => match.record)).toEqual([pluginMatch, projectMatch]);
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
        `rd://artifacts/ctx1/runs/${SECOND_RUN_ID}/review.json?source=plugin`,
        finderOptions(cwd, states),
      ),
    ).resolves.toMatchObject([{ record: second }]);
  });

  it('excludes non-completed runs by default and includes them with status any', async () => {
    const cwd = await tempCwd();
    await writeManifest(cwd, [record]);
    await touchArtifact(cwd, record);
    const states = new Map([
      [record.runId, { lifecycle: 'active', terminalAt: '2026-05-04T05:00:00.000Z' }],
    ]);

    await expect(
      findArtifactMatches('rd://artifacts/ctx1/runs/*/review.json', finderOptions(cwd, states)),
    ).resolves.toEqual([]);
    await expect(
      findArtifactMatches(
        'rd://artifacts/ctx1/runs/*/review.json?status=any',
        finderOptions(cwd, states),
      ),
    ).resolves.toMatchObject([{ record }]);
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
      uri: `rd://artifacts/ctx2/runs/${RUN_ID}/review.json`,
    });
    await writeManifest(cwd, [otherContext], 'ctx2');
    await touchArtifact(cwd, otherContext);

    await expect(
      findArtifactMatches(
        'rd://artifacts/ctx1/runs/*/review.json?status=any',
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
        'rd://artifacts/ctx1/runs/*/review.json?status=any',
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
        'rd://artifacts/ctx1/runs/*/review.json?status=any',
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
