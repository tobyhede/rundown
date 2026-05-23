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

// Canonical mapping defined alongside the renderer's status-event handler in
// packages/cli/src/services/renderers/json-renderer.ts. `stash`, `pop`, and
// `claimed` carry distinct lifecycle payloads and get their own `kind`
// discriminants (matching the schemas in
// packages/core/src/output/zod-schemas.ts). Everything else folds into the
// action family.
const KIND_BY_ACTION: Record<string, string> = {
  stash: 'stash',
  pop: 'pop',
  claimed: 'claim',
};

function expectedKindFor(action: string): string {
  return KIND_BY_ACTION[action] ?? 'action';
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
  it('matches the canonical mapping for the three special discriminants', () => {
    fc.assert(
      fc.property(fc.constantFrom('stash', 'pop', 'claimed'), (action) => {
        expect(renderStatus(action)).toBe(expectedKindFor(action));
      }),
    );
  });

  it('folds any other action into the "action" family', () => {
    // Generate arbitrary action strings excluding the three special cases.
    // Restrict to identifier-ish strings so the renderer's JSON output stays
    // well-formed; the discriminant logic doesn't depend on character set.
    const otherActionArb = fc
      .stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,32}$/)
      .filter((s) => s !== 'stash' && s !== 'pop' && s !== 'claimed');
    fc.assert(
      fc.property(otherActionArb, (action) => {
        expect(renderStatus(action)).toBe('action');
      }),
    );
  });

  it('the mapping is unaffected by message and data payload contents', () => {
    // The renderer derives kind purely from `event.action`; carrying arbitrary
    // message/data must not change which kind is emitted.
    const allActions = fc.constantFrom('stash', 'pop', 'claimed', 'CONTINUE', 'STOP', 'completed');
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
