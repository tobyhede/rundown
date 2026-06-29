// packages/cli/src/commands/pass.ts

import type { Command } from 'commander';
import { mutationCommandAliases } from '@rundown-org/core';
import { registerTransitionCommand } from '../helpers/transition-command.js';
import { createPassTransitionConfig } from '../helpers/transitions.js';

/**
 * Registers the 'pass' command for marking steps as passed.
 *
 * Thin registration wrapper around {@link registerTransitionCommand}; the
 * shared transition-command body owns option parsing, transition execution,
 * parent propagation, and exit-code semantics so `pass` and `fail` stay in
 * lock-step.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerPassCommand(program: Command): void {
  registerTransitionCommand(program, {
    name: 'pass',
    // Single source of truth: the subprocess boundary normalizes these aliases
    // to `pass`, so deriving them here keeps the CLI surface and the security
    // gate in lock-step (see mutationCommandAliases in @rundown-org/core).
    aliases: mutationCommandAliases('pass'),
    description: 'Mark current step as passed (triggers PASS transition)',
    buildConfig: createPassTransitionConfig,
    noActiveLabel: 'pass',
  });
}
