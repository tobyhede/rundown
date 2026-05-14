import { describe, expect, it } from '@jest/globals';
import { createActor } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type { CurrentCursorResolvedCompletion } from '../../src/runbook/completion-service.js';
import type { BaseStep, ResolvedStep } from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

describe('APPLY_CURRENT_RESOLVED_COMPLETION event', () => {
  const DEFAULT_TRANSITIONS = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
  };

  function inferSteps(raw: Array<Omit<BaseStep, 'kind'>>): ResolvedStep[] {
    return raw.map((step) => ({ ...step, kind: 'base' }) as ResolvedStep);
  }

  function currentCompletion(
    result: 'pass' | 'fail',
    finalVars?: Readonly<Record<string, string>>,
  ): CurrentCursorResolvedCompletion {
    return {
      agentId: 'delegation',
      result,
      targetStep: '1',
      targetSubstep: '1',
      targetFrameKey: buildFrameKey('1'),
      targetEntry: 1,
      ...(finalVars ? { finalVars } : {}),
      completedAt: '2026-01-01T00:00:00.000Z',
      __currentCursorValidated: true,
    };
  }

  it('merges finalVars before applying a pass completion', () => {
    const steps = inferSteps([
      {
        name: '1',
        description: 'First',
        transitions: DEFAULT_TRANSITIONS,
      },
      {
        name: '2',
        description: 'Second',
        transitions: DEFAULT_TRANSITIONS,
      },
    ]);
    const actor = createActor(compileRunbookToMachine(steps));
    actor.start();

    actor.send({
      type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
      completion: currentCompletion('pass', { ChildValue: 'ready' }),
    });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.variables).toEqual({ ChildValue: 'ready' });
    expect(snapshot.value).toEqual({ 'step::2': 'idle' });
  });

  it('applies a fail completion as fail behavior', () => {
    const steps = inferSteps([
      {
        name: '1',
        description: 'First',
        transitions: DEFAULT_TRANSITIONS,
      },
    ]);
    const actor = createActor(compileRunbookToMachine(steps));
    actor.start();

    actor.send({
      type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
      completion: currentCompletion('fail'),
    });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe('STOPPED');
    expect(snapshot.context.lastAction).toEqual(expect.objectContaining({ type: 'STOP' }));
  });
});
