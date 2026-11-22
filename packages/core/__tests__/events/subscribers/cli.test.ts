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
      }),
    );
    const output = writer.getOutput();
    expect(output).toContain('File:');
    expect(output).toContain('State:');
    expect(output).toContain('.rundown/rundown.db');
    // `State:` is the same database for every run, so the run identity has to
    // come from the `Run:` line.
    expect(output).toContain('Run:      wf-test');
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
        artifacts: {},
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
  describe('Delegation events (#904, #905)', () => {
    const parent = 'rd_46cbdd5f19324d3b91667e2ff0e96386';
    const inline = 'rd_7af1d92df90a405edbf718ca20012b3f';

    it.each([
      [
        'current',
        { standing: 'current', runId: parent, step: '1.1' },
        [`Run wf-test abandoned; run ${parent} collects it at 1.1 as a fail`],
      ],
      [
        'cancelled',
        { standing: 'cancelled', runId: parent, step: '1.1' },
        [`Run wf-test abandoned; run ${parent} no longer counts it at 1.1, so nothing collects it`],
      ],
      [
        'parent_finished',
        { standing: 'parent_finished', runId: parent, step: '1.1' },
        [`Run wf-test abandoned; run ${parent} has finished, so nothing collects it at 1.1`],
      ],
      [
        'parent_pruned',
        { standing: 'parent_pruned', step: '1.1' },
        ['Run wf-test abandoned; its parent run was pruned, so nothing collects it at 1.1'],
      ],
    ] as const)('renders RUNBOOK_ABANDONED for a %s parent', (_name, standing, lines) => {
      subscriber.handle(makeEvent('RUNBOOK_ABANDONED', { parent: standing, abandonedInline: [] }));
      expect(writer.getOutput().trimEnd().split('\n')).toEqual(lines);
    });

    it('renders RUNBOOK_ABANDONED with the Inline Children abandoned alongside', () => {
      subscriber.handle(
        makeEvent('RUNBOOK_ABANDONED', {
          parent: { standing: 'current', runId: parent, step: '1.1' },
          abandonedInline: [inline],
        }),
      );
      expect(writer.getOutput().trimEnd().split('\n')).toEqual([
        `Run wf-test abandoned; run ${parent} collects it at 1.1 as a fail`,
        `Inline child ${inline} abandoned with it`,
      ]);
    });

    it('renders DELEGATION_RETRIED with the fresh ticket once', () => {
      subscriber.handle(
        makeEvent('DELEGATION_RETRIED', {
          step: '1.1',
          cancelledRunId: parent,
          children: [{ step: '1.1', runId: inline, runbook: 'child.runbook.md', ticket: 'rdt_x' }],
        } as never),
      );
      expect(writer.getOutput().trimEnd().split('\n')).toEqual([
        `Retried 1.1: cancelled ${parent}`,
        `Delegation 1.1: child.runbook.md (${inline}) ticket rdt_x`,
      ]);
    });
  });
});
