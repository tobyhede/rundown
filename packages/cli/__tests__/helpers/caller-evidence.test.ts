import { assertClaimId } from '@rundown-org/core';
import { readLifecycleCallerEvidence } from '../../src/helpers/caller-evidence.js';

describe('readLifecycleCallerEvidence', () => {
  it('maps a bare direct-CLI invocation to direct_cli evidence', () => {
    expect(readLifecycleCallerEvidence()).toEqual({ kind: 'direct_cli' });
  });

  it('maps a bearer claim id to claim_bearer evidence', () => {
    const claimId = assertClaimId(`rdclm_${'a'.repeat(32)}_${'A'.repeat(43)}`);

    expect(readLifecycleCallerEvidence({ claimId })).toEqual({
      kind: 'claim_bearer',
      claimId,
    });
  });

  it('never emits a source label', () => {
    const evidence = readLifecycleCallerEvidence();
    expect(Object.keys(evidence)).toEqual(['kind']);
  });
});
