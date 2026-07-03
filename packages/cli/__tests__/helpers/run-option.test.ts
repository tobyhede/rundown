import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { assertClaimId } from '@rundown-org/core';
import { Command } from 'commander';
import { parseRunOption } from '../../src/helpers/run-option.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';
import { registerPassCommand } from '../../src/commands/pass.js';
import { registerFailCommand } from '../../src/commands/fail.js';
import { registerCompleteCommand } from '../../src/commands/complete.js';
import { registerStopCommand } from '../../src/commands/stop.js';
import { registerCollectCommand } from '../../src/commands/collect.js';
import { registerDelegateCommand } from '../../src/commands/delegate.js';
import { registerGotoCommand } from '../../src/commands/goto.js';

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

describe('--run registration drift guard', () => {
  // pass/fail derive --run from the single-source PASS_FAIL_VALUE_TAKING_OPTION_NAMES
  // mechanism; the other mutating commands register it manually. This guard
  // pins every mutating command in the subprocess withhold set (plus goto) to a
  // --run Commander option so a future command cannot silently miss the flag.
  const registrations: ReadonlyArray<{
    readonly name: string;
    readonly register: (program: Command) => void;
  }> = [
    { name: 'pass', register: registerPassCommand },
    { name: 'fail', register: registerFailCommand },
    { name: 'complete', register: registerCompleteCommand },
    { name: 'stop', register: registerStopCommand },
    { name: 'collect', register: registerCollectCommand },
    { name: 'delegate', register: registerDelegateCommand },
    { name: 'goto', register: registerGotoCommand },
  ];

  it.each(registrations)('registers --run on $name', ({ name, register }) => {
    const program = new Command();
    register(program);
    const command = program.commands.find((c) => c.name() === name);
    expect(command).toBeDefined();
    const runOption = command!.options.find((o) => o.long === '--run');
    expect(runOption).toBeDefined();
  });
});
