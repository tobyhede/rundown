import { describe, it, expect, beforeEach } from '@jest/globals';
import { CLISubscriber } from '../../../src/events/subscribers/cli.js';
import { TestWriter, resetColorCache, setColorEnabled } from '../../../src/cli/index.js';
import type { RunbookEventV1 } from '../../../src/events/types.js';

describe('CLISubscriber', () => {
  let writer: TestWriter;
  let subscriber: CLISubscriber;

  beforeEach(() => {
    writer = new TestWriter();
    resetColorCache();
    setColorEnabled(false);
    subscriber = new CLISubscriber(writer);
  });

  const makeEvent = <T extends RunbookEventV1['type']>(
    type: T,
    payload: Extract<RunbookEventV1, { type: T }>['payload'],
  ): Extract<RunbookEventV1, { type: T }> =>
    ({
      v: '1',
      type,
      ts: new Date().toISOString(),
      runbookId: 'wf-test',
      runbook: { source: 'project', path: 'test.runbook.md' },
      seq: 1,
      payload,
    }) as Extract<RunbookEventV1, { type: T }>;

  it('renders RUNBOOK_STARTED event with metadata', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STARTED', {
        title: 'Test',
        prompted: false,
        statePath: '.rundown/runs/wf-test.json',
      }),
    );
    const output = writer.getOutput();
    expect(output).toContain('File:');
    expect(output).toContain('State:');
    expect(output).toContain('Action:');
    expect(output).toContain('START');
  });

  it('renders STEP_ENTERED with prompted flag', () => {
    subscriber.handle(
      makeEvent('STEP_ENTERED', {
        position: { current: '1', total: 5 },
        stepName: '1',
        description: 'Test step',
        hasCommand: true,
        isSubstep: false,
        prompted: true,
      }),
    );
    const output = writer.getOutput();
    expect(output).toContain('Test step');
  });

  it('renders STEP_TRANSITIONED event with separator', () => {
    subscriber.handle(
      makeEvent('STEP_TRANSITIONED', {
        action: 'CONTINUE',
        from: '1',
        at: '2',
        result: 'PASS',
      }),
    );
    const output = writer.getOutput();

    // Verify separator is present (em-dash character)
    expect(output).toContain('─');

    // Verify step number appears in separator
    expect(output).toContain('2');

    // Verify action block content
    expect(output).toContain('Action:');
    expect(output).toContain('CONTINUE');
    expect(output).toContain('PASS');
  });

  it('renders RUNBOOK_COMPLETED event', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_COMPLETED', {
        message: 'All done!',
        finalPosition: { current: '5', total: 5 },
      }),
    );
    const output = writer.getOutput();
    expect(output).toContain('Runbook:');
    expect(output).toContain('COMPLETE');
  });

  it('renders POLICY_DENIED event', () => {
    subscriber.handle(
      makeEvent('POLICY_DENIED', {
        command: 'rm -rf /',
        reason: 'Dangerous command',
        position: { current: '1', total: 1 },
      }),
    );
    const output = writer.getOutput();
    expect(output).toContain('Policy Denied');
  });

  it('renders RUNBOOK_STOPPED event with position', () => {
    subscriber.handle(
      makeEvent('RUNBOOK_STOPPED', {
        position: { current: '3', total: 5 },
        reason: 'fail_transition',
        message: 'Step failed',
      }),
    );
    const output = writer.getOutput();
    expect(output).toContain('Runbook:');
    expect(output).toContain('STOP');
  });

  it('renders ERROR_OCCURRED event', () => {
    subscriber.handle(
      makeEvent('ERROR_OCCURRED', {
        message: 'Something went wrong',
        code: 'ERR_TEST',
      }),
    );
    const output = writer.getOutput();
    expect(output).toContain('Error:');
    expect(output).toContain('Something went wrong');
    expect(output).toContain('Code:');
    expect(output).toContain('ERR_TEST');
  });
});
