import { describe, expect, it } from '@jest/globals';
import {
  renderArtifactValue,
  renderArtifactPathValue,
  renderArtifactRecordValue,
  renderLiteralArtifactPath,
  type RenderArtifactOptions,
} from '../../src/runbook/renderer/artifact-helper.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';

const CWD = '/tmp/project';
const WORK_PATH = '.rundown/work';
const CONTEXT_ID = 'ctx1';
const RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RUNBOOK = { source: 'project' as const, path: 'planning/write-plan.runbook.md' };

const PLAN: ArtifactRecord = {
  kind: 'artifact-record',
  uri: `rd://artifacts/${CONTEXT_ID}/${RUN_ID}/plan.json`,
  runId: RUN_ID,
  contextId: CONTEXT_ID,
  runbook: RUNBOOK,
  key: 'plan.json',
  timestamp: '2026-05-07T00:00:00.000Z',
};

const REVIEW_A: ArtifactRecord = {
  kind: 'artifact-record',
  uri: `rd://artifacts/${CONTEXT_ID}/${RUN_ID}/review-plan-a.json`,
  runId: RUN_ID,
  contextId: CONTEXT_ID,
  runbook: RUNBOOK,
  key: 'review-plan-a.json',
  timestamp: '2026-05-07T00:00:00.000Z',
};

const OPTIONS: RenderArtifactOptions = {
  cwd: CWD,
  workPath: WORK_PATH,
  contextId: CONTEXT_ID,
  runId: RUN_ID,
};

describe('renderArtifactValue (direct alias projection)', () => {
  it('renders an ArtifactRecord as its URI string', () => {
    expect(renderArtifactValue(PLAN, OPTIONS)).toBe(PLAN.uri);
  });

  it('renders an ArtifactRecord[] as a JSON array of URIs', () => {
    expect(renderArtifactValue([REVIEW_A], OPTIONS)).toBe(JSON.stringify([REVIEW_A.uri]));
  });

  it('renders an empty ArtifactRecord[] as the literal "[]"', () => {
    expect(renderArtifactValue([], OPTIONS)).toBe('[]');
  });
});

describe('renderArtifactPathValue (path helper)', () => {
  it('renders an ArtifactRecord as its local artifact path', () => {
    const out = renderArtifactPathValue(PLAN, OPTIONS);
    expect(out).toContain(`.rd-${CONTEXT_ID}`);
    expect(out).toContain(RUN_ID);
    expect(out.endsWith('plan.json')).toBe(true);
  });

  it('renders an ArtifactRecord[] as a JSON array of local paths', () => {
    const out = renderArtifactPathValue([REVIEW_A], OPTIONS);
    const parsed = JSON.parse(out) as string[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].endsWith('review-plan-a.json')).toBe(true);
  });

  it('renders empty ArtifactRecord[] as "[]"', () => {
    expect(renderArtifactPathValue([], OPTIONS)).toBe('[]');
  });
});

describe('renderArtifactRecordValue (artifact helper)', () => {
  // Per spec §9.3 the `artifact` helper renders URI values with the same shape
  // as direct-alias rendering — scalar URI for an ArtifactRecord, JSON array
  // of URIs for ArtifactRecord[]. It is functionally identical to
  // `renderArtifactValue`; the helper exists as an explicit author-visible
  // surface for "render this as an artifact URI".

  it('renders an ArtifactRecord as its URI string', () => {
    expect(renderArtifactRecordValue(PLAN, OPTIONS)).toBe(PLAN.uri);
  });

  it('renders an ArtifactRecord[] as a JSON array of URIs', () => {
    expect(renderArtifactRecordValue([REVIEW_A], OPTIONS)).toBe(JSON.stringify([REVIEW_A.uri]));
  });

  it('renders empty ArtifactRecord[] as "[]"', () => {
    expect(renderArtifactRecordValue([], OPTIONS)).toBe('[]');
  });
});

describe('renderLiteralArtifactPath (literal path helper)', () => {
  it('renders the current-run local path for a valid key', () => {
    const out = renderLiteralArtifactPath('plan.json', OPTIONS);
    expect(out).toContain(`.rd-${CONTEXT_ID}`);
    expect(out).toContain(RUN_ID);
    expect(out.endsWith('plan.json')).toBe(true);
  });

  it('throws for an invalid key shape', () => {
    expect(() => renderLiteralArtifactPath('../escape.json', OPTIONS)).toThrow();
  });

  it('throws for empty key', () => {
    expect(() => renderLiteralArtifactPath('', OPTIONS)).toThrow();
  });
});
