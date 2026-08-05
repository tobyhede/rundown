import { describe, expect, it } from '@jest/globals';
import { StepDelegationSchema } from '../../src/schemas.js';
import type { DelegationCredentialIssuer } from '../../src/runbook/delegation-credential.js';
import {
  createDelegation,
  retryDelegation,
  type CreateDelegationResult,
  type RetryDelegationResult,
} from '../../src/runbook/delegation-service.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import {
  prepareManualDelegation,
  type ManualDelegationPreparationEvent,
  type ManualDelegationPreparationInput,
} from '../../src/runbook/manual-delegation-machine.js';
import type { RunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, RunbookState, SubstepState } from '../../src/runbook/types.js';
import { makeDelegationCredentialIssuer } from '../../src/testing/delegation-fixtures.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';
import { makeSimpleSteps, makeState, makeSteps } from './delegation-service-fixtures.js';

const CHILD_RUN_ID = brandRunIdForTest(`rd_${'d'.repeat(32)}`);
const PARENT_RUN_ID = brandRunIdForTest(`rd_${'e'.repeat(32)}`);

/** Attach a claimed child run to every issued delegation in the given substep states. */
function linkChildRun(
  substepStates: readonly SubstepState[],
  childRunId: RunId,
): readonly SubstepState[] {
  return substepStates.map((substep) =>
    substep.delegation === undefined
      ? substep
      : { ...substep, delegation: { ...substep.delegation, childRunId } },
  );
}

/** Issue a fresh delegation on substep `1.1` and return the prepared substep states. */
function issueFixture(): readonly SubstepState[] {
  const issued = prepareManualDelegation({
    state: makeState(),
    steps: makeSteps(),
    issueCredential: makeDelegationCredentialIssuer(),
    event: {
      type: 'ISSUE',
      stepId: '1.1',
      frameKey: buildFrameKey('1'),
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
    },
  });
  if (issued.status !== 'prepared') throw new Error('expected prepared issue');
  return issued.substepStates;
}

/** Build the typed ISSUE command every refusal fixture varies by step id alone. */
function issueEvent(stepId: string): Extract<ManualDelegationPreparationEvent, { type: 'ISSUE' }> {
  return {
    type: 'ISSUE',
    stepId,
    frameKey: buildFrameKey('1'),
    childRunbookPath: 'child.md',
    childRunbookRef: { source: 'project', path: 'child.md' },
  };
}

/** Captured state, resolved steps, and the typed command one refusal needs. */
interface RefusalFixture<E extends ManualDelegationPreparationEvent> {
  readonly state: RunbookState;
  readonly steps: readonly ResolvedStep[];
  readonly event: E;
}

type IssueRefusalFixture = RefusalFixture<
  Extract<ManualDelegationPreparationEvent, { type: 'ISSUE' }>
>;
type RetryRefusalFixture = RefusalFixture<
  Extract<ManualDelegationPreparationEvent, { type: 'RETRY' }>
>;

/**
 * Every `CreateDelegationResult` arm the ISSUE handler folds into `error`.
 *
 * Keyed by arm rather than listed, so the mapped type is total: adding a
 * refusal to {@link CreateDelegationResult} fails this table to compile, which
 * is the test-side mirror of the handler's `never` exhaustiveness guard. The
 * two arms excluded here are the ones with their own mapping — `created`
 * becomes `prepared`, `delegation_claimed` becomes `child_in_flight` — and both
 * are pinned by their own tests above.
 */
const ISSUE_REFUSAL_FIXTURES: {
  readonly [K in Exclude<
    CreateDelegationResult['status'],
    'created' | 'delegation_claimed'
  >]: () => IssueRefusalFixture;
} = {
  // Guard 0: a claimed child may not delegate further (single-level invariant).
  parent_is_delegated: () => ({
    state: makeState({
      parentLinkage: {
        kind: 'delegation',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
        tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      },
    }),
    steps: makeSteps(),
    event: issueEvent('1.1'),
  }),
  // Step '9' is absent from the resolved runbook.
  step_not_found: () => ({ state: makeState(), steps: makeSteps(), event: issueEvent('9.9') }),
  // Step '1' has substeps, so a bare step id cannot name a delegation target.
  substep_required: () => ({ state: makeState(), steps: makeSteps(), event: issueEvent('1') }),
  // Step '1' authors substeps '1' and '2' only.
  substep_not_found: () => ({ state: makeState(), steps: makeSteps(), event: issueEvent('1.9') }),
  // The captured frontier is step '1'; the command targets step '2'.
  step_not_current: () => ({ state: makeState(), steps: makeSteps('2'), event: issueEvent('2.1') }),
  // A bare step at the frontier exposes no substep to attach a delegation to.
  not_delegatable: () => ({ state: makeState(), steps: makeSimpleSteps(), event: issueEvent('1') }),
  // Substep '1' already carries an unclaimed, uncancelled delegation.
  delegation_exists: () => ({
    state: makeState({ substepStates: [...issueFixture()] }),
    steps: makeSteps(),
    event: issueEvent('1.1'),
  }),
};

/**
 * Every `RetryDelegationResult` arm the RETRY handler folds into `error`.
 *
 * Total over the union for the same reason as {@link ISSUE_REFUSAL_FIXTURES};
 * `retried` maps to `prepared` and `in_flight` to `child_in_flight`, each
 * pinned by its own test above.
 */
const RETRY_REFUSAL_FIXTURES: {
  readonly [K in Exclude<
    RetryDelegationResult['status'],
    'retried' | 'in_flight'
  >]: () => RetryRefusalFixture;
} = {
  // Substep '1' exists in the captured state but carries no delegation.
  not_found: () => ({
    state: makeState(),
    steps: makeSteps(),
    event: {
      type: 'RETRY',
      substepId: '1',
      frameKey: buildFrameKey('1'),
      allowLinkedChildRun: false,
    },
  }),
  // The delegation was issued while step '1' was current; the frontier moved on.
  not_current: () => ({
    state: makeState({ substepStates: [...issueFixture()], step: '2' }),
    steps: makeSteps(),
    event: {
      type: 'RETRY',
      substepId: '1',
      frameKey: buildFrameKey('1'),
      allowLinkedChildRun: false,
    },
  }),
  // A snapshot with no owning step predates the `contextSnapshot.step`
  // guarantee, so the currency check has nothing to compare against.
  error: () => ({
    state: makeState({
      substepStates: issueFixture().map((substep) => {
        if (substep.delegation === undefined) return substep;
        const { step: _droppedOwnerStep, ...staleSnapshot } = substep.delegation.contextSnapshot;
        return {
          ...substep,
          delegation: { ...substep.delegation, contextSnapshot: staleSnapshot },
        };
      }),
    }),
    steps: makeSteps(),
    event: {
      type: 'RETRY',
      substepId: '1',
      frameKey: buildFrameKey('1'),
      allowLinkedChildRun: false,
    },
  }),
};

/**
 * Drive one ISSUE fixture straight through `createDelegation`.
 *
 * Asserting `status: 'error'` alone cannot tell the arms apart, so a fixture
 * that drifted onto a neighbouring refusal would keep the suite green while
 * silently vacating the arm it claims to cover. Running the primitive with the
 * options the handler builds makes "this fixture reaches THAT arm" observable,
 * and hands back the exact `RundownError` the mapping must forward untouched.
 *
 * @param fixture - Captured state, resolved steps, and the typed issue command.
 * @returns The primitive's own discriminated result for the fixture.
 */
function refuseIssueDirectly(fixture: IssueRefusalFixture): CreateDelegationResult {
  return createDelegation(
    {
      state: fixture.state,
      stepId: fixture.event.stepId,
      childRunbookPath: fixture.event.childRunbookPath,
      childRunbookRef: fixture.event.childRunbookRef,
      ancestors: [],
      frameKey: fixture.event.frameKey,
      issueCredential: makeDelegationCredentialIssuer(),
    },
    fixture.steps,
  );
}

/**
 * Drive one RETRY fixture straight through `retryDelegation`.
 *
 * Same role as {@link refuseIssueDirectly} for the retry handler's arms.
 *
 * @param fixture - Captured state, resolved steps, and the typed retry command.
 * @returns The primitive's own discriminated result for the fixture.
 */
function refuseRetryDirectly(fixture: RetryRefusalFixture): RetryDelegationResult {
  return retryDelegation(
    {
      state: fixture.state,
      substepId: fixture.event.substepId,
      frameKey: fixture.event.frameKey,
      allowLinkedChildRun: fixture.event.allowLinkedChildRun,
      issueCredential: makeDelegationCredentialIssuer(),
    },
    fixture.steps,
  );
}

/** Outcome of one preparation call observed for both throw paths. */
interface ObservedPreparation {
  /** Value thrown synchronously out of `prepareManualDelegation`. */
  readonly caught: unknown;
  /** Errors that escaped asynchronously through Node's unhandled-error paths. */
  readonly unhandled: readonly unknown[];
}

/**
 * Run one preparation call while watching for asynchronously escaping errors.
 *
 * A throw raised inside an XState `assign` action does not propagate out of
 * `actor.send`; XState re-reports it on a later event-loop turn, which
 * terminates the process rather than reaching the CLI error envelope. Watching
 * both paths is what makes the distinction observable: the error must arrive at
 * `caught`, and `unhandled` must stay empty.
 *
 * @param input - Exact preparation input to dispatch.
 * @returns The synchronously caught value plus anything reported asynchronously.
 * @throws {Error} If the call returned normally instead of throwing.
 */
async function observePreparationThrow(
  input: ManualDelegationPreparationInput,
): Promise<ObservedPreparation> {
  const unhandled: unknown[] = [];
  const record = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  try {
    let threw = false;
    let caught: unknown;
    try {
      prepareManualDelegation(input);
    } catch (error) {
      threw = true;
      caught = error;
    }
    // XState reports an action throw on a later event-loop turn, so drain one
    // timer turn before concluding that nothing escaped asynchronously.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    if (!threw) throw new Error('expected prepareManualDelegation to throw');
    return { caught, unhandled };
  } finally {
    process.off('uncaughtException', record);
    process.off('unhandledRejection', record);
  }
}

describe('prepareManualDelegation', () => {
  it('prepares fresh issuance through a typed machine without mutating captured state', () => {
    const state = makeState();
    const captured = structuredClone(state);
    const result = prepareManualDelegation({
      state,
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(state).toEqual(captured);
    expect(result.substepStates[0]?.delegation).toEqual(
      expect.objectContaining({
        childRunbookPath: 'child.md',
        childRunId: null,
        credential: expect.objectContaining({ version: 1 }),
      }),
    );
  });

  it('prepares retry from the captured descriptor and supersedes its token hash', () => {
    const issuer = makeDelegationCredentialIssuer();
    const state = makeState();
    const issued = prepareManualDelegation({
      state,
      steps: makeSteps(),
      issueCredential: issuer,
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });
    if (issued.status !== 'prepared') throw new Error('expected prepared issue');
    const oldHash = issued.substepStates[0]?.delegation?.tokenHash;
    if (oldHash === undefined) throw new Error('expected issued token hash');

    const retried = prepareManualDelegation({
      state: { ...state, substepStates: [...issued.substepStates] },
      steps: makeSteps(),
      issueCredential: issuer,
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
      },
    });

    expect(retried.status).toBe('prepared');
    if (retried.status !== 'prepared') return;
    expect(retried.substepStates[0]?.delegation?.credential).toEqual(
      expect.objectContaining({ supersedesTokenHash: oldHash }),
    );
    expect(retried.substepStates[0]?.delegation?.tokenHash).not.toBe(oldHash);
  });

  it('threads ISSUE extraVars into the issued delegation and its inherited context', () => {
    const result = prepareManualDelegation({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: { region: 'ap-southeast-2' },
      },
    });

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    const delegation = result.substepStates[0]?.delegation;
    // `extraVars` is the ONLY channel an operator's `--input` has into the child.
    // Dropping it at this seam issues a delegation the child then resolves
    // against the parent's variables alone — a silently wrong run, not a refusal.
    expect(delegation?.extraVars).toEqual({ region: 'ap-southeast-2' });
    // Pinned on the snapshot as well because that is what the child actually
    // reads: carrying the value on the delegation row but omitting it from the
    // captured context would leave the operator's input equally invisible.
    expect(delegation?.contextSnapshot.vars).toEqual(
      expect.objectContaining({ region: 'ap-southeast-2' }),
    );
  });

  it('merges RETRY overrides over the inherited extraVars of the superseded delegation', () => {
    const issuer = makeDelegationCredentialIssuer();
    const state = makeState();
    const issued = prepareManualDelegation({
      state,
      steps: makeSteps(),
      issueCredential: issuer,
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: { region: 'us-east-1', tier: 'gold' },
      },
    });
    if (issued.status !== 'prepared') throw new Error('expected prepared issue');

    const retried = prepareManualDelegation({
      state: { ...state, substepStates: [...issued.substepStates] },
      steps: makeSteps(),
      issueCredential: issuer,
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
        overrides: { region: 'eu-west-1' },
      },
    });

    expect(retried.status).toBe('prepared');
    if (retried.status !== 'prepared') return;
    // Asymmetric on purpose: `region` must be REPLACED and `tier` must SURVIVE.
    // A seam that drops `overrides` keeps `us-east-1`; one that replaces the
    // inherited set wholesale loses `tier`. Only forwarding the overrides into
    // the documented merge satisfies both halves.
    expect(retried.substepStates[0]?.delegation?.extraVars).toEqual({
      region: 'eu-west-1',
      tier: 'gold',
    });
    expect(retried.substepStates[0]?.delegation?.contextSnapshot.vars).toEqual(
      expect.objectContaining({ region: 'eu-west-1', tier: 'gold' }),
    );
  });

  it('prepares parent cancellation through the typed abort event', () => {
    const state = makeState();
    const issued = prepareManualDelegation({
      state,
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });
    if (issued.status !== 'prepared') throw new Error('expected prepared issue');
    const issuedState = { ...state, substepStates: [...issued.substepStates] };

    const aborted = prepareManualDelegation({
      state: issuedState,
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ABORT',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        force: false,
      },
    });

    expect(aborted.status).toBe('prepared');
    if (aborted.status !== 'prepared') return;
    expect(issuedState.substepStates[0]?.delegation?.cancelledAt).toBeNull();
    expect(aborted.substepStates[0]?.delegation?.cancelledAt).toEqual(expect.any(String));
  });

  it('refuses a repeated abort as already_cancelled without a state change', () => {
    const state = makeState();
    const aborted = prepareManualDelegation({
      state: { ...state, substepStates: [...issueFixture()] },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });
    if (aborted.status !== 'prepared') throw new Error('expected prepared abort');

    const repeated = prepareManualDelegation({
      state: { ...state, substepStates: [...aborted.substepStates] },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });

    expect(repeated).toEqual({ status: 'already_cancelled' });
  });

  it('refuses aborting a claimed delegation with needs_force and its child run id', () => {
    const state = makeState();

    const refused = prepareManualDelegation({
      state: { ...state, substepStates: linkChildRun(issueFixture(), CHILD_RUN_ID) },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });

    expect(refused).toEqual({ status: 'needs_force', childRunId: CHILD_RUN_ID });
  });

  it('propagates the linked child run id when retry refuses an in-flight delegation', () => {
    const state = makeState();

    const refused = prepareManualDelegation({
      state: { ...state, substepStates: linkChildRun(issueFixture(), CHILD_RUN_ID) },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
      },
    });

    expect(refused.status).toBe('child_in_flight');
    if (refused.status !== 'child_in_flight') return;
    expect(refused.childRunId).toBe(CHILD_RUN_ID);
    expect(refused.error).toEqual(
      expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    );
  });

  it('propagates the claimed child run id when issuance refuses a live delegation', () => {
    const state = makeState();

    const refused = prepareManualDelegation({
      state: { ...state, substepStates: linkChildRun(issueFixture(), CHILD_RUN_ID) },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });

    expect(refused.status).toBe('child_in_flight');
    if (refused.status !== 'child_in_flight') return;
    expect(refused.childRunId).toBe(CHILD_RUN_ID);
    expect(refused.error).toEqual(
      expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    );
  });

  it('maps every other issue refusal to the generic error status', () => {
    const refused = prepareManualDelegation({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '9.9',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });

    expect(refused).toEqual({
      status: 'error',
      error: expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    });
  });

  it('maps every other retry refusal to the generic error status', () => {
    const refused = prepareManualDelegation({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
      },
    });

    expect(refused).toEqual({
      status: 'error',
      error: expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    });
  });

  // The ISSUE and RETRY handlers enumerate every refusal arm instead of
  // catching the tail with a bare `default`. Enumerating is only equivalent if
  // each named arm still forwards `result.error` verbatim, so each arm gets its
  // own case here rather than being represented by whichever refusal a generic
  // fixture happened to reach.
  it.each(Object.entries(ISSUE_REFUSAL_FIXTURES))(
    'maps the %s issue refusal to the generic error status with the primitive error',
    (arm, buildFixture) => {
      const fixture = buildFixture();
      const direct = refuseIssueDirectly(fixture);

      expect(direct.status).toBe(arm);
      if (direct.status === 'created' || direct.status === 'delegation_claimed') {
        throw new Error(`fixture for ${arm} reached ${direct.status}, which is not error-mapped`);
      }

      const mapped = prepareManualDelegation({
        ...fixture,
        issueCredential: makeDelegationCredentialIssuer(),
      });

      expect(mapped).toEqual({ status: 'error', error: direct.error });
      // Compared explicitly because `code` is a getter, not an own property, so
      // deep equality above never reads it — and the code is what the CLI error
      // envelope surfaces to the operator.
      expect((mapped as { readonly error: { readonly code: string } }).error.code).toBe(
        direct.error.code,
      );
    },
  );

  it.each(Object.entries(RETRY_REFUSAL_FIXTURES))(
    'maps the %s retry refusal to the generic error status with the primitive error',
    (arm, buildFixture) => {
      const fixture = buildFixture();
      const direct = refuseRetryDirectly(fixture);

      expect(direct.status).toBe(arm);
      if (direct.status === 'retried' || direct.status === 'in_flight') {
        throw new Error(`fixture for ${arm} reached ${direct.status}, which is not error-mapped`);
      }

      const mapped = prepareManualDelegation({
        ...fixture,
        issueCredential: makeDelegationCredentialIssuer(),
      });

      expect(mapped).toEqual({ status: 'error', error: direct.error });
      expect((mapped as { readonly error: { readonly code: string } }).error.code).toBe(
        direct.error.code,
      );
    },
  );

  it('maps an abort against a substep with no delegation to the generic error status', () => {
    const refused = prepareManualDelegation({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });

    expect(refused).toEqual({
      status: 'error',
      error: expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    });
  });

  it('rethrows an issuer throw from ISSUE unchanged instead of discarding it', async () => {
    const boom = new Error('issuer exploded during fresh issuance');
    const throwingIssuer: DelegationCredentialIssuer = () => {
      throw boom;
    };

    const { caught, unhandled } = await observePreparationThrow({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: throwingIssuer,
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });

    expect(caught).toBe(boom);
    expect(unhandled).toEqual([]);
  });

  it('rethrows an issuer throw from RETRY unchanged instead of discarding it', async () => {
    const boom = new Error('issuer exploded during retry');
    const throwingIssuer: DelegationCredentialIssuer = () => {
      throw boom;
    };

    const { caught, unhandled } = await observePreparationThrow({
      state: { ...makeState(), substepStates: [...issueFixture()] },
      steps: makeSteps(),
      issueCredential: throwingIssuer,
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
      },
    });

    expect(caught).toBe(boom);
    expect(unhandled).toEqual([]);
  });

  it('rethrows a primitive throw from ABORT unchanged instead of discarding it', async () => {
    const boom = new Error('captured state read exploded during abort');
    // `abortDelegation` takes no injected callable, so the failure is staged
    // where the primitive reads the captured state. The assertion is about the
    // action boundary, not about this particular read: any throw raised inside
    // the ABORT action must reach the caller.
    const hostileState: RunbookState = Object.defineProperty({ ...makeState() }, 'substepStates', {
      configurable: true,
      enumerable: true,
      get: () => {
        throw boom;
      },
    });

    const { caught, unhandled } = await observePreparationThrow({
      state: hostileState,
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });

    expect(caught).toBe(boom);
    expect(unhandled).toEqual([]);
  });

  it('still reports the generic failure when a dispatched event yields no result and no throw', () => {
    // An event the machine declares no handler for is dropped by XState, so
    // neither a result nor a captured throw lands in context. That is the only
    // case the generic guard is allowed to describe.
    expect(() =>
      prepareManualDelegation({
        state: makeState(),
        steps: makeSteps(),
        issueCredential: makeDelegationCredentialIssuer(),
        event: { type: 'UNHANDLED' } as unknown as ManualDelegationPreparationEvent,
      }),
    ).toThrow('Manual delegation machine produced no result.');
  });

  it('inherits the child run id brand from persisted-state validation, not a boundary assert', () => {
    // The live-child refusals surface `StepDelegation.childRunId` verbatim, so
    // the brand is guaranteed where the state is admitted rather than re-checked
    // downstream: a non-canonical id never survives the load that produces the
    // captured state the machine is handed. Pinned here because it is the reason
    // this module does not re-assert the brand itself.
    const delegation = issueFixture()[0]?.delegation;
    if (!delegation) throw new Error('expected an issued delegation');

    expect(
      StepDelegationSchema.safeParse({ ...delegation, childRunId: 'not-a-run-id' }).success,
    ).toBe(false);
    expect(
      StepDelegationSchema.safeParse({ ...delegation, childRunId: CHILD_RUN_ID }).success,
    ).toBe(true);
  });
});
