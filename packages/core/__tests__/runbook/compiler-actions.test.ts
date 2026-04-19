import { describe, it, expect } from '@jest/globals';
import { actionRef, type CompilerActionRef } from '../../src/runbook/compiler-actions.js';
import type { LastAction } from '../../src/runbook/types.js';

describe('actionRef', () => {
  it('builds a setLastAction ref with the exact shape the setup expects', () => {
    const ref = actionRef('setLastAction', {
      action: { type: 'STOP' } as LastAction,
      msg: 'stopped for test',
    });

    expect(ref).toEqual({
      type: 'setLastAction',
      params: { action: { type: 'STOP' }, msg: 'stopped for test' },
    });
  });

  it('narrows on the discriminant so consumers can branch on ref.type', () => {
    const refs: CompilerActionRef[] = [
      actionRef('setLastAction', { action: { type: 'STOP' } as LastAction, msg: 'a' }),
      actionRef('setLastAction', { action: { type: 'COMPLETE' } as LastAction }),
    ];

    const seen: string[] = [];
    for (const ref of refs) {
      switch (ref.type) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- single-variant union in Phase 1; non-trivial after Phase 2 adds entries
        case 'setLastAction':
          seen.push(`set:${ref.params.action.type}`);
          break;
      }
    }

    expect(seen).toEqual(['set:STOP', 'set:COMPLETE']);
  });
});

describe('actionRef (type-level assertions)', () => {
  it('rejects unknown action names and mismatched params at compile time', () => {
    // @ts-expect-error - 'notAnAction' is not a key of ActionDefs
    actionRef('notAnAction', {});

    // @ts-expect-error - missing required 'action' field
    actionRef('setLastAction', { msg: 'no action' });

    // Sanity: the correct form compiles.
    actionRef('setLastAction', { action: { type: 'STOP' } as LastAction });
    expect(true).toBe(true);
  });
});
