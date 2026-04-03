import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCliInProcess,
  readSession,
  getActiveState,
  listRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('start command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('file mode', () => {
    it('creates runbook state from valid runbook file', async () => {
      const result = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      if (result.exitCode !== 0) {
        console.log('Run failed:', result.stdout, result.stderr);
      }

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Action:   START');
      expect(result.stdout).toContain('simple.runbook.md');
    });

    it('sets runbook as active', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      const session = await readSession(workspace);
      expect(session.active).toBeTruthy();
    });

    it('stores relative path in state', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      const state = await getActiveState(workspace);
      expect(state).not.toBeNull();
      expect(state?.runbook).toBe('runbooks/simple.runbook.md');
    });

    it('initializes step=1 and retryCount=0', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      const state = await getActiveState(workspace);
      expect(state?.step).toBe('1');
      expect(state?.retryCount).toBe(0);
    });

    it('outputs first step description', async () => {
      const result = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });

    it('fails if file does not exist', async () => {
      const result = await runCliInProcess('run runbooks/nonexistent.md', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('fails if no file argument provided', async () => {
      const result = await runCliInProcess('run', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('required');
    });

    it('creates state file on disk', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      const stateFiles = await listRunbookStates(workspace);
      expect(stateFiles.length).toBe(1);
    });
  });

  describe('auto-execution mode', () => {
    it('executes commands and advances through runbook', async () => {
      const result = await runCliInProcess('run runbooks/simple.runbook.md', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('$ rd echo --result pass');
      expect(result.stdout).toContain('Runbook:  COMPLETE');
    });

    it('completes runbook when all commands pass', async () => {
      await runCliInProcess('run runbooks/simple.runbook.md', workspace);

      // Runbook completed, so active runbook is null
      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });
  });

  describe('option validation', () => {
    it('rejects --step without active parent runbook', async () => {
      const result = await runCliInProcess('run runbooks/simple.runbook.md --step 1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--step requires an active parent runbook');
    });

    it('rejects --index without --step', async () => {
      const result = await runCliInProcess(
        'run runbooks/simple.runbook.md --prompted --index 1',
        workspace,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--index requires --step');
    });
  });
});
