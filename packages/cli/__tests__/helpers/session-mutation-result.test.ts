// packages/cli/__tests__/helpers/session-mutation-result.test.ts
//
// Dedicated coverage for the single CLI rendering of a session ownership
// refusal (#608). The end-to-end path is pinned by `prune.test.ts`, but that
// test reaches the command through `runCliInProcess`'s dynamic `import()`, so
// jest's static inverse module graph cannot attribute the execution back to this
// module. These direct calls are what make the mapping and the exit disposition
// observable to a scoped mutation run.

import { describe, it, expect, jest } from '@jest/globals';
import type { ExecutionEpoch, RunId, SessionMutationRefusalOutcome } from '@rundown-org/core';
import {
  isSessionMutationRefusal,
  isTransactionalMutationRefusal,
  renderSessionMutationRefusal,
  renderTransactionalMutationRefusal,
  sessionMutationRefusalCode,
  transactionalRefusalCode,
  type TransactionalMutationRefusal,
} from '../../src/helpers/session-mutation-result.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// ---------------------------------------------------------------------------
// F12 — the CLI union must be DERIVED from core's, never re-declared.
//
// A hand-restatement compiles, but it silently de-brands `RunId` /
// `ExecutionEpoch` down to `string` / `number` and drops fields core does carry
// (`runId` on the CAS refusals). The result is a structurally parallel result
// type — exactly what the PR 11-head planning audit forbids. These assertions
// fail to compile the moment the union stops being core's.
// ---------------------------------------------------------------------------

/** The CAS refusal arms carry core's branded `runId`, not a dropped field. */
type ClaimSupersededArm = Extract<TransactionalMutationRefusal, { kind: 'claim_superseded' }>;
const _claimSupersededKeepsBrandedRunId = (arm: ClaimSupersededArm): RunId => arm.runId;
void _claimSupersededKeepsBrandedRunId;

/** The aggregate arm's attempts keep both brands. */
type AggregateAttempt = Extract<
  TransactionalMutationRefusal,
  { kind: 'aggregate_recovery_required' }
>['attempts'][number];
const _aggregateAttemptKeepsBrands = (
  attempt: AggregateAttempt,
): { runId: RunId; epoch: ExecutionEpoch } => attempt;
void _aggregateAttemptKeepsBrands;

const RUN_ID = `rd_${'1'.repeat(32)}` as SessionMutationRefusalOutcome['runId'];

const executionInProgress = {
  kind: 'execution_in_progress',
  runId: RUN_ID,
  message: `Run ${RUN_ID} has an execution in progress.`,
} as SessionMutationRefusalOutcome;

const recoveryRequired = {
  kind: 'recovery_required',
  runId: RUN_ID,
  epoch: 7,
  message: `Run ${RUN_ID} ended execution with an unknown outcome at epoch 7; run recovery before continuing.`,
} as unknown as SessionMutationRefusalOutcome;

function makeOutput(): { emitter: OutputEmitter; error: jest.Mock } {
  const error = jest.fn();
  return { emitter: { error } as unknown as OutputEmitter, error };
}

describe('sessionMutationRefusalCode', () => {
  it('maps each refusal kind to its registered symbolic code', () => {
    // Both codes are members of CLISymbolicErrorCodeValues and are documented in
    // docs/spec/cli-output.md; the drift guard checks the doc side, this checks
    // that the CLI actually emits those exact spellings.
    expect(sessionMutationRefusalCode(executionInProgress)).toBe('EXECUTION_IN_PROGRESS');
    expect(sessionMutationRefusalCode(recoveryRequired)).toBe('RECOVERY_REQUIRED');
  });

  it('throws rather than emitting an unregistered code for an unknown kind', () => {
    // The exhaustive guard is unreachable through the type system; drive it
    // through a cast so a future refusal arm added to core cannot silently reach
    // output under no code at all.
    const unknown = { kind: 'claim_superseded', runId: RUN_ID, message: 'nope' };
    expect(() => sessionMutationRefusalCode(unknown as SessionMutationRefusalOutcome)).toThrow(
      /Unhandled session mutation refusal: claim_superseded/,
    );
  });

  it('names only the discriminant of an unknown refusal, never its payload', () => {
    // An unrecognized variant is one whose fields this build does not know, so
    // the guard must not serialize it wholesale into an error message that
    // reaches stderr and logs.
    const unknown = {
      kind: 'future_refusal',
      runId: RUN_ID,
      message: 'nope',
      claimId: 'rdc_secret_bearer_value',
    };

    expect(() => sessionMutationRefusalCode(unknown as SessionMutationRefusalOutcome)).toThrow(
      'Unhandled session mutation refusal: future_refusal',
    );
    try {
      sessionMutationRefusalCode(unknown as SessionMutationRefusalOutcome);
    } catch (error) {
      const thrown = error as Error;
      expect(thrown.message).not.toContain('rdc_secret_bearer_value');
      expect(thrown.message).not.toContain(RUN_ID);
    }
    expect.assertions(3);
  });
});

describe('renderSessionMutationRefusal', () => {
  it.each([
    { label: 'execution_in_progress', refusal: executionInProgress, code: 'EXECUTION_IN_PROGRESS' },
    { label: 'recovery_required', refusal: recoveryRequired, code: 'RECOVERY_REQUIRED' },
  ])("emits core's message verbatim under the $label code", ({ refusal, code }) => {
    const { emitter, error } = makeOutput();

    const exitError = renderSessionMutationRefusal(emitter, refusal);

    // The message is forwarded, never re-synthesized: it already names the run,
    // and the documented error envelope carries no run-id field of its own.
    expect(error).toHaveBeenCalledWith(refusal.message, code);
    expect(error).toHaveBeenCalledTimes(1);
    // An ownership refusal always requests a non-zero exit code.
    expect(exitError).toBe(true);
  });
});

describe('isSessionMutationRefusal', () => {
  it.each([{ kind: 'execution_in_progress' }, { kind: 'recovery_required' }])(
    'narrows $kind to a refusal',
    (outcome) => {
      expect(isSessionMutationRefusal(outcome)).toBe(true);
    },
  );

  it.each([
    { kind: 'removed' },
    { kind: 'empty-stack' },
    { kind: 'healthy-top' },
    { kind: 'committed' },
  ])('leaves $kind alone', (outcome) => {
    // OrphanCleanupResult's own arms, plus the committed arm: narrowing must not
    // capture any of them, or `terminal-command.ts` would render a cleanup
    // success as a refusal.
    expect(isSessionMutationRefusal(outcome)).toBe(false);
  });
});

describe('isTransactionalMutationRefusal', () => {
  // Restated INDEPENDENTLY of the source's own key map, and held to the union by
  // the same `satisfies Record<…, true>` obligation: a refusal arm added to
  // `TransactionalMutationRefusal` fails to compile here as well as in the
  // module, so this list cannot quietly lag the guard it checks.
  const everyRefusalKind = Object.keys({
    claim_superseded: true,
    concurrent_modification: true,
    execution_in_progress: true,
    recovery_required: true,
    missing: true,
    aggregate_recovery_required: true,
  } satisfies Record<TransactionalMutationRefusal['kind'], true>);

  it.each(everyRefusalKind)('narrows %s to a transactional refusal', (kind) => {
    expect(isTransactionalMutationRefusal({ kind })).toBe(true);
  });

  it.each([
    { kind: 'committed' },
    { kind: 'allowed' },
    { kind: 'collection_applied' },
    { kind: 'already_collected' },
    { kind: 'collection_failed' },
    { kind: 'open_claims' },
  ])('leaves $kind alone', (outcome) => {
    // The committed arm plus `CollectionWorkflowResult`'s own policy members:
    // narrowing must not capture any of them, or `collect.ts` would render a
    // successful aggregation as a refusal and exit non-zero.
    expect(isTransactionalMutationRefusal(outcome)).toBe(false);
  });
});

describe('renderTransactionalMutationRefusal', () => {
  it.each([
    { refusal: executionInProgress, code: 'EXECUTION_IN_PROGRESS' },
    { refusal: recoveryRequired, code: 'RECOVERY_REQUIRED' },
  ])(
    'renders the $refusal.kind ownership refusal through the shared mapping',
    ({ refusal, code }) => {
      const { emitter, error } = makeOutput();

      expect(renderTransactionalMutationRefusal(emitter, refusal)).toBe(true);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(refusal.message, code);
    },
  );

  // Each fixture carries `runId` because core's CAS refusals do — the union is
  // derived from them, so a fixture that omits it no longer type-checks.
  it.each([
    {
      kind: 'claim_superseded' as const,
      runId: RUN_ID,
      message: 'superseded',
      code: 'STALE_CLAIM',
    },
    {
      kind: 'concurrent_modification' as const,
      runId: RUN_ID,
      message: 'changed concurrently',
      code: 'CONCURRENT_MODIFICATION',
    },
    {
      kind: 'missing' as const,
      runId: RUN_ID,
      message: 'missing run',
      code: 'RUN_TARGET_UNAVAILABLE',
    },
  ])('renders $kind with its exact message and code', (refusal) => {
    const { emitter, error } = makeOutput();

    expect(renderTransactionalMutationRefusal(emitter, refusal)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(refusal.message, refusal.code);
  });

  it('renders every aggregate recovery attempt under the distinct aggregate code', () => {
    // A multi-run refusal is NOT the single-run `recovery_required` arm: it
    // carries a set, and `details.runs` only exists here. Collapsing the two
    // onto one wire code makes the two shapes indistinguishable to an agent
    // that routes on `code`.
    const { emitter, error } = makeOutput();
    const refusal = {
      kind: 'aggregate_recovery_required' as const,
      message: 'recover these runs',
      attempts: [
        { runId: `rd_${'2'.repeat(32)}` as RunId, epoch: 3 as ExecutionEpoch },
        { runId: `rd_${'3'.repeat(32)}` as RunId, epoch: 4 as ExecutionEpoch },
      ],
    };

    expect(renderTransactionalMutationRefusal(emitter, refusal)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('recover these runs', 'AGGREGATE_RECOVERY_REQUIRED', {
      runs: [
        { runId: refusal.attempts[0].runId, epoch: 3 },
        { runId: refusal.attempts[1].runId, epoch: 4 },
      ],
    });
  });

  it('throws rather than emitting no code at all for an unrecognized refusal kind', () => {
    // The six-member union is the one place that owns the full mapping, so it
    // is the one place a `never` guard has to exist. Without it a new core arm
    // falls off the end of the switch and `output.error` is never called: the
    // command exits 1 with a silent, empty envelope.
    const { emitter, error } = makeOutput();
    const unknown = { kind: 'future_refusal', message: 'nope' };

    expect(() =>
      renderTransactionalMutationRefusal(emitter, unknown as TransactionalMutationRefusal),
    ).toThrow('Unhandled transactional mutation refusal: future_refusal');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('transactionalRefusalCode', () => {
  // The sites that need the CODE rather than the rendering (goto-workflow's
  // structured result, execution.ts's ERROR_OCCURRED payload) call this instead
  // of restating the map. One mapping, two consumers.
  it.each([
    { refusal: executionInProgress, code: 'EXECUTION_IN_PROGRESS' },
    { refusal: recoveryRequired, code: 'RECOVERY_REQUIRED' },
    {
      refusal: { kind: 'claim_superseded', runId: RUN_ID, message: 'superseded' },
      code: 'STALE_CLAIM',
    },
    {
      refusal: { kind: 'concurrent_modification', runId: RUN_ID, message: 'changed' },
      code: 'CONCURRENT_MODIFICATION',
    },
    {
      refusal: { kind: 'missing', runId: RUN_ID, message: 'missing run' },
      code: 'RUN_TARGET_UNAVAILABLE',
    },
    {
      refusal: {
        kind: 'aggregate_recovery_required',
        message: 'recover these runs',
        attempts: [{ runId: RUN_ID, epoch: 2 }],
      },
      code: 'AGGREGATE_RECOVERY_REQUIRED',
    },
  ])('maps $refusal.kind to $code', ({ refusal, code }) => {
    expect(transactionalRefusalCode(refusal as TransactionalMutationRefusal)).toBe(code);
  });

  it('names only the discriminant of an unknown refusal, never its payload', () => {
    const unknown = {
      kind: 'future_refusal',
      runId: RUN_ID,
      message: 'nope',
      claimId: 'rdc_secret_bearer_value',
    };

    try {
      transactionalRefusalCode(unknown as TransactionalMutationRefusal);
    } catch (error) {
      const thrown = error as Error;
      expect(thrown.message).toBe('Unhandled transactional mutation refusal: future_refusal');
      expect(thrown.message).not.toContain('rdc_secret_bearer_value');
      expect(thrown.message).not.toContain(RUN_ID);
    }
    expect.assertions(3);
  });
});
