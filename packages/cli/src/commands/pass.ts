// packages/cli/src/commands/pass.ts

import type { Command } from 'commander';
import { registerTransitionCommand } from '../helpers/transition-command.js';
import { createPassTransitionConfig } from '../helpers/transitions.js';

/** Aliases accepted for `rundown pass`. */
export const PASS_ALIASES = ['yes', 'ok'] as const;

/**
 * Registers the 'pass' command for marking steps as passed.
 *
 * Thin registration wrapper around {@link registerTransitionCommand}; the
 * shared transition-command body owns option parsing, token resolution,
 * transition execution and exit-code semantics so `pass` and `fail` stay in
 * lock-step.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerPassCommand(program: Command): void {
  registerTransitionCommand(program, {
    name: 'pass',
    aliases: PASS_ALIASES,
    description: 'Mark current step as passed (triggers PASS transition)',
    buildConfig: createPassTransitionConfig,
  });
}
