/**
 * Docs ↔ error-code enum drift guard (issue #615).
 *
 * `docs/spec/cli-output.md` documents CLI JSON error/warning envelopes by
 * example, each carrying a machine-readable `"code"`. Nothing structurally
 * couples those documented codes to the registered enums in
 * `src/output/zod-schemas.ts`, so a documented-but-invalid or stale code can
 * survive indefinitely — this already happened once (#559's stale exclusion
 * comment outlived the commit that invalidated it by eight days).
 *
 * This test extracts every `"code"` value from the JSON fenced code blocks of
 * that spec and asserts each documented code is a registered code. Direction is
 * one-way on purpose: documented ⊆ registered. It catches documenting an
 * invalid/misspelled code; it deliberately does NOT enforce registered ⊆
 * documented (many codes are intentionally undocumented, which would need an
 * opt-out mechanism this guard does not provide).
 *
 * @module tests/output/docs-error-code-drift
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RundownErrorCodeValues,
  CLISymbolicErrorCodeValues,
  CLIWarningCodes,
} from '../../src/output/zod-schemas.js';

/** Absolute path to the spec whose documented codes are being guarded. */
const SPEC_PATH = fileURLToPath(new URL('../../../../docs/spec/cli-output.md', import.meta.url));

/** Human-readable location of the spec, used in failure messages. */
const SPEC_LABEL = 'docs/spec/cli-output.md';

/**
 * A `"code"` value documented in a JSON fence, tagged with the envelope kind it
 * was nested under and enough source location to make a failure actionable.
 */
interface DocumentedCode {
  /** The documented code string (the `"code"` value). */
  readonly code: string;
  /** Kind of the nearest enclosing object: `error`, `warning`, or `unknown`. */
  readonly kind: 'error' | 'warning' | 'unknown';
  /** 1-based index of the JSON fence within the document. */
  readonly fence: number;
  /** 1-based line number of the code within the document. */
  readonly line: number;
}

/**
 * Recursively collect every `code` string in a parsed JSON value, tagging each
 * with the `kind` of its nearest enclosing object.
 *
 * @param value - A parsed JSON value (object, array, or scalar).
 * @param inheritedKind - Kind carried down from an enclosing object.
 * @param out - Accumulator receiving `{ code, kind }` for every string `code`.
 */
function collectCodes(
  value: unknown,
  inheritedKind: DocumentedCode['kind'],
  out: { code: string; kind: DocumentedCode['kind'] }[],
): void {
  if (Array.isArray(value)) {
    for (const element of value) collectCodes(element, inheritedKind, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const kind: DocumentedCode['kind'] =
    record.kind === 'error' || record.kind === 'warning' ? record.kind : inheritedKind;

  if (typeof record.code === 'string') {
    out.push({ code: record.code, kind });
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'code') continue;
    collectCodes(nested, kind, out);
  }
}

/** 1-based line number for a character offset within `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Extract every documented `"code"` from the JSON fenced code blocks of a
 * markdown document.
 *
 * Structured parsing is preferred so each code can be tagged with its enclosing
 * envelope `kind`. A JSON fence that is not valid JSON (for example an
 * illustrative schema sketch with `//` comments) falls back to a textual scan
 * that still surfaces any `"code"` it contains, tagged `unknown`, so a real code
 * hidden in a non-parseable fence is never silently dropped. Fenced blocks with
 * no `"code"` contribute nothing.
 *
 * @param markdown - Raw markdown source to scan.
 * @returns Every documented code with its kind and source location, in document order.
 */
function extractDocumentedCodes(markdown: string): DocumentedCode[] {
  const results: DocumentedCode[] = [];
  const fenceOpen = '```json\n';
  let fence = 0;

  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    fence += 1;
    const body = match[1];
    const bodyOffset = (match.index ?? 0) + fenceOpen.length;

    let parsed: unknown;
    let parseable = true;
    try {
      parsed = JSON.parse(body);
    } catch {
      parseable = false;
    }

    if (parseable) {
      const collected: { code: string; kind: DocumentedCode['kind'] }[] = [];
      collectCodes(parsed, 'unknown', collected);
      for (const { code, kind } of collected) {
        const rel = body.indexOf(`"${code}"`);
        const line = lineAt(markdown, rel === -1 ? bodyOffset : bodyOffset + rel);
        results.push({ code, kind, fence, line });
      }
    } else {
      for (const codeMatch of body.matchAll(/"code"\s*:\s*"([^"]+)"/g)) {
        results.push({
          code: codeMatch[1],
          kind: 'unknown',
          fence,
          line: lineAt(markdown, bodyOffset + (codeMatch.index ?? 0)),
        });
      }
    }
  }

  return results;
}

/** Registered CLI error codes: RD-NNN factory codes plus CLI-only symbolic codes. */
const REGISTERED_ERROR_CODES = new Set<string>([
  ...RundownErrorCodeValues,
  ...CLISymbolicErrorCodeValues,
]);

/** Registered CLI warning codes. */
const REGISTERED_WARNING_CODES = new Set<string>(Object.values(CLIWarningCodes));

/**
 * Classify a documented code as valid against the registered enums.
 *
 * Error-envelope codes must be registered error codes; warning-envelope codes
 * must be registered warning codes; a code from a non-parseable fence (kind
 * `unknown`) is accepted if it is registered as either.
 *
 * @param entry - The documented code to validate.
 * @returns True when the code is a member of the appropriate registered enum.
 */
function isRegistered(entry: DocumentedCode): boolean {
  if (entry.kind === 'warning') return REGISTERED_WARNING_CODES.has(entry.code);
  if (entry.kind === 'error') return REGISTERED_ERROR_CODES.has(entry.code);
  return REGISTERED_ERROR_CODES.has(entry.code) || REGISTERED_WARNING_CODES.has(entry.code);
}

/** Format an offending code for a failure message naming its source location. */
function describeOffender(entry: DocumentedCode): string {
  return `"${entry.code}" (${entry.kind} envelope, ${SPEC_LABEL} JSON fence #${entry.fence}, line ${entry.line})`;
}

describe('docs/spec/cli-output.md error codes are registered (#615)', () => {
  describe('extraction guard has teeth', () => {
    // A fixture that mirrors the spec's shape: a valid error envelope, a valid
    // warning envelope, an illustrative non-parseable fence, a nested/array
    // envelope, and one bogus code. If the guard could not tell these apart it
    // would be worthless, so these assertions pin the extractor's behaviour
    // BEFORE trusting a green run against the real doc.
    const fixture = [
      'Prose mentioning `"code": "IGNORED"` inline should not be extracted.',
      '',
      '```json',
      '{ "kind": "error", "code": "STEP_NOT_FOUND", "command": "goto" }',
      '```',
      '',
      '```json',
      '{ "kind": "warning", "code": "NO_ACTIVE_RUNBOOK" }',
      '```',
      '',
      '```json',
      '{',
      '  "id": "string", // illustrative sketch, not valid JSON',
      '  "status": "string"',
      '}',
      '```',
      '',
      '```json',
      '[',
      '  { "kind": "error", "code": "INVALID_SYNTAX", "details": { "code": "STEP_NOT_FOUND" } }',
      ']',
      '```',
      '',
      '```json',
      '{ "kind": "error", "code": "NOT_A_REAL_CODE_615", "command": "pass" }',
      '```',
      '',
    ].join('\n');

    it('extracts codes only from JSON fences, tagged by envelope kind and depth', () => {
      const codes = extractDocumentedCodes(fixture);

      // Inline prose code span is not inside a ```json fence → never extracted.
      expect(codes.some((c) => c.code === 'IGNORED')).toBe(false);

      // Error and warning envelope codes are tagged by their envelope kind.
      expect(codes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'STEP_NOT_FOUND', kind: 'error' }),
          expect.objectContaining({ code: 'NO_ACTIVE_RUNBOOK', kind: 'warning' }),
        ]),
      );

      // Nested `details.code` inside an array-of-errors is reached at depth.
      const nested = codes.filter((c) => c.code === 'STEP_NOT_FOUND');
      expect(nested.length).toBeGreaterThanOrEqual(2);
      expect(nested.every((c) => c.kind === 'error')).toBe(true);
    });

    it('flags a bogus documented code as unregistered', () => {
      const invalid = extractDocumentedCodes(fixture).filter((c) => !isRegistered(c));

      expect(invalid.map((c) => c.code)).toEqual(['NOT_A_REAL_CODE_615']);
    });

    it('accepts the real registered codes in the fixture', () => {
      const valid = extractDocumentedCodes(fixture).filter((c) => c.code !== 'NOT_A_REAL_CODE_615');

      expect(valid.length).toBeGreaterThan(0);
      for (const entry of valid) {
        expect(isRegistered(entry)).toBe(true);
      }
    });
  });

  describe('the real spec', () => {
    const markdown = readFileSync(SPEC_PATH, 'utf-8');
    const documented = extractDocumentedCodes(markdown);

    it('documents at least one error code (sanity: the extractor found fences)', () => {
      expect(documented.some((c) => c.kind === 'error')).toBe(true);
    });

    it('documents only registered error and warning codes', () => {
      const offenders = documented.filter((entry) => !isRegistered(entry));

      expect(offenders.map(describeOffender)).toEqual([]);
    });
  });
});
