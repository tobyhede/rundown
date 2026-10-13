import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { Command } from 'commander';
import { parseRunOption } from '../../src/helpers/run-option.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';
import { registerPassCommand } from '../../src/commands/pass.js';
import { registerFailCommand } from '../../src/commands/fail.js';
import { registerCompleteCommand } from '../../src/commands/complete.js';
import { registerStopCommand } from '../../src/commands/stop.js';
import { registerStatusCommand } from '../../src/commands/status.js';
import { registerGotoCommand } from '../../src/commands/goto.js';
import { takeExitCode } from './exit-code.js';

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
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns ok with no runId when --run is absent', () => {
    const { output } = makeOutput();
    expect(parseRunOption(undefined, output)).toEqual({ ok: true });
  });

  it('accepts a well-formed run id', () => {
    const { output } = makeOutput();
    const result = parseRunOption(`rd_${'a'.repeat(32)}`, output);
    expect(result).toEqual({ ok: true, runId: `rd_${'a'.repeat(32)}` });
  });

  it('rejects a malformed run id with INVALID_RUN_ID', () => {
    const { output, errorSpy } = makeOutput();
    const result = parseRunOption('not-a-run-id', output);
    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), 'INVALID_RUN_ID');
    // Signalling failure via `process.exitCode` is the parser's contract; consume it.
    expect(takeExitCode()).toBe(1);
  });
});

describe('--run registration drift guard', () => {
  // One writer per run (ADR 0005): `--run` is a read-only selector. `status`
  // advertises it; every mutating command registers it HIDDEN so the
  // `--run`+`--token` combination is refused with the documented
  // `INVALID_SYNTAX` envelope instead of Commander's plain-text usage error.
  const mutating: ReadonlyArray<{
    readonly name: string;
    readonly register: (program: Command) => void;
  }> = [
    { name: 'pass', register: registerPassCommand },
    { name: 'fail', register: registerFailCommand },
    { name: 'complete', register: registerCompleteCommand },
    { name: 'stop', register: registerStopCommand },
    { name: 'goto', register: registerGotoCommand },
  ];

  it.each(mutating)('registers a hidden --run on $name', ({ name, register }) => {
    const program = new Command();
    register(program);
    const command = program.commands.find((c) => c.name() === name);
    expect(command).toBeDefined();
    const runOption = command!.options.find((o) => o.long === '--run');
    expect(runOption).toBeDefined();
    expect(runOption!.hidden).toBe(true);
  });

  it('advertises --run on status and never --token', () => {
    const program = new Command();
    registerStatusCommand(program);
    const command = program.commands.find((c) => c.name() === 'status');
    expect(command).toBeDefined();
    const runOption = command!.options.find((o) => o.long === '--run');
    expect(runOption).toBeDefined();
    expect(runOption!.hidden).toBe(false);
    expect(command!.options.find((o) => o.long === '--token')).toBeUndefined();
  });
});
