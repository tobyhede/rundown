import { describe, it, expect } from '@jest/globals';
import { TransitionsSchema, TransitionObjectSchema, StepIdSchema } from '../src/schemas.js';

describe('TransitionsSchema with kind', () => {
  it('should validate transitions with kind', () => {
    const input = {
      all: true,
      pass: { kind: 'yes', action: { type: 'CONTINUE' } },
      fail: { kind: 'no', action: { type: 'STOP' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject invalid kind', () => {
    const input = {
      all: true,
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
  it('should validate all: true transitions', () => {
    const input = {
      all: true,
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', action: { type: 'STOP' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should validate all: false transitions', () => {
    const input = {
      all: false,
      pass: { kind: 'yes', action: { type: 'COMPLETE' } },
      fail: { kind: 'no', action: { type: 'CONTINUE' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject transitions without all field', () => {
    const input = {
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', action: { type: 'STOP' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject transitions without pass field', () => {
    const input = {
      all: true,
      fail: { kind: 'fail', action: { type: 'STOP' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject transitions without fail field', () => {
    const input = {
      all: true,
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
    };
    const result = TransitionsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('StepIdSchema with named steps', () => {
  it('accepts numeric step', () => {
    expect(StepIdSchema.safeParse({ step: '1' }).success).toBe(true);
  });

  it('accepts {N} dynamic step', () => {
    expect(StepIdSchema.safeParse({ step: '{N}' }).success).toBe(true);
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

  it('StepIdSchema accepts {N} for dynamic step references', () => {
    const result = StepIdSchema.safeParse({ step: '{N}', substep: '1' });
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

  it('StepNameSchema accepts {N} for dynamic steps', () => {
    const result = StepIdSchema.safeParse({ step: '{N}' });
    expect(result.success).toBe(true);
  });
});
