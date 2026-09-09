import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RunbookStateManager, SessionService, assertClaimId } from '@rundown-org/core';
import {
  createRunbook,
  createTestWorkspace,
  getCliPath,
  parseConcatenatedJson,
  parseJsonEvents,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const DRIVER = fileURLToPath(new URL('../fixtures/progression-driver-child.ts', import.meta.url));
const COMPLETION_DRIVER = fileURLToPath(
  new URL('../fixtures/progression-completion-race-driver-child.ts', import.meta.url),
);
const COMPLETION_WRITER = fileURLToPath(
  new URL('../fixtures/progression-completion-writer-child.ts', import.meta.url),
);
const TSX = createRequire(import.meta.url).resolve('tsx');

interface ProcessResult {
  readonly pid: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DriverReport {
  readonly ok: boolean;
  readonly pid: number;
  readonly outcome?: Record<string, unknown>;
  readonly events?: readonly string[];
  readonly propagationSources?: readonly Record<string, unknown>[];
  readonly error?: string;
}

interface WriterReport {
  readonly ok: boolean;
  readonly pid: number;
  readonly mode: 'record' | 'apply';
  readonly events?: readonly string[];
  readonly outcome?: Record<string, unknown>;
  readonly error?: string;
}

describe('issue #854: multi-process Run Progression races', () => {
  let workspace: TestWorkspace;
  let children: ChildProcess[];

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    children = [];
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await workspace.cleanup();
  });

  /** Poll for a checked-in worker protocol file, failing if its process exits first. */
  async function waitForFile(file: string, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await readFile(file, 'utf8');
        return;
      } catch {
        // File absence is the waiting condition; a dead worker is a broken witness.
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`progression driver ${String(child.pid)} exited before ${file}`);
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Spawn a process and retain its complete JSON/stdout result. */
  function spawnProcess(args: readonly string[]): {
    readonly child: ChildProcess;
    readonly result: Promise<ProcessResult>;
  } {
    const child = spawn(process.execPath, [...args], {
      cwd: workspace.cwd,
      env: {
        ...process.env,
        PATH: `${workspace.binPath()}:${process.env.PATH ?? ''}`,
        CLAUDE_PLUGIN_ROOT: join(workspace.cwd, 'plugin'),
        NO_COLOR: '1',
        FORCE_COLOR: undefined,
        RUNDOWN_LOG: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const result = new Promise<ProcessResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal !== null) {
          reject(new Error(`process ${String(child.pid)} exited on ${signal}`));
          return;
        }
        resolve({
          pid: child.pid ?? -1,
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
    return { child, result };
  }

  it('converges on durable completed without executing or falsely refusing the stale command', async () => {
    const runbook = createRunbook({
      title: 'Command capture race',
      steps: [
        {
          title: 'Command or authored pass',
          pass: 'COMPLETE',
          fail: 'GOTO 1',
          command: 'true',
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'command-capture-race.runbook.md'), runbook);
    // Prompted start creates the real run-control claim but deliberately parks
    // before automatic command execution. The persisted flag is then cleared
    // so the independent driver process selects the runnable command.
    const started = runCli('run --prompted command-capture-race.runbook.md', workspace);
    expect(started).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const startedEvent = parseJsonEvents(started.stdout).find(
      (event) => event.type === 'runbook_started',
    );
    const claimId = startedEvent?.claim_id;
    const runId = startedEvent?.runbookId;
    if (typeof claimId !== 'string' || typeof runId !== 'string') {
      throw new Error(`runbook_started did not carry run/claim identity: ${started.stdout}`);
    }
    const manager = new RunbookStateManager(workspace.cwd);
    await manager.update(runId, { prompted: false });

    const readyFile = join(workspace.cwd, 'progression-driver.ready');
    const goFile = join(workspace.cwd, 'progression-driver.go');
    const reportFile = join(workspace.cwd, 'progression-driver.report.json');
    const driver = spawnProcess([
      '--import',
      TSX,
      DRIVER,
      workspace.cwd,
      runId,
      claimId,
      readyFile,
      goFile,
      reportFile,
    ]);
    await waitForFile(readyFile, driver.child);

    // The driver is parked after selecting the command but before capture. A
    // distinct real CLI process now authors PASS, atomically commits completed
    // + addressed Run Release, and exits before the driver is released.
    const writer = spawnProcess([getCliPath(), 'pass', '--claim-id', claimId]);
    const writerResult = await writer.result;
    expect(writerResult).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const writerEnvelopes = parseConcatenatedJson(writerResult.stdout);
    expect(writerEnvelopes).not.toContainEqual(expect.objectContaining({ kind: 'error' }));
    expect(writerEnvelopes).not.toContainEqual(
      expect.objectContaining({ type: 'runbook_stopped' }),
    );
    await writeFile(goFile, 'writer committed terminal');

    const driverResult = await driver.result;
    expect(driverResult).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const report = JSON.parse(await readFile(reportFile, 'utf8')) as DriverReport;
    expect(report).toMatchObject({
      ok: true,
      pid: driverResult.pid,
      outcome: { kind: 'completed', runId },
    });
    expect(report.events).not.toContain('COMMAND_STARTED');
    expect(report.events).not.toContain('ERROR_OCCURRED');
    expect(report.events).not.toContain('RUNBOOK_STOPPED');
    expect(new Set([driverResult.pid, writerResult.pid]).size).toBe(2);
    expect([driverResult.pid, writerResult.pid]).not.toContain(process.pid);

    const state = await manager.load(runId);
    expect(state?.lifecycle).toBe('completed');
    const session = new SessionService(manager);
    await expect(session.getActive()).resolves.toBeNull();
    await expect(session.getActiveForClaimId(assertClaimId(claimId))).resolves.toMatchObject({
      status: 'terminal',
      lifecycle: 'completed',
    });
  }, 90_000);

  it('applies a FAIL COMPLETE recorded after waiting selection before handing back', async () => {
    const runbook = createRunbook({
      title: 'Waiting selection completion race',
      steps: [
        {
          title: 'Fan-out',
          pass: 'STOP',
          fail: 'COMPLETE',
          substeps: [
            { title: 'First', pass: 'DEFER', fail: 'DEFER' },
            { title: 'Second', pass: 'DEFER', fail: 'DEFER' },
          ],
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'waiting-selection-race.runbook.md'), runbook);
    const started = runCli('run --prompted waiting-selection-race.runbook.md', workspace);
    expect(started).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const startedEvent = parseJsonEvents(started.stdout).find(
      (event) => event.type === 'runbook_started',
    );
    const claimId = startedEvent?.claim_id;
    const runId = startedEvent?.runbookId;
    if (typeof claimId !== 'string' || typeof runId !== 'string') {
      throw new Error(`runbook_started did not carry run/claim identity: ${started.stdout}`);
    }

    const readyFile = join(workspace.cwd, 'waiting-selection.ready');
    const goFile = join(workspace.cwd, 'waiting-selection.go');
    const driverReportFile = join(workspace.cwd, 'waiting-selection.driver.json');
    const writerReportFile = join(workspace.cwd, 'waiting-selection.writer.json');
    const driver = spawnProcess([
      '--import',
      TSX,
      COMPLETION_DRIVER,
      workspace.cwd,
      runId,
      claimId,
      'waiting',
      readyFile,
      goFile,
      driverReportFile,
    ]);
    await waitForFile(readyFile, driver.child);

    // The driver applied the first PASS and is now parked after XState selected
    // waiting, before the authoritative stability read. A distinct process
    // records the second substep's FAIL but deliberately does not activate its
    // returned directive; only the parked activation may observe and apply it.
    const writer = spawnProcess([
      '--import',
      TSX,
      COMPLETION_WRITER,
      'record',
      workspace.cwd,
      runId,
      claimId,
      'fail',
      writerReportFile,
    ]);
    const writerResult = await writer.result;
    expect(writerResult).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const writerReport = JSON.parse(await readFile(writerReportFile, 'utf8')) as WriterReport;
    expect(writerReport).toMatchObject({
      ok: true,
      pid: writerResult.pid,
      mode: 'record',
      events: [],
      outcome: { kind: 'applied', progression: 'activate' },
    });
    await writeFile(goFile, 'completion recorded');

    const driverResult = await driver.result;
    expect(driverResult).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const driverReport = JSON.parse(await readFile(driverReportFile, 'utf8')) as DriverReport;
    expect(driverReport).toMatchObject({
      ok: true,
      pid: driverResult.pid,
      outcome: { kind: 'completed', runId },
      propagationSources: [{ kind: 'explicit-result', result: 'fail' }],
    });
    expect(driverReport.events?.filter((event) => event === 'RUNBOOK_COMPLETED')).toHaveLength(1);
    expect(driverReport.events).toContain('STEP_TRANSITIONED');
    expect(driverReport.events).not.toContain('ERROR_OCCURRED');
    expect(new Set([driverResult.pid, writerResult.pid, process.pid]).size).toBe(3);

    const manager = new RunbookStateManager(workspace.cwd);
    await expect(manager.load(runId)).resolves.toMatchObject({
      lifecycle: 'completed',
      lastResult: 'fail',
      resolvedCompletions: {},
    });
    const session = new SessionService(manager);
    await expect(session.getActive()).resolves.toBeNull();
    await expect(session.getActiveForClaimId(assertClaimId(claimId))).resolves.toMatchObject({
      status: 'terminal',
      lifecycle: 'completed',
    });
  }, 90_000);

  it('converges on a competing PASS STOP apply without duplicate observation or release', async () => {
    const runbook = createRunbook({
      title: 'Completion apply race',
      steps: [
        {
          title: 'Fan-out',
          pass: 'STOP',
          fail: 'COMPLETE',
          substeps: [{ title: 'Only', pass: 'DEFER', fail: 'DEFER' }],
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'completion-apply-race.runbook.md'), runbook);
    const started = runCli('run --prompted completion-apply-race.runbook.md', workspace);
    expect(started).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const startedEvent = parseJsonEvents(started.stdout).find(
      (event) => event.type === 'runbook_started',
    );
    const claimId = startedEvent?.claim_id;
    const runId = startedEvent?.runbookId;
    if (typeof claimId !== 'string' || typeof runId !== 'string') {
      throw new Error(`runbook_started did not carry run/claim identity: ${started.stdout}`);
    }

    const readyFile = join(workspace.cwd, 'completion-apply.ready');
    const goFile = join(workspace.cwd, 'completion-apply.go');
    const driverReportFile = join(workspace.cwd, 'completion-apply.driver.json');
    const writerReportFile = join(workspace.cwd, 'completion-apply.writer.json');
    const driver = spawnProcess([
      '--import',
      TSX,
      COMPLETION_DRIVER,
      workspace.cwd,
      runId,
      claimId,
      'apply_completion',
      readyFile,
      goFile,
      driverReportFile,
    ]);
    await waitForFile(readyFile, driver.child);

    // Both processes saw the persisted PASS completion. The writer performs
    // the real one-apply CAS and addressed Run Release while the driver is
    // parked immediately after machine selection; the losing driver then
    // reloads the authoritative terminal instead of observing or releasing it.
    const writer = spawnProcess([
      '--import',
      TSX,
      COMPLETION_WRITER,
      'apply',
      workspace.cwd,
      runId,
      claimId,
      'pass',
      writerReportFile,
    ]);
    const writerResult = await writer.result;
    expect(writerResult).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const writerReport = JSON.parse(await readFile(writerReportFile, 'utf8')) as WriterReport;
    expect(writerReport).toMatchObject({
      ok: true,
      pid: writerResult.pid,
      mode: 'apply',
      outcome: { kind: 'applied', terminal: 'stopped' },
    });
    expect(writerReport.events?.filter((event) => event === 'RUNBOOK_STOPPED')).toHaveLength(1);
    expect(writerReport.events).not.toContain('ERROR_OCCURRED');
    await writeFile(goFile, 'competing apply committed terminal');

    const driverResult = await driver.result;
    expect(driverResult).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    const driverReport = JSON.parse(await readFile(driverReportFile, 'utf8')) as DriverReport;
    expect(driverReport).toMatchObject({
      ok: true,
      pid: driverResult.pid,
      outcome: { kind: 'stopped', runId },
      events: [],
      propagationSources: [{ kind: 'explicit-result', result: 'pass' }],
    });
    expect(driverReport.events).not.toContain('STEP_TRANSITIONED');
    expect(driverReport.events).not.toContain('RUNBOOK_STOPPED');
    expect(driverReport.events).not.toContain('ERROR_OCCURRED');
    expect(new Set([driverResult.pid, writerResult.pid, process.pid]).size).toBe(3);

    const manager = new RunbookStateManager(workspace.cwd);
    await expect(manager.load(runId)).resolves.toMatchObject({
      lifecycle: 'stopped',
      lastResult: 'pass',
      resolvedCompletions: {},
    });
    const session = new SessionService(manager);
    await expect(session.getActive()).resolves.toBeNull();
    await expect(session.getActiveForClaimId(assertClaimId(claimId))).resolves.toMatchObject({
      status: 'terminal',
      lifecycle: 'stopped',
    });
  }, 90_000);
});
