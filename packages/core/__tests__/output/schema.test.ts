import { describe, it, expect } from '@jest/globals';
import { ErrorCodes } from '../../src/errors/codes.js';
import {
  isActionResponse,
  isCheckResponse,
  isResolveResponse,
  isErrorResponse,
  isWarningResponse,
} from '../../src/output/schema.js';
import {
  ActiveRunbookEntrySchema,
  ArtifactAssertionInputSchema,
  ResolveSourceInfoSchema,
  CheckResponseSchema,
  ResolveResponseSchema,
  ScenarioRunResponseSchema,
  ErrorDetailsSchema,
  ErrorResponseSchema,
  CLIErrorCodes,
  CLISymbolicErrorCodeValues,
  CLIWarningCodes,
  ErrorCodeSchema,
  RundownErrorCodeValues,
  WarningCodeSchema,
  WarningResponseSchema,
} from '../../src/output/zod-schemas.js';
import type {
  ActionResponse,
  ErrorResponse,
  WarningResponse,
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

describe('ErrorCodeSchema code registry', () => {
  it('accepts every registered CLI error code', () => {
    for (const code of Object.values(CLIErrorCodes)) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it.each(['TOKEN_REQUIRED', 'UNKNOWN_TOKEN', 'RUNBOOK_COMPOSITION_UNSUPPORTED'] as const)(
    'registers the one-writer refusal code %s (ADR 0005)',
    (code) => {
      // The three refusals the Owner Token model adds: a bare mutation, a token
      // no run carries, and a runbook that composes other runbooks before #903
      // and #904 restore composition. Each is a registered symbolic code so a
      // consumer validating against the published schema accepts the envelope.
      expect(CLIErrorCodes[code]).toBe(code);
      expect(CLISymbolicErrorCodeValues).toContain(code);
      expect(
        ErrorResponseSchema.safeParse({
          kind: 'error',
          error: `refused with ${code}`,
          code,
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    'ALREADY_STASHED',
    'NO_STASHED_RUNBOOK',
    'STALE_CLAIM',
    'ACTOR_CONTEXT_REQUIRED',
    'CLAIM_GRANT_REQUIRED',
    'CLAIM_BEARER_MISMATCH',
    // EXECUTION_IN_PROGRESS is not here: the one-writer execution lease (#902)
    // brought it back, registered beside EXECUTION_INTERRUPTED.
    'RECOVERY_REQUIRED',
    'AGGREGATE_RECOVERY_REQUIRED',
    'OPEN_DELEGATED_CHILDREN',
    'DELEGATION_COLLECTION_PENDING',
    'INVALID_TOKEN',
    'TOKEN_NOT_FOUND',
  ])('no longer registers the multi-writer code %s', (code) => {
    // Retired with the machinery that emitted them (ADR 0005). A code that is
    // not registered cannot be documented either, which is what the docs
    // drift guard enforces from the other side.
    expect(CLISymbolicErrorCodeValues).not.toContain(code);
    expect(ErrorCodeSchema.safeParse(code).success).toBe(false);
  });

  it.each(CLISymbolicErrorCodeValues)('parses the registered symbolic code %s', (code) => {
    // `ErrorCodeSchema` is built from this list, so a member that fails to parse
    // means the enum construction dropped it. Registration is what makes a code
    // usable in a published-schema-validating consumer; the docs drift guard is
    // one-way (documented ⊆ registered) and cannot see an unregistered code at
    // all, which is exactly how `STALE_CLAIM` stayed missing.
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  it.each(['CONCURRENT_MODIFICATION', 'RUN_TARGET_UNAVAILABLE'] as const)(
    'accepts the surviving refusal code %s',
    (code) => {
      // `CONCURRENT_MODIFICATION` is the one conditional-write refusal left
      // under one writer per run; `RUN_TARGET_UNAVAILABLE` is what a read-only
      // `--run` that names no run reports.
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(
        ErrorResponseSchema.safeParse({
          kind: 'error',
          error: `refused with ${code}`,
          code,
        }).success,
      ).toBe(true);
    },
  );

  it('registers OBSERVATION_DELIVERY_FAILED in the symbolic registry (#853)', () => {
    // The observation commit gate's own envelope code. The `it.each` above
    // sweeps the whole list, so a code REMOVED from the registry would make
    // that sweep quietly shorter rather than fail — this names it.
    expect(CLISymbolicErrorCodeValues).toContain('OBSERVATION_DELIVERY_FAILED');
    expect(ErrorCodeSchema.safeParse('OBSERVATION_DELIVERY_FAILED').success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: 'the reporting channel is broken',
        code: 'OBSERVATION_DELIVERY_FAILED',
      }).success,
    ).toBe(true);
  });

  it('registers CONCURRENT_STATE_MODIFICATION (RD-308) in the Rundown registry (#777)', () => {
    // RD-308 is a RUNDOWN code, not a symbolic one, so it belongs to the other
    // half of `ErrorCodeSchema`'s enum. A spent run-start CAS budget now
    // surfaces under it through the launch pipeline, so a consumer validating
    // against the published schema must accept an envelope carrying it.
    const code = ErrorCodes.CONCURRENT_STATE_MODIFICATION.code;
    expect(RundownErrorCodeValues).toContain(code);
    expect(CLISymbolicErrorCodeValues).not.toContain(code);
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: 'Run rd_9e725b142d81dabcefb9e04919568fcd changed while latching inline launch',
        code,
      }).success,
    ).toBe(true);
  });
});

describe('ErrorDetailsSchema aggregate recovery payload (#608)', () => {
  it('declares `runs` as run-id/epoch pairs rather than leaving it to .loose()', () => {
    const parsed = ErrorDetailsSchema.safeParse({
      runs: [
        { runId: 'rd_9e725b142d81dabcefb9e04919568fcd', epoch: 4 },
        { runId: 'rd_3f0c1a7b28d94ef5a6b0c9d3e81f2a47', epoch: 1 },
      ],
    });

    expect(parsed.success).toBe(true);
    // Declared, not merely tolerated: a loose passthrough would preserve the
    // value without validating it, which is what the undeclared field did.
    expect(parsed.data?.runs).toEqual([
      { runId: 'rd_9e725b142d81dabcefb9e04919568fcd', epoch: 4 },
      { runId: 'rd_3f0c1a7b28d94ef5a6b0c9d3e81f2a47', epoch: 1 },
    ]);
  });

  it('rejects a runs entry with a non-numeric epoch', () => {
    expect(ErrorDetailsSchema.safeParse({ runs: [{ runId: 'rd_x', epoch: 'four' }] }).success).toBe(
      false,
    );
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

  it('accepts the already-terminal RUNBOOK_NOT_RUNNING warning code', () => {
    expect(WarningCodeSchema.safeParse('RUNBOOK_NOT_RUNNING').success).toBe(true);
    expect(
      WarningResponseSchema.safeParse({
        kind: 'warning',
        message: 'No active runbook',
        command: 'complete',
        code: 'RUNBOOK_NOT_RUNNING',
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

  it('accepts every code declared in the CLIWarningCodes single source', () => {
    // The schema enum is derived from CLIWarningCodes; assert the invariant so a
    // code added to the const but not the schema (or vice versa) fails here.
    for (const code of Object.values(CLIWarningCodes)) {
      expect(WarningCodeSchema.safeParse(code).success).toBe(true);
    }
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
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_11111111111111111111111111111111/plan.json',
      path: '/tmp/project/.rundown/work/.rd-ctx1/rd_11111111111111111111111111111111/plan.json',
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

  it('accepts warning assertion results and unasserted warnings', () => {
    const parsed = ScenarioRunResponseSchema.parse({
      kind: 'scenario_run',
      result: false,
      scenario: 'warning-contract',
      expected: 'UNKNOWN',
      actual: 'UNKNOWN',
      warningAssertions: [
        {
          assertion: { code: 'NO_ACTIVE_RUNBOOK', command: 'pass', message: 'No active runbook' },
          matched: true,
          matchedWarning: {
            code: 'NO_ACTIVE_RUNBOOK',
            command: 'pass',
            message: 'No active runbook',
          },
        },
      ],
      unassertedWarnings: [
        { code: 'NO_ACTIVE_RUNBOOK', command: 'fail', message: 'No active runbook' },
      ],
    });

    expect(parsed.warningAssertions?.[0]?.matchedWarning?.command).toBe('pass');
    expect(parsed.unassertedWarnings?.[0]?.command).toBe('fail');
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

describe('ActiveRunbookEntrySchema id contract', () => {
  // `ls` and `prune` both emit `id` from run state whose ids reach the model
  // through `assertRunId` / `RunIdSchema`, so every real value is a run id.
  it('accepts a real-shaped run id', () => {
    const result = ActiveRunbookEntrySchema.safeParse({
      id: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      runbook: 'deploy.runbook.md',
      status: 'active',
      step: '1',
      total: 3,
      title: 'Deploy to Production',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an id that is not a run id', () => {
    // Same complete entry as the accepted case, differing only in `id`, so the
    // refusal can only be the run-id check and not a missing sibling field.
    const result = ActiveRunbookEntrySchema.safeParse({
      id: 'abc12345',
      runbook: 'deploy.runbook.md',
      status: 'active',
      step: '1',
      total: 3,
      title: 'Deploy to Production',
    });
    expect(result.success).toBe(false);
  });
});
