import { describe, it, expect } from '@jest/globals';
import {
  EXACT_ARTIFACT_KEY_PATTERN,
  WILDCARD_ARTIFACT_KEY_PATTERN,
  isWildcardArtifactKey,
  parseArtifactDeclaration,
} from '../src/index.js';

describe('parseArtifactDeclaration', () => {
  it('parses an exact key (alphanumerics, dot, dash, underscore)', () => {
    expect(parseArtifactDeclaration('PlanPath "plan.json"')).toEqual({
      name: 'PlanPath',
      key: 'plan.json',
      kind: 'exact',
    });
  });

  it('parses a wildcard key with `*`', () => {
    expect(parseArtifactDeclaration('Reviews "*-reviews.json"')).toEqual({
      name: 'Reviews',
      key: '*-reviews.json',
      kind: 'wildcard',
    });
  });

  it('parses a wildcard key with `?`', () => {
    expect(parseArtifactDeclaration('Single "plan-?.json"')).toEqual({
      name: 'Single',
      key: 'plan-?.json',
      kind: 'wildcard',
    });
  });

  it('returns null when the key is not quoted', () => {
    expect(parseArtifactDeclaration('PlanPath plan.json')).toBeNull();
  });

  it('returns null on a slash in the key', () => {
    expect(parseArtifactDeclaration('PlanPath "plans/plan.json"')).toBeNull();
  });

  it('returns null on a `..` traversal key', () => {
    expect(parseArtifactDeclaration('PlanPath ".."')).toBeNull();
  });

  it('returns null on a `.` key', () => {
    expect(parseArtifactDeclaration('PlanPath "."')).toBeNull();
  });

  it('returns null on an empty key', () => {
    expect(parseArtifactDeclaration('PlanPath ""')).toBeNull();
  });

  it('returns null on a recursive `**` wildcard', () => {
    expect(parseArtifactDeclaration('Plans "**.json"')).toBeNull();
  });

  it('returns null on an invalid identifier name', () => {
    expect(parseArtifactDeclaration('123bad "plan.json"')).toBeNull();
  });

  it('returns null on an empty string', () => {
    expect(parseArtifactDeclaration('')).toBeNull();
  });

  it('returns null when only a name is provided (no key)', () => {
    expect(parseArtifactDeclaration('PlanPath')).toBeNull();
  });

  it('returns null when text inside the quotes contains whitespace', () => {
    expect(parseArtifactDeclaration('PlanPath "plan with space.json"')).toBeNull();
  });

  it('does not template-expand keys (literal `{{var}}` is rejected by the key pattern)', () => {
    expect(parseArtifactDeclaration('PlanPath "{{var}}"')).toBeNull();
  });

  it('isWildcardArtifactKey returns true for wildcard keys', () => {
    expect(isWildcardArtifactKey('*-reviews.json')).toBe(true);
    expect(isWildcardArtifactKey('plan-?.json')).toBe(true);
  });

  it('isWildcardArtifactKey returns false for exact keys', () => {
    expect(isWildcardArtifactKey('plan.json')).toBe(false);
  });

  it('exposes EXACT_ARTIFACT_KEY_PATTERN and WILDCARD_ARTIFACT_KEY_PATTERN', () => {
    expect(EXACT_ARTIFACT_KEY_PATTERN.test('plan.json')).toBe(true);
    expect(EXACT_ARTIFACT_KEY_PATTERN.test('plan*.json')).toBe(false);
    expect(WILDCARD_ARTIFACT_KEY_PATTERN.test('plan*.json')).toBe(true);
  });
});
