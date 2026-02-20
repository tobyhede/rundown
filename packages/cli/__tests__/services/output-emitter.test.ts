import { describe, it, expect, jest } from '@jest/globals';
import type { OutputWriter, RunbookEventV1 } from '@rundown-org/core';
import type { OutputRenderer } from '../../src/services/renderers/types.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';

interface JsonCall {
  data: unknown;
  pretty: boolean | undefined;
}

type MockWriter = OutputWriter & {
  jsonCalls: JsonCall[];
};

type MockRenderer = OutputRenderer & {
  render: ReturnType<typeof jest.fn>;
  flush: ReturnType<typeof jest.fn>;
};

function createMockWriter(): MockWriter {
  const jsonCalls: JsonCall[] = [];
  return {
    jsonCalls,
    write: () => undefined,
    writeLine: () => undefined,
    writeLines: () => undefined,
    writeError: () => undefined,
    writeJson: (data: unknown, pretty?: boolean) => {
      jsonCalls.push({ data, pretty });
    },
  };
}

function createMockRenderer(): MockRenderer {
  return {
    render: jest.fn(),
    flush: jest.fn(),
  };
}

function createExecutionEvent(): RunbookEventV1 {
  return {
    v: '1',
    type: 'COMMAND_STARTED',
    ts: '2026-02-20T00:00:00.000Z',
    runbookId: 'wf-test',
    runbook: { name: 'test', path: '/test.runbook.md' },
    seq: 1,
    payload: {
      command: 'echo hello',
      displayCommand: 'echo hello',
      position: { current: '1', total: 2 },
    },
  };
}

describe('OutputEmitter', () => {
  it('selects renderer based on options', () => {
    const writer = createMockWriter();
    const customRenderer = createMockRenderer();

    const customEmitter = new OutputEmitter({
      writer,
      json: true,
      renderer: customRenderer,
    });
    const jsonEmitter = new OutputEmitter({ writer, json: true });
    const textEmitter = new OutputEmitter({ writer });
    const defaultWriterEmitter = new OutputEmitter();

    expect(customEmitter.isJson()).toBe(false);
    expect(jsonEmitter.isJson()).toBe(true);
    expect(textEmitter.isJson()).toBe(false);
    expect(defaultWriterEmitter.getWriter()).toBeDefined();
  });

  it('emits all output events via renderer and delegates writer methods', () => {
    const writer = createMockWriter();
    const renderer = createMockRenderer();
    const emitter = new OutputEmitter({ writer, renderer });

    emitter.list([{ id: 1 }], [{ header: 'ID', key: (item: { id: number }) => item.id }], {
      emptyMessage: 'No items',
      jsonMapper: (item) => ({ value: item.id }),
    });
    emitter.detail({ key: 'value' }, 'custom');
    emitter.metadata({ file: 'runbook.md', state: 'running', prompted: true });
    emitter.status(true, 'check', 'ok', { total: 1 });
    emitter.action(
      {
        action: 'CONTINUE',
        result: true,
        command: 'echo hello',
        from: { current: '1', total: 2 },
        at: { current: '2', total: 2, substep: 'a' },
      },
      { complete: true, stopped: true },
    );
    emitter.stepSeparator({ current: '2', total: 3, substep: '1' });
    emitter.message('info message');
    emitter.success('success message');
    emitter.warning('warning message');
    emitter.error('new-style error', 'ERR_NEW', { source: 'new' });
    emitter.error('legacy error', { code: 'ERR_OLD', details: { source: 'legacy' } });
    emitter.error('plain error');
    emitter.complete('done', { current: '3', total: 3 });
    emitter.stopped('stopped', { current: '2', total: 3 });
    emitter.noActiveRunbook('pass');
    emitter.noActiveRunbook('goto', 'NO_RUNBOOK');
    emitter.executionEvent(createExecutionEvent());
    emitter.flush();
    emitter.json({ direct: true });

    const events = renderer.render.mock.calls.map((call) => call[0] as Record<string, unknown>);
    const listEvent = events.find((event) => event.type === 'list');
    const plainErrorEvent = events.find(
      (event) => event.type === 'error' && event.message === 'plain error',
    );
    const defaultNoActiveRunbook = events.find(
      (event) => event.type === 'no_active_runbook' && event.action === 'pass',
    );
    const explicitNoActiveRunbook = events.find(
      (event) => event.type === 'no_active_runbook' && event.action === 'goto',
    );

    expect(listEvent).toBeDefined();
    expect(listEvent?.emptyMessage).toBe('No items');
    expect(listEvent?.jsonMapper).toBeInstanceOf(Function);
    expect(
      (listEvent?.jsonMapper as (item: { id: number }) => { value: number })({ id: 7 }),
    ).toEqual({
      value: 7,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'detail', format: 'custom' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'metadata' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', action: 'check' }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'action', complete: true, stopped: true }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'step_separator',
        position: { current: '2', total: 3, substep: '1' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message', text: 'info message', level: 'info' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message', text: 'success message', level: 'success' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message', text: 'warning message', level: 'warning' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'new-style error', code: 'ERR_NEW' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'legacy error', code: 'ERR_OLD' }),
    );
    expect(plainErrorEvent).toEqual(
      expect.objectContaining({ type: 'error', message: 'plain error', code: undefined }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'complete', message: 'done' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'stopped', message: 'stopped' }));
    expect(defaultNoActiveRunbook).toEqual(
      expect.objectContaining({ type: 'no_active_runbook', code: 'NO_ACTIVE_RUNBOOK' }),
    );
    expect(explicitNoActiveRunbook).toEqual(
      expect.objectContaining({ type: 'no_active_runbook', code: 'NO_RUNBOOK' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'execution_event', event: createExecutionEvent() }),
    );
    expect(renderer.flush).toHaveBeenCalledTimes(1);
    expect(writer.jsonCalls).toEqual([{ data: { direct: true }, pretty: undefined }]);
  });
});
