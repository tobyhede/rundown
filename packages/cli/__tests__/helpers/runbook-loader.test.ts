import { describe, it, expect } from '@jest/globals';
import { getRunbookFromState } from '../../src/helpers/runbook-loader.js';
import { assertRunId, type ArtifactRecord, type RunbookState } from '@rundown-org/core';
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
    };

    const steps = getRunbookFromState(state as RunbookState, '/unused');

    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe('1');
    expect(steps[1].name).toBe('2');
  });

  it('should throw when runbookSrc is missing (corrupted state)', () => {
    const state: Partial<RunbookState> = {
      id: 'corrupted-id' as RunbookState['id'],
      runbook: { source: 'project', path: 'test.runbook.md' },
      // runbookSrc is undefined
    };

    expect(() => {
      getRunbookFromState(state as RunbookState, '/unused');
    }).toThrow('State file corrupted-id is missing runbookSrc');
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
    expect(steps[0].prompt).toContain(artifact.uri);
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
    }).toThrow('State file missing-src-id is missing runbookSrc');
  });
});
