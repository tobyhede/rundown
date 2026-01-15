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
      'navigation/goto-static.runbook.md',
      'navigation/goto-dynamic-substep.runbook.md',
      'navigation/goto-named.runbook.md',
      'dynamic/dynamic-step-next.runbook.md',
    ];

    for (const pattern of patterns) {
      const src = join(patternsDir, pattern);
      const filename = pattern.split('/').pop()!;
      const dest = join(targetDir, filename);
      copyFileSync(src, dest);
    }
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('GOTO N (step jump)', () => {
    it('jumps from step 1 to step 3, skipping step 2', async () => {
      runCli('run --prompted --step 1 goto-static.runbook.md', workspace);

      // Step 1 passes → GOTO 3
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('## 3');
      expect(result.stdout).toContain('Jump Target');

      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3');

      // Complete from step 3
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('complete');
    });
  });

  describe('GOTO N.M (substep jump)', () => {
    it('jumps from 4.1 to 4.3, skipping 4.2', async () => {
      runCli('run --prompted --step 4 goto-static.runbook.md', workspace);

      // Substep 4.1 passes → GOTO 4.3
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('GOTO 4.3');
      expect(result.stdout).toContain('Step:     4.3');

      // State stores step and substep separately
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('4');
      expect(state?.substep).toBe('3');

      // Complete from 4.3
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
      runCli('run --prompted dynamic-step-next.runbook.md', workspace);

      // Instance passes → GOTO NEXT (rendered as step advancement)
      let result = runCli('pass', workspace);
      // Dynamic steps show {N} template in output
      expect(result.stdout).toContain('{N}');

      // Check for iteration (next instance)
      // Actually {N} output is usually like "Step: 1/{N}"
      expect(result.stdout).toContain('1/{N}');
    });
  });
  
  describe('GOTO NEXT (static)', () => {
    it('advances to next static step via GOTO NEXT', async () => {
      runCli('run --prompted --step 6 goto-static.runbook.md', workspace);
      
      // Step 6 passes -> GOTO NEXT (step 7)
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('GOTO NEXT');
      expect(result.stdout).toContain('## 7');
      expect(result.stdout).toContain('Next Target');
    });
  });

  describe('GOTO named (named step jump)', () => {
    it('jumps to named steps (Initialize → Cleanup)', async () => {
      runCli('run --prompted goto-named.runbook.md', workspace);

      // Initialize passes → GOTO Cleanup
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('Cleanup');

      // Cleanup passes → COMPLETE
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('complete');
    });

    it('jumps from named to static (Process → 1)', async () => {
      runCli('run --prompted --step Process goto-named.runbook.md', workspace);

      // Process passes → GOTO 1
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('## 1');
      expect(result.stdout).toContain('Static Step');
    });
  });
});