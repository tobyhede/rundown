import { describe, it, expect } from '@jest/globals';
import { JSONRenderer } from '../../../src/services/renderers/json-renderer.js';
import type {
  OutputWriter,
  DetailOutput,
  ExecutionEventOutput,
  RunbookEventV1,
  StatusOutput,
} from '@rundown-org/core';

function createMockWriter(): OutputWriter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
    },
    writeLine: (text?: string) => {
      lines.push(text ?? '');
    },
    writeLines: (textLines: string[]) => {
      lines.push(...textLines);
    },
    writeError: (text: string) => {
      lines.push(text);
    },
    writeJson: (data: unknown, pretty?: boolean) => {
      lines.push(JSON.stringify(data, null, pretty ? 2 : undefined));
    },
  };
}

function envelope(seq: number) {
  return {
    v: '1' as const,
    ts: '2026-04-23T00:00:00.000Z',
    runbookId: 'wf-2026-04-23-abcdef',
    runbook: { source: 'project' as const, path: 'test.runbook.md' },
    seq,
  };
}

function executionEvent(event: RunbookEventV1): ExecutionEventOutput {
  return { type: 'execution_event', event };
}

describe('JSONRenderer', () => {
  describe('flush in JSONL streaming mode', () => {
    it('does not emit a trailing empty {} after streaming execution events only', () => {
      const writer = createMockWriter();
      const renderer = new JSONRenderer({ writer });

      const started: RunbookEventV1 = {
        ...envelope(1),
        type: 'RUNBOOK_STARTED',
        payload: {
          prompted: false,
          statePath: '.rundown/runs/wf-2026-04-23-abcdef.json',
        },
      };
      const completed: RunbookEventV1 = {
        ...envelope(2),
        type: 'RUNBOOK_COMPLETED',
        payload: { finalPosition: { current: '1', total: 1 } },
      };

      renderer.render(executionEvent(started));
      renderer.render(executionEvent(completed));
      renderer.flush();

      expect(writer.lines).toHaveLength(2);
      expect(writer.lines.some((l) => l.trim() === '{}')).toBe(false);
      expect(writer.lines[0]).toContain('"type":"runbook_started"');
      expect(writer.lines[1]).toContain('"type":"runbook_completed"');
    });

    it('still flushes accumulated non-JSONL output alongside streamed events', () => {
      // `rd claim` streams JSONL execution events AND produces an action
      // detail that accumulates into `this.output`. The empty-{} fix must
      // not suppress the legitimate action object.
      const writer = createMockWriter();
      const renderer = new JSONRenderer({ writer });

      const started: RunbookEventV1 = {
        ...envelope(1),
        type: 'RUNBOOK_STARTED',
        payload: {
          prompted: false,
          statePath: '.rundown/runs/wf-2026-04-23-abcdef.json',
        },
      };

      const detail: DetailOutput = {
        type: 'detail',
        format: 'custom',
        data: { action: 'claimed', token: 'rdtk_xyz', kind: 'claim' },
      };

      renderer.render(executionEvent(started));
      renderer.render(detail);
      renderer.flush();

      expect(writer.lines).toHaveLength(2);
      expect(writer.lines[0]).toContain('"type":"runbook_started"');
      const tail = writer.lines[1];
      expect(tail).toContain('"action":"claimed"');
      expect(tail).toContain('"token":"rdtk_xyz"');
    });
  });

  describe('flush in non-streaming mode', () => {
    it('emits the accumulated pretty-printed JSON object', () => {
      const writer = createMockWriter();
      const renderer = new JSONRenderer({ writer });

      const detail: DetailOutput = {
        type: 'detail',
        format: 'custom',
        data: { kind: 'status', message: 'hello' },
      };

      renderer.render(detail);
      renderer.flush();

      expect(writer.lines).toHaveLength(1);
      const parsed = JSON.parse(writer.lines[0]) as Record<string, unknown>;
      expect(parsed.kind).toBe('status');
      expect(parsed.message).toBe('hello');
    });
  });

  describe('status-action → kind mapping', () => {
    // Each StatusOutput action carries a distinct lifecycle payload and the
    // renderer assigns the appropriate `kind` discriminant. stash, pop, and
    // claimed have their own kinds; everything else folds into the action
    // family. See packages/cli/src/services/renderers/json-renderer.ts case
    // 'status' and the corresponding schemas in
    // packages/core/src/output/zod-schemas.ts.
    function renderStatusKind(action: string): string {
      const writer = createMockWriter();
      const renderer = new JSONRenderer({ writer });
      const event: StatusOutput = { type: 'status', action };
      renderer.render(event);
      renderer.flush();
      const parsed = JSON.parse(writer.lines[0]) as Record<string, unknown>;
      return parsed.kind as string;
    }

    it('maps "claimed" → kind: "claim"', () => {
      expect(renderStatusKind('claimed')).toBe('claim');
    });

    it('maps "stash" → kind: "stash"', () => {
      expect(renderStatusKind('stash')).toBe('stash');
    });

    it('maps "pop" → kind: "pop"', () => {
      expect(renderStatusKind('pop')).toBe('pop');
    });

    it('maps "complete" → kind: "action" (action family default)', () => {
      expect(renderStatusKind('complete')).toBe('action');
    });

    it('maps "stop" → kind: "action" (action family default)', () => {
      expect(renderStatusKind('stop')).toBe('action');
    });

    it('maps an unknown action → kind: "action" (action family default)', () => {
      expect(renderStatusKind('something-else')).toBe('action');
    });
  });
});
