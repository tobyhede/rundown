import { describe, expect, it } from '@jest/globals';
import { parseRunbookDocument } from '@rundown-org/parser';
import {
  assertRunId,
  prepareParsedRunbook,
  type ArtifactRecord,
  type PrepareParsedRunbookInput,
} from '../../src/runbook/index.js';
import { brandTrustedArtifactRecordForTest } from '../../src/testing/effective-vars.js';

/**
 * Launch-time refusal of a non-artifact value bound to a name a naked
 * `ARTIFACTS` assertion requires (language spec §10.1.2), at the core seam
 * every launch path shares: `prepareParsedRunbook`.
 */

// Mirrors the shape of the plugin's convert-skill runbook: the input is
// declared in `inputs:`, asserted naked at step 2, and projected through the
// `path` helper in the same step.
const ASSERTING_RUNBOOK = `---
inputs:
  - SkillPath
required:
  - SkillPath
---
# Convert

## 1. Prepare
- PASS CONTINUE

Get ready.

## 2. Read the source skill
- ARTIFACTS
  - SkillPath
- PASS COMPLETE

Read {{ path SkillPath }}.
`;

const SKILL_URI = 'rd://artifacts/ctx-src/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skill.md';

function prepare(
  markdown: string,
  vars: Pick<PrepareParsedRunbookInput, 'templateVars' | 'runtimeVars' | 'providedKeys'>,
) {
  const parsed = parseRunbookDocument(markdown, 'convert.runbook.md');
  return prepareParsedRunbook({
    rawRunbook: parsed.runbook,
    frontmatter: parsed.frontmatter,
    diagnostics: parsed.diagnostics,
    cwd: '/tmp/project',
    templateVars: { ContextId: 'ctx1', WorkPath: '.rundown/work', ...vars.templateVars },
    ...(vars.runtimeVars !== undefined ? { runtimeVars: vars.runtimeVars } : {}),
    providedKeys: vars.providedKeys,
    runbookRef: { source: 'project', path: 'convert.runbook.md' },
    helperRegistry: new Map(),
    identity: { kind: 'runnable', runId: assertRunId('rd_0123456789abcdef0123456789abcdef') },
  });
}

describe('artifact-asserted input refusal at launch', () => {
  it('refuses a plain string bound to a naked-asserted name with ARTIFACT_INPUT_REQUIRED', () => {
    const result = prepare(ASSERTING_RUNBOOK, {
      templateVars: { SkillPath: 'some/file.md' },
      providedKeys: new Set(['SkillPath']),
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'ARTIFACT_INPUT_REQUIRED',
      details: { variable: 'SkillPath', step: '2' },
    });
    if (result.ok) return;
    expect(result.error).toContain('--artifacts SkillPath=<rd:// URI>');
    expect(result.error).toContain('some/file.md');
  });

  it('refuses a non-string, non-artifact value the assertion can never accept', () => {
    const result = prepare(ASSERTING_RUNBOOK, {
      templateVars: { SkillPath: 42 },
      providedKeys: new Set(['SkillPath']),
    });

    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_INPUT_REQUIRED' });
  });

  it('accepts a trusted artifact supplied through the artifact channel', () => {
    const record: ArtifactRecord = {
      kind: 'artifact-record',
      uri: SKILL_URI,
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx-src',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'skill.md',
      timestamp: '2026-05-25T00:00:00.000Z',
    };
    const result = prepare(ASSERTING_RUNBOOK, {
      templateVars: {},
      runtimeVars: { SkillPath: brandTrustedArtifactRecordForTest(record) },
      providedKeys: new Set(['SkillPath']),
    });

    expect(result.ok).toBe(true);
  });

  it('defers an rd:// URI string to step entry, which resolves it against the manifest', () => {
    const result = prepare(
      ASSERTING_RUNBOOK.replace('Read {{ path SkillPath }}.', 'Read the skill.'),
      { templateVars: { SkillPath: SKILL_URI }, providedKeys: new Set(['SkillPath']) },
    );

    expect(result.ok).toBe(true);
  });

  it('defers a name an earlier step can rebind (the §8.2 produced set) to step entry', () => {
    const produced = `---
inputs:
  - Plan
---
# Produced

## 1. Produce the plan
- ARTIFACTS
  - Plan "plan.json"
- PASS CONTINUE

Write the plan.

## 2. Use the plan
- ARTIFACTS
  - Plan
- PASS COMPLETE

Use it.
`;
    const result = prepare(produced, {
      templateVars: { Plan: 'plan.json' },
      providedKeys: new Set(['Plan']),
    });

    expect(result.ok).toBe(true);
  });

  it('does not judge a name no naked assertion requires', () => {
    const result = prepare(
      ASSERTING_RUNBOOK.replace('- ARTIFACTS\n  - SkillPath\n', '').replace(
        'Read {{ path SkillPath }}.',
        'Read {{ SkillPath }}.',
      ),
      { templateVars: { SkillPath: 'some/file.md' }, providedKeys: new Set(['SkillPath']) },
    );

    expect(result.ok).toBe(true);
  });
});

describe('path helper refusal at launch', () => {
  it('refuses {{ path X }} over a plain string with ARTIFACT_INPUT_REQUIRED, not an untyped throw', () => {
    const helperOnly = `# Read

## 1. Read
- PASS COMPLETE

Read {{ path Doc }}.
`;
    let result: ReturnType<typeof prepare> | undefined;
    expect(() => {
      result = prepare(helperOnly, {
        templateVars: { Doc: 'notes.md' },
        providedKeys: new Set(['Doc']),
      });
    }).not.toThrow();

    expect(result).toMatchObject({
      ok: false,
      code: 'ARTIFACT_INPUT_REQUIRED',
      details: { variable: 'Doc' },
    });
    if (result === undefined || result.ok) return;
    expect(result.error).toContain('--artifacts Doc=<rd:// URI>');
  });
});
