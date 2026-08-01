import { describe, expect, it } from '@jest/globals';
import { generateClaimBearer, parseClaimBearer } from '../../src/runbook/claim-id.js';
import {
  createDelegationCredentialIssuer,
  createDelegationTokenDeriver,
} from '../../src/runbook/delegation-credential.js';
import { assertDelegationIssuanceNonce } from '../../src/runbook/delegation-token.js';
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
  it('issues and reproduces a token without retaining plaintext in the descriptor', () => {
    const owner = authority();
    const issue = createDelegationCredentialIssuer(owner.authority, () =>
      assertDelegationIssuanceNonce('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    );
    const issued = issue({
      parentRunId: assertRunId(`rd_${'1'.repeat(32)}`),
      parentStepId: '1.1',
      parentFrameKey: '1|' as FrameKey,
      parentEntry: 1,
    });

    expect(createDelegationTokenDeriver(owner.authority)(issued.credential)).toBe(issued.token);
    expect(JSON.stringify(issued.credential)).not.toContain(issued.token);
    expect(issued.credential.issuerClaimKey).toBe(owner.parsed.claimKey);
  });

  it('refuses to reproduce a credential owned by another claim', () => {
    const first = authority();
    const second = authority();
    const issued = createDelegationCredentialIssuer(first.authority)({
      parentRunId: assertRunId(`rd_${'1'.repeat(32)}`),
      parentStepId: '1.1',
      parentFrameKey: '1|' as FrameKey,
      parentEntry: 1,
    });

    expect(() => createDelegationTokenDeriver(second.authority)(issued.credential)).toThrow(
      'Delegation credential belongs to a different issuer claim',
    );
  });
});
