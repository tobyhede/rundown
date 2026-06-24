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

  it('returns root-unavailable (not terminal) when the resolved root sendAndSync races to null', async () => {
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

    // The only member (the resolved root) raced to null, so it was never forced
    // and `finalTargetState` would still be the RUNNING root. Returning a
    // terminal outcome here would let the command layer propagate a running root
    // to its parent as terminal, so surface a non-terminal `root-unavailable`
    // race outcome instead — while still releasing the chain and not throwing.
    expect(result).toEqual({
      status: 'root-unavailable',
      message: 'Runbook state changed during force-complete; retry',
      code: 'RUNBOOK_STATE_CHANGED',
    });
    expect(actorService.sendAndSync).toHaveBeenCalledTimes(1);
    expect(sessionService.releaseRunbooks).toHaveBeenCalledWith([root.id]);
  });

  it('still returns terminal when a DESCENDANT races to null but the root is forced', async () => {
    // Only the descendant's sendAndSync races; the root is forced normally. The
    // root drives propagation, so a descendant race is tolerated and the cascade
    // still reports a terminal outcome (this is the boundary the root-race guard
    // must not over-reach).
    const child = {
      id: 'rd_child',
      lifecycle: 'running',
      runbook: { source: 'project', path: 'child.runbook.md' },
      step: '1',
      runbookSrc: '# Child\n\n## 1. Do work\n\n- PASS COMPLETE\n- FAIL STOP\n',
    };
    const root = {
      id: 'rd_root',
      lifecycle: 'running',
      runbook: { source: 'project', path: 'root.runbook.md' },
      step: '1',
      runbookSrc: '# Root\n\n## 1. Do work\n\n- PASS COMPLETE\n- FAIL STOP\n',
    };
    const forcedRoot = { ...root, lifecycle: 'completed' };
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
    // The descendant races to null; the root is forced and returns its state.
    const actorService = {
      sendAndSync: jest.fn(async (runId: string, _steps: unknown, _event: unknown) =>
        runId === root.id ? { state: forcedRoot, snapshot: { context: {} }, effects: [] } : null,
      ),
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
      status: 'completed',
      targetState: root,
      finalTargetState: forcedRoot,
      forcedRunIds: [root.id],
    });
    expect(sessionService.releaseRunbooks).toHaveBeenCalledWith([child.id, root.id]);
  });
});
