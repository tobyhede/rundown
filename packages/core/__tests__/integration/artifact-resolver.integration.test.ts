import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import { artifactUriToPath } from '../../src/runbook/artifact-uri.js';
import { ArtifactRuntimeService } from '../../src/runbook/artifact-runtime-service.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import type { RunId } from '../../src/runbook/run-id.js';
import type { ResolvedRunbook, ResolvedStep } from '../../src/runbook/types.js';
import { brandRunIdForTest } from '../helpers/effective-vars.js';
import { makeBaseStep } from '../helpers/step-factories.js';

const WORK_PATH = '.rundown/work';
const CONTEXT_ID = 'ctx1';
const RUNBOOK_REF = { source: 'project' as const, path: 'artifact.integration.md' };
const SIBLING_RUN = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CURRENT_RUN = brandRunIdForTest('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

function makeStep(artifacts: ResolvedStep['artifacts']): ResolvedStep {
  return makeBaseStep({
    name: '1',
    description: 'Only step',
    artifacts,
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  });
}

function runbookForSteps(steps: readonly ResolvedStep[]): ResolvedRunbook {
  return {
    title: 'Artifact Integration',
    description: 'Artifact integration test',
    steps: [...steps],
  };
}

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

async function createRun(
  manager: RunbookStateManager,
  runId: RunId,
  steps: readonly ResolvedStep[],
) {
  return manager.create(RUNBOOK_REF, runbookForSteps(steps), {
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
    const actorService = new RunbookActorService(manager);
    const service = new ArtifactRuntimeService(manager, actorService);

    const siblingSteps = [makeStep([{ name: 'PlanPath', key: 'plan.json', kind: 'exact' }])];
    const sibling = await createRun(manager, SIBLING_RUN, siblingSteps);
    await actorService.initializeState(sibling.id, [...siblingSteps]);
    const siblingResult = await service.resolveCurrentUnitArtifacts(sibling.id, siblingSteps);
    if (siblingResult.status !== 'resolved') throw new Error('expected resolved');
    const siblingRecord = siblingResult.artifacts.PlanPath as ArtifactRecord;
    const siblingPath = artifactUriToPath(siblingRecord.uri, { cwd, workPath: WORK_PATH });
    await fsp.mkdir(path.dirname(siblingPath), { recursive: true });
    await fsp.writeFile(siblingPath, '{}');
    await manager.update(sibling.id, { lifecycle: 'completed' });

    const currentSteps = [makeStep([{ name: 'Plans', key: 'plan*.json', kind: 'wildcard' }])];
    const current = await createRun(manager, CURRENT_RUN, currentSteps);
    await actorService.initializeState(current.id, [...currentSteps]);
    const currentResult = await service.resolveCurrentUnitArtifacts(current.id, currentSteps);
    if (currentResult.status !== 'resolved') throw new Error('expected resolved');

    expect(currentResult.artifacts.Plans).toHaveLength(1);
    expect((currentResult.artifacts.Plans as ArtifactRecord[])[0]).toMatchObject({
      contextId: CONTEXT_ID,
      runId: sibling.id,
      key: 'plan.json',
      runbook: RUNBOOK_REF,
    });
  });
});
