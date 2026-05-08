import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactRuntimeService } from '../../src/runbook/artifact-runtime-service.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { replace } from '../../src/runbook/state-update-ops.js';
import { artifactUriToPath } from '../../src/runbook/artifact-uri.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import type { ResolvedRunbook } from '../../src/runbook/types.js';
import { brandRunIdForTest } from '../helpers/effective-vars.js';
import {
  makeBaseStep,
  makeResolvedStepWithSubsteps,
  makeSubstep,
} from '../helpers/step-factories.js';

const WORK_PATH = '.rundown/work';
const CONTEXT_ID = 'ctx1';
const RUN_ID = brandRunIdForTest('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const RUNBOOK_REF = { source: 'project' as const, path: 'artifact-runtime.md' };

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function tempCwd(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-runtime-'));
  tempDirs.push(cwd);
  return cwd;
}

function runbookWithSteps(steps: ResolvedRunbook['steps']): ResolvedRunbook {
  return {
    title: 'Artifact Runtime',
    description: 'Artifact runtime test',
    steps,
  };
}

async function createRun(manager: RunbookStateManager, runbook: ResolvedRunbook) {
  return manager.create(RUNBOOK_REF, runbook, {
    runbookPath: RUNBOOK_REF.path,
    runId: RUN_ID,
    frontmatterOutputs: [],
    templateVars: {
      WorkPath: WORK_PATH,
      ContextId: CONTEXT_ID,
      RunId: RUN_ID,
      RunbookRef: RUNBOOK_REF,
    },
  });
}

describe('ArtifactRuntimeService', () => {
  it('resolves active step ARTIFACTS through the machine and persists current plus accumulated artifacts', async () => {
    const cwd = await tempCwd();
    const manager = new RunbookStateManager(cwd);
    const actorService = new RunbookActorService(manager);
    const service = new ArtifactRuntimeService(manager, actorService);
    const steps = [
      makeBaseStep({
        name: '1',
        description: 'Produce plan',
        artifacts: [{ name: 'PlanPath', key: 'plan.json', kind: 'exact' }],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      }),
    ];
    const runbook = runbookWithSteps(steps);
    const state = await createRun(manager, runbook);
    await actorService.initializeState(state.id, steps);

    const result = await service.resolveCurrentUnitArtifacts(state.id, steps);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('expected resolved');
    expect(result.artifacts).toHaveProperty('PlanPath');
    const record = result.artifacts.PlanPath as ArtifactRecord;
    expect(record).toMatchObject({
      contextId: CONTEXT_ID,
      runId: RUN_ID,
      runbook: RUNBOOK_REF,
      key: 'plan.json',
    });
    await expect(
      fsp.stat(path.dirname(artifactUriToPath(record.uri, { cwd, workPath: WORK_PATH }))),
    ).resolves.toBeDefined();
    const loaded = await manager.load(state.id);
    expect(loaded?.artifacts).toEqual({ PlanPath: record });
    expect(loaded?.artifactVars).toEqual({ PlanPath: record });
  });

  it('dispatches an empty object for units without ARTIFACTS when previous current artifacts need clearing', async () => {
    const cwd = await tempCwd();
    const manager = new RunbookStateManager(cwd);
    const actorService = new RunbookActorService(manager);
    const service = new ArtifactRuntimeService(manager, actorService);
    const previousArtifact = {
      uri: 'rd://artifacts/ctx1/runs/rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/previous.json',
      runId: RUN_ID,
      contextId: CONTEXT_ID,
      runbook: RUNBOOK_REF,
      key: 'previous.json',
      timestamp: '2026-05-08T00:00:00.000Z',
    };
    const steps = [
      makeBaseStep({
        name: '1',
        description: 'No artifacts',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      }),
    ];
    const runbook = runbookWithSteps(steps);
    const state = await createRun(manager, runbook);
    await actorService.initializeState(state.id, steps);
    await manager.update(state.id, {
      artifacts: replace({ PreviousPath: previousArtifact }),
      artifactVars: replace({ PreviousPath: previousArtifact }),
    });

    const result = await service.resolveCurrentUnitArtifacts(state.id, steps);

    expect(result).toMatchObject({ status: 'resolved', artifacts: {} });
    const loaded = await manager.load(state.id);
    expect(loaded?.artifacts).toEqual({});
    expect(loaded?.artifactVars).toEqual({ PreviousPath: previousArtifact });
  });

  it('resolves ARTIFACTS from the active substep rather than the parent step', async () => {
    const cwd = await tempCwd();
    const manager = new RunbookStateManager(cwd);
    const actorService = new RunbookActorService(manager);
    const service = new ArtifactRuntimeService(manager, actorService);
    const steps = [
      makeResolvedStepWithSubsteps({
        name: '1',
        description: 'Parent',
        artifacts: [{ name: 'ParentPath', key: 'parent.json', kind: 'exact' }],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
        substeps: [
          makeSubstep({
            id: '1',
            description: 'Child',
            artifacts: [{ name: 'ChildPath', key: 'child.json', kind: 'exact' }],
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
            },
          }),
        ],
      }),
    ];
    const runbook = runbookWithSteps(steps);
    const state = await createRun(manager, runbook);
    await actorService.initializeState(state.id, steps);

    const result = await service.resolveCurrentUnitArtifacts(state.id, steps);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('expected resolved');
    expect(result.artifacts).toHaveProperty('ChildPath');
    expect(result.artifacts).not.toHaveProperty('ParentPath');

    const loaded = await manager.load(state.id);
    expect(loaded?.artifacts).toHaveProperty('ChildPath');
    expect(loaded?.artifacts).not.toHaveProperty('ParentPath');
  });

  it('returns missing-run when the persisted state is absent', async () => {
    const cwd = await tempCwd();
    const manager = new RunbookStateManager(cwd);
    const actorService = new RunbookActorService(manager);
    const service = new ArtifactRuntimeService(manager, actorService);

    const result = await service.resolveCurrentUnitArtifacts(
      'rd_ffffffffffffffffffffffffffffffff',
      [],
    );

    expect(result).toEqual({ status: 'missing-run' });
  });

  it('skips dispatch when the active unit has no ARTIFACTS and persisted state.artifacts is already empty', async () => {
    const cwd = await tempCwd();
    const manager = new RunbookStateManager(cwd);
    const actorService = new RunbookActorService(manager);
    const service = new ArtifactRuntimeService(manager, actorService);
    const steps = [
      makeBaseStep({
        name: '1',
        description: 'No artifacts',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      }),
    ];
    const runbook = runbookWithSteps(steps);
    const state = await createRun(manager, runbook);
    await actorService.initializeState(state.id, steps);
    await manager.update(state.id, { artifacts: replace({}) });

    const sendAndSyncSpy = jest.spyOn(actorService, 'sendAndSync');

    const result = await service.resolveCurrentUnitArtifacts(state.id, steps);

    expect(result).toMatchObject({ status: 'resolved', artifacts: {} });
    expect(sendAndSyncSpy).not.toHaveBeenCalled();

    sendAndSyncSpy.mockRestore();
  });
});
