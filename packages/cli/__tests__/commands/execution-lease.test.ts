import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { RunbookStateManager } from '@rundown-org/core';
import {
  createTestWorkspace,
  runCliInProcess,
  parseConcatenatedJson,
  parseCliJsonObject,
  readRunbookState,
  requireOwnerToken,
  requireRunId,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import {
  ErrorResponseSchema,
  validateSchema,
  validateStatusOutput,
} from '../helpers/schema-validator.js';

/**
 * The execution lease at the CLI surface (#902): refusal envelopes and the
 * `status` rendering of In Progress and Interrupted.
 *
 * The lease is planted through core's own seam on a prompted run resting at
 * a step, as a `rundown run` whose command is still running (this process
 * holds it: live) or was SIGKILLed (an exited process holds it: dead) would
 * leave it. The genuine multi-process cases live in
 * `__tests__/integration/execution-lease.integration.test.ts`.
 */

function errorEnvelope(stdout: string): Record<string, unknown> | undefined {
  return parseConcatenatedJson(stdout).find(
    (document): document is Record<string, unknown> =>
      typeof document === 'object' &&
      document !== null &&
      (document as Record<string, unknown>).kind === 'error',
  );
}

/** A pid that certainly names no process: a child that already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

describe('execution lease at the CLI', () => {
  let workspace: TestWorkspace;
  let token: string;
  let runId: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    const result = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    token = requireOwnerToken(result.stdout);
    runId = requireRunId(result.stdout);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function leaseStep(holder: 'live' | 'dead'): Promise<void> {
    const manager = new RunbookStateManager(workspace.cwd);
    const read = await manager.loadWithVersion(runId);
    if (!read) throw new Error('run missing');
    const acquired = await manager.acquireExecutionLease(read.state.id, read.stateVersion, {
      // A null start id leaves liveness to the pid alone.
      pid: holder === 'live' ? process.pid : deadPid(),
      startId: null,
    });
    if (acquired.kind !== 'acquired') throw new Error(`lease not set: ${acquired.kind}`);
  }

  describe('In Progress', () => {
    it('refuses pass with a schema-valid EXECUTION_IN_PROGRESS envelope and writes nothing', async () => {
      await leaseStep('live');

      const result = await runCliInProcess(['pass', '--token', token, '--step', '1'], workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope).toMatchObject({
        code: 'EXECUTION_IN_PROGRESS',
        details: { runId, step: '1', pid: process.pid },
      });
      expect(validateSchema(ErrorResponseSchema, envelope)).toEqual({ valid: true, errors: [] });
      expect((await readRunbookState(workspace, runId))?.step).toBe('1');
    });

    it.each([
      ['fail', ['fail', '--step', '1']],
      ['goto', ['goto', '2']],
      ['stop', ['stop']],
      ['complete', ['complete']],
    ])('refuses %s', async (_name, args) => {
      await leaseStep('live');

      const result = await runCliInProcess([...args, '--token', token], workspace);

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)?.code).toBe('EXECUTION_IN_PROGRESS');
    });

    it('shows the step In Progress on status, for the run and in the list', async () => {
      await leaseStep('live');

      const detail = parseCliJsonObject(
        (await runCliInProcess(['status', '--run', runId], workspace)).stdout,
      );
      const list = parseCliJsonObject((await runCliInProcess(['status'], workspace)).stdout);

      const execution = {
        condition: 'in_progress',
        step: '1',
        attempt: expect.any(Number),
        pid: process.pid,
        startedAt: expect.any(String),
      };
      expect(detail.execution).toEqual(execution);
      expect(validateStatusOutput(detail)).toEqual({ valid: true, errors: [] });
      expect(list.runs).toEqual([expect.objectContaining({ id: runId, execution })]);
      expect(validateStatusOutput(list)).toEqual({ valid: true, errors: [] });
    });
  });

  describe('Interrupted', () => {
    it('refuses pass with EXECUTION_INTERRUPTED naming the decisions that clear it', async () => {
      await leaseStep('dead');

      const result = await runCliInProcess(['pass', '--token', token, '--step', '1'], workspace);

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope?.code).toBe('EXECUTION_INTERRUPTED');
      expect(String(envelope?.error)).toContain('rundown fail --step 1');
      expect(validateSchema(ErrorResponseSchema, envelope)).toEqual({ valid: true, errors: [] });
    });

    it('shows the step Interrupted on status, in text too', async () => {
      await leaseStep('dead');

      const detail = parseCliJsonObject(
        (await runCliInProcess(['status', '--run', runId], workspace)).stdout,
      );
      const text = await runCliInProcess(['status', '--run', runId, '--text'], workspace);

      expect(detail.execution).toMatchObject({ condition: 'interrupted', step: '1' });
      expect(text.stdout).toContain('Interrupted');
    });

    it('lets fail decide the step, after which status shows no execution', async () => {
      await leaseStep('dead');

      const result = await runCliInProcess(['fail', '--token', token, '--step', '1'], workspace);

      expect(errorEnvelope(result.stdout)).toBeUndefined();
      const detail = parseCliJsonObject(
        (await runCliInProcess(['status', '--run', runId], workspace)).stdout,
      );
      expect(detail.execution).toBeUndefined();
    });
  });
});
