import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('integration: GOTO patterns', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();

    // Copy pattern runbooks to test workspace
    const patternsDir = join(__dirname, '..', '..', '..', '..', 'runbooks', 'patterns');
    const targetDir = join(workspace.cwd, '.claude', 'rundown', 'runbooks');

    // Ensure target directory exists
    mkdirSync(targetDir, { recursive: true });

    const patterns = [
      'goto-step.runbook.md',
      'goto-substep.runbook.md',
      'goto-dynamic-substep.runbook.md',
      'goto-next.runbook.md',
      'goto-named.runbook.md',
    ];

    for (const pattern of patterns) {
      const src = join(patternsDir, pattern);
      const dest = join(targetDir, pattern);
      copyFileSync(src, dest);
    }
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('GOTO N (step jump)', () => {
    it('jumps from step 1 to step 3, skipping step 2', async () => {
      runCli('run --prompted goto-step.runbook.md', workspace);

      // Step 1 passes → GOTO 3
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('## 3');
      expect(result.stdout).toContain('Jump target');

      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3');

      // Complete from step 3
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('complete');
    });
  });

  describe('GOTO N.M (substep jump)', () => {
    it('jumps from 1.1 to 1.3, skipping 1.2', async () => {
      runCli('run --prompted goto-substep.runbook.md', workspace);

      // Substep 1.1 passes → GOTO 1.3
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('GOTO 1.3');
      expect(result.stdout).toContain('Step:     1.3');

      // State stores step and substep separately
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('1');
      expect(state?.substep).toBe('3');

      // Complete from 1.3
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('complete');
    });
  });

  describe('GOTO {N}.M (dynamic substep)', () => {
    it('jumps within dynamic instance from {N}.1 to {N}.3', async () => {
      runCli('run --prompted goto-dynamic-substep.runbook.md', workspace);

      // First instance: {N}.1 → GOTO {N}.3 (dynamic steps use {N} template)
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('GOTO {N}.3');
      expect(result.stdout).toContain('Step:     1.3/{N}');

      // {N}.3 passes → GOTO NEXT advances the dynamic instance
      result = runCli('pass', workspace);
      // Dynamic step advancement is indicated by step counter reset
      expect(result.stdout).toContain('{N}');
    });
  });

  describe('GOTO NEXT (dynamic instance advance)', () => {
    it('advances through dynamic instances via GOTO NEXT', async () => {
      runCli('run --prompted goto-next.runbook.md', workspace);

      // Instance passes → GOTO NEXT (rendered as step advancement)
      let result = runCli('pass', workspace);
      // Dynamic steps show {N} template in output
      expect(result.stdout).toContain('{N}');

      // Fail to exit loop (FAIL: COMPLETE)
      result = runCli('fail', workspace);
      expect(result.stdout).toContain('complete');
    });
  });

  describe('GOTO named (named step jump)', () => {
    it('jumps to named steps (Process → Cleanup)', async () => {
      runCli('run --prompted goto-named.runbook.md', workspace);

      // Initialize passes → CONTINUE
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('Process');

      // Process passes → GOTO Cleanup (skips ErrorHandler)
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('Cleanup');

      // Cleanup passes → COMPLETE
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('complete');
    });

    it('jumps to ErrorHandler on failure, then to Cleanup', async () => {
      runCli('run --prompted goto-named.runbook.md', workspace);

      // Initialize passes → CONTINUE
      runCli('pass', workspace);

      // Process fails → GOTO ErrorHandler
      let result = runCli('fail', workspace);
      expect(result.stdout).toContain('ErrorHandler');

      // ErrorHandler passes → GOTO Cleanup
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('Cleanup');

      // Cleanup passes → COMPLETE
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('complete');
    });
  });
});
