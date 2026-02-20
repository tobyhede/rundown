import { describe, it, expect } from '@jest/globals';
import type { OutputWriter, RunbookEventV1, StepPosition } from '@rundown-org/core';
import { JSONRenderer } from '../../../src/services/renderers/json-renderer.js';

interface JsonWrite {
  data: unknown;
  pretty: boolean | undefined;
}

type MockWriter = OutputWriter & {
  lines: string[];
  jsonWrites: JsonWrite[];
};

function createMockWriter(): MockWriter {
  const lines: string[] = [];
  const jsonWrites: JsonWrite[] = [];
  return {
    lines,
    jsonWrites,
    write: (text: string) => {
      lines.push(text);
    },
    writeLine: (text?: string) => {
      lines.push(text ?? '');
    },
    writeLines: (texts: string[]) => {
      lines.push(...texts);
    },
    writeError: (text: string) => {
      lines.push(text);
    },
    writeJson: (data: unknown, pretty?: boolean) => {
      jsonWrites.push({ data, pretty });
    },
  };
}

function pos(current = '1', total = 2, substep?: string): StepPosition {
  return { current, total, substep };
}

function transitionEvent(
  extras: Partial<RunbookEventV1> = {},
  payload: RunbookEventV1['payload'] = {
    action: 'CONTINUE',
    from: pos('1', 2),
    to: pos('2', 2),
    result: true,
  },
): RunbookEventV1 {
  return {
    v: '1',
    type: 'STEP_TRANSITIONED',
    ts: '2026-02-20T00:00:00.000Z',
    runbookId: 'wf-123',
    runbook: { name: 'demo', path: '/demo.runbook.md' },
    seq: 7,
    payload,
    ...extras,
  } as RunbookEventV1;
}

describe('JSONRenderer', () => {
  it('does nothing on flush when no output has been rendered', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.flush();

    expect(writer.jsonWrites).toHaveLength(0);
    expect(writer.lines).toHaveLength(0);
  });

  it('renders list-only output as raw arrays (with and without jsonMapper)', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.render({
      type: 'list',
      items: [{ id: 1 }, { id: 2 }],
      columns: [{ header: 'ID', key: 'id' }],
      jsonMapper: (item: { id: number }) => item.id,
    });
    renderer.flush();

    renderer.render({
      type: 'list',
      items: ['a', 'b'],
      columns: [{ header: 'Value', key: (item: string) => item }],
    });
    renderer.flush();

    expect(writer.jsonWrites[0]).toEqual({ data: [1, 2], pretty: true });
    expect(writer.jsonWrites[1]).toEqual({ data: ['a', 'b'], pretty: true });
  });

  it('renders mixed list/detail output as an object and defaults result=true', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.render({
      type: 'list',
      items: [{ name: 'alpha' }],
      columns: [{ header: 'Name', key: 'name' }],
    });
    renderer.render({
      type: 'detail',
      format: 'custom',
      data: { mode: 'mixed' },
    });
    renderer.flush();

    expect(writer.jsonWrites[0]).toEqual({
      data: {
        items: [{ name: 'alpha' }],
        mode: 'mixed',
        result: true,
      },
      pretty: true,
    });
  });

  it('renders metadata, status, step separators, and informational messages', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.render({
      type: 'metadata',
      metadata: { file: 'runbook.md', state: 'running', prompted: false },
    });
    renderer.render({
      type: 'metadata',
      metadata: { file: 'runbook.md', state: 'running', prompted: true },
    });
    renderer.render({
      type: 'status',
      result: true,
      action: 'check',
      message: 'ok',
      data: { validated: 1 },
    });
    renderer.render({
      type: 'status',
      result: false,
      action: 'check',
    });
    renderer.render({
      type: 'step_separator',
      position: pos('2', 3, '1'),
    });
    renderer.render({
      type: 'message',
      text: 'info',
      level: 'info',
    });
    renderer.flush();

    expect(writer.jsonWrites[0]).toEqual({
      data: {
        file: 'runbook.md',
        state: 'running',
        prompted: true,
        result: false,
        action: 'check',
        message: 'info',
        validated: 1,
        position: { current: '2', total: 3, substep: '1' },
      },
      pretty: true,
    });
  });

  it('renders action events with full and minimal payloads', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.render({
      type: 'action',
      block: {
        action: 'RETRY',
      },
    });
    renderer.render({
      type: 'action',
      block: {
        action: 'GOTO 2',
        result: false,
        command: 'rd echo fail',
        from: pos('1', 3),
        at: pos('2', 3, 'a'),
      },
      complete: true,
      stopped: true,
    });
    renderer.flush();

    expect(writer.jsonWrites[0]).toEqual({
      data: {
        action: 'GOTO 2',
        result: false,
        command: 'rd echo fail',
        from: { current: '1', total: 3 },
        to: { current: '2', total: 3, substep: 'a' },
        complete: true,
        stopped: true,
      },
      pretty: true,
    });
  });

  it('renders message/error/no_active_runbook output and derives result from errors', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.render({
      type: 'message',
      text: 'warning message',
      level: 'warning',
    });
    renderer.render({
      type: 'message',
      text: 'fatal message',
      level: 'error',
    });
    renderer.render({
      type: 'error',
      message: 'structured error',
      code: 'ERR_CODE',
      details: { retryable: false },
    });
    renderer.render({
      type: 'error',
      message: 'plain error',
    });
    renderer.render({
      type: 'no_active_runbook',
    });
    renderer.render({
      type: 'no_active_runbook',
      action: 'pass',
      code: 'NO_RUNBOOK',
    });
    renderer.flush();

    expect(writer.jsonWrites[0]).toEqual({
      data: {
        message: 'warning message',
        error: 'No active runbook',
        result: false,
        code: 'NO_RUNBOOK',
        details: { retryable: false },
        action: 'pass',
      },
      pretty: true,
    });
  });

  it('renders complete and stopped events with and without optional fields', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.render({
      type: 'complete',
    });
    renderer.flush();

    renderer.render({
      type: 'stopped',
      message: 'Stopped by user',
      position: pos('3', 3),
    });
    renderer.flush();

    expect(writer.jsonWrites[0]).toEqual({
      data: {
        result: true,
        action: 'complete',
      },
      pretty: true,
    });
    expect(writer.jsonWrites[1]).toEqual({
      data: {
        result: false,
        action: 'stop',
        message: 'Stopped by user',
        position: { current: '3', total: 3 },
      },
      pretty: true,
    });
  });

  it('streams execution events as NDJSON and keeps compact JSON flush mode', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.render({
      type: 'execution_event',
      event: transitionEvent({
        agentId: 'agent-1',
        parentRunbookId: 'parent-1',
        parentStepId: 'step-7',
      }),
    });

    renderer.render({
      type: 'execution_event',
      event: transitionEvent({
        seq: 8,
      }),
    });
    renderer.flush();

    const firstLine = JSON.parse(writer.lines[0]);
    const secondLine = JSON.parse(writer.lines[1]);

    expect(firstLine).toMatchObject({
      type: 'step_transitioned',
      action: 'CONTINUE',
      timestamp: '2026-02-20T00:00:00.000Z',
      runbookId: 'wf-123',
      seq: 7,
      agentId: 'agent-1',
      parentRunbookId: 'parent-1',
      parentStepId: 'step-7',
    });
    expect(secondLine).toMatchObject({
      type: 'step_transitioned',
      runbookId: 'wf-123',
      seq: 8,
    });
    expect(secondLine.agentId).toBeUndefined();
    expect(secondLine.parentRunbookId).toBeUndefined();
    expect(secondLine.parentStepId).toBeUndefined();
    expect(writer.jsonWrites[0]).toEqual({
      data: { result: true },
      pretty: false,
    });
  });

  it('resets internal state between flushes', () => {
    const writer = createMockWriter();
    const renderer = new JSONRenderer({ writer });

    renderer.render({
      type: 'message',
      text: 'first',
      level: 'info',
    });
    renderer.flush();

    renderer.render({
      type: 'list',
      items: [1],
      columns: [{ header: 'Value', key: (item: number) => item }],
    });
    renderer.flush();

    expect(writer.jsonWrites[0]).toEqual({
      data: { message: 'first', result: true },
      pretty: true,
    });
    expect(writer.jsonWrites[1]).toEqual({
      data: [1],
      pretty: true,
    });
  });
});
