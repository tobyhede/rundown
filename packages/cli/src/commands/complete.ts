// packages/cli/src/commands/complete.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseClaimCapabilityOption } from '../helpers/claim-capability-option.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { parseRunCapabilityOption } from '../helpers/run-capability-option.js';
import { parseRunOption } from '../helpers/run-option.js';
import { runSeamTerminal, handleTerminalRecovery } from '../helpers/terminal-command.js';

/**
 * Registers the 'complete' command for manually completing runbooks.
 *
 * Note: Runbooks auto-complete when the final step's PASS transition executes.
 * This command is for forcing early completion from any step, bypassing
 * remaining steps. Use cases include:
 * - Early exit when remaining steps are unnecessary
 * - Agent-driven completion where manual override is needed
 * - Testing/debugging runbook execution
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
export function registerCompleteCommand(program: Command): void {
  program
    .command('complete')
    .description('Force early completion of current runbook (runbooks auto-complete on final step)')
    .argument('[message]', 'Completion message')
    .option('--claim-id <claimId>', 'Legacy claim id; mutations require --claim-capability')
    .option('--claim-capability <capability>', 'Prove authority over a claimed delegated child')
    .option('--run-capability <capability>', 'Prove orchestrator authority over a run')
    .option('--run <runId>', 'Name the run you control (explicit orchestrator targeting)')
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        message: string | undefined,
        options: {
          claimId?: string;
          claimCapability?: string;
          runCapability?: string;
          run?: string;
          text?: boolean;
        },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'complete' });
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
            const runCapabilityTarget = parseRunCapabilityOption(
              options.runCapability,
              claimCapabilityTarget.claimCapability,
              output,
            );
            if (!runCapabilityTarget.ok) return;
            const runTarget = parseRunOption(
              options.run,
              claimTarget.claimId,
              output,
              claimCapabilityTarget.claimCapability,
              runCapabilityTarget.runCapability,
            );
            if (!runTarget.ok) return;

            try {
              const { exitError } = await runSeamTerminal(output, cwd, 'complete', {
                ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
                ...(claimCapabilityTarget.claimCapability
                  ? { claimCapability: claimCapabilityTarget.claimCapability }
                  : {}),
                ...(runCapabilityTarget.runCapability
                  ? { runCapability: runCapabilityTarget.runCapability }
                  : {}),
                ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
                ...(message !== undefined ? { message } : {}),
              });
              if (exitError) process.exitCode = 1;
            } catch (error: unknown) {
              await handleTerminalRecovery('complete', error, output, cwd, {
                ...(claimTarget.claimId ? { claimId: claimTarget.claimId } : {}),
                ...(claimCapabilityTarget.claimCapability
                  ? { claimCapability: claimCapabilityTarget.claimCapability }
                  : {}),
                ...(runCapabilityTarget.runCapability
                  ? { runCapability: runCapabilityTarget.runCapability }
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
