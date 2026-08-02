// packages/cli/__tests__/helpers/session-mutation-result.test.ts
//
// Dedicated coverage for the single CLI rendering of a session ownership
// refusal (#608). The end-to-end path is pinned by `prune.test.ts`, but that
// test reaches the command through `runCliInProcess`'s dynamic `import()`, so
// jest's static inverse module graph cannot attribute the execution back to this
// module. These direct calls are what make the mapping and the exit disposition
// observable to a scoped mutation run.

import { describe, it, expect, jest } from '@jest/globals';
import type { SessionMutationRefusalOutcome } from '@rundown-org/core';
import {
  isSessionMutationRefusal,
  renderSessionMutationRefusal,
  renderTransactionalMutationRefusal,
  sessionMutationRefusalCode,
} from '../../src/helpers/session-mutation-result.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

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
      /Unhandled session mutation refusal/,
    );
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

  it.each([
    { kind: 'claim_superseded' as const, message: 'superseded', code: 'STALE_CLAIM' },
    {
      kind: 'concurrent_modification' as const,
      message: 'changed concurrently',
      code: 'CONCURRENT_MODIFICATION',
    },
    { kind: 'missing' as const, message: 'missing run', code: 'RUN_TARGET_UNAVAILABLE' },
  ])('renders $kind with its exact message and code', (refusal) => {
    const { emitter, error } = makeOutput();

    expect(renderTransactionalMutationRefusal(emitter, refusal)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(refusal.message, refusal.code);
  });

  it('renders every aggregate recovery attempt with a numeric epoch', () => {
    const { emitter, error } = makeOutput();
    const refusal = {
      kind: 'aggregate_recovery_required' as const,
      message: 'recover these runs',
      attempts: [
        { runId: `rd_${'2'.repeat(32)}`, epoch: 3 },
        { runId: `rd_${'3'.repeat(32)}`, epoch: 4 },
      ],
    };

    expect(renderTransactionalMutationRefusal(emitter, refusal)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('recover these runs', 'RECOVERY_REQUIRED', {
      runs: [
        { runId: refusal.attempts[0].runId, epoch: 3 },
        { runId: refusal.attempts[1].runId, epoch: 4 },
      ],
    });
  });
});
