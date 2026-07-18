import { describe, it, expect } from '@jest/globals';
import type { CommandTargetReader } from '../../src/runbook/command-target-resolver.js';
import { resolveIssuanceAnchor } from '../../src/runbook/issuance-anchor.js';
import {
  assertClaimId,
  assertClaimLookupKey,
  type ClaimIdResolution,
  type VerifiedClaim,
} from '../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';
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
// Via `makeClaimRecord`, not a literal: this suite only cares about the anchor
// fields (`controlledRunId`, `grants`) — the rest of the shape is incidental, and
// spelling it out here is what made `lastSeenAt` becoming required a manual
// sweep across every suite that had its own copy (#519).
const claimRecord = makeClaimRecord({
  claimKey,
  controlledRunId: anchorRunId,
  grants: [{ action: 'delegate-from-run', runId: anchorRunId }],
});
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
    async getActiveForClaimId(_claimId, readOptions) {
      const resolution = options.claimResolution ?? { status: 'missing', claimId: _claimId };
      // Mirror the real head's visibility rule rather than ignoring the option: a
      // stashed claim is only visible when the caller asks for it. Without this,
      // no fake input could distinguish `allowStashed` on from off, so the
      // anchor's deliberate choice to leave it off would be unpinned.
      if (resolution.status === 'unlinked' && readOptions.includeStashed) {
        return claimed();
      }
      return resolution;
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

      const anchored = await resolveIssuanceAnchor(reader, {
        callerEvidence: pluginEvidence,
        targetRunId: namedRunId,
      });

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

      const anchored = await resolveIssuanceAnchor(reader, {
        callerEvidence: bearerEvidence,
        targetRunId: namedRunId,
      });

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(namedRunId);
    });

    it('refuses unknown_run when the named id is not on the session stack', async () => {
      const reader = fakeReader({ active: activeRun, runById: {} });

      const anchored = await resolveIssuanceAnchor(reader, {
        callerEvidence: pluginEvidence,
        targetRunId: namedRunId,
      });

      expect(anchored.kind).toBe('unknown_run');
      if (anchored.kind !== 'unknown_run') throw new Error('expected unknown_run');
      expect(anchored.runId).toBe(namedRunId);
    });

    it('does not fall through to a live bearer claim when the named id is absent', async () => {
      const reader = fakeReader({
        active: activeRun,
        claimResolution: claimed(),
        runById: {},
      });

      const anchored = await resolveIssuanceAnchor(reader, {
        callerEvidence: bearerEvidence,
        targetRunId: namedRunId,
      });

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

      const anchored = await resolveIssuanceAnchor(reader, {
        callerEvidence: pluginEvidence,
        targetRunId: namedRunId,
      });

      expect(anchored.kind).toBe('unknown_run');
      if (anchored.kind !== 'unknown_run') throw new Error('expected unknown_run');
      expect(anchored.runId).toBe(namedRunId);
      expect(anchored.message).toContain('completed');
    });
  });

  describe('(2) a live bearer claim anchors the run it controls', () => {
    it("anchors the claim's controlled run over the active default (#586)", async () => {
      const reader = fakeReader({ active: activeRun, claimResolution: claimed() });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(anchorRunId);
    });

    it('refuses terminal_claim rather than anchoring the active default (#586)', async () => {
      const reader = fakeReader({
        active: activeRun,
        claimResolution: {
          status: 'terminal',
          claim: verifiedClaim,
          state: { ...anchorRun, lifecycle: 'completed' },
          lifecycle: 'completed',
        },
      });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('terminal_claim');
      if (anchored.kind !== 'terminal_claim') throw new Error('expected terminal_claim');
      expect(anchored.lifecycle).toBe('completed');
      expect(anchored.message).toContain('completed');
    });

    it('carries the stopped lifecycle through, not a hardcoded completed (#586)', async () => {
      // The only other terminal case is `completed`, so without this a constant
      // `lifecycle: 'completed'` in the anchor would pass every test.
      const reader = fakeReader({
        active: activeRun,
        claimResolution: {
          status: 'terminal',
          claim: verifiedClaim,
          state: { ...anchorRun, lifecycle: 'stopped' },
          lifecycle: 'stopped',
        },
      });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('terminal_claim');
      if (anchored.kind !== 'terminal_claim') throw new Error('expected terminal_claim');
      expect(anchored.lifecycle).toBe('stopped');
      expect(anchored.message).toContain('stopped');
    });

    it('refuses stale_claim rather than anchoring the active default (#586)', async () => {
      const reader = fakeReader({
        active: activeRun,
        claimResolution: { status: 'missing', claimId },
      });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('stale_claim');
      if (anchored.kind !== 'stale_claim') throw new Error('expected stale_claim');
      expect(anchored.message).toContain('does not exist');
    });

    it('refuses a stashed claim with its actionable message (#586)', async () => {
      // The claim head is consulted WITHOUT `allowStashed`, so a stashed child
      // never anchors here. Rather than discarding that diagnosis, the anchor
      // surfaces it so the operator learns what to actually do. Also pins the
      // visibility choice: flipping `allowStashed` on makes the fake resolve
      // `claimed`, anchoring the stashed run and failing this assertion.
      const reader = fakeReader({
        active: activeRun,
        claimResolution: { status: 'unlinked', claim: verifiedClaim, reason: 'stashed' },
      });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('stale_claim');
      if (anchored.kind !== 'stale_claim') throw new Error('expected stale_claim');
      expect(anchored.message).toContain('rundown pop');
    });

    it('refuses stale_claim even when no active default exists', async () => {
      // The claim's own diagnosis outranks the absence of a fallback: `none`
      // would tell the operator "no active runbook", which is not their problem.
      const reader = fakeReader({ active: null, claimResolution: { status: 'missing', claimId } });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: bearerEvidence });

      expect(anchored.kind).toBe('stale_claim');
    });
  });

  describe('(3) the active default is the bare fallback', () => {
    it('anchors the active run for non-claim evidence', async () => {
      const reader = fakeReader({ active: activeRun });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: pluginEvidence });

      expect(anchored.kind).toBe('ok');
      if (anchored.kind !== 'ok') throw new Error('expected ok');
      expect(anchored.state.id).toBe(activeRunId);
    });

    it('resolves none when no run is active', async () => {
      const reader = fakeReader({ active: null });

      const anchored = await resolveIssuanceAnchor(reader, { callerEvidence: pluginEvidence });

      expect(anchored.kind).toBe('none');
    });
  });
});
