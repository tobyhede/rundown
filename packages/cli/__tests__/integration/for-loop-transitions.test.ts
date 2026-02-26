import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Options for the shared FOR runbook template.
 */
interface WriteForRunbookOptions {
  /** Number of iterations (default: 2) */
  iterations?: number;
  /** Raw iteration-level transition lines (indented under FOR) */
  iterTransitions?: string;
  /** Step-level PASS transition (default: 'CONTINUE') */
  stepPass?: string;
  /** Step-level FAIL transition (default: 'STOP') */
  stepFail?: string;
  /** Step-level PASS modifier (default: 'ALL') */
  stepPassMod?: string;
  /** Step-level FAIL modifier (default: 'ANY') */
  stepFailMod?: string;
}

/**
 * Write a two-step FOR runbook template with configurable transitions.
 *
 * Structure:
 * - Step 1: FOR loop with one substep (1.1 Check)
 * - Step 2: Final step with PASS: COMPLETE
 *
 * In --prompted mode, each substep iteration requires `rd pass` or `rd fail`.
 */
async function writeForRunbook(
  workspace: TestWorkspace,
  filename: string,
  options: WriteForRunbookOptions = {},
): Promise<void> {
  const {
    iterations = 2,
    iterTransitions = '',
    stepPass = 'CONTINUE',
    stepFail = 'STOP',
    stepPassMod = 'ALL',
    stepFailMod = 'ANY',
  } = options;

  const iterLines = iterTransitions
    ? iterTransitions
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => `  ${l.trim()}`)
        .join('\n')
    : '';

  const content = `## 1. Process
- FOR i IN 1 TO ${String(iterations)}
${iterLines ? iterLines + '\n' : ''}- PASS ${stepPassMod}: ${stepPass}
- FAIL ${stepFailMod}: ${stepFail}

### 1.1 Check
- PASS: CONTINUE
- FAIL: CONTINUE

Do the check.

## 2. Done
- PASS: COMPLETE

Final step.
`;

  await writeFile(join(workspace.cwd, filename), content);
}

describe('FOR loop transitions integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  // ===========================================================================
  // Group 1: FOR Loop Aggregation
  // ===========================================================================
  describe('FOR loop aggregation', () => {
    it('PASS ALL — all iterations pass → CONTINUE to next step', async () => {
      await writeForRunbook(workspace, 'agg-all-pass.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: CONTINUE\n- FAIL ANY: BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook in prompted mode
      let result = runCli('run --prompted agg-all-pass.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 1: pass substep 1.1
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2: pass substep 1.1
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Should now be at step 2 — pass to complete
      expect(result.stdout).toContain('Final step');
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('PASS ALL — one iteration fails → STOP', async () => {
      await writeForRunbook(workspace, 'agg-one-fail.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: CONTINUE\n- FAIL ANY: BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook in prompted mode
      runCli('run --prompted agg-one-fail.runbook.md', workspace);

      // Iteration 1: pass
      runCli('pass', workspace);

      // Iteration 2: fail → BREAK at iteration level → step-level PASS ALL fails → STOP
      const result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('PASS ANY — one pass suffices', async () => {
      await writeForRunbook(workspace, 'agg-any-pass.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: CONTINUE\n- FAIL ANY: CONTINUE`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
        stepPassMod: 'ANY',
        stepFailMod: 'ALL',
      });

      // Start runbook
      runCli('run --prompted agg-any-pass.runbook.md', workspace);

      // Iteration 1: fail → iteration-level CONTINUE (no BREAK)
      runCli('fail', workspace);

      // Iteration 2: pass → iteration-level CONTINUE → loop ends
      // Step-level PASS ANY: [fail, pass] → at least one passed → CONTINUE to step 2
      let result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Final step');

      // Complete step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('FAIL ANY: BREAK at iteration level — early exit skips remaining iterations', async () => {
      await writeForRunbook(workspace, 'agg-break.runbook.md', {
        iterations: 3,
        iterTransitions: `- PASS ALL: CONTINUE\n- FAIL ANY: BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook
      runCli('run --prompted agg-break.runbook.md', workspace);

      // Iteration 1: pass
      runCli('pass', workspace);

      // Iteration 2: fail → BREAK (skips iteration 3)
      // Only 2 rd commands needed before terminal state
      const result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);
    });
  });

  // ===========================================================================
  // Group 2: FOR Iteration-Level RETRY
  // ===========================================================================
  describe('FOR iteration-level RETRY', () => {
    it('RETRY 2 BREAK — exhausts retries then breaks', async () => {
      await writeForRunbook(workspace, 'retry-break.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: CONTINUE\n- FAIL ANY: RETRY 2 BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook
      runCli('run --prompted retry-break.runbook.md', workspace);

      // Iteration 1, attempt 1: fail → RETRY (1/2)
      let result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');

      // Iteration 1, attempt 2: fail → RETRY (2/2)
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');

      // Iteration 1, attempt 3: fail → retries exhausted → BREAK → STOP
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('RETRY 1 CONTINUE — retries then continues to next iteration', async () => {
      await writeForRunbook(workspace, 'retry-continue.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: CONTINUE\n- FAIL ANY: RETRY 1 CONTINUE`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook
      runCli('run --prompted retry-continue.runbook.md', workspace);

      // Iteration 1, attempt 1: fail → RETRY (1/1)
      let result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');

      // Iteration 1, attempt 2: fail → retry exhausted → CONTINUE to iteration 2
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2: pass → loop ends
      // Step-level PASS ALL: [fail, pass] → not all passed → STOP
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('RETRY succeeds on second attempt', async () => {
      await writeForRunbook(workspace, 'retry-success.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: CONTINUE\n- FAIL ANY: RETRY 2 BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook
      runCli('run --prompted retry-success.runbook.md', workspace);

      // Iteration 1, attempt 1: fail → RETRY
      let result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');

      // Iteration 1, attempt 2: pass → iteration 1 passes, advance to iteration 2
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2: pass → all iterations pass → CONTINUE to step 2
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Final step');

      // Complete step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });
  });

  // ===========================================================================
  // Group 3: FOR with Nested Runbook Substeps + Agent Dispatch
  // ===========================================================================
  describe('FOR with nested runbook substeps and agent dispatch', () => {
    async function writeForWithChildRunbooks(ws: TestWorkspace): Promise<void> {
      const runbooksDir = join(ws.cwd, 'runbooks');
      await mkdir(runbooksDir, { recursive: true });

      const parentContent = `## 1. Process items
- FOR i IN 1 TO 2
  - PASS ALL: CONTINUE
  - FAIL ANY: BREAK
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Work item

- child.runbook.md

## 2. Done
- PASS: COMPLETE

Final step.
`;

      const childContent = `## 1. Do work
- PASS: COMPLETE

Complete the work.
`;

      await writeFile(join(runbooksDir, 'parent.runbook.md'), parentContent);
      await writeFile(join(runbooksDir, 'child.runbook.md'), childContent);
    }

    it('agent dispatch per iteration — all pass', async () => {
      await writeForWithChildRunbooks(workspace);

      // Start parent runbook in prompted mode
      let result = runCli('run --prompted runbooks/parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 1: queue step for agent, bind agent, agent passes
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('run --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);

      // Auto-advanced parent past iteration 1 substep → moves to iteration 2
      // Iteration 2: queue step for agent, bind agent, agent passes
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('run --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      result = runCli('pass --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);

      // Auto-advanced parent past iteration 2 substep → FOR loop ends → step 2
      // Pass step 2 to complete
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('agent fails on second iteration → BREAK → STOP', async () => {
      await writeForWithChildRunbooks(workspace);

      // Start parent runbook in prompted mode
      let result = runCli('run --prompted runbooks/parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 1: agent passes
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('run --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);

      // Auto-advanced parent past iteration 1 substep → moves to iteration 2
      // Iteration 2: agent fails
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('run --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Agent fails child → child stops → auto-propagates FAIL to parent → BREAK → STOP
      result = runCli('fail --agent agent-2', workspace);
      expect(result.exitCode).toBe(1);
    });
  });

  // ===========================================================================
  // Group 4: FOR + Multi-Substep Agent Dispatch
  // ===========================================================================
  describe('FOR with multi-substep agent dispatch', () => {
    async function writeForMultiSubstep(ws: TestWorkspace): Promise<void> {
      const content = `## 1. Process
- FOR i IN 1 TO 2
  - PASS ALL: CONTINUE
  - FAIL ANY: BREAK
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Validate
Validate the item.

### 1.2 Transform
Transform the item.

## 2. Done
- PASS: COMPLETE

Final step.
`;
      await writeFile(join(ws.cwd, 'for-multi.runbook.md'), content);
    }

    it('FOR + multi-substep — all iterations all substeps pass', async () => {
      await writeForMultiSubstep(workspace);

      // Start at substep 1.1 (iteration 1)
      let result = runCli('run --prompted for-multi.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 1, substep 1.1
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-1a', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');
      result = runCli('pass --agent agent-1a', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 1, substep 1.2
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-1b', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');
      result = runCli('pass --agent agent-1b', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2, substep 1.1
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-2a', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');
      result = runCli('pass --agent agent-2a', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2, substep 1.2
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-2b', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');
      result = runCli('pass --agent agent-2b', workspace);
      expect(result.exitCode).toBe(0);

      // All iterations + substeps passed → CONTINUE to step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('FOR + multi-substep — second iteration first substep fails → BREAK → STOP', async () => {
      await writeForMultiSubstep(workspace);

      // Start at substep 1.1 (iteration 1)
      runCli('run --prompted for-multi.runbook.md', workspace);

      // Iteration 1: pass both substeps
      runCli('run --step 1', workspace);
      runCli('run --agent agent-1a', workspace);
      let result = runCli('pass --agent agent-1a', workspace);
      expect(result.exitCode).toBe(0);

      runCli('run --step 1', workspace);
      runCli('run --agent agent-1b', workspace);
      result = runCli('pass --agent agent-1b', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2, substep 1.1: fail → BREAK → STOP
      runCli('run --step 1', workspace);
      runCli('run --agent agent-2a', workspace);
      result = runCli('fail --agent agent-2a', workspace);
      expect(result.exitCode).toBe(1);
    });
  });
});
