import { describe, it, expect, jest } from '@jest/globals';
import { reportDelegatedTerminal } from '../../src/runbook/inline-parent-advance.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookCompletionService } from '../../src/runbook/completion-service.js';
import type { RunbookState } from '../../src/runbook/types.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';

// `recordChildCompletion` answers with FIVE outcomes. `reportDelegatedTerminal`
// switched on three of them and swept the rest into a catch-all `duplicate`, so
// `cancelled` — the delegation is gone, nothing was recorded — reached the
// caller wearing the label of "already recorded". They are different facts with
// different remedies, and only an exhaustive switch makes a sixth outcome a
// build error rather than another silent collapse.

const CHILD_RUN_ID = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const PARENT_RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function terminalChild(): RunbookState {
  return {
    prompted: false,
    id: CHILD_RUN_ID,
    runbook: { source: 'project', path: 'child.md' },
    runbookPath: 'child.md',
    step: '1',
    stepName: 'Work',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    templateVars: brandInitialTemplateVarsForTest({ ContextId: 'ctx', WorkPath: '.rundown/work' }),
    steps: [],
    lifecycle: 'completed',
    lastResult: 'pass',
    startedAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:01:00.000Z',
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    substepStates: [],
    resolvedCompletions: {},
    parentLinkage: {
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    },
  } as unknown as RunbookState;
}

describe('reportDelegatedTerminal maps every completion outcome to its own kind', () => {
  it.each([
    ['recorded', 'reported'],
    ['duplicate', 'duplicate'],
    ['cancelled', 'cancelled'],
    ['blocked', 'refused'],
    ['not-applicable', 'not-applicable'],
  ] as const)('reports %s as %s', async (recorded, expected) => {
    const completionService = {
      recordChildCompletion: jest.fn(async () => recorded),
    } as unknown as RunbookCompletionService;

    await expect(
      reportDelegatedTerminal({ completionService }, terminalChild(), 'pass'),
    ).resolves.toEqual({ kind: expected });
  });
});
