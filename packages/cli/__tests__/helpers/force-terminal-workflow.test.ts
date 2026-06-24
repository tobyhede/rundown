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
});
