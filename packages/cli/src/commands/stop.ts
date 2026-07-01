// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  InvalidRunbookStateError,
  isError,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  cleanupOrphanedActiveStack,
  isRecoverableActiveStackError,
} from '../helpers/active-runbook-cleanup.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { runSeamTerminal } from '../helpers/terminal-command.js';

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
  program
    .command('stop')
    .description('Abort current runbook')
    .argument('[message]', 'Stop message')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (message: string | undefined, options: { claimId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'stop' });
          const cwd = getCwd();
          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;

          try {
            const { exitError } = await runSeamTerminal(output, cwd, 'stop', {
              ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
              ...(message !== undefined ? { message } : {}),
            });
            if (exitError) process.exitCode = 1;
          } catch (error: unknown) {
            await handleStopRecovery(error, output, cwd, claimTarget.claimId);
          }
        },
        { text: options.text },
      );
    });
}

/**
 * Recover from an unusable persisted snapshot surfaced during a `stop` command.
 *
 * The bare path attempts orphan cleanup (a Category-A recovery) and reports a
 * clean removal; the claim path treats the same failure as no active runbook (a
 * claimed child that is no longer usable is nothing to stop). Any other error is
 * rethrown for the outer `withErrorHandling` to render.
 *
 * @param error - The error thrown by the seam.
 * @param output - Output emitter for the recovery message.
 * @param cwd - Current working directory (used to build the cleanup manager).
 * @param claimId - Explicit claim id when the command targeted a claimed child.
 * @throws {unknown} Rethrows any error that is not a recoverable snapshot failure.
 */
async function handleStopRecovery(
  error: unknown,
  output: OutputEmitter,
  cwd: string,
  claimId: string | undefined,
): Promise<void> {
  // Claim path: orphan cleanup (a bare-command recovery) never applies to a
  // claim target, so an unusable snapshot is reported as no active runbook.
  if (claimId !== undefined) {
    if (error instanceof InvalidRunbookStateError) {
      output.noActiveRunbook('stop');
      output.flush();
      return;
    }
    throw error;
  }

  if (
    error instanceof InvalidRunbookStateError ||
    (isError(error) && isRecoverableActiveStackError(error))
  ) {
    const manager = new RunbookStateManager(cwd);
    const sessionService = new SessionService(manager);
    const orphanId = await cleanupOrphanedActiveStack(manager, sessionService);
    if (orphanId) {
      output.stopped('Removed unusable runbook state from session');
      output.flush();
      return;
    }
  }
  throw error;
}
