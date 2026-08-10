import { describe, expect, it, jest } from '@jest/globals';
import type { ActorSyncResult } from '../../src/runbook/actor-service.js';
import type { VerifiedClaimAuthority } from '../../src/runbook/claim-id.js';
import {
  createDelegationCredentialIssuer,
  createDelegationTokenDeriver,
  type DelegationTokenDeriver,
} from '../../src/runbook/delegation-credential.js';
import {
  assertDelegationIssuanceNonce,
  assertDelegationTokenHash,
} from '../../src/runbook/delegation-token.js';
import { assertClaimId, assertClaimLookupKey, assertRunId } from '../../src/runbook/index.js';
import {
  projectAndConsumeReEntryFrontier,
  readPersistedReEntryFrontier,
  type ReEntryFrontierActorService,
} from '../../src/runbook/re-entry-frontier.js';
import { InvalidRunbookStateError } from '../../src/runbook/state.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type {
  PersistedDelegateFrontierEntry,
  ResolvedStep,
  RunbookState,
} from '../../src/runbook/types.js';
import type {
  ExecutionObservationEffect,
  StepEntryMetadata,
} from '../../src/events/execution-observation.js';
import {
  brandStoredOutputsForTest,
  brandInitialTemplateVarsForTest,
} from '../../src/testing/effective-vars.js';
import { makeResolvedStepWithSubsteps, makeSubstep } from '../helpers/step-factories.js';

// This suite drives `re-entry-frontier.ts` directly rather than through
// `collectDelegationOutcomes`. Two reasons it earns its own file:
//
//   * `readPersistedReEntryFrontier` is a public reader with a caller that is
//     NOT the seam — the CLI execution loop calls it standalone to decide
//     whether a continuation lacking a deriver must refuse
//     (`ACTOR_CONTEXT_REQUIRED`). That branch turns on `.length > 0`, so the
//     reader's empty/non-empty boundary and its rejection set are load-bearing
//     security behaviour, not incidental parsing.
//   * `ReEntryFrontierActorService` is deliberately a structural `Pick`, so the
//     seam's four arms can be pinned against a double without a state manager,
//     a temp directory, or a real machine. That keeps every arm — including the
//     two refusals, which a real actor service would never produce on demand —
//     reachable and cheap.

const runId = assertRunId('rd_11111111111111111111111111111111');
const otherRunId = assertRunId('rd_22222222222222222222222222222222');
const claimId = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const claimKey = assertClaimLookupKey('rdclk_11111111111111111111111111111111');
// A second, unrelated verified authority. Its deriver reproduces nothing issued
// by `authority`, which is exactly the rotated/foreign-issuer condition the
// `projection_refused` arm exists for.
const foreignClaimId = assertClaimId(
  'rdclm_99999999999999999999999999999999_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const foreignClaimKey = assertClaimLookupKey('rdclk_99999999999999999999999999999999');

const authority: VerifiedClaimAuthority = { kind: 'bearer', claimId, claimKey };
const foreignAuthority: VerifiedClaimAuthority = {
  kind: 'bearer',
  claimId: foreignClaimId,
  claimKey: foreignClaimKey,
};

const deriveToken: DelegationTokenDeriver = createDelegationTokenDeriver(authority);
const deriveForeignToken: DelegationTokenDeriver = createDelegationTokenDeriver(foreignAuthority);

/**
 * Issue a real frontier entry: persisted (non-secret) plus its public projection.
 *
 * Deliberately built through the production issuer rather than hand-rolled, so
 * `deriveToken` genuinely reproduces the bearer and the persisted `tokenHash`
 * genuinely verifies it. A hand-written descriptor would refuse projection for
 * the wrong reason and make the `projected` arm unreachable.
 */
function frontierEntry(id = '1.1', runbook = 'child-a.md', nonce = 'A') {
  const issued = createDelegationCredentialIssuer(authority, () =>
    assertDelegationIssuanceNonce(`${nonce.repeat(42)}A`),
  )({
    parentRunId: runId,
    parentStepId: id,
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
  });
  return {
    persisted: {
      id,
      runbook,
      credential: issued.credential,
      tokenHash: issued.tokenHash,
    } satisfies PersistedDelegateFrontierEntry,
    public: { id, runbook, token: issued.token },
  };
}

const steps: readonly ResolvedStep[] = [
  makeResolvedStepWithSubsteps({
    name: '1',
    substeps: [makeSubstep({ id: '1', delegate: true }), makeSubstep({ id: '2', delegate: true })],
  }),
];

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    templateVars: brandInitialTemplateVarsForTest({}),
    id: runId,
    runbook: { source: 'project', path: 're-entry-test.md' },
    runbookPath: 're-entry-test.md',
    step: '1',
    substep: '1',
    stepName: 'Delegate work',
    retryCount: 1,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    lifecycle: 'running',
    startedAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    substepStates: [],
    resolvedCompletions: {},
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

/** A run whose persisted snapshot carries exactly the given `delegateFrontier` value. */
function stateWithFrontier(delegateFrontier: unknown): RunbookState {
  return state({ snapshot: { context: { delegateFrontier } } });
}

/** Rendered entry metadata for a substep — the only shape that can carry a frontier. */
const substepEntry: Omit<StepEntryMetadata, 'delegateFrontier'> = {
  stepId: '1',
  substepId: '1',
  position: { current: '1', total: 1, substep: '1' },
  stepName: '1',
  description: 'Delegate A',
  prompt: 'Dispatch the child',
  isSubstep: true,
  prompted: false,
};

/** The same rendering for a cursor that has advanced off the substeps. */
const stepEntry: Omit<StepEntryMetadata, 'delegateFrontier'> = {
  stepId: '1',
  position: { current: '1', total: 1 },
  stepName: '1',
  isSubstep: false,
  prompted: false,
};

function observationEffect(stepName: string): ExecutionObservationEffect {
  return {
    kind: 'execution_observation',
    event: {
      type: 'STEP_ENTERED',
      payload: {
        position: { current: '1', total: 1, substep: '1' },
        stepName,
        hasCommand: false,
        isSubstep: true,
        prompted: false,
        artifacts: {},
      },
    },
  };
}

/**
 * Build a structural {@link ReEntryFrontierActorService} double that records call order.
 *
 * `calls` is what pins the seam's stated ordering guarantee — observe, then
 * commit the consume — independently of the arm the seam returns.
 */
function makeActorService(
  options: {
    readonly observations?: readonly ExecutionObservationEffect[];
    readonly consumed?: ActorSyncResult | null;
  } = {},
) {
  const observations = options.observations ?? [observationEffect('1')];
  const consumed =
    options.consumed === undefined
      ? ({
          state: state({ substep: '2', updatedAt: '2026-07-21T00:05:00.000Z' }),
          snapshot: { context: {} },
          effects: [],
        } satisfies ActorSyncResult)
      : options.consumed;
  const calls: string[] = [];
  const observeExecutionUnitEntry = jest
    .fn<ReEntryFrontierActorService['observeExecutionUnitEntry']>()
    .mockImplementation(async () => {
      calls.push('observe');
      return observations;
    });
  const sendAndSync = jest
    .fn<ReEntryFrontierActorService['sendAndSync']>()
    .mockImplementation(async () => {
      calls.push('sendAndSync');
      return consumed;
    });
  const service: ReEntryFrontierActorService = { observeExecutionUnitEntry, sendAndSync };
  return { service, observeExecutionUnitEntry, sendAndSync, calls, observations, consumed };
}

describe('readPersistedReEntryFrontier', () => {
  it('returns empty when the run carries no persisted snapshot', () => {
    // `state.snapshot` is `unknown` and may be absent entirely (a run that has
    // never synced). The optional chain must yield `[]`, not throw.
    expect(readPersistedReEntryFrontier(state())).toEqual([]);
  });

  it('returns empty when the persisted snapshot carries no context', () => {
    expect(readPersistedReEntryFrontier(state({ snapshot: {} }))).toEqual([]);
  });

  it('returns empty when the persisted context carries no delegateFrontier', () => {
    // `rawFrontier === undefined` short-circuits. Distinguishes "no frontier
    // field" (fine) from "frontier field holding a non-array" (corrupt, below).
    expect(readPersistedReEntryFrontier(state({ snapshot: { context: { step: '1' } } }))).toEqual(
      [],
    );
  });

  // ---------------------------------------------------------------------------
  // The empty/non-empty boundary. `packages/cli/src/services/execution.ts`
  // branches on `readPersistedReEntryFrontier(currentState).length > 0` to
  // refuse a continuation that would disclose a frontier it holds no authority
  // for (`ACTOR_CONTEXT_REQUIRED`). These two cases are the pair that separates
  // `> 0` from `>= 0`: the reader must report exactly 0 for an empty frontier
  // and exactly 1 for a single-entry one.
  // ---------------------------------------------------------------------------

  it('reports length 0 for an empty persisted frontier', () => {
    expect(readPersistedReEntryFrontier(stateWithFrontier([]))).toHaveLength(0);
  });

  it('reports length 1 for a single-entry persisted frontier', () => {
    const entry = frontierEntry();
    const frontier = readPersistedReEntryFrontier(stateWithFrontier([entry.persisted]));

    expect(frontier).toHaveLength(1);
    // Returned verbatim: a reader that dropped or re-shaped fields would leave
    // the seam unable to project, and would silently weaken the CLI's refusal.
    expect(frontier[0]).toEqual(entry.persisted);
  });

  it('preserves persisted order across multiple entries', () => {
    // Order is the disclosure order the agent dispatches children in, so a
    // reader that sorted or reversed would pair tokens with the wrong substeps.
    const first = frontierEntry('1.1', 'child-a.md', 'A');
    const second = frontierEntry('1.2', 'child-b.md', 'B');

    expect(
      readPersistedReEntryFrontier(stateWithFrontier([first.persisted, second.persisted])).map(
        (entry) => entry.id,
      ),
    ).toEqual(['1.1', '1.2']);
  });

  it('carries no plaintext bearer in the persisted frontier it returns', () => {
    // The reader's contract is that the persisted blob is non-secret. If a
    // bearer ever appeared here, the CLI's authority gate would be moot.
    const frontier = readPersistedReEntryFrontier(stateWithFrontier([frontierEntry().persisted]));

    expect(JSON.stringify(frontier)).not.toMatch(/rdtk_/);
  });

  // ---------------------------------------------------------------------------
  // Rejection set. `snapshot` is `unknown`, so anything that is not an array of
  // structurally valid entries is corrupt/incompatible persisted state. Per the
  // no-migration rule the reader refuses rather than coercing — a reader that
  // returned `[]` for a populated-but-malformed frontier would silently disarm
  // the CLI refusal, which is the worst available failure mode.
  // ---------------------------------------------------------------------------

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'oops'],
    ['a number', 3],
    ['a plain object', {}],
    ['an array-like object', { 0: 'a', length: 1 }],
  ])('rejects a delegateFrontier that is %s', (_label, raw) => {
    expect(() => readPersistedReEntryFrontier(stateWithFrontier(raw))).toThrow(
      InvalidRunbookStateError,
    );
  });

  it('names the offending run in the refusal', () => {
    // The recovery path is explicit operator action (finish/stop/prune/restart)
    // on ONE run, so a refusal that does not identify it is not actionable.
    expect(() => readPersistedReEntryFrontier(stateWithFrontier('oops'))).toThrow(
      `Run ${runId} carries a malformed delegateFrontier in its persisted snapshot`,
    );
  });

  it('names the run it was actually given, not a constant', () => {
    expect(() =>
      readPersistedReEntryFrontier(state({ id: otherRunId, snapshot: { context: {} } })),
    ).not.toThrow();
    expect(() =>
      readPersistedReEntryFrontier(
        state({ id: otherRunId, snapshot: { context: { delegateFrontier: 'oops' } } }),
      ),
    ).toThrow(`Run ${otherRunId} carries a malformed`);
  });

  const valid = () => frontierEntry().persisted as unknown as Record<string, unknown>;

  it.each<[string, () => unknown]>([
    ['a primitive entry', () => 'not-an-object'],
    ['a null entry', () => null],
    ['an array entry', () => []],
    [
      'an entry missing its id',
      () => {
        const { id: _id, ...rest } = valid();
        return rest;
      },
    ],
    ['an entry whose id is empty', () => ({ ...valid(), id: '' })],
    ['an entry whose id is not a string', () => ({ ...valid(), id: 1 })],
    [
      'an entry missing its runbook',
      () => {
        const { runbook: _runbook, ...rest } = valid();
        return rest;
      },
    ],
    ['an entry whose runbook is empty', () => ({ ...valid(), runbook: '' })],
    [
      'an entry missing its credential descriptor',
      () => {
        const { credential: _credential, ...rest } = valid();
        return rest;
      },
    ],
    [
      'an entry whose credential names a non-positive parent entry',
      () => ({
        ...valid(),
        credential: { ...(valid().credential as object), parentEntry: 0 },
      }),
    ],
    [
      'an entry whose credential declares an unknown version',
      () => ({
        ...valid(),
        credential: { ...(valid().credential as object), version: 2 },
      }),
    ],
    [
      'an entry whose credential carries an unknown field',
      () => ({
        ...valid(),
        credential: { ...(valid().credential as object), token: 'rdtk_smuggled' },
      }),
    ],
    [
      'an entry missing its token hash',
      () => {
        const { tokenHash: _tokenHash, ...rest } = valid();
        return rest;
      },
    ],
    ['an entry whose token hash is not canonical', () => ({ ...valid(), tokenHash: 'nope' })],
    // `.strict()` matters here: an unknown key is how a plaintext bearer would
    // ride along inside a blob that otherwise looks well-formed.
    ['an entry carrying an unknown field', () => ({ ...valid(), token: 'rdtk_smuggled' })],
  ])('rejects a frontier containing %s', (_label, build) => {
    expect(() => readPersistedReEntryFrontier(stateWithFrontier([build()]))).toThrow(
      InvalidRunbookStateError,
    );
  });

  // The refusal reaches an operator as RD-309, whose envelope must name the run
  // in a field rather than only inside the message prose.
  it('carries the run and reason in the refusal defect', () => {
    const state = stateWithFrontier([{ id: '1.1' }]);

    let defect: unknown;
    try {
      readPersistedReEntryFrontier(state);
    } catch (error) {
      if (!(error instanceof InvalidRunbookStateError)) throw error;
      defect = error.defect;
    }

    expect(defect).toEqual({ runId: state.id, reason: 'malformed_delegate_frontier' });
  });

  it('rejects the whole frontier when only its last entry is malformed', () => {
    // Pins `.every` rather than `.some`/`.find`: one bad entry among good ones
    // must still refuse, or a corrupt blob would be partially trusted.
    expect(() =>
      readPersistedReEntryFrontier(
        stateWithFrontier([frontierEntry('1.1', 'child-a.md', 'A').persisted, { id: '1.2' }]),
      ),
    ).toThrow(InvalidRunbookStateError);
  });

  it('rejects the whole frontier when only its first entry is malformed', () => {
    expect(() =>
      readPersistedReEntryFrontier(
        stateWithFrontier([{ id: '1.1' }, frontierEntry('1.2', 'child-b.md', 'B').persisted]),
      ),
    ).toThrow(InvalidRunbookStateError);
  });

  it('accepts a frontier whose credential carries an optional supersedesTokenHash', () => {
    // The one optional descriptor field. A guard that required it (or rejected
    // it) would refuse legitimate rotated credentials as corrupt state.
    const base = frontierEntry();
    const rotated = {
      ...base.persisted,
      credential: {
        ...base.persisted.credential,
        supersedesTokenHash: assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`),
      },
    };

    expect(readPersistedReEntryFrontier(stateWithFrontier([rotated]))).toEqual([rotated]);
  });
});

describe('projectAndConsumeReEntryFrontier', () => {
  /** First recorded `observeExecutionUnitEntry` call, as a typed tuple. */
  function observedCall(actor: ReturnType<typeof makeActorService>) {
    expect(actor.observeExecutionUnitEntry).toHaveBeenCalledTimes(1);
    return actor.observeExecutionUnitEntry.mock.calls[0];
  }

  /** A deriver that fails the test if the seam reaches it. */
  function neverDerives(): DelegationTokenDeriver {
    return jest.fn<DelegationTokenDeriver>().mockImplementation(() => {
      throw new Error('deriveToken must not be called on the none arm');
    });
  }

  it('returns none when the run carries no persisted frontier', async () => {
    const actor = makeActorService();

    await expect(
      projectAndConsumeReEntryFrontier({
        actorService: actor.service,
        steps,
        state: state(),
        deriveToken: neverDerives(),
        entry: substepEntry,
      }),
    ).resolves.toEqual({ status: 'none' });
    expect(actor.calls).toEqual([]);
  });

  it('returns none for an empty persisted frontier without observing or consuming', async () => {
    // The `length === 0` gate. A mutant that fell through would observe an entry
    // with an empty frontier and then consume a frontier that is not there.
    const actor = makeActorService();

    await expect(
      projectAndConsumeReEntryFrontier({
        actorService: actor.service,
        steps,
        state: stateWithFrontier([]),
        deriveToken: neverDerives(),
        entry: substepEntry,
      }),
    ).resolves.toEqual({ status: 'none' });
    expect(actor.calls).toEqual([]);
  });

  it('returns none for a non-substep entry even when a frontier is persisted', async () => {
    // A step-level execution unit can never carry a frontier, so the seam must
    // not disclose one to it. The frontier stays persisted for the substep entry
    // that can legitimately receive it.
    const actor = makeActorService();

    await expect(
      projectAndConsumeReEntryFrontier({
        actorService: actor.service,
        steps,
        state: stateWithFrontier([frontierEntry().persisted]),
        deriveToken: neverDerives(),
        entry: stepEntry,
      }),
    ).resolves.toEqual({ status: 'none' });
    expect(actor.calls).toEqual([]);
  });

  it('validates the persisted blob before the non-substep short-circuit', async () => {
    // Read-then-gate, not gate-then-read: reordering would let a corrupt
    // snapshot pass unnoticed for every step-level entry, so the corruption
    // would only surface later, on a substep, far from its cause.
    const actor = makeActorService();

    await expect(
      projectAndConsumeReEntryFrontier({
        actorService: actor.service,
        steps,
        state: stateWithFrontier('oops'),
        deriveToken: neverDerives(),
        entry: stepEntry,
      }),
    ).rejects.toBeInstanceOf(InvalidRunbookStateError);
    expect(actor.calls).toEqual([]);
  });

  it('projects, observes and consumes a valid frontier', async () => {
    const entry = frontierEntry();
    const actor = makeActorService();

    const result = await projectAndConsumeReEntryFrontier({
      actorService: actor.service,
      steps,
      state: stateWithFrontier([entry.persisted]),
      deriveToken,
      entry: substepEntry,
    });

    expect(result).toEqual({
      status: 'projected',
      observations: actor.observations,
      state: actor.consumed?.state,
    });
    // The consumed state, NOT the input state: the caller continues from the
    // post-consume cursor, and returning the input state would re-offer a
    // frontier that has already been handed out.
    expect(result).toMatchObject({ status: 'projected', state: { substep: '2' } });
  });

  it('observes the caller entry augmented with the projected bearers', async () => {
    // The seam contributes `delegateFrontier` and nothing else — every other
    // field is the frontend's rendering decision and must survive untouched.
    const entry = frontierEntry();
    const actor = makeActorService();

    await projectAndConsumeReEntryFrontier({
      actorService: actor.service,
      steps,
      state: stateWithFrontier([entry.persisted]),
      deriveToken,
      entry: substepEntry,
    });

    // Asserted through `mock.calls` rather than `toHaveBeenCalledWith`: the
    // latter's tuple matcher recurses through `ResolvedStep` deeply enough to
    // trip TS2589 on this signature.
    const [observedRunId, observedSteps, observedEntry] = observedCall(actor);
    expect(observedRunId).toBe(runId);
    // The seam forwards the caller's steps verbatim; an emptied copy would make
    // the observation unresolvable against the machine.
    expect(observedSteps).toEqual(steps);
    expect(observedEntry).toEqual({ ...substepEntry, delegateFrontier: [entry.public] });
  });

  it('preserves persisted frontier order in the projected bearers', async () => {
    const first = frontierEntry('1.1', 'child-a.md', 'A');
    const second = frontierEntry('1.2', 'child-b.md', 'B');
    const actor = makeActorService();

    await projectAndConsumeReEntryFrontier({
      actorService: actor.service,
      steps,
      state: stateWithFrontier([first.persisted, second.persisted]),
      deriveToken,
      entry: substepEntry,
    });

    expect(observedCall(actor)[2].delegateFrontier).toEqual([first.public, second.public]);
  });

  it('commits the consume with DELEGATE_FRONTIER_CONSUMED on the same run', async () => {
    const actor = makeActorService();

    await projectAndConsumeReEntryFrontier({
      actorService: actor.service,
      steps,
      state: stateWithFrontier([frontierEntry().persisted]),
      deriveToken,
      entry: substepEntry,
    });

    expect(actor.sendAndSync).toHaveBeenCalledTimes(1);
    const consumeCall = actor.sendAndSync.mock.calls[0];
    expect(consumeCall[0]).toBe(runId);
    expect(consumeCall[1]).toEqual(steps);
    expect(consumeCall[2]).toEqual({ type: 'DELEGATE_FRONTIER_CONSUMED' });
  });

  it('observes the entry before committing the consume', async () => {
    // The documented ordering. Observing after the consume would leave a window
    // where the frontier is consumed but the bearers were never surfaced.
    const actor = makeActorService();

    await projectAndConsumeReEntryFrontier({
      actorService: actor.service,
      steps,
      state: stateWithFrontier([frontierEntry().persisted]),
      deriveToken,
      entry: substepEntry,
    });

    expect(actor.calls).toEqual(['observe', 'sendAndSync']);
  });

  it('refuses projection when the deriver is not the frontier issuer', async () => {
    // A rotated or foreign issuing claim. This is the disclosure boundary the
    // whole seam exists for: refuse rather than emit a continuation event
    // carrying bearers this authority cannot vouch for.
    const actor = makeActorService();

    await expect(
      projectAndConsumeReEntryFrontier({
        actorService: actor.service,
        steps,
        state: stateWithFrontier([frontierEntry().persisted]),
        deriveToken: deriveForeignToken,
        entry: substepEntry,
      }),
    ).resolves.toEqual({
      status: 'projection_refused',
      message: 'Delegation credential belongs to a different issuer claim',
    });
    // Nothing observed and nothing consumed: the frontier stays persisted, and
    // no bearer reached an observation.
    expect(actor.calls).toEqual([]);
  });

  it('refuses projection when the derived bearer does not match the persisted verifier', async () => {
    const base = frontierEntry();
    const tampered = {
      ...base.persisted,
      tokenHash: assertDelegationTokenHash(`sha256:${'0'.repeat(64)}`),
    };
    const actor = makeActorService();

    await expect(
      projectAndConsumeReEntryFrontier({
        actorService: actor.service,
        steps,
        state: stateWithFrontier([tampered]),
        deriveToken,
        entry: substepEntry,
      }),
    ).resolves.toEqual({
      status: 'projection_refused',
      // Names the frontier id, never a bearer — the refusal detail is surfaced
      // verbatim by both frontends, so it must stay safe to print.
      message: 'Derived delegation credential does not match frontier 1.1',
    });
    expect(actor.calls).toEqual([]);
  });

  it('never leaks a bearer through the refusal message', async () => {
    const base = frontierEntry();
    const actor = makeActorService();

    const result = await projectAndConsumeReEntryFrontier({
      actorService: actor.service,
      steps,
      state: stateWithFrontier([
        { ...base.persisted, tokenHash: assertDelegationTokenHash(`sha256:${'0'.repeat(64)}`) },
      ]),
      deriveToken,
      entry: substepEntry,
    });

    expect(result).toMatchObject({ status: 'projection_refused' });
    expect(JSON.stringify(result)).not.toMatch(/rdtk_/);
  });

  it('reports a non-Error projection failure as its string form', async () => {
    // `getErrorMessage`, not `error.message`: a thrown non-Error must still
    // produce a refusal with a readable message rather than `undefined`.
    const actor = makeActorService();

    await expect(
      projectAndConsumeReEntryFrontier({
        actorService: actor.service,
        steps,
        state: stateWithFrontier([frontierEntry().persisted]),
        deriveToken: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'derivation exploded';
        },
        entry: substepEntry,
      }),
    ).resolves.toEqual({ status: 'projection_refused', message: 'derivation exploded' });
    expect(actor.calls).toEqual([]);
  });

  it('withholds observations when the consume is not accepted', async () => {
    // The frontier is still persisted, so the next attempt re-projects it.
    // Returning the observations here would orphan the bearers they carry.
    const actor = makeActorService({ consumed: null });

    const result = await projectAndConsumeReEntryFrontier({
      actorService: actor.service,
      steps,
      state: stateWithFrontier([frontierEntry().persisted]),
      deriveToken,
      entry: substepEntry,
    });

    expect(result).toEqual({ status: 'consume_failed' });
    expect(result).not.toHaveProperty('observations');
    expect(result).not.toHaveProperty('state');
    // The entry WAS observed — the arm is about what is returned, not about
    // skipping the observation — so the ordering guarantee still holds.
    expect(actor.calls).toEqual(['observe', 'sendAndSync']);
  });

  it('carries no bearer in the consume_failed result', async () => {
    const actor = makeActorService({ consumed: null });

    const result = await projectAndConsumeReEntryFrontier({
      actorService: actor.service,
      steps,
      state: stateWithFrontier([frontierEntry().persisted]),
      deriveToken,
      entry: substepEntry,
    });

    expect(JSON.stringify(result)).not.toMatch(/rdtk_/);
  });

  it('propagates a malformed persisted frontier as InvalidRunbookStateError', async () => {
    const actor = makeActorService();

    await expect(
      projectAndConsumeReEntryFrontier({
        actorService: actor.service,
        steps,
        state: stateWithFrontier([{ id: '1.1', runbook: 'child-a.md' }]),
        deriveToken,
        entry: substepEntry,
      }),
    ).rejects.toBeInstanceOf(InvalidRunbookStateError);
    expect(actor.calls).toEqual([]);
  });
});
