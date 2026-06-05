import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
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
import type { BaseStep, ResolvedStep } from '@rundown-org/parser';
import type * as ExecutionModule from '../../src/services/execution.js';

const PARENT_RUN_ID = brandRunIdForTest(`rd_${'9'.repeat(32)}`);
const SECOND_PARENT_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
const DEFAULT_RUN_ID = brandRunIdForTest(`rd_${'b'.repeat(32)}`);
const ARTIFACT_RUN_ID = brandRunIdForTest(`rd_${'c'.repeat(32)}`);

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => {
  const countNumberedSteps = mockFn<typeof CoreModule.countNumberedSteps>();
  countNumberedSteps.mockReturnValue(5);
  return {
    stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
      id.substep ? `${id.step}.${id.substep}` : id.step,
    ),
    buildStepPosition: jest.fn((current: string, total: number, substep?: string) => ({
      current,
      total,
      ...(substep ? { substep } : {}),
    })),
    deriveExecutionAt: jest.fn(
      (step: string, substep?: string, iteration?: number) =>
        `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
    ),
    countNumberedSteps,
    isArtifactRecord: jest.fn(
      (value: unknown) =>
        value !== null &&
        typeof value === 'object' &&
        'kind' in value &&
        ((value as { kind?: unknown }).kind === 'artifact-record' ||
          (value as { kind?: unknown }).kind === 'file-artifact-record'),
    ),
    isArtifactValue: jest.fn((value: unknown) => {
      const isRecord = (candidate: unknown): boolean =>
        candidate !== null &&
        typeof candidate === 'object' &&
        'kind' in candidate &&
        ((candidate as { kind?: unknown }).kind === 'artifact-record' ||
          (candidate as { kind?: unknown }).kind === 'file-artifact-record');
      return (
        isRecord(value) ||
        (Array.isArray(value) && value.length > 0 && value.every((item) => isRecord(item)))
      );
    }),
    WORK_DIR: '.rundown/work',
    renderArtifactValue: jest.fn((value: unknown, options?: { cwd: string; workPath: string }) => {
      const renderOne = (record: { key: string; kind: string }) =>
        record.kind === 'file-artifact-record'
          ? '/tmp/project/schemas/review.schema.json'
          : `${options?.cwd ?? '/test'}/${options?.workPath ?? '.rundown/work'}/.rd-ctx-a/${ARTIFACT_RUN_ID}/${record.key}`;
      if (Array.isArray(value)) {
        return JSON.stringify(value.map(renderOne));
      }
      return renderOne(value as { key: string; kind: string });
    }),
    toPublicArtifactVarValue: jest.fn(
      (value: unknown, options: { cwd: string; workPath: string }) => {
        const renderOne = (record: Record<string, unknown>) => ({
          ...record,
          path:
            record.kind === 'file-artifact-record'
              ? '/tmp/project/schemas/review.schema.json'
              : `${options.cwd}/${options.workPath}/.rd-${String(record.contextId)}/${String(
                  record.runId,
                )}/${String(record.key)}`,
        });
        return Array.isArray(value)
          ? value.map(renderOne)
          : renderOne(value as Record<string, unknown>);
      },
    ),
    mergeEffectiveVars: jest.fn(
      (
        state: { templateVars?: Record<string, unknown>; variables?: Record<string, unknown> },
        extraVars?: Record<string, unknown>,
      ) => ({
        ...(state.templateVars ?? {}),
        ...(state.variables ?? {}),
        ...(extraVars ?? {}),
      }),
    ),
    ...mockErrorHelpers,
  };
});

import type { RunbookState } from '@rundown-org/core';

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
      mockFn<(state: RunbookState) => { file?: string; state?: string; prompted?: boolean }>(),
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
      state: '.rundown/runs/test-id.json',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(2);

    const result = buildStashedStatus(state, '/test');

    expect(result.active).toBe(false);
    expect(result.stashed).toBe(true);
    expect(result.file).toBe('test.runbook.md');
    expect(result.position).toEqual({ current: '2', total: 2 });
  });

  it('includes substep in position when present', () => {
    const state = makeState({ step: '2', substep: '1' });
    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
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
      state: '.rundown/runs/test-id.json',
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
      state: '.rundown/runs/test-id.json',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.active).toBe(true);
    expect(result.stashed).toBe(false);
    expect(result.step).toEqual({ name: '1', description: 'First Step' });
    expect(result.position).toEqual({ current: '1', total: 1 });
  });

  it('sets stashed flag when stashedId provided', () => {
    const state = makeState();
    const steps = [makeStep()];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
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
      state: '.rundown/runs/test-id.json',
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
      state: '.rundown/runs/test-id.json',
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
      state: '.rundown/runs/test-id.json',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.step).toBeUndefined();
  });
});

describe('parentLinkage projection', () => {
  beforeEach(() => {
    const steps = [makeStep({ name: '1', description: 'First Step' })];
    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
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
      variables: brandStoredOutputsForTest({ output_value: 'child-output' }),
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
    // Caller-scoped (parentLinkage set) → vars must be redacted from stashed status.
    expect(result.vars).toBeUndefined();
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
      state: '.rundown/runs/test-id.json',
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
      state: '.rundown/runs/test-id.json',
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

describe('mergeEffectiveVars mock contract', () => {
  // Direct gate against mock drift: the mock must match production's
  // (state, extraVars?) signature with precedence templateVars < variables < extraVars.
  // See packages/core/src/runbook/effective-vars.ts:mergeEffectiveVars.
  it('applies precedence extraVars > variables > templateVars', () => {
    const state = {
      templateVars: { key: 'from-templateVars', tOnly: 't' },
      variables: { key: 'from-variables', vOnly: 'v' },
    };
    const extraVars = { key: 'from-extraVars', eOnly: 'e' };
    const merged = (
      core.mergeEffectiveVars as unknown as (
        s: typeof state,
        e?: typeof extraVars,
      ) => Record<string, unknown>
    )(state, extraVars);
    expect(merged).toEqual({
      key: 'from-extraVars',
      tOnly: 't',
      vOnly: 'v',
      eOnly: 'e',
    });
  });
});
