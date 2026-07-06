import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  getAllStates,
  findActionOutput,
  injectDelegationOutcomeForActiveRun,
  readRunbookState,
  parseConcatenatedJson,
  type TestWorkspace,
  withRunTarget,
} from '../helpers/test-utils.js';
import { ActionResponseSchema, WarningResponseSchema } from '../helpers/schema-validator.js';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/fail.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerFailCommand } from '../../src/commands/fail.js';

describe('fail command wiring', () => {
  it('registers the fail command with its aliases, flags, and descriptions', () => {
    const program = new Command();
    registerFailCommand(program);

    const fail = program.commands.find((c) => c.name() === 'fail');
    expect(fail).toBeDefined();
    expect(fail?.description()).toBe('Mark current step as failed (triggers FAIL transition)');
    expect(fail?.aliases()).toEqual(['no']);

    const byLong = new Map(fail!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(
      expect.arrayContaining(['--step', '--index', '--claim-id', '--text']),
    );
    expect(byLong.get('--step')?.description).toBe('Target specific substep');
    expect(byLong.get('--index')?.description).toBe(
      'FOR loop iteration to target (requires --step)',
    );
    expect(byLong.get('--claim-id')?.description).toBe(
      'Legacy claim id; mutations require --claim-capability',
    );
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('fail command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('collection-pending guard', () => {
    it('refuses bare fail while a delegated outcome is waiting for collection', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

      // Post-R1 the guard needs named authority: a run-targeted bare-shaped
      // advance still refuses with the collection-pending guard.
      const result = await runCliInProcess(await withRunTarget(['fail'], workspace), workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        code?: string;
        details?: { outcomeCompletionKeys?: string[] };
      };
      expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
      expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
    });

    it('exempts a targeted fail --step from the collection-pending guard', async () => {
      // A `--step` target is a deliberate transition, not a bare parent advance,
      // so the same pending outcome that blocks bare `fail` must not block it
      // (mirrors the core policy exemption for `targeted` intents).
      await runCliInProcess('run --prompted runbooks/substeps.runbook.md --text', workspace);
      await injectDelegationOutcomeForActiveRun(workspace);

      // Post-R1 the sanctioned targeted recovery is run+step.
      const result = await runCliInProcess(
        await withRunTarget(['fail', '--step', '1.2'], workspace),
        workspace,
      );

      // The targeted transition runs to completion: exit 0, a real transition is
      // emitted, and the bare-only collection-pending guard never fires.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('step_transitioned');
      expect(result.stdout).not.toContain('DELEGATION_COLLECTION_PENDING');
    });
  });

  describe('--run-capability explicit targeting', () => {
    it('applies fail --run-capability <capability> to the named running run', async () => {
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);

      const result = await runCliInProcess(await withRunTarget(['fail'], workspace), workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1');
    });

    it('refuses a well-formed but unknown --run id with RUN_TARGET_UNAVAILABLE', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const bogus = `rd_${'e'.repeat(32)}`;

      const result = await runCliInProcess(`fail --run ${bogus}`, workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('RUN_TARGET_UNAVAILABLE');
      // The refusal did not mutate the active run.
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('1');
      expect(state?.lifecycle).toBe('running');
    });
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
      const state = states.find((s) => s.runbook.path === 'runbooks/simple.runbook.md');
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
      const claimCapability1 = child1Output.claim_capability;
      if (typeof claimCapability1 !== 'string') {
        throw new Error('Expected claim output to include claim_capability string');
      }

      result = await runCliInProcess(`claim ${token2!}`, workspace);
      expect(result.exitCode).toBe(0);
      const child2Output = findActionOutput(result.stdout);
      expect(child2Output).toBeDefined();
      if (!child2Output || typeof child2Output.run_id !== 'string') {
        throw new Error('Expected claim output to include run_id string');
      }
      const child2Id = child2Output.run_id;

      result = await runCliInProcess(
        ['fail', '--claim-capability', claimCapability1, '--text'],
        workspace,
      );
      // Plan 5 (exit-code narrowing): the child's FAIL action is STOP, so the
      // child locally STOPs and this command exits 1 on its OWN lifecycle.
      // Reporting upward (report-only) no longer absorbs the stop into exit 0.
      expect(result.exitCode).toBe(1);

      const child1 = await readRunbookState(workspace, child1Id);
      const child2 = await readRunbookState(workspace, child2Id);

      expect(child1?.lifecycle).toBe('stopped');
      expect(child2?.lifecycle).toBe('running');
    });

    it('plain fail does not mutate a claimed child runbook', async () => {
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

      const claim = await runCliInProcess(`claim ${token!}`, workspace);
      const childId = String(findActionOutput(claim.stdout)?.run_id);

      // Plain fail is refused outright post-R1 (no ambient trust on a
      // delegating parent); the run-targeted bare-shaped fail is then held by
      // the open-delegated-children guard. Neither may stop the parent or touch
      // the claimed child (callers resolve the child via `--claim-id`).
      const bareFail = await runCliInProcess('fail', workspace);
      expect(bareFail.exitCode).toBe(1);
      expect((JSON.parse(bareFail.stdout) as { code?: string }).code).toBe(
        'ACTOR_CONTEXT_REQUIRED',
      );
      const failResult = await runCliInProcess(await withRunTarget(['fail'], workspace), workspace);
      expect(failResult.exitCode).toBe(1);
      const failPayload = JSON.parse(failResult.stdout) as { code?: string };
      expect(failPayload.code).toBe('OPEN_DELEGATED_CHILDREN');

      const parent = await readRunbookState(workspace, parentId!);
      const child = await readRunbookState(workspace, childId);
      expect(parent?.lifecycle).toBe('running');
      expect(child?.lifecycle).toBe('running');
    }, 30_000);
  });

  describe('JSON output', () => {
    it('includes warning kind when no active runbook', async () => {
      // Run fail with no active runbook
      const result = await runCliInProcess('fail', workspace);

      // Should exit cleanly (no active runbook is not an error)
      expect(result.exitCode).toBe(0);

      // Parse JSON output
      const output = JSON.parse(result.stdout);

      // No-active-runbook path emits a warning response (not an error)
      expect(output).toHaveProperty('kind', 'warning');
      expect(output).toHaveProperty('message', 'No active runbook');
      expect(output).toHaveProperty('command', 'fail');
      expect(output.code).toBe('NO_ACTIVE_RUNBOOK');

      // Validate against WarningResponseSchema (not ErrorResponseSchema)
      const parseResult = WarningResponseSchema.safeParse(output);
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
      const state = states.find((s) => s.runbook.path === 'runbooks/substep-fail-any.md');
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

  describe('idempotent --claim-id on terminal child', () => {
    /**
     * Drive a delegated child to a stopped terminal state via `rd fail`, leaving
     * its claim record as a terminal tombstone.
     *
     * @returns The claim id of the stopped child.
     */
    async function stopDelegatedChild(): Promise<string> {
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
      const claimCapability = claimOutput?.claim_capability;
      if (typeof claimId !== 'string') throw new Error('expected claim_id from claim output');
      if (typeof claimCapability !== 'string') {
        throw new Error('expected claim_capability from claim output');
      }

      // Drive the child's single FAIL STOP step to a stopped terminal state.
      await runCliInProcess(['fail', '--claim-capability', claimCapability], workspace);
      const runId = claimOutput?.run_id;
      if (typeof runId !== 'string') throw new Error('expected run_id from claim output');
      const child = await readRunbookState(workspace, runId);
      expect(child?.lifecycle).toBe('stopped');

      return claimCapability;
    }

    it('rd fail --claim-capability is an idempotent no-op after the child stopped', async () => {
      const claimCapability = await stopDelegatedChild();

      const result = await runCliInProcess(
        ['fail', '--claim-capability', claimCapability],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'action', action: 'fail', status: 'already-resolved' });
      // The idempotent already-resolved payload must satisfy ActionResponseSchema,
      // whose `kind` discriminant is the literal 'action' (not the command name).
      expect(ActionResponseSchema.safeParse(json).success).toBe(true);
    }, 30_000);

    it('rd pass --claim-capability on a stopped child conflicts (DELEGATION_RESULT_CONFLICT)', async () => {
      const claimCapability = await stopDelegatedChild();

      const result = await runCliInProcess(
        ['pass', '--claim-capability', claimCapability],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const json = parseConcatenatedJson(result.stdout).at(-1) as Record<string, unknown>;
      expect(json).toMatchObject({ kind: 'error', code: 'DELEGATION_RESULT_CONFLICT' });
    }, 30_000);
  });
});
