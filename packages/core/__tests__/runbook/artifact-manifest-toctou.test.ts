import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Mode, PathLike } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ARTIFACT_ERROR_TEXT } from '../../src/runbook/artifact-errors.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import type { ArtifactPathOptions } from '../../src/runbook/artifact-uri.js';

const actualFs = await import('node:fs');

let afterLstat: ((filePath: string) => void) | undefined;
let beforeOpen: ((filePath: string) => void) | undefined;

jest.unstable_mockModule('node:fs', () => ({
  ...actualFs,
  lstatSync: jest.fn((filePath: PathLike) => {
    const stat = actualFs.lstatSync(filePath);
    afterLstat?.(String(filePath));
    return stat;
  }),
  openSync: jest.fn((filePath: PathLike, flags: string | number, mode?: Mode) => {
    beforeOpen?.(String(filePath));
    return actualFs.openSync(filePath, flags, mode);
  }),
}));

const { appendArtifactManifestRecordSync, findArtifactMatches, readArtifactManifest } =
  await import('../../src/runbook/artifact-manifest.js');

const RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_RUN_ID = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const record = {
  uri: `rd://artifacts/ctx1/${RUN_ID}/review.json`,
  runId: RUN_ID,
  contextId: 'ctx1',
  runbook: {
    source: 'plugin',
    path: 'planning/review.runbook.md',
  },
  key: 'review.json',
  timestamp: '2026-05-04T03:15:24.000Z',
} satisfies ArtifactRecord;

const replacementRecord = {
  ...record,
  uri: `rd://artifacts/ctx1/${SECOND_RUN_ID}/review.json`,
  runId: SECOND_RUN_ID,
  timestamp: '2026-05-04T03:16:24.000Z',
} satisfies ArtifactRecord;

const optionsFor = (cwd: string): ArtifactPathOptions => ({ cwd, workPath: '.rundown/work' });
const manifestPath = (cwd: string): string =>
  path.join(cwd, '.rundown/work', '.rd-ctx1', 'manifest.jsonl');
const runDir = (cwd: string, runId: string): string =>
  path.join(cwd, '.rundown/work', '.rd-ctx1', runId);
const artifactFile = (cwd: string, runId: string): string =>
  path.join(runDir(cwd, runId), 'review.json');

let tempDirs: string[] = [];

afterEach(async () => {
  afterLstat = undefined;
  beforeOpen = undefined;
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { force: true, recursive: true })));
  tempDirs = [];
  jest.clearAllMocks();
});

async function tempCwd(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-manifest-toctou-'));
  tempDirs.push(cwd);
  return cwd;
}

async function writeManifestFile(filePath: string, rows: readonly ArtifactRecord[]): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

async function writeArtifact(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, '{}');
}

describe('artifact manifest TOCTOU defenses', () => {
  it('does not read a manifest swapped to a symlink after path inspection', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const safeManifest = manifestPath(cwd);
    const outsideManifest = path.join(outside, 'manifest.jsonl');
    await writeManifestFile(safeManifest, [record]);
    await writeManifestFile(outsideManifest, [replacementRecord]);

    let swapped = false;
    afterLstat = (filePath) => {
      if (swapped || filePath !== safeManifest) {
        return;
      }
      swapped = true;
      actualFs.rmSync(safeManifest);
      actualFs.symlinkSync(outsideManifest, safeManifest);
    };

    await expect(readArtifactManifest(optionsFor(cwd), 'ctx1')).resolves.toEqual([record]);
  });

  it('does not append through a manifest directory swapped to a symlink before open', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const safeManifest = manifestPath(cwd);
    await fsp.mkdir(path.dirname(safeManifest), { recursive: true });

    let swapped = false;
    beforeOpen = (filePath) => {
      if (swapped || filePath !== safeManifest) {
        return;
      }
      swapped = true;
      actualFs.rmSync(path.dirname(safeManifest), { recursive: true, force: true });
      actualFs.symlinkSync(outside, path.dirname(safeManifest), 'dir');
    };

    expect(() => {
      appendArtifactManifestRecordSync(optionsFor(cwd), record);
    }).toThrow(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE);

    const outsideManifest = path.join(outside, 'manifest.jsonl');
    const outsideContent = actualFs.existsSync(outsideManifest)
      ? actualFs.readFileSync(outsideManifest, 'utf8')
      : '';
    expect(outsideContent).not.toContain(record.uri);
  });

  it('does not match an artifact whose parent directory is swapped to a symlink', async () => {
    const cwd = await tempCwd();
    const outside = await tempCwd();
    const safeArtifact = artifactFile(cwd, RUN_ID);
    const outsideArtifact = path.join(outside, 'review.json');
    await writeManifestFile(manifestPath(cwd), [record]);
    await writeArtifact(safeArtifact);
    await fsp.writeFile(outsideArtifact, '{}');

    let swapped = false;
    const swapRunDir = (): void => {
      if (swapped) {
        return;
      }
      swapped = true;
      actualFs.rmSync(runDir(cwd, RUN_ID), { recursive: true, force: true });
      actualFs.symlinkSync(outside, runDir(cwd, RUN_ID), 'dir');
    };
    let artifactLstatCount = 0;
    afterLstat = (filePath) => {
      if (filePath === safeArtifact) {
        artifactLstatCount += 1;
      }
      if (filePath === safeArtifact && artifactLstatCount === 2) {
        swapRunDir();
      }
    };
    beforeOpen = (filePath) => {
      if (filePath === safeArtifact) {
        swapRunDir();
      }
    };

    await expect(
      findArtifactMatches('rd://artifacts/ctx1/*/review.json?status=any', {
        ...optionsFor(cwd),
        loadRunState: async () => ({
          lifecycle: 'completed',
          terminalAt: '2026-05-04T04:00:00.000Z',
        }),
      }),
    ).resolves.toEqual([]);
  });
});
