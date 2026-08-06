import { describe, it, expect } from '@jest/globals';
import {
  isActionResponse,
  isClaimResponse,
  isCheckResponse,
  isResolveResponse,
  isErrorResponse,
  isWarningResponse,
} from '../../src/output/schema.js';
import {
  AbortResponseSchema,
  ActiveRunbookEntrySchema,
  ArtifactAssertionInputSchema,
  ResolveSourceInfoSchema,
  CheckResponseSchema,
  DelegateResponseSchema,
  ResolveResponseSchema,
  ScenarioRunResponseSchema,
  ErrorDetailsSchema,
  ErrorResponseSchema,
  CLIErrorCodes,
  CLISymbolicErrorCodeValues,
  CLIWarningCodes,
  ErrorCodeSchema,
  WarningCodeSchema,
  WarningResponseSchema,
} from '../../src/output/zod-schemas.js';
import type {
  ActionResponse,
  ClaimResponse,
  ErrorResponse,
  WarningResponse,
  StashResponse,
  PopResponse,
  CLIResponse,
} from '../../src/output/schema.js';

function makeClaimResponse(): ClaimResponse {
  return {
    kind: 'claim',
    action: 'claimed',
    token: 'rdtk_abcdef0123456789abcdef',
    claim_id: 'rdclm_F3J3n3d_f8fo0a0b1B2c3Q',
    run_id: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    runbook: 'child.runbook.md',
    parent_run_id: 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    parent_step: '1.1',
  };
}

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

  describe('correctly rejects StashResponse, PopResponse, and ClaimResponse', () => {
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

    it('returns false for ClaimResponse', () => {
      // ClaimResponse has kind='claim', not 'action' — see isClaimResponse
      expect(isActionResponse(makeClaimResponse() as CLIResponse)).toBe(false);
    });
  });
});

describe('isClaimResponse type guard', () => {
  it('returns true for ClaimResponse', () => {
    expect(isClaimResponse(makeClaimResponse() as CLIResponse)).toBe(true);
  });

  it('returns true for a ClaimResponse with parent_step omitted', () => {
    // parent_step is optional for bare-step delegations.
    const response = makeClaimResponse();
    delete (response as Record<string, unknown>).parent_step;
    expect(isClaimResponse(response as CLIResponse)).toBe(true);
  });

  it('returns false for ActionResponse (kind: "action")', () => {
    const response: ActionResponse = {
      kind: 'action',
      action: 'CONTINUE',
      command: 'pass',
      from: '1',
      at: '2',
    };
    expect(isClaimResponse(response)).toBe(false);
  });

  it('returns false for StashResponse', () => {
    const response: StashResponse = {
      kind: 'stash',
      action: 'stash',
      stashedId: 'abc-123',
      runbook: { file: 'test.md', state: 'test-state.json' },
    };
    expect(isClaimResponse(response as CLIResponse)).toBe(false);
  });

  it('returns false for PopResponse', () => {
    const response: PopResponse = {
      kind: 'pop',
      action: 'pop',
      restoredId: 'abc-123',
      runbook: { file: 'test.md', state: 'test-state.json' },
    };
    expect(isClaimResponse(response as CLIResponse)).toBe(false);
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
  it('registers RD-813 for non-delegatable delegation targets', () => {
    expect(CLIErrorCodes.DELEGATION_NO_DELEGATABLE_SUBSTEP).toBe('RD-813');
  });

  it('registers AGGREGATE_RECOVERY_REQUIRED distinctly from the single-run code (#608)', () => {
    // The multi-run refusal is not a plural spelling of the single-run one: only
    // it carries `details.runs`, so a consumer routing on `code` alone must be
    // able to tell the two envelope shapes apart.
    expect(CLIErrorCodes.AGGREGATE_RECOVERY_REQUIRED).toBe('AGGREGATE_RECOVERY_REQUIRED');
    expect(CLIErrorCodes.AGGREGATE_RECOVERY_REQUIRED).not.toBe(CLIErrorCodes.RECOVERY_REQUIRED);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: 'The aggregate execution outcome is unknown and requires recovery.',
        code: 'AGGREGATE_RECOVERY_REQUIRED',
      }).success,
    ).toBe(true);
  });

  it.each(CLISymbolicErrorCodeValues)('parses the registered symbolic code %s', (code) => {
    // `ErrorCodeSchema` is built from this list, so a member that fails to parse
    // means the enum construction dropped it. Registration is what makes a code
    // usable in a published-schema-validating consumer; the docs drift guard is
    // one-way (documented ⊆ registered) and cannot see an unregistered code at
    // all, which is exactly how `STALE_CLAIM` stayed missing.
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  it.each([
    'EXECUTION_IN_PROGRESS',
    'RECOVERY_REQUIRED',
    'STALE_CLAIM',
    'CONCURRENT_MODIFICATION',
    'RUN_TARGET_UNAVAILABLE',
    'AGGREGATE_RECOVERY_REQUIRED',
  ] as const)('accepts the transactional refusal code %s (#608)', (code) => {
    // The exact six codes `transactionalRefusalCode` maps the transactional
    // delegation refusal union onto (`packages/cli/src/helpers/
    // session-mutation-result.ts`). Every one must be a registered error code,
    // or a consumer validating against the published schema rejects an envelope
    // the CLI genuinely emits.
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: `transactional mutation refused with ${code}`,
        code,
      }).success,
    ).toBe(true);
  });

  it('registers STALE_CLAIM as its own code, distinct from the resolution-time refusals (#608)', () => {
    // `STALE_CLAIM` is the compare-and-swap loss: the bearer WAS the run's
    // controlling authority when the mutation captured it and was not at commit.
    // `DELEGATION_SUPERSEDED` / `CLAIMED_RUNBOOK_UNAVAILABLE` are the
    // target-resolution refusals raised before any mutation is attempted. Three
    // codes, three causes — collapsing them would give a retrying agent the
    // wrong remediation.
    for (const code of ['STALE_CLAIM', 'DELEGATION_SUPERSEDED', 'CLAIMED_RUNBOOK_UNAVAILABLE']) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(CLISymbolicErrorCodeValues).toContain('STALE_CLAIM');
    // Unlike `AGGREGATE_RECOVERY_REQUIRED`, the stale-claim arm carries no
    // structured details — the run id travels inside the message — so the
    // detail-free envelope is the shape consumers must accept.
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error:
          'Run rd_9e725b142d81dabcefb9e04919568fcd claim generation advanced since it was captured.',
        code: 'STALE_CLAIM',
        command: 'pass',
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

describe('AbortResponseSchema cleanup contract (#608)', () => {
  const base = {
    kind: 'abort' as const,
    action: 'abort' as const,
    status: 'cancelled' as const,
    token: 'rdtk_AAA...HHHH',
    substep: '1.1',
    runbook: 'child.runbook.md',
    parentRunId: 'rd_9e725b142d81dabcefb9e04919568fcd',
  };

  it.each(['none', 'active_child_failed', 'terminal_child_cleaned', 'missing_child_cleaned'])(
    'accepts the %s cleanup branch',
    (cleanup) => {
      expect(AbortResponseSchema.safeParse({ ...base, cleanup }).success).toBe(true);
    },
  );

  it('rejects a cleanup value core cannot produce', () => {
    expect(AbortResponseSchema.safeParse({ ...base, cleanup: 'forced' }).success).toBe(false);
  });

  // The three cross-field rules the TSDoc declares. Field types alone admit
  // every combination, so without these the schema would accept envelopes the
  // renderer never emits — and a consumer generating a client from it would
  // branch on states that cannot occur.
  it('accepts force alongside a real teardown branch', () => {
    for (const cleanup of [
      'active_child_failed',
      'terminal_child_cleaned',
      'missing_child_cleaned',
    ])
      expect(AbortResponseSchema.safeParse({ ...base, cleanup, force: true }).success).toBe(true);
  });

  it('rejects cleanup on a non-cancelled abort', () => {
    expect(
      AbortResponseSchema.safeParse({ ...base, status: 'already_cancelled', cleanup: 'none' })
        .success,
    ).toBe(false);
  });

  it('rejects force without a cleanup branch', () => {
    expect(AbortResponseSchema.safeParse({ ...base, force: true }).success).toBe(false);
  });

  it('rejects force on the no-teardown branch', () => {
    // `cleanup: 'none'` is the one branch reachable with `--force`, and it is
    // exactly where reporting `force` would claim a teardown that never ran.
    expect(AbortResponseSchema.safeParse({ ...base, cleanup: 'none', force: true }).success).toBe(
      false,
    );
  });

  it('accepts emitted RundownError RD codes in error envelopes', () => {
    for (const code of ['RD-301', 'RD-403', 'RD-501', 'RD-812', 'RD-816', 'RD-819', 'RD-999']) {
      expect(
        ErrorResponseSchema.safeParse({
          kind: 'error',
          error: 'Rundown error',
          code,
        }).success,
      ).toBe(true);
    }
  });

  it('accepts direct CLI symbolic codes and rejects dead symbolic aliases', () => {
    for (const code of [
      'INVALID_STEP',
      'INVALID_INDEX',
      'NOT_DELEGATE_STEP',
      'SUBSTEPS_NOT_RESOLVED',
      'DELEGATION_ALREADY_RESOLVED',
      'DELEGATION_ALREADY_EXISTS',
      'CONFLICTING_INDEX',
      'ENGINE_INIT_FAILED',
      'INVALID_AT_TARGET',
    ]) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }

    for (const code of ['FILE_ERROR', 'LAUNCH_FAILED', 'DELEGATION_NESTED_FORBIDDEN']) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it('accepts every registered CLI error code', () => {
    for (const code of Object.values(CLIErrorCodes)) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('accepts the OPEN_DELEGATED_CHILDREN refusal emitted by bare pass/fail', () => {
    // The CLI emits this code when a bare `rd pass`/`rd fail` is refused because
    // the active parent has open claimed delegated children. The documented
    // error schema must accept it so `--schema`-validating consumers (MCP,
    // contract tests) do not reject a response the CLI can actually produce.
    expect(ErrorCodeSchema.safeParse('OPEN_DELEGATED_CHILDREN').success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: 'Cannot run bare rd pass: active parent runbook has open delegated child claim(s).',
        code: 'OPEN_DELEGATED_CHILDREN',
      }).success,
    ).toBe(true);
    // Documented in the curated registry, like its sibling refusal codes
    // CLAIMED_RUNBOOK_UNAVAILABLE and DELEGATION_RESULT_CONFLICT.
    expect(CLIErrorCodes.OPEN_DELEGATED_CHILDREN).toBe('OPEN_DELEGATED_CHILDREN');
  });

  it('accepts DELEGATION_COLLECTION_PENDING for the future collection-pending guard', () => {
    const message =
      'A delegated claim has reported an outcome that must be collected by the orchestrator.';

    expect(ErrorCodeSchema.safeParse('DELEGATION_COLLECTION_PENDING').success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: message,
        code: 'DELEGATION_COLLECTION_PENDING',
        details: {
          suggestion:
            'If you are the delegated agent, stop here. If you are the orchestrator, run rd collect.',
        },
      }).success,
    ).toBe(true);
    expect(CLIErrorCodes.DELEGATION_COLLECTION_PENDING).toBe('DELEGATION_COLLECTION_PENDING');
  });

  it.each([
    'ACTOR_CONTEXT_REQUIRED',
    'CLAIM_GRANT_REQUIRED',
    // #613: a caller/target bearer divergence. Registered alongside its two
    // siblings because the CLI's refusal renderers emit all three the same way,
    // so a consumer validating the published schema must accept all three.
    'CLAIM_BEARER_MISMATCH',
    'RUN_TARGET_MISMATCH',
  ] as const)('accepts %s for command policy rendering', (code) => {
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: `command policy refused with ${code}`,
        code,
        details: { source: 'command-policy' },
      }).success,
    ).toBe(true);
    expect(CLIErrorCodes[code]).toBe(code);
  });

  it('accepts collection-operation output codes', () => {
    for (const code of ['COLLECT_ALREADY_APPLIED', 'COLLECT_OPERATION_FAILED'] as const) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(CLIErrorCodes[code]).toBe(code);
    }
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

describe('DelegateResponseSchema discriminated union', () => {
  const base = {
    kind: 'delegate' as const,
    step: '1.1',
    runbook: 'child.runbook.md',
    token: 'rdtk_abc',
    parent_run_id: 'run-1',
  };

  it('accepts the delegated arm with token_hash', () => {
    expect(
      DelegateResponseSchema.safeParse({ ...base, action: 'delegated', token_hash: 'h' }).success,
    ).toBe(true);
  });

  it('accepts the retried arm with token_hash', () => {
    expect(
      DelegateResponseSchema.safeParse({ ...base, action: 'retried', token_hash: 'h' }).success,
    ).toBe(true);
  });

  it('accepts the already-delegated arm without token_hash', () => {
    expect(DelegateResponseSchema.safeParse({ ...base, action: 'already-delegated' }).success).toBe(
      true,
    );
  });

  it('rejects the already-delegated arm when token_hash is present', () => {
    expect(
      DelegateResponseSchema.safeParse({ ...base, action: 'already-delegated', token_hash: 'h' })
        .success,
    ).toBe(false);
  });

  it('rejects the delegated arm when token_hash is missing', () => {
    expect(DelegateResponseSchema.safeParse({ ...base, action: 'delegated' }).success).toBe(false);
  });

  it('rejects an unknown action discriminant', () => {
    expect(
      DelegateResponseSchema.safeParse({ ...base, action: 'issued', token_hash: 'h' }).success,
    ).toBe(false);
  });

  it('narrows on action: token_hash is typed only on delegated/retried', () => {
    const parsed = DelegateResponseSchema.parse({ ...base, action: 'already-delegated' });
    if (parsed.action === 'already-delegated') {
      // @ts-expect-error token_hash does not exist on the already-delegated arm.
      void parsed.token_hash;
    }
    expect(parsed.action).toBe('already-delegated');
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
    const result = ActiveRunbookEntrySchema.safeParse({
      id: 'abc12345',
      runbook: 'deploy.runbook.md',
    });
    expect(result.success).toBe(false);
  });
});
