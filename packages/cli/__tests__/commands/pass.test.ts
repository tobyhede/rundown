import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  readSession,
  getAllStates,
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
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('advances to next step', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('2');
    });
  });

  describe('PASS: COMPLETE', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      await runCliInProcess('pass --text', workspace); // Advance to step 2 which has PASS: COMPLETE
    });

    it('marks runbook complete', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.stdout).toContain('COMPLETE');
    });

    it('clears active runbook', async () => {
      await runCliInProcess('pass --text', workspace);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });

    it('should set lifecycle to completed when runbook completes', async () => {
      await runCliInProcess('pass --text', workspace);

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/simple.runbook.md');
      expect(state?.lifecycle).toBe('completed');
    });
  });

  describe('PASS: GOTO N', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);
    });

    it('jumps to specified step', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3'); // GOTO 3
    });

    it('skips intermediate steps', async () => {
      await runCliInProcess('pass --text', workspace);

      const state = await getActiveState(workspace);
      expect(state?.stepName).toContain('Jump target');
    });
  });

  describe('PASS: RETRY N', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/pass-retry.runbook.md --text', workspace);
    });

    it('increments retryCount if under max', async () => {
      await runCliInProcess('pass --text', workspace);

      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1'); // Same step
    });

    it('outputs retry info', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.stdout).toContain('Retry');
    });

    it('advances after max retries', async () => {
      await runCliInProcess('pass --text', workspace); // Retry 1 (count 0→1)
      await runCliInProcess('pass --text', workspace); // Retry 2 (count 1→2)
      await runCliInProcess('pass --text', workspace); // Retry 3 (count 2→3)
      await runCliInProcess('pass --text', workspace); // Count 3 >= 3, CONTINUE to step 2

      const state = await getActiveState(workspace);
      expect(state?.step).toBe('2'); // Advanced to step 2
    });
  });

  describe('PASS: STOP', () => {
    beforeEach(async () => {
      // stop-on-pass.md created inline in the lastResult test
      const stopOnPassRunbook = `## 1. Stop on pass
- PASS STOP
- FAIL CONTINUE

This step stops on pass.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'stop-on-pass.md'), stopOnPassRunbook);
      await runCliInProcess('run --prompted runbooks/stop-on-pass.md --text', workspace);
    });

    it('blocks runbook', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.exitCode).toBe(1);
    });

    it('outputs stop message', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.stdout).toContain('STOP');
    });

    it('should set lifecycle to stopped when STOP action triggered', async () => {
      await runCliInProcess('pass --text', workspace);

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/stop-on-pass.md');
      expect(state?.lifecycle).toBe('stopped');
    });
  });

  describe('nested runbook completion restores parent', () => {
    it('should restore parent runbook as active when nested child completes', async () => {
      // Create parent/child runbooks for nesting test
      const parentRunbook = `## 1. Parent step
- PASS COMPLETE

Do parent work.
`;
      const childRunbook = `## 1. Child step
- PASS COMPLETE

Do child work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-nest.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-nest.md'), childRunbook);

      // Start parent runbook (prompted mode to keep it active)
      await runCliInProcess('run --prompted runbooks/parent-nest.md --text', workspace);
      const session1 = await readSession(workspace);
      const parentId = session1.active;

      // Start child runbook in same stack (nested)
      await runCliInProcess('run --prompted runbooks/child-nest.md --text', workspace);
      const session2 = await readSession(workspace);
      expect(session2.active).not.toBe(parentId); // Child is now active
      expect(session2.defaultStack).toContain(parentId); // Parent still in stack

      // Complete child runbook
      await runCliInProcess('pass --text', workspace); // Child step 1: DONE -> complete

      // Parent should now be active (child popped from stack)
      const session3 = await readSession(workspace);
      expect(session3.active).toBe(parentId);
    });
  });

  describe('sibling fan-out isolation', () => {
    interface FrontierEntry {
      id: string;
      runbook: string;
      token: string;
    }

    function parseConcatenatedJson(raw: string): unknown[] {
      const results: unknown[] = [];
      let i = 0;
      while (i < raw.length) {
        while (i < raw.length && /\s/.test(raw[i])) i++;
        if (i >= raw.length) break;
        const start = i;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (; i < raw.length; i++) {
          const ch = raw[i];
          if (inString) {
            if (escaped) {
              escaped = false;
            } else if (ch === '\\') {
              escaped = true;
            } else if (ch === '"') {
              inString = false;
            }
          } else if (ch === '"') {
            inString = true;
          } else if (ch === '{' || ch === '[') {
            depth++;
          } else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
        }
        const chunk = raw.slice(start, i);
        try {
          results.push(JSON.parse(chunk));
        } catch {
          // skip malformed chunk
        }
      }
      return results;
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

    it('does not let the later claimed sibling steal the first child pass', async () => {
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
        '- child.runbook.md',
        '',
        '### 1.2 Second child',
        '',
        '- child.runbook.md',
        '',
        '## 2. Done',
        '',
        '- PASS COMPLETE',
        '',
        'Finished.',
        '',
      ].join('\n');

      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentRunbook);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

      const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const frontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
      expect(frontier).toHaveLength(2);
      const token1 = frontier.find((entry) => entry.id === '1.1')?.token;
      const token2 = frontier.find((entry) => entry.id === '1.2')?.token;
      expect(token1).toBeDefined();
      expect(token2).toBeDefined();

      const agent1 = { env: { RD_AGENT_ID: 'agent-one', RD_SESSION_ID: 'session-main' } };
      const agent2 = { env: { RD_AGENT_ID: 'agent-two', RD_SESSION_ID: 'session-main' } };

      let result = await runCliInProcess(`claim ${token1!}`, workspace, agent1);
      expect(result.exitCode).toBe(0);
      const child1Output = findActionOutput(result.stdout);
      expect(child1Output).toBeDefined();
      if (!child1Output || typeof child1Output.run_id !== 'string') {
        throw new Error('Expected claim output to include run_id string');
      }
      const child1Id = child1Output.run_id;

      result = await runCliInProcess(`claim ${token2!}`, workspace, agent2);
      expect(result.exitCode).toBe(0);
      const child2Output = findActionOutput(result.stdout);
      expect(child2Output).toBeDefined();
      if (!child2Output || typeof child2Output.run_id !== 'string') {
        throw new Error('Expected claim output to include run_id string');
      }
      const child2Id = child2Output.run_id;

      const anonymousActive = await getActiveState(workspace);
      expect(anonymousActive?.runbook).toBe('runbooks/parent.runbook.md');

      let status = await runCliInProcess('status', workspace, agent1);
      expect(JSON.parse(status.stdout).state).toContain(child1Id);

      status = await runCliInProcess('status', workspace, agent2);
      expect(JSON.parse(status.stdout).state).toContain(child2Id);

      result = await runCliInProcess('pass --text', workspace, agent1);
      expect(result.exitCode).toBe(0);

      const child1 = await readRunbookState(workspace, child1Id);
      const child2 = await readRunbookState(workspace, child2Id);

      expect(child1?.lifecycle).toBe('completed');
      expect(child2?.lifecycle).toBe('running');
    }, 30_000);

    it('anonymous pass does not mutate an agent-owned child runbook', async () => {
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
        '- child.runbook.md',
        '',
        '## 2. Done',
        '',
        '- PASS COMPLETE',
        '',
        'Finished.',
        '',
      ].join('\n');

      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentRunbook);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

      const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const frontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
      const token = frontier.find((entry) => entry.id === '1.1')?.token;
      expect(token).toBeDefined();

      const agent = { env: { RD_AGENT_ID: 'lone-agent', RD_SESSION_ID: 'lone-session' } };
      const claim = await runCliInProcess(`claim ${token!}`, workspace, agent);
      expect(claim.exitCode).toBe(0);
      const childId = String(findActionOutput(claim.stdout)?.run_id);

      // Anonymous pass — the resolver must not route to the agent-owned child.
      // Whether it succeeds or errors on the parent is not the regression we're guarding;
      // the invariant is that the agent's child remains untouched.
      await runCliInProcess('pass --text', workspace);

      const child = await readRunbookState(workspace, childId);
      expect(child?.lifecycle).toBe('running');
    }, 30_000);
  });

  describe('runbook completion with stack', () => {
    it('pops to parent runbook on completion', async () => {
      // Create parent/child runbooks
      const parentRunbook = `## 1. Step one
- PASS COMPLETE

Do something.
`;
      const childRunbook = `## 1. Step one
- PASS COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child.md'), childRunbook);

      // Start parent (prompted to prevent auto-completion)
      await runCliInProcess('run --prompted runbooks/parent.md --text', workspace);

      // Start child in same stack (prompted to prevent auto-completion)
      await runCliInProcess('run --prompted runbooks/child.md --text', workspace);

      // Complete child
      let result = await runCliInProcess('pass --text', workspace);
      expect(result.stdout).toContain('COMPLETE');

      // Should now be on parent
      result = await runCliInProcess('status --text', workspace);
      expect(result.stdout).toContain('parent.md');
    });
  });

  describe('lastResult semantics', () => {
    it('sets lastResult to pass even when STOP is triggered', async () => {
      // Create a runbook where PASS triggers STOP (edge case)
      const stopOnPassRunbook = `## 1. Stop on pass
- PASS STOP
- FAIL CONTINUE

This step stops on pass.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'stop-on-pass.md'), stopOnPassRunbook);

      await runCliInProcess('run --prompted runbooks/stop-on-pass.md --text', workspace);
      await runCliInProcess('pass --text', workspace);

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/stop-on-pass.md');

      // lastResult should reflect user's choice (pass), not transition outcome
      expect(state?.lastResult).toBe('pass');
    });
  });

  describe('JSON action result semantics', () => {
    it('reports action CONTINUE for CONTINUE transitions', async () => {
      // Start runbook in prompted mode
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      // Pass should trigger CONTINUE to next step
      const result = await runCliInProcess('pass', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('CONTINUE');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports result FAIL in JSONL for RETRY transitions', async () => {
      // Create retry runbook where pass triggers retry (via command failure)
      const retryRunbook = `## 1. Retry on pass fail

- PASS CONTINUE
- FAIL RETRY 3 STOP

This step has FAIL: RETRY.

\`\`\`bash
rd echo --result fail
\`\`\`

## 2. Done

- PASS COMPLETE
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'retry-test.md'), retryRunbook);

      // Start runbook (not prompted - will execute command which fails, triggering RETRY)
      const result = await runCliInProcess('run runbooks/retry-test.md', workspace);
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

    it('reports action complete for COMPLETE transitions', async () => {
      // Start runbook in prompted mode
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      await runCliInProcess('pass --text', workspace); // Advance to step 2

      // Pass on step 2 should trigger COMPLETE
      // The action is 'complete' (lowercase) for completion events
      const result = await runCliInProcess('pass', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('complete');
    });

    it('reports action GOTO for GOTO transitions', async () => {
      // Start goto runbook in prompted mode
      await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);

      // Pass should trigger GOTO 3
      const result = await runCliInProcess('pass', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^GOTO/);
    });

    it('reports stepResult FAIL for RETRY transitions', async () => {
      // Start pass-retry runbook in prompted mode
      await runCliInProcess('run --prompted runbooks/pass-retry.runbook.md --text', workspace);

      // Pass should trigger RETRY (since PASS: RETRY 3)
      // stepResult is FAIL (RETRY = not yet passing)
      const result = await runCliInProcess('pass', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^RETRY/);
      expect(output?.stepResult).toBe('FAIL');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports action stop for STOP transitions', async () => {
      // Create stop-on-pass runbook
      const stopOnPassRunbook = `## 1. Stop on pass
- PASS STOP
- FAIL CONTINUE

This step stops on pass.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'stop-on-pass-json.md'), stopOnPassRunbook);

      // Start runbook in prompted mode
      await runCliInProcess('run --prompted runbooks/stop-on-pass-json.md --text', workspace);

      // Pass should trigger STOP
      const result = await runCliInProcess('pass', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('stop'); // lowercase per CLI conventions

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('option validation', () => {
    it('rejects --index without --step', async () => {
      const result = await runCliInProcess('pass --index 1 --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--index requires --step');
    });
  });
});
