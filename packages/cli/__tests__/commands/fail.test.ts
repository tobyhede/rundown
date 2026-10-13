import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  getAllStates,
  findActionOutput,
  readRunbookState,
  parseConcatenatedJson,
  requireOwnerToken,
  requireRunId,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { ActionResponseSchema, ErrorResponseSchema } from '../helpers/schema-validator.js';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/fail.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess).
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
      expect.arrayContaining(['--token', '--step', '--index', '--text']),
    );
    expect(byLong.get('--token')?.description).toBe(
      'Owner token of the run to mutate (owner_token from runbook_started)',
    );
    expect(byLong.get('--step')?.description).toBe(
      'Current step or substep position (required, e.g. 2 or 2.1)',
    );
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
    expect(byLong.get('--run')?.hidden).toBe(true);
  });
});

function errorEnvelope(stdout: string): Record<string, unknown> | undefined {
  return parseConcatenatedJson(stdout).find(
    (document): document is Record<string, unknown> =>
      typeof document === 'object' &&
      document !== null &&
      (document as Record<string, unknown>).kind === 'error',
  );
}

describe('fail command', () => {
  let workspace: TestWorkspace;
  let token: string;
  let runId: string;

  /** Start a prompted run in JSON mode and capture its Owner Token and id. */
  async function start(runbook: string): Promise<void> {
    const result = await runCliInProcess(`run --prompted ${runbook}`, workspace);
    expect(result.exitCode).toBe(0);
    token = requireOwnerToken(result.stdout);
    runId = requireRunId(result.stdout);
  }

  /** `rundown fail --token <token> --step <step>` plus any extra args. */
  function fail(step: string, ...extra: string[]) {
    return runCliInProcess(['fail', '--token', token, '--step', step, ...extra], workspace);
  }

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('--token authority', () => {
    beforeEach(async () => {
      await start('runbooks/retry.runbook.md');
    });

    it('refuses a bare fail with TOKEN_REQUIRED and writes nothing', async () => {
      const result = await runCliInProcess('fail --step 1', workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('TOKEN_REQUIRED');
      expect(envelope?.command).toBe('fail');
      expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
      expect((await readRunbookState(workspace, runId))?.retryCount).toBe(0);
    });

    it('refuses a well-formed but unknown token with UNKNOWN_TOKEN', async () => {
      const bogus = `rdo_${'A'.repeat(43)}`;

      const result = await runCliInProcess(['fail', '--token', bogus, '--step', '1'], workspace);

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('UNKNOWN_TOKEN');
      expect((await readRunbookState(workspace, runId))?.retryCount).toBe(0);
    });

    it('the `no` alias takes the same --token and --step', async () => {
      const result = await runCliInProcess(['no', '--token', token, '--step', '1'], workspace);

      expect(result.exitCode).toBe(0);
      expect((await readRunbookState(workspace, runId))?.retryCount).toBe(1);
    });

    it('requires --step, naming the current position', async () => {
      const result = await runCliInProcess(['fail', '--token', token], workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('INVALID_STEP');
      expect(String(envelope?.error)).toContain('the current position is 1');
    });
  });

  describe('FAIL: RETRY N', () => {
    beforeEach(async () => {
      await start('runbooks/retry.runbook.md');
    });

    it('increments retryCount if under max', async () => {
      await fail('1', '--text');

      const state = await readRunbookState(workspace, runId);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1'); // Same step
    });

    it('outputs retry info', async () => {
      const result = await fail('1', '--text');

      expect(result.stdout).toContain('Retry');
    });
  });

  describe('FAIL: STOP', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('blocks runbook', async () => {
      const result = await fail('1', '--text');

      expect(result.exitCode).toBe(1);
    });

    it('outputs error message', async () => {
      const result = await fail('1', '--text');

      expect(result.stdout).toContain('STOP');
    });

    it('should set lifecycle to stopped when STOP action triggered', async () => {
      await fail('1', '--text');

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook.path === 'runbooks/simple.runbook.md');
      expect(state?.lifecycle).toBe('stopped');
    });

    it('refuses a later fail on the stopped run with RD-304', async () => {
      await fail('1', '--text');

      const late = await fail('1');

      expect(late.exitCode).toBe(1);
      const envelope = errorEnvelope(late.stdout);
      expect(envelope?.code).toBe('RD-304');
      expect(envelope?.details).toMatchObject({ runId, lifecycle: 'stopped' });
    });
  });

  describe('FAIL: GOTO N', () => {
    beforeEach(async () => {
      await start('runbooks/fail-goto.runbook.md');
    });

    it('jumps to specified step on failure', async () => {
      const result = await fail('1', '--text');

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state?.step).toBe('3'); // GOTO 3 on FAIL
    });
  });

  describe('JSON action result semantics', () => {
    it('reports stepResult FAIL for RETRY transitions', async () => {
      await start('runbooks/retry.runbook.md');

      // Fail should trigger RETRY (since FAIL: RETRY 3)
      const result = await fail('1');
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output!.action as string).toMatch(/^RETRY/);
      expect(output!.stepResult).toBe('FAIL');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports action stop for STOP transitions', async () => {
      await start('runbooks/simple.runbook.md');

      // Fail should trigger STOP
      const result = await fail('1');
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('stop'); // lowercase per CLI conventions

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports stepResult FAIL for GOTO transitions', async () => {
      await start('runbooks/fail-goto.runbook.md');

      // Fail should trigger GOTO 3
      const result = await fail('1');
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^GOTO/);
      expect(output?.stepResult).toBe('FAIL');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('never echoes the owner token', async () => {
      await start('runbooks/retry.runbook.md');

      const result = await fail('1');

      expect(result.stdout).not.toContain('rdo_');
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('fail after max retries exhausted triggers fallback action', async () => {
      await start('runbooks/retry.runbook.md');

      // Fail repeatedly until retries exhausted (RETRY 3 = 3 retries allowed, 4 total attempts)
      await fail('1', '--text'); // retry 1 (retryCount: 0→1)
      await fail('1', '--text'); // retry 2 (retryCount: 1→2)
      await fail('1', '--text'); // retry 3 (retryCount: 2→3)
      const result = await fail('1', '--text'); // retries exhausted, fallback STOP

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

      await start('runbooks/substep-fail-any.md');

      // Fail substep 1.1 -- result is deferred, machine advances to 1.2
      const first = await fail('1.1', '--text');
      expect(first.exitCode).toBe(0);

      // Pass substep 1.2 -- all substeps now complete, aggregation fires
      // FAIL ANY: STOP triggers because substep 1.1 was failed
      const result = await runCliInProcess(
        ['pass', '--token', token, '--step', '1.2', '--text'],
        workspace,
      );

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

      await start('runbooks/multi-fail.md');

      // First fail - retry
      let result = await fail('1', '--text');
      let state = await readRunbookState(workspace, runId);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1');

      // Second fail - retry again
      result = await fail('1', '--text');
      state = await readRunbookState(workspace, runId);
      expect(state?.retryCount).toBe(2);
      expect(state?.step).toBe('1');

      // Third fail - exhausted retries, triggers explicit STOP fallback
      result = await fail('1', '--text');
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

      await start('runbooks/no-fail.md');

      // Fail should use default action (STOP)
      const result = await fail('1', '--text');
      expect(result.exitCode).toBe(1);
    });
  });
});
