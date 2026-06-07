import { describe, expect, it } from '@jest/globals';
import { createActor, transition } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, Substep, SubstepState } from '../../src/runbook/types.js';

const sub = (id: string): Substep => ({
  id,
  description: id,
  transitions: {
    pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
  },
});

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
    kind: 'base',
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  },
] satisfies ResolvedStep[];

const frame = buildFrameKey('1');
const frameOne = buildFrameKey('1', 1);
const frameTwo = buildFrameKey('1', 2);

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

  it('self-loop GOTO resets the target substep and later rows while preserving earlier rows', () => {
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
        substepStates: [
          { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
          { id: 'b', frameKey: frame, status: 'done', result: 'fail' },
          { id: 'c', frameKey: frame, status: 'pending' },
        ],
      },
    } as typeof atB;

    const [next] = transition(machine, seeded, {
      type: 'GOTO',
      target: { step: '1', substep: 'b' },
    });

    expect(next.context.substepStates).toEqual([
      { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
      { id: 'b', frameKey: frame, status: 'pending' },
      { id: 'c', frameKey: frame, status: 'pending' },
    ]);
  });

  it('GOTO inside a FOR iteration resets only the active iteration frame', () => {
    const forSteps = [
      {
        name: '1',
        description: 'Loop',
        kind: 'for',
        forClause: { start: 1, end: 2 },
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
        substeps: [sub('a'), sub('b')],
      },
      {
        name: '2',
        description: 'Done',
        kind: 'base',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      },
    ] satisfies ResolvedStep[];
    const machine = compileRunbookToMachine(forSteps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' });
    actor.send({ type: 'PASS' });
    actor.send({ type: 'PASS' });
    const atIterationTwoB = actor.getSnapshot();
    actor.stop();

    const seeded = {
      ...atIterationTwoB,
      context: {
        ...atIterationTwoB.context,
        substepStates: [
          { id: 'a', frameKey: frameOne, status: 'done', result: 'pass' },
          { id: 'b', frameKey: frameOne, status: 'done', result: 'pass' },
          { id: 'a', frameKey: frameTwo, status: 'done', result: 'fail' },
          { id: 'b', frameKey: frameTwo, status: 'done', result: 'pass' },
        ],
      },
    } as typeof atIterationTwoB;

    const [next] = transition(machine, seeded, {
      type: 'GOTO',
      target: { step: '1', substep: 'a' },
    });

    expect(next.context.substepStates).toEqual([
      { id: 'a', frameKey: frameOne, status: 'done', result: 'pass' },
      { id: 'b', frameKey: frameOne, status: 'done', result: 'pass' },
      { id: 'a', frameKey: frameTwo, status: 'pending' },
      { id: 'b', frameKey: frameTwo, status: 'pending' },
    ]);
  });

  it('intra-loop GOTO carrying an explicit `at` resets the active frame, not the `at` frame', () => {
    const forSteps = [
      {
        name: '1',
        description: 'Loop',
        kind: 'for',
        forClause: { start: 1, end: 2 },
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
        substeps: [sub('a'), sub('b')],
      },
      {
        name: '2',
        description: 'Done',
        kind: 'base',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      },
    ] satisfies ResolvedStep[];
    const machine = compileRunbookToMachine(forSteps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' });
    actor.send({ type: 'PASS' });
    actor.send({ type: 'PASS' });
    const atIterationTwoB = actor.getSnapshot();
    actor.stop();

    const seeded = {
      ...atIterationTwoB,
      context: {
        ...atIterationTwoB.context,
        substepStates: [
          { id: 'a', frameKey: frameOne, status: 'done', result: 'pass' },
          { id: 'b', frameKey: frameOne, status: 'done', result: 'pass' },
          { id: 'a', frameKey: frameTwo, status: 'done', result: 'fail' },
          { id: 'b', frameKey: frameTwo, status: 'done', result: 'pass' },
        ],
      },
    } as typeof atIterationTwoB;

    // initForStack ignores `at` for an intra-loop GOTO and stays on iteration 2,
    // so the reset must target frame two regardless of the `at: 1` qualifier.
    const [next] = transition(machine, seeded, {
      type: 'GOTO',
      target: { step: '1', substep: 'a', at: 1 },
    });

    expect(next.context.substepStates).toEqual([
      { id: 'a', frameKey: frameOne, status: 'done', result: 'pass' },
      { id: 'b', frameKey: frameOne, status: 'done', result: 'pass' },
      { id: 'a', frameKey: frameTwo, status: 'pending' },
      { id: 'b', frameKey: frameTwo, status: 'pending' },
    ]);
  });
});
