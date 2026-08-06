import { describe, expect, it } from '@jest/globals';
import { generateClaimBearer, parseClaimBearer } from '../../src/runbook/claim-id.js';
import {
  createDelegationCredentialIssuer,
  createDelegationTokenDeriver,
} from '../../src/runbook/delegation-credential.js';
import {
  assertDelegationIssuanceNonce,
  assertDelegationTokenHash,
  hashDelegationToken,
} from '../../src/runbook/delegation-token.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import type { FrameKey } from '../../src/runbook/targeting.js';

function authority() {
  const parsed = parseClaimBearer(generateClaimBearer());
  return {
    parsed,
    authority: { kind: 'bearer' as const, claimId: parsed.claimId, claimKey: parsed.claimKey },
  };
}

describe('delegation credential capabilities', () => {
  const location = {
    parentRunId: assertRunId(`rd_${'1'.repeat(32)}`),
    parentStepId: '1.1',
    parentFrameKey: '1|' as FrameKey,
    parentEntry: 1,
  };

  it('issues and reproduces a token without retaining plaintext in the descriptor', () => {
    const owner = authority();
    const issue = createDelegationCredentialIssuer(owner.authority, () =>
      assertDelegationIssuanceNonce('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    );
    const issued = issue(location);

    expect(createDelegationTokenDeriver(owner.authority)(issued.credential)).toBe(issued.token);
    expect(JSON.stringify(issued.credential)).not.toContain(issued.token);
    expect(issued.credential.issuerClaimKey).toBe(owner.parsed.claimKey);
  });

  it('publishes a tokenHash that verifies the token the deriver reproduces', () => {
    // projectDelegateFrontier (events/execution-observation.ts) discloses a
    // frontier token only when hashDelegationToken(deriveToken(credential))
    // equals the persisted entry.tokenHash. That check can only ever succeed if
    // the issuer's tokenHash is the hash of the token it issued, so pin the
    // agreement here rather than leaving it to the projection's runtime throw.
    const owner = authority();
    const issued = createDelegationCredentialIssuer(owner.authority)(location);

    expect(issued.tokenHash).toBe(hashDelegationToken(issued.token));
    expect(
      hashDelegationToken(createDelegationTokenDeriver(owner.authority)(issued.credential)),
    ).toBe(issued.tokenHash);
  });

  it('derives a distinct token per issuance at one location with the default nonce', () => {
    // The default generateNonce is the only thing separating two issuances that
    // share every coordinate: same claim, same parent run/step/frame/entry. The
    // pinned-nonce tests above deliberately freeze it, so uniqueness is only
    // exercised here.
    const owner = authority();
    const issue = createDelegationCredentialIssuer(owner.authority);

    const first = issue(location);
    const second = issue(location);

    expect(second.credential.issuanceNonce).not.toBe(first.credential.issuanceNonce);
    expect(second.token).not.toBe(first.token);
    expect(second.tokenHash).not.toBe(first.tokenHash);
  });

  it('refuses an authority whose bearer encodes a different claim key', () => {
    const bearerOwner = authority();
    const claimedOwner = authority();

    expect(() =>
      createDelegationTokenDeriver({
        ...bearerOwner.authority,
        claimKey: claimedOwner.parsed.claimKey,
      }),
    ).toThrow('Verified claim authority does not match its bearer');
  });

  it('omits supersedesTokenHash when issuance does not supersede a credential', () => {
    const owner = authority();
    const issued = createDelegationCredentialIssuer(owner.authority)(location);

    expect(issued.credential).not.toHaveProperty('supersedesTokenHash');
  });

  it('retains the exact superseded token hash in the issued descriptor', () => {
    const owner = authority();
    const supersedesTokenHash = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);
    const issued = createDelegationCredentialIssuer(owner.authority)(location, supersedesTokenHash);

    expect(issued.credential.supersedesTokenHash).toBe(supersedesTokenHash);
  });

  it('refuses to reproduce a credential owned by another claim', () => {
    const first = authority();
    const second = authority();
    const issued = createDelegationCredentialIssuer(first.authority)(location);

    expect(() => createDelegationTokenDeriver(second.authority)(issued.credential)).toThrow(
      'Delegation credential belongs to a different issuer claim',
    );
  });
});
