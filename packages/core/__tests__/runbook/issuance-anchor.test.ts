import { describe, it, expect } from '@jest/globals';
import type { CommandTargetReader } from '../../src/runbook/command-target-resolver.js';
import { resolveIssuanceAnchor } from '../../src/runbook/issuance-anchor.js';
import {
  assertClaimId,
  assertClaimLookupKey,
  assertClaimSecretHash,
  type ClaimIdResolution,
  type ClaimRecord,
  type VerifiedClaim,
} from '../../src/runbook/claim-id.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import type { CallerEvidence } from '../../src/runbook/actor-context.js';
import type { RunbookState } from '../../src/runbook/types.js';

/**
 * Unit coverage for the delegate anchor seam. `resolveIssuanceAnchor` is the
 * single source of truth for "which run does this delegate invocation act on?" —
 * the core issuance seam and the CLI's Category-A preconditions both resolve
 * through it, so its precedence is pinned here directly rather than only via the
 * (slow) seam and CLI suites.
 *
 * A structural `CommandTargetReader` fake keeps these tests filesystem-free,
 * mirroring `command-target-resolver.test.ts`.
 */

const anchorRunId = assertRunId('rd_11111111111111111111111111111111');
const activeRunId = assertRunId('rd_22222222222222222222222222222222');
const namedRunId = assertRunId('rd_33333333333333333333333333333333');

const claimId = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);

const anchorRun = { id: anchorRunId, lifecycle: 'running' } as RunbookState;
const activeRun = { id: activeRunId, lifecycle: 'running' } as RunbookState;
const namedRun = { id: namedRunId, lifecycle: 'running' } as RunbookState;
const terminalNamedRun = { ...namedRun, lifecycle: 'completed' } as RunbookState;

const claimKey = assertClaimLookupKey('rdclk_11111111111111111111111111111111');
const claimRecord: ClaimRecord = {
  claimKey,
  secretHash: assertClaimSecretHash(`sha256:${'a'.repeat(64)}`),
  controlledRunId: anchorRunId,
  grants: [{ action: 'delegate-from-run', runId: anchorRunId }],
  issuedAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
};
const verifiedClaim: VerifiedClaim = {
  claimKey,
  controlledRunId: anchorRunId,
  grants: claimRecord.grants,
};

const bearerEvidence: CallerEvidence = { kind: 'claim_bearer', claimId };
const pluginEvidence: CallerEvidence = { kind: 'plugin', agentId: 'agent' };

function fakeReader(options: {
  readonly active?: RunbookState | null;
  readonly claimResolution?: ClaimIdResolution;
  readonly runById?: Readonly<Record<string, RunbookState>>;
}): CommandTargetReader {
  return {
    async getActive() {
      return options.active ?? null;
    },
    async resolveRunningStackMember(runId) {
      const state = options.runById?.[runId];
      if (!state) return { kind: 'not_on_stack' };
      if (state.lifecycle !== 'running') {
        return { kind: 'not_running', lifecycle: state.lifecycle };
      }
      return { kind: 'running', state };
    },
    async getActiveForClaimId(_claimId) {
      return options.claimResolution ?? { status: 'missing', claimId: _claimId };
    },
    async verifyClaimId() {
      return { status: 'missing', claimKey: claimRecord.claimKey };
    },
    async listOpenClaimsForParent() {
      return [];
    },
  };
}

const claimed = (state: RunbookState = anchorRun): ClaimIdResolution => ({
  status: 'claimed',
  claimId,
  claim: verifiedClaim,
  record: claimRecord,
  state,
});

describe('resolveIssuanceAnchor', () => {
  describe('(1) explicit --run outranks every other selector', () => {
    it('anchors the named running session-stack member', async () => {
      const reader = fakeReader({ active: activeRun, runById: { [namedRunId]: namedRun } });

      const anchored = await resolveIssuanceAnchor(reader, namedRunId, pluginEvidence);

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(namedRunId);
    });

    it('outranks a live bearer claim naming a different run', async () => {
      // Both selectors are present and name DIFFERENT runs. `--run` wins: a
      // mutant reordering the claim branch above the `--run` branch anchors the
      // claim's run and fails here. (The CLI rejects this combination as
      // INVALID_SYNTAX, so this pins the seam's own precedence for other front
      // ends.)
      const reader = fakeReader({
        active: activeRun,
        claimResolution: claimed(),
        runById: { [namedRunId]: namedRun },
      });

      const anchored = await resolveIssuanceAnchor(reader, namedRunId, bearerEvidence);

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(namedRunId);
    });

    it('refuses unknown_run when the named id is not on the session stack', async () => {
      const reader = fakeReader({ active: activeRun, runById: {} });

      const anchored = await resolveIssuanceAnchor(reader, namedRunId, pluginEvidence);

      expect(anchored.kind).toBe('unknown_run');
      if (anchored.kind !== 'unknown_run') throw new Error('expected unknown_run');
      expect(anchored.runId).toBe(namedRunId);
    });

    it('refuses unknown_run when the named id is on the stack but terminal', async () => {
      // `not_running` carries a cause-specific message distinct from
      // `not_on_stack`; both collapse to the same `unknown_run` refusal kind.
      const reader = fakeReader({
        active: activeRun,
        runById: { [namedRunId]: terminalNamedRun },
      });

      const anchored = await resolveIssuanceAnchor(reader, namedRunId, pluginEvidence);

      expect(anchored.kind).toBe('unknown_run');
      if (anchored.kind !== 'unknown_run') throw new Error('expected unknown_run');
      expect(anchored.runId).toBe(namedRunId);
      expect(anchored.message).toContain('completed');
    });
  });

  describe('(2) a live bearer claim anchors the run it controls', () => {
    it("anchors the claim's controlled run over the active default (#586)", async () => {
      const reader = fakeReader({ active: activeRun, claimResolution: claimed() });

      const anchored = await resolveIssuanceAnchor(reader, undefined, bearerEvidence);

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(anchorRunId);
    });

    it('falls through to the active default for a terminal claim', async () => {
      const reader = fakeReader({
        active: activeRun,
        claimResolution: {
          status: 'terminal',
          claim: verifiedClaim,
          state: { ...anchorRun, lifecycle: 'completed' },
          lifecycle: 'completed',
        },
      });

      const anchored = await resolveIssuanceAnchor(reader, undefined, bearerEvidence);

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(activeRunId);
    });

    it('falls through to the active default for a missing (stale) claim', async () => {
      const reader = fakeReader({
        active: activeRun,
        claimResolution: { status: 'missing', claimId },
      });

      const anchored = await resolveIssuanceAnchor(reader, undefined, bearerEvidence);

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(activeRunId);
    });

    it('falls through to the active default for a stashed claim', async () => {
      // The claim head is consulted WITHOUT `allowStashed`, so a stashed child
      // never anchors here — it falls through and the unchanged authorization
      // gate refuses. Pins the deliberate visibility choice: flipping
      // `includeStashed` on would anchor the stashed run instead.
      const reader = fakeReader({
        active: activeRun,
        claimResolution: { status: 'unlinked', claim: verifiedClaim, reason: 'stashed' },
      });

      const anchored = await resolveIssuanceAnchor(reader, undefined, bearerEvidence);

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(activeRunId);
    });
  });

  describe('(3) the active default is the bare fallback', () => {
    it('anchors the active run for non-claim evidence', async () => {
      const reader = fakeReader({ active: activeRun });

      const anchored = await resolveIssuanceAnchor(reader, undefined, pluginEvidence);

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(activeRunId);
    });

    it('resolves none when no run is active', async () => {
      const reader = fakeReader({ active: null });

      const anchored = await resolveIssuanceAnchor(reader, undefined, pluginEvidence);

      expect(anchored.kind).toBe('none');
    });

    it('resolves none when a stale claim leaves no active default', async () => {
      const reader = fakeReader({ active: null, claimResolution: { status: 'missing', claimId } });

      const anchored = await resolveIssuanceAnchor(reader, undefined, bearerEvidence);

      expect(anchored.kind).toBe('none');
    });
  });
});
