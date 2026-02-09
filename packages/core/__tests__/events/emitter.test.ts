import { describe, it, expect, beforeEach } from '@jest/globals';
import { ExecutionEventEmitter } from '../../src/events/emitter.js';
import type { RunbookEventV1, RunbookRef } from '../../src/events/types.js';

describe('ExecutionEventEmitter', () => {
  let emitter: ExecutionEventEmitter;
  const runbook: RunbookRef = { name: 'test', path: 'test.md' };

  beforeEach(() => {
    emitter = new ExecutionEventEmitter('wf-test-123', runbook);
  });

  it('emits events to subscribers', () => {
    const received: RunbookEventV1[] = [];
    emitter.subscribe((event) => received.push(event));

    emitter.emit('RUNBOOK_STARTED', { title: 'Test', prompted: false, statePath: '.claude/rundown/runs/wf-test-123.json' });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('RUNBOOK_STARTED');
    expect(received[0].v).toBe('1');
  });

  it('assigns sequential seq numbers', () => {
    const received: RunbookEventV1[] = [];
    emitter.subscribe((event) => received.push(event));

    emitter.emit('RUNBOOK_STARTED', { title: 'Test', prompted: false, statePath: '.claude/rundown/runs/wf-test-123.json' });
    emitter.emit('STEP_ENTERED', {
      position: { current: '1', total: 5 },
      stepName: '1',
      description: 'Test step',
      hasCommand: true,
      isSubstep: false,
      isDynamic: false,
      prompted: false,
    });

    expect(received[0].seq).toBe(1);
    expect(received[1].seq).toBe(2);
  });

  it('generates ISO timestamps', () => {
    const received: RunbookEventV1[] = [];
    emitter.subscribe((event) => received.push(event));

    emitter.emit('RUNBOOK_STARTED', { title: 'Test', prompted: false, statePath: '.claude/rundown/runs/wf-test-123.json' });

    expect(received[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('unsubscribes correctly', () => {
    const received: RunbookEventV1[] = [];
    const unsub = emitter.subscribe((event) => received.push(event));

    emitter.emit('RUNBOOK_STARTED', { title: 'Test', prompted: false, statePath: '.claude/rundown/runs/wf-test-123.json' });
    unsub();
    emitter.emit('RUNBOOK_COMPLETED', {
      finalPosition: { current: '1', total: 1 },
    });

    expect(received).toHaveLength(1);
  });

  it('clears all subscribers', () => {
    const received: RunbookEventV1[] = [];
    emitter.subscribe((event) => received.push(event));

    emitter.clear();
    emitter.emit('RUNBOOK_STARTED', { title: 'Test', prompted: false, statePath: '.claude/rundown/runs/wf-test-123.json' });

    expect(received).toHaveLength(0);
  });
});
