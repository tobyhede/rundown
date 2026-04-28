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
import { resolveCallerIdentity } from '../helpers/caller-identity.js';
import { resolveActiveRunbook } from '../helpers/active-runbook-resolver.js';

/**
 * Registers the 'status' command for displaying runbook state.
 * @param program - Commander program instance to register the command on
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current runbook state')
    .option('--text', 'Output as human-readable text')
    .action(async (options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text });

          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const active = await resolveActiveRunbook(sessionService, resolveCallerIdentity());
          const stashedId = await sessionService.getStashedRunbookId();

          switch (active.kind) {
            case 'owned':
            case 'default':
              output.detail(
                buildActiveStatus(active.state, cwd, stashedId ?? undefined) as unknown as Record<
                  string,
                  unknown
                >,
                'status',
              );
              output.flush();
              return;
            case 'none':
              break;
            case 'stale_owner':
            case 'invalid_identity':
              output.error(active.message, 'OWNED_RUNBOOK_UNAVAILABLE');
              output.flush();
              process.exitCode = 1;
              return;
            default: {
              const _exhaustive: never = active;
              return _exhaustive;
            }
          }

          // Case 1: No active runbook and nothing stashed
          if (!stashedId) {
            output.detail(buildInactiveStatus() as unknown as Record<string, unknown>, 'status');
            output.flush();
            return;
          }

          // Case 2: Something stashed but nothing active
          const stashed = await manager.load(stashedId);
          if (stashed) {
            output.detail(
              buildStashedStatus(stashed, cwd) as unknown as Record<string, unknown>,
              'status',
            );
            output.flush();
            return;
          }
          // Stale stash reference — treat as inactive
          output.detail(buildInactiveStatus() as unknown as Record<string, unknown>, 'status');
          output.flush();
        },
        { text: options.text },
      );
    });
}
