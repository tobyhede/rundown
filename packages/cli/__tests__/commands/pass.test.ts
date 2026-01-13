import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  readSession,
  getAllStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

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

    it('marks workflow complete', async () => {
      const result = runCli('pass', workspace);

      expect(result.stdout).toContain('complete');
    });

    it('clears active workflow', async () => {
      runCli('pass', workspace);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });

    it('should set variables.completed=true when completing workflow', async () => {
      runCli('pass', workspace);

      const states = await getAllStates(workspace);
      const state = states.find(s => s.workflow === 'runbooks/simple.runbook.md');
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

  describe('nested workflow completion restores parent', () => {
    it('should restore parent workflow as active when nested child completes', async () => {
      // Create parent/child workflows for nesting test
      const parentWorkflow = `## 1. Parent step
- PASS: COMPLETE

Do parent work.
`;
      const childWorkflow = `## 1. Child step
- PASS: COMPLETE

Do child work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-nest.md'), parentWorkflow);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-nest.md'), childWorkflow);

      // Start parent workflow (prompted mode to keep it active)
      runCli('run --prompted runbooks/parent-nest.md', workspace);
      const session1 = await readSession(workspace);
      const parentId = session1.active;

      // Start child workflow in same stack (nested)
      runCli('run --prompted runbooks/child-nest.md', workspace);
      const session2 = await readSession(workspace);
      expect(session2.active).not.toBe(parentId); // Child is now active
      expect(session2.defaultStack).toContain(parentId); // Parent still in stack

      // Complete child workflow
      runCli('pass', workspace); // Child step 1: DONE -> complete

      // Parent should now be active (child popped from stack)
      const session3 = await readSession(workspace);
      expect(session3.active).toBe(parentId);
    });
  });

  describe('agent workflow completion', () => {
    it('should complete agent workflow independently of parent', async () => {
      // Start parent workflow (prompted mode to keep it active)
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      const session1 = await readSession(workspace);
      const parentId = session1.active;

      // Start agent workflow independently (not via binding)
      runCli('run --prompted runbooks/simple.runbook.md --agent test-agent', workspace);

      // Agent has its own workflow
      const session2 = await readSession(workspace);
      expect(session2.stacks['test-agent']).toBeDefined();
      expect(session2.stacks['test-agent'].length).toBe(1);

      // Parent still in default stack
      expect(session2.defaultStack).toContain(parentId);

      // Complete agent's workflow
      runCli(['pass', '--agent', 'test-agent'], workspace); // Step 1: CONTINUE -> Step 2
      runCli(['pass', '--agent', 'test-agent'], workspace); // Step 2: DONE -> complete

      // Agent stack should be empty now
      const session3 = await readSession(workspace);
      expect(session3.stacks['test-agent'] ?? []).toHaveLength(0);

      // Parent should still be active in default stack
      expect(session3.defaultStack).toContain(parentId);
    });
  });

  describe('workflow completion with stack', () => {
    it('pops to parent workflow on completion', async () => {
      // Create parent/child workflows
      const parentWorkflow = `## 1. Step one
- PASS: COMPLETE

Do something.
`;
      const childWorkflow = `## 1. Step one
- PASS: COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.md'), parentWorkflow);
      await writeFile(join(workspace.cwd, 'runbooks', 'child.md'), childWorkflow);

      // Start parent (prompted to prevent auto-completion)
      runCli('run --prompted runbooks/parent.md', workspace);

      // Start child in same stack (prompted to prevent auto-completion)
      runCli('run --prompted runbooks/child.md', workspace);

      // Complete child
      let result = runCli('pass', workspace);
      expect(result.stdout).toContain('complete');

      // Should now be on parent
      result = runCli('status', workspace);
      expect(result.stdout).toContain('parent.md');
    });

    it('agent workflow pops to null when no parent', async () => {
      // Create a single-step workflow for quick completion
      const singleStep = `## 1. Do it
- PASS: COMPLETE
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'single.md'), singleStep);

      runCli('run --prompted runbooks/single.md --agent agent-001', workspace);

      // Complete workflow
      runCli('pass --agent agent-001', workspace);

      // Agent stack should be empty
      const result = runCli('status --agent agent-001', workspace);
      expect(result.stdout).toContain('No active workflow');
    });
  });
});
