// packages/cli/src/commands/fail.ts

import type { Command } from 'commander';
import { registerTransitionCommand } from '../helpers/transition-command.js';
import { createFailTransitionConfig } from '../helpers/transitions.js';

/** Aliases accepted for `rundown fail`. */
export const FAIL_ALIASES = ['no'] as const;

/**
 * Registers the 'fail' command for marking steps as failed.
 *
 * Thin registration wrapper around {@link registerTransitionCommand}; the
 * shared transition-command body owns option parsing, token resolution,
 * transition execution and exit-code semantics so `pass` and `fail` stay in
 * lock-step.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerFailCommand(program: Command): void {
  registerTransitionCommand(program, {
    name: 'fail',
    aliases: FAIL_ALIASES,
    description: 'Mark current step as failed (triggers FAIL transition)',
    buildConfig: createFailTransitionConfig,
  });
}
