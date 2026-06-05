import { describe, expect, it } from '@jest/globals';
import {
  renderArtifactValue,
  renderArtifactPathValue,
  renderArtifactRecordValue,
  renderLiteralArtifactPath,
  type RenderArtifactOptions,
} from '../../src/runbook/renderer/artifact-helper.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import { assertRunId } from '../../src/runbook/run-id.js';

const CWD = '/tmp/project';
const WORK_PATH = '.rundown/work';
const CONTEXT_ID = 'ctx1';
const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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

const SCHEMA_FILE: ArtifactRecord = {
  kind: 'file-artifact-record',
  uri: 'file:///tmp/project/schemas/review.schema.json',
  runId: RUN_ID,
  contextId: CONTEXT_ID,
  runbook: RUNBOOK,
  key: 'schemas/review.schema.json',
  timestamp: '2026-05-07T00:00:00.000Z',
};

const OPTIONS: RenderArtifactOptions = {
  cwd: CWD,
  workPath: WORK_PATH,
  contextId: CONTEXT_ID,
  runId: RUN_ID,
};

describe('renderArtifactValue (direct alias projection)', () => {
  it('renders an ArtifactRecord as its local artifact path', () => {
    expect(renderArtifactValue(PLAN, OPTIONS)).toBe(
      '/tmp/project/.rundown/work/.rd-ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
    );
  });

  it('renders an ArtifactRecord[] as a JSON array of local paths', () => {
    expect(renderArtifactValue([REVIEW_A], OPTIONS)).toBe(
      JSON.stringify([
        '/tmp/project/.rundown/work/.rd-ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/review-plan-a.json',
      ]),
    );
  });

  it('renders an empty ArtifactRecord[] as the literal "[]"', () => {
    expect(renderArtifactValue([], OPTIONS)).toBe('[]');
  });

  it('renders a file artifact record as the referenced filesystem path', () => {
    expect(renderArtifactValue(SCHEMA_FILE, OPTIONS)).toBe(
      '/tmp/project/schemas/review.schema.json',
    );
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

  it('renders a file artifact record as the resolved filesystem path', () => {
    expect(renderArtifactPathValue(SCHEMA_FILE, OPTIONS)).toBe(
      '/tmp/project/schemas/review.schema.json',
    );
  });
});

describe('renderArtifactRecordValue (artifact helper)', () => {
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
