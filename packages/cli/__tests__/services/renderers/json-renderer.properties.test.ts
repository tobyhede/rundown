import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { JSONRenderer } from '../../../src/services/renderers/json-renderer.js';
import type { OutputWriter, StatusOutput } from '@rundown-org/core';

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

// Every status action folds into the action family: the stash/pop/claim
// discriminants left with their commands (#901). See
// packages/cli/src/services/renderers/json-renderer.ts case 'status'.
function expectedKindFor(_action: string): string {
  return 'action';
}

function renderStatus(action: string, message?: string, data?: Record<string, unknown>): string {
  const writer = createMockWriter();
  const renderer = new JSONRenderer({ writer });
  const event: StatusOutput = { type: 'status', action, message, data };
  renderer.render(event);
  renderer.flush();
  const parsed = JSON.parse(writer.lines[0]) as Record<string, unknown>;
  return parsed.kind as string;
}

describe('JSONRenderer status-action → kind mapping (property)', () => {
  it('folds every action into the "action" family', () => {
    // Restrict to identifier-ish strings so the renderer's JSON output stays
    // well-formed; the discriminant logic doesn't depend on character set.
    const otherActionArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,32}$/);
    fc.assert(
      fc.property(otherActionArb, (action) => {
        expect(renderStatus(action)).toBe('action');
      }),
    );
  });

  it('the mapping is unaffected by message and data payload contents', () => {
    // The renderer derives kind purely from `event.action`; carrying arbitrary
    // message/data must not change which kind is emitted.
    const allActions = fc.constantFrom('pass', 'fail', 'goto', 'CONTINUE', 'STOP', 'completed');
    fc.assert(
      fc.property(
        allActions,
        fc.option(fc.string({ maxLength: 64 }), { nil: undefined }),
        fc.option(
          fc.dictionary(
            fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/),
            fc.oneof(fc.string({ maxLength: 64 }), fc.integer(), fc.boolean()),
          ),
          { nil: undefined },
        ),
        (action, message, data) => {
          expect(renderStatus(action, message, data)).toBe(expectedKindFor(action));
        },
      ),
    );
  });
});
