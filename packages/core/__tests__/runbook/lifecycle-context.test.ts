import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { parseRunbookDocument, areAllStepsResolved } from '@rundown-org/parser';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type { ResolvedStep } from '../../src/runbook/types.js';

function createRunbook(markdown: string): ResolvedStep[] {
  const { runbook } = parseRunbookDocument(markdown);
  const steps = [...runbook.steps];
  if (!areAllStepsResolved(steps)) {
    throw new Error('Test runbook has unresolved FOR bounds or runbook references');
  }
  return [...steps];
}

describe('lifecycle context field', () => {
  it('initializes context.lifecycle to "running"', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    const ctx = actor.getSnapshot().context;
    expect(ctx.lifecycle).toBe('running');
    actor.stop();
  });

  it('sets context.lifecycle to "completed" on COMPLETE final entry', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' });
    expect(actor.getSnapshot().context.lifecycle).toBe('completed');
    actor.stop();
  });

  it('sets context.lifecycle to "stopped" on STOPPED final entry', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.lifecycle).toBe('stopped');
    actor.stop();
  });

  it('still writes the legacy variables.completed flag (coexistence phase)', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' });
    // Backward-compat assertion — removed in Task 5.
    expect(actor.getSnapshot().context.variables.completed).toBe(true);
    actor.stop();
  });
});
