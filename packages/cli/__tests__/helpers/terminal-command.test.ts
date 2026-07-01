import { describe, it, expect } from '@jest/globals';
import {
  assertClaimId,
  assertRunId,
  type LifecycleTerminalOutcome,
  type RunbookState,
  type RunbookStateManager,
  type TransitionObservationEvent,
} from '@rundown-org/core';
import { renderTerminalOutcome } from '../../src/helpers/terminal-command.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// Renderer contract coverage for the terminal (complete/stop) seam front end.
// Each LifecycleTerminalOutcome kind must map to the correct CLI envelope / error
// code and the correct exit-code boolean (return true → non-zero exit). This is
// the JSON-first path (CLAUDE.md): the emitter double records structured calls.

const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const PARENT_ID = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const CLAIM_ID = assertClaimId('rdclm_abcdefghijklmnopqrstu1');

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
  } as unknown as RunbookState;
}

/** Manager double whose `load` returns the supplied root state (or null). */
function managerReturning(state: RunbookState | null): RunbookStateManager {
  return { load: async () => state } as unknown as RunbookStateManager;
}

const NO_MANAGER = managerReturning(null);

async function render(
  outcome: LifecycleTerminalOutcome,
  opts: { command?: 'complete' | 'stop'; json?: boolean; manager?: RunbookStateManager } = {},
) {
  const { output, calls } = recordingEmitter(opts.json ?? true);
  const exitError = await renderTerminalOutcome(
    output,
    opts.command ?? 'complete',
    opts.manager ?? NO_MANAGER,
    outcome,
  );
  return { exitError, calls };
}

function codeOf(calls: Recorded[], method: string): string | undefined {
  const call = calls.find((c) => c.method === method);
  return call?.args[1] as string | undefined;
}

describe('renderTerminalOutcome', () => {
  it('renders none as noActiveRunbook and exits 0', async () => {
    const { exitError, calls } = await render({ kind: 'none' });
    expect(exitError).toBe(false);
    expect(calls.some((c) => c.method === 'noActiveRunbook')).toBe(true);
  });

  it('renders a stale_claim outcome as CLAIMED_RUNBOOK_UNAVAILABLE and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'stale_claim',
      claimId: CLAIM_ID,
      message: 'gone',
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('CLAIMED_RUNBOOK_UNAVAILABLE');
  });

  it('renders actor_context_required as ACTOR_CONTEXT_REQUIRED and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'actor_context_required',
      targetRunId: RUN_ID,
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('ACTOR_CONTEXT_REQUIRED');
    const errorCall = calls.find((c) => c.method === 'error');
    expect(errorCall?.args[2]).toEqual({ targetRunId: RUN_ID });
  });

  it('renders delegation_collection_pending via DELEGATION_COLLECTION_PENDING and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'delegation_collection_pending',
      parentRunId: PARENT_ID,
      outcomeCompletionKeys: ['k1'],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('DELEGATION_COLLECTION_PENDING');
  });

  it('renders terminal_claim_confirmed as an idempotent already-resolved JSON payload, exit 0', async () => {
    const { exitError, calls } = await render({
      kind: 'terminal_claim_confirmed',
      claimId: CLAIM_ID,
      lifecycle: 'completed',
      command: 'complete',
    });
    expect(exitError).toBe(false);
    const jsonCall = calls.find((c) => c.method === 'json');
    expect(jsonCall?.args[0]).toMatchObject({
      kind: 'action',
      action: 'complete',
      status: 'already-resolved',
      claimId: CLAIM_ID,
      lifecycle: 'completed',
    });
  });

  it('renders terminal_claim_confirmed as a human message when not JSON, exit 0', async () => {
    const { exitError, calls } = await render(
      {
        kind: 'terminal_claim_confirmed',
        claimId: CLAIM_ID,
        lifecycle: 'stopped',
        command: 'stop',
      },
      { command: 'stop', json: false },
    );
    expect(exitError).toBe(false);
    expect(calls.some((c) => c.method === 'message')).toBe(true);
  });

  it('renders terminal_claim_conflict as DELEGATION_RESULT_CONFLICT and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'terminal_claim_conflict',
      claimId: CLAIM_ID,
      lifecycle: 'stopped',
      expectedCommand: 'stop',
      requestedCommand: 'complete',
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('DELEGATION_RESULT_CONFLICT');
  });

  it('renders already_terminal as RUNBOOK_NOT_RUNNING and exits 0', async () => {
    const { exitError, calls } = await render({
      kind: 'already_terminal',
      targetRunId: RUN_ID,
      lifecycle: 'completed',
    });
    expect(exitError).toBe(false);
    // noActiveRunbook(command, 'RUNBOOK_NOT_RUNNING')
    expect(codeOf(calls, 'noActiveRunbook')).toBe('RUNBOOK_NOT_RUNNING');
  });

  it.each([
    ['missing-inline-parent', 'INLINE_PARENT_UNAVAILABLE'],
    ['inline-cycle', 'INLINE_PARENT_CYCLE'],
    ['root-unavailable', 'RUNBOOK_STATE_CHANGED'],
  ] as const)('renders inline_plan_unavailable (%s) with code %s and exits non-zero', async (reason, code) => {
    const { exitError, calls } = await render({
      kind: 'inline_plan_unavailable',
      reason,
      message: 'boom',
      code,
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe(code);
  });

  it('renders applied-claim completed → metadata + complete, exit 0', async () => {
    const events: TransitionObservationEvent[] = [];
    const { exitError, calls } = await render(
      { kind: 'applied-claim', runId: RUN_ID, status: 'completed', events, reported: 'recorded' },
      { manager: managerReturning(fakeRootState()) },
    );
    expect(exitError).toBe(false);
    expect(calls.some((c) => c.method === 'metadata')).toBe(true);
    expect(calls.some((c) => c.method === 'complete')).toBe(true);
  });

  it('streams applied-claim events attributed to the claimed child state', async () => {
    // Exercises the applied-claim bridge path distinctly from applied-bare: the
    // single forced run's events are stamped with the claimed child's own id.
    const event = {
      type: 'RUNBOOK_COMPLETED',
      payload: { message: 'ok', position: undefined },
    } as unknown as TransitionObservationEvent;
    const { calls } = await render(
      {
        kind: 'applied-claim',
        runId: RUN_ID,
        status: 'completed',
        events: [event],
        reported: 'recorded',
      },
      { manager: managerReturning(fakeRootState()) },
    );
    const executionEventCall = calls.find((c) => c.method === 'executionEvent');
    expect(executionEventCall?.args[0]).toMatchObject({ runbookId: RUN_ID });
  });

  it('renders applied-claim stopped → exit 0 (report-only delegated close)', async () => {
    // A claim-path stop reports the child fail to the parent as data, but the
    // command itself succeeds — only a bare stop is a failure terminal.
    const { exitError, calls } = await render(
      {
        kind: 'applied-claim',
        runId: RUN_ID,
        status: 'stopped',
        events: [],
        reported: 'recorded',
      },
      { command: 'stop', manager: managerReturning(fakeRootState()) },
    );
    expect(exitError).toBe(false);
    expect(calls.some((c) => c.method === 'stopped')).toBe(true);
  });

  it('renders applied-bare stopped → exit non-zero and streams attributed events through the bridge', async () => {
    const event = {
      type: 'RUNBOOK_STOPPED',
      payload: { message: 'Runbook stopped', position: undefined },
    } as unknown as TransitionObservationEvent;
    const { exitError, calls } = await render(
      {
        kind: 'applied-bare',
        rootRunId: RUN_ID,
        status: 'stopped',
        events: [{ runId: RUN_ID, runbook: { source: 'project', path: 'root.md' }, event }],
        forcedRunIds: [RUN_ID],
        reported: 'not-applicable',
      },
      { command: 'stop', manager: managerReturning(fakeRootState()) },
    );
    expect(exitError).toBe(true);
    expect(calls.some((c) => c.method === 'metadata')).toBe(true);
    expect(calls.some((c) => c.method === 'executionEvent')).toBe(true);
    expect(calls.some((c) => c.method === 'stopped')).toBe(true);
  });
});
