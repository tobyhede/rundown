import { describe, it, expect } from '@jest/globals';
import { Command, type Option } from 'commander';
import { registerPassCommand } from '../../src/commands/pass.js';
import { registerFailCommand } from '../../src/commands/fail.js';
import { registerGotoCommand } from '../../src/commands/goto.js';
import { registerStopCommand } from '../../src/commands/stop.js';
import { registerCompleteCommand } from '../../src/commands/complete.js';
import { registerStatusCommand } from '../../src/commands/status.js';

function registeredValueTakingOptionLongs(register: (program: Command) => void): string[] {
  const program = new Command();
  register(program);
  const command = program.commands.at(0);
  if (!command) throw new Error('expected a subcommand to be registered');
  return command.options
    .filter((option: Option) => option.required || option.optional)
    .map((option: Option) => option.long)
    .filter((long): long is string => long !== undefined)
    .sort();
}

function hiddenOptionLongs(register: (program: Command) => void): string[] {
  const program = new Command();
  register(program);
  const command = program.commands.at(0);
  if (!command) throw new Error('expected a subcommand to be registered');
  return command.options
    .filter((option: Option) => option.hidden)
    .map((option: Option) => option.long)
    .filter((long): long is string => long !== undefined)
    .sort();
}

/**
 * One writer per run (ADR 0005): every mutating command takes exactly the
 * same authority option, `--token`, and never advertises `--run`. `--run` is
 * registered hidden so the combination is refused with the documented
 * `INVALID_SYNTAX` envelope rather than Commander's plain-text usage error.
 */
describe('mutating-command option surface', () => {
  it('pass and fail take --token, --step and --index (and hidden --run)', () => {
    for (const register of [registerPassCommand, registerFailCommand]) {
      expect(registeredValueTakingOptionLongs(register)).toEqual([
        '--index',
        '--run',
        '--step',
        '--token',
      ]);
      expect(hiddenOptionLongs(register)).toEqual(['--run']);
    }
  });

  it('goto takes --token and --index (and hidden --run)', () => {
    expect(registeredValueTakingOptionLongs(registerGotoCommand)).toEqual([
      '--index',
      '--run',
      '--token',
    ]);
    expect(hiddenOptionLongs(registerGotoCommand)).toEqual(['--run']);
  });

  it('stop and complete take only --token and --run, hidden on complete', () => {
    for (const register of [registerStopCommand, registerCompleteCommand]) {
      expect(registeredValueTakingOptionLongs(register)).toEqual(['--run', '--token']);
    }
    expect(hiddenOptionLongs(registerCompleteCommand)).toEqual(['--run']);
    // stop's --run is the human escape hatch (#906), so it is advertised.
    expect(hiddenOptionLongs(registerStopCommand)).toEqual([]);
  });

  it('status is read-only: --run and --claimed-by (#907), never --token', () => {
    expect(registeredValueTakingOptionLongs(registerStatusCommand)).toEqual([
      '--claimed-by',
      '--run',
    ]);
    expect(hiddenOptionLongs(registerStatusCommand)).toEqual([]);
  });
});
