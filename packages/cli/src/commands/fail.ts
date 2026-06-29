// packages/cli/src/commands/fail.ts

import type { Command } from 'commander';
import { mutationCommandAliases } from '@rundown-org/core';
import { registerTransitionCommand } from '../helpers/transition-command.js';
import { createFailTransitionConfig } from '../helpers/transitions.js';

/**
 * Registers the 'fail' command for marking steps as failed.
 *
 * Thin registration wrapper around {@link registerTransitionCommand}; the
 * shared transition-command body owns option parsing, transition execution,
 * parent propagation, and exit-code semantics so `pass` and `fail` stay in
 * lock-step.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerFailCommand(program: Command): void {
  registerTransitionCommand(program, {
    name: 'fail',
    // Single source of truth: derived from core so the CLI alias surface and the
    // subprocess boundary's normalization cannot drift apart.
    aliases: mutationCommandAliases('fail'),
    description: 'Mark current step as failed (triggers FAIL transition)',
    buildConfig: createFailTransitionConfig,
    noActiveLabel: 'fail',
  });
}
