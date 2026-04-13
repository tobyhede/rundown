import { describe, it, expect, beforeEach } from '@jest/globals';
import { JSONSubscriber } from '../../../src/events/subscribers/json.js';
import type { RunbookEventV1 } from '../../../src/events/types.js';

describe('JSONSubscriber', () => {
  let subscriber: JSONSubscriber;

  beforeEach(() => {
    subscriber = new JSONSubscriber();
  });

  const makeEvent = <T extends RunbookEventV1['type']>(
    type: T,
    payload: Extract<RunbookEventV1, { type: T }>['payload'],
    seq = 1,
  ): Extract<RunbookEventV1, { type: T }> =>
    ({
      v: '1',
      type,
      ts: new Date().toISOString(),
      runbookId: 'wf-test',
      runbook: { name: 'test', path: 'test.md' },
      seq,
      payload,
    }) as Extract<RunbookEventV1, { type: T }>;

  it('collects events', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', { prompted: false, statePath: '.rundown/runs/wf-test.json' }, 1),
    );
    subscriber.handle(
      makeEvent(
        'STEP_TRANSITIONED',
        {
          action: 'CONTINUE',
          from: '1',
          at: '2',
          result: 'PASS',
        },
        2,
      ),
    );

    expect(subscriber.getEvents()).toHaveLength(2);
  });

  it('builds execution summary for complete runbook', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', { prompted: false, statePath: '.rundown/runs/wf-test.json' }, 1),
    );
    subscriber.handle(
      makeEvent(
        'COMMAND_COMPLETED',
        {
          command: 'echo test',
          success: true,
          exitCode: 0,
          position: { current: '1', total: 1 },
        },
        2,
      ),
    );
    subscriber.handle(
      makeEvent(
        'RUNBOOK_COMPLETED',
        {
          finalPosition: { current: '1', total: 1 },
          message: 'Done',
        },
        3,
      ),
    );

    const summary = subscriber.getSummary();
    expect(summary.kind).toBe('execution_summary');
    expect(summary.status).toBe('complete');
    expect(summary.commandsRun).toBe(1);
    expect(summary.commandsFailed).toBe(0);
    expect(summary.message).toBe('Done');
  });

  it('builds execution summary for stopped runbook', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', { prompted: false, statePath: '.rundown/runs/wf-test.json' }, 1),
    );
    subscriber.handle(
      makeEvent(
        'RUNBOOK_STOPPED',
        {
          position: { current: '1', total: 1 },
          message: 'Failed',
          reason: 'fail_transition',
        },
        2,
      ),
    );

    const summary = subscriber.getSummary();
    expect(summary.status).toBe('stopped');
    expect(summary.message).toBe('Failed');
  });

  it('clears collected events', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', {
        prompted: false,
        statePath: '.rundown/runs/wf-test.json',
      }),
    );
    subscriber.clear();
    expect(subscriber.getEvents()).toHaveLength(0);
  });

  it('collects ERROR_OCCURRED events', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', { prompted: false, statePath: '.rundown/runs/wf-test.json' }, 1),
    );
    subscriber.handle(
      makeEvent(
        'ERROR_OCCURRED',
        {
          message: 'Command timed out',
          code: 'TIMEOUT',
          position: { current: '1', total: 2 },
        },
        2,
      ),
    );

    const errors = subscriber.getEventsByType('ERROR_OCCURRED');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.message).toBe('Command timed out');
    expect(errors[0].payload.code).toBe('TIMEOUT');
  });

  it('builds summary for empty runbook (no steps executed)', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', { prompted: false, statePath: '.rundown/runs/wf-test.json' }, 1),
    );
    subscriber.handle(
      makeEvent(
        'RUNBOOK_COMPLETED',
        {
          finalPosition: { current: '0', total: 0 },
        },
        2,
      ),
    );

    const summary = subscriber.getSummary();
    expect(summary.status).toBe('complete');
    expect(summary.stepsExecuted).toBe(0);
    expect(summary.commandsRun).toBe(0);
    expect(summary.commandsFailed).toBe(0);
    expect(summary.runbookId).toBe('wf-test');
  });

  it('counts multiple commands with mixed success/failure', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', { prompted: false, statePath: '.rundown/runs/wf-test.json' }, 1),
    );
    subscriber.handle(
      makeEvent(
        'COMMAND_COMPLETED',
        {
          command: 'echo 1',
          success: true,
          exitCode: 0,
          position: { current: '1', total: 3 },
        },
        2,
      ),
    );
    subscriber.handle(
      makeEvent(
        'COMMAND_COMPLETED',
        {
          command: 'false',
          success: false,
          exitCode: 1,
          position: { current: '2', total: 3 },
        },
        3,
      ),
    );
    subscriber.handle(
      makeEvent(
        'COMMAND_COMPLETED',
        {
          command: 'echo 2',
          success: true,
          exitCode: 0,
          position: { current: '3', total: 3 },
        },
        4,
      ),
    );
    subscriber.handle(
      makeEvent(
        'RUNBOOK_COMPLETED',
        {
          finalPosition: { current: '3', total: 3 },
        },
        5,
      ),
    );

    const summary = subscriber.getSummary();
    expect(summary.commandsRun).toBe(3);
    expect(summary.commandsFailed).toBe(1);
  });

  it('returns running status before terminal event', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', { prompted: false, statePath: '.rundown/runs/wf-test.json' }, 1),
    );
    subscriber.handle(
      makeEvent(
        'COMMAND_COMPLETED',
        {
          command: 'echo test',
          success: true,
          exitCode: 0,
          position: { current: '1', total: 2 },
        },
        2,
      ),
    );

    const summary = subscriber.getSummary();
    expect(summary.status).toBe('running');
    expect(summary.runbookId).toBe('wf-test');
    expect(summary.runbook).toBe('test.md');
    expect(summary.finalPosition).toBeUndefined();
    expect(summary.message).toBeUndefined();
  });
});
