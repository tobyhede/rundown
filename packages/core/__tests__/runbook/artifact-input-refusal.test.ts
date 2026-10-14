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
  vars: Pick<PrepareParsedRunbookInput, 'templateVars' | 'runtimeVars' | 'providedKeys'> & {
    readonly origin?: PrepareParsedRunbookInput['origin'];
  },
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
    origin: vars.origin ?? { kind: 'launch' },
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
    expect(result.error).toContain('a plain string that is not an rd:// URI');
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

// A value supplied as `--input KEY` (env inheritance) or `RD_INPUT_*` may be a
// secret; the refusal names the variable and the value's kind, never the value.
const SECRET = 'sk-live-0123456789abcdefSECRET';

describe('refusal messages never echo the value (A9)', () => {
  it('a launch refusal for a naked assertion describes the value without echoing it', () => {
    const result = prepare(ASSERTING_RUNBOOK, {
      templateVars: { SkillPath: SECRET },
      providedKeys: new Set(['SkillPath']),
    });

    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_INPUT_REQUIRED' });
    if (result.ok) return;
    expect(result.error).not.toContain(SECRET);
    expect(result.error).not.toContain('SECRET');
    expect(result.error).toContain('a plain string that is not an rd:// URI');
  });

  it('a launch refusal for {{ path X }} describes the value without echoing it', () => {
    const result = prepare('# Read\n\n## 1. Read\n- PASS COMPLETE\n\nRead {{ path Doc }}.\n', {
      templateVars: { Doc: SECRET },
      providedKeys: new Set(['Doc']),
    });

    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_INPUT_REQUIRED' });
    if (result.ok) return;
    expect(result.error).not.toContain('SECRET');
    expect(result.error).toContain('a plain string that is not an rd:// URI');
  });

  it.each([
    [42, 'a number'],
    [['plan.md'], 'a string array with an entry that is not an rd:// URI'],
    [
      '["rd://artifacts/ctx1/*/plan.json","plan.json"]',
      'a JSON array string with an entry that is not an rd:// URI',
    ],
  ])('describes %p as %s', (value, kind) => {
    const result = prepare(ASSERTING_RUNBOOK, {
      templateVars: { SkillPath: value },
      providedKeys: new Set(['SkillPath']),
    });

    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_INPUT_REQUIRED' });
    if (result.ok) return;
    expect(result.error).toContain(kind);
  });
});

describe('launch deferral for names a composed child can bind (A1)', () => {
  const composing = (delegate: boolean) => `---
inputs:
  - plan
---
# Parent

## 1. Plan
- PASS ALL CONTINUE
- FAIL ANY STOP

- planner.runbook.md${delegate ? '\n  - DELEGATE' : ''}

## 2. Use the plan
- ARTIFACTS
  - plan
- PASS COMPLETE

Use it.
`;

  it.each([
    ['an inline child', false],
    ['a delegated child', true],
  ])(
    'defers a naked assertion when %s may bind the name through frontmatter outputs',
    (_label, delegate) => {
      const result = prepare(composing(delegate), {
        templateVars: { plan: 'plan.json' },
        providedKeys: new Set(['plan']),
      });

      expect(result.ok).toBe(true);
    },
  );

  it('defers {{ path X }} when a composed child may bind the name', () => {
    const result = prepare(composing(false).replace('Use it.', 'Read {{ path plan }}.'), {
      templateVars: { plan: 'plan.json' },
      providedKeys: new Set(['plan']),
    });

    expect(result.ok).toBe(true);
  });
});

describe('launch deferral of {{ path X }} for produced names (A2)', () => {
  const produced = `---
inputs:
  - plan
---
# Produced

## 1. Produce the plan
- ARTIFACTS
  - plan "plan.md"
- PASS CONTINUE

Write the plan.

## 2. Read the plan
- PASS COMPLETE

Read {{ path plan }}.
`;

  it('defers {{ path X }} over a launch value an earlier ARTIFACTS alias rebinds', () => {
    const result = prepare(produced, {
      templateVars: { plan: 'draft' },
      providedKeys: new Set(['plan']),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Left for step entry, which renders against the rebound artifact.
    expect(result.runbook.steps[1]?.prompt).toContain('{{ path plan }}');
  });

  it('still refuses {{ path X }} over a launch value no step can rebind', () => {
    const result = prepare(produced.replace('  - plan "plan.md"', '  - other "plan.md"'), {
      templateVars: { plan: 'draft' },
      providedKeys: new Set(['plan']),
    });

    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_INPUT_REQUIRED' });
  });
});

describe('refusal guidance follows where the refusal happens (A3)', () => {
  it('a child-preparation refusal names the parent binding, not a launch flag', () => {
    const result = prepare(ASSERTING_RUNBOOK, {
      templateVars: { SkillPath: 'some/file.md' },
      providedKeys: new Set(['SkillPath']),
      origin: { kind: 'child-preparation' },
    });

    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_INPUT_REQUIRED' });
    if (result.ok) return;
    expect(result.error).not.toContain('--artifacts');
    expect(result.error).toContain('parent');
  });
});

describe('prompted-for substeps are launch-checked (A4)', () => {
  const promptedFor = (asserted: string) => `---
inputs:
  - Doc
---
# Prompted

## 1. Loop
- FOR item IN 1 TO {{ N }}

### 1.1 Use
- ARTIFACTS
  - ${asserted}

Use it.
`;

  it('refuses a plain launch value asserted in a prompted-for substep', () => {
    const result = prepare(promptedFor('Doc'), {
      templateVars: { Doc: 'notes.md' },
      providedKeys: new Set(['Doc']),
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'ARTIFACT_INPUT_REQUIRED',
      details: { variable: 'Doc', step: '1.1' },
    });
  });

  it('does not refuse a prompted-for substep asserting its own loop variable', () => {
    const result = prepare(promptedFor('item'), {
      templateVars: { item: 'notes.md' },
      providedKeys: new Set(['item']),
    });

    expect(result.ok).toBe(true);
  });
});

describe('one classification for forged artifact records (A6)', () => {
  it('describes an unbranded artifact-shaped record as unverified at launch', () => {
    const forged = {
      kind: 'artifact-record',
      uri: SKILL_URI,
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx-src',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'skill.md',
      timestamp: '2026-05-25T00:00:00.000Z',
    };
    const result = prepare(ASSERTING_RUNBOOK, {
      templateVars: { SkillPath: forged },
      providedKeys: new Set(['SkillPath']),
    });

    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_INPUT_REQUIRED' });
    if (result.ok) return;
    expect(result.error).toContain('not-an-artifact');
    expect(result.error).toContain('an unverified artifact-shaped record');
  });
});

describe('a FOR step asserting its own loop variable at step level (B5)', () => {
  // A step's ARTIFACTS precede its FOR clause and resolve on entering the
  // step, before any iteration binds the loop variable: the value the
  // assertion judges is the launch value, so launch can refuse it.
  const forStep = `---
inputs:
  - plans
  - plan
---
# Loop

## 1. Loop
- ARTIFACTS
  - plan
- FOR plan IN {{ plans }}

### 1.1 Use
- PASS CONTINUE

Use it.
`;

  it('judges a step-level assertion on the loop variable against the launch value', () => {
    const result = prepare(forStep, {
      templateVars: { plans: [SKILL_URI], plan: 'notes.md' },
      providedKeys: new Set(['plans', 'plan']),
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'ARTIFACT_INPUT_REQUIRED',
      details: { variable: 'plan', step: '1' },
    });
  });
});

describe('a {{ path X.Y }} refusal names the variable that binds the value (B3)', () => {
  it('reports the root binding, not the dotted reference, as the variable to supply', () => {
    const result = prepare(
      `---
inputs:
  - plan
---
# Dotted

## 1. Read
- PASS COMPLETE

Read {{ path plan.file }}.
`,
      { templateVars: { plan: { file: 'notes.md' } }, providedKeys: new Set(['plan']) },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'ARTIFACT_INPUT_REQUIRED',
      details: { variable: 'plan' },
    });
    if (result.ok) return;
    expect(result.error).toContain('--artifacts plan=<rd:// URI>');
    expect(result.error).not.toContain('--artifacts plan.file=');
    // The message still quotes the reference as the runbook wrote it.
    expect(result.error).toContain('{{ path plan.file }}');
  });
});

describe('a JSON URI[] string under {{ path X }} is described as unresolved (B1)', () => {
  it('names a JSON array string of valid rd:// URIs as unresolved, not as holding a non-URI entry', () => {
    const result = prepare(
      `---
inputs:
  - plans
---
# Plans

## 1. Read
- PASS COMPLETE

Read {{ path plans }}.
`,
      { templateVars: { plans: JSON.stringify([SKILL_URI]) }, providedKeys: new Set(['plans']) },
    );

    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_INPUT_REQUIRED' });
    if (result.ok) return;
    expect(result.error).toContain(
      'a JSON array string of rd:// URIs that have not been resolved to artifacts',
    );
    expect(result.error).not.toContain('an entry that is not an rd:// URI');
  });
});
