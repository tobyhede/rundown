import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
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
      const state = states.find(s => s.runbook === 'runbooks/simple.runbook.md');
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

  describe('agent runbook completion', () => {
    it('should complete agent runbook independently of parent', async () => {
      // Start parent runbook (prompted mode to keep it active)
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      const session1 = await readSession(workspace);
      const parentId = session1.active;

      // Start agent runbook independently (not via binding)
      runCli('run --prompted runbooks/simple.runbook.md --agent test-agent', workspace);

      // Agent has its own runbook
      const session2 = await readSession(workspace);
      expect(session2.stacks['test-agent']).toBeDefined();
      expect(session2.stacks['test-agent'].length).toBe(1);

      // Parent still in default stack
      expect(session2.defaultStack).toContain(parentId);

      // Complete agent's runbook
      runCli(['pass', '--agent', 'test-agent'], workspace); // Step 1: CONTINUE -> Step 2
      runCli(['pass', '--agent', 'test-agent'], workspace); // Step 2: DONE -> complete

      // Agent stack should be empty now
      const session3 = await readSession(workspace);
      expect(session3.stacks['test-agent'] ?? []).toHaveLength(0);

      // Parent should still be active in default stack
      expect(session3.defaultStack).toContain(parentId);
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

    it('agent runbook pops to null when no parent', async () => {
      // Create a single-step runbook for quick completion
      const singleStep = `## 1. Do it
- PASS: COMPLETE
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'single.md'), singleStep);

      runCli('run --prompted runbooks/single.md --agent agent-001', workspace);

      // Complete runbook
      runCli('pass --agent agent-001', workspace);

      // Agent stack should be empty
      const result = runCli('status --agent agent-001', workspace);
      expect(result.stdout).toContain('No active runbook');
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
      const state = states.find(s => s.runbook === 'runbooks/stop-on-pass.md');

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
      expect(output!.action).toBe('CONTINUE');
      expect(output!.result).toBe(true);

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports result: false for RETRY transitions', async () => {
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

      // Find the action output line (may be multiple JSON outputs)
      let foundRetry = false;
      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          try {
            const output = JSON.parse(line) as Record<string, unknown>;
            const action = output.action as string | undefined;
            if (action?.startsWith('RETRY')) {
              expect(output.result).toBe(false);
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
      expect(output!.action).toBe('complete');
      expect(output!.result).toBe(true);
    });

    it('reports result: true for GOTO transitions', async () => {
      // Start goto runbook in prompted mode
      runCli('run --prompted runbooks/goto.runbook.md', workspace);

      // Pass should trigger GOTO 3
      const result = runCli('pass --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect((output!.action as string)).toMatch(/^GOTO/);
      expect(output!.result).toBe(true);
    });
  });
});
