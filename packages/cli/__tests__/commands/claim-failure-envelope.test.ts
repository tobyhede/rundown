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
// in either shows up here rather than only in an agent's routing.

import { describe, it, expect } from '@jest/globals';
import { ErrorCodes, assertRunId } from '@rundown-org/core';
import { claimFailureToEnvelope, type ClaimFailureEnvelope } from '../../src/commands/claim.js';
import type { ClaimFailure } from '../../src/helpers/runbook-pipeline.js';

const PARENT_RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CHILD_RUN_ID = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const STEP_ID = '1';
// cspell:disable-next-line
const TOKEN = 'rdtk_AAAA…';

/** Every arm's expected envelope, keyed by the reason that produces it. */
interface ArmCase {
  readonly label: string;
  readonly failure: Exclude<ClaimFailure, { reason: 'session-refused' }>;
  readonly expected: ClaimFailureEnvelope;
}

describe('claimFailureToEnvelope', () => {
  const cases: readonly ArmCase[] = [
    {
      label: 'invalid-token',
      failure: { reason: 'invalid-token', token: TOKEN },
      expected: {
        code: 'INVALID_TOKEN',
        message: 'Invalid token format. Tokens must start with "rdtk_".',
        details: { token: TOKEN },
      },
    },
    {
      label: 'token-not-found',
      failure: { reason: 'token-not-found', token: TOKEN },
      expected: {
        code: 'TOKEN_NOT_FOUND',
        message: 'No active run contains a delegation with this token.',
        details: { token: TOKEN },
      },
    },
    {
      label: 'parent-missing',
      failure: { reason: 'parent-missing', parentRunId: PARENT_RUN_ID },
      expected: {
        code: 'PARENT_RUN_MISSING',
        message: `Parent run ${PARENT_RUN_ID} no longer exists.`,
        details: { parentRunId: PARENT_RUN_ID },
      },
    },
    {
      label: 'parent-ended',
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
    {
      label: 'delegation-removed',
      failure: { reason: 'delegation-removed', parentRunId: PARENT_RUN_ID, stepId: STEP_ID },
      expected: {
        code: 'DELEGATION_SUPERSEDED',
        message: `Delegation no longer exists on parent step ${STEP_ID}. ${ErrorCodes.DELEGATION_SUPERSEDED.description}`,
        details: { parentRunId: PARENT_RUN_ID, stepId: STEP_ID },
      },
    },
    {
      label: 'delegation-cancelled',
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
    {
      label: 'delegation-superseded',
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
    {
      label: 'child-missing',
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
  ];

  it.each(cases.map((c) => [c.label, c] as const))('renders %s', (_label, arm) => {
    expect(claimFailureToEnvelope(arm.failure)).toEqual(arm.expected);
  });

  // The defect #807 names, stated as the property rather than as three separate
  // arms: `TOKEN_NOT_FOUND` belongs to the ONE reason that is about the token.
  it('reserves TOKEN_NOT_FOUND for the reason that is actually about the token', () => {
    const tokenCoded = cases.filter((c) => c.expected.code === 'TOKEN_NOT_FOUND');
    expect(tokenCoded.map((c) => c.label)).toEqual(['token-not-found']);
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
      const arm = cases.find((c) => c.label === reason);
      expect(arm?.expected.code).toBe(superseded.code);
    }
  });

  it('refuses an unrecognized reason rather than inventing an envelope', () => {
    expect(() =>
      claimFailureToEnvelope({ reason: 'not-a-reason' } as unknown as ClaimFailure as never),
    ).toThrow('Unhandled claim failure reason: not-a-reason');
  });
});
