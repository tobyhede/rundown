import { describe, it, expect } from '@jest/globals';
import {
  evaluateStepOutputs,
  evaluateFrontmatterOutputs,
} from '../../../src/helpers/step-outputs.js';
import type { OutputDeclaration } from '@rundown-org/parser';

describe('evaluateStepOutputs', () => {
  it('evaluates with-value form expressions', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Result', value: '"literal-value"' }];
    const vars = { ContextId: 'ctx-abc', Step: '1' };
    const result = evaluateStepOutputs(outputs, vars);
    expect(result).toEqual({ Result: 'literal-value' });
  });

  it('evaluates multiple outputs', () => {
    const outputs: OutputDeclaration[] = [
      { name: 'A', value: '"val-a"' },
      { name: 'B', value: '"val-b"' },
    ];
    const result = evaluateStepOutputs(outputs, { ContextId: 'ctx' });
    expect(result).toEqual({ A: 'val-a', B: 'val-b' });
  });

  it('skips naked form (no value) — only valid for frontmatter', () => {
    const outputs: OutputDeclaration[] = [{ name: 'NakedVar' }];
    const vars = { NakedVar: 'hello', ContextId: 'ctx-abc' };
    const result = evaluateStepOutputs(outputs, vars);
    expect(result).toEqual({});
  });

  it('returns empty object for empty outputs array', () => {
    const result = evaluateStepOutputs([], { ContextId: 'ctx' });
    expect(result).toEqual({});
  });
});

describe('evaluateFrontmatterOutputs', () => {
  it('handles naked form by reading var by name', () => {
    const outputs: OutputDeclaration[] = [{ name: 'PlanPath' }];
    const vars = { PlanPath: '/work/plan.json', ContextId: 'ctx-abc' };
    const result = evaluateFrontmatterOutputs(outputs, vars);
    expect(result).toEqual({ PlanPath: '/work/plan.json' });
  });

  it('handles with-value form via expression evaluation', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Literal', value: '"hello-world"' }];
    const result = evaluateFrontmatterOutputs(outputs, { ContextId: 'ctx-abc' });
    expect(result).toEqual({ Literal: 'hello-world' });
  });

  it('skips naked form when var is absent', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Missing' }];
    const result = evaluateFrontmatterOutputs(outputs, { ContextId: 'ctx-abc' });
    expect(result).toEqual({});
  });

  it('skips naked form when var is non-scalar (array)', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Items' }];
    const vars = { Items: ['a', 'b', 'c'], ContextId: 'ctx-abc' };
    const result = evaluateFrontmatterOutputs(outputs, vars as Record<string, string>);
    expect(result).toEqual({});
  });

  it('converts number values to string for naked form', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Port' }];
    const result = evaluateFrontmatterOutputs(outputs, {
      Port: 3000 as unknown as string,
      ContextId: 'ctx',
    });
    expect(result).toEqual({ Port: '3000' });
  });

  it('converts boolean values to string for naked form', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Debug' }];
    const result = evaluateFrontmatterOutputs(outputs, {
      Debug: true as unknown as string,
      ContextId: 'ctx',
    });
    expect(result).toEqual({ Debug: 'true' });
  });

  it('skips naked-form output when variable is undefined (not null)', () => {
    const result = evaluateFrontmatterOutputs([{ name: 'Missing' }], {
      PlanPath: '/some/path',
      ContextId: 'ctx',
    });
    expect(result).toEqual({});
  });

  it('skips naked-form output when variable is null', () => {
    const result = evaluateFrontmatterOutputs([{ name: 'NullVar' }], {
      NullVar: null as unknown as string,
    });
    expect(result).toEqual({});
  });

  it('returns empty object for empty outputs array', () => {
    const result = evaluateFrontmatterOutputs([], { ContextId: 'ctx' });
    expect(result).toEqual({});
  });
});
