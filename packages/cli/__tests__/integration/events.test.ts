// packages/cli/__tests__/integration/events.test.ts
import { describe, it, expect } from '@jest/globals';
import { ExecutionEventEmitter, JSONSubscriber } from '@rundown-org/core';

describe('event output integration', () => {
  it('JSONSubscriber captures all event types', () => {
    const emitter = new ExecutionEventEmitter('wf-test', {
      source: 'project',
      path: 'test.runbook.md',
    });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    // Simulate execution sequence
    emitter.emit({
      type: 'RUNBOOK_STARTED',
      payload: {
        prompted: false,
        statePath: '.rundown/runs/wf-test.json',
      },
    });
    emitter.emit({
      type: 'STEP_ENTERED',
      payload: {
        position: { current: '1', total: 1 },
        stepName: '1',
        description: 'Test step',
        hasCommand: true,
        commandCode: 'echo test',
        commandLang: 'bash',
        isSubstep: false,
        prompted: false,
        artifacts: {},
      },
    });
    emitter.emit({
      type: 'COMMAND_STARTED',
      payload: {
        command: 'echo test',
        displayCommand: 'echo test',
        position: { current: '1', total: 1 },
      },
    });
    emitter.emit({
      type: 'COMMAND_COMPLETED',
      payload: {
        command: 'echo test',
        success: true,
        exitCode: 0,
        position: { current: '1', total: 1 },
      },
    });
    emitter.emit({
      type: 'STEP_TRANSITIONED',
      payload: {
        action: 'COMPLETE',
        from: '1',
        at: '1',
        result: 'PASS',
      },
    });
    emitter.emit({
      type: 'RUNBOOK_COMPLETED',
      payload: {
        finalPosition: { current: '1', total: 1 },
      },
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
    const emitter = new ExecutionEventEmitter('wf-test', {
      source: 'project',
      path: 'test.runbook.md',
    });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    emitter.emit({
      type: 'RUNBOOK_STARTED',
      payload: {
        prompted: false,
        statePath: '.rundown/runs/wf-test.json',
      },
    });
    emitter.emit({
      type: 'COMMAND_COMPLETED',
      payload: {
        command: 'exit 1',
        success: false,
        exitCode: 1,
        position: { current: '1', total: 1 },
      },
    });
    emitter.emit({
      type: 'RUNBOOK_STOPPED',
      payload: {
        position: { current: '1', total: 1 },
        reason: 'fail_transition',
      },
    });

    const summary = subscriber.getSummary();
    expect(summary.status).toBe('stopped');
    expect(summary.commandsRun).toBe(1);
    expect(summary.commandsFailed).toBe(1);
  });

  it('tracks policy denied commands', () => {
    const emitter = new ExecutionEventEmitter('wf-test', {
      source: 'project',
      path: 'test.runbook.md',
    });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    emitter.emit({
      type: 'RUNBOOK_STARTED',
      payload: {
        prompted: false,
        statePath: '.rundown/runs/wf-test.json',
      },
    });
    emitter.emit({
      type: 'COMMAND_COMPLETED',
      payload: {
        command: 'rm -rf /',
        success: false,
        exitCode: 126,
        position: { current: '1', total: 1 },
        policyDenied: true,
        denialReason: 'Dangerous command',
      },
    });
    emitter.emit({
      type: 'RUNBOOK_STOPPED',
      payload: {
        position: { current: '1', total: 1 },
        reason: 'policy_denied',
      },
    });

    const summary = subscriber.getSummary();
    expect(summary.commandsFailed).toBe(1);

    // Verify COMMAND_COMPLETED contains policy denial info
    const cmdResult = subscriber.getEventsByType('COMMAND_COMPLETED')[0];
    expect(cmdResult.payload.policyDenied).toBe(true);
    expect(cmdResult.payload.denialReason).toBe('Dangerous command');
  });

  it('tracks event sequence numbers', () => {
    const emitter = new ExecutionEventEmitter('wf-test', {
      source: 'project',
      path: 'test.runbook.md',
    });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    emitter.emit({
      type: 'RUNBOOK_STARTED',
      payload: {
        prompted: false,
        statePath: '.rundown/runs/wf-test.json',
      },
    });
    emitter.emit({
      type: 'STEP_ENTERED',
      payload: {
        position: { current: '1', total: 1 },
        stepName: '1',
        description: 'Test',
        hasCommand: false,
        isSubstep: false,
        prompted: false,
        artifacts: {},
      },
    });

    const events = subscriber.getEvents();
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it('includes ISO timestamps on all events', () => {
    const emitter = new ExecutionEventEmitter('wf-test', {
      source: 'project',
      path: 'test.runbook.md',
    });
    const subscriber = new JSONSubscriber();
    emitter.subscribe(subscriber.handle);

    emitter.emit({
      type: 'RUNBOOK_STARTED',
      payload: {
        prompted: false,
        statePath: '.rundown/runs/wf-test.json',
      },
    });

    const event = subscriber.getEvents()[0];
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
