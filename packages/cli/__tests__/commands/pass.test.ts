import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  readSession,
  getAllStates,
  findActionOutput,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { ActionResponseSchema } from '../helpers/schema-validator.js';

describe('pass command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('PASS: CONTINUE', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('advances to next step', async () => {
      const result = runCli('pass', workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('2');
    });
  });

  describe('PASS: COMPLETE', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      runCli('pass', workspace); // Advance to step 2 which has PASS: COMPLETE
    });

    it('marks runbook complete', async () => {
      const result = runCli('pass', workspace);

      expect(result.stdout).toContain('COMPLETE');
    });

    it('clears active runbook', async () => {
      runCli('pass', workspace);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });

    it('should set variables.completed=true when completing runbook', async () => {
      runCli('pass', workspace);

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/simple.runbook.md');
      expect(state?.variables.completed).toBe(true);
    });
  });

  describe('PASS: GOTO N', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/goto.runbook.md', workspace);
    });

    it('jumps to specified step', async () => {
      const result = runCli('pass', workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3'); // GOTO 3
    });

    it('skips intermediate steps', async () => {
      runCli('pass', workspace);

      const state = await getActiveState(workspace);
      expect(state?.stepName).toContain('Jump target');
    });
  });

  describe('PASS: RETRY N', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/pass-retry.runbook.md', workspace);
    });

    it('increments retryCount if under max', async () => {
      runCli('pass', workspace);

      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1'); // Same step
    });

    it('outputs retry info', async () => {
      const result = runCli('pass', workspace);

      expect(result.stdout).toContain('Retry');
    });

    it('advances after max retries', async () => {
      runCli('pass', workspace); // Retry 1 (count 0→1)
      runCli('pass', workspace); // Retry 2 (count 1→2)
      runCli('pass', workspace); // Retry 3 (count 2→3)
      runCli('pass', workspace); // Count 3 >= 3, CONTINUE to step 2

      const state = await getActiveState(workspace);
      expect(state?.step).toBe('2'); // Advanced to step 2
    });
  });

  describe('PASS: STOP', () => {
    beforeEach(async () => {
      // stop-on-pass.md created inline in the lastResult test
      const stopOnPassRunbook = `## 1. Stop on pass
- PASS: STOP
- FAIL: CONTINUE

This step stops on pass.
`;
      return mkdir(join(workspace.cwd, 'runbooks'), { recursive: true })
        .then(() =>
          writeFile(join(workspace.cwd, 'runbooks', 'stop-on-pass.md'), stopOnPassRunbook),
        )
        .then(() => runCli('run --prompted runbooks/stop-on-pass.md', workspace));
    });

    it('blocks runbook', async () => {
      const result = runCli('pass', workspace);

      expect(result.exitCode).toBe(1);
    });

    it('outputs stop message', async () => {
      const result = runCli('pass', workspace);

      expect(result.stdout).toContain('STOP');
    });

    it('should set variables.stopped=true when STOP action triggered', async () => {
      runCli('pass', workspace);

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/stop-on-pass.md');
      expect(state?.variables.stopped).toBe(true);
    });
  });

  describe('nested runbook completion restores parent', () => {
    it('should restore parent runbook as active when nested child completes', async () => {
      // Create parent/child runbooks for nesting test
      const parentRunbook = `## 1. Parent step
- PASS: COMPLETE

Do parent work.
`;
      const childRunbook = `## 1. Child step
- PASS: COMPLETE

Do child work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-nest.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-nest.md'), childRunbook);

      // Start parent runbook (prompted mode to keep it active)
      runCli('run --prompted runbooks/parent-nest.md', workspace);
      const session1 = await readSession(workspace);
      const parentId = session1.active;

      // Start child runbook in same stack (nested)
      runCli('run --prompted runbooks/child-nest.md', workspace);
      const session2 = await readSession(workspace);
      expect(session2.active).not.toBe(parentId); // Child is now active
      expect(session2.defaultStack).toContain(parentId); // Parent still in stack

      // Complete child runbook
      runCli('pass', workspace); // Child step 1: DONE -> complete

      // Parent should now be active (child popped from stack)
      const session3 = await readSession(workspace);
      expect(session3.active).toBe(parentId);
    });
  });

  describe('runbook completion with stack', () => {
    it('pops to parent runbook on completion', async () => {
      // Create parent/child runbooks
      const parentRunbook = `## 1. Step one
- PASS: COMPLETE

Do something.
`;
      const childRunbook = `## 1. Step one
- PASS: COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child.md'), childRunbook);

      // Start parent (prompted to prevent auto-completion)
      runCli('run --prompted runbooks/parent.md', workspace);

      // Start child in same stack (prompted to prevent auto-completion)
      runCli('run --prompted runbooks/child.md', workspace);

      // Complete child
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');

      // Should now be on parent
      result = runCli('status', workspace);
      expect(result.stdout).toContain('parent.md');
    });
  });

  describe('lastResult semantics', () => {
    it('sets lastResult to pass even when STOP is triggered', async () => {
      // Create a runbook where PASS triggers STOP (edge case)
      const stopOnPassRunbook = `## 1. Stop on pass
- PASS: STOP
- FAIL: CONTINUE

This step stops on pass.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'stop-on-pass.md'), stopOnPassRunbook);

      runCli('run --prompted runbooks/stop-on-pass.md', workspace);
      runCli('pass', workspace);

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/stop-on-pass.md');

      // lastResult should reflect user's choice (pass), not transition outcome
      expect(state?.lastResult).toBe('pass');
    });
  });

  describe('JSON action result semantics', () => {
    it('reports result: true for CONTINUE transitions', async () => {
      // Start runbook in prompted mode
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      // Pass should trigger CONTINUE to next step
      const result = runCli('pass --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('CONTINUE');
      expect(output?.result).toBe(true);

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports result FAIL in JSONL for RETRY transitions', async () => {
      // Create retry runbook where pass triggers retry (via command failure)
      const retryRunbook = `## 1. Retry on pass fail

- PASS: CONTINUE
- FAIL: RETRY 3

This step has FAIL: RETRY.

\`\`\`bash
rd echo --result fail
\`\`\`

## 2. Done

- PASS: COMPLETE
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'retry-test.md'), retryRunbook);

      // Start runbook (not prompted - will execute command which fails, triggering RETRY)
      const result = runCli('run runbooks/retry-test.md --json', workspace);
      const lines = result.stdout.trim().split('\n');

      // Find the STEP_TRANSITIONED JSONL event with RETRY action
      let foundRetry = false;
      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          try {
            const output = JSON.parse(line) as Record<string, unknown>;
            const action = output.action as string | undefined;
            if (action?.startsWith('RETRY') && typeof output.result === 'string') {
              // In JSONL execution events, result is 'PASS'|'FAIL' string from StepTransitionedPayload
              expect(output.result).toBe('FAIL');
              foundRetry = true;
              break;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
      expect(foundRetry).toBe(true);
    });

    it('reports result: true for COMPLETE transitions', async () => {
      // Start runbook in prompted mode
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      runCli('pass', workspace); // Advance to step 2

      // Pass on step 2 should trigger COMPLETE
      // The action is 'complete' (lowercase) for completion events
      const result = runCli('pass --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('complete');
      expect(output?.result).toBe(true);
    });

    it('reports result: true for GOTO transitions', async () => {
      // Start goto runbook in prompted mode
      runCli('run --prompted runbooks/goto.runbook.md', workspace);

      // Pass should trigger GOTO 3
      const result = runCli('pass --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^GOTO/);
      expect(output?.result).toBe(true);
    });

    it('reports result: true and stepResult FAIL for RETRY transitions', async () => {
      // Start pass-retry runbook in prompted mode
      runCli('run --prompted runbooks/pass-retry.runbook.md', workspace);

      // Pass should trigger RETRY (since PASS: RETRY 3)
      // result is true (operation non-terminal), stepResult is FAIL (RETRY = not yet passing)
      const result = runCli('pass --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^RETRY/);
      expect(output?.result).toBe(true);
      expect(output?.stepResult).toBe('FAIL');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports result: false for STOP transitions', async () => {
      // Create stop-on-pass runbook
      const stopOnPassRunbook = `## 1. Stop on pass
- PASS: STOP
- FAIL: CONTINUE

This step stops on pass.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'stop-on-pass-json.md'), stopOnPassRunbook);

      // Start runbook in prompted mode
      runCli('run --prompted runbooks/stop-on-pass-json.md', workspace);

      // Pass should trigger STOP
      const result = runCli('pass --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('stop'); // lowercase per CLI conventions
      expect(output?.result).toBe(false);

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });
  });
});
