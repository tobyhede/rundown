import { describe, it, expect } from '@jest/globals';
import {
  TransitionsSchema,
  TransitionObjectSchema,
  AggregationSchema,
  StepIdSchema,
  ForClauseSchema,
  ActionSchema,
  RunbookSchema,
  BoundRefSchema,
  BoundSchema,
  UnresolvedNumericWindowSchema,
  UnresolvedSourceWindowSchema,
  ParsedForClauseSchema,
  BaseStepSchema,
  StepWithCommandSchema,
  StepWithSubstepsSchema,
  StepWithForSchema,
  StepNameSchema,
  CommandSchema,
  MAX_STEP_NUMBER,
  TEMPLATE_VAR_PATTERN,
  LoopControlActionSchema,
  SubstepSchema,
  StepSchema,
} from '../src/schemas.js';

describe('TransitionsSchema with kind', () => {
  it('should validate transitions with kind', () => {
    const input = {
      pass: { kind: 'yes', action: { type: 'CONTINUE' } },
      fail: { kind: 'no', action: { type: 'STOP' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject invalid kind', () => {
    const input = {
      pass: { kind: 'invalid', action: { type: 'CONTINUE' } },
      fail: { kind: 'no', action: { type: 'STOP' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('TransitionObjectSchema', () => {
  it('should validate transition object with pass kind', () => {
    const input = {
      kind: 'pass',
      action: { type: 'CONTINUE' },
    };
    const result = TransitionObjectSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should validate transition object with fail kind', () => {
    const input = {
      kind: 'fail',
      action: { type: 'COMPLETE' },
    };
    const result = TransitionObjectSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should validate transition object with yes kind', () => {
    const input = {
      kind: 'yes',
      action: { type: 'STOP' },
    };
    const result = TransitionObjectSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should validate transition object with no kind', () => {
    const input = {
      kind: 'no',
      action: { type: 'GOTO', target: { step: '1' } },
    };
    const result = TransitionObjectSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject transition object with invalid kind', () => {
    const input = {
      kind: 'maybe',
      action: { type: 'CONTINUE' },
    };
    const result = TransitionObjectSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject transition object without kind', () => {
    const input = {
      action: { type: 'CONTINUE' },
    };
    const result = TransitionObjectSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject transition object without action', () => {
    const input = {
      kind: 'pass',
    };
    const result = TransitionObjectSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('TransitionsSchema validation', () => {
  it('should validate transitions with pass and fail', () => {
    const input = {
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', action: { type: 'STOP' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should validate transitions with yes and no kinds', () => {
    const input = {
      pass: { kind: 'yes', action: { type: 'COMPLETE' } },
      fail: { kind: 'no', action: { type: 'CONTINUE' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject transitions without pass field', () => {
    const input = {
      fail: { kind: 'fail', action: { type: 'STOP' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject transitions without fail field', () => {
    const input = {
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject transitions with unknown fields (strict mode)', () => {
    const input = {
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', action: { type: 'STOP' } },
      unknownField: 'rejected',
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects transitions with legacy aggregation field', () => {
    const input = {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      aggregation: { strategy: 'ALL' },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('StepIdSchema with named steps', () => {
  it('accepts numeric step', () => {
    expect(StepIdSchema.safeParse({ step: '1' }).success).toBe(true);
  });

  it('rejects {N} dynamic step (no longer supported)', () => {
    expect(StepIdSchema.safeParse({ step: '{N}' }).success).toBe(false);
  });

  it('accepts NEXT', () => {
    expect(StepIdSchema.safeParse({ step: 'NEXT' }).success).toBe(true);
  });

  it('accepts named step identifier', () => {
    expect(StepIdSchema.safeParse({ step: 'Cleanup' }).success).toBe(true);
  });

  it('accepts named step with underscore', () => {
    expect(StepIdSchema.safeParse({ step: 'error_handler' }).success).toBe(true);
  });

  it('accepts named step with substep', () => {
    expect(StepIdSchema.safeParse({ step: 'ErrorHandler', substep: '1' }).success).toBe(true);
  });

  it('accepts named step with named substep', () => {
    expect(StepIdSchema.safeParse({ step: 'ErrorHandler', substep: 'Recover' }).success).toBe(true);
  });

  it('rejects NEXT with substep', () => {
    expect(StepIdSchema.safeParse({ step: 'NEXT', substep: '1' }).success).toBe(false);
  });

  it('rejects NEXT with both qualifier AND substep', () => {
    expect(
      StepIdSchema.safeParse({
        step: 'NEXT',
        qualifier: { step: 'Cleanup' },
        substep: '1',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid identifier (starts with digit)', () => {
    expect(StepIdSchema.safeParse({ step: '123abc' }).success).toBe(false);
  });

  it('rejects invalid identifier (contains hyphen)', () => {
    expect(StepIdSchema.safeParse({ step: 'error-handler' }).success).toBe(false);
  });

  it('rejects reserved word CONTINUE as step name', () => {
    expect(StepIdSchema.safeParse({ step: 'CONTINUE' }).success).toBe(false);
  });

  it('rejects reserved word COMPLETE as step name', () => {
    expect(StepIdSchema.safeParse({ step: 'COMPLETE' }).success).toBe(false);
  });

  it('rejects reserved word STOP as step name', () => {
    expect(StepIdSchema.safeParse({ step: 'STOP' }).success).toBe(false);
  });

  it('rejects reserved word GOTO as step name', () => {
    expect(StepIdSchema.safeParse({ step: 'GOTO' }).success).toBe(false);
  });

  it('rejects reserved word PASS as step name', () => {
    expect(StepIdSchema.safeParse({ step: 'PASS' }).success).toBe(false);
  });

  it('rejects reserved word FAIL as step name', () => {
    expect(StepIdSchema.safeParse({ step: 'FAIL' }).success).toBe(false);
  });
});

describe('unified naming schemas', () => {
  it('StepIdSchema accepts string step names', () => {
    const result = StepIdSchema.safeParse({ step: '1' });
    expect(result.success).toBe(true);
    expect(result.data?.step).toBe('1');
  });

  it('StepIdSchema accepts named step identifiers', () => {
    const result = StepIdSchema.safeParse({ step: 'ErrorHandler' });
    expect(result.success).toBe(true);
  });

  it('StepIdSchema accepts NEXT as special target', () => {
    const result = StepIdSchema.safeParse({ step: 'NEXT' });
    expect(result.success).toBe(true);
  });

  it('StepNameSchema rejects reserved words as step names', () => {
    const result = StepIdSchema.safeParse({ step: 'CONTINUE' });
    expect(result.success).toBe(false);
  });

  it('StepNameSchema accepts numeric strings', () => {
    const result = StepIdSchema.safeParse({ step: '1' });
    expect(result.success).toBe(true);
  });

  it('StepNameSchema accepts identifiers', () => {
    const result = StepIdSchema.safeParse({ step: 'ErrorHandler' });
    expect(result.success).toBe(true);
  });
});

describe('ForClauseSchema', () => {
  it('validates basic numeric range', () => {
    expect(ForClauseSchema.safeParse({ start: 1, end: 10 }).success).toBe(true);
  });

  it('validates range with variable name', () => {
    expect(ForClauseSchema.safeParse({ variable: 'batch', start: 1, end: 10 }).success).toBe(true);
  });

  it('rejects template variable end', () => {
    expect(
      ForClauseSchema.safeParse({ variable: 'item', start: 1, end: '{{MaxItems}}' }).success,
    ).toBe(false);
  });

  it('rejects template variable start', () => {
    expect(ForClauseSchema.safeParse({ start: '{{StartIdx}}', end: 10 }).success).toBe(false);
  });

  it('rejects both template variables', () => {
    expect(ForClauseSchema.safeParse({ start: '{{Start}}', end: '{{End}}' }).success).toBe(false);
  });

  it('rejects zero as start', () => {
    expect(ForClauseSchema.safeParse({ start: 0, end: 10 }).success).toBe(false);
  });

  it('rejects negative start', () => {
    expect(ForClauseSchema.safeParse({ start: -1, end: 10 }).success).toBe(false);
  });

  it('rejects negative end', () => {
    expect(ForClauseSchema.safeParse({ start: 1, end: -5 }).success).toBe(false);
  });

  it('rejects zero as end', () => {
    expect(ForClauseSchema.safeParse({ start: 1, end: 0 }).success).toBe(false);
  });

  it('rejects invalid variable name (starts with digit)', () => {
    expect(ForClauseSchema.safeParse({ variable: '1batch', start: 1, end: 10 }).success).toBe(
      false,
    );
  });

  it('rejects invalid variable name (contains hyphen)', () => {
    expect(ForClauseSchema.safeParse({ variable: 'my-var', start: 1, end: 10 }).success).toBe(
      false,
    );
  });

  it('rejects invalid template variable format', () => {
    expect(ForClauseSchema.safeParse({ start: 1, end: '{MaxItems}' }).success).toBe(false);
  });

  it('rejects string that is not a template variable', () => {
    expect(ForClauseSchema.safeParse({ start: 1, end: 'notavar' }).success).toBe(false);
  });

  it('accepts reversed range (start > end)', () => {
    expect(ForClauseSchema.safeParse({ start: 10, end: 5 }).success).toBe(true);
  });

  it('allows start equal to end (single iteration)', () => {
    expect(ForClauseSchema.safeParse({ start: 5, end: 5 }).success).toBe(true);
  });
});

describe('SourceWindow validation', () => {
  it('validates source window without end bound', () => {
    const result = ForClauseSchema.safeParse({
      variable: 'item',
      start: 1,
      source: 'items',
    });
    expect(result.success).toBe(true);
  });

  it('validates source window with end bound', () => {
    const result = ForClauseSchema.safeParse({
      variable: 'item',
      start: 1,
      end: 10,
      source: 'items',
    });
    expect(result.success).toBe(true);
  });

  it('requires variable for source window', () => {
    const result = ForClauseSchema.safeParse({
      start: 1,
      source: 'items',
    });
    expect(result.success).toBe(false);
  });

  it('requires source name to be non-empty', () => {
    const result = ForClauseSchema.safeParse({
      variable: 'item',
      start: 1,
      source: '',
    });
    expect(result.success).toBe(false);
  });

  it('validates source window with underscores in source name', () => {
    const result = ForClauseSchema.safeParse({
      variable: 'item',
      start: 1,
      source: 'my_items_2',
    });
    expect(result.success).toBe(true);
  });

  it('rejects source window with hyphens in source name', () => {
    const result = ForClauseSchema.safeParse({
      variable: 'item',
      start: 1,
      source: 'my-items',
    });
    expect(result.success).toBe(false);
  });

  it('allows end to be optional for source window', () => {
    const result = ForClauseSchema.safeParse({
      variable: 'server',
      start: 1,
      source: 'servers',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('end' in result.data ? result.data.end : undefined).toBeUndefined();
    }
  });
});

describe('ActionSchema with NEXT and BREAK', () => {
  it('validates NEXT action', () => {
    expect(ActionSchema.safeParse({ type: 'NEXT' }).success).toBe(true);
  });

  it('validates BREAK action', () => {
    expect(ActionSchema.safeParse({ type: 'BREAK' }).success).toBe(true);
  });

  it('still validates CONTINUE action', () => {
    expect(ActionSchema.safeParse({ type: 'CONTINUE' }).success).toBe(true);
  });

  it('still validates COMPLETE action', () => {
    expect(ActionSchema.safeParse({ type: 'COMPLETE' }).success).toBe(true);
  });

  it('still validates STOP action', () => {
    expect(ActionSchema.safeParse({ type: 'STOP' }).success).toBe(true);
  });

  it('still validates GOTO action', () => {
    expect(ActionSchema.safeParse({ type: 'GOTO', target: { step: '1' } }).success).toBe(true);
  });

  it('rejects unknown action type', () => {
    expect(ActionSchema.safeParse({ type: 'INVALID' }).success).toBe(false);
  });
});

describe('StepIdSchema with AT field', () => {
  it('accepts step with numeric AT', () => {
    expect(StepIdSchema.safeParse({ step: '3', at: 1 }).success).toBe(true);
  });

  it('accepts step with template variable AT', () => {
    expect(StepIdSchema.safeParse({ step: '3', at: '{{Index}}' }).success).toBe(true);
  });

  it('accepts step with substep and AT', () => {
    expect(StepIdSchema.safeParse({ step: '3', substep: '1', at: 1 }).success).toBe(true);
  });

  it('accepts step without AT (backward compat)', () => {
    expect(StepIdSchema.safeParse({ step: '3' }).success).toBe(true);
  });

  it('rejects AT with zero', () => {
    expect(StepIdSchema.safeParse({ step: '3', at: 0 }).success).toBe(false);
  });

  it('rejects AT with negative number', () => {
    expect(StepIdSchema.safeParse({ step: '3', at: -1 }).success).toBe(false);
  });

  it('rejects AT with invalid template format', () => {
    expect(StepIdSchema.safeParse({ step: '3', at: '{Index}' }).success).toBe(false);
  });

  it('accepts AT with whitespace in template variable', () => {
    expect(StepIdSchema.safeParse({ step: '3', at: '{{ Index }}' }).success).toBe(true);
  });

  it('accepts AT with leading whitespace only', () => {
    expect(StepIdSchema.safeParse({ step: '3', at: '{{ Index}}' }).success).toBe(true);
  });

  it('accepts AT with trailing whitespace only', () => {
    expect(StepIdSchema.safeParse({ step: '3', at: '{{Index }}' }).success).toBe(true);
  });
});

describe('E5: RunbookSchema with metadata fields', () => {
  const defaultTransitions = {
    pass: { kind: 'pass', action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', action: { type: 'STOP' } },
  };

  it('validates runbook with all metadata fields', () => {
    const result = RunbookSchema.safeParse({
      title: 'My Runbook',
      description: 'A test runbook',
      name: 'my-runbook',
      version: '1.0.0',
      author: 'Test Author',
      tags: ['test', 'automation'],
      steps: [{ kind: 'base', name: '1', description: 'Step 1', transitions: defaultTransitions }],
    });
    expect(result.success).toBe(true);
  });

  it('validates runbook with only steps (all metadata optional)', () => {
    const result = RunbookSchema.safeParse({
      steps: [{ kind: 'base', name: '1', description: 'Step 1', transitions: defaultTransitions }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-string tags', () => {
    const result = RunbookSchema.safeParse({
      steps: [{ kind: 'base', name: '1', description: 'Step 1', transitions: defaultTransitions }],
      tags: [123, true],
    });
    expect(result.success).toBe(false);
  });

  it('validates runbook with empty tags array', () => {
    const result = RunbookSchema.safeParse({
      steps: [{ kind: 'base', name: '1', description: 'Step 1', transitions: defaultTransitions }],
      tags: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('BoundRefSchema', () => {
  it('accepts valid identifier ref', () => {
    expect(BoundRefSchema.safeParse({ ref: 'Max' }).success).toBe(true);
  });

  it('accepts ref with underscore', () => {
    expect(BoundRefSchema.safeParse({ ref: 'max_items' }).success).toBe(true);
  });

  it('rejects ref starting with digit', () => {
    expect(BoundRefSchema.safeParse({ ref: '1abc' }).success).toBe(false);
  });

  it('rejects ref with hyphen', () => {
    expect(BoundRefSchema.safeParse({ ref: 'max-items' }).success).toBe(false);
  });

  it('rejects empty ref', () => {
    expect(BoundRefSchema.safeParse({ ref: '' }).success).toBe(false);
  });
});

describe('BoundSchema', () => {
  it('accepts positive integer', () => {
    expect(BoundSchema.safeParse(5).success).toBe(true);
  });

  it('accepts BoundRef', () => {
    expect(BoundSchema.safeParse({ ref: 'Max' }).success).toBe(true);
  });

  it('rejects zero', () => {
    expect(BoundSchema.safeParse(0).success).toBe(false);
  });

  it('rejects negative number', () => {
    expect(BoundSchema.safeParse(-1).success).toBe(false);
  });

  it('rejects string that is not BoundRef', () => {
    expect(BoundSchema.safeParse('Max').success).toBe(false);
  });
});

describe('UnresolvedNumericWindowSchema', () => {
  it('validates with both bounds as refs', () => {
    const result = UnresolvedNumericWindowSchema.safeParse({
      unresolved: true,
      variable: 'item',
      start: { ref: 'Start' },
      end: { ref: 'End' },
    });
    expect(result.success).toBe(true);
  });

  it('validates with mixed bounds (number start, ref end)', () => {
    const result = UnresolvedNumericWindowSchema.safeParse({
      unresolved: true,
      start: 1,
      end: { ref: 'Max' },
    });
    expect(result.success).toBe(true);
  });

  it('validates without variable', () => {
    const result = UnresolvedNumericWindowSchema.safeParse({
      unresolved: true,
      start: 1,
      end: { ref: 'Max' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects without unresolved flag', () => {
    const result = UnresolvedNumericWindowSchema.safeParse({
      start: 1,
      end: { ref: 'Max' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects with source field set', () => {
    const result = UnresolvedNumericWindowSchema.safeParse({
      unresolved: true,
      start: 1,
      end: { ref: 'Max' },
      source: 'items',
    });
    expect(result.success).toBe(false);
  });
});

describe('UnresolvedSourceWindowSchema', () => {
  it('validates with ref end and source', () => {
    const result = UnresolvedSourceWindowSchema.safeParse({
      unresolved: true,
      variable: 'item',
      start: 1,
      end: { ref: 'Max' },
      source: 'items',
    });
    expect(result.success).toBe(true);
  });

  it('validates with both bounds as refs and source', () => {
    const result = UnresolvedSourceWindowSchema.safeParse({
      unresolved: true,
      variable: 'item',
      start: { ref: 'Start' },
      end: { ref: 'End' },
      source: 'items',
    });
    expect(result.success).toBe(true);
  });

  it('requires variable', () => {
    const result = UnresolvedSourceWindowSchema.safeParse({
      unresolved: true,
      start: 1,
      end: { ref: 'Max' },
      source: 'items',
    });
    expect(result.success).toBe(false);
  });

  it('requires source', () => {
    const result = UnresolvedSourceWindowSchema.safeParse({
      unresolved: true,
      variable: 'item',
      start: 1,
      end: { ref: 'Max' },
    });
    expect(result.success).toBe(false);
  });
});

describe('ParsedForClauseSchema', () => {
  it('accepts resolved numeric clause', () => {
    expect(ParsedForClauseSchema.safeParse({ start: 1, end: 10 }).success).toBe(true);
  });

  it('accepts resolved source clause', () => {
    expect(
      ParsedForClauseSchema.safeParse({ variable: 'item', start: 1, source: 'items' }).success,
    ).toBe(true);
  });

  it('accepts unresolved numeric clause', () => {
    expect(
      ParsedForClauseSchema.safeParse({ unresolved: true, start: 1, end: { ref: 'Max' } }).success,
    ).toBe(true);
  });

  it('accepts unresolved source clause', () => {
    expect(
      ParsedForClauseSchema.safeParse({
        unresolved: true,
        variable: 'item',
        start: 1,
        end: { ref: 'Max' },
        source: 'items',
      }).success,
    ).toBe(true);
  });

  it('rejects invalid unresolved (missing unresolved flag with ref bound)', () => {
    // Without unresolved: true, BoundRef in end doesn't match ForClauseSchema
    expect(ParsedForClauseSchema.safeParse({ start: 1, end: { ref: 'Max' } }).success).toBe(false);
  });
});

describe('AggregationSchema', () => {
  it('validates ALL strategy', () => {
    const result = AggregationSchema.safeParse({ strategy: 'ALL' });
    expect(result.success).toBe(true);
  });

  it('validates ANY strategy', () => {
    const result = AggregationSchema.safeParse({ strategy: 'ANY' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid strategy', () => {
    const result = AggregationSchema.safeParse({ strategy: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects missing strategy', () => {
    const result = AggregationSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('aggregation scoped to parent steps only', () => {
  const defaultTransitions = {
    pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
  };

  it('strips aggregation from BaseStepSchema (not a recognized field)', () => {
    const result = BaseStepSchema.safeParse({
      kind: 'base',
      name: '1',
      description: 'Step 1',
      transitions: defaultTransitions,
      aggregation: { strategy: 'ALL' },
    });
    expect(result.success).toBe(true);
    // aggregation is stripped because it is not defined on BaseStepSchema
    expect(result.data).not.toHaveProperty('aggregation');
  });

  it('strips aggregation from StepWithCommandSchema (not a recognized field)', () => {
    const result = StepWithCommandSchema.safeParse({
      kind: 'command',
      name: '1',
      description: 'Step 1',
      transitions: defaultTransitions,
      command: { code: 'echo hello' },
      aggregation: { strategy: 'ALL' },
    });
    expect(result.success).toBe(true);
    // aggregation is stripped because it is not defined on StepWithCommandSchema
    expect(result.data).not.toHaveProperty('aggregation');
  });

  it('accepts aggregation on StepWithSubstepsSchema', () => {
    const result = StepWithSubstepsSchema.safeParse({
      kind: 'substeps',
      name: '1',
      description: 'Step 1',
      transitions: defaultTransitions,
      aggregation: { strategy: 'ALL' },
      substeps: [{ id: '1', description: 'sub', transitions: defaultTransitions }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts aggregation on StepWithForSchema', () => {
    const result = StepWithForSchema.safeParse({
      kind: 'for',
      name: '1',
      description: 'Step 1',
      transitions: defaultTransitions,
      aggregation: { strategy: 'ANY' },
      forClause: { start: 1, end: 3 },
      substeps: [{ id: '1', description: 'sub', transitions: defaultTransitions }],
    });
    expect(result.success).toBe(true);
  });
});

// === Batch 6: schemas.ts mutation-killing tests ===

describe('TEMPLATE_VAR_PATTERN mutation killing', () => {
  it('rejects text before template variable', () => {
    expect(TEMPLATE_VAR_PATTERN.test('text{{ var }}')).toBe(false);
  });

  it('rejects text after template variable', () => {
    expect(TEMPLATE_VAR_PATTERN.test('{{ var }}text')).toBe(false);
  });

  it('accepts valid template variable', () => {
    expect(TEMPLATE_VAR_PATTERN.test('{{ myVar }}')).toBe(true);
  });

  it('accepts template variable without spaces', () => {
    expect(TEMPLATE_VAR_PATTERN.test('{{myVar}}')).toBe(true);
  });

  it('rejects empty braces', () => {
    expect(TEMPLATE_VAR_PATTERN.test('{{ }}')).toBe(false);
  });

  it('rejects single brace template', () => {
    expect(TEMPLATE_VAR_PATTERN.test('{ myVar }')).toBe(false);
  });
});

describe('CommandSchema mutation killing', () => {
  it('accepts valid command with code', () => {
    expect(CommandSchema.safeParse({ code: 'echo hello' }).success).toBe(true);
  });

  it('rejects command without code', () => {
    expect(CommandSchema.safeParse({}).success).toBe(false);
  });

  it('accepts command with lang', () => {
    expect(CommandSchema.safeParse({ code: 'echo hi', lang: 'bash' }).success).toBe(true);
  });

  it('rejects non-string code', () => {
    expect(CommandSchema.safeParse({ code: 123 }).success).toBe(false);
  });
});

describe('StepNameSchema mutation killing', () => {
  it('rejects step name "0"', () => {
    expect(StepNameSchema.safeParse('0').success).toBe(false);
  });

  it('accepts MAX_STEP_NUMBER', () => {
    expect(StepNameSchema.safeParse(String(MAX_STEP_NUMBER)).success).toBe(true);
  });

  it('rejects MAX_STEP_NUMBER + 1', () => {
    expect(StepNameSchema.safeParse(String(MAX_STEP_NUMBER + 1)).success).toBe(false);
  });

  it('accepts positive integer "1"', () => {
    expect(StepNameSchema.safeParse('1').success).toBe(true);
  });

  it('accepts valid identifier', () => {
    expect(StepNameSchema.safeParse('ErrorHandler').success).toBe(true);
  });

  it('rejects reserved word CONTINUE', () => {
    expect(StepNameSchema.safeParse('CONTINUE').success).toBe(false);
  });

  it('rejects reserved word STOP', () => {
    expect(StepNameSchema.safeParse('STOP').success).toBe(false);
  });

  it('rejects invalid identifier with hyphen', () => {
    expect(StepNameSchema.safeParse('error-handler').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(StepNameSchema.safeParse('').success).toBe(false);
  });

  it('provides correct error message', () => {
    const result = StepNameSchema.safeParse('CONTINUE');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Step name must be a positive integer or valid identifier',
      );
    }
  });
});

describe('StepIdSchema NEXT validation mutation killing', () => {
  it('rejects NEXT with substep', () => {
    expect(StepIdSchema.safeParse({ step: 'NEXT', substep: '1' }).success).toBe(false);
  });

  it('rejects NEXT with qualifier and substep', () => {
    expect(
      StepIdSchema.safeParse({
        step: 'NEXT',
        qualifier: { step: 'Cleanup' },
        substep: '1',
      }).success,
    ).toBe(false);
  });

  it('accepts NEXT without substep', () => {
    expect(StepIdSchema.safeParse({ step: 'NEXT' }).success).toBe(true);
  });

  it('accepts NEXT with qualifier only', () => {
    expect(
      StepIdSchema.safeParse({
        step: 'NEXT',
        qualifier: { step: 'ErrorHandler' },
      }).success,
    ).toBe(true);
  });

  it('provides correct error message for invalid NEXT', () => {
    const result = StepIdSchema.safeParse({ step: 'NEXT', substep: '1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i: { message: string }) => i.message === 'Invalid NEXT target structure',
        ),
      ).toBe(true);
    }
  });
});

describe('LoopControlActionSchema mutation killing', () => {
  it('accepts NEXT action', () => {
    expect(LoopControlActionSchema.safeParse({ type: 'NEXT' }).success).toBe(true);
  });

  it('accepts BREAK action', () => {
    expect(LoopControlActionSchema.safeParse({ type: 'BREAK' }).success).toBe(true);
  });

  it('rejects CONTINUE action', () => {
    expect(LoopControlActionSchema.safeParse({ type: 'CONTINUE' }).success).toBe(false);
  });

  it('rejects DEFER action', () => {
    expect(LoopControlActionSchema.safeParse({ type: 'DEFER' }).success).toBe(false);
  });
});

describe('ActionSchema discrimination mutation killing', () => {
  it('accepts all 7 action types', () => {
    expect(ActionSchema.safeParse({ type: 'CONTINUE' }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'DEFER' }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'COMPLETE' }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'STOP' }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'GOTO', target: { step: '1' } }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'NEXT' }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'BREAK' }).success).toBe(true);
  });

  it('rejects invalid action type', () => {
    expect(ActionSchema.safeParse({ type: 'INVALID' }).success).toBe(false);
  });

  it('rejects GOTO without target', () => {
    expect(ActionSchema.safeParse({ type: 'GOTO' }).success).toBe(false);
  });
});

describe('SubstepSchema mutation killing', () => {
  it('rejects empty prompt string', () => {
    const result = SubstepSchema.safeParse({
      id: '1',
      description: 'Test',
      transitions: {
        pass: { kind: 'pass', action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', action: { type: 'STOP' } },
      },
      prompt: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts substep without prompt', () => {
    const result = SubstepSchema.safeParse({
      id: '1',
      description: 'Test',
      transitions: {
        pass: { kind: 'pass', action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', action: { type: 'STOP' } },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('runbook-list-derived substep schema invariants', () => {
  it('rejects empty synthetic substep description', () => {
    const result = StepWithSubstepsSchema.safeParse({
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      transitions: {
        pass: { kind: 'pass', action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', action: { type: 'STOP' } },
      },
      substepsDerivedFromRunbookList: true,
      substeps: [
        {
          id: '1',
          description: '',
          runbooks: ['child.runbook.md'],
          transitions: {
            pass: { kind: 'pass', action: { type: 'DEFER' } },
            fail: { kind: 'fail', action: { type: 'DEFER' } },
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only synthetic substep description', () => {
    const result = StepWithSubstepsSchema.safeParse({
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      transitions: {
        pass: { kind: 'pass', action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', action: { type: 'STOP' } },
      },
      substepsDerivedFromRunbookList: true,
      substeps: [
        {
          id: '1',
          description: '   ',
          runbooks: ['child.runbook.md'],
          transitions: {
            pass: { kind: 'pass', action: { type: 'DEFER' } },
            fail: { kind: 'fail', action: { type: 'DEFER' } },
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('StepSchema discrimination mutation killing', () => {
  const defaultTransitions = {
    pass: { kind: 'pass', action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', action: { type: 'STOP' } },
  };

  it('accepts base step', () => {
    expect(
      StepSchema.safeParse({
        kind: 'base',
        name: '1',
        description: 'Test',
        transitions: defaultTransitions,
      }).success,
    ).toBe(true);
  });

  it('accepts command step', () => {
    expect(
      StepSchema.safeParse({
        kind: 'command',
        name: '1',
        description: 'Test',
        transitions: defaultTransitions,
        command: { code: 'echo' },
      }).success,
    ).toBe(true);
  });

  it('accepts substeps step', () => {
    expect(
      StepSchema.safeParse({
        kind: 'substeps',
        name: '1',
        description: 'Test',
        transitions: defaultTransitions,
        substeps: [{ id: '1', description: 'Sub', transitions: defaultTransitions }],
      }).success,
    ).toBe(true);
  });

  it('accepts for step', () => {
    expect(
      StepSchema.safeParse({
        kind: 'for',
        name: '1',
        description: 'Test',
        transitions: defaultTransitions,
        forClause: { start: 1, end: 3 },
        substeps: [{ id: '1', description: 'Sub', transitions: defaultTransitions }],
      }).success,
    ).toBe(true);
  });

  it('rejects unknown kind', () => {
    expect(
      StepSchema.safeParse({
        kind: 'unknown',
        name: '1',
        description: 'Test',
        transitions: defaultTransitions,
      }).success,
    ).toBe(false);
  });
});

import { TEMPLATE_PATH_PATTERN, TEMPLATE_VAR_PATH_PATTERN } from '../src/index.js';

describe('template path schema compatibility', () => {
  it('keeps TEMPLATE_VAR_PATH_PATTERN as the parser-owned path grammar alias', () => {
    expect(TEMPLATE_VAR_PATH_PATTERN).toBe(TEMPLATE_PATH_PATTERN);
  });
});
