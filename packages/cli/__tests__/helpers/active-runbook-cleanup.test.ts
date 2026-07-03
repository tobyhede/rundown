// packages/cli/__tests__/helpers/active-runbook-cleanup.test.ts
//
// Regression coverage for #518: cleanupOrphanedActiveStack must verify the top
// default-stack entry is actually unusable before deleting it. Uses REAL core
// services against a temp project dir — this is persistence behavior, so no
// mocks.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunbookStateManager,
  SessionService,
  statePath,
  type Runbook,
  type RunbookState,
} from '@rundown-org/core';
import { cleanupOrphanedActiveStack } from '../../src/helpers/active-runbook-cleanup.js';

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

  async function corruptStateFile(id: string): Promise<void> {
    await writeFile(statePath(tmpCwd, id), 'not json', 'utf8');
  }

  it('returns empty-stack and touches nothing when the default stack is empty', async () => {
    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'empty-stack' });
    const session = await manager.loadSession();
    expect(session.defaultStack).toHaveLength(0);
  });

  it('removes the top when its state file is missing', async () => {
    const run = await createRun();
    await unlink(statePath(tmpCwd, run.id));

    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'removed', runId: run.id });
    const session = await manager.loadSession();
    expect(session.defaultStack).not.toContain(run.id);
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
    const raw = JSON.parse(await readFile(statePath(tmpCwd, run.id), 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      statePath(tmpCwd, run.id),
      JSON.stringify({ ...raw, schemaVersion: 99 }),
      'utf8',
    );

    const result = await cleanupOrphanedActiveStack(manager, sessionService);

    expect(result).toEqual({ kind: 'removed', runId: run.id });
    const session = await manager.loadSession();
    expect(session.defaultStack).not.toContain(run.id);
  });

  it('removes the top when its state file is a legacy dynamic-step snapshot', async () => {
    const run = await createRun();
    const raw = JSON.parse(await readFile(statePath(tmpCwd, run.id), 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      statePath(tmpCwd, run.id),
      JSON.stringify({ ...raw, lastAction: { type: 'GOTO_NEXT' } }),
      'utf8',
    );

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
    await expect(readFile(statePath(tmpCwd, run.id), 'utf8')).resolves.toBeDefined();
    const session = await manager.loadSession();
    expect(session.defaultStack).toContain(run.id);
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
