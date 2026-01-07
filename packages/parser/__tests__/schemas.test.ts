import { describe, it, expect } from '@jest/globals';
import { TransitionsSchema, TransitionObjectSchema } from '../src/schemas.js';

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
      action: { type: 'GOTO', target: { step: 1 } },
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
