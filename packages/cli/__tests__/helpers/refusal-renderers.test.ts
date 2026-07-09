import { describe, it, expect } from '@jest/globals';
import { assertClaimId, assertRunId, parseClaimBearer, redactClaimId } from '@rundown-org/core';
import {
  renderActorContextRequiredRefusal,
  renderClaimGrantRequiredRefusal,
  renderTerminalClaimConfirmed,
  renderTerminalClaimConflict,
} from '../../src/helpers/refusal-renderers.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

interface Recorded {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Recording OutputEmitter double capturing structured output calls. */
function recordingEmitter(json = true): { output: OutputEmitter; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) =>
      calls.push({ method, args });
  const output = {
    error: rec('error'),
    json: rec('json'),
    message: rec('message'),
    isJson: () => json,
  } as unknown as OutputEmitter;
  return { output, calls };
}

const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CLAIM_ID = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const CLAIM_SECRET = parseClaimBearer(CLAIM_ID).secret;
const CLAIM_KEY = redactClaimId(CLAIM_ID);

describe('renderActorContextRequiredRefusal', () => {
  it('emits ACTOR_CONTEXT_REQUIRED, names the command, and never echoes a run id', () => {
    const { output, calls } = recordingEmitter();

    const exit = renderActorContextRequiredRefusal(output, 'abort', 'aborting delegated work');

    expect(exit).toBe(true);
    const err = calls.find((c) => c.method === 'error');
    expect(err?.args[1]).toBe('ACTOR_CONTEXT_REQUIRED');
    expect(err?.args[0]).toContain('rundown abort');
    expect(err?.args[0]).toContain('aborting delegated work');
    // Accident barrier: the actor-context refusal must carry no details object.
    expect(err?.args[2]).toBeUndefined();
  });
});

describe('renderClaimGrantRequiredRefusal', () => {
  it('emits CLAIM_GRANT_REQUIRED with the shared wording and no details by default', () => {
    const { output, calls } = recordingEmitter();

    const exit = renderClaimGrantRequiredRefusal(output, 'abort');

    expect(exit).toBe(true);
    const err = calls.find((c) => c.method === 'error');
    expect(err?.args[1]).toBe('CLAIM_GRANT_REQUIRED');
    expect(err?.args[0]).toContain('rundown abort');
    expect(err?.args[2]).toBeUndefined();
  });

  it('forwards a targetRunId detail when supplied', () => {
    const { output, calls } = recordingEmitter();

    renderClaimGrantRequiredRefusal(output, 'abort', { targetRunId: RUN_ID });

    const err = calls.find((c) => c.method === 'error');
    expect(err?.args[2]).toEqual({ targetRunId: RUN_ID });
  });
});

describe('renderTerminalClaimConfirmed', () => {
  it('identifies the claim by its redacted key in the JSON payload, never the bearer secret', () => {
    const { output, calls } = recordingEmitter(true);

    const exit = renderTerminalClaimConfirmed(output, 'complete', CLAIM_ID, 'completed');

    expect(exit).toBe(false);
    const json = calls.find((c) => c.method === 'json');
    const payload = json?.args[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: 'action',
      action: 'complete',
      status: 'already-resolved',
      claimKey: CLAIM_KEY,
      lifecycle: 'completed',
    });
    expect(payload.claimId).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(CLAIM_SECRET);
  });

  it('identifies the claim by its redacted key in text mode, never the bearer secret', () => {
    const { output, calls } = recordingEmitter(false);

    renderTerminalClaimConfirmed(output, 'complete', CLAIM_ID, 'completed');

    const message = calls.find((c) => c.method === 'message');
    expect(String(message?.args[0])).toContain(CLAIM_KEY);
    expect(String(message?.args[0])).not.toContain(CLAIM_SECRET);
  });
});

describe('renderTerminalClaimConflict', () => {
  it('identifies the claim by its redacted key, never the bearer secret', () => {
    const { output, calls } = recordingEmitter(true);

    const exit = renderTerminalClaimConflict(output, CLAIM_ID, 'completed', 'stopped');

    expect(exit).toBe(true);
    const err = calls.find((c) => c.method === 'error');
    expect(err?.args[1]).toBe('DELEGATION_RESULT_CONFLICT');
    expect(String(err?.args[0])).toContain(CLAIM_KEY);
    expect(String(err?.args[0])).not.toContain(CLAIM_SECRET);
  });
});
