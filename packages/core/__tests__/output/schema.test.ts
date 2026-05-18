import { describe, it, expect } from '@jest/globals';
import {
  isActionResponse,
  isCheckResponse,
  isResolveResponse,
  isErrorResponse,
  isWarningResponse,
} from '../../src/output/schema.js';
import {
  ArtifactAssertionInputSchema,
  ResolveSourceInfoSchema,
  CheckResponseSchema,
  ResolveResponseSchema,
  ScenarioRunResponseSchema,
  WarningCodeSchema,
  WarningResponseSchema,
} from '../../src/output/zod-schemas.js';
import type {
  ActionResponse,
  ErrorResponse,
  WarningResponse,
  StashResponse,
  PopResponse,
  CLIResponse,
} from '../../src/output/schema.js';

describe('isActionResponse type guard', () => {
  describe('correctly identifies ActionResponse', () => {
    it('returns true for ActionResponse with pass action', () => {
      const response: ActionResponse = {
        kind: 'action',
        action: 'CONTINUE',
        command: 'pass',
        from: '1',
        at: '2',
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with fail action', () => {
      const response: ActionResponse = {
        kind: 'action',
        action: 'RETRY',
        command: 'fail',
        from: '1',
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with complete', () => {
      const response: ActionResponse = {
        kind: 'action',
        action: 'COMPLETE',
        complete: true,
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with stopped', () => {
      const response: ActionResponse = {
        kind: 'action',
        action: 'STOP',
        stopped: true,
      };

      expect(isActionResponse(response)).toBe(true);
    });
  });

  describe('correctly rejects StashResponse and PopResponse', () => {
    it('returns false for StashResponse', () => {
      const response: StashResponse = {
        kind: 'stash',
        action: 'stash',
        stashedId: 'abc-123',
        runbook: { file: 'test.md', state: 'test-state.json' },
      };

      // StashResponse has kind='stash', not 'action'
      expect(isActionResponse(response as CLIResponse)).toBe(false);
    });

    it('returns false for PopResponse', () => {
      const response: PopResponse = {
        kind: 'pop',
        action: 'pop',
        restoredId: 'abc-123',
        runbook: { file: 'test.md', state: 'test-state.json' },
      };

      // PopResponse has kind='pop', not 'action'
      expect(isActionResponse(response as CLIResponse)).toBe(false);
    });
  });
});

describe('isErrorResponse type guard', () => {
  it('returns true for ErrorResponse payloads without result', () => {
    const response: ErrorResponse = {
      kind: 'error',
      error: 'No stashed runbook to restore',
      code: 'NO_STASHED_RUNBOOK',
    };

    expect(isErrorResponse(response)).toBe(true);
  });

  it('returns false for action payloads', () => {
    const response: ActionResponse = {
      kind: 'action',
      action: 'CONTINUE',
      command: 'pass',
    };

    expect(isErrorResponse(response as CLIResponse)).toBe(false);
  });
});

describe('isWarningResponse type guard', () => {
  it('returns true for WarningResponse payloads', () => {
    const response: WarningResponse = {
      kind: 'warning',
      message: 'No active runbook',
      code: 'NO_ACTIVE_RUNBOOK',
      command: 'pass',
    };

    expect(isWarningResponse(response)).toBe(true);
  });

  it('returns false for error payloads', () => {
    const response: ErrorResponse = {
      kind: 'error',
      error: 'No stashed runbook to restore',
      code: 'NO_STASHED_RUNBOOK',
    };

    expect(isWarningResponse(response as CLIResponse)).toBe(false);
  });
});

describe('WarningResponseSchema code semantics', () => {
  it('accepts warning codes for warning responses', () => {
    expect(WarningCodeSchema.safeParse('NO_ACTIVE_RUNBOOK').success).toBe(true);
    expect(
      WarningResponseSchema.safeParse({
        kind: 'warning',
        message: 'No active runbook',
        code: 'NO_ACTIVE_RUNBOOK',
      }).success,
    ).toBe(true);
  });

  it('rejects error-only codes for warning responses', () => {
    expect(WarningCodeSchema.safeParse('STEP_NOT_FOUND').success).toBe(false);
    expect(
      WarningResponseSchema.safeParse({
        kind: 'warning',
        message: 'Target step does not exist',
        code: 'STEP_NOT_FOUND',
      }).success,
    ).toBe(false);
  });

  it('preserves extra fields for forward-compatible warning responses', () => {
    const parsed = WarningResponseSchema.parse({
      kind: 'warning',
      message: 'No active runbook',
      code: 'NO_ACTIVE_RUNBOOK',
      command: 'collect',
      context: { runbook: 'parent.runbook.md' },
    });

    expect(parsed).toMatchObject({
      context: { runbook: 'parent.runbook.md' },
    });
  });
});

describe('Check/Resolve kind discriminator', () => {
  it('CheckResponseSchema requires kind: "check"', () => {
    const valid = CheckResponseSchema.safeParse({
      kind: 'check',
      valid: true,
      errors: [],
      stats: { steps: 1, substeps: 0 },
    });
    expect(valid.success).toBe(true);

    const missingKind = CheckResponseSchema.safeParse({
      valid: true,
      errors: [],
    });
    expect(missingKind.success).toBe(false);

    const wrongKind = CheckResponseSchema.safeParse({
      kind: 'resolve',
      valid: true,
      errors: [],
    });
    expect(wrongKind.success).toBe(false);
  });

  it('ResolveResponseSchema requires kind: "resolve"', () => {
    const valid = ResolveResponseSchema.safeParse({
      kind: 'resolve',
      valid: true,
      errors: [],
      stats: { steps: 1, substeps: 0 },
      variables: { Date: '2026-01-01' },
    });
    expect(valid.success).toBe(true);

    const missingKind = ResolveResponseSchema.safeParse({
      valid: true,
      errors: [],
    });
    expect(missingKind.success).toBe(false);

    const wrongKind = ResolveResponseSchema.safeParse({
      kind: 'check',
      valid: true,
      errors: [],
    });
    expect(wrongKind.success).toBe(false);
  });

  it('isCheckResponse discriminates on kind field', () => {
    const checkResp = { kind: 'check', valid: true, errors: [] } as CLIResponse;
    const resolveResp = { kind: 'resolve', valid: true, errors: [] } as CLIResponse;

    expect(isCheckResponse(checkResp)).toBe(true);
    expect(isCheckResponse(resolveResp)).toBe(false);
  });

  it('isResolveResponse discriminates on kind field', () => {
    const resolveResp = { kind: 'resolve', valid: true, errors: [] } as CLIResponse;
    const checkResp = { kind: 'check', valid: true, errors: [] } as CLIResponse;

    expect(isResolveResponse(resolveResp)).toBe(true);
    expect(isResolveResponse(checkResp)).toBe(false);
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

describe('ScenarioRunResponseSchema step assertions', () => {
  it('preserves aggregated marker on assertions and matched transition events', () => {
    const parsed = ScenarioRunResponseSchema.parse({
      kind: 'scenario_run',
      result: true,
      scenario: 'aggregated-complete',
      expected: 'pass',
      actual: 'pass',
      stepAssertions: [
        {
          assertion: {
            at: '1',
            action: 'COMPLETE',
            result: 'PASS',
            aggregated: true,
          },
          matched: true,
          matchedEvent: {
            at: '1',
            action: 'COMPLETE',
            result: 'PASS',
            aggregated: true,
          },
        },
      ],
    });

    expect(parsed.stepAssertions?.[0]?.assertion).toMatchObject({ aggregated: true });
    expect(parsed.stepAssertions?.[0]?.matchedEvent).toMatchObject({ aggregated: true });
  });

  it('accepts artifact assertion results', () => {
    const artifact = {
      uri: 'rd://artifacts/ctx1/rd_11111111111111111111111111111111/plan.json',
      runId: 'rd_11111111111111111111111111111111',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: '.rundown/runbooks/artifacts.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };

    const parsed = ScenarioRunResponseSchema.parse({
      kind: 'scenario_run',
      result: true,
      scenario: 'artifact-produced',
      expected: 'COMPLETE',
      actual: 'COMPLETE',
      artifactAssertions: [
        {
          assertion: {
            at: '1',
            alias: 'PlanPath',
            key: 'plan.json',
            exists: true,
          },
          matched: true,
          matchedEntry: {
            at: '1',
            artifacts: { PlanPath: artifact },
            runbook: { source: 'project', path: '.rundown/runbooks/artifacts.runbook.md' },
          },
          matchedRecords: [artifact],
        },
      ],
    });

    expect(parsed.artifactAssertions?.[0]?.matchedRecords?.[0]?.key).toBe('plan.json');
  });
});

describe('ArtifactAssertionInputSchema normalization contract', () => {
  // This schema describes the assertion shape EMITTED by the CLI (used inside
  // ScenarioArtifactAssertionResultSchema). The CLI parser normalizes `at` to
  // string and rejects empty `alias`, so the public `--schema` contract must
  // not advertise payloads the CLI never emits.
  it('rejects a numeric `at` (normalized form is string-only)', () => {
    const result = ArtifactAssertionInputSchema.safeParse({
      at: 1,
      alias: 'Plan',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty `alias`', () => {
    const result = ArtifactAssertionInputSchema.safeParse({
      at: '1',
      alias: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts the normalized shape (string `at`, non-empty `alias`)', () => {
    const result = ArtifactAssertionInputSchema.safeParse({
      at: '1',
      alias: 'Plan',
    });
    expect(result.success).toBe(true);
  });
});
