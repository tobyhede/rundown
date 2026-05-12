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

  it('no longer writes legacy variables.completed/stopped flags on FAIL → stopped path', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().context.lifecycle).toBe('stopped');
    const vars = actor.getSnapshot().context.variables;
    expect(vars.completed).toBeUndefined();
    expect(vars.stopped).toBeUndefined();
    actor.stop();
  });

  it('FORCE_COMPLETE enters COMPLETE with lastAction and lastMessage from the event', () => {
    const steps = createRunbook(`## 1. Only\n- PASS CONTINUE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    actor.send({ type: 'FORCE_COMPLETE', message: 'Enough work is done' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe('COMPLETE');
    expect(snapshot.context.lifecycle).toBe('completed');
    expect(snapshot.context.lastAction).toEqual({ type: 'COMPLETE' });
    expect(snapshot.context.lastMessage).toBe('Enough work is done');
    actor.stop();
  });

  it('FORCE_STOP enters STOPPED with lastAction and lastMessage from the event', () => {
    const steps = createRunbook(`## 1. Only\n- PASS CONTINUE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();

    actor.send({ type: 'FORCE_STOP', message: 'Operator cancelled' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe('STOPPED');
    expect(snapshot.context.lifecycle).toBe('stopped');
    expect(snapshot.context.lastAction).toEqual({ type: 'STOP' });
    expect(snapshot.context.lastMessage).toBe('Operator cancelled');
    actor.stop();
  });

  it('forced terminal events clear stale lastMessage when no message is supplied', () => {
    const steps = createRunbook(`## 1. Only\n- PASS CONTINUE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);

    // Initialize actor and capture snapshot shape for hydration
    const initialActor = createActor(machine);
    initialActor.start();
    const initialSnapshot = initialActor.getSnapshot();
    initialActor.stop();

    // Create hydrated snapshot with stale lastMessage pre-set
    const hydratedSnapshot = {
      ...initialSnapshot,
      context: { ...initialSnapshot.context, lastMessage: 'stale message' },
    };

    // Rehydrate actor from persisted snapshot
    const actor = createActor(machine, { snapshot: hydratedSnapshot });
    actor.start();
    expect(actor.getSnapshot().context.lastMessage).toBe('stale message');

    actor.send({ type: 'FORCE_COMPLETE' });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe('COMPLETE');
    expect(snapshot.context.lastMessage).toBeUndefined();
    actor.stop();
  });
});
