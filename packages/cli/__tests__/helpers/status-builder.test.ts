import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from './brand-helpers.js';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
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
  countNumberedSteps: jest.fn<any>().mockReturnValue(5),
  mergeEffectiveVars: jest.fn(
    (
      state: { templateVars?: Record<string, unknown>; variables?: Record<string, string> },
      extraVars?: Record<string, unknown>,
    ) => ({
      ...(state.templateVars ?? {}),
      ...(state.variables ?? {}),
      ...(extraVars ?? {}),
    }),
  ),
  ...mockErrorHelpers,
}));

import type { RunbookState } from '@rundown-org/core';

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: jest.fn(),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  getStepRetryMax: jest.fn<any>().mockReturnValue(0),
  buildMetadata: jest.fn(),
  formatActionForDisplay: jest.fn<any>().mockReturnValue('CONTINUE'),
  extractRetryDisplayCount: jest.fn((_: unknown, retryCount: number) => retryCount),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
const { getStepRetryMax, buildMetadata, formatActionForDisplay } = await import(
  '../../src/services/execution.js'
);
const { buildInactiveStatus, buildStashedStatus, buildActiveStatus } = await import(
  '../../src/helpers/status-builder.js'
);

function makeState(overrides: Partial<RunbookState> = {}): any {
  return {
    id: 'test-id',
    runbook: 'test.runbook.md',
    runbookPath: 'test.runbook.md',
    step: '1',
    stepName: 'First Step',
    retryCount: 0,
    variables: {},
    steps: [],
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as any;
}

function makeStep(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    name: '1',
    description: 'First Step',
    transitions: {
      pass: { action: 'continue' as const, retry: 0 },
      fail: { action: 'continue' as const, retry: 0 },
    },
    ...overrides,
  } as any;
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

    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(2);

    const result = buildStashedStatus(state, '/test');

    expect(result.active).toBe(false);
    expect(result.stashed).toBe(true);
    expect(result.file).toBe('test.runbook.md');
    expect(result.position).toEqual({ current: '2', total: 2 });
  });

  it('includes substep in position when present', () => {
    const state = makeState({ step: '2', substep: '1' });
    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];

    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(2);

    const result = buildStashedStatus(state, '/test');

    expect(result.position).toEqual({ current: '2', total: 2, substep: '1' });
  });

  it('includes prompted when true', () => {
    const state = makeState({ prompted: true });
    const steps = [makeStep()];

    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
      prompted: true,
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);

    const result = buildStashedStatus(state, '/test');

    expect(result.prompted).toBe(true);
  });
});

describe('buildActiveStatus', () => {
  it('returns active status with step details', () => {
    const state = makeState({ step: '1' });
    const steps = [makeStep({ name: '1', description: 'First Step' })];

    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.active).toBe(true);
    expect(result.stashed).toBe(false);
    expect(result.step).toEqual({ name: '1', description: 'First Step' });
    expect(result.position).toEqual({ current: '1', total: 1 });
  });

  it('sets stashed flag when stashedId provided', () => {
    const state = makeState();
    const steps = [makeStep()];

    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test', 'stashed-id');

    expect(result.stashed).toBe(true);
  });

  it('includes lastAction when present', () => {
    const state = makeState({
      lastAction: { type: 'RETRY' },
      retryCount: 1,
      lastResult: 'fail',
    });
    const steps = [makeStep({ name: '1' })];

    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);
    (getStepRetryMax as jest.Mock<any>).mockReturnValue(3);
    (formatActionForDisplay as jest.Mock<any>).mockReturnValue('RETRY (1/3)');

    const result = buildActiveStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'RETRY (1/3)', result: 'FAIL' });
    expect(formatActionForDisplay).toHaveBeenCalledWith({ type: 'RETRY' }, 1, 3);
  });

  it('maps lastResult pass to result true', () => {
    const state = makeState({
      lastAction: { type: 'CONTINUE' },
      retryCount: 0,
      lastResult: 'pass',
    });
    const steps = [makeStep({ name: '1' })];

    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);
    (getStepRetryMax as jest.Mock<any>).mockReturnValue(0);
    (formatActionForDisplay as jest.Mock<any>).mockReturnValue('CONTINUE');

    const result = buildActiveStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'CONTINUE', result: 'PASS' });
  });

  it('omits step when currentStep not found', () => {
    const state = makeState({ step: 'nonexistent' });
    const steps = [makeStep({ name: '1' })];

    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.step).toBeUndefined();
  });
});

describe('parentLinkage projection', () => {
  beforeEach(() => {
    const steps = [makeStep({ name: '1', description: 'First Step' })];
    (getRunbookFromState as jest.Mock<any>).mockReturnValue(steps);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);
  });

  it('surfaces delegation linkage with tokenHash in active status', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'delegation',
        tokenHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        parentRunId: 'parent-run-1',
        parentStepId: '1.1',
        parentStep: '1',
      },
    });

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'delegation',
      tokenHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      parentRunId: 'parent-run-1',
      parentStepId: '1.1',
      parentStep: '1',
    });
  });

  it('surfaces inline linkage without tokenHash in active status', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'inline',
        parentRunId: 'parent-run-1',
        parentStepId: '1.1',
      },
    });

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'inline',
      parentRunId: 'parent-run-1',
      parentStepId: '1.1',
    });
    expect(result.parentLinkage).not.toHaveProperty('tokenHash');
  });

  it('omits parentLinkage when state has none', () => {
    const state = makeState();

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toBeUndefined();
  });

  it('surfaces parentLinkage in stashed status', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'delegation',
        tokenHash: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        parentRunId: 'parent-run-2',
        parentStepId: '2.1',
      },
    });

    const result = buildStashedStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'delegation',
      tokenHash: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      parentRunId: 'parent-run-2',
      parentStepId: '2.1',
    });
  });
});

describe('vars field', () => {
  beforeEach(() => {
    (getRunbookFromState as jest.Mock<any>).mockReturnValue([]);
    (core.countNumberedSteps as jest.Mock<any>).mockReturnValue(0);
    (buildMetadata as jest.Mock<any>).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/runs/test-id.json',
    });
    (getStepRetryMax as jest.Mock<any>).mockReturnValue(0);
    (formatActionForDisplay as jest.Mock<any>).mockReturnValue('CONTINUE');
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
