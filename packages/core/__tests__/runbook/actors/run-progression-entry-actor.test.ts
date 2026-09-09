import { describe, expect, it, jest } from '@jest/globals';
import { createActor, toPromise, type PromiseActorLogic } from 'xstate';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../../src/testing/effective-vars.js';
import {
  runProgressionEntryActor,
  runProgressionFrontierActor,
  type EnterRunProgressionUnit,
  type ProjectRunProgressionFrontier,
} from '../../../src/runbook/actors/run-progression-entry-actor.js';
import type { ExecutionUnitEntry } from '../../../src/runbook/execution-unit-entry.js';
import type { FencedReEntryProjection } from '../../../src/runbook/re-entry-frontier.js';
import { CURRENT_SCHEMA_VERSION } from '../../../src/runbook/index.js';
import { assertRunId } from '../../../src/runbook/run-id.js';
import { buildFrameKey } from '../../../src/runbook/targeting.js';
import type { DelegateFrontierEntry } from '../../../src/events/types.js';
import type { RunbookState } from '../../../src/runbook/types.js';

// Both actors are one-line pass-through wrappers, which is exactly why they
// need their own pins: nothing else in the suite asserts what they RETURN. Emptying either
// body (`async () => undefined`) or its returned object left every core test
// passing, so the machine could have been handed `undefined` in place of a
// projection or an entry and no test would have noticed.
//
// The pass-through is also the invariant worth protecting. The entry actor
// returns the state it was GIVEN beside the entry rendered from it, so the
// observation and the runtime's cursor cannot describe two different versions
// of one run — an identity assertion, not a structural one.

const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function state(): RunbookState {
  return {
    prompted: false,
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
    resolvedCompletions: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    frontmatterOutputs: [],
  };
}

/** The shape both actors under test share: a `fromPromise` over one input. */
type ActorLogicFor<TInput, TOutput> = PromiseActorLogic<TOutput, TInput>;

/**
 * Run one of this module's actors to completion and return its output.
 *
 * `toPromise` is the same settle-the-actor helper production uses, so the
 * actor is driven here exactly as the machine drives it.
 *
 * @param logic - The actor logic under test.
 * @param input - The actor's typed input.
 * @returns The actor's resolved output.
 */
async function runToOutput<TInput, TOutput>(
  logic: ActorLogicFor<TInput, TOutput>,
  input: TInput,
): Promise<TOutput> {
  const actor = createActor(logic, { input });
  actor.start();
  return await toPromise(actor);
}

describe('runProgressionFrontierActor', () => {
  it('resolves the projection its bound callable returned, against the state it was given', async () => {
    const selected = state();
    const projection: FencedReEntryProjection = {
      status: 'projected',
      state: selected,
      frontier: [{ id: '1.1', runbook: 'child.runbook.md', token: 'rdtk_frontier' }],
    };
    const project = jest.fn<ProjectRunProgressionFrontier>().mockResolvedValue(projection);

    const output = await runToOutput(runProgressionFrontierActor, {
      state: selected,
      project,
    });

    // Identity on both sides: the callable is asked about THIS state, and the
    // machine receives THAT projection — the transient bearers included, which
    // the projected-frontier entry state discloses exactly once. Read off
    // `mock.calls` rather than through `toHaveBeenCalledWith`, which compares
    // by deep equality (and, on a type this size, exhausts the checker).
    expect(project.mock.calls[0]?.[0]).toBe(selected);
    expect(output).toBe(projection);
  });

  it('resolves a refusal arm as itself rather than flattening it', async () => {
    // The actor owns no frontier policy, so a refusal must reach the machine
    // shaped as the seam produced it; the machine, not the actor, classifies it.
    const refused: FencedReEntryProjection = {
      status: 'projection_refused',
      message: 'the deriver is not the frontier issuer',
    };
    const project = jest.fn<ProjectRunProgressionFrontier>().mockResolvedValue(refused);

    const output = await runToOutput(runProgressionFrontierActor, {
      state: state(),
      project,
    });

    expect(output).toEqual(refused);
  });
});

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

  it('passes the disclosed frontier through to the entry render', async () => {
    const selected = state();
    const frontier: readonly DelegateFrontierEntry[] = [
      { id: '1.1', runbook: 'child.runbook.md', token: 'rdtk_disclosed' },
    ];
    const enter = jest.fn<EnterRunProgressionUnit>().mockResolvedValue(entered);

    await runToOutput(runProgressionEntryActor, { state: selected, enter, frontier });

    expect(enter.mock.calls[0]?.[0]).toBe(selected);
    expect(enter.mock.calls[0]?.[1]).toBe(frontier);
  });

  it('renders the ordinary entry with no frontier at all', async () => {
    // `__progression-enter-unit` invokes the same actor without bearers, and
    // "absent" must reach the render as absent — never as an empty list, which
    // a re-entry with nothing left to disclose means instead.
    const selected = state();
    const enter = jest.fn<EnterRunProgressionUnit>().mockResolvedValue(entered);

    await runToOutput(runProgressionEntryActor, { state: selected, enter });

    expect(enter.mock.calls[0]?.[1]).toBeUndefined();
  });
});
