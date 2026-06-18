import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  readSession,
  getAllStates,
  parseConcatenatedJson,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { ActionResponseSchema } from '../helpers/schema-validator.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '@rundown-org/core';

async function injectDelegationOutcomeForActiveRun(workspace: TestWorkspace): Promise<string> {
  const state = await getActiveState(workspace);
  if (!state) throw new Error('Expected active state');
  const frameKey = state.activeFrameKey ?? buildFrameKey(state.step);
  const completionKey = buildCompletionKey(activeFrame(frameKey, state.activeEntry ?? 1), '1');
  await writeFile(
    join(workspace.statePath(), `${state.id}.json`),
    JSON.stringify(
      {
        ...state,
        substep: state.substep ?? '1',
        activeFrameKey: frameKey,
        activeEntry: state.activeEntry ?? 1,
        frameEntries: { ...(state.frameEntries ?? {}), [frameKey]: state.activeEntry ?? 1 },
        resolvedCompletions: {
          ...(state.resolvedCompletions ?? {}),
          [completionKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: state.step,
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, state.activeEntry ?? 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      },
      null,
      2,
    ),
  );
  return completionKey;
}

describe('pass command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('collection-pending guard', () => {
    it('refuses bare pass while a delegated outcome is waiting for collection', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

      const result = await runCliInProcess('pass', workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        code?: string;
        details?: { outcomeCompletionKeys?: string[] };
      };
      expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
      expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
    });
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

    it('fails closed on invalid non-v1 schemaVersion state instead of migrating it', async () => {
      const state = await getActiveState(workspace);
      expect(state).toBeDefined();
      await writeFile(
        join(workspace.statePath(), `${state!.id}.json`),
        JSON.stringify({ ...state, schemaVersion: 2 }),
      );

      const result = await runCliInProcess('pass --text', workspace);

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/invalid|schema|prune/i);
      const reloaded = JSON.parse(
        await readFile(join(workspace.statePath(), `${state!.id}.json`), 'utf-8'),
      ) as { schemaVersion?: unknown };
      expect(reloaded.schemaVersion).toBe(2);
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
      const state = states.find((s) => s.runbook.path === 'runbooks/simple.runbook.md');
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
      const state = states.find((s) => s.runbook.path === 'runbooks/stop-on-pass.md');
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

      let result = await runCliInProcess(`claim ${token1!}`, workspace);
      expect(result.exitCode).toBe(0);
      const child1Output = findActionOutput(result.stdout);
      expect(child1Output).toBeDefined();
      if (
        !child1Output ||
        typeof child1Output.run_id !== 'string' ||
        typeof child1Output.claim_id !== 'string'
      ) {
        throw new Error('Expected claim output to include run_id and claim_id strings');
      }
      const child1Id = child1Output.run_id;
      const claimId1 = child1Output.claim_id;

      result = await runCliInProcess(`claim ${token2!}`, workspace);
      expect(result.exitCode).toBe(0);
      const child2Output = findActionOutput(result.stdout);
      expect(child2Output).toBeDefined();
      if (
        !child2Output ||
        typeof child2Output.run_id !== 'string' ||
        typeof child2Output.claim_id !== 'string'
      ) {
        throw new Error('Expected claim output to include run_id and claim_id strings');
      }
      const child2Id = child2Output.run_id;
      const claimId2 = child2Output.claim_id;

      const anonymousActive = await getActiveState(workspace);
      expect(anonymousActive?.runbook).toEqual({
        source: 'project',
        path: 'runbooks/parent.runbook.md',
      });

      let status = await runCliInProcess(['status', '--claim-id', claimId1], workspace);
      expect(JSON.parse(status.stdout).state).toContain(child1Id);

      status = await runCliInProcess(['status', '--claim-id', claimId2], workspace);
      expect(JSON.parse(status.stdout).state).toContain(child2Id);

      result = await runCliInProcess(['pass', '--claim-id', claimId1, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      const child1 = await readRunbookState(workspace, child1Id);
      const child2 = await readRunbookState(workspace, child2Id);

      expect(child1?.lifecycle).toBe('completed');
      expect(child2?.lifecycle).toBe('running');
    }, 30_000);

    it('plain pass does not mutate a claimed child runbook', async () => {
      // Regression: plain callers must target only the default-stack runbook
      // (the parent), never a claimed delegated child.
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
      const parentId = (await getActiveState(workspace))?.id;
      expect(parentId).toBeDefined();
      const frontier = findFrontierInEvents(parseConcatenatedJson(start.stdout)) ?? [];
      const token = frontier.find((entry) => entry.id === '1.1')?.token;
      expect(token).toBeDefined();

      const claim = await runCliInProcess(`claim ${token!}`, workspace);
      expect(claim.exitCode).toBe(0);
      const childId = String(findActionOutput(claim.stdout)?.run_id);

      // Anonymous pass is refused while a claimed delegated child is open: it
      // must not advance the default-stack parent past the DELEGATE step, and it
      // must not touch the agent-owned child (callers resolve the child via
      // `--claim-id`). This is the open-delegated-children guard.
      const passResult = await runCliInProcess('pass', workspace);
      expect(passResult.exitCode).toBe(1);
      const passPayload = JSON.parse(passResult.stdout) as { code?: string };
      expect(passPayload.code).toBe('OPEN_DELEGATED_CHILDREN');

      const parent = await readRunbookState(workspace, parentId!);
      const child = await readRunbookState(workspace, childId);
      expect(parent?.step).toBe('1');
      expect(parent?.lifecycle).toBe('running');
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
      const state = states.find((s) => s.runbook.path === 'runbooks/stop-on-pass.md');

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

  describe('idempotent --claim-id on terminal child', () => {
    /**
     * Drive a delegated child to its natural completion (lifecycle 'completed'),
     * leaving its claim record as a terminal tombstone.
     *
     * @returns The claim id of the completed child.
     */
    async function completeDelegatedChild(): Promise<string> {
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
      const state = await getActiveState(workspace);
      const token = state?.substepStates?.find((substep) => substep.id === '1')?.delegation?.token;
      if (!token) throw new Error('expected auto-issued frontier token for 1.1');

      const claimResult = await runCliInProcess(`claim ${token}`, workspace);
      expect(claimResult.exitCode).toBe(0);
      const claimOutput = findActionOutput(claimResult.stdout);
      const claimId = claimOutput?.claim_id;
      if (typeof claimId !== 'string') throw new Error('expected claim_id from claim output');

      // Drive the child's single PASS COMPLETE step to terminal completion.
      const finish = await runCliInProcess(['pass', '--claim-id', claimId], workspace);
      expect(finish.exitCode).toBe(0);
      const runId = claimOutput?.run_id;
      if (typeof runId !== 'string') throw new Error('expected run_id from claim output');
      const child = await readRunbookState(workspace, runId);
      expect(child?.lifecycle).toBe('completed');

      return claimId;
    }

    it('rd pass --claim-id is an idempotent no-op after the child completed', async () => {
      const claimId = await completeDelegatedChild();

      const result = await runCliInProcess(['pass', '--claim-id', claimId], workspace);

      expect(result.exitCode).toBe(0);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'action', action: 'pass', status: 'already-resolved' });
      // The idempotent already-resolved payload must satisfy ActionResponseSchema,
      // whose `kind` discriminant is the literal 'action' (not the command name).
      expect(ActionResponseSchema.safeParse(json).success).toBe(true);
    }, 30_000);

    it('rd fail --claim-id on a passed child conflicts (DELEGATION_RESULT_CONFLICT)', async () => {
      const claimId = await completeDelegatedChild();

      const result = await runCliInProcess(['fail', '--claim-id', claimId], workspace);

      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'DELEGATION_RESULT_CONFLICT' });
    }, 30_000);

    it('rd pass --claim-id on an unknown claim still errors CLAIMED_RUNBOOK_UNAVAILABLE', async () => {
      const result = await runCliInProcess(
        ['pass', '--claim-id', 'rdclm_AAAAAAAAAAAAAAAAAAAAAA'],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'CLAIMED_RUNBOOK_UNAVAILABLE' });
    });
  });
});
