import { describe, expect, it, jest } from '@jest/globals';
import { createActor, toPromise, type PromiseActorLogic } from 'xstate';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../../src/testing/effective-vars.js';
import {
  runProgressionEntryActor,
  type EnterRunProgressionUnit,
} from '../../../src/runbook/actors/run-progression-entry-actor.js';
import type { ExecutionUnitEntry } from '../../../src/runbook/execution-unit-entry.js';
import { CURRENT_SCHEMA_VERSION } from '../../../src/runbook/persisted-state-guards.js';
import { assertRunId } from '../../../src/runbook/run-id.js';
import { buildFrameKey } from '../../../src/runbook/targeting.js';
import type { RunbookState } from '../../../src/runbook/types.js';

// The actor is a one-line pass-through wrapper, which is exactly why it needs
// its own pin: nothing else in the suite asserts what it RETURNS. Emptying its
// body (`async () => undefined`) or its returned object left every core test
// passing, so the machine could have been handed `undefined` in place of an
// entry and no test would have noticed.
//
// The pass-through is also the invariant worth protecting. The actor returns
// the state it was GIVEN beside the entry rendered from it, so the observation
// and the runtime's cursor cannot describe two different versions of one run —
// an identity assertion, not a structural one.

const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function state(): RunbookState {
  return {
    prompted: false,
    launchDir: '.',
    templateVars: brandInitialTemplateVarsForTest({}),
    id: RUN_ID,
    runbook: { source: 'project', path: 'entry-actor-test.md' },
    runbookPath: 'entry-actor-test.md',
    step: '1',
    substep: '1',
    stepName: 'Delegate work',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    lifecycle: 'running',
    startedAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    substepStates: [],
    schemaVersion: CURRENT_SCHEMA_VERSION,
    frontmatterOutputs: [],
  };
}

/**
 * Run the actor to completion and return its output.
 *
 * `toPromise` is the same settle-the-actor helper production uses, so the
 * actor is driven here exactly as the machine drives it.
 *
 * @param logic - The actor logic under test.
 * @param input - The actor's typed input.
 * @returns The actor's resolved output.
 */
async function runToOutput<TInput, TOutput>(
  logic: PromiseActorLogic<TOutput, TInput>,
  input: TInput,
): Promise<TOutput> {
  const actor = createActor(logic, { input });
  actor.start();
  return await toPromise(actor);
}

describe('runProgressionEntryActor', () => {
  const entered: ExecutionUnitEntry = { kind: 'awaiting', effects: [] };

  it('returns the entry beside the EXACT state it rendered from', async () => {
    const selected = state();
    const enter = jest.fn<EnterRunProgressionUnit>().mockResolvedValue(entered);

    const output = await runToOutput(runProgressionEntryActor, { state: selected, enter });

    // `toBe`, not `toEqual`: an actor that rebuilt an equal-looking state would
    // let the observation and the cursor drift apart, which is the whole reason
    // this actor returns the state at all.
    expect(output.state).toBe(selected);
    expect(output.entered).toBe(entered);
  });

  it('renders against the state it was given and nothing else', async () => {
    const selected = state();
    const enter = jest.fn<EnterRunProgressionUnit>().mockResolvedValue(entered);

    await runToOutput(runProgressionEntryActor, { state: selected, enter });

    // Pinned first, and the argument then read NON-optionally: `toBe` on an
    // optional chain is satisfied by an `enter` that was never called at all.
    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter.mock.calls[0][0]).toBe(selected);
    expect(enter.mock.calls[0]).toHaveLength(1);
  });
});
