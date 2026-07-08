import { describe, it, expect } from '@jest/globals';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli.js';

// Structural invariant for the transition-target flag pair (`--claim-id` +
// `--run`). These two options are "which run, and by what authority" — one
// logical parameter. `pass`, `fail`, `goto`, `stop`, `complete`, `collect`, and
// `delegate` register the pair; every other mutating command that targets a run
// by claim only (`abort`, `status`, `pop`, `stash`) registers `--claim-id`
// WITHOUT `--run`, and read-only commands register neither. `--run` therefore
// appears on exactly the transition-target commands. If a new command grows a
// `--run` selector without routing through the shared parser, this test fails —
// turning "we deduplicated" into an enforced guarantee that the claim/run pair
// and its single parser cannot drift apart.

/** Canonical names of the commands that register the claim/run pair. */
const TRANSITION_TARGET_COMMANDS = new Set([
  'pass',
  'fail',
  'goto',
  'stop',
  'complete',
  'collect',
  'delegate',
]);

/** Long option names registered directly on a subcommand. */
function optionLongs(command: Command): Set<string> {
  return new Set(command.options.map((o) => o.long).filter((l): l is string => l !== undefined));
}

describe('transition-target flag pair single source of truth', () => {
  const program = createProgram();

  it('registers --run on exactly the transition-target commands', () => {
    const withRun = program.commands
      .filter((c) => optionLongs(c).has('--run'))
      .map((c) => c.name())
      .sort();
    expect(withRun).toEqual([...TRANSITION_TARGET_COMMANDS].sort());
  });

  it('registers --claim-id alongside --run on every transition-target command', () => {
    for (const command of program.commands) {
      if (!TRANSITION_TARGET_COMMANDS.has(command.name())) continue;
      const longs = optionLongs(command);
      expect(longs.has('--claim-id')).toBe(true);
      expect(longs.has('--run')).toBe(true);
    }
  });
});
