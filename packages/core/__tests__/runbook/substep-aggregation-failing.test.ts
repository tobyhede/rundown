import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RunbookActorService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  resolveOwnedRun,
  type OwnedRun,
  type ResolvedStep,
} from '../../src/runbook/index.js';
import { closeRunbookStore } from '../../src/runbook/storage/store-registry.js';
import type { OwnerToken } from '../../src/runbook/run-secrets.js';
import { seedRun } from '../../src/testing/run-fixtures.js';
import { createRunbook } from './fixtures.js';

// R3 (PR #912 review F4): ALL/ANY substep aggregation with a failing substep,
// driven end to end through the lifecycle command seam (`rundown pass` /
// `rundown fail`) against the real machine and the real store. Substeps carry
// no authored handlers, so they take the spec §6.1 default under aggregation
// (`PASS DEFER`, `FAIL DEFER`) and the parent's aggregation alone decides.
//
// Each parent maps its two aggregate outcomes to observably different
// actions (CONTINUE to step 2 vs a terminal), so a wrong aggregate result
// cannot pass the assertion by coincidence.

/** ALL: one failing substep must fail the parent (FAIL ANY → CONTINUE to 2). */
const ALL_PARENT = `## 1. Parent
- PASS ALL COMPLETE
- FAIL ANY CONTINUE

### 1.1 First child
Do the first thing.

### 1.2 Second child
Do the second thing.

## 2. After failure
- PASS COMPLETE
- FAIL STOP
`;

/** ANY: one passing substep must pass the parent (PASS ANY → CONTINUE to 2). */
const ANY_PARENT = `## 1. Parent
- PASS ANY CONTINUE
- FAIL ALL COMPLETE

### 1.1 First child
Do the first thing.

### 1.2 Second child
Do the second thing.

## 2. After success
- PASS COMPLETE
- FAIL STOP
`;

/** ALL over a FOR loop: a failing iteration must fail the parent. */
const FOR_ALL_PARENT = `## 1. Loop
- FOR i IN 1 TO 2
- PASS ALL COMPLETE
- FAIL ANY CONTINUE

### 1.1 Body
Do iteration {{i}}.

## 2. After failure
- PASS COMPLETE
- FAIL STOP
`;

/** ANY over a FOR loop: one passing iteration must pass the parent. */
const FOR_ANY_PARENT = `## 1. Loop
- FOR i IN 1 TO 2
- PASS ANY CONTINUE
- FAIL ALL COMPLETE

### 1.1 Body
Do iteration {{i}}.

## 2. After success
- PASS COMPLETE
- FAIL STOP
`;

describe('substep aggregation with a failing substep (end to end)', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let seam: RunbookLifecycleCommandService;
  let steps: readonly ResolvedStep[];

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'substep-agg-fail-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    steps = [];
    seam = new RunbookLifecycleCommandService({
      manager,
      actorService,
      loadSteps: () => steps,
    });
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

  async function owned(token: OwnerToken): Promise<OwnedRun> {
    const resolution = await resolveOwnedRun(manager, token);
    if (resolution.kind !== 'running') {
      throw new Error(`expected a running run, got ${resolution.kind}`);
    }
    return resolution.run;
  }

  async function drive(
    token: OwnerToken,
    command: 'pass' | 'fail',
    stepId: string,
    iteration?: number,
  ): Promise<void> {
    const run = await owned(token);
    const outcome = await seam.runTransition({
      command,
      run,
      target: iteration === undefined ? { stepId } : { stepId, iteration },
    });
    if (outcome.kind !== 'applied') {
      throw new Error(`expected applied, got ${JSON.stringify(outcome)}`);
    }
  }

  describe('(a) parent result and handler action', () => {
    it('ALL: pass then fail aggregates to fail and takes the FAIL ANY handler', async () => {
      const { runId, token } = await start(ALL_PARENT);

      await drive(token, 'pass', '1.1');
      await drive(token, 'fail', '1.2');

      const persisted = await manager.load(runId);
      expect(persisted?.lifecycle).toBe('running');
      expect(persisted?.step).toBe('2');
      expect(persisted?.lastResult).toBe('fail');
    });

    it('ALL: fail on the first substep still walks the second before aggregating', async () => {
      const { runId, token } = await start(ALL_PARENT);

      await drive(token, 'fail', '1.1');
      const mid = await manager.load(runId);
      expect(mid?.step).toBe('1');
      expect(mid?.substep).toBe('2');

      await drive(token, 'pass', '1.2');
      const persisted = await manager.load(runId);
      expect(persisted?.lifecycle).toBe('running');
      expect(persisted?.step).toBe('2');
    });

    it('ANY: fail then pass aggregates to pass and takes the PASS ANY handler', async () => {
      const { runId, token } = await start(ANY_PARENT);

      await drive(token, 'fail', '1.1');
      await drive(token, 'pass', '1.2');

      const persisted = await manager.load(runId);
      expect(persisted?.lifecycle).toBe('running');
      expect(persisted?.step).toBe('2');
      expect(persisted?.lastResult).toBe('pass');
    });

    it('ANY: all substeps failing aggregates to fail and takes the FAIL ALL handler', async () => {
      const { runId, token } = await start(ANY_PARENT);

      await drive(token, 'fail', '1.1');
      await drive(token, 'fail', '1.2');

      expect((await manager.load(runId))?.lifecycle).toBe('completed');
    });

    it('FOR ALL: one failing iteration aggregates to fail', async () => {
      const { runId, token } = await start(FOR_ALL_PARENT);

      await drive(token, 'pass', '1.1', 1);
      await drive(token, 'fail', '1.1', 2);

      const persisted = await manager.load(runId);
      expect(persisted?.lifecycle).toBe('running');
      expect(persisted?.step).toBe('2');
    });

    it('FOR ANY: one passing iteration aggregates to pass', async () => {
      const { runId, token } = await start(FOR_ANY_PARENT);

      await drive(token, 'fail', '1.1', 1);
      await drive(token, 'pass', '1.1', 2);

      const persisted = await manager.load(runId);
      expect(persisted?.lifecycle).toBe('running');
      expect(persisted?.step).toBe('2');
    });
  });
});
