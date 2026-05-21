import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  classifyExpandedArtifactToken,
  classifyRawArtifactToken,
  type ArtifactTokenClassificationResult,
} from '../src/index.js';

const plainSegmentArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
const dottedNameSegmentArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,6}\.[A-Za-z0-9_-]{1,6}$/);
const safeSegmentArb = fc.oneof(plainSegmentArb, dottedNameSegmentArb);
const separatorArb = fc.constantFrom('/', '\\');
const classifierArb = fc.constantFrom(classifyRawArtifactToken, classifyExpandedArtifactToken);

function joinPathSegments(segments: readonly string[], separator: string): string {
  return segments.join(separator);
}

function containsForbiddenDotSegment(raw: string): boolean {
  return raw
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => segment === '.' || segment === '..');
}

const dotSegmentTokenArb = fc
  .tuple(
    fc.array(safeSegmentArb, { maxLength: 3 }),
    fc.constantFrom('.', '..'),
    fc.array(safeSegmentArb, { maxLength: 3 }),
    separatorArb,
  )
  .map(([before, dotSegment, after, separator]) =>
    joinPathSegments([...before, dotSegment, ...after], separator),
  );

const recursiveWildcardTokenArb = fc
  .tuple(
    fc.array(safeSegmentArb, { maxLength: 3 }),
    fc.constant('**'),
    fc.array(safeSegmentArb, { maxLength: 3 }),
    separatorArb,
  )
  .map(([before, recursiveWildcard, after, separator]) =>
    joinPathSegments([...before, recursiveWildcard, ...after], separator),
  );

const wildcardPathHybridArb = fc
  .tuple(
    fc.constantFrom('', '/', 'C:\\', '\\\\server\\share\\'),
    fc.array(safeSegmentArb, { minLength: 1, maxLength: 3 }),
    fc.constantFrom('*.json', 'review-?.json'),
    separatorArb,
  )
  .map(
    ([prefix, dirs, filename, separator]) =>
      `${prefix}${joinPathSegments([...dirs, filename], separator)}`,
  );

const pathLikeTokenArb = fc
  .tuple(
    fc.constantFrom('', '/', 'C:\\', '\\\\server\\share\\'),
    fc.array(fc.oneof(safeSegmentArb, fc.constant('.'), fc.constant('..'), fc.constant('**')), {
      minLength: 2,
      maxLength: 5,
    }),
    separatorArb,
  )
  .map(([prefix, segments, separator]) => `${prefix}${joinPathSegments(segments, separator)}`);

function isAcceptedPath(result: ArtifactTokenClassificationResult): result is Extract<
  ArtifactTokenClassificationResult,
  { ok: true }
> & {
  readonly token: { readonly kind: 'abs-path' | 'rel-path'; readonly raw: string };
} {
  return result.ok && (result.token.kind === 'abs-path' || result.token.kind === 'rel-path');
}

describe('ARTIFACTS token classifier properties', () => {
  it('rejects raw and expanded tokens with dot path segments as dot-segment', () => {
    fc.assert(
      fc.property(classifierArb, dotSegmentTokenArb, (classify, raw) => {
        expect(classify(raw)).toEqual({ ok: false, reason: 'dot-segment', raw });
      }),
    );
  });

  it('rejects raw and expanded tokens with recursive wildcards as recursive-wildcard', () => {
    fc.assert(
      fc.property(classifierArb, recursiveWildcardTokenArb, (classify, raw) => {
        expect(classify(raw)).toEqual({ ok: false, reason: 'recursive-wildcard', raw });
      }),
    );
  });

  it('rejects path-like wildcard hybrids as invalid-wildcard-key', () => {
    fc.assert(
      fc.property(classifierArb, wildcardPathHybridArb, (classify, raw) => {
        expect(classify(raw)).toEqual({ ok: false, reason: 'invalid-wildcard-key', raw });
      }),
    );
  });

  it('never accepts expanded relative or absolute paths with forbidden segments or recursive wildcards', () => {
    fc.assert(
      fc.property(pathLikeTokenArb, (raw) => {
        const result = classifyExpandedArtifactToken(raw);
        if (!isAcceptedPath(result)) return;

        expect(containsForbiddenDotSegment(result.token.raw)).toBe(false);
        expect(result.token.raw.includes('**')).toBe(false);
      }),
    );
  });
});
