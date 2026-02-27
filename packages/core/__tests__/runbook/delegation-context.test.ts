import { describe, it, expect } from '@jest/globals';
import { reconstituteContextVars } from '../../src/runbook/delegation-context.js';
import type { ContextSnapshot, AncestorSnapshot } from '../../src/runbook/types.js';

describe('reconstituteContextVars', () => {
  it('produces parent vars from snapshot.vars', () => {
    const snapshot: ContextSnapshot = {
      vars: { env: 'staging', version: '1.0' },
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
      vars: {
        env: 'staging',
        'context.parent.vars.old': 'should-be-excluded',
        'context.ancestors.0.vars.old': 'should-be-excluded',
      },
      ancestors: [],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.parent.vars.env']).toBe('staging');
    expect(result['context.parent.vars.context.parent.vars.old']).toBeUndefined();
    expect(result['context.parent.vars.context.ancestors.0.vars.old']).toBeUndefined();
  });

  it('produces grandparent from snapshot.ancestors[0] with offset', () => {
    const grandparent: AncestorSnapshot = {
      runId: 'gp-run',
      runbook: 'grandparent.md',
      step: '3',
      substep: '2',
      vars: { region: 'us-east' },
    };
    const snapshot: ContextSnapshot = {
      vars: { env: 'staging' },
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
      runId: 'gp-run',
      runbook: 'grandparent.md',
      step: '2',
      substep: null,
      vars: { gp_var: 'gp_value' },
    };
    const greatGrandparent: AncestorSnapshot = {
      runId: 'ggp-run',
      runbook: 'great-grandparent.md',
      step: '1',
      substep: '3',
      vars: { ggp_var: 'ggp_value' },
    };
    const snapshot: ContextSnapshot = {
      vars: { parent_var: 'parent_value' },
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
      vars: { env: 'prod' },
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

  it('omits substep when null in ancestor', () => {
    const ancestor: AncestorSnapshot = {
      runId: 'anc-run',
      runbook: 'ancestor.md',
      step: '5',
      substep: null,
      vars: {},
    };
    const snapshot: ContextSnapshot = {
      vars: {},
      ancestors: [ancestor],
    };

    const result = reconstituteContextVars(snapshot);

    expect(result['context.ancestors.1.step']).toBe('5');
    expect(result['context.ancestors.1.substep']).toBeUndefined();
    expect(result['context.parent.parent.step']).toBe('5');
    expect(result['context.parent.parent.substep']).toBeUndefined();
  });
});
