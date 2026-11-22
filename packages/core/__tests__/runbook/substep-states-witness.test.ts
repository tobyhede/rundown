// Witness for F4 (PR #912 review): finished substeps' `substepStates` rows
// stay `pending`. Nothing writes a row's `status`/`result` since #912 removed
// the delegation/inline callers of `upsertSubstepState` /
// `replaceSubstepStateEntry`; only `initializeSubsteps` produces rows, always
// as `pending`. Parent aggregation itself is correct (it reads
// `deferredResults` / `iterationResults`, not `substepStates`).
//
// EXPECTED TO FAIL until F4 is fixed. The fix direction is undecided: either
// record `status`/`result` on the row when a substep finishes, or remove
// `status`/`result` from the row. Whichever lands must update this test.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RunbookActorService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  resolveOwnedRun,
  type ResolvedStep,
} from '../../src/runbook/index.js';
import { closeRunbookStore } from '../../src/runbook/storage/store-registry.js';
import type { OwnerToken } from '../../src/runbook/run-secrets.js';
import { seedRun } from '../../src/testing/run-fixtures.js';
import { createRunbook } from './fixtures.js';

const STATIC_ALL = `## 1. Parent
- PASS ALL COMPLETE
- FAIL ANY CONTINUE

### 1.1 First child
Do the first thing.

### 1.2 Second child
Do the second thing.

## 2. After
- PASS COMPLETE
- FAIL STOP
`;

const FOR_ALL = `## 1. Loop
- FOR i IN 1 TO 2
- PASS ALL COMPLETE
- FAIL ANY CONTINUE

### 1.1 Body
Do iteration {{i}}.

## 2. After
- PASS COMPLETE
- FAIL STOP
`;

describe('F4 witness: finished substeps are recorded in persisted substepStates', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let seam: RunbookLifecycleCommandService;
  let steps: readonly ResolvedStep[];

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'f4-witness-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    steps = [];
    seam = new RunbookLifecycleCommandService({ manager, actorService, loadSteps: () => steps });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await closeRunbookStore(tmp);
    await rm(tmp, { recursive: true, force: true });
  });

  async function start(markdown: string): Promise<{ runId: string; token: OwnerToken }> {
    steps = createRunbook(markdown);
    const seeded = await seedRun(tmp, { markdown });
    await actorService.initializeState(seeded.runId, steps);
    return { runId: seeded.runId, token: seeded.ownerToken };
  }

  async function drive(
    token: OwnerToken,
    command: 'pass' | 'fail',
    stepId: string,
    iteration?: number,
  ): Promise<void> {
    const resolution = await resolveOwnedRun(manager, token);
    if (resolution.kind !== 'running') throw new Error(`expected running, got ${resolution.kind}`);
    const outcome = await seam.runTransition({
      command,
      run: resolution.run,
      target: iteration === undefined ? { stepId } : { stepId, iteration },
    });
    if (outcome.kind !== 'applied') throw new Error(`expected applied, got ${outcome.kind}`);
  }

  async function row(runId: string, id: string, frameKey: string) {
    const state = await manager.load(runId);
    return state?.substepStates?.find((s) => s.id === id && s.frameKey === frameKey);
  }

  it('static substeps (ALL): pass 1.1 then fail 1.2 records each as done with its result', async () => {
    const { runId, token } = await start(STATIC_ALL);

    await drive(token, 'pass', '1.1');
    expect(await row(runId, '1', '1|')).toEqual({
      id: '1',
      frameKey: '1|',
      status: 'done',
      result: 'pass',
    });

    await drive(token, 'fail', '1.2');
    expect(await row(runId, '2', '1|')).toEqual({
      id: '2',
      frameKey: '1|',
      status: 'done',
      result: 'fail',
    });
  });

  it('FOR iteration (ALL): passing iteration 1 records its body row as done/pass', async () => {
    const { runId, token } = await start(FOR_ALL);
    const frameKey = (await manager.load(runId))?.substepStates?.[0]?.frameKey;
    if (frameKey === undefined) throw new Error('iteration 1 frame was not initialised');

    await drive(token, 'pass', '1.1', 1);
    expect(await row(runId, '1', frameKey)).toEqual({
      id: '1',
      frameKey,
      status: 'done',
      result: 'pass',
    });
  });
});
