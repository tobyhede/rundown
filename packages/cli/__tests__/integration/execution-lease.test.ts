import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  getCliPath,
  parseCliJsonObject,
  parseConcatenatedJson,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * The execution lease across real processes (#902, ADR 0005).
 *
 * Only a multi-process test observes a genuine race (docs/internal/
 * concurrency.md § Testing a race). Each case starts `rundown run` in its own
 * process on a runbook whose command sleeps, and drives the run from fresh
 * CLI processes while that command is running or after its process was
 * SIGKILLed.
 */

const SLOW = `# Slow

## 1. Slow

- PASS COMPLETE
- FAIL STOP

\`\`\`bash
echo started >> attempts.log
sleep 30
\`\`\`
`;

/** A running `rundown run` and the identity it printed. */
interface StartedRun {
  readonly child: ChildProcess;
  readonly token: string;
  readonly runId: string;
  /** Resolves with the full stdout once the process exits. */
  readonly exited: Promise<string>;
}

/**
 * Start `rundown run` in its own process group and wait for its
 * `runbook_started` event, which it prints before the command starts.
 *
 * @param workspace - Test workspace.
 * @param runbook - Runbook path relative to the workspace.
 * @returns The live process with its Owner Token and run id.
 */
async function startRun(workspace: TestWorkspace, runbook: string): Promise<StartedRun> {
  const child = spawn('node', [getCliPath(), 'run', runbook, '--allow-all'], {
    cwd: workspace.cwd,
    // Its own group, so SIGKILL reaches the shell's `sleep` too.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${workspace.binPath()}:${process.env.PATH ?? ''}`,
      NO_COLOR: '1',
      FORCE_COLOR: undefined,
      RUNDOWN_LOG: '0',
    },
  });
  let stdout = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const exited = new Promise<string>((resolve) => {
    child.on('close', () => {
      resolve(stdout);
    });
  });
  const started = await new Promise<{ token: string; runId: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`rundown run printed no runbook_started:\n${stdout}`));
    }, 15_000);
    const poll = setInterval(() => {
      const event = stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((value) => value.type === 'runbook_started');
      if (event !== undefined) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ token: String(event.owner_token), runId: String(event.runbookId) });
      }
    }, 25);
  });
  return { child, exited, ...started };
}

/**
 * Wait until the run's step holds the execution lease, as `status` reports it.
 *
 * @param workspace - Test workspace.
 * @param runId - The run.
 * @returns The `execution` field status reported.
 */
async function awaitExecution(
  workspace: TestWorkspace,
  runId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = parseCliJsonObject(runCli(['status', '--run', runId], workspace).stdout);
    if (status.execution !== undefined) return status.execution as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} never took the execution lease`);
}

/** How many times the slow step's command has started. */
async function attempts(workspace: TestWorkspace): Promise<number> {
  const log = await readFile(join(workspace.cwd, 'attempts.log'), 'utf8').catch(() => '');
  return log.split('\n').filter((line) => line === 'started').length;
}

/** Wait until the slow step's command has started once. */
async function awaitFirstAttempt(workspace: TestWorkspace): Promise<void> {
  const deadline = Date.now() + 15_000;
  while ((await attempts(workspace)) < 1) {
    if (Date.now() > deadline) throw new Error('the command never started');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function errorCode(stdout: string): unknown {
  const envelope = parseConcatenatedJson(stdout).find(
    (document) =>
      typeof document === 'object' &&
      document !== null &&
      (document as Record<string, unknown>).kind === 'error',
  ) as Record<string, unknown> | undefined;
  return envelope?.code;
}

describe('execution lease across processes', () => {
  let workspace: TestWorkspace;
  let running: StartedRun | undefined;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'slow.runbook.md'), SLOW);
  });

  afterEach(async () => {
    const child = running?.child;
    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid !== undefined
    ) {
      process.kill(-child.pid, 'SIGKILL');
      await running?.exited;
    }
    running = undefined;
    await workspace.cleanup();
  });

  it('refuses a second attempt EXECUTION_IN_PROGRESS while the command runs', async () => {
    running = await startRun(workspace, 'slow.runbook.md');
    const execution = await awaitExecution(workspace, running.runId);
    await awaitFirstAttempt(workspace);
    expect(execution).toMatchObject({
      condition: 'in_progress',
      step: '1',
      pid: running.child.pid,
    });

    const pass = runCli(['pass', '--token', running.token, '--step', '1'], workspace);
    const fail = runCli(['fail', '--token', running.token, '--step', '1'], workspace);

    expect(pass.exitCode).toBe(1);
    expect(errorCode(pass.stdout)).toBe('EXECUTION_IN_PROGRESS');
    expect(fail.exitCode).toBe(1);
    expect(errorCode(fail.stdout)).toBe('EXECUTION_IN_PROGRESS');
    const status = parseCliJsonObject(runCli(['status', '--run', running.runId], workspace).stdout);
    expect(status).toMatchObject({ active: true, position: { current: '1' } });
    expect(await attempts(workspace)).toBe(1);
  }, 30_000);

  it('leaves a SIGKILLed owner Interrupted until the owner decides, never repeating the command', async () => {
    running = await startRun(workspace, 'slow.runbook.md');
    await awaitExecution(workspace, running.runId);
    await awaitFirstAttempt(workspace);
    const { token, runId } = running;
    if (running.child.pid === undefined) throw new Error('no pid');
    process.kill(-running.child.pid, 'SIGKILL');
    await running.exited;

    const status = parseCliJsonObject(runCli(['status', '--run', runId], workspace).stdout);
    expect(status).toMatchObject({
      active: true,
      execution: { condition: 'interrupted', step: '1' },
    });

    const pass = runCli(['pass', '--token', token, '--step', '1'], workspace);
    expect(pass.exitCode).toBe(1);
    expect(errorCode(pass.stdout)).toBe('EXECUTION_INTERRUPTED');
    expect(pass.stdout).toContain('rundown fail --step 1');
    // Refused again: nothing cleared the interruption but an explicit decision.
    expect(errorCode(runCli(['pass', '--token', token, '--step', '1'], workspace).stdout)).toBe(
      'EXECUTION_INTERRUPTED',
    );

    const fail = runCli(['fail', '--token', token, '--step', '1'], workspace);
    expect(errorCode(fail.stdout)).toBeUndefined();

    const after = parseCliJsonObject(runCli(['status', '--run', runId], workspace).stdout);
    expect(after.execution).toBeUndefined();
    expect(after.status).toBe('stopped');
    expect(await attempts(workspace)).toBe(1);
  }, 30_000);
});
