import { describe, it, expect } from '@jest/globals';
import type { ClaimId, ClaimRecord, DelegationTokenHash, RunId } from '@rundown-org/core';
import { buildCollectActorIngress } from '../../src/commands/collect.js';

// Robust source + claim-evidence propagation driver: a pure exported helper that
// collect uses to build its ActorIngress from the resolved source tag and the
// resolved claim record. Module-spying a first-party named export is unreliable
// under this package's jest config (`isolatedModules: true` + `useESM: true`),
// so the driver is a direct unit test of the helper — mirroring delegate's
// `buildDelegateActorIngress` and Task 6's `buildTransitionActorContext`. This
// FAILS to import before Step 4 extracts the helper, which is what TDD-drives
// the migration: collection is source-independent, so an end-to-end test cannot
// observe the source spread, and the entire spread could otherwise be deleted
// with every collect test still green.
const STATE_ID = 'run_target' as RunId;
const CLAIM_ID = 'rdclm_target' as ClaimId;
const TOKEN_HASH = 'tokenhash_target' as DelegationTokenHash;
// buildCollectActorIngress only reads `.claimId` and `.tokenHash`; the rest of
// the ClaimRecord shape (notably `childRunId`, NOT `controlledRunId`) is
// irrelevant to ingress construction, so a minimal cast stub suffices.
const claimStub = { claimId: CLAIM_ID, tokenHash: TOKEN_HASH } as unknown as ClaimRecord;

describe('buildCollectActorIngress threads the source and claim evidence', () => {
  it('tags ingress.source only when a source is supplied and no claim is present', () => {
    expect(buildCollectActorIngress('plugin', undefined, STATE_ID)).toEqual({ source: 'plugin' });
  });

  it('produces an empty ingress when neither a source nor a claim is supplied', () => {
    expect(buildCollectActorIngress(undefined, undefined, STATE_ID)).toEqual({});
  });

  it('threads source AND full claim evidence, defaulting controlledRunId to the target state id', () => {
    // controlledRunId comes from the passed targetStateId (the resolved claimed
    // child), NOT from a field on the claim — ClaimRecord has no controlledRunId.
    expect(buildCollectActorIngress('mcp', claimStub, STATE_ID)).toEqual({
      source: 'mcp',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: STATE_ID,
    });
  });

  it('threads claim evidence with no source when only a claim is supplied', () => {
    expect(buildCollectActorIngress(undefined, claimStub, STATE_ID)).toEqual({
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: STATE_ID,
    });
  });
});
