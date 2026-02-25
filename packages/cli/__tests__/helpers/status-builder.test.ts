import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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
  countNumberedSteps: jest.fn().mockReturnValue(5),
}));

import type { RunbookState } from '@rundown-org/core';

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: jest.fn(),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  getStepRetryMax: jest.fn().mockReturnValue(0),
  buildMetadata: jest.fn(),
  formatActionForDisplay: jest.fn().mockReturnValue('CONTINUE'),
  extractRetryDisplayCount: jest.fn((_: unknown, retryCount: number) => retryCount),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { getRunbookFromState } = await import('../../src/helpers/runbook-loader');
const { getStepRetryMax, buildMetadata, formatActionForDisplay } = await import(
  '../../src/services/execution'
);
const { buildInactiveStatus, buildStashedStatus, buildActiveStatus } = await import(
  '../../src/helpers/status-builder'
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
    pendingSteps: [],
    agentBindings: {},
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

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
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

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
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

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
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

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
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

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
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

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);
    getStepRetryMax.mockReturnValue(3);
    formatActionForDisplay.mockReturnValue('RETRY (1/3)');

    const result = buildActiveStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'RETRY (1/3)', result: false });
    expect(formatActionForDisplay).toHaveBeenCalledWith({ type: 'RETRY' }, 1, 3);
  });

  it('maps lastResult pass to result true', () => {
    const state = makeState({
      lastAction: { type: 'CONTINUE' },
      retryCount: 0,
      lastResult: 'pass',
    });
    const steps = [makeStep({ name: '1' })];

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);
    getStepRetryMax.mockReturnValue(0);
    formatActionForDisplay.mockReturnValue('CONTINUE');

    const result = buildActiveStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'CONTINUE', result: true });
  });

  it('includes pending steps when present', () => {
    const state = makeState({
      pendingSteps: [{ stepId: { step: '2' }, targetStep: '2' }] as any,
    });
    const steps = [makeStep()];

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);
    const result = buildActiveStatus(state, '/test');

    expect(result.pending).toEqual(['2']);
  });

  it('includes agent bindings when present', () => {
    const state = makeState({
      agentBindings: {
        'agent-1': { stepId: { step: '1' }, targetStep: '1', status: 'running' },
      } as any,
    });
    const steps = [makeStep()];

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);
    const result = buildActiveStatus(state, '/test');

    expect(result.agents).toEqual({
      'agent-1': { step: '1', status: 'running', result: undefined },
    });
  });

  it('omits step when currentStep not found', () => {
    const state = makeState({ step: 'nonexistent' });
    const steps = [makeStep({ name: '1' })];

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.step).toBeUndefined();
  });

  it('omits pending when empty', () => {
    const state = makeState({ pendingSteps: [] });
    const steps = [makeStep()];

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.pending).toBeUndefined();
  });

  it('omits agents when empty', () => {
    const state = makeState({ agentBindings: {} });
    const steps = [makeStep()];

    getRunbookFromState.mockReturnValue(steps);
    buildMetadata.mockReturnValue({
      file: 'test.runbook.md',
      state: '.claude/rundown/runs/test-id.json',
    });
    (
      core.countNumberedSteps as jest.MockedFunction<typeof core.countNumberedSteps>
    ).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.agents).toBeUndefined();
  });
});
