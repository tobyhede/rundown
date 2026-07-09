import { describe, it, expect } from '@jest/globals';
import { Command, type Option } from 'commander';
import {
  SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS,
  type RoleSpecificMutationCommand,
} from '@rundown-org/core';
import { registerPassCommand } from '../../src/commands/pass.js';
import { registerFailCommand } from '../../src/commands/fail.js';
import { registerDelegateCommand } from '../../src/commands/delegate.js';
import { registerGotoCommand } from '../../src/commands/goto.js';
import { registerCompleteCommand } from '../../src/commands/complete.js';
import { registerStopCommand } from '../../src/commands/stop.js';
import { registerCollectCommand } from '../../src/commands/collect.js';

// Single-source-of-truth invariant for the VALUE-TAKING option surface of every
// command the subprocess trust boundary scans.
//
// `carriesClaimEvidence` (@rundown-org/core subprocess-mutation-boundary) walks a
// spawned mutation command's argv looking for `--claim-id` evidence, skipping the
// value token consumed by each value-taking option. It skips using a single set:
// SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS. If a scanned command grows a new
// value-taking option (e.g. `delegate --note <text>`) that the set does not know
// about, the scanner stops skipping that option's value — and an attacker can
// smuggle `--claim-id=x` into the value slot (`delegate --note --claim-id=x`).
// The scanner then mis-reads it as real claim evidence and FAILS OPEN, letting a
// bare delegate launder direct-CLI trust past the gate. That is exactly the bug
// that `--artifacts` / `--artifacts-json` caused before they were added.
//
// The boundary set is the single source of truth. These tests pin it to the real
// Commander surface in both directions — fail-closed on drift.
//
// `claim` is deliberately absent: it is not a RoleSpecificMutationCommand, so
// `canonicalMutationCommand` never resolves it and its argv is never scanned.

/**
 * Registrars for every command the boundary scans.
 *
 * Keyed by {@link RoleSpecificMutationCommand} so that adding a command to that
 * union fails to compile until it is wired into this guard — the guard cannot
 * silently fall out of step with the set of scanned commands.
 */
const MUTATION_COMMAND_REGISTRARS: Record<RoleSpecificMutationCommand, (program: Command) => void> =
  {
    pass: registerPassCommand,
    fail: registerFailCommand,
    delegate: registerDelegateCommand,
    goto: registerGotoCommand,
    complete: registerCompleteCommand,
    stop: registerStopCommand,
    collect: registerCollectCommand,
  };

/**
 * Long names of the value-taking options commander registered on a command.
 *
 * An option takes a value iff commander marked it `required` (`--foo <bar>`) or
 * `optional` (`--foo [bar]`); boolean flags have both false.
 */
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

const SCANNED_COMMANDS = Object.entries(MUTATION_COMMAND_REGISTRARS) as ReadonlyArray<
  [RoleSpecificMutationCommand, (program: Command) => void]
>;

describe('scanned mutation command value-taking option single source of truth', () => {
  // Security direction: a value-taking option the boundary does not know about is
  // an open claim-id smuggling slot. Asserted per command so a failure names the
  // offending command and option rather than diffing two anonymous arrays.
  it.each(
    SCANNED_COMMANDS,
  )('registers only boundary-known value-taking options on `%s`', (_command, register) => {
    const unknown = registeredValueTakingOptionLongs(register).filter(
      (long) => !SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS.has(long),
    );
    expect(unknown).toEqual([]);
  });

  // Rot direction: an entry no scanned command registers means the set has drifted
  // from the surface it claims to describe. Harmless to the scanner (over-skipping
  // fails closed) but it erodes the single-source-of-truth guarantee.
  it('contains no value-taking option that no scanned command registers', () => {
    const union = new Set(
      SCANNED_COMMANDS.flatMap(([, register]) => registeredValueTakingOptionLongs(register)),
    );
    expect([...union].sort()).toEqual([...SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS].sort());
  });
});
