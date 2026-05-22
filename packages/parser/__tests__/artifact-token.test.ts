import { describe, expect, it } from '@jest/globals';
import {
  classifyExpandedArtifactToken,
  classifyRawArtifactToken,
  parseArtifactDeclaration,
  SELECTOR_ARTIFACT_KEY_PATTERN,
} from '../src/index.js';

describe('classifyRawArtifactToken', () => {
  it.each([
    ['plan.json', { kind: 'shorthand', key: 'plan.json', runScope: 'current' }],
    ['review-*.json', { kind: 'shorthand', key: 'review-*.json', runScope: 'current' }],
    ['*/plan.json', { kind: 'shorthand', key: 'plan.json', runScope: 'any' }],
    ['*/review-*.json', { kind: 'shorthand', key: 'review-*.json', runScope: 'any' }],
    [
      '*/end-to-end-test-review.json',
      {
        kind: 'shorthand',
        key: 'end-to-end-test-review.json',
        runScope: 'any',
      },
    ],
  ] as const)('classifies %s as shorthand', (raw, token) => {
    expect(classifyRawArtifactToken(raw)).toEqual({
      ok: true,
      token: { ...token, raw },
    });
  });

  it.each([
    ['rd://artifacts/ctx1/*/plan.json', 'rd-uri'],
    ['/tmp/plan.json', 'abs-path'],
    ['schemas/review.schema.json', 'rel-path'],
  ] as const)('classifies %s as %s', (raw, kind) => {
    expect(classifyRawArtifactToken(raw)).toMatchObject({
      ok: true,
      token: { kind, raw },
    });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'invalid-shorthand-key'],
    ['.', 'dot-segment'],
    ['..', 'dot-segment'],
    ['**', 'recursive-wildcard'],
    ['dir/**/plan.json', 'recursive-wildcard'],
    ['a/./b.json', 'dot-segment'],
    ['a/../b.json', 'dot-segment'],
    ['foo bar', 'invalid-shorthand-key'],
    ['foo:bar', 'invalid-shorthand-key'],
    ['plan#.json', 'invalid-shorthand-key'],
    ['/tmp/review-*.json', 'invalid-shorthand-key'],
    ['dir/*.json', 'invalid-shorthand-key'],
    ['reports/review-*.json', 'invalid-shorthand-key'],
    ['review-*.json extra', 'invalid-shorthand-key'],
    ['*/dir/plan.json', 'invalid-shorthand-key'],
    ['*/plan#.json', 'invalid-shorthand-key'],
    ['*/', 'invalid-shorthand-key'],
  ] as const)('rejects %s with reason %s', (raw, reason) => {
    expect(classifyRawArtifactToken(raw)).toEqual({ ok: false, reason, raw });
  });

  it('accepts raw template tokens before runtime expansion', () => {
    expect(classifyRawArtifactToken('{{ContextId}}-plan.json')).toMatchObject({
      ok: true,
      token: { kind: 'shorthand', key: '{{ContextId}}-plan.json', runScope: 'current' },
    });
  });

  it('accepts a raw templated cross-run shorthand before expansion', () => {
    expect(classifyRawArtifactToken('*/{{Name}}-review.json')).toMatchObject({
      ok: true,
      token: { kind: 'shorthand', key: '{{Name}}-review.json', runScope: 'any' },
    });
  });

  it('accepts raw templated tokens as advisory before expanded classification', () => {
    // A templated `/`-shaped token is accepted permissively at raw
    // classification — its final shape is unknown until expansion. The
    // advisory kind is `rel-path`; only `.ok` gates declaration acceptance,
    // and the resolver re-classifies the expanded value.
    expect(classifyRawArtifactToken('{{Dir}}/review-*.json')).toMatchObject({
      ok: true,
      token: { kind: 'rel-path', raw: '{{Dir}}/review-*.json', path: '{{Dir}}/review-*.json' },
    });

    expect(classifyExpandedArtifactToken('reports/review-*.json')).toEqual({
      ok: false,
      reason: 'invalid-shorthand-key',
      raw: 'reports/review-*.json',
    });
  });

  it('accepts raw templated rd URI tokens without carrying parsed segments', () => {
    expect(classifyRawArtifactToken('rd://{{ContextId}}/{{RunId}}/plan.json')).toEqual({
      ok: true,
      token: {
        kind: 'rd-uri',
        raw: 'rd://{{ContextId}}/{{RunId}}/plan.json',
        uri: 'rd://{{ContextId}}/{{RunId}}/plan.json',
      },
    });
  });
});

describe('parseArtifactDeclaration classifier validation', () => {
  it.each(['foo bar', 'foo:bar'])('rejects invalid exact shorthand key %s', (rawToken) => {
    expect(parseArtifactDeclaration(`Plan "${rawToken}"`)).toBeNull();
  });

  it.each([
    'dir/*.json',
    'review-*.json extra',
    '/tmp/*.json',
    '/tmp/review-?.json',
    '/tmp/review-*.json',
  ])('rejects invalid wildcard shorthand key %s', (rawToken) => {
    expect(parseArtifactDeclaration(`Plan "${rawToken}"`)).toBeNull();
  });

  it.each([
    '*/plan.json',
    '*/end-to-end-test-review.json',
    '*/review-*.json',
  ])('accepts cross-run shorthand %s', (rawToken) => {
    expect(parseArtifactDeclaration(`Plan "${rawToken}"`)).toEqual({
      name: 'Plan',
      rawToken,
    });
  });
});

describe('classifyExpandedArtifactToken', () => {
  it.each([
    ['plan.json', { kind: 'shorthand', key: 'plan.json', runScope: 'current' }],
    ['review-?.json', { kind: 'shorthand', key: 'review-?.json', runScope: 'current' }],
    ['*/plan.json', { kind: 'shorthand', key: 'plan.json', runScope: 'any' }],
    ['*/review-?.json', { kind: 'shorthand', key: 'review-?.json', runScope: 'any' }],
  ] as const)('classifies expanded %s as shorthand', (raw, token) => {
    expect(classifyExpandedArtifactToken(raw)).toEqual({
      ok: true,
      token: { ...token, raw },
    });
  });

  it.each([
    ['rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json', 'rd-uri'],
    ['/tmp/plan.json', 'abs-path'],
    ['C:\\tmp\\plan.json', 'abs-path'],
    ['\\\\server\\share\\plan.json', 'abs-path'],
    ['schemas/review.schema.json', 'rel-path'],
  ] as const)('classifies expanded %s as %s', (raw, kind) => {
    expect(classifyExpandedArtifactToken(raw)).toMatchObject({
      ok: true,
      token: { kind, raw },
    });
  });

  it('rejects unresolved template markers after expansion', () => {
    expect(classifyExpandedArtifactToken('rd://{{env}}/file.yaml')).toEqual({
      ok: false,
      reason: 'unresolved-template',
      raw: 'rd://{{env}}/file.yaml',
    });

    expect(classifyExpandedArtifactToken('{{Name}}-plan.json')).toEqual({
      ok: false,
      reason: 'unresolved-template',
      raw: '{{Name}}-plan.json',
    });
  });

  it.each([
    '/tmp/review-*.json',
    'C:\\tmp\\review-?.json',
  ])('rejects expanded absolute glob path %s', (raw) => {
    expect(classifyExpandedArtifactToken(raw)).toEqual({
      ok: false,
      reason: 'invalid-shorthand-key',
      raw,
    });
  });

  it('classifies an expanded templated rd URI as an rd URI without carrying parsed segments', () => {
    expect(
      classifyExpandedArtifactToken(
        'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      ),
    ).toEqual({
      ok: true,
      token: {
        kind: 'rd-uri',
        raw: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
        uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      },
    });
  });
});

describe('SELECTOR_ARTIFACT_KEY_PATTERN', () => {
  it.each([
    'plan.json',
    'review-plan-a.json',
    'end-to-end-test-review.json',
  ])('accepts exact key %s', (key) => {
    expect(SELECTOR_ARTIFACT_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each([
    'plan-*.json',
    'review-?.json',
    '*.json',
    'a*b?c.json',
  ])('accepts wildcard key %s', (key) => {
    expect(SELECTOR_ARTIFACT_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each(['.', '..'])('accepts dot-segment key %s', (key) => {
    expect(SELECTOR_ARTIFACT_KEY_PATTERN.test(key)).toBe(true);
  });

  // `.` and `..` are intentionally NOT rejected by this pattern — it
  // mirrors EXACT_ARTIFACT_KEY_PATTERN, which also accepts them. Dot-segment
  // safety is the caller's job (`rejectUnsafeArtifactToken` / `assertSafeId`).
  it.each([
    '',
    'nested/plan.json',
    'with space.json',
    'plan#.json',
    '**',
  ])('rejects unsafe key %s', (key) => {
    expect(SELECTOR_ARTIFACT_KEY_PATTERN.test(key)).toBe(false);
  });
});
