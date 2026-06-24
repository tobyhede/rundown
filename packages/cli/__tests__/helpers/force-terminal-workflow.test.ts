import { describe, expect, it, jest } from '@jest/globals';
import { forceTerminalWorkflow } from '../../src/helpers/force-terminal-workflow.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';

describe('forceTerminalWorkflow', () => {
  it('returns already-terminal and releases the chain when the resolved root is not running', async () => {
    const child = {
      id: 'rd_child',
      lifecycle: 'running',
      runbook: { source: 'project', path: 'child.runbook.md' },
      step: '1',
    };
    const root = {
      id: 'rd_root',
      lifecycle: 'completed',
      runbook: { source: 'project', path: 'root.runbook.md' },
      step: '1',
    };
    const sessionService = {
      resolveActiveInlineForceTerminalPlan: jest.fn(async () => ({
        status: 'resolved',
        kind: 'complete',
        activeState: child,
        targetState: root,
        descendantStates: [child],
        forceOrder: [child, root],
        releaseRunIds: [child.id, root.id],
      })),
      releaseRunbooks: jest.fn(async (_runbookIds: readonly string[]) => ({
        releasedRunIds: [child.id, root.id],
        nextDefaultRunbookId: null,
      })),
    };
    const actorService = {
      sendAndSync: jest.fn(),
    };

    const result = await forceTerminalWorkflow({
      kind: 'complete',
      message: undefined,
      cwd: process.cwd(),
      sessionService: sessionService as never,
      actorService: actorService as never,
      output: new OutputEmitter(),
    });

    expect(result).toEqual({
      status: 'already-terminal',
      targetState: root,
      releaseRunIds: [child.id, root.id],
    });
    expect(actorService.sendAndSync).not.toHaveBeenCalled();
    expect(sessionService.releaseRunbooks).toHaveBeenCalledWith([child.id, root.id]);
  });

  it('maps the none plan to a NO_ACTIVE_RUNBOOK unavailable outcome', async () => {
    const sessionService = {
      resolveActiveInlineForceTerminalPlan: jest.fn(async () => ({ status: 'none' })),
      releaseRunbooks: jest.fn(),
    };
    const actorService = { sendAndSync: jest.fn() };

    const result = await forceTerminalWorkflow({
      kind: 'complete',
      message: undefined,
      cwd: process.cwd(),
      sessionService: sessionService as never,
      actorService: actorService as never,
      output: new OutputEmitter(),
    });

    expect(result).toEqual({
      status: 'none',
      message: 'No active runbook to complete',
      code: 'NO_ACTIVE_RUNBOOK',
    });
    expect(actorService.sendAndSync).not.toHaveBeenCalled();
    expect(sessionService.releaseRunbooks).not.toHaveBeenCalled();
  });

  it('maps a missing-inline-parent plan to an INLINE_PARENT_UNAVAILABLE outcome', async () => {
    const sessionService = {
      resolveActiveInlineForceTerminalPlan: jest.fn(async () => ({
        status: 'missing-inline-parent',
        missingParentRunId: 'rd_missing',
      })),
      releaseRunbooks: jest.fn(),
    };
    const actorService = { sendAndSync: jest.fn() };

    const result = await forceTerminalWorkflow({
      kind: 'stop',
      message: undefined,
      cwd: process.cwd(),
      sessionService: sessionService as never,
      actorService: actorService as never,
      output: new OutputEmitter(),
    });

    expect(result).toEqual({
      status: 'missing-inline-parent',
      message: 'Inline parent rd_missing is unavailable',
      code: 'INLINE_PARENT_UNAVAILABLE',
    });
    expect(actorService.sendAndSync).not.toHaveBeenCalled();
    expect(sessionService.releaseRunbooks).not.toHaveBeenCalled();
  });

  it('maps an inline-cycle plan to an INLINE_PARENT_CYCLE outcome', async () => {
    const sessionService = {
      resolveActiveInlineForceTerminalPlan: jest.fn(async () => ({
        status: 'inline-cycle',
        repeatedRunId: 'rd_loop',
      })),
      releaseRunbooks: jest.fn(),
    };
    const actorService = { sendAndSync: jest.fn() };

    const result = await forceTerminalWorkflow({
      kind: 'complete',
      message: undefined,
      cwd: process.cwd(),
      sessionService: sessionService as never,
      actorService: actorService as never,
      output: new OutputEmitter(),
    });

    expect(result).toEqual({
      status: 'inline-cycle',
      message: 'Inline parent cycle detected at rd_loop',
      code: 'INLINE_PARENT_CYCLE',
    });
    expect(actorService.sendAndSync).not.toHaveBeenCalled();
    expect(sessionService.releaseRunbooks).not.toHaveBeenCalled();
  });

  it('tolerates a null sendAndSync (snapshot race) and still releases + returns terminal', async () => {
    const root = {
      id: 'rd_root',
      lifecycle: 'running',
      runbook: { source: 'project', path: 'root.runbook.md' },
      step: '1',
      // getRunbookFromState resolves steps from the persisted source before
      // sendAndSync is dispatched, so a minimal valid runbook is required.
      runbookSrc: '# Root\n\n## 1. Do work\n\n- PASS COMPLETE\n- FAIL STOP\n',
    };
    const sessionService = {
      resolveActiveInlineForceTerminalPlan: jest.fn(async () => ({
        status: 'resolved',
        kind: 'complete',
        activeState: root,
        targetState: root,
        descendantStates: [],
        forceOrder: [root],
        releaseRunIds: [root.id],
      })),
      releaseRunbooks: jest.fn(async (_runbookIds: readonly string[]) => ({
        releasedRunIds: [root.id],
        nextDefaultRunbookId: null,
      })),
    };
    // The persisted snapshot vanished between resolution and dispatch.
    const actorService = {
      sendAndSync: jest.fn(async (_runId: string, _steps: unknown, _event: unknown) => null),
    };

    const result = await forceTerminalWorkflow({
      kind: 'complete',
      message: undefined,
      cwd: process.cwd(),
      sessionService: sessionService as never,
      actorService: actorService as never,
      output: new OutputEmitter(),
    });

    // No member was forced (the race skipped the only member), but the chain is
    // still released and a terminal outcome is returned without throwing.
    expect(result).toEqual({
      status: 'completed',
      targetState: root,
      finalTargetState: root,
      forcedRunIds: [],
    });
    expect(actorService.sendAndSync).toHaveBeenCalledTimes(1);
    expect(sessionService.releaseRunbooks).toHaveBeenCalledWith([root.id]);
  });
});
