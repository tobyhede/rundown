import { describe, it, expect } from '@jest/globals';
import { getRunbookFromState } from '../../src/helpers/runbook-loader.js';
import { assertRunId, type ArtifactRecord, type RunbookState } from '@rundown-org/core';
import type { ResolvedStep } from '@rundown-org/parser';
import { brandInitialTemplateVarsForTest, brandStoredOutputsForTest } from './brand-helpers.js';

describe('getRunbookFromState', () => {
  it('should parse from runbookSrc when available', () => {
    const runbookSrc = `# Test Runbook

## 1. First Step
- PASS CONTINUE

\`\`\`bash
echo hello
\`\`\`

## 2. Second Step
- PASS COMPLETE

\`\`\`bash
echo done
\`\`\`
`;
    const state: Partial<RunbookState> = {
      id: 'test-id' as RunbookState['id'],
      runbook: { source: 'project', path: 'test.runbook.md' },
      runbookSrc,
      templateVars: brandInitialTemplateVarsForTest({
        ContextId: 'current-context',
        WorkPath: '.rundown/work',
      }),
    };

    const steps = getRunbookFromState(state as RunbookState, '/unused');

    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe('1');
    expect(steps[1].name).toBe('2');
  });

  // A persisted row without templateVars is incompatible state, not something to
  // reconstruct by re-parsing the stored source. That refusal is asserted where
  // it is enforceable — against raw persisted JSON, in
  // core's `state-schema-version.test.ts` ('rejects current-schema state missing
  // templateVars instead of reconstructing it'). It cannot be re-asserted here:
  // `templateVars` is required on `RunbookState`, so reaching this function
  // without one takes a cast, which would test the cast rather than the system.

  it('should throw when runbookSrc is missing (corrupted state)', () => {
    const state: Partial<RunbookState> = {
      id: 'corrupted-id' as RunbookState['id'],
      runbook: { source: 'project', path: 'test.runbook.md' },
      // runbookSrc is undefined
    };

    expect(() => {
      getRunbookFromState(state as RunbookState, '/unused');
    }).toThrow('Persisted run corrupted-id is missing runbookSrc');
  });

  it('should throw on the first error-severity structural diagnostic', () => {
    // Diagnostics come back as [warning, error, error]: step 1 self-GOTOs
    // (warning), steps 2 and 3 target steps that do not exist (errors). The
    // interleaving is deliberate — it pins that the reported message is the
    // first *error*, not the first diagnostic and not a later error.
    const runbookSrc = `# Structural Runbook

## 1. Loop
- PASS GOTO 1
- FAIL CONTINUE

## 2. Bad Target
- PASS GOTO 99
- FAIL CONTINUE

## 3. Another Bad Target
- PASS GOTO 98
- FAIL COMPLETE
`;
    const state: Partial<RunbookState> = {
      id: assertRunId('rd_66666666666666666666666666666666'),
      runbook: { source: 'project', path: 'structural.runbook.md' },
      runbookSrc,
      templateVars: brandInitialTemplateVarsForTest({
        ContextId: 'current-context',
        WorkPath: '.rundown/work',
      }),
    };

    const load = (): readonly ResolvedStep[] =>
      getRunbookFromState(state as RunbookState, '/project');

    expect(load).toThrow(
      'Runbook structural.runbook.md has structural errors: Step 2: GOTO target step "99" does not exist.. Delete state and re-run the runbook.',
    );
    // Not the leading warning, and not the second error.
    expect(load).not.toThrow(/GOTO self without RETRY/);
    expect(load).not.toThrow(/"98"/);
  });

  it('should not throw when diagnostics are warning-severity only', () => {
    // A self-GOTO without RETRY is a warning, not an error. Warnings must not
    // reach the structural-error refusal — the run stays loadable.
    const runbookSrc = `# Warning Runbook

## 1. Loop
- PASS GOTO 1
- FAIL COMPLETE
`;
    const state: Partial<RunbookState> = {
      id: assertRunId('rd_77777777777777777777777777777777'),
      runbook: { source: 'project', path: 'warning.runbook.md' },
      runbookSrc,
      templateVars: brandInitialTemplateVarsForTest({
        ContextId: 'current-context',
        WorkPath: '.rundown/work',
      }),
    };

    const steps = getRunbookFromState(state as RunbookState, '/project');

    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('1');
  });

  it('should substitute templateVars when present in state', () => {
    const runbookSrc = `# Template Runbook

## 1. Deploy
- PASS COMPLETE

Deploy to {{ env }}.
`;
    const state: Partial<RunbookState> = {
      id: assertRunId('rd_55555555555555555555555555555555'),
      runbook: { source: 'project', path: 'template.runbook.md' },
      runbookSrc,
      templateVars: brandInitialTemplateVarsForTest({
        env: 'staging',
        ContextId: 'current-context',
        WorkPath: '.rundown/work',
      }),
    };

    const steps = getRunbookFromState(state as RunbookState, '/unused');

    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('1');
    expect(steps[0].prompt).toContain('staging');
  });

  it('should substitute persisted runtime artifact variables when reloading state', () => {
    const runId = assertRunId('rd_11111111111111111111111111111111');
    const artifactRunId = assertRunId('rd_22222222222222222222222222222222');
    const artifact: ArtifactRecord = {
      kind: 'artifact-record',
      uri: 'rd://artifacts/producer-context/rd_22222222222222222222222222222222/plan.json',
      runId: artifactRunId,
      contextId: 'producer-context',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    };
    const runbookSrc = `# Artifact Runbook

## 1. Use Plan
- PASS COMPLETE

Plans: {{ Plans }}
`;
    const state: Partial<RunbookState> = {
      id: runId,
      runbook: { source: 'project', path: 'artifact.runbook.md' },
      runbookSrc,
      templateVars: brandInitialTemplateVarsForTest({
        ContextId: 'current-context',
        WorkPath: '.rundown/work',
      }),
      variables: brandStoredOutputsForTest({ Plans: [artifact] }),
    };

    const steps = getRunbookFromState(state as RunbookState, '/project');

    expect(steps).toHaveLength(1);
    expect(steps[0].prompt).toContain(
      '/project/.rundown/work/.rd-producer-context/rd_22222222222222222222222222222222/plan.json',
    );
    expect(steps[0].prompt).not.toContain('{{ Plans }}');
  });

  it('should throw when reload render context is missing ContextId', () => {
    const state: Partial<RunbookState> = {
      id: assertRunId('rd_33333333333333333333333333333333'),
      runbook: { source: 'project', path: 'template.runbook.md' },
      runbookSrc: '# Template Runbook\n\n## 1. Step\nUse {{ path Plan }}',
      templateVars: brandInitialTemplateVarsForTest({ WorkPath: '.rundown/work' }),
    };

    expect(() => getRunbookFromState(state as RunbookState, '/project')).toThrow(
      'Runbook state rd_33333333333333333333333333333333 is missing ContextId. Delete state and re-run the runbook.',
    );
  });

  it('should throw when reload render context is missing WorkPath', () => {
    const state: Partial<RunbookState> = {
      id: assertRunId('rd_44444444444444444444444444444444'),
      runbook: { source: 'project', path: 'template.runbook.md' },
      runbookSrc: '# Template Runbook\n\n## 1. Step\nUse {{ path Plan }}',
      templateVars: brandInitialTemplateVarsForTest({ ContextId: 'current-context' }),
    };

    expect(() => getRunbookFromState(state as RunbookState, '/project')).toThrow(
      'Runbook state rd_44444444444444444444444444444444 is missing WorkPath. Delete state and re-run the runbook.',
    );
  });

  it('should not attempt disk fallback', () => {
    const state: Partial<RunbookState> = {
      id: 'missing-src-id' as RunbookState['id'],
      runbook: { source: 'project', path: 'nonexistent.runbook.md' },
      // runbookSrc is undefined
    };

    // Should throw immediately without checking disk
    expect(() => {
      getRunbookFromState(state as RunbookState, '/some/cwd');
    }).toThrow('Persisted run missing-src-id is missing runbookSrc');
  });
});
