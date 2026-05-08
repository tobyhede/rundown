import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import { artifactUriToPath } from '../../src/runbook/artifact-uri.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import type { RunId } from '../../src/runbook/run-id.js';
import type { ResolvedRunbook } from '../../src/runbook/types.js';
import { brandRunIdForTest } from '../helpers/effective-vars.js';
import { makeBaseStep } from '../helpers/step-factories.js';

const WORK_PATH = '.rundown/work';
const CONTEXT_ID = 'ctx1';
const RUNBOOK_REF = { source: 'project' as const, path: 'artifact.integration.md' };
const SIBLING_RUN = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CURRENT_RUN = brandRunIdForTest('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

const runbook: ResolvedRunbook = {
  title: 'Artifact Integration',
  description: 'Artifact integration test',
  steps: [
    makeBaseStep({
      name: '1',
      description: 'Only step',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    }),
  ],
};

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function tempCwd(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-resolver-integration-'));
  tempDirs.push(cwd);
  return cwd;
}

async function createRun(manager: RunbookStateManager, runId: RunId) {
  return manager.create(RUNBOOK_REF, runbook, {
    runbookPath: RUNBOOK_REF.path,
    runId,
    frontmatterOutputs: [],
    templateVars: {
      WorkPath: WORK_PATH,
      ContextId: CONTEXT_ID,
      RunId: runId,
      RunbookRef: RUNBOOK_REF,
    },
  });
}

describe('artifact resolver integration', () => {
  it('resolves artifacts from a completed sibling run in the same context', async () => {
    const cwd = await tempCwd();
    const manager = new RunbookStateManager(cwd);

    const sibling = await createRun(manager, SIBLING_RUN);
    const siblingArtifacts = await manager.resolveArtifactsForRun(sibling.id, [
      { name: 'PlanPath', key: 'plan.json', kind: 'exact' },
    ]);
    const siblingRecord = siblingArtifacts.PlanPath as ArtifactRecord;
    const siblingPath = artifactUriToPath(siblingRecord.uri, { cwd, workPath: WORK_PATH });
    await fsp.mkdir(path.dirname(siblingPath), { recursive: true });
    await fsp.writeFile(siblingPath, '{}');
    await manager.update(sibling.id, {
      lifecycle: 'completed',
      updatedAt: new Date().toISOString(),
    });

    const current = await createRun(manager, CURRENT_RUN);
    const artifacts = await manager.resolveArtifactsForRun(current.id, [
      { name: 'Plans', key: 'plan*.json', kind: 'wildcard' },
    ]);

    expect(artifacts.Plans).toHaveLength(1);
    expect((artifacts.Plans as ArtifactRecord[])[0].runId).toBe(sibling.id);
  });
});
