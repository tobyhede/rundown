import { brandInitialTemplateVarsForTest } from './brand-helpers.js';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ResolvedStep, Substep, ForClause, Transitions } from '@rundown-org/parser';
import type {
  ClaimId,
  DelegationCredentialIssuer,
  DelegationTokenDeriver,
  ExecutionEpoch,
  LifecycleNavigationMutationOutcome,
  LifecycleNavigationCapability,
  RunProgressionDirective,
  RunProgressionOutcome,
  RunbookLifecycleCommandService,
  RunbookState,
  RunbookStateManager,
  StepId,
} from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { brandRunIdForTest } from './brand-helpers.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';
import { delegationRuntimeDouble } from './delegation-runtime-helpers.js';

const DEFAULT_RUNBOOK_ID = brandRunIdForTest(`rd_${'6'.repeat(32)}`);
// Branded by cast rather than assertClaimId: core is mocked in this suite, so
// the real validator is unavailable and only the value's identity matters here.
const CLAIM_ID = 'rdclm_abcdefghijklmnopqrstu1' as unknown as ClaimId;

/** The refusal half of a fenced navigation outcome, minus the applied arm. */
type NavigationRefusal = Exclude<LifecycleNavigationMutationOutcome, { kind: 'applied' }>;

// Branded by cast for the same reason as CLAIM_ID above: core is mocked here, so
// `assertExecutionEpoch` is unavailable and only the value's identity matters.
const TEST_EPOCH = 4 as ExecutionEpoch;

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  SessionService: jest.fn(),
  // Statically imported by delegation-completion.js (pulled in via executeGoto's
  // propagateDrivenRunTerminal call); the ESM link check needs the names, but the
  // executeGoto tests below make `manager.load` return null so propagation
  // short-circuits `skipped` without invoking any of these.
  ExecutionLifecycleService: jest.fn(),
  RunbookCompletionService: jest.fn(),
  projectDelegationTerminalOutcome: jest.fn(),
  // Satisfies the ESM named-import link check for delegation-completion.ts,
  // which this module pulls in transitively.
  COMPLETION_TARGET_MISMATCH_CODE: 'COMPLETION_TARGET_MISMATCH',
  parseStepIdFromString: jest.fn(),
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  deriveGotoActionBlock: jest.fn(({ target }: { target: { step: string; substep?: string } }) => ({
    action: `GOTO ${target.substep ? `${target.step}.${target.substep}` : target.step}`,
    from: '1',
    at: target.step,
  })),
  // Runtime-only validator with no service dependencies; pass-through preserves
  // structural mocking — every static import from @rundown-org/core resolves
  // through the factory rather than leaking the real module.
  assertClaimId: jest.fn((s: string) => s),
  claimKeyFromBearer: jest.fn((s: string) => `key:${s}`),
  runbooksDir: jest.fn((cwd: string) => `${cwd}/.rundown/runbooks`),
  // Statically imported by refusal-renderers.js, which goto-workflow.js pulls in
  // for renderNavigationRefusal. Only the terminal-claim renderers call it, and
  // navigation has no such arm — but the ESM link check needs the name present.
  redactClaimId: jest.fn((claimId: string) => claimId),
  ...mockErrorHelpers,
}));

// Mock the lifecycle seam factory: buildGotoContext dispatches into the core
// navigation seam through it (not exercised by these unit tests); mocking the
// factory keeps this suite off the seam's core-service import graph.
jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory', () => ({
  buildNonDelegatingLifecycleSeam: jest.fn(),
}));

// GOTO owns only rendering and verbatim directive forwarding. Keep the shared
// driver structural so these tests cannot accidentally pin its internal loop.
jest.unstable_mockModule('../../src/helpers/run-progression-adapters', () => ({
  driveRunProgression: mockFn<() => Promise<RunProgressionOutcome>>(),
  progressionFailedClosed: jest.fn((outcome: RunProgressionOutcome) =>
    ['refused', 'failed', 'stopped'].includes(outcome.kind),
  ),
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<() => readonly ResolvedStep[]>().mockReturnValue([]),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

// Delegation completion still imports this factory transitively; keep that
// collaborator structural even though GotoContext no longer carries it.
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { driveRunProgression, progressionFailedClosed } = await import(
  '../../src/helpers/run-progression-adapters.js'
);
const {
  validateGotoTarget,
  executeGoto,
  gotoResultRequiresFailureExit,
  renderNavigationRefusal,
  buildGotoContext,
} = await import('../../src/helpers/goto-workflow.js');
const { buildNonDelegatingLifecycleSeam } = await import(
  '../../src/helpers/lifecycle-seam-factory.js'
);

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

interface MakeStepOverrides {
  name?: string;
  description?: string;
  transitions?: Transitions;
  substeps?: readonly Substep[];
  forClause?: ForClause;
  command?: { code: string; lang?: string };
  kind?: ResolvedStep['kind'];
}

function makeStep(overrides: MakeStepOverrides = {}): ResolvedStep {
  const base = {
    name: overrides.name ?? '1',
    description: overrides.description ?? 'Test Step',
    transitions: overrides.transitions ?? DEFAULT_TRANSITIONS,
  };
  const explicitKind = overrides.kind;
  if (explicitKind === 'prompted-for' && overrides.substeps) {
    return {
      kind: 'prompted-for',
      ...base,
      substeps: overrides.substeps,
    };
  }
  if (overrides.forClause !== undefined) {
    return {
      kind: 'for',
      ...base,
      forClause: overrides.forClause,
      substeps: overrides.substeps ?? [],
    };
  }
  if (Array.isArray(overrides.substeps) && overrides.substeps.length > 0) {
    return {
      kind: 'substeps',
      ...base,
      substeps: overrides.substeps,
    };
  }
  if (overrides.command !== undefined) {
    return {
      kind: 'command',
      ...base,
      command: overrides.command,
    };
  }
  return {
    kind: 'base',
    ...base,
  };
}

function makeSubstep(id: string, description: string): Substep {
  return { id, description, transitions: DEFAULT_TRANSITIONS };
}

function makeNumericFor(start: number, end: number, variable = 'x'): ForClause {
  return { variable, start, end };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations after reset
  jest
    .mocked(core.stepIdToString)
    .mockImplementation((id) => (id.substep ? `${id.step}.${id.substep}` : id.step));
  jest.mocked(core.deriveGotoActionBlock).mockImplementation(({ target }) => ({
    action: `GOTO ${target.substep ? `${target.step}.${target.substep}` : target.step}`,
    from: '1',
    at: target.step,
  }));
  jest.mocked(driveRunProgression).mockResolvedValue({
    kind: 'waiting',
    runId: DEFAULT_RUNBOOK_ID,
    reason: 'awaiting_input',
  });
  jest
    .mocked(progressionFailedClosed)
    .mockImplementation((outcome) => ['refused', 'failed', 'stopped'].includes(outcome.kind));
});

// ACCEPTED MUTATION SURVIVORS in goto-workflow.ts (#485).
//
//  - The `default:` arm of `executeGoto`'s refusal switch (`goto-workflow.ts:394`),
//    `ConditionalExpression` + `BlockStatement`. Unreachable by construction: the
//    arm exists only to bind `const _exhaustive: never = mutation`, so reaching it
//    is a compile error, not a runtime state a test could drive.

describe('buildGotoContext claim-target coupling (#613)', () => {
  /**
   * Pin that goto derives caller evidence and the target selector from the SAME
   * `--claim-id`.
   *
   * `docs/reference/cli.md` and `docs/internal/architecture.md` both state that
   * `CLAIM_BEARER_MISMATCH` is unreachable from the CLI. That claim rests
   * entirely on this coupling: the seam refuses a divergence, so a frontend
   * sourcing the two fields independently would refuse every claim-targeted
   * goto at runtime AND silently falsify both docs. Nothing else fails if the
   * coupling breaks, so it is pinned here, where drift would originate.
   *
   * `readLifecycleCallerEvidence` is deliberately NOT mocked in this suite, so
   * this exercises the real derivation rather than a stand-in.
   */
  it('derives caller evidence and target selector from one --claim-id', async () => {
    const captured: unknown[] = [];
    jest.mocked(buildNonDelegatingLifecycleSeam).mockReturnValue({
      manager: {} as never,
      seam: {
        resolveRunNavigation: async (input: unknown) => {
          captured.push(input);
          // `none` short-circuits buildGotoContext before it assembles context,
          // which keeps this test about input construction only.
          return { kind: 'none' } as never;
        },
      } as never,
    } as never);
    const output = { noActiveRunbook: () => {} } as unknown as OutputEmitter;

    await buildGotoContext(output, '/cwd', { claimId: CLAIM_ID });

    expect(captured).toHaveLength(1);
    const input = captured[0] as {
      callerEvidence: { kind: string; claimId?: unknown };
      targetSelector: { kind: string; claimId?: unknown };
    };
    expect(input.callerEvidence).toEqual({ kind: 'claim_bearer', claimId: CLAIM_ID });
    expect(input.targetSelector).toEqual({ kind: 'claim', claimId: CLAIM_ID });
    // The invariant, stated as the seam's own gate states it: same id on both.
    expect(input.callerEvidence.claimId).toBe(input.targetSelector.claimId);
  });

  it('presents no bearer when no --claim-id is supplied, so the gate cannot fire', async () => {
    const captured: unknown[] = [];
    jest.mocked(buildNonDelegatingLifecycleSeam).mockReturnValue({
      manager: {} as never,
      seam: {
        resolveRunNavigation: async (input: unknown) => {
          captured.push(input);
          return { kind: 'none' } as never;
        },
      } as never,
    } as never);
    const output = { noActiveRunbook: () => {} } as unknown as OutputEmitter;

    await buildGotoContext(output, '/cwd', {});

    const input = captured[0] as {
      callerEvidence: { kind: string };
      targetSelector: { kind: string };
    };
    // Anti-vacuity for the case above: without `--claim-id` neither field is
    // claim-shaped, so the reconciliation is a no-op rather than a refusal.
    expect(input.callerEvidence).toEqual({ kind: 'direct_cli' });
    expect(input.targetSelector.kind).not.toBe('claim');
  });
});

describe('buildGotoContext delegation authority propagation', () => {
  /**
   * Pin that the claim-bound capability pair reaches the goto context.
   *
   * `resolveRunNavigation` mints one opaque capability containing authority and
   * the graph it verified. The runtime pair remains nested inside that
   * authority, making a separately threaded issuer, deriver, or graph
   * impossible at the CLI boundary.
   */
  function seamReturning(outcome: unknown): void {
    jest.mocked(buildNonDelegatingLifecycleSeam).mockReturnValue({
      manager: {} as never,
      seam: { resolveRunNavigation: async () => outcome } as never,
    } as never);
  }

  const allowedOutcome = (
    navigation: LifecycleNavigationCapability,
  ): Record<string, unknown> & { kind: 'allowed' } => ({
    kind: 'allowed',
    runId: DEFAULT_RUNBOOK_ID,
    state: { id: DEFAULT_RUNBOOK_ID, step: '1' },
    steps: navigation.steps,
    navigation,
  });

  it('carries both claim-bound delegation capabilities onto the context', async () => {
    const issueDelegationCredential = jest.fn() as unknown as DelegationCredentialIssuer;
    const deriveDelegationToken = jest.fn() as unknown as DelegationTokenDeriver;
    const delegationRuntime = delegationRuntimeDouble({
      issueDelegationCredential,
      deriveDelegationToken,
    });
    const navigation = {
      authority: { runId: DEFAULT_RUNBOOK_ID, delegationRuntime },
      steps: [makeStep()],
    } as unknown as LifecycleNavigationCapability;
    seamReturning(allowedOutcome(navigation));
    const output = {} as unknown as OutputEmitter;

    const result = await buildGotoContext(output, '/cwd', {});

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.ctx.navigation).toBe(navigation);
    expect(result.ctx.navigation.authority.delegationRuntime).toBe(delegationRuntime);
    expect(result.ctx.navigation.authority.delegationRuntime?.issueDelegationCredential).toBe(
      issueDelegationCredential,
    );
    expect(result.ctx.navigation.authority.delegationRuntime?.deriveDelegationToken).toBe(
      deriveDelegationToken,
    );
  });

  it('keeps the capability whole when verified authority has no delegation runtime', async () => {
    const navigation = {
      authority: { runId: DEFAULT_RUNBOOK_ID },
      steps: [makeStep()],
    } as unknown as LifecycleNavigationCapability;
    seamReturning(allowedOutcome(navigation));
    const output = {} as unknown as OutputEmitter;

    const result = await buildGotoContext(output, '/cwd', {});

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.ctx.navigation).toBe(navigation);
    expect(result.ctx.navigation.authority.delegationRuntime).toBeUndefined();
  });
});

describe('renderNavigationRefusal', () => {
  /** Recording OutputEmitter double capturing the rendered envelope. */
  function refusalEmitter(): {
    output: OutputEmitter;
    errors: readonly unknown[][];
    noActive: readonly unknown[][];
  } {
    const errors: unknown[][] = [];
    const noActive: unknown[][] = [];
    const output = {
      error: (...args: unknown[]) => errors.push(args),
      noActiveRunbook: (...args: unknown[]) => noActive.push(args),
    } as unknown as OutputEmitter;
    return { output, errors, noActive };
  }

  it('reports `none` as a no-op, not a failure', () => {
    const { output, errors, noActive } = refusalEmitter();

    // The empty-stack case is the one non-`ready` result that exits 0 — the
    // caller maps this polarity to process.exitCode.
    expect(renderNavigationRefusal(output, { kind: 'none' })).toBe(false);
    expect(noActive).toEqual([['goto']]);
    expect(errors).toEqual([]);
  });

  it('renders stale_claim under the code core assigned to the refusal', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, {
      kind: 'stale_claim',
      claimId: CLAIM_ID,
      message: 'superseded by the parent',
      code: 'DELEGATION_SUPERSEDED',
    });

    expect(exitError).toBe(true);
    // The code travels with the refusal — it is not hard-coded per arm.
    expect(errors).toEqual([['superseded by the parent', 'DELEGATION_SUPERSEDED']]);
  });

  it('renders terminal_claim as CLAIMED_RUNBOOK_UNAVAILABLE', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, {
      kind: 'terminal_claim',
      claimId: CLAIM_ID,
      lifecycle: 'completed',
      message: 'child already completed',
    });

    expect(exitError).toBe(true);
    expect(errors).toEqual([['child already completed', 'CLAIMED_RUNBOOK_UNAVAILABLE']]);
  });

  it('renders unknown_run as RUN_TARGET_UNAVAILABLE', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, {
      kind: 'unknown_run',
      runId: DEFAULT_RUNBOOK_ID,
      message: 'not a member of this session stack',
    });

    expect(exitError).toBe(true);
    expect(errors).toEqual([['not a member of this session stack', 'RUN_TARGET_UNAVAILABLE']]);
  });

  it('renders actor_context_required naming goto and echoing no run id', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, { kind: 'actor_context_required' });

    expect(exitError).toBe(true);
    expect(errors[0]?.[1]).toBe('ACTOR_CONTEXT_REQUIRED');
    expect(errors[0]?.[0]).toContain('rundown goto');
    expect(errors[0]?.[0]).toContain('--claim-id');
    // Accident barrier: no details object, and no run id anywhere.
    expect(errors[0]?.[2]).toBeUndefined();
    expect(JSON.stringify(errors[0])).not.toContain(DEFAULT_RUNBOOK_ID);
  });

  it('names the invoking command, so the run --prompted --step path does not say goto', () => {
    // `run --prompted --step` routes its launch-local jump through this same
    // navigation seam (it did not before #855, which built the context by
    // hand). The remedial advice is identical either way, but naming `rundown
    // goto` to someone who typed `rundown run` points at a command they never
    // invoked — and `command` also rides the JSON `no_active_runbook` envelope
    // that agents route on.
    const { output, errors } = refusalEmitter();

    expect(renderNavigationRefusal(output, { kind: 'actor_context_required' }, 'run')).toBe(true);
    expect(errors[0]?.[0]).toContain('rundown run');
    expect(errors[0]?.[0]).not.toContain('rundown goto');

    const mismatch = refusalEmitter();
    expect(renderNavigationRefusal(mismatch.output, { kind: 'claim_bearer_mismatch' }, 'run')).toBe(
      true,
    );
    expect(mismatch.errors[0]?.[0]).toContain('rundown run');
    expect(mismatch.errors[0]?.[0]).not.toContain('rundown goto');
  });

  it('renders claim_bearer_mismatch under its own code, naming goto (#613)', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, { kind: 'claim_bearer_mismatch' });

    expect(exitError).toBe(true);
    expect(errors[0]?.[1]).toBe('CLAIM_BEARER_MISMATCH');
    expect(errors[0]?.[1]).not.toBe('ACTOR_CONTEXT_REQUIRED');
    // Names this command, so the message cannot be command-agnostic boilerplate.
    expect(errors[0]?.[0]).toContain('rundown goto');
    // The caller DID present a claim id, so the bare-form advice would misdiagnose.
    expect(errors[0]?.[0]).not.toContain('Pass `--claim-id');
    expect(errors[0]?.[2]).toBeUndefined();
  });

  it('fails closed on an unrecognized kind rather than exiting zero', () => {
    const { output, errors, noActive } = refusalEmitter();

    // Unreachable through the typed API — the union is exhausted above. Reachable
    // from an untyped frontend, or from a core version that adds a refusal this
    // build does not know. The exhaustiveness guard's runtime consequence is what
    // matters: the caller must still exit non-zero. A guard that fell through
    // would return undefined and silently succeed, turning an unknown refusal
    // into a successful goto.
    const exitError = renderNavigationRefusal(output, {
      kind: 'unrecognized_future_refusal',
    } as unknown as Parameters<typeof renderNavigationRefusal>[1]);

    // `toBe(true)`, not `toBeTruthy()`: the signature promises a boolean, so the
    // unreachable arm must honour it too. A truthiness assertion would also pass
    // for an arm that returned the refusal object, leaving a `=== true` call
    // site free to break on it.
    expect(exitError).toBe(true);
    // Nothing is rendered for a kind we cannot describe — no guessed envelope.
    expect(errors).toEqual([]);
    expect(noActive).toEqual([]);
  });

  it('distinguishes the two claim-authority refusals from each other', () => {
    const bare = refusalEmitter();
    const mismatch = refusalEmitter();

    renderNavigationRefusal(bare.output, { kind: 'actor_context_required' });
    renderNavigationRefusal(mismatch.output, { kind: 'claim_bearer_mismatch' });

    // Same command, same exit polarity, different diagnosis — the whole point
    // of splitting the code rather than reusing ACTOR_CONTEXT_REQUIRED (#613).
    expect(bare.errors[0]?.[1]).not.toBe(mismatch.errors[0]?.[1]);
    expect(bare.errors[0]?.[0]).not.toBe(mismatch.errors[0]?.[0]);
  });
});

describe('validateGotoTarget', () => {
  it('rejects invalid format', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue(null);

    const result = validateGotoTarget('abc', [makeStep()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_SYNTAX');
      expect(result.details).toEqual({ provided: 'abc' });
    }
  });

  it('rejects missing step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '99' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('99', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
      expect(result.details?.available).toEqual(['1', '2']);
    }
  });

  it('rejects AT on non-FOR step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [makeStep({ name: '1' })]; // No forClause
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_AT_TARGET');
    }
  });

  it('accepts AT on FOR step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(true);
  });

  it('rejects substep on step without substeps', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '2' });

    const steps = [makeStep({ name: '1' })]; // No substeps
    const result = validateGotoTarget('1.2', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
    }
  });

  it('rejects nonexistent substep', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '3' });

    const steps = [
      makeStep({
        name: '1',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.3', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
      expect(result.details?.available).toEqual(['1', '2']);
    }
  });

  it('accepts substep target on prompted-for step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });

    const steps = [
      makeStep({
        name: '1',
        kind: 'prompted-for',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.1', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1', substep: '1' });
    }
  });

  it('rejects AT on prompted-for step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [
      makeStep({
        name: '1',
        kind: 'prompted-for',
        substeps: [makeSubstep('1', 'Sub 1')],
      }),
    ];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_AT_TARGET');
    }
  });

  it('accepts valid step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '2' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('2', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '2' });
    }
  });

  it('accepts self-referencing GOTO as valid target', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1' });
    }
  });

  it('accepts valid substep', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '2' });

    const steps = [
      makeStep({
        name: '1',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.2', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1', substep: '2' });
    }
  });

  describe('--index option', () => {
    it('sets target.at from --index on FOR step', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1', steps, '3');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.target.at).toBe(3);
      }
    });

    it('rejects --index on non-FOR step', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1' })]; // No forClause
      const result = validateGotoTarget('1', steps, '3');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_AT_TARGET');
      }
    });

    it('rejects conflicting --index and AT', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 5 });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 10) })];
      const result = validateGotoTarget('1 AT 5', steps, '3');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('CONFLICTING_INDEX');
      }
    });

    it('accepts matching --index and AT (idempotent)', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1 AT 3', steps, '3');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.target.at).toBe(3);
      }
    });

    it('rejects invalid --index value', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1', steps, 'abc');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_SYNTAX');
      }
    });
  });
});

describe('executeGoto', () => {
  // Build a state for the goto context. Includes the minimum required RunbookState
  // fields; tests exercise only the specific fields each path consults.
  function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      templateVars: brandInitialTemplateVarsForTest({}),
      id: DEFAULT_RUNBOOK_ID,
      runbook: { source: 'project', path: 'test.md' },
      runbookPath: 'test.md',
      step: '1',
      stepName: 'Step 1',
      retryCount: 0,
      variables: {} as RunbookState['variables'],
      steps: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      prompted: false,
      ...overrides,
    };
  }

  const gotoSteps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
  const navigation = {
    authority: { runId: DEFAULT_RUNBOOK_ID },
    steps: gotoSteps,
  } as unknown as LifecycleNavigationCapability;
  const progressionDirective = {
    kind: 'activate',
    authority: navigation.authority,
    steps: navigation.steps,
    entryBoundary: { kind: 'after_observed_transition', lifecycle: 'running' },
  } as const satisfies Extract<RunProgressionDirective, { kind: 'activate' }>;
  const waitingProgression = {
    kind: 'waiting',
    runId: DEFAULT_RUNBOOK_ID,
    reason: 'awaiting_input',
  } as const satisfies RunProgressionOutcome;

  function appliedMutation(): Extract<LifecycleNavigationMutationOutcome, { kind: 'applied' }> {
    return {
      kind: 'applied',
      runId: DEFAULT_RUNBOOK_ID,
      previousState: makeState(),
      updatedState: makeState({ step: '2' }),
      snapshot: {},
      progression: progressionDirective,
    };
  }

  // Every refusal the fenced navigation mutation can return, each mapped to its
  // own symbolic code. The codes are the branch an agent acts on — re-claim,
  // re-read, wait, recover, or give up — so the table asserts the message is
  // forwarded verbatim alongside the code, not merely that the goto failed.
  //
  // Each outcome is typed as the concrete union member rather than cast, so the
  // fixtures are checked against the contract they stand in for: only
  // `recovery_required` carries an epoch, and a row that drifted from core's
  // shape would fail to compile instead of silently testing a shape core never
  // produces.
  it.each<{
    readonly label: string;
    readonly outcome: NavigationRefusal;
    readonly code: string;
  }>([
    {
      label: 'a vanished run target',
      outcome: { kind: 'missing', runId: DEFAULT_RUNBOOK_ID, message: 'run disappeared' },
      code: 'RUN_TARGET_UNAVAILABLE',
    },
    {
      label: 'a superseded claim',
      outcome: {
        kind: 'claim_superseded',
        runId: DEFAULT_RUNBOOK_ID,
        message: 'A newer claim controls this run.',
      },
      code: 'STALE_CLAIM',
    },
    {
      label: 'a concurrent state change',
      outcome: {
        kind: 'concurrent_modification',
        runId: DEFAULT_RUNBOOK_ID,
        message: 'The run changed while this goto was deciding.',
      },
      code: 'CONCURRENT_MODIFICATION',
    },
    {
      label: 'an in-flight execution',
      outcome: {
        kind: 'execution_in_progress',
        runId: DEFAULT_RUNBOOK_ID,
        message: 'Another actor owns this run.',
      },
      code: 'EXECUTION_IN_PROGRESS',
    },
    {
      label: 'an interrupted execution',
      outcome: {
        kind: 'recovery_required',
        runId: DEFAULT_RUNBOOK_ID,
        epoch: TEST_EPOCH,
        message: 'The execution outcome is unknown and requires recovery.',
      },
      code: 'RECOVERY_REQUIRED',
    },
  ])('returns $code when the fenced core mutation refuses with $label', async (refusal) => {
    const update = mockFn<RunbookStateManager['update']>();
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue(refusal.outcome);

    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep()],
      cwd: '/test',
      navigation,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(refusal.code);
      expect(result.error).toBe(refusal.outcome.message);
    }
    // A refused navigation must not write: the fence owns the commit, so a CLI
    // fallback write would be the shadow persistence path the fence replaced.
    expect(update).not.toHaveBeenCalled();
  });

  it('renders GOTO before forwarding the core directive verbatim to shared progression', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    update.mockImplementation(async (_id, _patch) => makeState({ step: '2' }));
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue(appliedMutation());
    jest.mocked(driveRunProgression).mockResolvedValue(waitingProgression);

    const action = jest.fn();
    const ctx = {
      output: {
        action,
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      navigation,
    };

    const target: StepId = { step: '2' };
    const result = await executeGoto(ctx, target);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.progression).toEqual(waitingProgression);
    }
    expect(action).toHaveBeenCalled();
    expect(runNavigationMutation).toHaveBeenCalledTimes(1);
    // The seam decides authority, target, and release policy from this input
    // alone — the CLI performs no navigation write of its own — so an input that
    // silently lost a field would hand the fence a different mutation.
    expect(runNavigationMutation).toHaveBeenCalledWith({
      navigation,
      target,
    });
    expect(driveRunProgression).toHaveBeenCalledWith(
      progressionDirective,
      expect.objectContaining({ manager: ctx.manager, cwd: '/test' }),
    );
    expect(jest.mocked(driveRunProgression).mock.calls[0]?.[1]).not.toHaveProperty('steps');
    expect(action.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(driveRunProgression).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(update).not.toHaveBeenCalledWith(
      DEFAULT_RUNBOOK_ID,
      expect.objectContaining({ lastAction: expect.anything() }),
    );
  });

  it('does not call clearLastResult after core GOTO synchronization', async () => {
    const clearLastResult = jest.fn(async () => undefined);
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue(appliedMutation());

    const outputAction = jest.fn();
    const output = {
      action: outputAction,
      flush: jest.fn(),
    } as unknown as OutputEmitter;
    const ctx = {
      output,
      manager: {
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      navigation,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.progression).toEqual(waitingProgression);
    }
    expect(clearLastResult).not.toHaveBeenCalled();
    expect(outputAction).toHaveBeenCalledWith({
      action: 'GOTO 2',
      from: '1',
      at: '2',
    });
  });

  it('returns the shared progression stopped outcome without a second terminal branch', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    update.mockImplementation(async (_id, _patch) => makeState({ step: '2' }));
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue(appliedMutation());
    jest.mocked(driveRunProgression).mockResolvedValue({
      kind: 'stopped',
      runId: DEFAULT_RUNBOOK_ID,
    });

    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      navigation,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.progression).toEqual({
        kind: 'stopped',
        runId: DEFAULT_RUNBOOK_ID,
      });
    }
  });

  it('does not unpack or reconstruct the authority used by mutation and continuation', async () => {
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    const issueDelegationCredential = jest.fn() as unknown as DelegationCredentialIssuer;
    const deriveDelegationToken = jest.fn() as unknown as DelegationTokenDeriver;
    const delegationRuntime = delegationRuntimeDouble({
      issueDelegationCredential,
      deriveDelegationToken,
    });
    const navigationWithRuntime = {
      authority: { runId: DEFAULT_RUNBOOK_ID, delegationRuntime },
      steps: gotoSteps,
    } as unknown as LifecycleNavigationCapability;
    const directiveWithRuntime = {
      ...progressionDirective,
      authority: navigationWithRuntime.authority,
    } satisfies Extract<RunProgressionDirective, { kind: 'activate' }>;
    runNavigationMutation.mockResolvedValue({
      ...appliedMutation(),
      progression: directiveWithRuntime,
    });
    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      navigation: navigationWithRuntime,
    };

    await executeGoto(ctx, { step: '2' });

    expect(runNavigationMutation).toHaveBeenCalledWith({
      navigation: navigationWithRuntime,
      target: { step: '2' },
    });
    expect(driveRunProgression).toHaveBeenCalledWith(directiveWithRuntime, expect.anything());
    expect(directiveWithRuntime.authority.delegationRuntime).toBe(delegationRuntime);
  });
});

describe('gotoResultRequiresFailureExit', () => {
  // GOTO delegates the exit decision to the same predicate used by every
  // directive-driven frontend; it does not reinterpret terminal propagation.
  type OkResult = Parameters<typeof gotoResultRequiresFailureExit>[0];

  it.each([
    [{ kind: 'waiting', runId: DEFAULT_RUNBOOK_ID, reason: 'awaiting_input' }, false],
    [{ kind: 'completed', runId: DEFAULT_RUNBOOK_ID }, false],
    [{ kind: 'stopped', runId: DEFAULT_RUNBOOK_ID }, true],
    [
      {
        kind: 'refused',
        runId: DEFAULT_RUNBOOK_ID,
        reason: 'actor_context_required',
        message: 'authority required',
        recovery: 'provide_authority',
      },
      true,
    ],
  ] as const)('returns %s for progression %p', (progression, expected) => {
    const result: OkResult = { ok: true, progression };
    expect(gotoResultRequiresFailureExit(result)).toBe(expected);
    expect(progressionFailedClosed).toHaveBeenLastCalledWith(progression);
  });
});
