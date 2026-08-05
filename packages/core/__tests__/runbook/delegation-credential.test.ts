import { describe, expect, it } from '@jest/globals';
import { generateClaimBearer, parseClaimBearer } from '../../src/runbook/claim-id.js';
import {
  createDelegationCredentialIssuer,
  createDelegationTokenDeriver,
  delegationRuntimeCapabilities,
  type DelegationRuntimeCapabilities,
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

  // The consolidated producer. Issuance and derivation are two halves of ONE
  // authority — a descriptor minted by one issuer is refused RD-821 by a deriver
  // bound to another — so the pair is now a single branded value with a single
  // producer. These cases pin what that buys: the pairing holds by construction,
  // a foreign descriptor is still refused, the bad-authority refusal is still
  // eager, and the brand is what stops a caller re-assembling a mismatched pair.
  describe('delegationRuntimeCapabilities', () => {
    it('binds both capabilities to the same authority', () => {
      const owner = authority();
      const runtime = delegationRuntimeCapabilities(owner.authority);

      const issued = runtime.issueDelegationCredential(location);

      // The same-authority claim, stated as the only thing that can prove it:
      // the deriver reproduces the exact bearer the issuer minted, and its hash
      // is the persistable verifier the issuer published. Building the two
      // halves from different authorities fails both lines.
      expect(runtime.deriveDelegationToken(issued.credential)).toBe(issued.token);
      expect(hashDelegationToken(runtime.deriveDelegationToken(issued.credential))).toBe(
        issued.tokenHash,
      );
      expect(issued.credential.issuerClaimKey).toBe(owner.parsed.claimKey);
    });

    it("refuses a descriptor minted by a different authority's issuer", () => {
      // RD-821, reached through the consolidated producer: the cross-issuer
      // refusal is the reason the pair may not be split, so it is pinned on the
      // value the split-proof type produces, not only on the raw deriver.
      const owner = delegationRuntimeCapabilities(authority().authority);
      const stranger = delegationRuntimeCapabilities(authority().authority);

      const foreign = stranger.issueDelegationCredential(location);

      expect(() => owner.deriveDelegationToken(foreign.credential)).toThrow(
        'Delegation credential belongs to a different issuer claim',
      );
    });

    it('refuses eagerly when the authority bearer encodes a different claim key', () => {
      // Eager, i.e. no capability pair is handed out at all — a later refusal
      // would leave a caller holding a value whose type promises an authority it
      // does not have.
      const bearerOwner = authority();
      const claimedOwner = authority();

      expect(() =>
        delegationRuntimeCapabilities({
          ...bearerOwner.authority,
          claimKey: claimedOwner.parsed.claimKey,
        }),
      ).toThrow('Verified claim authority does not match its bearer');
    });

    it('cannot be re-assembled from two authorities by an object literal', () => {
      const owner = delegationRuntimeCapabilities(authority().authority);
      const stranger = delegationRuntimeCapabilities(authority().authority);

      // The brand, exercised. Two real capabilities from two real authorities
      // satisfy every visible member of the interface, so only the unexported
      // `unique symbol` stands between a caller and a pair that cannot work.
      // `@ts-expect-error` is the assertion: should the brand ever be dropped or
      // exported, this line type-checks and tsc reports the unused directive.
      // @ts-expect-error - the module-private brand cannot be satisfied here
      const forged: DelegationRuntimeCapabilities = {
        issueDelegationCredential: owner.issueDelegationCredential,
        deriveDelegationToken: stranger.deriveDelegationToken,
      };

      // And this is what the brand is protecting against: the forged pair is
      // dead on arrival, refused the moment it is used.
      expect(() =>
        forged.deriveDelegationToken(forged.issueDelegationCredential(location).credential),
      ).toThrow('Delegation credential belongs to a different issuer claim');
    });
  });
});
