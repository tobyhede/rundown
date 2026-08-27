import { describe, it, expect } from '@jest/globals';
import {
  assertClaimId,
  assertRunId,
  parseClaimBearer,
  redactClaimId,
  TestWriter,
} from '@rundown-org/core';
import * as refusalRenderers from '../../src/helpers/refusal-renderers.js';
import {
  renderActorContextRequiredRefusal,
  renderClaimBearerMismatchRefusal,
  renderClaimGrantRequiredRefusal,
  renderRefusedTerminalCleanup,
  renderStaleClaimRefusal,
  renderTerminalClaimConfirmed,
  renderTerminalClaimConflict,
} from '../../src/helpers/refusal-renderers.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';
import { ErrorCodeSchema, ErrorResponseSchema, validateSchema } from './schema-validator.js';

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

/**
 * Drive a renderer through a real {@link OutputEmitter} in its default JSON mode
 * and return the envelope it actually wrote.
 *
 * {@link recordingEmitter} captures renderer *arguments*, which cannot detect a
 * code the CLI emits but `ErrorCodeSchema` rejects — argument assertions pass
 * either way. This returns the parsed JSON document a `--schema`-validating
 * consumer receives, so the emitted code can be checked against the registry
 * that governs it.
 *
 * @param render - Renderer invocation under test.
 * @param command - CLI command name stamped onto the envelope.
 * @returns The parsed JSON envelope written to stdout.
 */
function emittedEnvelope(
  render: (output: OutputEmitter) => void,
  command = 'pass',
): Record<string, unknown> {
  const writer = new TestWriter();
  const output = new OutputEmitter({ writer, command });
  render(output);
  output.flush();
  return JSON.parse(writer.getStdout()) as Record<string, unknown>;
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

describe('renderClaimBearerMismatchRefusal', () => {
  it('emits CLAIM_BEARER_MISMATCH, names the command, and carries no details (#613)', () => {
    const { output, calls } = recordingEmitter();

    const exit = renderClaimBearerMismatchRefusal(output, 'pass');

    // Non-zero exit: a divergence is refused, never quietly applied.
    expect(exit).toBe(true);
    const err = calls.find((c) => c.method === 'error');
    expect(err?.args[1]).toBe('CLAIM_BEARER_MISMATCH');
    // Each clause of the remediation carries distinct information: what was
    // wrong, what the seam did instead of authorizing, and what to do.
    expect(err?.args[0]).toContain('is not the claim');
    expect(err?.args[0]).toContain('rundown pass');
    expect(err?.args[0]).toContain("under the target's authority");
    expect(err?.args[0]).toContain('Present the bearer');
    // No verified claim record exists at refusal time, so nothing is echoed —
    // a raw claimId here would put a bearer secret in output.
    expect(err?.args[2]).toBeUndefined();
    expect(JSON.stringify(err?.args)).not.toContain(CLAIM_SECRET);
  });

  it('is distinct from the actor-context refusal it replaces for this case (#613)', () => {
    const mismatch = recordingEmitter();
    const bare = recordingEmitter();

    renderClaimBearerMismatchRefusal(mismatch.output, 'stop');
    renderActorContextRequiredRefusal(bare.output, 'stop');

    const mismatchErr = mismatch.calls.find((c) => c.method === 'error');
    const bareErr = bare.calls.find((c) => c.method === 'error');
    expect(mismatchErr?.args[1]).not.toBe(bareErr?.args[1]);
    // The bare-form advice ("pass --claim-id") would misdiagnose a caller that
    // already presented one, so it must not appear here.
    expect(bareErr?.args[0]).toContain('--claim-id');
    expect(mismatchErr?.args[0]).not.toContain('Pass `--claim-id');
  });

  it('emits an envelope a schema-validating consumer accepts (#613)', () => {
    // The refusal is worthless if every `--schema` consumer rejects the envelope
    // that carries it. `CLAIM_BEARER_MISMATCH` must therefore be a registered
    // member of the closed `ErrorCodeSchema` enum, checked against the envelope
    // the emitter really writes rather than against the argument list.
    const envelope = emittedEnvelope((output) => {
      renderClaimBearerMismatchRefusal(output, 'pass');
    });

    expect(envelope.code).toBe('CLAIM_BEARER_MISMATCH');
    expect(validateSchema(ErrorCodeSchema, envelope.code)).toEqual({ valid: true, errors: [] });
    expect(validateSchema(ErrorResponseSchema, envelope)).toEqual({ valid: true, errors: [] });
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

describe('every refusal renderer emits a registered error code', () => {
  // `OutputEmitter.error` types its code parameter as plain `string`, so the
  // closed `ErrorCodeSchema` enum is not enforced at the emit site: an
  // unregistered code typechecks cleanly and only fails when a consumer
  // validates the envelope. #613's `CLAIM_BEARER_MISMATCH` shipped that way.
  // This sweep is the enforcement the type system does not provide, and it
  // covers every renderer rather than the one code that was missed.

  /**
   * One entry per exported renderer, listing an invocation for every distinct
   * code that renderer can emit. `renderStaleClaimRefusal` takes its code as a
   * parameter, so both `StaleClaimRefusalCode` members are driven.
   */
  const INVOCATIONS: Readonly<Record<string, readonly ((output: OutputEmitter) => void)[]>> = {
    renderStaleClaimRefusal: [
      (output) =>
        renderStaleClaimRefusal(output, 'Claimed runbook is gone.', 'CLAIMED_RUNBOOK_UNAVAILABLE'),
      (output) =>
        renderStaleClaimRefusal(output, 'Parent superseded the claim.', 'DELEGATION_SUPERSEDED'),
    ],
    renderActorContextRequiredRefusal: [
      (output) => renderActorContextRequiredRefusal(output, 'pass'),
      (output) => renderActorContextRequiredRefusal(output, 'collect', 'collecting delegated work'),
    ],
    renderClaimBearerMismatchRefusal: [
      (output) => renderClaimBearerMismatchRefusal(output, 'pass'),
    ],
    renderClaimGrantRequiredRefusal: [
      (output) => renderClaimGrantRequiredRefusal(output, 'collect'),
      (output) => renderClaimGrantRequiredRefusal(output, 'abort', { targetRunId: RUN_ID }),
    ],
    renderTerminalClaimConfirmed: [
      (output) => renderTerminalClaimConfirmed(output, 'complete', CLAIM_ID, 'completed'),
    ],
    renderTerminalClaimConflict: [
      (output) => renderTerminalClaimConflict(output, CLAIM_ID, 'completed', 'stopped'),
    ],
    renderRefusedTerminalCleanup: [
      (output) =>
        renderRefusedTerminalCleanup(output, RUN_ID, {
          kind: 'claim_rotated',
          claimKey: redactClaimId(CLAIM_ID),
        }),
      (output) =>
        renderRefusedTerminalCleanup(output, RUN_ID, {
          kind: 'determination_lost',
          runId: RUN_ID,
        }),
    ],
  };

  it('drives every renderer this module exports', () => {
    // Without this, a renderer added later would simply not be swept and the
    // guard would keep reporting green over an unchecked code.
    const exported = Object.entries(refusalRenderers)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);

    expect(Object.keys(INVOCATIONS).sort()).toEqual(exported.sort());
  });

  it('emits only codes ErrorCodeSchema accepts, in envelopes ErrorResponseSchema accepts', () => {
    const offenders: string[] = [];
    const seen: string[] = [];

    for (const [name, renders] of Object.entries(INVOCATIONS)) {
      renders.forEach((render, index) => {
        const envelope = emittedEnvelope(render);
        // Idempotent confirmations are `kind: 'action'` and carry no code —
        // nothing for the error registry to govern.
        if (envelope.kind !== 'error') return;

        seen.push(String(envelope.code));
        const code = validateSchema(ErrorCodeSchema, envelope.code);
        const response = validateSchema(ErrorResponseSchema, envelope);
        if (!code.valid || !response.valid) {
          offenders.push(
            `${name}[${String(index)}] emitted ${JSON.stringify(envelope.code)}: ${[...code.errors, ...response.errors].join('; ')}`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
    // Pins the codes the sweep actually observed, so a renderer that stops
    // emitting a code — or an emitter change that swallows it — fails here
    // instead of letting the registration check pass over an empty sweep.
    expect([...new Set(seen)].sort()).toEqual([
      'ACTOR_CONTEXT_REQUIRED',
      'CLAIMED_RUNBOOK_UNAVAILABLE',
      'CLAIM_BEARER_MISMATCH',
      'CLAIM_GRANT_REQUIRED',
      'DELEGATION_RESULT_CONFLICT',
      'DELEGATION_SUPERSEDED',
      'RUN_TARGET_UNAVAILABLE',
    ]);
  });
});
