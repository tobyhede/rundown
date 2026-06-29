import { describe, it, expect } from '@jest/globals';
import { Command, type Option } from 'commander';
import { PASS_FAIL_VALUE_TAKING_OPTION_NAMES } from '@rundown-org/core';
import { registerPassCommand } from '../../src/commands/pass.js';
import { registerFailCommand } from '../../src/commands/fail.js';

// Single-source-of-truth invariant for the pass/fail VALUE-TAKING option surface.
//
// The subprocess trust boundary (`@rundown-org/core`
// subprocess-mutation-boundary) scans pass/fail argv for claim evidence and must
// skip the value token consumed by each value-taking option (`--step <v>`,
// `--index <v>`, `--claim-id <v>`). If the CLI grows a new value-taking pass/fail
// option (e.g. `--note <text>`) without the boundary learning it consumes a
// value, an attacker can smuggle `--claim-id=x` into that option's value slot and
// the scanner mis-reads it as real claim evidence — laundering direct-CLI trust
// past the gate. The boundary set is therefore the single source of truth; the
// CLI registration DERIVES from it. These tests pin that they cannot drift: a
// value-taking option registered on `pass`/`fail` that the core list does not
// know about (or vice versa) fails the build — fail-closed on drift.

/** Long names of the value-taking options commander registered on a command. */
function registeredValueTakingOptionLongs(register: (program: Command) => void): string[] {
  const program = new Command();
  register(program);
  const command = program.commands.find((c) => c.name() === program.commands[0]?.name());
  if (!command) throw new Error('expected a subcommand to be registered');
  return command.options
    .filter((option: Option) => option.required || option.optional)
    .map((option: Option) => option.long)
    .filter((long): long is string => long !== undefined)
    .sort();
}

describe('pass/fail value-taking option single source of truth', () => {
  const expected = [...PASS_FAIL_VALUE_TAKING_OPTION_NAMES].sort();

  it('registers exactly the boundary-known value-taking options on `pass`', () => {
    expect(registeredValueTakingOptionLongs(registerPassCommand)).toEqual(expected);
  });

  it('registers exactly the boundary-known value-taking options on `fail`', () => {
    expect(registeredValueTakingOptionLongs(registerFailCommand)).toEqual(expected);
  });
});
