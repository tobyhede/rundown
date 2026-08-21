// packages/cli/__tests__/commands/claim-failure-envelope.test.ts
//
// Per-arm pin for `claimFailureToEnvelope`, the single mapping from a
// `rundown claim` refusal to the code and message the claimer receives.
//
// This mapping had no test of its own, which is how four distinct,
// correctly-discriminated reasons came to collapse onto `TOKEN_NOT_FOUND`
// (#807). Three of them are not about the token — it was found and it was
// valid — so the code sent the holder to check the one thing that was not
// wrong, and two of them are caused by a concurrent actor, the category
// CLAUDE.md requires be passed through as itself.
//
// Every arm is pinned by code AND message, character for character, so a drift
// in either shows up here rather than only in an agent's routing — and the
// table is keyed by reason with `satisfies Record<MappedReason, ArmCase>`, so
// the compiler, not a reader, is what keeps "every arm" true.

import { describe, it, expect } from '@jest/globals';
import { ErrorCodes, assertRunId } from '@rundown-org/core';
import { claimFailureToEnvelope, type ClaimFailureEnvelope } from '../../src/commands/claim.js';
import type { ClaimFailure } from '../../src/helpers/runbook-pipeline.js';

const PARENT_RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CHILD_RUN_ID = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const STEP_ID = '1';
// cspell:disable-next-line
const TOKEN = 'rdtk_AAAA…';

/** The refusal reasons this mapping owns — every `ClaimFailure` but the session arm. */
type MappedReason = Exclude<ClaimFailure, { reason: 'session-refused' }>['reason'];

/** One arm's input and the exact envelope it must produce. */
interface ArmCase {
  readonly failure: Exclude<ClaimFailure, { reason: 'session-refused' }>;
  readonly expected: ClaimFailureEnvelope;
}

/**
 * Every arm, keyed by reason, with the compiler holding the table exhaustive.
 *
 * `Record<MappedReason, ArmCase>` is what makes the header's claim true rather
 * than aspirational: a missing reason is a "property is missing" error and a
 * reason the union does not have is an excess-property error. The array this
 * replaced covered 8 of the 14 arms, so a future edit mis-coding
 * `linkage-mismatch` or `concurrent-modification` onto `TOKEN_NOT_FOUND` — the
 * exact #807 defect class — passed the suite that exists to catch it, and the
 * property test below filtered the table rather than the union, so it could
 * only ever check the arms already listed.
 */
const ARM_CASES = {
  'invalid-token': {
    failure: { reason: 'invalid-token', token: TOKEN },
    expected: {
      code: 'INVALID_TOKEN',
      message: 'Invalid token format. Tokens must start with "rdtk_".',
      details: { token: TOKEN },
    },
  },
  'token-not-found': {
    failure: { reason: 'token-not-found', token: TOKEN },
    expected: {
      code: 'TOKEN_NOT_FOUND',
      message: 'No active run contains a delegation with this token.',
      details: { token: TOKEN },
    },
  },
  'parent-missing': {
    failure: { reason: 'parent-missing', parentRunId: PARENT_RUN_ID },
    expected: {
      code: 'PARENT_RUN_MISSING',
      message: `Parent run ${PARENT_RUN_ID} no longer exists.`,
      details: { parentRunId: PARENT_RUN_ID },
    },
  },
  'parent-ended': {
    failure: {
      reason: 'parent-ended',
      parentRunId: PARENT_RUN_ID,
      lifecycle: 'stopped',
    },
    expected: {
      code: 'DELEGATION_SUPERSEDED',
      message: `Parent run ${PARENT_RUN_ID} has been stopped. ${ErrorCodes.DELEGATION_SUPERSEDED.description}`,
      details: { parentRunId: PARENT_RUN_ID, lifecycle: 'stopped' },
    },
  },
  'delegation-removed': {
    failure: { reason: 'delegation-removed', parentRunId: PARENT_RUN_ID, stepId: STEP_ID },
    expected: {
      code: 'DELEGATION_SUPERSEDED',
      message: `Delegation no longer exists on parent step ${STEP_ID}. ${ErrorCodes.DELEGATION_SUPERSEDED.description}`,
      details: { parentRunId: PARENT_RUN_ID, stepId: STEP_ID },
    },
  },
  'delegation-cancelled': {
    failure: {
      reason: 'delegation-cancelled',
      parentRunId: PARENT_RUN_ID,
      stepId: STEP_ID,
      cancelledAt: '2026-08-21T10:00:00.000Z',
    },
    expected: {
      code: 'DELEGATION_CANCELLED',
      message: 'This delegation has been cancelled and cannot be claimed.',
      details: {
        parentRunId: PARENT_RUN_ID,
        stepId: STEP_ID,
        cancelledAt: '2026-08-21T10:00:00.000Z',
      },
    },
  },
  'delegation-superseded': {
    failure: {
      reason: 'delegation-superseded',
      parentRunId: PARENT_RUN_ID,
      stepId: STEP_ID,
      childRunId: CHILD_RUN_ID,
    },
    expected: {
      code: 'DELEGATION_SUPERSEDED',
      message: ErrorCodes.DELEGATION_SUPERSEDED.description,
      details: { parentRunId: PARENT_RUN_ID, stepId: STEP_ID, childRunId: CHILD_RUN_ID },
    },
  },
  'child-missing': {
    failure: {
      reason: 'child-missing',
      parentRunId: PARENT_RUN_ID,
      stepId: STEP_ID,
      childRunId: CHILD_RUN_ID,
    },
    expected: {
      code: 'CHILD_RUN_MISSING',
      message: `Child run ${CHILD_RUN_ID} no longer exists on disk. Delegation cannot be claimed.`,
      details: { parentRunId: PARENT_RUN_ID, stepId: STEP_ID, childRunId: CHILD_RUN_ID },
    },
  },
  'delegation-resolved': {
    failure: {
      reason: 'delegation-resolved',
      parentRunId: PARENT_RUN_ID,
      stepId: STEP_ID,
      childRunId: CHILD_RUN_ID,
    },
    expected: {
      code: 'DELEGATION_ALREADY_RESOLVED',
      message: 'This delegation has already been resolved and cannot be claimed again.',
      details: { parentRunId: PARENT_RUN_ID, stepId: STEP_ID, childRunId: CHILD_RUN_ID },
    },
  },
  'delegation-already-claimed': {
    failure: {
      reason: 'delegation-already-claimed',
      parentRunId: PARENT_RUN_ID,
      stepId: STEP_ID,
      childRunId: CHILD_RUN_ID,
    },
    expected: {
      code: 'DELEGATION_ALREADY_CLAIMED',
      message: 'This delegation has already been claimed and cannot be claimed again.',
      details: { parentRunId: PARENT_RUN_ID, stepId: STEP_ID, childRunId: CHILD_RUN_ID },
    },
  },
  'linkage-mismatch': {
    failure: {
      reason: 'linkage-mismatch',
      parentRunId: PARENT_RUN_ID,
      stepId: STEP_ID,
      childRunId: CHILD_RUN_ID,
    },
    expected: {
      code: 'CHILD_LINKAGE_MISMATCH',
      message: `Persisted linkage for child run ${CHILD_RUN_ID} does not match the verified delegation. State may be corrupted; recover with \`rundown prune\` and restart the parent from source.`,
      details: { parentRunId: PARENT_RUN_ID, stepId: STEP_ID, childRunId: CHILD_RUN_ID },
    },
  },
  'concurrent-modification': {
    failure: {
      reason: 'concurrent-modification',
      parentRunId: PARENT_RUN_ID,
      stepId: STEP_ID,
      childRunId: CHILD_RUN_ID,
    },
    expected: {
      code: 'CONCURRENT_MODIFICATION',
      message: 'The parent changed while the delegated child claim was being committed. Retry.',
      details: { parentRunId: PARENT_RUN_ID, stepId: STEP_ID, childRunId: CHILD_RUN_ID },
    },
  },
  // The two passthrough arms: the code and message are the failure's own, so
  // what is pinned is that this mapping forwards them rather than re-deriving.
  'prepare-failed': {
    failure: {
      reason: 'prepare-failed',
      runbook: 'child.runbook.md',
      code: 'POLICY_DENIED',
      cause: 'Policy denied the child runbook.',
      details: { runbook: 'child.runbook.md' },
    },
    expected: {
      code: 'POLICY_DENIED',
      message: 'Policy denied the child runbook.',
      details: { runbook: 'child.runbook.md' },
    },
  },
  'launch-failed': {
    failure: {
      reason: 'launch-failed',
      runbook: 'child.runbook.md',
      code: 'RD-816',
      cause: 'Child runbook launch failed.',
      details: { runbookName: 'child.runbook.md', runbook: 'child.runbook.md' },
    },
    expected: {
      code: 'RD-816',
      message: 'Child runbook launch failed.',
      details: { runbookName: 'child.runbook.md', runbook: 'child.runbook.md' },
    },
  },
} satisfies Record<MappedReason, ArmCase>;

describe('claimFailureToEnvelope', () => {
  it.each(Object.entries(ARM_CASES))('renders %s', (_reason, arm) => {
    expect(claimFailureToEnvelope(arm.failure)).toEqual(arm.expected);
  });

  // The defect #807 names, stated as the property rather than as three separate
  // arms: `TOKEN_NOT_FOUND` belongs to the ONE reason that is about the token.
  it('reserves TOKEN_NOT_FOUND for the reason that is actually about the token', () => {
    // Over the WHOLE table, which the `satisfies` above holds exhaustive against
    // the union — so a future arm coded `TOKEN_NOT_FOUND` cannot slip past by
    // simply not being listed, which is how the original 4-arm collapse went
    // unobserved.
    const tokenCoded = Object.entries(ARM_CASES)
      .filter(([, arm]) => arm.expected.code === 'TOKEN_NOT_FOUND')
      .map(([reason]) => reason);
    expect(tokenCoded).toEqual(['token-not-found']);
  });

  // The timing window #807 part 1 names. `parent-ended` and `delegation-removed`
  // are pre-read observations of facts core's own in-transaction classifier
  // closes as `parent-ended` / `cursor-advanced` / `token-reissued` — all of
  // which `claimRunbookInTransaction` reports as `delegation-superseded`. A
  // claimer must therefore see the same code wherever in the window it lands.
  it('renders the pre-read arms under the code core reports for the same facts', () => {
    const superseded = claimFailureToEnvelope({
      reason: 'delegation-superseded',
      parentRunId: PARENT_RUN_ID,
      stepId: STEP_ID,
    });
    for (const reason of ['parent-ended', 'delegation-removed'] as const) {
      expect(ARM_CASES[reason].expected.code).toBe(superseded.code);
    }
  });

  it('refuses an unrecognized reason rather than inventing an envelope', () => {
    expect(() =>
      claimFailureToEnvelope({ reason: 'not-a-reason' } as unknown as ClaimFailure as never),
    ).toThrow('Unhandled claim failure reason: not-a-reason');
  });
});
