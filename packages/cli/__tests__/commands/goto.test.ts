import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
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
      runCli('run --prompted runbooks/goto.runbook.md', workspace);
    });

    it('jumps to specified step number', async () => {
      const result = runCli(['goto', '3'], workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3');
    });

    it('resets retryCount on jump', async () => {
      runCli('stop', workspace);
      runCli('run --prompted runbooks/retry.runbook.md', workspace);

      // Increment retry by failing on a FAIL: RETRY condition
      runCli('fail', workspace);
      runCli(['goto', '2'], workspace);

      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(0);
    });

    it('outputs jumped step info', async () => {
      const result = runCli(['goto', '3'], workspace);

      expect(result.stdout).toContain('Action:   GOTO 3');
      expect(result.stdout).toContain('Jump target');
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/goto.runbook.md', workspace);
    });

    it('rejects invalid step numbers', async () => {
      const result = runCli(['goto', '999'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it('requires step number argument', async () => {
      const result = runCli('goto', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('missing required argument');
    });

    it('rejects NEXT target via CLI', async () => {
      const result = runCli(['goto', 'NEXT'], workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('GOTO NEXT is only valid as a runbook transition');
    });
  });
});
