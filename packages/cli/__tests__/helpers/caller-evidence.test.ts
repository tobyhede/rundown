import {
  assertRunCapability,
  assertRunId,
  assertClaimId,
  assertDelegationTokenHash,
} from '@rundown-org/core';
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

    expect(readLifecycleCallerEvidence({ claim })).toEqual({ kind: 'claim', ...claim });
  });

  it('maps a validated --run id to run_identifier evidence naming that run', () => {
    const runId = assertRunId('rd_22222222222222222222222222222222');

    expect(readLifecycleCallerEvidence({ runId })).toEqual({ kind: 'run_identifier', runId });
  });

  it('maps a validated --run-capability to run_capability evidence naming that run', () => {
    const runCapability = assertRunCapability(
      `rdrc_${'2'.repeat(32)}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    );

    expect(readLifecycleCallerEvidence({ runCapability })).toEqual({
      kind: 'run_capability',
      runId: assertRunId('rd_22222222222222222222222222222222'),
    });
  });

  it('gives claim evidence precedence when both inputs are somehow present', () => {
    // Exclusivity is enforced upstream by parseRunOption; the evidence reader
    // still has a deterministic precedence rather than an undefined state.
    const claim = {
      claimId: assertClaimId('rdclm_abcdefghijklmnopqrstu1'),
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      controlledRunId: assertRunId('rd_11111111111111111111111111111111'),
    };
    const runId = assertRunId('rd_22222222222222222222222222222222');

    expect(readLifecycleCallerEvidence({ claim, runId })).toEqual({ kind: 'claim', ...claim });
  });

  it('never emits a source label', () => {
    const evidence = readLifecycleCallerEvidence();
    expect(Object.keys(evidence)).toEqual(['kind']);
  });
});
