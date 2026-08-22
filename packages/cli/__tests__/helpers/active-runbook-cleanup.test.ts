// packages/cli/__tests__/helpers/active-runbook-cleanup.test.ts
//
// Regression coverage for #518: cleanupOrphanedActiveStack must verify the top
// default-stack entry is actually unusable before deleting it. Uses REAL core
// services against a temp project dir — this is persistence behavior, so no
// mocks.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidRunbookStateError,
  LegacySnapshotError,
  RunbookStateManager,
  SessionService,
  type Runbook,
  type RunbookState,
} from '@rundown-org/core';
import {
  patchPersistedRunState,
  readPersistedRunState,
  writeRawRunJson,
} from '@rundown-org/core/testing/session-fixtures';
import {
  cleanupOrphanedActiveStack,
  isRecoverableActiveStackError,
} from '../../src/helpers/active-runbook-cleanup.js';
import { seedExecutionOwnership } from './test-utils.js';

const RUNBOOK: Runbook = {
  title: 'Cleanup Test Runbook',
  description: 'A test',
  steps: [
    {
      name: '1',
      description: 'Initial step',
      prompt: 'Do the thing.',
      passAction: { type: 'CONTINUE' },
      failAction: { type: 'STOP' },
      substeps: [],
    },
  ],
} as unknown as Runbook;

describe('isRecoverableActiveStackError', () => {
  it('classifies by error type, not message wording', () => {
    // The three unusable-state shapes qualify regardless of message text.
    expect(isRecoverableActiveStackError(new InvalidRunbookStateError('anything'))).toBe(true);
    expect(isRecoverableActiveStackError(new LegacySnapshotError('reworded entirely'))).toBe(true);
    expect(isRecoverableActiveStackError(new SyntaxError('Unexpected token'))).toBe(true);
  });

  it('does not treat a generic error mentioning legacy snapshots as recoverable', () => {
    // Regression: recoverability once matched on the phrase
    // 'dynamic-step snapshots'; a copy edit in core (or an unrelated error
    // quoting it) must not grant deletion authority.
    expect(
      isRecoverableActiveStackError(new Error('failed while reading dynamic-step snapshots')),
    ).toBe(false);
  });

  it('does not treat environmental errors as recoverable', () => {
    expect(isRecoverableActiveStackError(new Error('EPERM: operation not permitted'))).toBe(false);
  });
});

describe('cleanupOrphanedActiveStack', () => {
  let tmpCwd: string;
  let manager: RunbookStateManager;
  let sessionService: SessionService;

  beforeEach(async () => {
    tmpCwd = await mkdtemp(join(tmpdir(), 'rd-cleanup-'));
    manager = new RunbookStateManager(tmpCwd);
    sessionService = new SessionService(manager);
  });

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true });
  });

  async function createRun(): Promise<RunbookState> {
    const state = await manager.create(
      { source: 'project', path: 'cleanup-test.runbook.md' },
      RUNBOOK,
      { runbookPath: 'cleanup-test.runbook.md' },
    );
    await sessionService.pushRunbook(state.id);
    return state;
  }

  /** Push a run and mint the run-control claim `rundown run` would give it. */
  async function createClaimedRun(): Promise<RunbookState> {
    const state = await manager.create(
      { source: 'project', path: 'cleanup-test.runbook.md' },
      RUNBOOK,
      { runbookPath: 'cleanup-test.runbook.md' },
    );
    const pushed = await sessionService.pushRunbookWithPreparedRunControlClaim(
      state.id,
      sessionService.prepareRunControlClaim(state.id),
    );
    if (pushed.kind !== 'committed') throw new Error(`push refused: ${pushed.kind}`);
    return state;
  }

  async function corruptStateFile(id: string): Promise<void> {
    await writeRawRunJson(tmpCwd, id, 'not json');
  }

  it('returns empty-stack and touches nothing when the default stack is empty', async () => {
    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'empty-stack' });
    const session = await manager.loadSession();
    expect(session.defaultStack).toHaveLength(0);
  });

  it('removes the top when its state file is corrupt JSON', async () => {
    const run = await createRun();
    await corruptStateFile(run.id);

    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'removed', runId: run.id });
    const session = await manager.loadSession();
    expect(session.defaultStack).not.toContain(run.id);
  });

  it('removes the top when its state file has an invalid schemaVersion', async () => {
    const run = await createRun();
    await patchPersistedRunState(tmpCwd, run.id, { schemaVersion: 99 });

    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'removed', runId: run.id });
    const session = await manager.loadSession();
    expect(session.defaultStack).not.toContain(run.id);
  });

  it('revokes the claims controlling an orphan it removes', async () => {
    // Pins the end state a caller can observe: an orphan cleanup leaves no claim
    // controlling the run it removed.
    //
    // It does NOT pin the release ROLE, and that is worth stating rather than
    // leaving for the next reader to discover. `cleanupOrphanedActiveStack`
    // deletes the run row immediately after releasing, and the claims table
    // cascades on that delete, so the claim is gone whether the release revoked
    // it (`discarded`) or retained it (`addressed`) — verified by flipping the
    // role and watching this test still pass. The role is still correct at the
    // seam: the window between release and delete is real, and a process that
    // dies inside it leaves a retained claim over a run nobody can read. That
    // window is what `discarded` is for, and no unit test observes it.
    const run = await createClaimedRun();
    const before = await manager.loadSession();
    expect(Object.values(before.claims).map((claim) => claim.controlledRunId)).toEqual([run.id]);
    await corruptStateFile(run.id);

    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'removed', runId: run.id });
    const session = await manager.loadSession();
    expect(session.defaultStack).not.toContain(run.id);
    expect(Object.values(session.claims)).toEqual([]);
  });

  it('refuses and leaves the orphan intact when the run is under execution (#608)', async () => {
    // Release runs BEFORE manager.delete precisely so an ownership refusal is
    // decisive: the verified-unusable orphan is still on the stack and its
    // state file still exists. Under the old delete-then-release order the
    // state would already be gone when the release refused.
    const run = await createRun();
    await patchPersistedRunState(tmpCwd, run.id, { schemaVersion: 99 });
    seedExecutionOwnership(tmpCwd, run.id);

    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({
      kind: 'execution_in_progress',
      runId: run.id,
      message: `Run ${run.id} has an execution in progress.`,
    });
    const session = await manager.loadSession();
    expect(session.defaultStack).toContain(run.id);
    expect(await readPersistedRunState(tmpCwd, run.id)).not.toBeNull();
  });

  it('removes the top when its state file is a legacy dynamic-step snapshot', async () => {
    const run = await createRun();
    await patchPersistedRunState(tmpCwd, run.id, { lastAction: { type: 'GOTO_NEXT' } });

    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'removed', runId: run.id });
    const session = await manager.loadSession();
    expect(session.defaultStack).not.toContain(run.id);
  });

  it('rethrows a non-recoverable load error without deleting anything', async () => {
    const run = await createRun();
    jest
      .spyOn(manager, 'load')
      .mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }));

    await expect(cleanupOrphanedActiveStack(manager, sessionService)).rejects.toThrow(
      'disk failure',
    );

    // Nothing was deleted or released — the probe failure is not authority to remove.
    await expect(readPersistedRunState(tmpCwd, run.id)).resolves.not.toBeNull();
    const session = await manager.loadSession();
    expect(session.defaultStack).toContain(run.id);
  });

  it('classifies the refusal thrown by the store seam, not only the loader (#666)', async () => {
    // Two things at once, and both are load-bearing.
    //
    // Taxonomy: `SessionService.stash()` resolves its target through the store's
    // in-transaction `ctx.readState`, not through `manager.load`. That seam threw
    // a bare `ZodError` for a legacy run until the three pre-parse gates became
    // one shared function, which put the refusal outside all three arms below.
    //
    // Identity: the class is defined in core's leaf guard module and re-exported
    // twice before the CLI imports it from `@rundown-org/core`. A second
    // definition anywhere on that chain leaves every `instanceof` silently false
    // — a failure no message assertion can see.
    const run = await createRun();
    await patchPersistedRunState(tmpCwd, run.id, { lastAction: { type: 'GOTO_NEXT' } });

    const thrown: unknown = await sessionService.stash().then(
      (value) => value,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(LegacySnapshotError);
    expect(isRecoverableActiveStackError(thrown as Error)).toBe(true);
  });

  it('refuses to delete a healthy top when a deeper entry is corrupt (#518)', async () => {
    const parent = await createRun(); // bottom (will be corrupted)
    const child = await createRun(); // top (valid, running)
    await corruptStateFile(parent.id);

    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'healthy-top', runId: child.id });
    await expect(manager.load(child.id)).resolves.not.toBeNull();
    const session = await manager.loadSession();
    expect(session.defaultStack).toContain(child.id);
  });
});
