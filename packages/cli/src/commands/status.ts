// packages/cli/src/commands/status.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildInactiveStatus,
  buildStashedStatus,
  buildActiveStatus,
} from '../helpers/status-builder.js';

/**
 * Registers the 'status' command for displaying runbook state.
 * @param program - Commander program instance to register the command on
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current runbook state')
    .option('--agent <agentId>', 'Show status for agent-specific runbook')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const output = new OutputEmitter({ json: options.json });

        const manager = new RunbookStateManager(cwd);
        const sessionService = new SessionService(manager);
        const state = await sessionService.getActive(options.agent);
        const stashedId = await sessionService.getStashedRunbookId();

        // Case 1: No active runbook and nothing stashed
        if (!state && !stashedId) {
          output.detail(buildInactiveStatus(), 'status');
          output.flush();
          return;
        }

        // Case 2: Something stashed but nothing active
        if (stashedId && !state) {
          const stashed = await manager.load(stashedId);
          if (stashed) {
            output.detail(buildStashedStatus(stashed, cwd), 'status');
            output.flush();
          }
          return;
        }

        // Early exit if no state (shouldn't happen, but defensive)
        if (!state) {
          output.flush();
          return;
        }

        // Case 3: Active runbook
        output.detail(buildActiveStatus(state, cwd, stashedId ?? undefined), 'status');
        output.flush();
      });
    });
}
