// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseClaimCapabilityOption } from '../helpers/claim-capability-option.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { parseRunOption } from '../helpers/run-option.js';
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
  program
    .command('stop')
    .description('Abort current runbook')
    .argument('[message]', 'Stop message')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--claim-capability <capability>', 'Prove authority over a claimed delegated child')
    .option('--run <runId>', 'Name the run you control (explicit orchestrator targeting)')
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        message: string | undefined,
        options: { claimId?: string; claimCapability?: string; run?: string; text?: boolean },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'stop' });
            const cwd = getCwd();
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            if (claimTarget.claimId !== undefined) {
              output.error(
                'Claim id is not an authority credential. Use --claim-capability with the capability returned by rundown claim.',
                'CLAIM_CAPABILITY_REQUIRED',
              );
              output.flush();
              process.exitCode = 1;
              return;
            }
            const claimCapabilityTarget = parseClaimCapabilityOption(
              options.claimCapability,
              output,
            );
            if (!claimCapabilityTarget.ok) return;
            const runTarget = parseRunOption(
              options.run,
              claimTarget.claimId,
              output,
              claimCapabilityTarget.claimCapability,
            );
            if (!runTarget.ok) return;

            try {
              const { exitError } = await runSeamTerminal(output, cwd, 'stop', {
                ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
                ...(claimCapabilityTarget.claimCapability
                  ? { claimCapability: claimCapabilityTarget.claimCapability }
                  : {}),
                ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
                ...(message !== undefined ? { message } : {}),
              });
              if (exitError) process.exitCode = 1;
            } catch (error: unknown) {
              await handleTerminalRecovery('stop', error, output, cwd, {
                ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
                ...(claimCapabilityTarget.claimCapability
                  ? { claimCapability: claimCapabilityTarget.claimCapability }
                  : {}),
                ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
              });
            }
          },
          { text: options.text },
        );
      },
    );
}
