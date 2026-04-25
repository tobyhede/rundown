import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookState, Step } from '../../src/runbook/types.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../helpers/effective-vars.js';

/** Helper: create minimal RunbookState for testing. */
export function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: 'run-1',
    runbook: 'parent.md',
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Main step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: '1', status: 'running' }],
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    substepStates: [
      { id: '1', frameKey: buildFrameKey('1'), status: 'pending' },
      { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
    ],
    templateVars: brandInitialTemplateVarsForTest({ env: 'staging' }),
    ...overrides,
  } as RunbookState;
}

/** Helper: create minimal Step[] for testing. */
export function makeSteps(stepName = '1', substepIds: string[] = ['1', '2']): readonly Step[] {
  return [
    {
      kind: 'substeps',
      name: stepName,
      description: 'Test step',
      substeps: substepIds.map((id) => ({
        id,
        description: `Substep ${id}`,
      })),
    },
  ] as unknown as readonly Step[];
}

/** Helper: create steps without substeps. */
export function makeSimpleSteps(stepName = '1'): readonly Step[] {
  return [
    {
      kind: 'base',
      name: stepName,
      description: 'Simple step',
    },
  ] as unknown as readonly Step[];
}

/** Helper: create FOR steps with substeps (supports three-level step IDs). */
export function makeForSteps(stepName = '1', substepIds: string[] = ['1', '2']): readonly Step[] {
  return [
    {
      kind: 'for',
      name: stepName,
      description: 'FOR step',
      forClause: { variable: 'i', start: 1, end: 10 },
      substeps: substepIds.map((id) => ({
        id,
        description: `Substep ${id}`,
      })),
    },
  ] as unknown as readonly Step[];
}

/** Helper: create prompted-for steps with substeps (supports three-level step IDs). */
export function makePromptedForSteps(
  stepName = '1',
  substepIds: string[] = ['1', '2'],
): readonly Step[] {
  return [
    {
      kind: 'prompted-for',
      name: stepName,
      description: 'Prompted-FOR step',
      substeps: substepIds.map((id) => ({
        id,
        description: `Substep ${id}`,
      })),
    },
  ] as unknown as readonly Step[];
}
