import { describe, expect, it } from '@jest/globals';
import {
  assertClaimBearer,
  assertClaimLookupKey,
  claimCanReportDelegationResult,
  claimKeyFromBearer,
  type ClaimGrant,
  type VerifiedClaim,
  createDelegatedChildGrants,
  createRunControlGrants,
  generateClaimBearer,
  grantAllows,
  hashClaimSecret,
  parseClaimBearer,
  redactClaimId,
  verifyClaimSecret,
} from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookState } from '../../src/runbook/types.js';

describe('claim bearer credentials', () => {
  const parentRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const childRunId = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const tokenHash = assertDelegationTokenHash(`sha256:${'c'.repeat(64)}`);
  const linkage = {
    childRunId,
    tokenHash,
    parentRunId,
    parentStepId: '1.1',
    parentStep: 'Process item',
    parentFrameKey: buildFrameKey('1', 0),
    parentEntry: 1,
  };

  it('generates a bearer claim_id with a lookup key and secret segment', () => {
    const claimId = generateClaimBearer();

    expect(claimId).toMatch(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
    expect(parseClaimBearer(claimId)).toEqual({
      claimId,
      claimKey: expect.stringMatching(/^rdclk_[a-f0-9]{32}$/),
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('derives the same non-secret lookup key from the bearer value', () => {
    const claimId = assertClaimBearer(
      'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
    );

    expect(claimKeyFromBearer(claimId)).toBe('rdclk_11111111111111111111111111111111');
  });

  it('redactClaimId renders a bearer as its non-secret lookup key, never the secret', () => {
    const claimId = assertClaimBearer(
      'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
    );
    const secret = parseClaimBearer(claimId).secret;

    const redacted = redactClaimId(claimId);

    expect(redacted).toBe('rdclk_11111111111111111111111111111111');
    expect(redacted).not.toContain(secret);
  });

  it('hashes and verifies only the secret segment using constant-time comparison', () => {
    const parsed = parseClaimBearer(generateClaimBearer());
    const secretHash = hashClaimSecret(parsed.secret);

    expect(secretHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyClaimSecret(parsed.secret, secretHash)).toBe(true);
    expect(verifyClaimSecret('wrong-secret', secretHash)).toBe(false);
  });

  it('creates explicit run-control grants for the started run', () => {
    expect(createRunControlGrants(parentRunId)).toEqual([
      { action: 'mutate-run', runId: parentRunId },
      { action: 'delegate-from-run', runId: parentRunId },
      { action: 'collect-for-run', runId: parentRunId },
      { action: 'abort-delegation', runId: parentRunId },
      { action: 'retry-delegation', runId: parentRunId },
    ]);
  });

  it('creates explicit delegated-child grants for the claimed child and parent report linkage', () => {
    expect(createDelegatedChildGrants({ linkage })).toEqual([
      { action: 'mutate-run', runId: childRunId },
      { action: 'report-delegation-result', ...linkage },
    ]);
  });

  it('authorizes by exact grant and target, not by claim kind', () => {
    const grants = createDelegatedChildGrants({ linkage });

    expect(grantAllows(grants[0], { action: 'mutate-run', runId: childRunId })).toBe(true);
    expect(grantAllows(grants[0], { action: 'mutate-run', runId: parentRunId })).toBe(false);
    expect(
      grantAllows(grants[1], {
        action: 'report-delegation-result',
        ...linkage,
      }),
    ).toBe(true);
    expect(
      grantAllows(grants[1], {
        action: 'report-delegation-result',
        ...linkage,
        tokenHash: assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`),
      }),
    ).toBe(false);
  });

  it('treats unscoped recovery grants as step wildcards and scoped recovery grants as exact-step only', () => {
    const otherStepId = '2.1';

    for (const action of ['abort-delegation', 'retry-delegation'] as const) {
      const unscopedGrant = { action, runId: parentRunId } satisfies ClaimGrant;
      const scopedGrant = {
        action,
        runId: parentRunId,
        stepId: linkage.parentStepId,
      } satisfies ClaimGrant;

      expect(grantAllows(unscopedGrant, { action, runId: parentRunId, stepId: otherStepId })).toBe(
        true,
      );
      expect(
        grantAllows(scopedGrant, { action, runId: parentRunId, stepId: linkage.parentStepId }),
      ).toBe(true);
      expect(grantAllows(scopedGrant, { action, runId: parentRunId, stepId: otherStepId })).toBe(
        false,
      );
    }
  });
});

describe('claimCanReportDelegationResult', () => {
  const parentRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const childRunId = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const linkage = {
    childRunId,
    tokenHash: assertDelegationTokenHash(`sha256:${'c'.repeat(64)}`),
    parentRunId,
    parentStepId: '1.1',
    parentStep: 'Process item',
    parentFrameKey: buildFrameKey('1', 0),
    parentEntry: 1,
  };
  const reportingClaim: VerifiedClaim = {
    claimKey: assertClaimLookupKey(`rdclk_${'1'.repeat(32)}`),
    controlledRunId: childRunId,
    delegation: linkage,
    grants: createDelegatedChildGrants({ linkage }),
  };
  const delegationChild = {
    id: childRunId,
    parentLinkage: { kind: 'delegation', ...linkage },
  } as unknown as RunbookState;

  it('allows reporting when the child is delegation-linked and the claim holds the matching grant', () => {
    expect(claimCanReportDelegationResult(reportingClaim, delegationChild)).toBe(true);
  });

  it('refuses reporting when the child carries no delegation parent linkage', () => {
    const inlineChild = { id: childRunId, parentLinkage: undefined } as RunbookState;

    expect(claimCanReportDelegationResult(reportingClaim, inlineChild)).toBe(false);
  });

  it('refuses reporting when the claim grant does not match the child linkage', () => {
    const mismatchedChild = {
      id: childRunId,
      parentLinkage: {
        kind: 'delegation',
        ...linkage,
        tokenHash: assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`),
      },
    } as unknown as RunbookState;

    expect(claimCanReportDelegationResult(reportingClaim, mismatchedChild)).toBe(false);
  });
});
