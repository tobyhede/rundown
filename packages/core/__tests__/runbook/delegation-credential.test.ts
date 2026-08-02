import { describe, expect, it } from '@jest/globals';
import { generateClaimBearer, parseClaimBearer } from '../../src/runbook/claim-id.js';
import {
  createDelegationCredentialIssuer,
  createDelegationTokenDeriver,
} from '../../src/runbook/delegation-credential.js';
import {
  assertDelegationIssuanceNonce,
  assertDelegationTokenHash,
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
