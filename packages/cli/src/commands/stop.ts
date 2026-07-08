// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  withTransitionTargetOptions,
  parseTransitionTarget,
  transitionTargetFields,
} from '../helpers/transition-target.js';
import { runSeamTerminal, handleTerminalRecovery } from '../helpers/terminal-command.js';

/**
 * Registers the 'stop' command for aborting runbooks.
 *
 * The command is a thin front end: target resolution, policy gating, the inline
 * FORCE cascade, record-before-release child propagation, and retained-tombstone
 * release all live in the core `runTerminal` seam (via {@link runSeamTerminal}).
 * The only CLI-owned logic that survives is the recovery path for an unusable
 * persisted snapshot (Category A), which only surfaces when the machine
 * rehydrates inside the seam.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerStopCommand(program: Command): void {
  withTransitionTargetOptions(
    program
      .command('stop')
      .description('Abort current runbook')
      .argument('[message]', 'Stop message'),
  )
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        message: string | undefined,
        options: { claimId?: string; run?: string; text?: boolean },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'stop' });
            const cwd = getCwd();
            const target = parseTransitionTarget(options, output);
            if (!target) return;
            const targetFields = transitionTargetFields(target);

            try {
              const { exitError } = await runSeamTerminal(output, cwd, 'stop', {
                ...targetFields,
                ...(message !== undefined ? { message } : {}),
              });
              if (exitError) process.exitCode = 1;
            } catch (error: unknown) {
              await handleTerminalRecovery('stop', error, output, cwd, {
                ...targetFields,
              });
            }
          },
          { text: options.text },
        );
      },
    );
}
