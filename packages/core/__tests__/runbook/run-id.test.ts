import { describe, it, expect } from '@jest/globals';
import {
  InvalidRunIdError,
  RUN_ID_PATTERN,
  RUN_ID_PREFIX,
  assertRunId,
  isRunId,
} from '../../src/runbook/run-id.js';
import * as coreBarrel from '../../src/index.js';

describe('isRunId', () => {
  it('accepts canonical rd_ + 32 lowercase hex chars', () => {
    expect(isRunId('rd_4b7f0c2d9e1a4b7f0c2d9e1a4b7f0c2d')).toBe(true);
  });

  it('accepts all-zero hex segment', () => {
    expect(isRunId('rd_00000000000000000000000000000000')).toBe(true);
  });

  it('accepts all-f hex segment', () => {
    expect(isRunId('rd_ffffffffffffffffffffffffffffffff')).toBe(true);
  });

  it('rejects uppercase hex characters', () => {
    expect(isRunId('rd_ABCDEF00000000000000000000000000')).toBe(false);
  });

  it('rejects uppercase RD_ prefix', () => {
    expect(isRunId('RD_00000000000000000000000000000000')).toBe(false);
  });

  it('rejects missing prefix', () => {
    expect(isRunId('00000000000000000000000000000000')).toBe(false);
  });

  it('rejects 31-char hex segment', () => {
    expect(isRunId('rd_0000000000000000000000000000000')).toBe(false);
  });

  it('rejects 33-char hex segment', () => {
    expect(isRunId('rd_000000000000000000000000000000000')).toBe(false);
  });

  it('rejects non-hex character in segment', () => {
    expect(isRunId('rd_g0000000000000000000000000000000')).toBe(false);
  });

  it('rejects hyphenated UUID-style body', () => {
    expect(isRunId('rd_550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isRunId('')).toBe(false);
  });

  it('rejects bare prefix with no body', () => {
    expect(isRunId('rd_')).toBe(false);
  });

  it('rejects legacy wf-YYYY-MM-DD-... format', () => {
    expect(isRunId('wf-2024-01-07-abc123')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isRunId(undefined)).toBe(false);
    expect(isRunId(null)).toBe(false);
    expect(isRunId(123)).toBe(false);
    expect(isRunId({})).toBe(false);
  });
});

describe('assertRunId', () => {
  it('returns the input when valid', () => {
    const raw = 'rd_4b7f0c2d9e1a4b7f0c2d9e1a4b7f0c2d';
    expect(assertRunId(raw)).toBe(raw);
  });

  it('throws on invalid id with a message naming the expected format', () => {
    expect(() => assertRunId('not-a-run-id')).toThrow(/rd_/);
  });

  it('throws on uppercase hex', () => {
    expect(() => assertRunId('rd_ABCDEF00000000000000000000000000')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => assertRunId('')).toThrow();
  });

  it('throws on bare prefix', () => {
    expect(() => assertRunId('rd_')).toThrow();
  });

  it('is idempotent for valid ids', () => {
    const raw = 'rd_22222222222222222222222222222222';
    expect(assertRunId(assertRunId(raw))).toBe(raw);
  });
});

describe('RUN_ID_PATTERN / RUN_ID_PREFIX', () => {
  it('exports the rd_ prefix constant', () => {
    expect(RUN_ID_PREFIX).toBe('rd_');
  });

  it('exposes a pattern that anchors both ends', () => {
    expect(RUN_ID_PATTERN.source.startsWith('^')).toBe(true);
    expect(RUN_ID_PATTERN.source.endsWith('$')).toBe(true);
  });

  it('matches values accepted by isRunId', () => {
    const id = 'rd_11111111111111111111111111111111';
    expect(RUN_ID_PATTERN.test(id)).toBe(true);
    expect(isRunId(id)).toBe(true);
  });

  it.each([
    ['missing rd_ prefix', '00000000000000000000000000000000'],
    ['uppercase hex', 'rd_ABCDEF00000000000000000000000000'],
    ['31-char body (too short)', 'rd_0000000000000000000000000000000'],
    ['33-char body (too long)', 'rd_000000000000000000000000000000000'],
    ['non-hex character in body', 'rd_g0000000000000000000000000000000'],
    ['hyphenated UUID body', 'rd_550e8400-e29b-41d4-a716-446655440000'],
  ])('rejects %s in both RUN_ID_PATTERN and isRunId', (_label, value) => {
    expect(RUN_ID_PATTERN.test(value)).toBe(false);
    expect(isRunId(value)).toBe(false);
  });

  it('does not have the global flag (stateless across repeated calls)', () => {
    expect(RUN_ID_PATTERN.global).toBe(false);
  });

  it('pattern prefix matches RUN_ID_PREFIX', () => {
    // The pattern must start with ^ followed by RUN_ID_PREFIX so generated ids
    // remain consistent with the constant.
    expect(RUN_ID_PATTERN.source).toContain(RUN_ID_PREFIX);
  });

  it('rejects values that isRunId rejects', () => {
    expect(RUN_ID_PATTERN.test('not-a-run-id')).toBe(false);
    expect(RUN_ID_PATTERN.test('')).toBe(false);
    expect(RUN_ID_PATTERN.test('RD_00000000000000000000000000000000')).toBe(false);
  });
});

describe('isRunId – additional boundary cases', () => {
  it('rejects a valid id with leading whitespace', () => {
    expect(isRunId(' rd_00000000000000000000000000000000')).toBe(false);
  });

  it('rejects a valid id with trailing whitespace', () => {
    expect(isRunId('rd_00000000000000000000000000000000 ')).toBe(false);
  });

  it('rejects a valid id with embedded newline', () => {
    expect(isRunId('rd_00000000000000000000000000000000\n')).toBe(false);
  });

  it('accepts all valid hex digit characters in one id', () => {
    // Contains every valid hex digit: 0-9, a-f
    expect(isRunId('rd_0123456789abcdef0123456789abcdef')).toBe(true);
  });

  it('rejects boolean values', () => {
    expect(isRunId(true)).toBe(false);
    expect(isRunId(false)).toBe(false);
  });

  it('rejects array values', () => {
    expect(isRunId(['rd_00000000000000000000000000000000'])).toBe(false);
  });

  it('rejects ids that merely contain rd_ without the exact prefix', () => {
    // Extra characters before 'rd_' must fail.
    expect(isRunId('xrd_00000000000000000000000000000000')).toBe(false);
  });
});

// `assertRunId` used to throw a bare `Error`, which left every consumer that
// needs to classify the failure matching on message text — `rdpath`'s
// best-effort active-state guard did exactly that, against the fragment
// `'Invalid run id'`. That is the string-discriminant smell CLAUDE.md §
// Design Principles names: the discriminant belongs in a type.
describe('InvalidRunIdError', () => {
  it('is what assertRunId throws, not a bare Error', () => {
    expect(() => assertRunId('not-a-run-id')).toThrow(InvalidRunIdError);
  });

  it('carries the offending value as data, not only inside the message', () => {
    // The value is what a caller correlates against (which stack row, which
    // stash slot); recovering it by re-parsing the message would reintroduce
    // the string coupling this class exists to remove.
    let caught: unknown;
    try {
      assertRunId('not-a-run-id');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidRunIdError);
    expect((caught as InvalidRunIdError).value).toBe('not-a-run-id');
    expect((caught as InvalidRunIdError).name).toBe('InvalidRunIdError');
  });

  it('names the offending value in the message so a CLI/hook surface shows it', () => {
    expect(() => assertRunId('not-a-run-id')).toThrow(/not-a-run-id/);
  });

  // Additive, not breaking: introducing the subclass must not change what any
  // existing `catch (error) { if (error instanceof Error) ... }` caller sees.
  // Asserted rather than assumed — every `assertRunId` call site in
  // `runbook-store.ts`, `compiler.ts`, `state.ts` and `execution.ts` relies on it.
  it('remains an Error subclass so existing catch-Error callers are unaffected', () => {
    const error = new InvalidRunIdError('nope');
    expect(error).toBeInstanceOf(Error);
    expect(Object.prototype.toString.call(error)).toBe('[object Error]');
    expect(typeof error.stack).toBe('string');
  });

  it('preserves the format guidance the previous bare Error carried', () => {
    expect(() => assertRunId('rd_short')).toThrow(/rd_<32 lowercase hex chars>/);
  });

  // The plugin narrows on this class through the package barrel; without the
  // re-export it would have to keep matching a string.
  it('is exported from the core barrel for cross-package narrowing', () => {
    expect(coreBarrel.InvalidRunIdError).toBe(InvalidRunIdError);
  });
});

describe('assertRunId – error message', () => {
  it('throws an Error instance (not a plain string)', () => {
    expect(() => assertRunId('bad')).toThrow(Error);
  });

  it('error message references the expected hex length', () => {
    expect(() => assertRunId('rd_short')).toThrow(/32/);
  });

  it('error message is informative for a completely unrelated string', () => {
    let message = '';
    try {
      assertRunId('totally-wrong');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/rd_/);
    expect(message.length).toBeGreaterThan(0);
  });
});
