import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  runCliInProcess,
  readRunbookState,
  getAllStates,
  parseConcatenatedJson,
  requireOwnerToken,
  requireRunId,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import {
  ActionResponseSchema,
  ErrorResponseSchema,
  validateSchema,
} from '../helpers/schema-validator.js';
import {
  FOREIGN_SCHEMA_VERSION,
  patchPersistedRunState,
  readPersistedRunState,
} from '@rundown-org/core/testing/run-fixtures';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/pass.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess).
import { registerPassCommand } from '../../src/commands/pass.js';

describe('pass command wiring', () => {
  it('registers the pass command with its aliases, flags, and descriptions', () => {
    const program = new Command();
    registerPassCommand(program);

    const pass = program.commands.find((c) => c.name() === 'pass');
    expect(pass).toBeDefined();
    expect(pass?.description()).toBe('Mark current step as passed (triggers PASS transition)');
    expect(pass?.aliases()).toEqual(['yes', 'ok']);

    const byLong = new Map(pass!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(
      expect.arrayContaining(['--token', '--step', '--index', '--text']),
    );
    expect(byLong.get('--token')?.description).toBe(
      'Owner token of the run to mutate (owner_token from runbook_started)',
    );
    expect(byLong.get('--step')?.description).toBe(
      'Current step or substep position (required, e.g. 2 or 2.1)',
    );
    expect(byLong.get('--index')?.description).toBe('Current FOR loop iteration (requires --step)');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
    // `--run` is accepted only so the combination can be refused INVALID_SYNTAX.
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

describe('pass command', () => {
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

  /** `rundown pass --token <token> --step <step>` plus any extra args. */
  function pass(step: string, ...extra: string[]) {
    return runCliInProcess(['pass', '--token', token, '--step', step, ...extra], workspace);
  }

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('--token authority', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('refuses a bare pass with TOKEN_REQUIRED and writes nothing', async () => {
      const result = await runCliInProcess('pass --step 1', workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('TOKEN_REQUIRED');
      expect(validateSchema(ErrorResponseSchema, envelope)).toEqual({ valid: true, errors: [] });
      expect((await readRunbookState(workspace, runId))?.step).toBe('1');
    });

    it('refuses a well-formed but unknown token with a schema-valid UNKNOWN_TOKEN envelope', async () => {
      const bogus = `rdo_${'A'.repeat(43)}`;

      const result = await runCliInProcess(['pass', '--token', bogus, '--step', '1'], workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('UNKNOWN_TOKEN');
      expect(validateSchema(ErrorResponseSchema, envelope)).toEqual({ valid: true, errors: [] });
      expect((await readRunbookState(workspace, runId))?.step).toBe('1');
    });

    it('rejects a malformed token with INVALID_SYNTAX', async () => {
      const result = await runCliInProcess(
        ['pass', '--token', 'not-a-token', '--step', '1'],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_SYNTAX');
    });

    it('rejects combining --token with --run instead of treating the run id as authority', async () => {
      const result = await runCliInProcess(
        ['pass', '--token', token, '--run', runId, '--step', '1'],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_SYNTAX');
      expect((await readRunbookState(workspace, runId))?.step).toBe('1');
    });

    it('refuses the token of a completed run with RD-303', async () => {
      expect((await pass('1')).exitCode).toBe(0);
      expect((await pass('2')).exitCode).toBe(0);

      const late = await pass('2');

      expect(late.exitCode).toBe(1);
      const envelope = errorEnvelope(late.stdout);
      expect(envelope?.code).toBe('RD-303');
      expect(envelope?.details).toMatchObject({ runId, lifecycle: 'completed' });
    });
  });

  describe('--step contract', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('requires --step, naming the current position', async () => {
      const result = await runCliInProcess(['pass', '--token', token], workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('INVALID_STEP');
      expect(String(envelope?.error)).toContain('the current position is 1');
      expect((await readRunbookState(workspace, runId))?.step).toBe('1');
    });

    it('refuses --step naming a later step with INVALID_STEP', async () => {
      const result = await pass('2');

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('INVALID_STEP');
      expect((await readRunbookState(workspace, runId))?.step).toBe('1');
    });

    it('drives a substep via pass --step <step.substep>', async () => {
      await start('runbooks/substeps.runbook.md');

      // The cursor rests at substep 1.1; a bare `--step 1` is refused.
      const bare = await pass('1');
      expect(bare.exitCode).toBe(1);
      expect(errorEnvelope(bare.stdout)?.code).toBe('INVALID_STEP');
      expect(String(errorEnvelope(bare.stdout)?.error)).toContain('1.1');

      const result = await pass('1.1');

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state?.step).toBe('1');
      expect(state?.substep).toBe('2');
    });
  });

  describe('PASS: CONTINUE', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
    });

    it('advances to next step', async () => {
      const result = await pass('1', '--text');

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state?.step).toBe('2');
    });

    it('fails closed on a foreign schemaVersion instead of migrating it', async () => {
      await patchPersistedRunState(workspace.cwd, runId, {
        schemaVersion: FOREIGN_SCHEMA_VERSION,
      });

      const result = await pass('1', '--text');

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/invalid|schema|prune/i);
      const reloaded = (await readPersistedRunState(workspace.cwd, runId)) as {
        schemaVersion?: unknown;
      } | null;
      expect(reloaded?.schemaVersion).toBe(FOREIGN_SCHEMA_VERSION);
    });
  });

  describe('PASS: COMPLETE', () => {
    beforeEach(async () => {
      await start('runbooks/simple.runbook.md');
      await pass('1', '--text'); // Advance to step 2 which has PASS: COMPLETE
    });

    it('marks runbook complete', async () => {
      const result = await pass('2', '--text');

      expect(result.stdout).toContain('COMPLETE');
    });

    it('should set lifecycle to completed when runbook completes', async () => {
      await pass('2', '--text');

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook.path === 'runbooks/simple.runbook.md');
      expect(state?.lifecycle).toBe('completed');
    });

    it('lists the completed run as complete in status', async () => {
      await pass('2', '--text');

      const status = await runCliInProcess('status', workspace);
      const detail = parseConcatenatedJson(status.stdout).at(-1) as Record<string, unknown>;
      expect(detail.runs).toEqual([expect.objectContaining({ id: runId, status: 'complete' })]);
    });
  });

  describe('PASS: GOTO N', () => {
    beforeEach(async () => {
      await start('runbooks/goto.runbook.md');
    });

    it('jumps to specified step', async () => {
      const result = await pass('1', '--text');

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state?.step).toBe('3'); // GOTO 3
    });

    it('skips intermediate steps', async () => {
      await pass('1', '--text');

      const state = await readRunbookState(workspace, runId);
      expect(state?.stepName).toContain('Jump target');
    });
  });

  describe('PASS: RETRY N', () => {
    beforeEach(async () => {
      await start('runbooks/pass-retry.runbook.md');
    });

    it('increments retryCount if under max', async () => {
      await pass('1', '--text');

      const state = await readRunbookState(workspace, runId);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1'); // Same step
    });

    it('outputs retry info', async () => {
      const result = await pass('1', '--text');

      expect(result.stdout).toContain('Retry');
    });

    it('advances after max retries', async () => {
      await pass('1', '--text'); // Retry 1 (count 0→1)
      await pass('1', '--text'); // Retry 2 (count 1→2)
      await pass('1', '--text'); // Retry 3 (count 2→3)
      await pass('1', '--text'); // Count 3 >= 3, CONTINUE to step 2

      const state = await readRunbookState(workspace, runId);
      expect(state?.step).toBe('2'); // Advanced to step 2
    });
  });

  describe('PASS: STOP', () => {
    beforeEach(async () => {
      const stopOnPassRunbook = `## 1. Stop on pass
- PASS STOP
- FAIL CONTINUE

This step stops on pass.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'stop-on-pass.md'), stopOnPassRunbook);
      await start('runbooks/stop-on-pass.md');
    });

    it('blocks runbook', async () => {
      const result = await pass('1', '--text');

      expect(result.exitCode).toBe(1);
    });

    it('outputs stop message', async () => {
      const result = await pass('1', '--text');

      expect(result.stdout).toContain('STOP');
    });

    it('should set lifecycle to stopped when STOP action triggered', async () => {
      await pass('1', '--text');

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook.path === 'runbooks/stop-on-pass.md');
      expect(state?.lifecycle).toBe('stopped');
    });

    it('refuses a later pass on the stopped run with RD-304', async () => {
      await pass('1', '--text');

      const late = await pass('1');

      expect(late.exitCode).toBe(1);
      const envelope = errorEnvelope(late.stdout);
      expect(envelope?.code).toBe('RD-304');
      expect(envelope?.details).toMatchObject({ runId, lifecycle: 'stopped' });
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

      await start('runbooks/stop-on-pass.md');
      await pass('1', '--text');

      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook.path === 'runbooks/stop-on-pass.md');

      // lastResult should reflect user's choice (pass), not transition outcome
      expect(state?.lastResult).toBe('pass');
    });
  });

  describe('JSON action result semantics', () => {
    it('reports action CONTINUE for CONTINUE transitions', async () => {
      await start('runbooks/simple.runbook.md');

      // Pass should trigger CONTINUE to next step
      const result = await pass('1');
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
      await start('runbooks/simple.runbook.md');
      await pass('1', '--text'); // Advance to step 2

      // Pass on step 2 should trigger COMPLETE
      // The action is 'complete' (lowercase) for completion events
      const result = await pass('2');
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('complete');
    });

    it('reports action GOTO for GOTO transitions', async () => {
      await start('runbooks/goto.runbook.md');

      // Pass should trigger GOTO 3
      const result = await pass('1');
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^GOTO/);
    });

    it('reports stepResult FAIL for RETRY transitions', async () => {
      await start('runbooks/pass-retry.runbook.md');

      // Pass should trigger RETRY (since PASS: RETRY 3)
      // stepResult is FAIL (RETRY = not yet passing)
      const result = await pass('1');
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

      await start('runbooks/stop-on-pass-json.md');

      // Pass should trigger STOP
      const result = await pass('1');
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('stop'); // lowercase per CLI conventions

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('never echoes the owner token', async () => {
      await start('runbooks/simple.runbook.md');

      const result = await pass('1');

      expect(result.stdout).not.toContain('rdo_');
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
