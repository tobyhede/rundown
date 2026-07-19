import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  backdateClaimSeen,
  createTestWorkspace,
  readSession,
  issueRunControlClaim,
  runCliInProcess,
  getActiveState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { claimKeyFromBearer } from '@rundown-org/core';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/goto.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerGotoCommand } from '../../src/commands/goto.js';

describe('goto command wiring', () => {
  it('registers the goto command with its documented flags and descriptions', () => {
    const program = new Command();
    registerGotoCommand(program);

    const goto = program.commands.find((c) => c.name() === 'goto');
    expect(goto).toBeDefined();
    expect(goto?.description()).toBe('Jump to specific step (e.g., "3" or "3.1" for substep)');

    const byLong = new Map(goto!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--index', '--claim-id', '--text']));
    expect(byLong.get('--index')?.description).toBe('FOR loop iteration to target');
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('goto command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('step jump (goto N)', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);
    });

    it('jumps to specified step number', async () => {
      const result = await runCliInProcess(['goto', '3', '--text'], workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3');
    });

    it('resets retryCount on jump', async () => {
      await runCliInProcess('stop --text', workspace);
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);

      // Increment retry by failing on a FAIL: RETRY condition
      await runCliInProcess('fail --text', workspace);
      await runCliInProcess(['goto', '2', '--text'], workspace);

      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(0);
    });

    it('clears stale lastResult without rewriting machine-owned GOTO lastAction', async () => {
      await runCliInProcess('stop --text', workspace);
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);
      await runCliInProcess('fail --text', workspace);

      const result = await runCliInProcess(['goto', '2', '--text'], workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.lastResult).toBeUndefined();
      expect(state?.lastAction).toEqual({ type: 'GOTO', origin: 'direct', target: '2' });
    });

    it('outputs jumped step info', async () => {
      const result = await runCliInProcess(['goto', '3', '--text'], workspace);

      expect(result.stdout).toContain('Action:   GOTO 3');
      expect(result.stdout).toContain('Jump target');
    });
  });

  describe('--run explicit targeting', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);
    });

    it('navigates the claimed run via goto <step> --claim-id <id>', async () => {
      const active = await getActiveState(workspace);
      expect(active).toBeDefined();
      const claimId = await issueRunControlClaim(workspace, active!.id);

      const result = await runCliInProcess(['goto', '3', '--claim-id', claimId], workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3');
    });

    it('refuses a well-formed but unknown --run id with RUN_TARGET_UNAVAILABLE', async () => {
      const bogus = `rd_${'f'.repeat(32)}`;

      const result = await runCliInProcess(`goto 3 --run ${bogus}`, workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('RUN_TARGET_UNAVAILABLE');
      // The refusal navigated nothing.
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('1');
    });

    it('rejects a malformed --run id with INVALID_RUN_ID', async () => {
      const result = await runCliInProcess('goto 3 --run not-a-run-id', workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('INVALID_RUN_ID');
    });
  });

  describe('error handling', () => {
    it('shows no active runbook when none started', async () => {
      const result = await runCliInProcess(['goto', '1', '--text'], workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active runbook');
    });

    it('rejects invalid step numbers', async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);

      const result = await runCliInProcess(['goto', '999', '--text'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('STEP_NOT_FOUND');
    });

    it('records an authorized bearer before refusing an invalid goto target', async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);
      const active = await getActiveState(workspace);
      expect(active).toBeDefined();
      const claimId = await issueRunControlClaim(workspace, active!.id);
      const claimKey = claimKeyFromBearer(claimId);
      const epoch = '2020-01-01T00:00:00.000Z';
      await backdateClaimSeen(workspace, claimKey, epoch);

      const result = await runCliInProcess(['goto', '999', '--claim-id', claimId], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('STEP_NOT_FOUND');
      expect(
        Date.parse((await readSession(workspace)).claims[claimKey].lastSeenAt),
      ).toBeGreaterThan(Date.parse(epoch));
    });

    it('requires step number argument', async () => {
      const result = await runCliInProcess('goto --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('missing required argument');
    });

    it('rejects AT on non-FOR step', async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);

      const result = await runCliInProcess(['goto', '2 AT 5', '--text'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('INVALID_AT_TARGET');
    });
  });
});
