// packages/cli/src/commands/stash.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService } from '@rundown-org/core';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { resolveActiveRunbook } from '../helpers/active-runbook-resolver.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';

/**
 * Registers the 'stash' command for pausing runbook enforcement.
 * @param program - Commander program instance to register the command on
 */
export function registerStashCommand(program: Command): void {
  program
    .command('stash')
    .description('Pause runbook enforcement, preserve state')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (options: { claimId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text, command: 'stash' });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;
          const active = await resolveActiveRunbook(sessionService, {
            claimId: claimTarget.claimId,
          });

          switch (active.kind) {
            case 'claim':
            case 'default':
              break;
            case 'none':
              output.noActiveRunbook();
              output.flush();
              return;
            case 'stale_claim':
              output.error(active.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
              output.flush();
              process.exitCode = 1;
              return;
            default: {
              const _exhaustive: never = active;
              return _exhaustive;
            }
          }
          const state = active.state;

          const totalSteps = await getStepTotal(cwd, state.runbook);

          // Stash the runbook
          const stashedId = await sessionService.stashRunbook(state.id);
          if (!stashedId) {
            output.error('A runbook is already stashed. Pop it first.', 'ALREADY_STASHED');
            output.flush();
            process.exitCode = 1;
            return;
          }

          // Emit structured output - TextRenderer handles stash action specially
          output.metadata(buildMetadata(state));
          output.status('stash', 'Runbook stashed', {
            position: {
              current: state.step,
              total: totalSteps,
            },
            stashedId,
          });
          output.flush();
        },
        { text: options.text },
      );
    });
}
