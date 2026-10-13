// packages/cli/src/commands/status.ts

import type { Command } from 'commander';
import { RunbookStateManager } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { buildRunListStatus, buildRunStatus } from '../helpers/status-builder.js';
import { parseRunOption } from '../helpers/run-option.js';

/**
 * Registers the 'status' command for displaying run state.
 *
 * Bare `rundown status` lists every persisted run (id, runbook, lifecycle,
 * position); `--run <id>` shows one run in detail. Status is read-only and
 * never renders an Owner Token.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show run state (all runs, or one run with --run)')
    .option('--run <runId>', 'Show one run in detail')
    .option('--text', 'Output as human-readable text')
    .action(async (options: { run?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text, command: 'status' });
          const run = parseRunOption(options.run, output);
          if (!run.ok) return;

          const manager = new RunbookStateManager(cwd);

          if (run.runId !== undefined) {
            const state = await manager.load(run.runId);
            if (!state) {
              output.error(`Run ${run.runId} not found.`, 'RUN_TARGET_UNAVAILABLE', {
                runId: run.runId,
              });
              output.flush();
              process.exitCode = 1;
              return;
            }
            output.detail(
              buildRunStatus(state, cwd) as unknown as Record<string, unknown>,
              'status',
            );
            output.flush();
            return;
          }

          const states = await manager.list();
          output.detail(buildRunListStatus(states) as unknown as Record<string, unknown>, 'status');
          output.flush();
        },
        { text: options.text },
      );
    });
}
