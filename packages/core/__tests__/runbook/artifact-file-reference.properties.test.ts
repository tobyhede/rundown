import { afterEach, describe, expect, it } from '@jest/globals';
import type { ArtifactDeclaration } from '@rundown-org/parser';
import fc from 'fast-check';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveArtifactDeclarations } from '../../src/runbook/artifact-directive-resolver.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import type { RunId } from '../../src/runbook/run-id.js';
import type { ArtifactVarValue } from '../../src/runbook/types.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';

const CURRENT_RUN: RunId = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CONTEXT_ID = 'ctx1';
const WORK_PATH = '.rundown/work';
const RUNBOOK = { source: 'project' as const, path: 'planning/write-plan.runbook.md' };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempCwd(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-file-prop-'));
  tempDirs.push(cwd);
  return cwd;
}

function decl(name: string, rawToken: string): ArtifactDeclaration {
  return { name, rawToken };
}

function isArtifactRecordArray(value: ArtifactVarValue): value is readonly ArtifactRecord[] {
  return Array.isArray(value);
}

const safeSegment = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((value) => /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..');

describe('artifact file reference properties', () => {
  it('never falls back to managed artifact keys for missing path-like tokens', async () => {
    await fc.assert(
      fc.asyncProperty(safeSegment, safeSegment, async (dir, file) => {
        const cwd = await tempCwd();
        const token = `${dir}/${file}.json`;

        await expect(
          resolveArtifactDeclarations([decl('Reference', token)], {
            cwd,
            workPath: WORK_PATH,
            contextId: CONTEXT_ID,
            runId: CURRENT_RUN,
            runbook: RUNBOOK,
          }),
        ).rejects.toThrow(/file reference|not found/i);
      }),
      { numRuns: 50 },
    );
  });

  it('always rejects symlinks under cwd whose realpath escapes the search roots', async () => {
    // Property: for any non-dot relative token resolving to a symlink under
    // `cwd` that points OUTSIDE the search roots, the resolver throws
    // "not found" — never silently follows the symlink to the outside target.
    // This pins the realpath + containment guard at
    // `artifact-directive-resolver.ts` `resolveExistingFileReference`.
    await fc.assert(
      fc.asyncProperty(safeSegment, safeSegment, safeSegment, async (dir, linkName, targetName) => {
        const cwd = await tempCwd();
        const outside = await tempCwd();
        const outsideTarget = path.join(outside, `${targetName}.json`);
        await fsp.writeFile(outsideTarget, '{}');
        await fsp.mkdir(path.join(cwd, dir), { recursive: true });
        const link = path.join(cwd, dir, linkName);
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
          resolveArtifactDeclarations([decl('Esc', `${dir}/${linkName}`)], {
            cwd,
            workPath: WORK_PATH,
            contextId: CONTEXT_ID,
            runId: CURRENT_RUN,
            runbook: RUNBOOK,
          }),
        ).rejects.toThrow(/file reference|not found/i);
      }),
      { numRuns: 25 },
    );
  });

  it('stores canonical file URIs that round-trip to canonical file paths', async () => {
    await fc.assert(
      fc.asyncProperty(safeSegment, safeSegment, async (dir, file) => {
        const cwd = await tempCwd();
        const token = `${dir}/${file}.json`;
        const target = path.join(cwd, dir, `${file}.json`);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, '{}');
        const canonical = await fsp.realpath(target);

        const result = await resolveArtifactDeclarations([decl('Reference', token)], {
          cwd,
          workPath: WORK_PATH,
          contextId: CONTEXT_ID,
          runId: CURRENT_RUN,
          runbook: RUNBOOK,
        });

        const record = result.Reference;
        expect(isArtifactRecordArray(record)).toBe(false);
        if (!isArtifactRecordArray(record)) {
          expect(record.kind).toBe('file-artifact-record');
          expect(record.uri).toBe(pathToFileURL(canonical).href);
          expect(fileURLToPath(record.uri)).toBe(canonical);
        }
      }),
      { numRuns: 50 },
    );
  });
});
