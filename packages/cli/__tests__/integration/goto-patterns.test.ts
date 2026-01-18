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

        const start = runCli('run --prompted goto-static.runbook.md', workspace);

        expect(start.exitCode).toBe(0);

  

        // Step 1 passes → GOTO 3

        const result1 = runCli('pass', workspace);

        expect(result1.stdout).toContain('## 3');

        expect(result1.stdout).toContain('Jump Target');



        const state = await getActiveState(workspace);

        expect(state?.step).toBe('3');



        // Complete from step 3

        const result2 = runCli('pass', workspace);

        expect(result2.stdout).toContain('COMPLETE');

      });

    });

  

    describe('GOTO N.M (substep jump)', () => {

      it('jumps from 4.1 to 4.3, skipping 4.2', async () => {

        const start = runCli('run --prompted goto-static.runbook.md', workspace);

        expect(start.exitCode).toBe(0);

        runCli('goto 4', workspace);

  

        // Substep 4.1 passes → GOTO 4.3

        const result1 = runCli('pass', workspace);

        expect(result1.stdout).toContain('GOTO 4.3');

        expect(result1.stdout).toContain('At:');
        expect(result1.stdout).toContain('4.3');

  

        // State stores step and substep separately

        const state = await getActiveState(workspace);

        expect(state?.step).toBe('4');

        expect(state?.substep).toBe('3');

  

        // Complete from 4.3

        // Complete from step 3

        const result2 = runCli('pass', workspace);

        expect(result2.stdout).toContain('COMPLETE');

      });

    });

  

    describe('GOTO {N}.M (dynamic substep)', () => {

      it('jumps within dynamic instance from {N}.1 to {N}.3', async () => {

        const start = runCli('run --prompted goto-dynamic-substep.runbook.md', workspace);

        expect(start.exitCode).toBe(0);

  

        // First instance: {N}.1 → GOTO {N}.3 (now resolved as GOTO 1.3)

        const result1 = runCli('pass', workspace);

        expect(result1.stdout).toContain('GOTO 1.3');

        expect(result1.stdout).toContain('At:');
        expect(result1.stdout).toContain('1.3');



        // {N}.3 passes → GOTO NEXT advances the dynamic instance

        const result2 = runCli('pass', workspace);

        // Dynamic step advancement shows asterisk for unbounded total

        expect(result2.stdout).toMatch(/\/\d+\*/);

      });

    });

  

    describe('GOTO NEXT (dynamic instance advance)', () => {

      it('advances through dynamic instances via GOTO NEXT', async () => {

        const start = runCli('run --prompted dynamic-step-next.runbook.md', workspace);

        expect(start.exitCode).toBe(0);

  

        // Instance passes → GOTO NEXT (rendered as step advancement)

        const result = runCli('pass', workspace);

        // Dynamic steps show asterisk for unbounded total

        expect(result.stdout).toMatch(/\/\d+\*/);



        // Check for iteration (next instance)

        expect(result.stdout).toMatch(/\/\d+\*/);

      });

    });

    

    describe('GOTO named (named step jump)', () => {

      it('jumps to named steps (Initialize → Cleanup)', async () => {

        const start = runCli('run --prompted goto-named.runbook.md', workspace);

        expect(start.exitCode).toBe(0);

  

        // Initialize passes → GOTO Cleanup

        const result1 = runCli('pass', workspace);

        expect(result1.stdout).toContain('Cleanup');

  

        // Cleanup passes → COMPLETE

        // Complete from step 3

        const result2 = runCli('pass', workspace);

        expect(result2.stdout).toContain('COMPLETE');

      });

  

      it('jumps from named to static (Process → 1)', async () => {

        const start = runCli('run --prompted goto-named.runbook.md', workspace);

        expect(start.exitCode).toBe(0);

        runCli('goto Process', workspace);

  

        // Process passes → GOTO 1

        const result = runCli('pass', workspace);

        expect(result.stdout).toContain('## 1');

        expect(result.stdout).toContain('Static Step');

      });

    });

  
});