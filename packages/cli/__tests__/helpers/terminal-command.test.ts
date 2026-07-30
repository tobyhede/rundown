import { describe, it, expect, jest } from '@jest/globals';
import {
  assertClaimId,
  assertRunId,
  InvalidRunbookStateError,
  parseClaimBearer,
  redactClaimId,
  type LifecycleTerminalOutcome,
  type RunbookState,
  type RunbookStateManager,
  type TransitionObservationEvent,
} from '@rundown-org/core';
import type { ChildTerminalPropagator } from '../../src/helpers/terminal-command.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { takeExitCode } from './exit-code.js';

// `runSeamTerminal` resolves the seam through this factory internally rather than
// taking it as a parameter — the one dependency in this module that is not
// injected. Mocking it is the only way to observe the seam input it builds, which
// the claim-target coupling guard below asserts on. Every other export here takes
// its `manager` as a parameter, so no existing test is affected by the mock.
//
// The module under test therefore has to be imported AFTER registration, which is
// why the value import below is dynamic; the type-only import above is erased and
// does not load the module.
jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory', () => ({
  buildNonDelegatingLifecycleSeam: jest.fn(),
}));

const {
  finalizeAppliedClaimTerminal,
  handleTerminalRecovery,
  renderTerminalOutcome,
  runSeamTerminal,
} = await import('../../src/helpers/terminal-command.js');
const { buildNonDelegatingLifecycleSeam } = await import(
  '../../src/helpers/lifecycle-seam-factory.js'
);

// Renderer contract coverage for the terminal (complete/stop) seam front end.
// Each LifecycleTerminalOutcome kind must map to the correct CLI envelope / error
// code and the correct exit-code boolean (return true → non-zero exit). This is
// the JSON-first path (CLAUDE.md): the emitter double records structured calls.

const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const PARENT_ID = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const CLAIM_ID = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);

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

describe('runSeamTerminal claim-target coupling (#613)', () => {
  /**
   * Drive `runSeamTerminal` against a stub seam and return the input it built.
   *
   * The stub answers `actor_context_required`: with a claim target that skips the
   * bare orphan-cleanup branch (guarded on `options.claimId === undefined`) and
   * renders through a path that never touches `manager`, so this stays a test of
   * input construction rather than of terminal rendering.
   */
  async function capturedSeamInput(
    options: { claimId?: ReturnType<typeof assertClaimId> } = {},
  ): Promise<Record<string, unknown>> {
    const captured: unknown[] = [];
    jest.mocked(buildNonDelegatingLifecycleSeam).mockReturnValue({
      manager: {} as never,
      sessionService: {} as never,
      seam: {
        runTerminal: async (input: unknown) => {
          captured.push(input);
          return { kind: 'actor_context_required' } as never;
        },
      } as never,
    });
    const { output } = recordingEmitter();

    await runSeamTerminal(output, '/cwd', 'complete', options);

    expect(captured).toHaveLength(1);
    return captured[0] as Record<string, unknown>;
  }

  it('derives caller evidence and target selector from one --claim-id', async () => {
    // `docs/reference/cli.md` and `docs/internal/architecture.md` both state that
    // CLAIM_BEARER_MISMATCH is unreachable from the CLI. That rests entirely on
    // this coupling, and complete/stop is where losing it costs most: a
    // divergence would force AND release a run on the target's own authority.
    // Nothing else fails if the two fields drift apart — the docs would just
    // silently become false — so it is pinned here, where drift would originate.
    const input = await capturedSeamInput({ claimId: CLAIM_ID });

    expect(input.callerEvidence).toEqual({ kind: 'claim_bearer', claimId: CLAIM_ID });
    expect(input.targetSelector).toEqual({ kind: 'claim', claimId: CLAIM_ID });
    // Stated as the seam's own gate states it: the same id on both sides.
    const evidence = input.callerEvidence as { claimId: unknown };
    const selector = input.targetSelector as { claimId: unknown };
    expect(evidence.claimId).toBe(selector.claimId);
  });

  it('presents no bearer without --claim-id, so the gate cannot fire', async () => {
    // Anti-vacuity for the case above: if the construction always produced a
    // claim-shaped pair the assertion would hold for the wrong reason.
    const input = await capturedSeamInput();

    expect(input.callerEvidence).toEqual({ kind: 'direct_cli' });
    expect((input.targetSelector as { kind: string }).kind).not.toBe('claim');
  });
});

describe('renderTerminalOutcome', () => {
  it('renders none as noActiveRunbook and exits 0', async () => {
    const { exitError, calls } = await render({ kind: 'none' });
    expect(exitError).toBe(false);
    expect(calls.some((c) => c.method === 'noActiveRunbook')).toBe(true);
  });

  it('renders a stale_claim outcome under the code core assigned it and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'stale_claim',
      claimId: CLAIM_ID,
      message: 'gone',
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('CLAIMED_RUNBOOK_UNAVAILABLE');
  });

  it('passes a superseded claim through as DELEGATION_SUPERSEDED, not the generic code', async () => {
    // The seam must not flatten the refusal back to "unavailable": RD-825 is the
    // no-retry signal, and complete/stop are reachable with a superseded bearer.
    const { exitError, calls } = await render({
      kind: 'stale_claim',
      claimId: CLAIM_ID,
      message: 'superseded',
      code: 'DELEGATION_SUPERSEDED',
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('DELEGATION_SUPERSEDED');
  });

  it('renders actor_context_required as ACTOR_CONTEXT_REQUIRED and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'actor_context_required',
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('ACTOR_CONTEXT_REQUIRED');
    const errorCall = calls.find((c) => c.method === 'error');
    // The remediation names the bearer-authority lane.
    expect(errorCall?.args[0]).toContain('--claim-id');
    // ...and the envelope carries NO details object and never echoes the
    // target run id — that would hand the refused caller a copy-paste bypass
    // of the accident barrier (decision 4).
    expect(errorCall?.args[2]).toBeUndefined();
    expect(JSON.stringify(errorCall?.args)).not.toContain(RUN_ID);
  });

  it('renders claim_bearer_mismatch as CLAIM_BEARER_MISMATCH and exits non-zero (#613)', async () => {
    const { exitError, calls } = await render({
      kind: 'claim_bearer_mismatch',
    });
    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('CLAIM_BEARER_MISMATCH');
    const errorCall = calls.find((c) => c.method === 'error');
    // A terminal is the highest-consequence divergence — forcing and releasing
    // a run on the target's own authority. It must not reuse the bare-form
    // advice, which would tell a caller that presented a claim to present one.
    expect(errorCall?.args[0]).not.toContain('Pass `--claim-id');
    expect(errorCall?.args[0]).toContain('Present the bearer');
    expect(errorCall?.args[2]).toBeUndefined();
    expect(JSON.stringify(errorCall?.args)).not.toContain(RUN_ID);
  });

  it('renders claim_grant_required as CLAIM_GRANT_REQUIRED and exits non-zero', async () => {
    const { exitError, calls } = await render({
      kind: 'claim_grant_required',
      claimId: CLAIM_ID,
      runId: RUN_ID,
    });

    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('CLAIM_GRANT_REQUIRED');
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
    // Identity is the non-secret lookup key, never the bearer (credential leak).
    expect(jsonCall?.args[0]).toMatchObject({
      kind: 'action',
      action: 'complete',
      status: 'already-resolved',
      claimKey: redactClaimId(CLAIM_ID),
      lifecycle: 'completed',
    });
    expect(JSON.stringify(jsonCall?.args[0])).not.toContain(parseClaimBearer(CLAIM_ID).secret);
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
  ] as const)(
    'renders inline_plan_unavailable (%s) with code %s and exits non-zero',
    async (reason, code) => {
      const { exitError, calls } = await render({
        kind: 'inline_plan_unavailable',
        reason,
        message: 'boom',
        code,
      });
      expect(exitError).toBe(true);
      expect(codeOf(calls, 'error')).toBe(code);
    },
  );

  it('renders applied_claim completed → metadata + complete, exit 0', async () => {
    const events: TransitionObservationEvent[] = [];
    const { exitError, calls } = await render(
      { kind: 'applied_claim', runId: RUN_ID, status: 'completed', events, reported: 'recorded' },
      { manager: managerReturning(fakeRootState()) },
    );
    expect(exitError).toBe(false);
    expect(calls.some((c) => c.method === 'metadata')).toBe(true);
    expect(calls.some((c) => c.method === 'complete')).toBe(true);
  });

  it('streams applied_claim events attributed to the claimed child state', async () => {
    // Exercises the applied_claim bridge path distinctly from applied_bare: the
    // single forced run's events are stamped with the claimed child's own id.
    const event = {
      type: 'RUNBOOK_COMPLETED',
      payload: { message: 'ok', position: undefined },
    } as unknown as TransitionObservationEvent;
    const { calls } = await render(
      {
        kind: 'applied_claim',
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

  it('renders applied_claim stopped → exit 0 (report-only delegated close)', async () => {
    // A claim-path stop reports the child fail to the parent as data, but the
    // command itself succeeds — only a bare stop is a failure terminal.
    const { exitError, calls } = await render(
      {
        kind: 'applied_claim',
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

  it('renders applied_claim when the root fails to reload → complete, no metadata/events', async () => {
    // The root fails to reload (manager returns null): the `if (rootState)` guards
    // skip metadata AND the event bridge, but the terminal envelope still renders.
    const event = {
      type: 'RUNBOOK_COMPLETED',
      payload: { message: 'ok', position: undefined },
    } as unknown as TransitionObservationEvent;
    const { exitError, calls } = await render(
      {
        kind: 'applied_claim',
        runId: RUN_ID,
        status: 'completed',
        events: [event],
        reported: 'recorded',
      },
      { manager: NO_MANAGER },
    );
    expect(exitError).toBe(false);
    expect(calls.some((c) => c.method === 'metadata')).toBe(false);
    expect(calls.some((c) => c.method === 'executionEvent')).toBe(false);
    expect(calls.some((c) => c.method === 'complete')).toBe(true);
  });

  it('renders applied_bare stopped → exit non-zero and streams attributed events through the bridge', async () => {
    const event = {
      type: 'RUNBOOK_STOPPED',
      payload: { message: 'Runbook stopped', position: undefined },
    } as unknown as TransitionObservationEvent;
    const { exitError, calls } = await render(
      {
        kind: 'applied_bare',
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

describe('finalizeAppliedClaimTerminal', () => {
  const APPLIED_STOP = {
    kind: 'applied_claim' as const,
    runId: RUN_ID,
    status: 'stopped' as const,
    events: [],
    reported: 'not-applicable' as const,
  };
  const APPLIED_COMPLETE = { ...APPLIED_STOP, status: 'completed' as const };

  /** Root state carrying an inline parent linkage (drives the propagate branch). */
  function inlineChildState(): RunbookState {
    return { ...fakeRootState(), parentLinkage: { kind: 'inline' } } as unknown as RunbookState;
  }

  /** Manager double counting loads and returning the supplied state. */
  function countingManager(state: RunbookState | null): {
    manager: RunbookStateManager;
    loads: () => number;
  } {
    let loads = 0;
    const manager = {
      load: async () => {
        loads++;
        return state;
      },
    } as unknown as RunbookStateManager;
    return { manager, loads: () => loads };
  }

  it('surfaces an error and non-zero exit when the terminated child fails to reload', async () => {
    const { output, calls } = recordingEmitter(true);
    let propagateCalled = false;
    const propagate: ChildTerminalPropagator = async () => {
      propagateCalled = true;
      return 'handled';
    };

    const exitError = await finalizeAppliedClaimTerminal(
      output,
      'stop',
      NO_MANAGER,
      APPLIED_STOP,
      '/cwd',
      undefined,
      propagate,
    );

    expect(exitError).toBe(true);
    expect(codeOf(calls, 'error')).toBe('RUN_TARGET_UNAVAILABLE');
    // Must NOT silently render a success envelope or propagate when the run vanished.
    expect(propagateCalled).toBe(false);
    expect(calls.some((c) => c.method === 'complete' || c.method === 'stopped')).toBe(false);
  });

  it('renders the child terminal before propagating to the inline parent', async () => {
    const { output, calls } = recordingEmitter(true);
    let childRenderedBeforePropagate = false;
    const propagate: ChildTerminalPropagator = async () => {
      childRenderedBeforePropagate = calls.some(
        (c) => c.method === 'stopped' || c.method === 'complete',
      );
      return 'handled';
    };

    await finalizeAppliedClaimTerminal(
      output,
      'stop',
      managerReturning(inlineChildState()),
      APPLIED_STOP,
      '/cwd',
      undefined,
      propagate,
    );

    expect(childRenderedBeforePropagate).toBe(true);
  });

  it('reloads the terminated child exactly once for both render and propagation', async () => {
    const { output } = recordingEmitter(true);
    const { manager, loads } = countingManager(inlineChildState());
    const propagate: ChildTerminalPropagator = async () => 'handled';

    await finalizeAppliedClaimTerminal(
      output,
      'complete',
      manager,
      APPLIED_COMPLETE,
      '/cwd',
      undefined,
      propagate,
    );

    expect(loads()).toBe(1);
  });

  it('propagates a stopped inline parent into a non-zero exit', async () => {
    const { output } = recordingEmitter(true);
    const propagate: ChildTerminalPropagator = async () => 'stopped';

    const exitError = await finalizeAppliedClaimTerminal(
      output,
      'complete',
      managerReturning(inlineChildState()),
      APPLIED_COMPLETE,
      '/cwd',
      undefined,
      propagate,
    );

    expect(exitError).toBe(true);
  });

  it('propagates a BLOCKED inline parent into a non-zero exit (#602)', async () => {
    // 'blocked' is the seam's fail-closed disposition — it is what a tripped
    // linkage guard ('linkage-cycle') collapses to at this adapter, and what a
    // command-infrastructure failure already collapsed to before #602. Exiting 0
    // here would print INLINE_PARENT_CYCLE on a SUCCESS exit: the diagnostic says
    // "corrupt state, prune the run" while the process says "all good". The
    // execution path already fails closed on 'blocked' (execution.ts:417); this
    // path must agree.
    const { output } = recordingEmitter(true);
    const propagate: ChildTerminalPropagator = async () => 'blocked';

    const exitError = await finalizeAppliedClaimTerminal(
      output,
      'complete',
      managerReturning(inlineChildState()),
      APPLIED_COMPLETE,
      '/cwd',
      undefined,
      propagate,
    );

    expect(exitError).toBe(true);
  });
});

describe('handleTerminalRecovery', () => {
  it('redacts the claim bearer in the complete recovery message (never leaks the secret)', async () => {
    const { output, calls } = recordingEmitter();

    await handleTerminalRecovery(
      'complete',
      new InvalidRunbookStateError('snapshot incompatible'),
      output,
      '/test',
      { claimId: CLAIM_ID },
    );

    const errorCall = calls.find((c) => c.method === 'error');
    expect(errorCall?.args[1]).toBe('CLAIMED_RUNBOOK_UNAVAILABLE');

    // The recovery message must name only the non-secret lookup key, never the
    // raw bearer whose 43-char secret would otherwise land in JSON output/logs.
    const message = String(errorCall?.args[0]);
    expect(message).toContain(redactClaimId(CLAIM_ID));
    expect(message).not.toContain(parseClaimBearer(CLAIM_ID).secret);
    // Defense in depth: nothing the recovery path emits carries the secret.
    expect(JSON.stringify(calls)).not.toContain(parseClaimBearer(CLAIM_ID).secret);

    // Recovery signals failure through `process.exitCode` rather than `process.exit`.
    // Assert it, and consume it so the value cannot leak into the next test file.
    expect(takeExitCode()).toBe(1);
  });
});
