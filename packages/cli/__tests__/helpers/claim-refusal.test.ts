// packages/cli/__tests__/helpers/claim-refusal.test.ts
//
// Dedicated coverage for `sharedClaimRefusal`, the single mapping `stash
// --claim-id` and `pop --claim-id` both delegate their six shared refusal arms
// to (`missing-claim`, `missing-child`, `terminal-child`,
// `child-linkage-mismatch`, `parent-missing`, `superseded`). Before the
// extraction each command carried its own byte-identical copy of these arms —
// a regression hit one command. Now one mapping serves both, so an unpinned
// mapping is worse than it was: this pins the exact message text and symbolic
// code for every arm, character for character, so a drift in either shows up
// here rather than only at the two call sites.

import { describe, it, expect } from '@jest/globals';
import {
  assertClaimId,
  assertRunId,
  parseClaimBearer,
  redactClaimId,
  type ClaimSupersededReason,
  type VerifiedClaim,
} from '@rundown-org/core';
import { sharedClaimRefusal, type SharedClaimRefusal } from '../../src/helpers/claim-refusal.js';

const CLAIM_ID = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const CLAIM_SECRET = parseClaimBearer(CLAIM_ID).secret;
const CLAIM_KEY = redactClaimId(CLAIM_ID);

const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CHILD_RUN_ID = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

// Only `claimKey`/`controlledRunId`/`grants` are load-bearing for these arms —
// `sharedClaimRefusal` derives the redacted key from its own `claimId`
// parameter, never from a field on `claim` — so this single fixture covers
// every arm that carries a `VerifiedClaim`.
const claim: VerifiedClaim = { claimKey: CLAIM_KEY, controlledRunId: RUN_ID, grants: [] };

interface SharedArmCase {
  readonly label: string;
  readonly result: SharedClaimRefusal;
  readonly message: string;
  readonly code: string;
}

describe('sharedClaimRefusal', () => {
  const cases: readonly SharedArmCase[] = [
    {
      label: 'missing-claim',
      result: { status: 'missing-claim', claimId: CLAIM_ID },
      message: `Claim id ${CLAIM_KEY} does not exist.`,
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
    },
    {
      label: 'missing-child',
      result: { status: 'missing-child', childRunId: CHILD_RUN_ID },
      message: `Claim id ${CLAIM_KEY} no longer has readable child runbook state. Recover with \`rundown prune\` and restart from source.`,
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
    },
    {
      label: 'terminal-child (completed)',
      result: { status: 'terminal-child', claim, lifecycle: 'completed' },
      message: `Claim id ${CLAIM_KEY} points at a completed child runbook.`,
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
    },
    {
      label: 'terminal-child (stopped)',
      result: { status: 'terminal-child', claim, lifecycle: 'stopped' },
      message: `Claim id ${CLAIM_KEY} points at a stopped child runbook.`,
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
    },
    {
      label: 'child-linkage-mismatch',
      result: { status: 'child-linkage-mismatch', claim },
      message: `Claim id ${CLAIM_KEY} is no longer linked to its child runbook.`,
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
    },
    {
      label: 'parent-missing',
      result: { status: 'parent-missing', claim },
      message: `Claim id ${CLAIM_KEY} parent runbook is missing.`,
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
    },
  ];

  it.each(cases)('maps $label to its exact message and code', ({ result, message, code }) => {
    const envelope = sharedClaimRefusal(CLAIM_ID, result);

    expect(envelope.message).toBe(message);
    expect(envelope.code).toBe(code);
  });

  it('identifies every arm by the redacted claim key, never the bearer secret', () => {
    for (const { result } of cases) {
      const envelope = sharedClaimRefusal(CLAIM_ID, result);
      expect(envelope.message).toContain(CLAIM_KEY);
      expect(envelope.message).not.toContain(CLAIM_SECRET);
    }
  });
});

describe("sharedClaimRefusal's superseded arm (RD-825)", () => {
  // `describeSupersededClaim` splits `ClaimSupersededReason` into two groups
  // that render under different codes: the ones where the *parent* moved past
  // the delegation carry the RD-825 no-retry instruction under
  // `DELEGATION_SUPERSEDED`; the ones where the claim itself was retired
  // (rotated, or its parent unreadable) render under the generic
  // `CLAIMED_RUNBOOK_UNAVAILABLE`. This is the most valuable split in the
  // module, so every reason is driven rather than a representative sample.
  //
  // Declared as a TOTAL map over the union rather than a hand-listed array: a
  // seventh reason added in core is then a compile error here, instead of a
  // silently untested arm that a hand-list would never notice.
  const REASON_CODES: Record<
    ClaimSupersededReason,
    'DELEGATION_SUPERSEDED' | 'CLAIMED_RUNBOOK_UNAVAILABLE'
  > = {
    'parent-ended': 'DELEGATION_SUPERSEDED',
    'cursor-advanced': 'DELEGATION_SUPERSEDED',
    resolved: 'DELEGATION_SUPERSEDED',
    'token-reissued': 'DELEGATION_SUPERSEDED',
    'claim-rotated': 'CLAIMED_RUNBOOK_UNAVAILABLE',
    'parent-unreadable': 'CLAIMED_RUNBOOK_UNAVAILABLE',
  };

  // `Object.entries` widens the key back to `string`. The assertion restores
  // only what `REASON_CODES`'s own annotation already guarantees, and it is
  // deliberately here rather than on the declaration — putting it there is what
  // would defeat the exhaustiveness check above.
  const reasonCases = (
    Object.entries(REASON_CODES) as ReadonlyArray<
      readonly [ClaimSupersededReason, (typeof REASON_CODES)[ClaimSupersededReason]]
    >
  ).map(([reason, code]) => ({ reason, code }));

  it.each(reasonCases)('maps reason $reason to $code', ({ reason, code }) => {
    const envelope = sharedClaimRefusal(CLAIM_ID, {
      status: 'superseded',
      claimId: CLAIM_ID,
      reason,
    });

    expect(envelope.code).toBe(code);
    expect(envelope.message).toContain(CLAIM_KEY);
    expect(envelope.message).not.toContain(CLAIM_SECRET);
  });

  it('carries the exact RD-825 wording for a parent-moved-on reason (DELEGATION_SUPERSEDED)', () => {
    const envelope = sharedClaimRefusal(CLAIM_ID, {
      status: 'superseded',
      claimId: CLAIM_ID,
      reason: 'parent-ended',
    });

    expect(envelope.message).toBe(
      `Claim id ${CLAIM_KEY} is superseded: the parent has moved past this delegation (parent-ended). Do not retry the token; report the superseded delegation to the orchestrator.`,
    );
    expect(envelope.code).toBe('DELEGATION_SUPERSEDED');
  });

  it('carries the exact wording for a claim-retired reason (CLAIMED_RUNBOOK_UNAVAILABLE)', () => {
    const envelope = sharedClaimRefusal(CLAIM_ID, {
      status: 'superseded',
      claimId: CLAIM_ID,
      reason: 'claim-rotated',
    });

    expect(envelope.message).toBe(
      `Claim id ${CLAIM_KEY} was released or replaced and is no longer authority. Claim the parent's current delegation instead of reusing this id.`,
    );
    expect(envelope.code).toBe('CLAIMED_RUNBOOK_UNAVAILABLE');
  });

  it('carries the exact wording for an unreadable-parent reason (CLAIMED_RUNBOOK_UNAVAILABLE)', () => {
    const envelope = sharedClaimRefusal(CLAIM_ID, {
      status: 'superseded',
      claimId: CLAIM_ID,
      reason: 'parent-unreadable',
    });

    expect(envelope.message).toBe(
      `Claim id ${CLAIM_KEY} is superseded and its parent run no longer exists. Recover with \`rundown prune\` and restart from source.`,
    );
    expect(envelope.code).toBe('CLAIMED_RUNBOOK_UNAVAILABLE');
  });

  it('reserves the no-retry instruction for the parent-moved-on reasons only', () => {
    const parentMovedOn = sharedClaimRefusal(CLAIM_ID, {
      status: 'superseded',
      claimId: CLAIM_ID,
      reason: 'parent-ended',
    });
    const claimRetired = sharedClaimRefusal(CLAIM_ID, {
      status: 'superseded',
      claimId: CLAIM_ID,
      reason: 'claim-rotated',
    });

    expect(parentMovedOn.message).toContain('Do not retry the token');
    expect(claimRetired.message).not.toContain('Do not retry the token');
  });
});
