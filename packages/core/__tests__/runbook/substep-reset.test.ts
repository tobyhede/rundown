import { describe, expect, it } from '@jest/globals';
import { resetReopenedSubsteps } from '../../src/runbook/substep-reset.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, SubstepState } from '../../src/runbook/types.js';

const step: ResolvedStep = {
  name: '1',
  description: 'Step 1',
  kind: 'substeps',
  transitions: {
    pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
  },
  substeps: [
    {
      id: 'a',
      description: 'A',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    },
    {
      id: 'b',
      description: 'B',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    },
    {
      id: 'c',
      description: 'C',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    },
  ],
} as unknown as ResolvedStep;

const frame = buildFrameKey('1');

function done(id: string, result: 'pass' | 'fail'): SubstepState {
  return { id, frameKey: frame, status: 'done', result };
}

describe('resetReopenedSubsteps', () => {
  it('resets the from-substep and all later substeps in the active frame to pending, clearing result', () => {
    const before: SubstepState[] = [done('a', 'pass'), done('b', 'fail'), done('c', 'pass')];
    const after = resetReopenedSubsteps(step, frame, 'b', before);
    expect(after).toEqual([
      done('a', 'pass'),
      { id: 'b', frameKey: frame, status: 'pending' },
      { id: 'c', frameKey: frame, status: 'pending' },
    ]);
  });

  it('leaves substeps before N untouched', () => {
    const before: SubstepState[] = [done('a', 'pass'), done('b', 'fail'), done('c', 'pass')];
    const after = resetReopenedSubsteps(step, frame, 'b', before);
    expect(after[0]).toEqual(done('a', 'pass'));
  });

  it('resets only the from-substep when it is last (self-loop on last)', () => {
    const before: SubstepState[] = [done('a', 'pass'), done('b', 'pass'), done('c', 'pass')];
    const after = resetReopenedSubsteps(step, frame, 'c', before);
    expect(after).toEqual([
      done('a', 'pass'),
      done('b', 'pass'),
      { id: 'c', frameKey: frame, status: 'pending' },
    ]);
  });

  it('leaves rows in other frames untouched', () => {
    const otherFrame = buildFrameKey('1', 2);
    const before: SubstepState[] = [
      done('a', 'pass'),
      { id: 'b', frameKey: otherFrame, status: 'done', result: 'pass' },
    ];
    const after = resetReopenedSubsteps(step, frame, 'a', before);
    expect(after).toEqual([
      { id: 'a', frameKey: frame, status: 'pending' },
      { id: 'b', frameKey: otherFrame, status: 'done', result: 'pass' },
    ]);
  });

  it('preserves a delegation record on a reset row (status/result reset only)', () => {
    const before: SubstepState[] = [
      {
        id: 'a',
        frameKey: frame,
        status: 'done',
        result: 'pass',
        delegation: { token: 't' } as never,
      },
    ];
    const after = resetReopenedSubsteps(step, frame, 'a', before);
    expect(after[0]).toEqual({
      id: 'a',
      frameKey: frame,
      status: 'pending',
      delegation: { token: 't' },
    });
  });

  it('returns the input unchanged when fromSubstepId is not a declared substep', () => {
    const before: SubstepState[] = [done('a', 'pass')];
    const after = resetReopenedSubsteps(step, frame, 'zzz', before);
    expect(after).toBe(before);
  });
});
