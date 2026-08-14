import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  brandDelegationTokenHashForTest,
  brandFrameKeyForTest,
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from './brand-helpers.js';
import { mockFn } from './typed-mocks.js';

import type * as CoreModule from '@rundown-org/core';
import type { BaseStep, ResolvedStep, Substep, Transitions } from '@rundown-org/parser';
import type * as ExecutionModule from '../../src/services/execution.js';

const PARENT_RUN_ID = brandRunIdForTest(`rd_${'9'.repeat(32)}`);
const SECOND_PARENT_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
const DEFAULT_RUN_ID = brandRunIdForTest(`rd_${'b'.repeat(32)}`);
const ARTIFACT_RUN_ID = brandRunIdForTest(`rd_${'c'.repeat(32)}`);

// PARTIAL mock of @rundown-org/core. Everything spread from `actual` is the
// real implementation — in particular the frame/entry scope rule
// (`deriveActiveCompletionFrame`, `resolvedSubstepIdsInFrame`,
// `classifyCompletionReachability` behind `readDelegationOutcomeReachability`),
// which this suite exists to hold the builder against. Doubling that boundary
// is the shape CLAUDE.md calls a BLIND check: with the answer stubbed, an
// assertion can only pin that the builder ASKED core for scope, never that the
// answer is right — and the mutation gate scopes `status-builder.ts` to THIS
// file, so a stubbed boundary means the gate scores mutants nothing constrains.
//
// `countNumberedSteps` stays doubled because the step total is an input this
// suite varies per test rather than behaviour it is testing, and `steps` here
// are hand-built fixtures, not parsed runbooks.
jest.unstable_mockModule('@rundown-org/core', async () => {
  const actual = jest.requireActual<typeof CoreModule>('@rundown-org/core');
  const countNumberedSteps = mockFn<typeof CoreModule.countNumberedSteps>();
  countNumberedSteps.mockReturnValue(5);
  return { ...actual, countNumberedSteps };
});

import type { Frame, ResolvedCompletion, RunbookState } from '@rundown-org/core';

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<(state: RunbookState, cwd: string) => readonly ResolvedStep[]>(),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => {
  const getStepRetryMax = mockFn<typeof ExecutionModule.getStepRetryMax>();
  getStepRetryMax.mockReturnValue(0);
  const formatActionForDisplay = mockFn<typeof ExecutionModule.formatActionForDisplay>();
  formatActionForDisplay.mockReturnValue('CONTINUE');
  const extractRetryDisplayCount = mockFn<typeof ExecutionModule.extractRetryDisplayCount>();
  extractRetryDisplayCount.mockImplementation((_, retryCount) => retryCount);
  return {
    getStepRetryMax,
    buildMetadata:
      mockFn<
        (state: RunbookState) => {
          file?: string;
          state?: string;
          runId?: string;
          prompted?: boolean;
        }
      >(),
    formatActionForDisplay,
    extractRetryDisplayCount,
  };
});

// Import after mocking
const core = await import('@rundown-org/core');
const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
const { getStepRetryMax, buildMetadata, formatActionForDisplay } = await import(
  '../../src/services/execution.js'
);
const { buildInactiveStatus, buildStashedStatus, buildActiveStatus } = await import(
  '../../src/helpers/status-builder.js'
);

function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  const baseState: RunbookState = {
    templateVars: brandInitialTemplateVarsForTest({}),
    id: DEFAULT_RUN_ID,
    runbook: { source: 'project', path: 'test.runbook.md' },
    runbookPath: 'test.runbook.md',
    step: '1',
    stepName: 'First Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest(),
    steps: [],
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  return { ...baseState, ...overrides };
}

function makeStep(overrides: Partial<Omit<BaseStep, 'kind'>> = {}): ResolvedStep {
  const baseStep: BaseStep = {
    kind: 'base',
    name: '1',
    description: 'First Step',
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
    },
  };
  return { ...baseStep, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('buildInactiveStatus', () => {
  it('returns inactive with no stash', () => {
    const result = buildInactiveStatus();
    expect(result).toEqual({ active: false, stashed: false });
  });
});

describe('buildStashedStatus', () => {
  it('returns stashed status with position', () => {
    const state = makeState({ step: '2', substep: undefined });
    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(2);

    const result = buildStashedStatus(state, '/test');

    expect(result.active).toBe(false);
    expect(result.stashed).toBe(true);
    expect(result.file).toBe('test.runbook.md');
    // `state` is the same database for every run, so `runId` carries identity.
    expect(result.runId).toBe(DEFAULT_RUN_ID);
    expect(result.position).toEqual({ current: '2', total: 2 });
  });

  it('includes substep in position when present', () => {
    const state = makeState({ step: '2', substep: '1' });
    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(2);

    const result = buildStashedStatus(state, '/test');

    expect(result.position).toEqual({ current: '2', total: 2, substep: '1' });
  });

  it('includes prompted when true', () => {
    const state = makeState({ prompted: true });
    const steps = [makeStep()];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
      prompted: true,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildStashedStatus(state, '/test');

    expect(result.prompted).toBe(true);
  });
});

describe('buildActiveStatus', () => {
  it('returns active status with step details', () => {
    const state = makeState({ step: '1' });
    const steps = [makeStep({ name: '1', description: 'First Step' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.active).toBe(true);
    expect(result.stashed).toBe(false);
    // `state` is the same database for every run, so `runId` carries identity.
    expect(result.runId).toBe(DEFAULT_RUN_ID);
    expect(result.step).toEqual({ name: '1', description: 'First Step' });
    expect(result.position).toEqual({ current: '1', total: 1 });
  });

  it('sets stashed flag when stashedId provided', () => {
    const state = makeState();
    const steps = [makeStep()];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test', 'stashed-id');

    expect(result.stashed).toBe(true);
  });

  it('includes lastAction when present', () => {
    const state = makeState({
      lastAction: { type: 'RETRY', origin: 'direct' },
      retryCount: 1,
      lastResult: 'fail',
    });
    const steps = [makeStep({ name: '1' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);
    jest.mocked(getStepRetryMax).mockReturnValue(3);
    jest.mocked(formatActionForDisplay).mockReturnValue('RETRY (1/3)');

    const result = buildActiveStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'RETRY (1/3)', result: 'FAIL' });
    expect(formatActionForDisplay).toHaveBeenCalledWith({ type: 'RETRY', origin: 'direct' }, 1, 3);
  });

  it('maps lastResult pass to result true', () => {
    const state = makeState({
      lastAction: { type: 'CONTINUE', origin: 'direct' },
      retryCount: 0,
      lastResult: 'pass',
    });
    const steps = [makeStep({ name: '1' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);
    jest.mocked(getStepRetryMax).mockReturnValue(0);
    jest.mocked(formatActionForDisplay).mockReturnValue('CONTINUE');

    const result = buildActiveStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'CONTINUE', result: 'PASS' });
  });

  it('omits step when currentStep not found', () => {
    const state = makeState({ step: 'nonexistent' });
    const steps = [makeStep({ name: '1' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.step).toBeUndefined();
  });
});

describe('claimKey join (#531)', () => {
  const CHILD_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
  const CLAIM_ID = 'rdclm_AAAAAAAAAAAAAAAAAAAAAA';

  beforeEach(() => {
    jest.mocked(getRunbookFromState).mockReturnValue([makeStep({ name: '1' })]);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);
  });

  function makeStateWithClaimedDelegation(
    overrides: {
      childRunId?: string | null;
      cancelledAt?: string | null;
      token?: string | null;
    } = {},
  ): RunbookState {
    // contextSnapshot.vars is branded (EffectiveVars) — hand-rolled fixture
    // records need the cast; the builder never reads contextSnapshot.
    const delegation = {
      token: overrides.token === null ? undefined : (overrides.token ?? `rdtk_${'A'.repeat(32)}`),
      tokenHash: brandDelegationTokenHashForTest(`sha256:${'a'.repeat(64)}`),
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      childRunId: overrides.childRunId != null ? brandRunIdForTest(overrides.childRunId) : null,
      cancelledAt: overrides.cancelledAt ?? null,
      contextSnapshot: { vars: {}, ancestors: [] },
      createdAt: '2026-07-03T00:00:00.000Z',
    } as unknown as CoreModule.StepDelegation;
    const substepStates: CoreModule.SubstepState[] = [
      {
        id: '1',
        frameKey: brandFrameKeyForTest('1|'),
        status: 'running',
        delegation,
      },
      // Non-delegation substep: must never surface as a delegations entry.
      {
        id: '2',
        frameKey: brandFrameKeyForTest('1|'),
        status: 'pending',
      },
    ];
    return makeState({ substepStates });
  }

  it('joins claimKey onto claimed delegations from the session claim map', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });

    const result = buildActiveStatus(state, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([[CHILD_RUN_ID, CLAIM_ID]]),
    });

    // Exactly one entry: the non-delegation substep never surfaces.
    expect(result.delegations).toHaveLength(1);
    expect(result.delegations?.[0]).toMatchObject({
      state: 'claimed',
      childRunId: CHILD_RUN_ID,
      claimKey: CLAIM_ID,
    });
    // A claimed delegation never exposes its raw token.
    expect(result.delegations?.[0]).not.toHaveProperty('token');
  });

  it('never attaches claimKey to a pending delegation even with stray map entries', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: null });

    const result = buildActiveStatus(state, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([
        [CHILD_RUN_ID, CLAIM_ID],
        [`rd_${'b'.repeat(32)}`, 'rdclm_strayAAAAAAAAAAAAAAAA'],
      ]),
    });

    const entry = result.delegations?.[0];
    // Status is a read model, not a credential-delivery surface. Even a
    // legacy-shaped state carrying a raw token must not expose it.
    expect(entry).toMatchObject({
      state: 'pending',
      tokenHash: `sha256:${'a'.repeat(64)}`,
      substep: '1',
      runbook: 'child.md',
    });
    expect(entry).not.toHaveProperty('token');
    expect(entry).not.toHaveProperty('childRunId');
    expect(entry).not.toHaveProperty('claimKey');
  });

  it('excludes delegations from other frames when an active frame is set', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });
    const scoped = { ...state, activeFrameKey: brandFrameKeyForTest('9|'), activeEntry: 1 };

    const result = buildActiveStatus(scoped, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([[CHILD_RUN_ID, CLAIM_ID]]),
    });

    // The fixture's delegation is scoped to frame '1|'; the active frame '9|'
    // filters it out.
    expect(result.delegations).toBeUndefined();
  });

  it('includes delegations whose frame matches the active frame', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });
    const scoped = { ...state, activeFrameKey: brandFrameKeyForTest('1|'), activeEntry: 1 };

    const result = buildActiveStatus(scoped, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([[CHILD_RUN_ID, CLAIM_ID]]),
    });

    expect(result.delegations).toHaveLength(1);
    expect(result.delegations?.[0]).toMatchObject({ state: 'claimed', claimKey: CLAIM_ID });
  });

  it('never resurfaces the token on a cancelled-before-claim delegation', () => {
    const state = makeStateWithClaimedDelegation({
      childRunId: null,
      cancelledAt: '2026-07-03T00:00:00.000Z',
    });

    const result = buildActiveStatus(state, '/test');

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'cancelled' });
    expect(entry).not.toHaveProperty('token');
  });

  it('keeps pending delegation status token-free when persisted state has no token', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: null, token: null });

    const result = buildActiveStatus(state, '/test');

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'pending' });
    expect(entry).not.toHaveProperty('token');
  });

  it('omits claimKey when the map has no matching entry', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });

    const result = buildActiveStatus(state, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map(),
    });

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'claimed', childRunId: CHILD_RUN_ID });
    expect(entry).not.toHaveProperty('claimKey');
  });

  it('keeps the current shape when the options argument is omitted', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });

    const result = buildActiveStatus(state, '/test');

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'claimed', childRunId: CHILD_RUN_ID });
    expect(entry).not.toHaveProperty('claimKey');
  });

  it('never attaches claimKey to a cancelled-after-claim delegation', () => {
    // Cancelled-after-claim: childRunId stays set while cancelledAt is stamped
    // (abortDelegation --force), so the computed entry state is 'cancelled'
    // even though the claim map has a matching entry (e.g. a window before
    // child teardown releases the claim record).
    const state = makeStateWithClaimedDelegation({
      childRunId: CHILD_RUN_ID,
      cancelledAt: '2026-07-03T00:00:00.000Z',
    });

    const result = buildActiveStatus(state, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([[CHILD_RUN_ID, CLAIM_ID]]),
    });

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'cancelled', childRunId: CHILD_RUN_ID });
    expect(entry).not.toHaveProperty('claimKey');
    // A cancelled delegation never resurfaces its raw token.
    expect(entry).not.toHaveProperty('token');
  });
});

describe('parentLinkage projection', () => {
  beforeEach(() => {
    const steps = [makeStep({ name: '1', description: 'First Step' })];
    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);
  });

  it('surfaces delegation linkage with tokenHash in active status', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'delegation',
        tokenHash: brandDelegationTokenHashForTest(
          'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        ),
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1'),
        parentEntry: 1,
      },
    });

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'delegation',
      tokenHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
    });
  });

  it('surfaces inline linkage without tokenHash in active status', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'inline',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1'),
        parentEntry: 1,
      },
    });

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'inline',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
    });
    expect(result.parentLinkage).not.toHaveProperty('tokenHash');
  });

  it('omits parentLinkage when state has none', () => {
    const state = makeState();

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toBeUndefined();
  });

  it('surfaces parentLinkage in stashed status and redacts vars for caller-scoped child', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'delegation',
        tokenHash: brandDelegationTokenHashForTest(
          'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        ),
        parentRunId: SECOND_PARENT_RUN_ID,
        parentStepId: '2.1',
        parentStep: '2',
        parentFrameKey: brandFrameKeyForTest('2'),
        parentEntry: 1,
      },
      templateVars: brandInitialTemplateVarsForTest({ secret: 'inherited-from-parent' }),
      variables: brandStoredOutputsForTest({
        output_value: 'child-output',
        PlanPath: brandTrustedArtifactRecordForTest({
          kind: 'artifact-record',
          uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
          runId: ARTIFACT_RUN_ID,
          contextId: 'ctx-a',
          runbook: { source: 'project', path: 'producer.runbook.md' },
          key: 'plan.json',
          timestamp: '2026-05-25T00:00:00.000Z',
        }),
      }),
    });

    const result = buildStashedStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'delegation',
      tokenHash: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      parentRunId: SECOND_PARENT_RUN_ID,
      parentStepId: '2.1',
      parentStep: '2',
      parentFrameKey: brandFrameKeyForTest('2'),
      parentEntry: 1,
    });
    // Caller-scoped (parentLinkage set) → vars and artifacts must be redacted from stashed status.
    expect(result.vars).toBeUndefined();
    expect(result.artifacts).toBeUndefined();
  });

  it('surfaces vars in stashed status when no parentLinkage is set', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ visible: 'value' }),
      variables: brandStoredOutputsForTest(),
    });

    const result = buildStashedStatus(state, '/test');

    expect(result.parentLinkage).toBeUndefined();
    expect(result.vars).toEqual(expect.objectContaining({ visible: 'value' }));
  });
});

describe('vars field', () => {
  beforeEach(() => {
    jest.mocked(getRunbookFromState).mockReturnValue([]);
    jest.mocked(core.countNumberedSteps).mockReturnValue(0);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(getStepRetryMax).mockReturnValue(0);
    jest.mocked(formatActionForDisplay).mockReturnValue('CONTINUE');
  });

  it('merges templateVars (scalars) and state.variables, state.variables wins on collision', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ environment: 'staging', port: 3000 }),
      variables: brandStoredOutputsForTest({
        environment: 'production',
        PlanPath: '/work/plan.json',
      }),
    });
    const result = buildActiveStatus(state, '/project');
    expect(result.vars).toEqual({
      environment: 'production',
      port: '3000',
      PlanPath: '/work/plan.json',
    });
  });

  it('excludes non-scalar templateVars (arrays, objects)', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({
        // `kind`-shaped sentinel masquerades as a JsonObject; runtime
        // filter drops it from the rendered vars map.
        items: { kind: 'json-array', value: ['a', 'b'] },
        name: 'test',
      }),
      variables: brandStoredOutputsForTest(),
    });
    const result = buildActiveStatus(state, '/project');
    expect(result.vars).toEqual({ name: 'test' });
    expect(result.vars?.items).toBeUndefined();
  });

  it('renders artifact-record variables as paths and exposes structured projections', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars).toEqual({
      PlanPath: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
    });
    expect(result.artifacts).toEqual({
      PlanPath: expect.objectContaining({
        kind: 'artifact-record',
        uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
        path: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      }),
    });
  });

  it('renders artifact path using record contextId and runId, not hardcoded values', () => {
    const otherRunId = brandRunIdForTest(`rd_${'d'.repeat(32)}`);
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-b/${otherRunId}/output.json`,
      runId: otherRunId,
      contextId: 'ctx-b',
      runbook: { source: 'project', path: 'other.runbook.md' },
      key: 'output.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ OutputPath: artifact }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars?.OutputPath).toBe(
      `/project/.rundown/work/.rd-ctx-b/${otherRunId}/output.json`,
    );
    expect(result.vars?.OutputPath).not.toContain('ctx-a');
    expect(result.vars?.OutputPath).not.toContain(String(ARTIFACT_RUN_ID));
  });

  it('renders artifact paths for two records from different contexts independently', () => {
    const runIdA = brandRunIdForTest(`rd_${'e'.repeat(32)}`);
    const runIdB = brandRunIdForTest(`rd_${'f'.repeat(32)}`);
    const artifactA = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-x/${runIdA}/a.json`,
      runId: runIdA,
      contextId: 'ctx-x',
      runbook: { source: 'project', path: 'a.runbook.md' },
      key: 'a.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const artifactB = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-y/${runIdB}/b.json`,
      runId: runIdB,
      contextId: 'ctx-y',
      runbook: { source: 'project', path: 'b.runbook.md' },
      key: 'b.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ ArtA: artifactA, ArtB: artifactB }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars?.ArtA).toContain('ctx-x');
    expect(result.vars?.ArtA).toContain(runIdA);
    expect(result.vars?.ArtB).toContain('ctx-y');
    expect(result.vars?.ArtB).toContain(runIdB);
    // Ensure cross-contamination does not occur
    expect(result.vars?.ArtA).not.toContain('ctx-y');
    expect(result.vars?.ArtB).not.toContain('ctx-x');
  });

  it('renders artifact-record arrays as JSON path arrays and exposes structured projections', () => {
    const first = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan-a.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan-a.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const second = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan-b.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan-b.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({
        Plans: brandTrustedArtifactArrayForTest([first, second]),
      }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars).toEqual({
      Plans: JSON.stringify([
        `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan-a.json`,
        `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan-b.json`,
      ]),
    });
    expect(result.artifacts?.Plans).toEqual([
      expect.objectContaining({
        uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan-a.json`,
        path: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan-a.json`,
      }),
      expect.objectContaining({
        uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan-b.json`,
        path: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan-b.json`,
      }),
    ]);
  });

  it('uses state WorkPath when rendering artifact status paths', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ WorkPath: '.custom/work' }),
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });

    jest.mocked(getRunbookFromState).mockReturnValue([makeStep()]);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars?.PlanPath).toBe(
      `/project/.custom/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
    );
    expect(result.artifacts?.PlanPath).toEqual(
      expect.objectContaining({
        path: `/project/.custom/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      }),
    );
  });

  it('redacts artifacts in stashed status for a caller-scoped child', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      parentLinkage: {
        kind: 'delegation',
        tokenHash: brandDelegationTokenHashForTest(
          'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        ),
        parentRunId: SECOND_PARENT_RUN_ID,
        parentStepId: '2.1',
        parentStep: '2',
        parentFrameKey: brandFrameKeyForTest('2'),
        parentEntry: 1,
      },
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });

    const result = buildStashedStatus(state, '/project');

    // Caller-scoped (parentLinkage set) → artifacts redacted alongside vars.
    expect(result.artifacts).toBeUndefined();
    expect(result.vars).toBeUndefined();
  });

  it('surfaces artifacts in stashed status when no parentLinkage is set', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });

    const result = buildStashedStatus(state, '/project');

    expect(result.parentLinkage).toBeUndefined();
    expect(result.artifacts?.PlanPath).toEqual(
      expect.objectContaining({
        kind: 'artifact-record',
        path: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      }),
    );
  });

  it('renders a file-artifact-record path in the artifacts projection', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'file-artifact-record',
      uri: 'file:///tmp/project/schemas/review.schema.json',
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'schemas/review.schema.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ SchemaPath: artifact }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.artifacts?.SchemaPath).toEqual(
      expect.objectContaining({
        kind: 'file-artifact-record',
        path: '/tmp/project/schemas/review.schema.json',
      }),
    );
  });

  it('returns undefined vars when both templateVars and variables are empty', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest(),
      variables: brandStoredOutputsForTest(),
    });
    const result = buildActiveStatus(state, '/project');
    expect(result.vars).toBeUndefined();
  });

  it('buildStashedStatus also includes vars field', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ environment: 'staging' }),
      variables: brandStoredOutputsForTest({ PlanPath: '/work/plan.json' }),
    });
    const result = buildStashedStatus(state, '/project');
    expect(result.vars).toEqual({
      environment: 'staging',
      PlanPath: '/work/plan.json',
    });
  });
});

// ---------------------------------------------------------------------------
// Scope agreement with core (#749, #766).
//
// These run against the REAL `deriveActiveCompletionFrame` /
// `resolvedSubstepIdsInFrame` / `readDelegationOutcomeReachability` — the whole
// reason this suite partial-mocks core rather than replacing it. Every
// expectation below is a claim about what the completion drain would do, so a
// double here would make them claims about the double.
// ---------------------------------------------------------------------------

const SCOPE_FRAME = core.buildFrameKey('1');

const SCOPE_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

function scopeSubstep(id: string): Substep {
  return { id, description: `Substep ${id}`, transitions: SCOPE_TRANSITIONS, delegate: true };
}

const SCOPE_STEP: ResolvedStep = {
  kind: 'substeps',
  name: '1',
  description: 'Fan out',
  transitions: SCOPE_TRANSITIONS,
  substeps: [scopeSubstep('1'), scopeSubstep('2')],
};

/** A state whose cursor sits on frame `1|` at entry 2 — one re-entry in. */
function scopeState(overrides: Partial<RunbookState> = {}): RunbookState {
  return makeState({
    step: '1',
    stepName: 'Fan out',
    resolvedCompletions: {},
    frameEntryCounts: { [SCOPE_FRAME]: 2 },
    activeFrameKey: SCOPE_FRAME,
    activeEntry: 2,
    ...overrides,
  });
}

function delegationRow(
  frame: Frame,
  targetSubstep: string,
  extra: { result?: 'pass' | 'fail'; targetIteration?: number } = {},
): Record<string, ResolvedCompletion> {
  return {
    [core.buildCompletionKey(frame, targetSubstep)]: core.buildResolvedCompletion({
      agentId: 'delegation',
      result: extra.result ?? 'pass',
      targetStep: '1',
      targetSubstep,
      ...(extra.targetIteration !== undefined ? { targetIteration: extra.targetIteration } : {}),
      targetFrame: frame,
      completedAt: '2026-01-01T00:00:00.000Z',
    }),
  };
}

function scopeFixtures(): void {
  jest.mocked(getRunbookFromState).mockReturnValue([SCOPE_STEP]);
  jest.mocked(buildMetadata).mockReturnValue({
    file: 'test.runbook.md',
    state: '.rundown/rundown.db',
    runId: DEFAULT_RUN_ID,
  });
  jest.mocked(core.countNumberedSteps).mockReturnValue(1);
}

describe('position.unresolved agrees with the completion drain (#766)', () => {
  beforeEach(scopeFixtures);

  it('counts a sentinel-entry completion as resolved', () => {
    // A pre-recorded completion persists at SENTINEL_ENTRY and the drain applies
    // it to ANY visit of its frame — `completionTargetsFrame` admits it for an
    // active frame. The CLI-local copy this replaced compared
    // `targetEntry === activeEntry`, so it called the substep unresolved while
    // `rundown collect` would have applied the row.
    const status = buildActiveStatus(
      scopeState({ resolvedCompletions: delegationRow(core.inactiveFrame(SCOPE_FRAME), '1') }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(1);
  });

  it('counts a live-entry completion as resolved', () => {
    const status = buildActiveStatus(
      scopeState({ resolvedCompletions: delegationRow(core.activeFrame(SCOPE_FRAME, 2), '1') }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(1);
  });

  it('counts a superseded-entry completion as unresolved', () => {
    const status = buildActiveStatus(
      scopeState({ resolvedCompletions: delegationRow(core.exactFrame(SCOPE_FRAME, 1), '1') }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(2);
  });

  it('counts a foreign-frame completion as unresolved', () => {
    const status = buildActiveStatus(
      scopeState({
        resolvedCompletions: delegationRow(core.activeFrame(core.buildFrameKey('2'), 2), '1'),
      }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(2);
  });

  it('counts every substep when nothing has been reported', () => {
    expect(buildActiveStatus(scopeState(), '/test').position?.unresolved).toBe(2);
  });

  it('counts zero when every substep has a reachable row', () => {
    const status = buildActiveStatus(
      scopeState({
        resolvedCompletions: {
          ...delegationRow(core.activeFrame(SCOPE_FRAME, 2), '1'),
          ...delegationRow(core.inactiveFrame(SCOPE_FRAME), '2'),
        },
      }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(0);
  });

  it('ignores a reachable row naming a substep this step does not declare', () => {
    const status = buildActiveStatus(
      scopeState({ resolvedCompletions: delegationRow(core.activeFrame(SCOPE_FRAME, 2), 'ghost') }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(2);
  });

  it('omits unresolved when the state names no active frame', () => {
    const status = buildActiveStatus(
      makeState({ step: '1', activeFrameKey: undefined, activeEntry: undefined }),
      '/test',
    );

    expect(status.position?.unresolved).toBeUndefined();
  });
});

describe('reportedOutcomes (#766)', () => {
  beforeEach(scopeFixtures);

  it('is omitted when the run has reported no delegation outcomes', () => {
    expect(buildActiveStatus(scopeState(), '/test')).not.toHaveProperty('reportedOutcomes');
  });

  it('reports a collectable outcome with no remedy', () => {
    const status = buildActiveStatus(
      scopeState({ resolvedCompletions: delegationRow(core.activeFrame(SCOPE_FRAME, 2), '1') }),
      '/test',
    );

    expect(status.reportedOutcomes).toEqual([
      {
        completionKey: core.buildCompletionKey(core.activeFrame(SCOPE_FRAME, 2), '1'),
        step: '1',
        substep: '1',
        outcome: 'pass',
        reportedAt: '2026-01-01T00:00:00.000Z',
        reachability: 'collectable',
      },
    ]);
  });

  it('carries a fail outcome through unchanged', () => {
    const status = buildActiveStatus(
      scopeState({
        resolvedCompletions: delegationRow(core.activeFrame(SCOPE_FRAME, 2), '1', {
          result: 'fail',
        }),
      }),
      '/test',
    );

    expect(status.reportedOutcomes?.[0]?.outcome).toBe('fail');
  });

  it('names delegate --retry on the reporting substep for a superseded outcome', () => {
    // The abandoned row #766 is about: reported, then stranded by a RETRY/GOTO
    // re-entry. Nothing will ever collect it, so `status` must say what does
    // clear it — and must name the SUBSTEP, which is what `--step` takes here.
    const status = buildActiveStatus(
      scopeState({ resolvedCompletions: delegationRow(core.exactFrame(SCOPE_FRAME, 1), '2') }),
      '/test',
    );

    expect(status.reportedOutcomes).toEqual([
      {
        completionKey: core.buildCompletionKey(core.exactFrame(SCOPE_FRAME, 1), '2'),
        step: '1',
        substep: '2',
        outcome: 'pass',
        reportedAt: '2026-01-01T00:00:00.000Z',
        reachability: 'superseded',
        remedy: 'rundown delegate --retry --step 2',
      },
    ]);
  });

  it('reports an out-of-scope outcome with its iteration and no remedy', () => {
    // A closed FOR iteration: the cursor is not on that frame at all, so
    // `delegate --retry --step` — which targets the CURRENT step — is not the
    // remedy and must not be advertised as one.
    const closedIteration = core.buildFrameKey('1', 2);
    const status = buildActiveStatus(
      scopeState({
        resolvedCompletions: delegationRow(core.exactFrame(closedIteration, 1), '1', {
          result: 'fail',
          targetIteration: 2,
        }),
      }),
      '/test',
    );

    expect(status.reportedOutcomes).toEqual([
      {
        completionKey: core.buildCompletionKey(core.exactFrame(closedIteration, 1), '1'),
        step: '1',
        substep: '1',
        iteration: 2,
        outcome: 'fail',
        reportedAt: '2026-01-01T00:00:00.000Z',
        reachability: 'out-of-scope',
      },
    ]);
  });

  it('omits iteration for a completion that carries none', () => {
    const status = buildActiveStatus(
      scopeState({ resolvedCompletions: delegationRow(core.activeFrame(SCOPE_FRAME, 2), '1') }),
      '/test',
    );

    expect(status.reportedOutcomes?.[0]).not.toHaveProperty('iteration');
  });

  it('reports all three classes together in persisted completion-key order', () => {
    const status = buildActiveStatus(
      scopeState({
        resolvedCompletions: {
          ...delegationRow(core.activeFrame(SCOPE_FRAME, 2), '2'),
          ...delegationRow(core.exactFrame(SCOPE_FRAME, 1), '1'),
          ...delegationRow(core.activeFrame(core.buildFrameKey('2'), 2), '1'),
        },
      }),
      '/test',
    );

    expect(status.reportedOutcomes?.map((entry) => [entry.substep, entry.reachability])).toEqual([
      ['1', 'superseded'],
      ['2', 'collectable'],
      ['1', 'out-of-scope'],
    ]);
  });

  it('agrees with the collection-pending guard on which outcomes are collectable', () => {
    // The invariant that keeps `status` honest end to end: what status calls
    // `collectable` is what a bare mutation is blocked on and what
    // `rundown collect` consumes. Asserting it here, against real core, is what
    // makes the reachability label a claim about the run rather than about a
    // fixture.
    const state = scopeState({
      resolvedCompletions: {
        ...delegationRow(core.activeFrame(SCOPE_FRAME, 2), '1'),
        ...delegationRow(core.exactFrame(SCOPE_FRAME, 1), '2'),
      },
    });

    const collectable = buildActiveStatus(state, '/test')
      .reportedOutcomes?.filter((entry) => entry.reachability === 'collectable')
      .map((entry) => entry.completionKey);

    expect(collectable).toEqual(
      core
        .readDelegationCollectionPendingForPolicy(state)
        .outcomes.map((outcome) => outcome.completionKey),
    );
  });

  it('ignores manual completions, reporting only delegation rows', () => {
    const manual = core.buildCompletionKey(core.activeFrame(SCOPE_FRAME, 2), '1');
    const status = buildActiveStatus(
      scopeState({
        resolvedCompletions: {
          [manual]: core.buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: core.activeFrame(SCOPE_FRAME, 2),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      }),
      '/test',
    );

    expect(status).not.toHaveProperty('reportedOutcomes');
  });
});
