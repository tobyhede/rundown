import { describe, it, expect } from '@jest/globals';
import { IDENTITY_OWNED_BUILTINS } from '@rundown-org/parser';
import {
  buildContextSnapshot,
  extractInheritedUserVars,
  reconstituteContextVars,
  MAX_ANCESTOR_DEPTH,
} from '../../src/runbook/delegation-context.js';
import { mergeEffectiveVars } from '../../src/runbook/effective-vars.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import type {
  AncestorSnapshot,
  ContextSnapshot,
  RunbookState,
  RunId,
} from '../../src/runbook/types.js';
import {
  brandArtifactVarsForTest,
  brandEffectiveVarsForTest,
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../helpers/effective-vars.js';

const RUN_ID = brandRunIdForTest(`rd_${'8'.repeat(32)}`);
const GRANDPARENT_RUN_ID = brandRunIdForTest(`rd_${'9'.repeat(32)}`);
const GREAT_GRANDPARENT_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
const ANCESTOR_RUN_ID = brandRunIdForTest(`rd_${'b'.repeat(32)}`);

function ancestorRunId(index: number): RunId {
  return brandRunIdForTest(`rd_${index.toString(16).padStart(32, '0')}`);
}

/** Helper: create minimal RunbookState for buildContextSnapshot tests. */
function makeMinimalState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: RUN_ID,
    runbook: { source: 'project', path: 'parent.md' },
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Main step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: '1', status: 'running' }],
    startedAt: '2026-04-22T10:00:00.000Z',
    updatedAt: '2026-04-22T10:00:00.000Z',
    ...overrides,
  };
}

describe('reconstituteContextVars', () => {
  it('produces parent vars from snapshot.vars', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { env: 'staging', version: '1.0' } }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.env']).toBe('staging');
    expect(result['context.parent.vars.version']).toBe('1.0');
    expect(result['context.ancestors.0.vars.env']).toBe('staging');
    expect(result['context.ancestors.0.vars.version']).toBe('1.0');
  });

  it('excludes context.* keys from source vars', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({
        templateVars: {
          env: 'staging',
          'context.parent.vars.old': 'should-be-excluded',
          'context.ancestors.0.vars.old': 'should-be-excluded',
        },
      }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.env']).toBe('staging');
    expect(result['context.parent.vars.context.parent.vars.old']).toBeUndefined();
    expect(result['context.parent.vars.context.ancestors.0.vars.old']).toBeUndefined();
  });

  it('produces grandparent from snapshot.ancestors[0] with offset', () => {
    const grandparent: AncestorSnapshot = {
      runId: GRANDPARENT_RUN_ID,
      runbook: 'grandparent.md',
      step: '3',
      substep: '2',
      vars: { region: 'us-east' },
    };
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { env: 'staging' } }),
      ancestors: [grandparent],
    };

    const result = reconstituteContextVars(snapshot);

    // Array-indexed form (grandparent is ancestors.1, not ancestors.0)
    expect(result['context.ancestors.1.step']).toBe('3');
    expect(result['context.ancestors.1.substep']).toBe('2');
    expect(result['context.ancestors.1.vars.region']).toBe('us-east');

    // Chain form
    expect(result['context.parent.parent.step']).toBe('3');
    expect(result['context.parent.parent.substep']).toBe('2');
    expect(result['context.parent.parent.vars.region']).toBe('us-east');
  });

  it('handles 3-level nesting', () => {
    const grandparent: AncestorSnapshot = {
      runId: GRANDPARENT_RUN_ID,
      runbook: 'grandparent.md',
      step: '2',
      substep: null,
      vars: { gp_var: 'gp_value' },
    };
    const greatGrandparent: AncestorSnapshot = {
      runId: GREAT_GRANDPARENT_RUN_ID,
      runbook: 'great-grandparent.md',
      step: '1',
      substep: '3',
      vars: { ggp_var: 'ggp_value' },
    };
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { parent_var: 'parent_value' } }),
      ancestors: [grandparent, greatGrandparent],
    };

    const result = reconstituteContextVars(snapshot);

    // Parent (ancestor 0)
    expect(result['context.parent.vars.parent_var']).toBe('parent_value');
    expect(result['context.ancestors.0.vars.parent_var']).toBe('parent_value');

    // Grandparent (ancestor 1)
    expect(result['context.ancestors.1.step']).toBe('2');
    expect(result['context.ancestors.1.vars.gp_var']).toBe('gp_value');
    expect(result['context.parent.parent.step']).toBe('2');
    expect(result['context.parent.parent.vars.gp_var']).toBe('gp_value');

    // Great-grandparent (ancestor 2)
    expect(result['context.ancestors.2.step']).toBe('1');
    expect(result['context.ancestors.2.substep']).toBe('3');
    expect(result['context.ancestors.2.vars.ggp_var']).toBe('ggp_value');
    expect(result['context.parent.parent.parent.step']).toBe('1');
    expect(result['context.parent.parent.parent.substep']).toBe('3');
    expect(result['context.parent.parent.parent.vars.ggp_var']).toBe('ggp_value');
  });

  it('handles empty ancestors array', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { env: 'prod' } }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.env']).toBe('prod');
    expect(result['context.ancestors.0.vars.env']).toBe('prod');

    // No ancestor or chain entries beyond parent
    const keys = Object.keys(result);
    expect(keys.filter((k) => k.startsWith('context.ancestors.1'))).toHaveLength(0);
    expect(keys.filter((k) => k.startsWith('context.parent.parent'))).toHaveLength(0);
  });

  it('emits parent structural fields when present in snapshot', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { env: 'staging' } }),
      ancestors: [],
      step: '2',
      substep: '1',
      at: '2.3.1',
      index: 3,
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.step']).toBe('2');
    expect(result['context.parent.substep']).toBe('1');
    expect(result['context.parent.at']).toBe('2.3.1');
    expect(result['context.parent.index']).toBe('3');
    expect(result['context.ancestors.0.step']).toBe('2');
    expect(result['context.ancestors.0.substep']).toBe('1');
    expect(result['context.ancestors.0.at']).toBe('2.3.1');
    expect(result['context.ancestors.0.index']).toBe('3');
  });

  it('omits parent structural fields when absent (backward compat)', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { env: 'staging' } }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.step']).toBeUndefined();
    expect(result['context.parent.substep']).toBeUndefined();
    expect(result['context.parent.at']).toBeUndefined();
    expect(result['context.parent.index']).toBeUndefined();
  });

  it('emits at and index for ancestors', () => {
    const ancestor: AncestorSnapshot = {
      runId: ANCESTOR_RUN_ID,
      runbook: 'ancestor.md',
      step: '3',
      substep: '1',
      vars: {},
      at: '3.2.1',
      index: 2,
    };
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: {} }),
      ancestors: [ancestor],
    };

    const result = reconstituteContextVars(snapshot);

    // Array form (grandparent is ancestors.1)
    expect(result['context.ancestors.1.at']).toBe('3.2.1');
    expect(result['context.ancestors.1.index']).toBe('2');

    // Chain form
    expect(result['context.parent.parent.at']).toBe('3.2.1');
    expect(result['context.parent.parent.index']).toBe('2');
  });

  it('omits substep when null in ancestor', () => {
    const ancestor: AncestorSnapshot = {
      runId: ANCESTOR_RUN_ID,
      runbook: 'ancestor.md',
      step: '5',
      substep: null,
      vars: {},
    };
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: {} }),
      ancestors: [ancestor],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.ancestors.1.step']).toBe('5');
    expect(result['context.ancestors.1.substep']).toBeUndefined();
    expect(result['context.parent.parent.step']).toBe('5');
    expect(result['context.parent.parent.substep']).toBeUndefined();
  });

  it('throws when ancestor chain exceeds MAX_ANCESTOR_DEPTH', () => {
    const ancestors: AncestorSnapshot[] = [];
    for (let i = 0; i < MAX_ANCESTOR_DEPTH + 1; i++) {
      ancestors.push({
        runId: ancestorRunId(i),
        runbook: `runbook-${String(i)}.md`,
        step: String(i + 1),
        substep: null,
        vars: {},
      });
    }

    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: {} }),
      ancestors,
    };

    expect(() => reconstituteContextVars(snapshot)).toThrow(
      `Parent context chain depth (${String(MAX_ANCESTOR_DEPTH + 1)}) exceeds maximum of ${String(MAX_ANCESTOR_DEPTH)} levels`,
    );
  });

  it('accepts ancestor chain at exactly MAX_ANCESTOR_DEPTH', () => {
    const ancestors: AncestorSnapshot[] = [];
    for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
      ancestors.push({
        runId: ancestorRunId(i),
        runbook: `runbook-${String(i)}.md`,
        step: String(i + 1),
        substep: null,
        vars: {},
      });
    }

    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: {} }),
      ancestors,
    };

    // Should not throw
    expect(() => reconstituteContextVars(snapshot)).not.toThrow();
  });

  it('handles snapshot with large number of ancestors (depth limit)', () => {
    // Test with 10 levels of ancestors
    const ancestors: AncestorSnapshot[] = [];
    for (let i = 0; i < 10; i++) {
      ancestors.push({
        runId: ancestorRunId(i),
        runbook: `runbook-${String(i)}.md`,
        step: String(i + 1),
        substep: null,
        vars: { level: String(i) },
      });
    }

    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { level: 'parent' } }),
      ancestors,
    };

    const result = reconstituteContextVars(snapshot);

    // Verify parent
    expect(result['context.ancestors.0.vars.level']).toBe('parent');

    // Verify all ancestors are accessible
    for (let i = 0; i < 10; i++) {
      expect(result[`context.ancestors.${String(i + 1)}.step`]).toBe(String(i + 1));
      expect(result[`context.ancestors.${String(i + 1)}.vars.level`]).toBe(String(i));
    }

    // Verify chain form for a few levels
    expect(result['context.parent.parent.step']).toBe('1');
    expect(result['context.parent.parent.parent.step']).toBe('2');
  });

  it('handles vars with special characters in keys', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({
        templateVars: {
          'key-with-dashes': 'value1',
          'key.with.dots': 'value2',
          key_with_underscores: 'value3',
        },
      }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.key-with-dashes']).toBe('value1');
    expect(result['context.parent.vars.key.with.dots']).toBe('value2');
    expect(result['context.parent.vars.key_with_underscores']).toBe('value3');
  });

  it('handles vars with empty string values', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { emptyVar: '', normalVar: 'value' } }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.emptyVar']).toBe('');
    expect(result['context.parent.vars.normalVar']).toBe('value');
  });

  it('handles ancestors with no vars field', () => {
    const ancestor: AncestorSnapshot = {
      runId: ANCESTOR_RUN_ID,
      runbook: 'ancestor.md',
      step: '2',
      substep: null,
      vars: {},
    };
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: {} }),
      ancestors: [ancestor],
    };

    const result = reconstituteContextVars(snapshot);

    // Should have structural keys but no vars keys
    expect(result['context.ancestors.1.step']).toBe('2');
    const varKeys = Object.keys(result).filter((k) => k.startsWith('context.ancestors.1.vars.'));
    expect(varKeys).toHaveLength(0);
  });

  it('handles snapshot with only structural fields (no vars)', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: {} }),
      ancestors: [],
      step: '3',
      substep: '2',
      at: '3.2',
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.step']).toBe('3');
    expect(result['context.parent.substep']).toBe('2');
    expect(result['context.parent.at']).toBe('3.2');

    // No vars should be present
    const varKeys = Object.keys(result).filter((k) => k.includes('.vars.'));
    expect(varKeys).toHaveLength(0);
  });

  it('does not mutate input snapshot', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { env: 'staging' } }),
      ancestors: [
        {
          runId: ANCESTOR_RUN_ID,
          runbook: 'anc.md',
          step: '1',
          substep: null,
          vars: { region: 'us-west' },
        },
      ],
    };

    const originalVars = { ...snapshot.vars };
    const originalAncestors = [...snapshot.ancestors];

    reconstituteContextVars(snapshot);

    // Verify snapshot wasn't mutated
    expect(snapshot.vars).toEqual(originalVars);
    expect(snapshot.ancestors).toEqual(originalAncestors);
  });

  it('handles numeric string values in vars', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { port: '8080', count: '42' } }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.port']).toBe('8080');
    expect(result['context.parent.vars.count']).toBe('42');
  });

  it('index is properly stringified when present', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: {} }),
      ancestors: [],
      step: '1',
      index: 0, // Zero is valid
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.index']).toBe('0');
    expect(result['context.ancestors.0.index']).toBe('0');
  });

  it('handles snapshot with deeply nested context.* keys to exclude', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({
        templateVars: {
          normalVar: 'value',
          'context.parent.vars.old': 'should-exclude',
          'context.ancestors.0.step': 'should-exclude',
          'context.something.else': 'should-exclude',
        },
      }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.normalVar']).toBe('value');

    // All context.* keys should be excluded
    const contextKeys = Object.keys(result).filter((k) =>
      k.startsWith('context.parent.vars.context.'),
    );
    expect(contextKeys).toHaveLength(0);
  });

  it('preserves JsonObject values in parent vars', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { config: { host: 'localhost', port: 3000 } } }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.config']).toEqual({ host: 'localhost', port: 3000 });
    expect(result['context.ancestors.0.vars.config']).toEqual({ host: 'localhost', port: 3000 });
  });

  it('preserves JsonObject values in ancestor vars', () => {
    const ancestor: AncestorSnapshot = {
      runId: GRANDPARENT_RUN_ID,
      runbook: 'grandparent.md',
      step: '1',
      substep: null,
      vars: { db: { host: 'db.example.com', port: 5432 } },
    };
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { env: 'prod' } }),
      ancestors: [ancestor],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.ancestors.1.vars.db']).toEqual({ host: 'db.example.com', port: 5432 });
    expect(result['context.parent.parent.vars.db']).toEqual({
      host: 'db.example.com',
      port: 5432,
    });
  });

  it('preserves number values in parent vars', () => {
    const snapshot: ContextSnapshot = {
      vars: mergeEffectiveVars({ templateVars: { port: 8080 } }),
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.port']).toBe(8080);
  });
});

describe('extractInheritedUserVars', () => {
  it('filters runtime identity while preserving user variables and outputs', () => {
    const snapshot = {
      vars: brandEffectiveVarsForTest({
        RunId: 'rd_parent',
        RunbookRef: { source: 'project', path: 'parent.runbook.md' },
        UserInput: 'ok',
        OutputValue: 'published',
        'context.parent.vars.UserInput': 'ignored',
      }),
      ancestors: [],
      step: '1',
    };

    expect(extractInheritedUserVars(snapshot)).toEqual(
      expect.objectContaining({ UserInput: 'ok', OutputValue: 'published' }),
    );
    expect(extractInheritedUserVars(snapshot)).not.toHaveProperty('RunId');
    expect(extractInheritedUserVars(snapshot)).not.toHaveProperty('RunbookRef');
  });

  it('filters every parser-declared identity-owned built-in', () => {
    expect(IDENTITY_OWNED_BUILTINS).toEqual(['RunId', 'RunbookRef']);

    const snapshot = {
      vars: brandEffectiveVarsForTest({
        ...Object.fromEntries(IDENTITY_OWNED_BUILTINS.map((key) => [key, `parent-${key}`])),
        UserInput: 'ok',
      }),
      ancestors: [],
      step: '1',
    };

    const inherited = extractInheritedUserVars(snapshot);

    expect(inherited).toEqual({ UserInput: 'ok' });
  });
});

describe('buildContextSnapshot', () => {
  const ARTIFACT_RECORD = {
    uri: 'rd://artifacts/ctx1/runs/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
    runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    contextId: 'ctx1',
    runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
    key: 'plan.json',
    timestamp: '2026-05-07T00:00:00.000Z',
  } satisfies ArtifactRecord;

  it('merges state.variables (step OUTPUTS) into snapshot.vars', () => {
    const state = makeMinimalState({
      templateVars: brandInitialTemplateVarsForTest({ Other: 'kept' }),
      variables: brandStoredOutputsForTest({ Message: 'hello from outputs' }),
    });
    const snap = buildContextSnapshot(state);
    expect(snap.vars.Message).toBe('hello from outputs');
    expect(snap.vars.Other).toBe('kept');
  });

  it('state.variables takes precedence over state.templateVars on key conflict', () => {
    const state = makeMinimalState({
      templateVars: brandInitialTemplateVarsForTest({ X: 'template-default' }),
      variables: brandStoredOutputsForTest({ X: 'output-overlay' }),
    });
    const snap = buildContextSnapshot(state);
    expect(snap.vars.X).toBe('output-overlay');
  });

  it('extraVars take precedence over both templateVars and variables', () => {
    const state = makeMinimalState({
      templateVars: brandInitialTemplateVarsForTest({ X: 'tv' }),
      variables: brandStoredOutputsForTest({ X: 'sv' }),
    });
    const snap = buildContextSnapshot(state, undefined, [], { extraVars: { X: 'ev' } });
    expect(snap.vars.X).toBe('ev');
  });

  it('handles state with no variables field (only templateVars)', () => {
    const state = makeMinimalState({
      templateVars: brandInitialTemplateVarsForTest({ Only: 'one' }),
      variables: brandStoredOutputsForTest({}),
    });
    const snap = buildContextSnapshot(state);
    expect(snap.vars.Only).toBe('one');
  });

  it('handles state with no templateVars field (only variables)', () => {
    const state = makeMinimalState({
      variables: brandStoredOutputsForTest({ Just: 'outputs' }),
    });
    const snap = buildContextSnapshot(state);
    expect(snap.vars.Just).toBe('outputs');
  });

  it('includes artifactVars in snapshot vars below step OUTPUTS', () => {
    const state = makeMinimalState({
      templateVars: brandInitialTemplateVarsForTest({ PlanPath: 'from-template' }),
      artifactVars: brandArtifactVarsForTest({
        PlanPath: ARTIFACT_RECORD,
        OutputWins: ARTIFACT_RECORD,
      }),
      variables: brandStoredOutputsForTest({ OutputWins: 'from-output' }),
    });

    const snap = buildContextSnapshot(state);

    expect(snap.vars.PlanPath).toEqual(ARTIFACT_RECORD);
    expect(snap.vars.OutputWins).toBe('from-output');
  });
});
