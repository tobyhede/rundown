// packages/cli/src/helpers/transition-command.ts

import type { Command } from 'commander';
import { getProjectRoot } from './context.js';
import { withErrorHandling } from './wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { commandStreamOptionsForOutputMode } from '../services/execution.js';
import { runSeamTransition, type TransitionConfig } from './transitions.js';
import { validateIndexRequiresStep } from './index-option.js';
import { parseTokenOption, withTokenOption } from './token-option.js';

/**
 * Definition for a transition command (pass / fail).
 *
 * Both `rd pass` and `rd fail` share an identical end-to-end flow — option
 * parsing, token resolution, transition execution, progression and exit-code
 * assignment. The only differences are a handful of labels and the
 * transition-config factory. Capturing those differences in this struct lets
 * the registration helper own the shared body in one place.
 */
export interface TransitionCommandDef {
  /** Command name as registered with commander ('pass' or 'fail'). */
  readonly name: 'pass' | 'fail';
  /** Aliases for the command (e.g. ['yes', 'ok'] for pass, ['no'] for fail). */
  readonly aliases: readonly string[];
  /** Description shown in `--help`. */
  readonly description: string;
  /** Factory producing the transition config — invoked per action call. */
  readonly buildConfig: () => TransitionConfig;
}

/**
 * Register a transition command (pass/fail) on the commander program.
 *
 * Options: `--token <token>` (required — the Owner Token from
 * `runbook_started`), `--step <stepId>` (required by core; it must name the
 * run's current position), `--index <number>` (the current FOR iteration) and
 * `--text`. A bare `--run` is never accepted here: a run id is a read-only
 * selector, not mutation authority.
 *
 * @param program - Commander program instance to register the command on
 * @param def - Per-command definition supplying name, aliases, description
 *   and the transition-config factory
 */
export function registerTransitionCommand(program: Command, def: TransitionCommandDef): void {
  withTokenOption(
    program
      .command(def.name)
      .aliases([...def.aliases])
      .description(def.description),
  )
    .option('--step <stepId>', 'Current step or substep position (required, e.g. 2 or 2.1)')
    .option('--index <number>', 'Current FOR loop iteration (requires --step)')
    .option('--text', 'Output as human-readable text')
    .action(
      async (options: {
        token?: string;
        run?: string;
        step?: string;
        index?: string;
        text?: boolean;
      }) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: def.name });

            const depError = validateIndexRequiresStep(options.index, options.step);
            if (depError) {
              output.error(depError, 'INVALID_SYNTAX');
              output.flush();
              process.exit(1);
            }

            const token = parseTokenOption(options, def.name, output);
            if (token === undefined) return;

            const cwd = getProjectRoot();
            const config = def.buildConfig();

            // Core owns token resolution, the `--step` contract, the machine
            // dispatch and the conditional save. The CLI keeps parsing,
            // rendering and exit mapping.
            const commandStreamOptions = commandStreamOptionsForOutputMode(options.text);
            const { exitError } = await runSeamTransition(output, cwd, config, {
              token,
              ...(options.step !== undefined ? { step: options.step } : {}),
              ...(options.index !== undefined ? { index: options.index } : {}),
              commandStreamOptions,
            });

            if (exitError) {
              process.exitCode = 1;
            } else {
              // Clear any non-zero code set earlier in this command: a handled
              // failure (FAIL ANY CONTINUE) must exit 0.
              process.exitCode = undefined;
            }
          },
          { text: options.text },
        );
      },
    );
}
