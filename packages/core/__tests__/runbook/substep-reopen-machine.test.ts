import { describe, expect, it } from '@jest/globals';
import { createActor, transition } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, Substep, SubstepState } from '../../src/runbook/types.js';

const sub = (id: string): Substep =>
  ({
    kind: 'base',
    id,
    description: id,
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  }) as Substep;

const steps = [
  {
    name: '1',
    description: 'Step 1',
    kind: 'substeps',
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
    aggregation: { strategy: 'ALL' },
    substeps: [sub('a'), sub('b'), sub('c')],
  },
  {
    name: '2',
    description: 'Step 2',
    kind: 'plain',
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  },
] as unknown as ResolvedStep[];

const frame = buildFrameKey('1');

function seedDoneRows(): SubstepState[] {
  return [
    { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
    { id: 'b', frameKey: frame, status: 'done', result: 'pass' },
    { id: 'c', frameKey: frame, status: 'pending' },
  ];
}

describe('substep reset-on-reopen (machine-level, pure transition)', () => {
  it('GOTO backward to an earlier substep resets that substep and all later same-frame rows', () => {
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' });
    actor.send({ type: 'PASS' });
    const atC = actor.getSnapshot();
    actor.stop();

    const seeded = {
      ...atC,
      context: { ...atC.context, substepStates: seedDoneRows() },
    } as typeof atC;

    const [next] = transition(machine, seeded, {
      type: 'GOTO',
      target: { step: '1', substep: 'a' },
    });

    expect(next.context.substepStates).toEqual([
      { id: 'a', frameKey: frame, status: 'pending' },
      { id: 'b', frameKey: frame, status: 'pending' },
      { id: 'c', frameKey: frame, status: 'pending' },
    ]);
  });

  it('cross-step GOTO does not reset substepStates of the previous frame', () => {
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' });
    const atB = actor.getSnapshot();
    actor.stop();

    const seeded = {
      ...atB,
      context: {
        ...atB.context,
        substepStates: [{ id: 'a', frameKey: frame, status: 'done', result: 'pass' }],
      },
    } as typeof atB;

    const [next] = transition(machine, seeded, { type: 'GOTO', target: { step: '2' } });

    expect(next.context.substepStates).toEqual([
      { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
    ]);
  });
});
