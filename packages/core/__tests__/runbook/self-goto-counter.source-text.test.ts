/**
 * `selfGotoCount` resets wherever `retryCount` resets.
 *
 * The two counters are deliberately separate — `retryCount` is the author's
 * `RETRY <count> <action>` budget, `selfGotoCount` is the machine's
 * `MAX_SELF_GOTO_PASSES` bound on `GOTO <self>` — but they answer the same
 * question about scope: both are spent within one execution unit and both must
 * start fresh when the cursor leaves it or reopens it from the top. There are a
 * dozen such transitions in `compiler.ts`, and missing one is silent in both
 * directions: a later self-loop that inherits a spent counter STOPs on its first
 * pass, and one that inherits nothing never reaches the bound at all.
 *
 * `compiler.test.ts` ("loop-counter reset sites") drives one behavioural test per
 * site that a fixture can reach. This file covers the same rule structurally, so
 * a site added later is caught the moment it is written rather than whenever
 * someone notices the missing fixture.
 *
 * Named `*.source-text.test.ts` per the convention in `jest.config.shared.js`:
 * it asserts on `src/**` text, which Stryker rewrites during instrumentation,
 * so the sandbox must not collect it.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('self-GOTO loop counter scoping', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/runbook/compiler.ts', import.meta.url)),
    'utf8',
  );
  const lines = source.split('\n');

  it('pairs every retryCount reset with a selfGotoCount assignment', () => {
    const resets = lines.flatMap((line, index) =>
      /^\s*retryCount: 0,$/.test(line) ? [index] : [],
    );
    // A scan that finds nothing passes for the wrong reason.
    expect(resets.length).toBeGreaterThan(0);

    const unpaired = resets
      .filter((index) => !/^\s*selfGotoCount:/.test(lines[index + 1] ?? ''))
      .map((index) => `${String(index + 1)}: ${lines[index].trim()}`);

    expect(unpaired).toEqual([]);
  });

  it('advances the loop counter only on a self-target', () => {
    // Every increment sits in an `isGotoToSelf` ternary. An unconditional one
    // would count jumps that left the unit, spending the bound on transitions
    // that reset it — the exact shape `retryCount` had before the split.
    const increments = lines.flatMap((line, index) =>
      line.includes('context.selfGotoCount + 1') ? [index] : [],
    );
    expect(increments.length).toBeGreaterThan(0);

    const unguarded = increments
      .filter((index) => !(lines[index - 1] ?? '').trimEnd().endsWith('isGotoToSelf'))
      .map((index) => `${String(index + 1)}: ${lines[index].trim()}`);

    expect(unguarded).toEqual([]);
  });

  it('bounds the self-loop on its own counter, never on the retry budget', () => {
    // The guard is the one place the split could silently undo itself: reading
    // `retryCount` here restores the collision without touching any assign.
    expect(source).toContain('return context.selfGotoCount < MAX_SELF_GOTO_PASSES;');
    expect(source).not.toContain('return context.retryCount < MAX_SELF_GOTO_PASSES;');
  });
});
