import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import {
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
    parseRunbook: mockFn<typeof CoreModule.parseRunbook>(),
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
      const renderOne = (record: {
        key: string;
        kind: string;
        contextId?: string;
        runId?: string;
      }) =>
        record.kind === 'file-artifact-record'
          ? '/tmp/project/schemas/review.schema.json'
          : `${options?.cwd ?? '/test'}/${options?.workPath ?? '.rundown/work'}/.rd-${String(
              record.contextId,
            )}/${String(record.runId)}/${record.key}`;
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

import type { FrameKey, RunbookState } from '@rundown-org/core';

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
const { buildInactiveStatus, buildRunListStatus, buildRunStatus } = await import(
  '../../src/helpers/status-builder.js'
);

function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  const baseState: RunbookState = {
    prompted: false,
    launchDir: '.',
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
  it('returns an empty run list', () => {
    const result = buildInactiveStatus();
    expect(result).toEqual({ active: false, runs: [] });
  });
});

describe('buildRunListStatus', () => {
  beforeEach(() => {
    jest.mocked(core.parseRunbook).mockReturnValue([]);
    jest.mocked(core.countNumberedSteps).mockReturnValue(2);
  });

  it('lists every run with id, runbook, lifecycle and position', () => {
    const running = makeState({
      id: DEFAULT_RUN_ID,
      step: '2',
      title: 'Running one',
      runbookSrc: '## 1. A\n\n## 2. B\n',
    });
    const completed = makeState({
      id: ARTIFACT_RUN_ID,
      runbookSrc: '## 1. A\n\n## 2. B\n',
      step: '2',
      lifecycle: 'completed',
      runbook: { source: 'project', path: 'done.runbook.md' },
    });

    const result = buildRunListStatus([running, completed]);

    expect(result.active).toBe(false);
    expect(result.runs).toEqual([
      {
        id: DEFAULT_RUN_ID,
        runbook: 'test.runbook.md',
        status: 'running',
        step: '2',
        total: 2,
        title: 'Running one',
      },
      { id: ARTIFACT_RUN_ID, runbook: 'done.runbook.md', status: 'complete', step: '2', total: 2 },
    ]);
  });

  it('renders a substep position as step.substep', () => {
    const state = makeState({ step: '2', substep: '1' });

    const result = buildRunListStatus([state]);

    expect(result.runs?.[0]?.step).toBe('2.1');
  });

  it('reports stopped and abandoned lifecycles', () => {
    const stopped = makeState({ id: DEFAULT_RUN_ID, lifecycle: 'stopped' });
    const abandoned = makeState({ id: ARTIFACT_RUN_ID, lifecycle: 'abandoned' });

    const result = buildRunListStatus([stopped, abandoned]);

    expect(result.runs?.map((run) => run.status)).toEqual(['stopped', 'abandoned']);
  });

  it('omits total for a run with no stored source without failing the list', () => {
    const withSrc = makeState({ id: DEFAULT_RUN_ID, runbookSrc: '## 1. A\n' });
    const withoutSrc = makeState({ id: ARTIFACT_RUN_ID });

    const result = buildRunListStatus([withSrc, withoutSrc]);

    expect(result.runs).toEqual([
      { id: DEFAULT_RUN_ID, runbook: 'test.runbook.md', status: 'running', step: '1', total: 2 },
      { id: ARTIFACT_RUN_ID, runbook: 'test.runbook.md', status: 'running', step: '1' },
    ]);
  });

  it('omits total only for the run whose stored source fails to parse', () => {
    jest.mocked(core.parseRunbook).mockImplementation((src) => {
      if (src === 'broken') throw new Error('parse failure');
      return [];
    });
    const broken = makeState({ id: DEFAULT_RUN_ID, runbookSrc: 'broken' });
    const healthy = makeState({ id: ARTIFACT_RUN_ID, runbookSrc: '## 1. A\n' });

    const result = buildRunListStatus([broken, healthy]);

    expect(result.runs?.[0]).not.toHaveProperty('total');
    expect(result.runs?.[1]).toMatchObject({ id: ARTIFACT_RUN_ID, total: 2 });
  });

  it('returns an empty list for no runs', () => {
    expect(buildRunListStatus([])).toEqual({ active: false, runs: [] });
  });

  it('never carries a token', () => {
    const result = buildRunListStatus([makeState()]);
    expect(JSON.stringify(result)).not.toMatch(/rdo_|token/i);
  });
});

describe('buildRunStatus', () => {
  it('returns active status with step details for a running run', () => {
    const state = makeState({ step: '1' });
    const steps = [makeStep({ name: '1', description: 'First Step' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildRunStatus(state, '/test');

    expect(result.active).toBe(true);
    expect(result.status).toBeUndefined();
    // `state` is the same database for every run, so `runId` carries identity.
    expect(result.runId).toBe(DEFAULT_RUN_ID);
    expect(result.file).toBe('test.runbook.md');
    expect(result.step).toEqual({ name: '1', description: 'First Step' });
    expect(result.position).toEqual({ current: '1', total: 1 });
    expect(result).not.toHaveProperty('stashed');
    expect(result).not.toHaveProperty('delegations');
    expect(result).not.toHaveProperty('parentLinkage');
  });

  it.each(['completed', 'stopped', 'abandoned'] as const)(
    'reports a %s run as inactive with its lifecycle',
    (lifecycle) => {
      const state = makeState({ step: '1', lifecycle });
      jest.mocked(getRunbookFromState).mockReturnValue([makeStep({ name: '1' })]);
      jest.mocked(buildMetadata).mockReturnValue({
        file: 'test.runbook.md',
        state: '.rundown/rundown.db',
        runId: DEFAULT_RUN_ID,
      });
      jest.mocked(core.countNumberedSteps).mockReturnValue(1);

      const result = buildRunStatus(state, '/test');

      expect(result.active).toBe(false);
      expect(result.status).toBe(lifecycle);
    },
  );

  it('includes substep, frame key and entry in position when present', () => {
    const state = makeState({
      step: '2',
      substep: '1',
      activeFrameKey: '2|' as FrameKey,
      activeEntry: 3,
    });
    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(2);

    const result = buildRunStatus(state, '/test');

    expect(result.position).toEqual({
      current: '2',
      total: 2,
      substep: '1',
      frameKey: state.activeFrameKey,
      entry: 3,
    });
  });

  it('includes prompted when true', () => {
    const state = makeState({ prompted: true });

    jest.mocked(getRunbookFromState).mockReturnValue([makeStep()]);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      state: '.rundown/rundown.db',
      runId: DEFAULT_RUN_ID,
      prompted: true,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildRunStatus(state, '/test');

    expect(result.prompted).toBe(true);
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

    const result = buildRunStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'RETRY (1/3)', result: 'FAIL' });
    expect(formatActionForDisplay).toHaveBeenCalledWith({ type: 'RETRY', origin: 'direct' }, 1, 3);
  });

  it('maps lastResult pass to result PASS', () => {
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

    const result = buildRunStatus(state, '/test');

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

    const result = buildRunStatus(state, '/test');

    expect(result.step).toBeUndefined();
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
    const result = buildRunStatus(state, '/project');
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
    const result = buildRunStatus(state, '/project');
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

    const result = buildRunStatus(state, '/project');

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

    const result = buildRunStatus(state, '/project');

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

    const result = buildRunStatus(state, '/project');

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

    const result = buildRunStatus(state, '/project');

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

    const result = buildRunStatus(state, '/project');

    expect(result.vars?.PlanPath).toBe(
      `/project/.custom/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
    );
    expect(result.artifacts?.PlanPath).toEqual(
      expect.objectContaining({
        path: `/project/.custom/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
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

    const result = buildRunStatus(state, '/project');

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
    const result = buildRunStatus(state, '/project');
    expect(result.vars).toBeUndefined();
  });

  it('surfaces vars and artifacts on a finished run', () => {
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
      lifecycle: 'completed',
      templateVars: brandInitialTemplateVarsForTest({ environment: 'staging' }),
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });
    const result = buildRunStatus(state, '/project');
    expect(result.active).toBe(false);
    expect(result.vars).toEqual({
      environment: 'staging',
      PlanPath: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
    });
    expect(result.artifacts?.PlanPath).toEqual(
      expect.objectContaining({ kind: 'artifact-record' }),
    );
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
