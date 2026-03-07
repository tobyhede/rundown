import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  type TestWorkspace,
} from '../helpers/test-utils.js';

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
      await runCliInProcess('run --prompted runbooks/goto.runbook.md', workspace);
    });

    it('jumps to specified step number', async () => {
      const result = await runCliInProcess(['goto', '3'], workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3');
    });

    it('resets retryCount on jump', async () => {
      await runCliInProcess('stop', workspace);
      await runCliInProcess('run --prompted runbooks/retry.runbook.md', workspace);

      // Increment retry by failing on a FAIL: RETRY condition
      await runCliInProcess('fail', workspace);
      await runCliInProcess(['goto', '2'], workspace);

      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(0);
    });

    it('outputs jumped step info', async () => {
      const result = await runCliInProcess(['goto', '3'], workspace);

      expect(result.stdout).toContain('Action:   GOTO 3');
      expect(result.stdout).toContain('Jump target');
    });
  });

  describe('error handling', () => {
    it('shows no active runbook when none started', async () => {
      const result = await runCliInProcess(['goto', '1'], workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active runbook');
    });

    it('rejects invalid step numbers', async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md', workspace);

      const result = await runCliInProcess(['goto', '999'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('STEP_NOT_FOUND');
    });

    it('requires step number argument', async () => {
      const result = await runCliInProcess('goto', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('missing required argument');
    });

    it('rejects AT on non-FOR step', async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md', workspace);

      const result = await runCliInProcess(['goto', '2 AT 5'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('INVALID_AT_TARGET');
    });
  });
});
