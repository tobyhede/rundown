import { describe, it, expect, jest } from '@jest/globals';
import {
  assertRunId,
  CONCURRENT_MODIFICATION_CODE,
  generateOwnerToken,
  type LifecycleTerminalOutcome,
  type OwnedRunResolution,
  type RunbookState,
  type RunbookStateManager,
  type TransitionObservationEvent,
} from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// `runSeamTerminal` resolves the seam through this factory internally rather than
// taking it as a parameter — the one dependency in this module that is not
// injected. Mocking it is the only way to observe the seam input it builds.
// Token resolution is likewise core's (`resolveOwnedRun`), mocked structurally.
//
// The module under test therefore has to be imported AFTER registration, which is
// why the value import below is dynamic.
// The command's target is core's decision (`resolveCommandTarget`, #903); the
// CLI helper that supplies its settle callable is mocked to the same double.
jest.unstable_mockModule('../../src/helpers/command-target', () => ({
  resolveCommandTarget: (ctx: { readonly manager: unknown }, token: unknown) =>
    resolveOwnedRun(ctx.manager as never, token as never),
}));
jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory', () => ({
  buildLifecycleSeam: jest.fn(),
}));
const actualCore = await import('@rundown-org/core');
const resolveOwnedRun = jest.fn<typeof actualCore.resolveOwnedRun>();
jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  resolveOwnedRun,
}));

const { renderTerminalOutcome, runSeamTerminal, ForceTerminalEventBridge } = await import(
  '../../src/helpers/terminal-command.js'
);
const { buildLifecycleSeam } = await import('../../src/helpers/lifecycle-seam-factory.js');

// Renderer contract coverage for the terminal (complete/stop) seam front end.
// Each LifecycleTerminalOutcome kind must map to the correct CLI envelope / error
// code and the correct exit-code boolean (return true → non-zero exit). This is
// the JSON-first path (CLAUDE.md): the emitter double records structured calls.

const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const TOKEN = generateOwnerToken();

interface Recorded {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Recording OutputEmitter double capturing structured calls in JSON mode. */
function recordingEmitter(json = true): { output: OutputEmitter; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const output = {
    noActiveRunbook: rec('noActiveRunbook'),
    error: rec('error'),
    json: rec('json'),
    message: rec('message'),
    metadata: rec('metadata'),
    executionEvent: rec('executionEvent'),
    complete: rec('complete'),
    stopped: rec('stopped'),
    flush: rec('flush'),
    isJson: () => json,
  } as unknown as OutputEmitter;
  return { output, calls };
}

/** Minimal RunbookState sufficient for buildMetadata + event attribution. */
function fakeRootState(id = RUN_ID): RunbookState {
  return {
    id,
    runbook: { source: 'project', path: 'root.md' },
    prompted: false,
    lifecycle: 'running',
  } as unknown as RunbookState;
}

/** Manager double whose `load` returns the supplied root state (or null). */
function managerReturning(state: RunbookState | null): RunbookStateManager {
  return { load: async () => state } as unknown as RunbookStateManager;
}

const NO_MANAGER = managerReturning(null);

async function render(
  outcome: LifecycleTerminalOutcome,
  opts: {
    command?: 'complete' | 'stop';
    json?: boolean;
    manager?: RunbookStateManager;
    message?: string;
  } = {},
) {
  const { output, calls } = recordingEmitter(opts.json ?? true);
  const exitError = await renderTerminalOutcome(
    output,
    opts.command ?? 'complete',
    opts.manager ?? NO_MANAGER,
    outcome,
    opts.message,
  );
  return { exitError, calls };
}

function codeOf(calls: Recorded[], method: string): string | undefined {
  const call = calls.find((c) => c.method === method);
  return call?.args[1] as string | undefined;
}

function completedEvent(): TransitionObservationEvent {
  return {
    type: 'RUNBOOK_COMPLETED',
    payload: { finalPosition: { current: '1', total: 1 } },
  } as unknown as TransitionObservationEvent;
}

function applied(
  lifecycle: 'completed' | 'stopped',
  events: readonly TransitionObservationEvent[] = [],
): LifecycleTerminalOutcome {
  return { kind: 'applied', runId: RUN_ID, lifecycle, events, progression: { kind: 'none' } };
}

function running(state: RunbookState = fakeRootState()): OwnedRunResolution {
  return { kind: 'running', run: { state, stateVersion: 1 as never, lease: null, linkage: null } };
}

describe('runSeamTerminal', () => {
  it('resolves the owned run from the token and hands it to runTerminal with the command', async () => {
    const runTerminal = jest.fn(async () => applied('completed'));
    const manager = managerReturning(fakeRootState());
    jest.mocked(buildLifecycleSeam).mockReturnValue({
      manager,
      seam: { runTerminal } as never,
    });
    const state = fakeRootState();
    resolveOwnedRun.mockResolvedValue(running(state));
    const { output, calls } = recordingEmitter();

    const result = await runSeamTerminal(output, '/cwd', 'complete', {
      token: TOKEN,
      message: 'done',
    });

    expect(resolveOwnedRun).toHaveBeenCalledWith(manager, TOKEN);
    expect(runTerminal).toHaveBeenCalledTimes(1);
    const input = (runTerminal.mock.calls as unknown as [[Record<string, unknown>]])[0][0];
    expect(input.command).toBe('complete');
    expect(input.run).toEqual({ state, stateVersion: 1, lease: null, linkage: null });
    expect(input.message).toBe('done');
    expect(result.exitError).toBe(false);
    expect(calls.find((c) => c.method === 'complete')?.args[0]).toBe('done');
    expect(calls.at(-1)?.method).toBe('flush');
  });

  it('renders UNKNOWN_TOKEN and never reaches the seam when no run carries the token', async () => {
    const runTerminal = jest.fn();
    jest.mocked(buildLifecycleSeam).mockReturnValue({
      manager: NO_MANAGER,
      seam: { runTerminal } as never,
    });
    resolveOwnedRun.mockResolvedValue({ kind: 'unknown_token' });
    const { output, calls } = recordingEmitter();

    const result = await runSeamTerminal(output, '/cwd', 'stop', { token: TOKEN });

    expect(runTerminal).not.toHaveBeenCalled();
    expect(result.exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('UNKNOWN_TOKEN');
  });

  it('renders RD-303 for a token whose run already completed, without reaching the seam', async () => {
    const runTerminal = jest.fn();
    jest.mocked(buildLifecycleSeam).mockReturnValue({
      manager: NO_MANAGER,
      seam: { runTerminal } as never,
    });
    resolveOwnedRun.mockResolvedValue({
      kind: 'finished',
      state: fakeRootState(),
      lifecycle: 'completed',
    });
    const { output, calls } = recordingEmitter();

    const result = await runSeamTerminal(output, '/cwd', 'stop', { token: TOKEN });

    expect(runTerminal).not.toHaveBeenCalled();
    expect(result.exitError).toBe(true);
    const error = calls.find((c) => c.method === 'error');
    expect(error?.args[1]).toBe('RD-303');
    expect(error?.args[2]).toEqual({ runId: RUN_ID, lifecycle: 'completed' });
    expect(String(error?.args[0])).not.toContain(TOKEN);
  });

  it('uses the complete display policy for complete and the always-false policy for stop', async () => {
    const runTerminal = jest.fn(async () => applied('completed'));
    jest.mocked(buildLifecycleSeam).mockReturnValue({
      manager: managerReturning(fakeRootState()),
      seam: { runTerminal } as never,
    });
    resolveOwnedRun.mockResolvedValue(running());

    await runSeamTerminal(recordingEmitter().output, '/cwd', 'complete', { token: TOKEN });
    await runSeamTerminal(recordingEmitter().output, '/cwd', 'stop', { token: TOKEN });

    const calls = runTerminal.mock.calls as unknown as [
      [{ computeActionResult: (t: string) => boolean }],
      [{ computeActionResult: (t: string) => boolean }],
    ];
    expect(calls[0][0].computeActionResult('CONTINUE')).toBe(true);
    expect(calls[0][0].computeActionResult('RETRY')).toBe(false);
    expect(calls[0][0].computeActionResult('STOP')).toBe(false);
    expect(calls[1][0].computeActionResult('CONTINUE')).toBe(false);
  });
});

describe('renderTerminalOutcome', () => {
  it('renders run_finished as RD-303 for a completed run and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'run_finished',
      runId: RUN_ID,
      lifecycle: 'completed',
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('RD-303');
  });

  it.each(['stopped', 'abandoned'] as const)(
    'renders run_finished as RD-304 for a %s run and exits non-zero',
    async (lifecycle) => {
      const { exitError, calls } = await render(
        { kind: 'run_finished', runId: RUN_ID, lifecycle },
        { command: 'stop' },
      );
      expect(exitError).toBe(true);
      const error = calls.find((c) => c.method === 'error');
      expect(error?.args[1]).toBe('RD-304');
      expect(String(error?.args[0])).toContain('rundown stop');
      expect(error?.args[2]).toEqual({ runId: RUN_ID, lifecycle });
    },
  );

  it('renders concurrent_modification as CONCURRENT_MODIFICATION with the run id and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'concurrent_modification',
      runId: RUN_ID,
      message: 'row moved',
    });
    expect(exitError).toBe(true);
    const error = calls.find((c) => c.method === 'error');
    expect(error?.args[0]).toBe('row moved');
    expect(error?.args[1]).toBe(CONCURRENT_MODIFICATION_CODE);
    expect(error?.args[2]).toEqual({ runId: RUN_ID });
  });

  it('renders applied completed → metadata + complete, exit 0', async () => {
    const { exitError, calls } = await render(applied('completed'), {
      manager: managerReturning(fakeRootState()),
    });
    expect(exitError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['metadata', 'complete']);
    expect(calls[0].args[0]).toMatchObject({ file: 'root.md', runId: RUN_ID });
    expect(calls[1].args[0]).toBe('Runbook completed successfully');
  });

  it('renders applied stopped → metadata + stopped, exit non-zero (No silent mapping)', async () => {
    const { exitError, calls } = await render(applied('stopped'), {
      command: 'stop',
      manager: managerReturning(fakeRootState()),
      message: 'aborted by operator',
    });
    expect(exitError).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['metadata', 'stopped']);
    expect(calls[1].args[0]).toBe('aborted by operator');
  });

  it('streams applied events through one bridge attributed to the run, with monotonic seq', async () => {
    const { exitError, calls } = await render(
      applied('completed', [completedEvent(), completedEvent()]),
      { manager: managerReturning(fakeRootState()) },
    );
    expect(exitError).toBe(false);
    const streamed = calls.filter((c) => c.method === 'executionEvent');
    expect(streamed).toHaveLength(2);
    expect(streamed.map((c) => (c.args[0] as { seq: number }).seq)).toEqual([1, 2]);
    for (const call of streamed) {
      expect(call.args[0]).toMatchObject({
        v: '1',
        type: 'RUNBOOK_COMPLETED',
        runbookId: RUN_ID,
        runbook: { source: 'project', path: 'root.md' },
      });
    }
  });

  it('renders applied without metadata or events when the run cannot be reloaded', async () => {
    const { exitError, calls } = await render(applied('completed', [completedEvent()]));
    expect(exitError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['complete']);
  });
});

describe('ForceTerminalEventBridge', () => {
  it('stamps a v1 envelope with the attribution and a counter that never restarts', () => {
    const { output, calls } = recordingEmitter();
    const bridge = new ForceTerminalEventBridge(output);
    const other = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    bridge.emit({ id: RUN_ID, runbook: { source: 'project', path: 'a.md' } }, completedEvent());
    bridge.emit({ id: other, runbook: { source: 'project', path: 'b.md' } }, completedEvent());
    expect(calls.map((c) => c.args[0])).toEqual([
      expect.objectContaining({
        seq: 1,
        runbookId: RUN_ID,
        runbook: { source: 'project', path: 'a.md' },
      }),
      expect.objectContaining({
        seq: 2,
        runbookId: other,
        runbook: { source: 'project', path: 'b.md' },
      }),
    ]);
    for (const call of calls) {
      expect(typeof (call.args[0] as { ts: unknown }).ts).toBe('string');
    }
  });
});
