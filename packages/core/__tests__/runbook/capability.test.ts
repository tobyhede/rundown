import { describe, expect, it } from '@jest/globals';
import {
  assertClaimCapability,
  assertRunCapability,
  generateClaimCapability,
  generateRunCapability,
  hashCapabilitySecret,
  parseClaimCapability,
  parseRunCapability,
  verifyCapabilitySecret,
} from '../../src/runbook/capability.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { assertRunId } from '../../src/runbook/run-id.js';

describe('capability credentials', () => {
  const runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');

  it('generates run capabilities that embed the run id and keep a separate secret', () => {
    const capability = generateRunCapability(runId);

    expect(capability).toMatch(/^rdrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_[A-Za-z0-9_-]{43}$/);
    expect(parseRunCapability(capability)).toMatchObject({ runId });
  });

  it('generates claim capabilities that embed the claim id and keep a separate secret', () => {
    const capability = generateClaimCapability(claimId);

    expect(capability).toMatch(/^rdcc_abcdefghijklmnopqrstu1_[A-Za-z0-9_-]{43}$/);
    expect(parseClaimCapability(capability)).toMatchObject({ claimId });
  });

  it('hashes and verifies only the secret segment', () => {
    const capability = generateRunCapability(runId);
    const parsed = parseRunCapability(capability);
    const hash = hashCapabilitySecret(parsed.secret);

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifyCapabilitySecret(parsed.secret, hash)).toBe(true);
    expect(verifyCapabilitySecret('wrong-secret', hash)).toBe(false);
  });

  it('rejects printed ids as capabilities', () => {
    expect(() => assertRunCapability(runId)).toThrow(
      'Invalid run capability: expected rdrc_<run id body>_<43 base64url characters>',
    );
    expect(() => assertClaimCapability(claimId)).toThrow(
      'Invalid claim capability: expected rdcc_<claim id body>_<43 base64url characters>',
    );
  });
});
