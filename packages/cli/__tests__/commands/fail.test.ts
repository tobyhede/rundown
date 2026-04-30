import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  getAllStates,
  findActionOutput,
  readRunbookState,
  parseConcatenatedJson,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { ActionResponseSchema, ErrorResponseSchema } from '../helpers/schema-validator.js';

describe('fail command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('FAIL: RETRY N', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);
    });

    it('increments retryCount if under max', async () => {
      await runCliInProcess('fail --text', workspace);

      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1'); // Same step
    });

    it('outputs retry info', async () => {
      const result = await runCliInProcess('fail --text', workspace);

      expect(result.stdout).toContain('Retry');
    });
  });

  describe('FAIL: STOP', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('blocks runbook', async () => {
      const result = await runCliInProcess('fail --text', workspace);

      expect(result.exitCode).toBe(1);
    });

    it('outputs error message', async () => {
      const result = await runCliInProcess('fail --text', workspace);

      expect(result.stdout).toContain('STOP');
    });

    it('should set lifecycle to stopped when STOP action triggered', async () => {
      // runbook already started by beforeEach
      await runCliInProcess('fail --text', workspace);

      // After blocking, the runbook is saved but no longer active
      // Retrieve from all states
      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/simple.runbook.md');
      expect(state?.lifecycle).toBe('stopped');
    });
  });

  describe('FAIL: GOTO N', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/fail-goto.runbook.md --text', workspace);
    });

    it('jumps to specified step on failure', async () => {
      const result = await runCliInProcess('fail --text', workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3'); // GOTO 3 on FAIL
    });
  });

  describe('runbook fail with stack', () => {
    it('pops to parent runbook on fail completion', async () => {
      // Create parent/child runbooks
      const parentRunbook = `## 1. Step one
- PASS COMPLETE
- FAIL COMPLETE

Do something.
`;
      const childRunbook = `## 1. Step one
- PASS COMPLETE
- FAIL COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-fail.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.md'), childRunbook);

      // Start parent (prompted to prevent auto-completion)
      await runCliInProcess('run --prompted runbooks/parent-fail.md --text', workspace);

      // Start child in same stack (prompted to prevent auto-completion)
      await runCliInProcess('run --prompted runbooks/child-fail.md --text', workspace);

      // Fail child - should complete (FAIL: COMPLETE) and pop to parent
      const result = await runCliInProcess('fail --text', workspace);
      expect(result.stdout).toContain('COMPLETE');

      // Should now be on parent
      const statusResult = await runCliInProcess('status --text', workspace);
      expect(statusResult.stdout).toContain('parent-fail.md');
    });
  });

  describe('sibling fan-out isolation', () => {
    interface FrontierEntry {
      id: string;
      runbook: string;
      token: string;
    }

    function findFrontierInEvents(events: unknown[]): FrontierEntry[] | undefined {
      for (const ev of events) {
        if (Array.isArray(ev)) {
          const nested = findFrontierInEvents(ev);
          if (nested) return nested;
        } else if (ev && typeof ev === 'object') {
          const e = ev as { type?: string; delegateFrontier?: FrontierEntry[] };
          if (e.type === 'step_entered' && e.delegateFrontier) {
            return e.delegateFrontier;
          }
        }
      }
      return undefined;
    }

    it('does not let a later claimed sibling steal the first child fail', async () => {
      const childRunbook = [
        '# Child',
        '',
        '## 1. Work',
        '',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Do child work.',
        '',
      ].join('\n');
      const parentRunbook = [
        '# Parent',
        '',
        '## 1. Fan out',
        '',
        '- DELEGATE',
        '- PASS ALL CONTINUE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 First child',
        '',
        '- child-fail.runbook.md',
        '',
        '### 1.2 Second child',
        '',
        '- child-fail.runbook.md',
        '',
      ].join('\n');

      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), childRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-fail.runbook.md'), parentRunbook);
      // Parent is started by explicit root path above; delegated child resolution uses
      // project-local runbook discovery, so this second write is intentional.
      await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), childRunbook);

      const start = await runCliInProcess(
        'run --prompted runbooks/parent-fail.runbook.md',
        workspace,
      );
      const frontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
      const token1 = frontier.find((entry) => entry.id === '1.1')?.token;
      const token2 = frontier.find((entry) => entry.id === '1.2')?.token;
      expect(token1).toBeDefined();
      expect(token2).toBeDefined();

      const agent1 = { env: { RD_AGENT_ID: 'fail-agent-one', RD_SESSION_ID: 'fail-session' } };
      const agent2 = { env: { RD_AGENT_ID: 'fail-agent-two', RD_SESSION_ID: 'fail-session' } };

      let result = await runCliInProcess(`claim ${token1!}`, workspace, agent1);
      const child1Id = String(findActionOutput(result.stdout)?.run_id);

      result = await runCliInProcess(`claim ${token2!}`, workspace, agent2);
      const child2Id = String(findActionOutput(result.stdout)?.run_id);

      result = await runCliInProcess('fail --text', workspace, agent1);
      expect(result.exitCode).toBe(0);

      const child1 = await readRunbookState(workspace, child1Id);
      const child2 = await readRunbookState(workspace, child2Id);

      expect(child1?.lifecycle).toBe('stopped');
      expect(child2?.lifecycle).toBe('running');
    });

    it('anonymous fail does not mutate an agent-owned child runbook', async () => {
      // Regression: anonymous (no RD_AGENT_ID) callers must target only the
      // default-stack runbook (the parent), never an agent-owned delegated child.
      const childRunbook = [
        '# Child',
        '',
        '## 1. Work',
        '',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Do child work.',
        '',
      ].join('\n');
      const parentRunbook = [
        '# Parent',
        '',
        '## 1. Fan out',
        '',
        '- DELEGATE',
        '- PASS ALL CONTINUE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 Only child',
        '',
        '- child-fail.runbook.md',
        '',
      ].join('\n');

      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), childRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-fail.runbook.md'), parentRunbook);
      await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), childRunbook);

      const start = await runCliInProcess(
        'run --prompted runbooks/parent-fail.runbook.md',
        workspace,
      );
      expect(start.exitCode).toBe(0);
      const parentId = (await getActiveState(workspace))?.id;
      expect(parentId).toBeDefined();
      const frontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
      const token = frontier.find((entry) => entry.id === '1.1')?.token;
      expect(token).toBeDefined();

      const agent = { env: { RD_AGENT_ID: 'lone-fail-agent', RD_SESSION_ID: 'lone-fail-session' } };
      const claim = await runCliInProcess(`claim ${token!}`, workspace, agent);
      const childId = String(findActionOutput(claim.stdout)?.run_id);

      // Anonymous fail — must stop the default-stack parent, not the
      // agent-owned child.
      const failResult = await runCliInProcess('fail --text', workspace);
      expect(failResult.exitCode).toBe(1);

      const parent = await readRunbookState(workspace, parentId!);
      const child = await readRunbookState(workspace, childId);
      expect(parent?.lifecycle).toBe('stopped');
      expect(child?.lifecycle).toBe('running');
    }, 30_000);
  });

  describe('JSON output', () => {
    it('includes action field when no active runbook', async () => {
      // Run fail with no active runbook
      const result = await runCliInProcess('fail', workspace);

      // Should exit with error code
      expect(result.exitCode).toBe(0);

      // Parse JSON output
      const output = JSON.parse(result.stdout);

      // No-active-runbook path emits an error response with kind: 'error'
      expect(output).toHaveProperty('kind', 'error');
      expect(output).toHaveProperty('command', 'fail');
      expect(output.code).toBe('NO_ACTIVE_RUNBOOK');

      // Validate against ErrorResponseSchema (not ActionResponseSchema)
      const parseResult = ErrorResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('JSON action result semantics', () => {
    it('reports stepResult FAIL for RETRY transitions', async () => {
      // Start retry runbook in prompted mode
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);

      // Fail should trigger RETRY (since FAIL: RETRY 3)
      const result = await runCliInProcess('fail', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output!.action as string).toMatch(/^RETRY/);
      expect(output!.stepResult).toBe('FAIL');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports action stop for STOP transitions', async () => {
      // Start simple runbook in prompted mode (FAIL: STOP on step 1)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      // Fail should trigger STOP
      const result = await runCliInProcess('fail', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('stop'); // lowercase per CLI conventions

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports stepResult FAIL for GOTO transitions', async () => {
      // Start fail-goto runbook in prompted mode (FAIL: GOTO 3)
      await runCliInProcess('run --prompted runbooks/fail-goto.runbook.md --text', workspace);

      // Fail should trigger GOTO 3
      const result = await runCliInProcess('fail', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^GOTO/);
      expect(output?.stepResult).toBe('FAIL');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('fail with no active runbook exits cleanly', async () => {
      // No runbook started
      const result = await runCliInProcess('fail --text', workspace);

      // Should exit without error (graceful handling)
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active runbook');
    });

    it('fail after max retries exhausted triggers fallback action', async () => {
      // Start retry runbook
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);

      // Fail repeatedly until retries exhausted (RETRY 3 = 3 retries allowed, 4 total attempts)
      await runCliInProcess('fail --text', workspace); // retry 1 (retryCount: 0→1)
      await runCliInProcess('fail --text', workspace); // retry 2 (retryCount: 1→2)
      await runCliInProcess('fail --text', workspace); // retry 3 (retryCount: 2→3)
      const result = await runCliInProcess('fail --text', workspace); // retries exhausted, fallback STOP

      // After max retries, should use on_fail action (STOP by default)
      expect(result.exitCode).toBe(1);
    });

    it('fail on substep with PASS ALL transition defers until all substeps complete', async () => {
      // Two substeps exercise DEFER "wait for all" semantics:
      // failing substep 1.1 must NOT stop immediately; aggregation
      // fires only after substep 1.2 also completes.
      const substepRunbook = `## 1. Process
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First substep
Do first task.

### 1.2 Second substep
Do second task.

## 2. Done
- PASS COMPLETE

Final step.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'substep-fail-any.md'), substepRunbook);

      await runCliInProcess('run --prompted runbooks/substep-fail-any.md --text', workspace);

      // Fail substep 1.1 -- result is deferred, machine advances to 1.2
      await runCliInProcess('fail --text', workspace);

      // Pass substep 1.2 -- all substeps now complete, aggregation fires
      // FAIL ANY: STOP triggers because substep 1.1 was failed
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.exitCode).toBe(1);
      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/substep-fail-any.md');
      expect(state?.lifecycle).toBe('stopped');
    });

    it('consecutive fail commands maintain state consistency', async () => {
      // Create a runbook that transitions on second fail
      const multiFailRunbook = `## 1. Retry step
- FAIL RETRY 2 STOP
- PASS CONTINUE

Try this step.

## 2. Done
- PASS COMPLETE

Final step.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'multi-fail.md'), multiFailRunbook);

      await runCliInProcess('run --prompted runbooks/multi-fail.md --text', workspace);

      // First fail - retry
      let result = await runCliInProcess('fail --text', workspace);
      let state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1');

      // Second fail - retry again
      result = await runCliInProcess('fail --text', workspace);
      state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(2);
      expect(state?.step).toBe('1');

      // Third fail - exhausted retries, triggers explicit STOP fallback
      result = await runCliInProcess('fail --text', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('fail on runbook with no explicit fail transition uses default', async () => {
      // Create runbook with only PASS transition (no explicit FAIL)
      const noFailTransition = `## 1. Step
- PASS COMPLETE

Do something.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'no-fail.md'), noFailTransition);

      await runCliInProcess('run --prompted runbooks/no-fail.md --text', workspace);

      // Fail should use default action (STOP)
      const result = await runCliInProcess('fail --text', workspace);
      expect(result.exitCode).toBe(1);
    });
  });
});
