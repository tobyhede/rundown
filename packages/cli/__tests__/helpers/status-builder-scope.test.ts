import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  exactFrame,
  inactiveFrame,
  type Frame,
  type RunbookState,
} from '@rundown-org/core';
import type { ResolvedStep, Substep, Transitions } from '@rundown-org/parser';
import { mockFn } from './typed-mocks.js';
import {
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from './brand-helpers.js';

// Only the runbook loader is mocked: this suite exists to pin the CLI's
// agreement with the REAL core scope rule (`completionTargetsFrame` via
// `deriveActiveCompletionFrame`), so mocking `@rundown-org/core` — as the
// sibling status-builder suite does — would defeat its entire purpose.
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<(state: RunbookState, cwd: string) => readonly ResolvedStep[]>(),
}));

const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
const { buildActiveStatus } = await import('../../src/helpers/status-builder.js');

const RUN_ID = brandRunIdForTest(`rd_${'7'.repeat(32)}`);
const FRAME = buildFrameKey('1');

const TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

function substep(id: string): Substep {
  return { id, description: `Substep ${id}`, transitions: TRANSITIONS, delegate: true };
}

const STEP: ResolvedStep = {
  kind: 'substeps',
  name: '1',
  description: 'Fan out',
  transitions: TRANSITIONS,
  substeps: [substep('1'), substep('2')],
};

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    templateVars: brandInitialTemplateVarsForTest({}),
    id: RUN_ID,
    runbook: { source: 'project', path: 'parent.md' },
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Fan out',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    resolvedCompletions: {},
    frameEntryCounts: { [FRAME]: 2 },
    activeFrameKey: FRAME,
    activeEntry: 2,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

function delegationRow(frame: Frame, targetSubstep: string) {
  return {
    [buildCompletionKey(frame, targetSubstep)]: buildResolvedCompletion({
      agentId: 'delegation',
      result: 'pass',
      targetStep: '1',
      targetSubstep,
      targetFrame: frame,
      completedAt: '2026-01-01T00:00:00.000Z',
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getRunbookFromState).mockReturnValue([STEP]);
});

describe('position.unresolved scope', () => {
  it('counts a sentinel-entry completion as resolved, matching the drain', () => {
    // A pre-recorded completion persists at SENTINEL_ENTRY and the drain applies
    // it to ANY visit of its frame — `completionTargetsFrame` admits it for an
    // active frame. Counting it as unresolved made `status` disagree with what
    // `rundown collect` would do.
    const status = buildActiveStatus(
      state({ resolvedCompletions: delegationRow(inactiveFrame(FRAME), '1') }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(1);
  });

  it('counts a live-entry completion as resolved', () => {
    const status = buildActiveStatus(
      state({ resolvedCompletions: delegationRow(activeFrame(FRAME, 2), '1') }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(1);
  });

  it('counts a superseded-entry completion as unresolved', () => {
    const status = buildActiveStatus(
      state({ resolvedCompletions: delegationRow(exactFrame(FRAME, 1), '1') }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(2);
  });

  it('counts a foreign-frame completion as unresolved', () => {
    const status = buildActiveStatus(
      state({ resolvedCompletions: delegationRow(activeFrame(buildFrameKey('2'), 2), '1') }),
      '/test',
    );

    expect(status.position?.unresolved).toBe(2);
  });
});
