import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
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
${iterLines ? `${iterLines}\n` : ''}- PASS ${stepPassMod}: ${stepPass}
- FAIL ${stepFailMod}: ${stepFail}

### 1.1 Check
- PASS: DEFER
- FAIL: DEFER

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
        iterTransitions: `- PASS ALL: DEFER\n- FAIL ANY: BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook in prompted mode
      let result = runCli('run --prompted agg-all-pass.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 1: pass substep 1.1 → DEFER feeds 'pass' → iteration DEFER → loop back
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2: pass substep 1.1 → DEFER feeds 'pass' → last iteration
      // Parent aggregation: [pass, pass] → PASS ALL → CONTINUE to step 2
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
        iterTransitions: `- PASS ALL: DEFER\n- FAIL ANY: BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook in prompted mode
      expect(runCli('run --prompted agg-one-fail.runbook.md', workspace).exitCode).toBe(0);

      // Iteration 1: pass → DEFER feeds 'pass' → iteration DEFER → loop back to iteration 2
      expect(runCli('pass', workspace).exitCode).toBe(0);

      // Iteration 2: fail → DEFER feeds 'fail' → BREAK at iteration level
      // Parent aggregation: [pass, fail] → PASS ALL fails → FAIL ANY: STOP
      const result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('PASS ANY — one pass suffices', async () => {
      await writeForRunbook(workspace, 'agg-any-pass.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: DEFER\n- FAIL ANY: DEFER`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
        stepPassMod: 'ANY',
        stepFailMod: 'ALL',
      });

      // Start runbook
      expect(runCli('run --prompted agg-any-pass.runbook.md', workspace).exitCode).toBe(0);

      // Iteration 1: fail → DEFER feeds 'fail' → iteration DEFER → loop back
      expect(runCli('fail', workspace).exitCode).toBe(0);

      // Iteration 2: pass → DEFER feeds 'pass' → last iteration
      // Parent aggregation: [fail, pass] → PASS ANY → at least one passed → CONTINUE to step 2
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
        iterTransitions: `- PASS ALL: DEFER\n- FAIL ANY: BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook
      expect(runCli('run --prompted agg-break.runbook.md', workspace).exitCode).toBe(0);

      // Iteration 1: pass → DEFER feeds 'pass' → iteration DEFER → loop back
      expect(runCli('pass', workspace).exitCode).toBe(0);

      // Iteration 2: fail → DEFER feeds 'fail' → BREAK (skips iteration 3)
      // Parent aggregation: [pass, fail] → PASS ALL fails → FAIL ANY: STOP
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
        iterTransitions: `- PASS ALL: DEFER\n- FAIL ANY: RETRY 2 BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook
      expect(runCli('run --prompted retry-break.runbook.md', workspace).exitCode).toBe(0);

      // Iteration 1, attempt 1: fail → substep DEFER feeds 'fail' → RETRY (1/2)
      let result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');

      // Iteration 1, attempt 2: fail → substep DEFER feeds 'fail' → RETRY (2/2)
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');

      // Iteration 1, attempt 3: fail → retries exhausted → BREAK
      // Parent aggregation: [fail] → PASS ALL fails → FAIL ANY: STOP
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('RETRY 1 DEFER — retries then defers to next iteration', async () => {
      await writeForRunbook(workspace, 'retry-defer.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: DEFER\n- FAIL ANY: RETRY 1 DEFER`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook
      expect(runCli('run --prompted retry-defer.runbook.md', workspace).exitCode).toBe(0);

      // Iteration 1, attempt 1: fail → substep DEFER feeds 'fail' → RETRY (1/1)
      let result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');

      // Iteration 1, attempt 2: fail → retry exhausted → DEFER (loop back with 'fail' accumulated)
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2: pass → substep DEFER feeds 'pass' → last iteration
      // Parent aggregation: [fail, pass] → PASS ALL fails → FAIL ANY: STOP
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('RETRY succeeds on second attempt', async () => {
      await writeForRunbook(workspace, 'retry-success.runbook.md', {
        iterations: 2,
        iterTransitions: `- PASS ALL: DEFER\n- FAIL ANY: RETRY 2 BREAK`,
        stepPass: 'CONTINUE',
        stepFail: 'STOP',
      });

      // Start runbook
      expect(runCli('run --prompted retry-success.runbook.md', workspace).exitCode).toBe(0);

      // Iteration 1, attempt 1: fail → substep DEFER feeds 'fail' → RETRY
      let result = runCli('fail', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');

      // Iteration 1, attempt 2: pass → substep DEFER feeds 'pass' → iteration passes
      // Iteration DEFER → loop back to iteration 2
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Iteration 2: pass → substep DEFER feeds 'pass' → last iteration
      // Parent aggregation: [pass, pass] → PASS ALL → CONTINUE to step 2
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Final step');

      // Complete step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });
  });

  // ===========================================================================
  // Group 4: Substep Loop Control Bypasses Iteration Retry
  // ===========================================================================
  describe('substep loop-control bypasses iteration retry', () => {
    it('substep BREAK skips iteration retry', async () => {
      // Substep ON FAIL: BREAK should bypass iteration-level RETRY 2 BREAK
      const filename = 'substep-break-bypass.runbook.md';
      const content = `## 1. Process
- FOR i IN 1 TO 3
  - FAIL ANY: RETRY 2 BREAK
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 First check
- PASS: DEFER
- FAIL: DEFER

Do the first check.

### 1.2 Second check
- PASS: DEFER
- FAIL: BREAK

Do the second check.

## 2. Done
- PASS: COMPLETE

Final step.
`;
      await writeFile(join(workspace.cwd, filename), content);

      // Start runbook in prompted mode
      expect(runCli(`run --prompted ${filename}`, workspace).exitCode).toBe(0);

      // Iteration 1: substep 1.1 FAIL (DEFER accumulates fail), substep 1.2 FAIL (BREAK exits)
      expect(runCli('fail', workspace).exitCode).toBe(0);
      const result = runCli('fail', workspace);
      // BREAK exits loop → aggregation: deferredResults=[fail] → fail → PASS ALL fails → STOP
      expect(result.exitCode).toBe(1);
      // Retry should NOT have fired
      expect(result.stdout).not.toContain('RETRY');
    });
  });
});
