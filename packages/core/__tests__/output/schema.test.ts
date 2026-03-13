import { describe, it, expect } from '@jest/globals';
import {
  isActionResponse,
  isCheckResponse,
  isResolveResponse,
  isErrorResponse,
} from '../../src/output/schema.js';
import {
  ResolveSourceInfoSchema,
  CheckResponseSchema,
  ResolveResponseSchema,
} from '../../src/output/zod-schemas.js';
import type {
  ActionResponse,
  ErrorResponse,
  StashResponse,
  PopResponse,
  CLIResponse,
} from '../../src/output/schema.js';

describe('isActionResponse type guard', () => {
  describe('correctly identifies ActionResponse', () => {
    it('returns true for ActionResponse with pass action', () => {
      const response: ActionResponse = {
        action: 'CONTINUE',
        command: 'pass',
        from: '1',
        at: '2',
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with fail action', () => {
      const response: ActionResponse = {
        action: 'RETRY',
        command: 'fail',
        from: '1',
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with complete', () => {
      const response: ActionResponse = {
        action: 'COMPLETE',
        complete: true,
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with stopped', () => {
      const response: ActionResponse = {
        action: 'STOP',
        stopped: true,
      };

      expect(isActionResponse(response)).toBe(true);
    });
  });

  describe('correctly rejects StashResponse and PopResponse', () => {
    it('returns false for StashResponse', () => {
      const response: StashResponse = {
        action: 'stash',
        stashedId: 'abc-123',
        runbook: { file: 'test.md', state: 'test-state.json' },
      };

      // StashResponse has stashedId which is not present in ActionResponse
      // The type guard should distinguish these
      expect(isActionResponse(response as CLIResponse)).toBe(false);
    });

    it('returns false for PopResponse', () => {
      const response: PopResponse = {
        action: 'pop',
        restoredId: 'abc-123',
        runbook: { file: 'test.md', state: 'test-state.json' },
      };

      // PopResponse has restoredId which is not present in ActionResponse
      // The type guard should distinguish these
      expect(isActionResponse(response as CLIResponse)).toBe(false);
    });
  });
});

describe('isErrorResponse type guard', () => {
  it('returns true for ErrorResponse payloads without result', () => {
    const response: ErrorResponse = {
      error: 'No stashed runbook to restore',
      code: 'NO_STASHED_RUNBOOK',
    };

    expect(isErrorResponse(response)).toBe(true);
  });

  it('returns false for action payloads', () => {
    const response: ActionResponse = {
      action: 'CONTINUE',
      command: 'pass',
    };

    expect(isErrorResponse(response as CLIResponse)).toBe(false);
  });
});

describe('Check/Resolve type discriminator', () => {
  it('CheckResponseSchema requires type: "check"', () => {
    const valid = CheckResponseSchema.safeParse({
      type: 'check',
      valid: true,
      errors: [],
      stats: { steps: 1, substeps: 0 },
    });
    expect(valid.success).toBe(true);

    const missingType = CheckResponseSchema.safeParse({
      valid: true,
      errors: [],
    });
    expect(missingType.success).toBe(false);

    const wrongType = CheckResponseSchema.safeParse({
      type: 'resolve',
      valid: true,
      errors: [],
    });
    expect(wrongType.success).toBe(false);
  });

  it('ResolveResponseSchema requires type: "resolve"', () => {
    const valid = ResolveResponseSchema.safeParse({
      type: 'resolve',
      valid: true,
      errors: [],
      stats: { steps: 1, substeps: 0 },
      variables: { Date: '2026-01-01' },
    });
    expect(valid.success).toBe(true);

    const missingType = ResolveResponseSchema.safeParse({
      valid: true,
      errors: [],
    });
    expect(missingType.success).toBe(false);

    const wrongType = ResolveResponseSchema.safeParse({
      type: 'check',
      valid: true,
      errors: [],
    });
    expect(wrongType.success).toBe(false);
  });

  it('isCheckResponse discriminates on type field', () => {
    const checkResp = { type: 'check', valid: true, errors: [] };
    const resolveResp = { type: 'resolve', valid: true, errors: [] };
    const noType = { valid: true, errors: [] };

    expect(isCheckResponse(checkResp)).toBe(true);
    expect(isCheckResponse(resolveResp)).toBe(false);
    expect(isCheckResponse(noType)).toBe(false);
  });

  it('isResolveResponse discriminates on type field', () => {
    const resolveResp = { type: 'resolve', valid: true, errors: [] };
    const checkResp = { type: 'check', valid: true, errors: [] };
    const noType = { valid: true, errors: [] };

    expect(isResolveResponse(resolveResp)).toBe(true);
    expect(isResolveResponse(checkResp)).toBe(false);
    expect(isResolveResponse(noType)).toBe(false);
  });
});

describe('ResolveSourceInfoSchema discriminated union', () => {
  it('accepts valid array source', () => {
    const result = ResolveSourceInfoSchema.safeParse({ kind: 'array', items: 3 });
    expect(result.success).toBe(true);
  });

  it('accepts valid file source', () => {
    const result = ResolveSourceInfoSchema.safeParse({
      kind: 'file',
      path: 'data.txt',
      format: 'text',
    });
    expect(result.success).toBe(true);
  });

  it('rejects array source with file-only fields', () => {
    const result = ResolveSourceInfoSchema.safeParse({ kind: 'array', path: '/foo' });
    expect(result.success).toBe(false);
  });

  it('rejects file source missing required fields', () => {
    const result = ResolveSourceInfoSchema.safeParse({ kind: 'file' });
    expect(result.success).toBe(false);
  });
});
