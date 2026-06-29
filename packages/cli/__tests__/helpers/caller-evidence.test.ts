import { assertRunId, assertClaimId, assertDelegationTokenHash } from '@rundown-org/core';
import { readLifecycleCallerEvidence } from '../../src/helpers/caller-evidence.js';

describe('readLifecycleCallerEvidence', () => {
  it('maps a bare direct-CLI invocation to direct_cli evidence', () => {
    expect(readLifecycleCallerEvidence()).toEqual({ kind: 'direct_cli' });
  });

  it('maps a resolved claim record to claim evidence anchored on the controlled run', () => {
    const claim = {
      claimId: assertClaimId('rdclm_abcdefghijklmnopqrstu1'),
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      controlledRunId: assertRunId('rd_11111111111111111111111111111111'),
    };

    expect(readLifecycleCallerEvidence(claim)).toEqual({ kind: 'claim', ...claim });
  });

  it('never emits a source label', () => {
    const evidence = readLifecycleCallerEvidence();
    expect(Object.keys(evidence)).toEqual(['kind']);
  });
});
