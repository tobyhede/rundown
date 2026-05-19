import { describe, expect, it } from '@jest/globals';
import {
  classifyExpandedArtifactToken,
  classifyRawArtifactToken,
  parseArtifactDeclaration,
} from '../src/index.js';

describe('classifyRawArtifactToken', () => {
  it.each([
    ['plan.json', 'bare-key'],
    ['review-*.json', 'wildcard-key'],
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
    ['   ', 'invalid-bare-key'],
    ['.', 'dot-segment'],
    ['..', 'dot-segment'],
    ['**', 'recursive-wildcard'],
    ['dir/**/plan.json', 'recursive-wildcard'],
    ['a/./b.json', 'dot-segment'],
    ['a/../b.json', 'dot-segment'],
    ['foo bar', 'invalid-bare-key'],
    ['foo:bar', 'invalid-bare-key'],
    ['plan#.json', 'invalid-bare-key'],
    ['dir/*.json', 'invalid-wildcard-key'],
    ['review-*.json extra', 'invalid-wildcard-key'],
  ] as const)('rejects %s with reason %s', (raw, reason) => {
    expect(classifyRawArtifactToken(raw)).toEqual({ ok: false, reason, raw });
  });

  it('accepts raw template tokens before runtime expansion', () => {
    expect(classifyRawArtifactToken('{{ContextId}}-plan.json')).toMatchObject({
      ok: true,
      token: { kind: 'bare-key', raw: '{{ContextId}}-plan.json' },
    });
  });

  it('accepts raw templated tokens as advisory before expanded classification', () => {
    expect(classifyRawArtifactToken('{{Dir}}/review-*.json')).toMatchObject({
      ok: true,
      token: { kind: 'wildcard-key', raw: '{{Dir}}/review-*.json' },
    });

    expect(classifyExpandedArtifactToken('reports/review-*.json')).toEqual({
      ok: false,
      reason: 'invalid-wildcard-key',
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
  it.each(['foo bar', 'foo:bar'])('rejects invalid exact bare key %s', (rawToken) => {
    expect(parseArtifactDeclaration(`Plan "${rawToken}"`)).toBeNull();
  });

  it.each(['dir/*.json', 'review-*.json extra'])('rejects invalid wildcard key %s', (rawToken) => {
    expect(parseArtifactDeclaration(`Plan "${rawToken}"`)).toBeNull();
  });
});

describe('classifyExpandedArtifactToken', () => {
  it.each([
    ['plan.json', 'bare-key'],
    ['review-?.json', 'wildcard-key'],
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
