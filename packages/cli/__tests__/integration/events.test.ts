// packages/cli/__tests__/integration/events.test.ts
import { describe, it, expect } from '@jest/globals';
import { ExecutionEventEmitter, JSONSubscriber } from '@rundown-org/core';

describe('event output integration', () => {
  it('JSONSubscriber captures all event types', () => {
    const emitter = new ExecutionEventEmitter('wf-test', { name: 'test' });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    // Simulate execution sequence
    emitter.emit('RUNBOOK_STARTED', {
      prompted: false,
      statePath: '.claude/rundown/runs/wf-test.json',
    });
    emitter.emit('STEP_ENTERED', {
      position: { current: '1', total: 1 },
      stepName: '1',
      description: 'Test step',
      hasCommand: true,
      commandCode: 'echo test',
      commandLang: 'bash',
      isSubstep: false,
      prompted: false,
    });
    emitter.emit('COMMAND_STARTED', {
      command: 'echo test',
      displayCommand: 'echo test',
      position: { current: '1', total: 1 },
    });
    emitter.emit('COMMAND_COMPLETED', {
      command: 'echo test',
      success: true,
      exitCode: 0,
      position: { current: '1', total: 1 },
    });
    emitter.emit('STEP_TRANSITIONED', {
      action: 'COMPLETE',
      from: { current: '1', total: 1 },
      to: { current: '1', total: 1 },
      result: true,
    });
    emitter.emit('RUNBOOK_COMPLETED', {
      finalPosition: { current: '1', total: 1 },
    });

    const summary = subscriber.getSummary();
    expect(summary.status).toBe('complete');
    expect(summary.commandsRun).toBe(1);
    expect(summary.commandsFailed).toBe(0);
    expect(summary.events).toHaveLength(6);
    expect(summary.events.map((e) => e.type)).toEqual([
      'RUNBOOK_STARTED',
      'STEP_ENTERED',
      'COMMAND_STARTED',
      'COMMAND_COMPLETED',
      'STEP_TRANSITIONED',
      'RUNBOOK_COMPLETED',
    ]);
  });

  it('counts failed commands correctly', () => {
    const emitter = new ExecutionEventEmitter('wf-test', { name: 'test' });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    emitter.emit('RUNBOOK_STARTED', {
      prompted: false,
      statePath: '.claude/rundown/runs/wf-test.json',
    });
    emitter.emit('COMMAND_COMPLETED', {
      command: 'exit 1',
      success: false,
      exitCode: 1,
      position: { current: '1', total: 1 },
    });
    emitter.emit('RUNBOOK_STOPPED', {
      position: { current: '1', total: 1 },
      reason: 'fail_transition',
    });

    const summary = subscriber.getSummary();
    expect(summary.status).toBe('stopped');
    expect(summary.commandsRun).toBe(1);
    expect(summary.commandsFailed).toBe(1);
  });

  it('tracks policy denied commands', () => {
    const emitter = new ExecutionEventEmitter('wf-test', { name: 'test' });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    emitter.emit('RUNBOOK_STARTED', {
      prompted: false,
      statePath: '.claude/rundown/runs/wf-test.json',
    });
    emitter.emit('COMMAND_COMPLETED', {
      command: 'rm -rf /',
      success: false,
      exitCode: 126,
      position: { current: '1', total: 1 },
      policyDenied: true,
      denialReason: 'Dangerous command',
    });
    emitter.emit('RUNBOOK_STOPPED', {
      position: { current: '1', total: 1 },
      reason: 'policy_denied',
    });

    const summary = subscriber.getSummary();
    expect(summary.commandsFailed).toBe(1);

    // Verify COMMAND_COMPLETED contains policy denial info
    const cmdResult = subscriber.getEventsByType('COMMAND_COMPLETED')[0];
    expect(cmdResult.payload.policyDenied).toBe(true);
    expect(cmdResult.payload.denialReason).toBe('Dangerous command');
  });

  it('tracks event sequence numbers', () => {
    const emitter = new ExecutionEventEmitter('wf-test', { name: 'test' });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    emitter.emit('RUNBOOK_STARTED', {
      prompted: false,
      statePath: '.claude/rundown/runs/wf-test.json',
    });
    emitter.emit('STEP_ENTERED', {
      position: { current: '1', total: 1 },
      stepName: '1',
      description: 'Test',
      hasCommand: false,
      isSubstep: false,
      prompted: false,
    });

    const events = subscriber.getEvents();
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it('includes ISO timestamps on all events', () => {
    const emitter = new ExecutionEventEmitter('wf-test', { name: 'test' });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    emitter.emit('RUNBOOK_STARTED', {
      prompted: false,
      statePath: '.claude/rundown/runs/wf-test.json',
    });

    const event = subscriber.getEvents()[0];
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
