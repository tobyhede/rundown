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
import { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import { closeRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import type { OwnerToken } from '../../src/runbook/run-secrets.js';
import { seedRun } from '../../src/testing/run-fixtures.js';
import { createRunbook } from './fixtures.js';
import { createProcessIdentity } from '../../src/runbook/process-identity.js';

// Lifecycle command seam contract under one writer per run (#901, ADR 0005).
//
// The seam takes the run the frontend resolved from its Owner Token and drives
// the real machine against the real store; only the step graph is a fixture.
// Every refusal is pinned together with "nothing was written": the row's
// `state_version` is read before and after, because a refusal that wrote
// anything is the defect ADR 0005 exists to rule out.

const TWO_STEP = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS COMPLETE
- FAIL STOP
`;

const ONE_STEP_COMPLETE = `## 1. Only
- PASS COMPLETE
- FAIL STOP
`;

const FAIL_CONTINUES = `## 1. First
- PASS STOP
- FAIL CONTINUE

## 2. Second
- PASS COMPLETE
- FAIL STOP
`;

const SUBSTEPS = `## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First child
- PASS CONTINUE
- FAIL STOP

### 1.2 Second child
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`;

const FOR_LOOP = `## 1. Loop
- FOR i IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Body
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`;

const FAIL_RETRIES = `## 1. Flaky
- PASS COMPLETE
- FAIL RETRY 1 STOP

## 2. Unreached
- PASS COMPLETE
- FAIL STOP
`;

/** This process's start id as the seam's injected identity reports it. */
const SELF_START = 'self-start';

describe('RunbookLifecycleCommandService', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let seam: RunbookLifecycleCommandService;
  let steps: readonly ResolvedStep[];

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-seam-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    steps = [];
    seam = new RunbookLifecycleCommandService({
      manager,
      actorService,
      loadSteps: () => steps,
      processIdentity: createProcessIdentity(() => SELF_START),
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await closeRunbookStore(tmp);
    await rm(tmp, { recursive: true, force: true });
  });

  /**
   * Seed a run from markdown, initialise its machine, and hand back the Owner
   * Token — exactly what `rundown run` leaves behind.
   *
   * @param markdown - Runbook source; also sets the suite's `steps`.
   * @returns The run id and its Owner Token.
   */
  async function start(markdown: string): Promise<{ runId: string; token: OwnerToken }> {
    steps = createRunbook(markdown);
    const seeded = await seedRun(tmp, { markdown });
    await actorService.initializeState(seeded.runId, steps);
    return { runId: seeded.runId, token: seeded.ownerToken };
  }

  /**
   * Resolve the token to its running run, as the CLI does before every
   * mutating command.
   *
   * @param token - The Owner Token.
   * @returns The owned run.
   * @throws {Error} When the token does not resolve to a running run.
   */
  async function owned(token: OwnerToken): Promise<OwnedRun> {
    const resolution = await resolveOwnedRun(manager, token);
    if (resolution.kind !== 'running') {
      throw new Error(`expected a running run, got ${resolution.kind}`);
    }
    return resolution.run;
  }

  async function version(runId: string): Promise<number> {
    const loaded = await manager.loadWithVersion(runId);
    if (!loaded) throw new Error('run missing');
    return loaded.stateVersion;
  }

  describe('runTransition', () => {
    it('applies pass with --step naming the current top-level step and continues', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);

      const outcome = await seam.runTransition({ command: 'pass', run, target: { stepId: '1' } });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      expect(outcome.updatedState?.step).toBe('2');
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.progression).toEqual({
        kind: 'activate',
        authority: expect.objectContaining({ runId }),
        runbook: run.state.runbook,
        steps,
        entryBoundary: { kind: 'after_observed_transition', lifecycle: 'running' },
      });
      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('2');
      expect(persisted?.lastResult).toBe('pass');
    });

    it('applies pass with --step naming the current substep and moves to the sibling', async () => {
      const { runId, token } = await start(SUBSTEPS);
      const run = await owned(token);
      expect(run.state.substep).toBe('1');

      const outcome = await seam.runTransition({
        command: 'pass',
        run,
        target: { stepId: '1.1' },
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('1');
      expect(persisted?.substep).toBe('2');
      expect(persisted?.lastResult).toBe('pass');
    });

    it('applies pass with --step and --index naming the current FOR iteration', async () => {
      const { runId, token } = await start(FOR_LOOP);
      const run = await owned(token);

      const outcome = await seam.runTransition({
        command: 'pass',
        run,
        target: { stepId: '1.1', iteration: 1 },
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      // One body per iteration: passing iteration 1 advances the loop to 2.
      expect((await manager.load(runId))?.forStack?.[0]).toMatchObject({ iteration: 2 });
    });

    it('applies a PASS COMPLETE and reports the terminal boundary', async () => {
      const { runId, token } = await start(ONE_STEP_COMPLETE);
      const run = await owned(token);

      const outcome = await seam.runTransition({ command: 'pass', run, target: { stepId: '1' } });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(outcome.updatedState).toBeUndefined();
      expect(outcome.events.some((e) => e.type === 'RUNBOOK_COMPLETED')).toBe(true);
      expect(outcome.progression).toMatchObject({
        kind: 'activate',
        authority: { runId },
        entryBoundary: { kind: 'after_observed_transition', lifecycle: 'completed' },
      });
      // The token stays resolvable, and now says the run finished.
      expect(await resolveOwnedRun(manager, token)).toMatchObject({
        kind: 'finished',
        lifecycle: 'completed',
      });
    });

    it('drives FAIL through the fail handler distinctly from PASS', async () => {
      // pass -> STOP, fail -> CONTINUE: only the FAIL mapping advances, so a
      // continue + persisted `fail` proves the command drove the fail handler.
      const { runId, token } = await start(FAIL_CONTINUES);
      const run = await owned(token);

      const outcome = await seam.runTransition({ command: 'fail', run, target: { stepId: '1' } });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('2');
      expect(persisted?.lastResult).toBe('fail');
    });

    it('threads computeActionResult into the observation while persisting the command', async () => {
      const { runId, token } = await start(FAIL_CONTINUES);
      const run = await owned(token);

      const outcome = await seam.runTransition({
        command: 'fail',
        run,
        target: { stepId: '1' },
        computeActionResult: () => true,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      const transitioned = outcome.events.find((e) => e.type === 'STEP_TRANSITIONED');
      expect(transitioned?.payload).toMatchObject({ result: 'PASS' });
      expect((await manager.load(runId))?.lastResult).toBe('fail');
    });

    describe('refuses invalid_step_target and writes nothing', () => {
      it.each([
        {
          label: 'a missing --step',
          markdown: TWO_STEP,
          target: undefined,
          message: '--step is required; the current position is 1',
        },
        {
          label: 'a --step naming another step',
          markdown: TWO_STEP,
          target: { stepId: '2' },
          message: '--step 2 targets step "2" but the active step is "1"',
        },
        {
          label: 'a bare --step while a substep is active',
          markdown: SUBSTEPS,
          target: { stepId: '1' },
          message: '--step 1 must name the current substep; the current position is 1.1',
        },
        {
          label: 'a --step naming a sibling substep',
          markdown: SUBSTEPS,
          target: { stepId: '1.2' },
          message: '--step 1.2 names substep "2" but the current position is 1.1',
        },
        {
          label: 'a missing --index inside a FOR iteration',
          markdown: FOR_LOOP,
          target: { stepId: '1.1' },
          message: '--index is required inside FOR step "1" (current iteration 1)',
        },
        {
          label: 'a --index naming another FOR iteration',
          markdown: FOR_LOOP,
          target: { stepId: '1.1', iteration: 2 },
          message: '--index 2 names iteration 2 of FOR step "1" but the current iteration is 1',
        },
        {
          label: 'a --index on a step that is not a FOR step',
          markdown: TWO_STEP,
          target: { stepId: '1', iteration: 1 },
          message: '--index requires step "1" to be a FOR or PROMPTED-FOR step, but it is "base"',
        },
      ])('refuses $label', async ({ markdown, target, message }) => {
        const { runId, token } = await start(markdown);
        const run = await owned(token);
        const before = await version(runId);
        const save = jest.spyOn(RunbookStore.prototype, 'saveRunResolvingLease');

        const outcome = await seam.runTransition({ command: 'pass', run, target });

        expect(outcome).toEqual({ kind: 'invalid_step_target', message });
        expect(save).not.toHaveBeenCalled();
        expect(await version(runId)).toBe(before);
        expect(await manager.load(runId)).toEqual(run.state);
      });
    });

    it.each(['completed', 'stopped', 'abandoned'] as const)(
      'refuses run_finished for a %s run and writes nothing',
      async (lifecycle) => {
        const { runId, token } = await start(TWO_STEP);
        const live = await owned(token);
        await manager.update(runId, { lifecycle });
        const finished = await manager.loadWithVersion(runId);
        if (!finished) throw new Error('run missing');
        const save = jest.spyOn(RunbookStore.prototype, 'saveRunResolvingLease');

        const outcome = await seam.runTransition({
          command: 'pass',
          run: finished,
          target: { stepId: '1' },
        });

        expect(outcome).toEqual({ kind: 'run_finished', runId: live.state.id, lifecycle });
        expect(save).not.toHaveBeenCalled();
        expect(await version(runId)).toBe(finished.stateVersion);
      },
    );

    it('refuses concurrent_modification once, without retry, when a writer lands between load and save', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);
      // The owner's second command landed first.
      await manager.update(runId, { variables: merge({ raced: 'yes' }) });
      const racedVersion = await version(runId);
      const save = jest.spyOn(RunbookStore.prototype, 'saveRunResolvingLease');

      const outcome = await seam.runTransition({ command: 'pass', run, target: { stepId: '1' } });

      expect(outcome).toEqual({
        kind: 'concurrent_modification',
        runId,
        message: expect.stringContaining('nothing was written'),
      });
      expect(save).toHaveBeenCalledTimes(1);
      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('1');
      expect(persisted?.variables).toMatchObject({ raced: 'yes' });
      expect(await version(runId)).toBe(racedVersion);
    });

    it('refuses unknown_token when the run is pruned between token resolution and the save', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);
      // `rundown prune --token T` lands in another shell.
      await manager.delete(runId);

      const outcome = await seam.runTransition({ command: 'pass', run, target: { stepId: '1' } });

      expect(outcome).toEqual({ kind: 'unknown_token' });
      expect(await manager.load(runId)).toBeNull();
      expect(await resolveOwnedRun(manager, token)).toEqual({ kind: 'unknown_token' });
    });
  });

  describe('runTerminal', () => {
    it('applies complete, announces it, and leaves the token resolvable as finished', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);

      const outcome = await seam.runTerminal({ command: 'complete', run });

      expect(outcome).toMatchObject({
        kind: 'applied',
        runId,
        lifecycle: 'completed',
        progression: { kind: 'none' },
      });
      if (outcome.kind !== 'applied') return;
      expect(outcome.events.some((e) => e.type === 'RUNBOOK_COMPLETED')).toBe(true);
      expect((await manager.load(runId))?.lifecycle).toBe('completed');
      expect(await resolveOwnedRun(manager, token)).toMatchObject({
        kind: 'finished',
        lifecycle: 'completed',
      });
    });

    it('applies stop with a message and leaves the token resolvable as finished', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);

      const outcome = await seam.runTerminal({ command: 'stop', run, message: 'operator stop' });

      expect(outcome).toMatchObject({ kind: 'applied', runId, lifecycle: 'stopped' });
      if (outcome.kind !== 'applied') return;
      const stopped = outcome.events.find((e) => e.type === 'RUNBOOK_STOPPED');
      expect(stopped?.payload).toMatchObject({ message: 'operator stop' });
      expect((await manager.load(runId))?.lifecycle).toBe('stopped');
      expect(await resolveOwnedRun(manager, token)).toMatchObject({
        kind: 'finished',
        lifecycle: 'stopped',
      });
    });

    it('refuses run_finished for a run that already finished', async () => {
      const { runId, token } = await start(TWO_STEP);
      await owned(token);
      await manager.update(runId, { lifecycle: 'stopped' });
      const finished = await manager.loadWithVersion(runId);
      if (!finished) throw new Error('run missing');
      const save = jest.spyOn(RunbookStore.prototype, 'saveRunResolvingLease');

      const outcome = await seam.runTerminal({
        command: 'complete',
        run: finished,
      });

      expect(outcome).toEqual({ kind: 'run_finished', runId, lifecycle: 'stopped' });
      expect(save).not.toHaveBeenCalled();
      expect((await manager.load(runId))?.lifecycle).toBe('stopped');
    });

    it('refuses concurrent_modification once and leaves the run running', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);
      await manager.update(runId, { variables: merge({ raced: 'yes' }) });
      const save = jest.spyOn(RunbookStore.prototype, 'saveRunResolvingLease');

      const outcome = await seam.runTerminal({ command: 'stop', run });

      expect(outcome).toMatchObject({ kind: 'concurrent_modification', runId });
      expect(save).toHaveBeenCalledTimes(1);
      expect((await manager.load(runId))?.lifecycle).toBe('running');
    });

    it('refuses unknown_token when the run is pruned between token resolution and the save', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);
      await manager.delete(runId);

      const outcome = await seam.runTerminal({ command: 'stop', run });

      expect(outcome).toEqual({ kind: 'unknown_token' });
      expect(await manager.load(runId)).toBeNull();
    });
  });

  describe('navigation', () => {
    it('allows a GOTO on the owned run and applies it under the resolved version', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);

      const allowed = await seam.resolveRunNavigation({ run });
      expect(allowed).toMatchObject({ kind: 'allowed', runId });
      if (allowed.kind !== 'allowed') return;

      const outcome = await seam.runNavigationMutation({
        navigation: allowed.navigation,
        target: { step: '2' },
      });

      expect(outcome).toMatchObject({
        kind: 'applied',
        runId,
        previousState: expect.objectContaining({ step: '1' }),
        updatedState: expect.objectContaining({ step: '2' }),
        progression: {
          kind: 'activate',
          authority: expect.objectContaining({ runId }),
          entryBoundary: { kind: 'after_observed_transition', lifecycle: 'running' },
        },
      });
      expect((await manager.load(runId))?.step).toBe('2');
    });

    it('refuses run_finished for a finished run', async () => {
      const { runId, token } = await start(TWO_STEP);
      await owned(token);
      await manager.update(runId, { lifecycle: 'completed' });
      const finished = await manager.loadWithVersion(runId);
      if (!finished) throw new Error('run missing');

      const outcome = await seam.resolveRunNavigation({
        run: finished,
      });

      expect(outcome).toEqual({ kind: 'run_finished', runId, lifecycle: 'completed' });
    });

    it('refuses concurrent_modification when a writer lands between resolution and the GOTO', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);
      const allowed = await seam.resolveRunNavigation({ run });
      if (allowed.kind !== 'allowed') throw new Error('expected allowed');
      await manager.update(runId, { variables: merge({ raced: 'yes' }) });
      const save = jest.spyOn(RunbookStore.prototype, 'saveRunResolvingLease');

      const outcome = await seam.runNavigationMutation({
        navigation: allowed.navigation,
        target: { step: '2' },
      });

      expect(outcome).toMatchObject({ kind: 'concurrent_modification', runId });
      expect(save).toHaveBeenCalledTimes(1);
      expect((await manager.load(runId))?.step).toBe('1');
    });

    it('refuses unknown_token when the run is pruned between resolution and the GOTO', async () => {
      const { runId, token } = await start(TWO_STEP);
      const run = await owned(token);
      const allowed = await seam.resolveRunNavigation({ run });
      if (allowed.kind !== 'allowed') throw new Error('expected allowed');
      await manager.delete(runId);

      const outcome = await seam.runNavigationMutation({
        navigation: allowed.navigation,
        target: { step: '2' },
      });

      expect(outcome).toEqual({ kind: 'unknown_token' });
      expect(await manager.load(runId)).toBeNull();
    });
  });

  describe('execution lease (#902)', () => {
    /**
     * Leave the run's current step holding an execution lease, as a `rundown
     * run` whose command is still running (live) or was SIGKILLed (dead).
     *
     * @param runId - The run.
     * @param holder - `live` records another live process (the parent, as a
     *   second `rundown` process would be); `dead` records that pid under a
     *   start id that no longer matches, i.e. a recycled pid. This process's
     *   own pid is not used: a lease it holds outside a Run Progression turn
     *   reads Interrupted by definition.
     */
    async function leaseStep(runId: string, holder: 'live' | 'dead'): Promise<void> {
      const read = await manager.loadWithVersion(runId);
      if (!read) throw new Error('run missing');
      const acquired = await manager.acquireExecutionLease(read.state.id, read.stateVersion, {
        pid: process.ppid,
        startId: holder === 'live' ? SELF_START : 'a process that has since exited',
      });
      if (acquired.kind !== 'acquired') throw new Error(`lease not set: ${acquired.kind}`);
    }

    async function leaseOf(runId: string) {
      return (await manager.loadWithVersion(runId))?.lease ?? null;
    }

    describe('while In Progress every decision is refused and nothing is written', () => {
      it.each(['pass', 'fail'] as const)('refuses %s', async (command) => {
        const { runId, token } = await start(TWO_STEP);
        await leaseStep(runId, 'live');
        const before = await version(runId);

        const outcome = await seam.runTransition({
          command,
          run: await owned(token),
          target: { stepId: '1' },
        });

        expect(outcome).toMatchObject({
          kind: 'execution_in_progress',
          runId,
          step: '1',
          lease: { pid: process.ppid, startId: SELF_START },
        });
        expect(await version(runId)).toBe(before);
      });

      it.each(['complete', 'stop'] as const)('refuses %s', async (command) => {
        const { runId, token } = await start(TWO_STEP);
        await leaseStep(runId, 'live');
        const before = await version(runId);

        const outcome = await seam.runTerminal({ command, run: await owned(token) });

        expect(outcome).toMatchObject({ kind: 'execution_in_progress', runId });
        expect(await version(runId)).toBe(before);
      });

      it('refuses goto', async () => {
        const { runId, token } = await start(TWO_STEP);
        await leaseStep(runId, 'live');

        const outcome = await seam.resolveRunNavigation({ run: await owned(token) });

        expect(outcome).toMatchObject({ kind: 'execution_in_progress', runId });
      });
    });

    describe('while Interrupted', () => {
      it('refuses pass with the Interrupted reason and writes nothing', async () => {
        const { runId, token } = await start(TWO_STEP);
        await leaseStep(runId, 'dead');
        const before = await version(runId);

        const outcome = await seam.runTransition({
          command: 'pass',
          run: await owned(token),
          target: { stepId: '1' },
        });

        expect(outcome).toMatchObject({ kind: 'execution_interrupted', runId, step: '1' });
        expect(await version(runId)).toBe(before);
        expect(await leaseOf(runId)).not.toBeNull();
      });

      it('refuses complete with the Interrupted reason', async () => {
        const { runId, token } = await start(TWO_STEP);
        await leaseStep(runId, 'dead');

        const outcome = await seam.runTerminal({ command: 'complete', run: await owned(token) });

        expect(outcome).toMatchObject({ kind: 'execution_interrupted', runId });
      });

      it('lets fail decide the step and clears the lease', async () => {
        const { runId, token } = await start(TWO_STEP);
        await leaseStep(runId, 'dead');

        const outcome = await seam.runTransition({
          command: 'fail',
          run: await owned(token),
          target: { stepId: '1' },
        });

        expect(outcome).toMatchObject({ kind: 'applied', status: 'stopped' });
        expect(await leaseOf(runId)).toBeNull();
      });

      it('lets fail take an authored RETRY, re-entering the step with the lease cleared', async () => {
        const { runId, token } = await start(FAIL_RETRIES);
        await leaseStep(runId, 'dead');

        const outcome = await seam.runTransition({
          command: 'fail',
          run: await owned(token),
          target: { stepId: '1' },
        });

        expect(outcome).toMatchObject({ kind: 'applied', status: 'continue' });
        const after = await manager.loadWithVersion(runId);
        expect(after?.state.step).toBe('1');
        expect(after?.state.retryCount).toBe(1);
        expect(after?.lease).toBeNull();
      });

      it('lets stop decide the run and clears the lease', async () => {
        const { runId, token } = await start(TWO_STEP);
        await leaseStep(runId, 'dead');

        const outcome = await seam.runTerminal({ command: 'stop', run: await owned(token) });

        expect(outcome).toMatchObject({ kind: 'applied', lifecycle: 'stopped' });
        expect(await leaseOf(runId)).toBeNull();
      });

      it('lets goto move the cursor and clears the lease', async () => {
        const { runId, token } = await start(TWO_STEP);
        await leaseStep(runId, 'dead');

        const allowed = await seam.resolveRunNavigation({ run: await owned(token) });
        if (allowed.kind !== 'allowed') throw new Error(`expected allowed, got ${allowed.kind}`);
        const applied = await seam.runNavigationMutation({
          navigation: allowed.navigation,
          target: { step: '2' },
        });

        expect(applied.kind).toBe('applied');
        const after = await manager.loadWithVersion(runId);
        expect(after?.state.step).toBe('2');
        expect(after?.lease).toBeNull();
      });
    });
  });
});
