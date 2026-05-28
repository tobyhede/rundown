import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import {
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
} from '../../src/runbook/effective-vars.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import {
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from '../../src/testing/effective-vars.js';
import { ArtifactRecordSchema } from '../../src/runbook/artifact-schema.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { createRunbook } from './fixtures.js';

const RUN_ID = assertRunId(`rd_${'a'.repeat(32)}`);
const CTX = 'ctx1';
const RECORD = ArtifactRecordSchema.parse({
  kind: 'artifact-record',
  uri: `rd://artifacts/${CTX}/${RUN_ID}/plan.json`,
  runId: RUN_ID,
  contextId: CTX,
  runbook: { source: 'project' as const, path: 'lifecycle-test.md' },
  key: 'plan.json',
  timestamp: '2026-05-25T00:00:00.000Z',
});

describe('TrustedArtifactRecord brand survives full RunbookActorService lifecycle', () => {
  let testDir: string | undefined;

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
  });

  it('persists via getPersistedSnapshot, loads via state manager, restarts, and exposes brand on restored context.variables', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brand-lifecycle-'));
    const manager = new RunbookStateManager(testDir);
    const service = new RunbookActorService(manager);

    const steps = createRunbook(`## 1. Step
- PASS COMPLETE
- FAIL STOP
`);
    const created = await manager.create(
      { source: 'project', path: 'lifecycle-test.md' },
      { title: 'Lifecycle', description: 'lifecycle', steps },
      { runbookPath: 'lifecycle-test.md', frontmatterOutputs: [] },
    );

    const branded = brandTrustedArtifactRecordForTest(RECORD);
    await manager.update(created.id, { variables: merge({ Plan: branded }) });

    const actor = await service.createActor(created.id, steps);
    if (!actor) throw new Error('actor creation failed');
    const snapshot = actor.getPersistedSnapshot();
    await manager.update(created.id, { snapshot });
    service.stopActor(actor);

    const reloadedState = await manager.load(created.id);
    if (!reloadedState) throw new Error('reload failed');

    expect(isTrustedArtifactRecord(reloadedState.variables.Plan)).toBe(true);

    const restarted = await service.createActor(reloadedState.id, steps);
    if (!restarted) throw new Error('restart failed');
    const restartedSnapshot = restarted.getPersistedSnapshot() as unknown as {
      context: { variables: Record<string, unknown> };
    };
    expect(isTrustedArtifactRecord(restartedSnapshot.context.variables.Plan)).toBe(true);
    service.stopActor(restarted);
  });

  it('persists and restores TrustedArtifactArray (container brand) end-to-end', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brand-lifecycle-arr-'));
    const manager = new RunbookStateManager(testDir);
    const service = new RunbookActorService(manager);

    const steps = createRunbook(`## 1. Step
- PASS COMPLETE
- FAIL STOP
`);
    const created = await manager.create(
      { source: 'project', path: 'lifecycle-test.md' },
      { title: 'Lifecycle', description: 'lifecycle', steps },
      { runbookPath: 'lifecycle-test.md', frontmatterOutputs: [] },
    );

    const brandedArr = brandTrustedArtifactArrayForTest([RECORD]);
    await manager.update(created.id, { variables: merge({ Plans: brandedArr }) });

    const actor = await service.createActor(created.id, steps);
    if (!actor) throw new Error('actor creation failed');
    const snapshot = actor.getPersistedSnapshot();
    await manager.update(created.id, { snapshot });
    service.stopActor(actor);

    const reloadedState = await manager.load(created.id);
    if (!reloadedState) throw new Error('reload failed');
    expect(isTrustedArtifactArray(reloadedState.variables.Plans)).toBe(true);

    const restarted = await service.createActor(reloadedState.id, steps);
    if (!restarted) throw new Error('restart failed');
    const restartedSnapshot = restarted.getPersistedSnapshot() as unknown as {
      context: { variables: Record<string, unknown> };
    };
    expect(isTrustedArtifactArray(restartedSnapshot.context.variables.Plans)).toBe(true);
    service.stopActor(restarted);
  });
});
