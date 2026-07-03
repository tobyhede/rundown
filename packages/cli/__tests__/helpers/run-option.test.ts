import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { assertClaimId } from '@rundown-org/core';
import { parseRunOption } from '../../src/helpers/run-option.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';

const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');

function makeOutput(): {
  output: OutputEmitter;
  errorSpy: jest.SpiedFunction<OutputEmitter['error']>;
} {
  const output = new OutputEmitter({ command: 'pass' });
  const errorSpy = jest.spyOn(output, 'error');
  jest.spyOn(output, 'flush').mockImplementation(() => {});
  return { output, errorSpy };
}

describe('parseRunOption', () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = previousExitCode;
    jest.restoreAllMocks();
  });

  it('returns ok with no runId when --run is absent', () => {
    const { output } = makeOutput();
    expect(parseRunOption(undefined, undefined, output)).toEqual({ ok: true });
  });

  it('accepts a well-formed run id', () => {
    const { output } = makeOutput();
    const result = parseRunOption(`rd_${'a'.repeat(32)}`, undefined, output);
    expect(result).toEqual({ ok: true, runId: `rd_${'a'.repeat(32)}` });
  });

  it('rejects a malformed run id with INVALID_RUN_ID', () => {
    const { output, errorSpy } = makeOutput();
    const result = parseRunOption('not-a-run-id', undefined, output);
    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), 'INVALID_RUN_ID');
  });

  it('rejects --run combined with --claim-id as INVALID_SYNTAX (mutually exclusive)', () => {
    // An orchestrator names its own run; a child names its claim — never both.
    const { output, errorSpy } = makeOutput();
    const result = parseRunOption(`rd_${'a'.repeat(32)}`, claimId, output);
    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), 'INVALID_SYNTAX');
  });
});
