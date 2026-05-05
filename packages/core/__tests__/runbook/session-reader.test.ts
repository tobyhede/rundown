import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActiveRunScope } from '../../src/runbook/session-reader.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import type { Runbook, Step } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';

describe('readActiveRunScope', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let sessionService: SessionService;
  const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
  const mockRunbook: Runbook = {
    title: 'Test Runbook',
    description: 'A test',
    steps: mockSteps,
  };

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'session-reader-test-'));
    manager = new RunbookStateManager(testDir);
    sessionService = new SessionService(manager);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns an empty scope when no runbook is active', async () => {
    await expect(readActiveRunScope(testDir)).resolves.toEqual({});
  });

  it('returns active WorkPath and ContextId from effective vars', async () => {
    const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
      runbookPath: 'test.md',
      templateVars: {
        WorkPath: '.rundown/work',
        ContextId: 'ctx-abc',
      },
    });
    await sessionService.pushRunbook(state.id);

    await expect(readActiveRunScope(testDir)).resolves.toEqual({
      workPath: '.rundown/work',
      contextId: 'ctx-abc',
    });
  });

  it('uses stored outputs over template vars', async () => {
    const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
      runbookPath: 'test.md',
      templateVars: {
        WorkPath: '.rundown/work',
        ContextId: 'ctx-template',
      },
    });
    await manager.update(state.id, {
      variables: {
        WorkPath: '.rundown/work/output',
        ContextId: 'ctx-output',
      },
    });
    await sessionService.pushRunbook(state.id);

    await expect(readActiveRunScope(testDir)).resolves.toEqual({
      workPath: '.rundown/work/output',
      contextId: 'ctx-output',
    });
  });
});
