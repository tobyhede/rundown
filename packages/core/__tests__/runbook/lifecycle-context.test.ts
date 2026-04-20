import { describe, it, expect } from '@jest/globals';
import { createActor } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { createRunbook } from './fixtures.js';

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
    expect(actor.getSnapshot().context.lifecycle).not.toBe('stopped');
    actor.stop();
  });

  it('sets context.lifecycle to "stopped" on STOPPED final entry', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.lifecycle).toBe('stopped');
    expect(actor.getSnapshot().context.lifecycle).not.toBe('completed');
    actor.stop();
  });

  it('no longer writes legacy variables.completed/stopped flags', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' });
    const vars = actor.getSnapshot().context.variables;
    expect(vars.completed).toBeUndefined();
    expect(vars.stopped).toBeUndefined();
    actor.stop();
  });
});
