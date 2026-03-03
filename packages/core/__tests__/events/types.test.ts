import { describe, it, expect } from '@jest/globals';
import type {
  RunbookEventV1,
  RunbookStartedPayload,
  StepTransitionedPayload,
} from '../../src/events/types.js';

describe('RunbookEventV1 types', () => {
  it('creates valid RUNBOOK_STARTED event', () => {
    const event: RunbookEventV1 = {
      v: '1',
      type: 'RUNBOOK_STARTED',
      ts: '2026-01-21T00:00:00.000Z',
      runbookId: 'wf-2026-01-21-abc123',
      runbook: { name: 'test', path: '.claude/rundown/runbooks/test.md' },
      seq: 1,
      payload: {
        title: 'Test Runbook',
        prompted: false,
        statePath: '.claude/rundown/runs/wf-2026-01-21-abc123.json',
      } satisfies RunbookStartedPayload,
    };
    expect(event.type).toBe('RUNBOOK_STARTED');
    expect(event.v).toBe('1');
  });

  it('creates valid STEP_TRANSITIONED event', () => {
    const event: RunbookEventV1 = {
      v: '1',
      type: 'STEP_TRANSITIONED',
      ts: '2026-01-21T00:00:00.000Z',
      runbookId: 'wf-2026-01-21-abc123',
      runbook: { name: 'test', path: '.claude/rundown/runbooks/test.md' },
      seq: 2,
      payload: {
        action: 'CONTINUE',
        from: '1',
        at: '2',
        result: 'PASS',
      } satisfies StepTransitionedPayload,
    };
    expect(event.type).toBe('STEP_TRANSITIONED');
  });
});
