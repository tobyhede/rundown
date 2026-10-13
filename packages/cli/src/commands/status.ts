// packages/cli/src/commands/status.ts

import type { Command } from 'commander';
import { classifyExecutionLease, RunbookStateManager } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { buildRunListStatus, buildRunStatus } from '../helpers/status-builder.js';
import { parseRunOption } from '../helpers/run-option.js';

/**
 * Registers the 'status' command for displaying run state.
 *
 * Bare `rundown status` lists every persisted run (id, runbook, lifecycle,
 * position); `--run <id>` shows one run in detail. A run whose step holds the
 * execution lease carries `execution` (In Progress or Interrupted, classified
 * by core). Status is read-only and never renders an Owner Token.
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
            const loaded = await manager.loadWithVersion(run.runId);
            if (!loaded) {
              output.error(`Run ${run.runId} not found.`, 'RUN_TARGET_UNAVAILABLE', {
                runId: run.runId,
              });
              output.flush();
              process.exitCode = 1;
              return;
            }
            const condition =
              loaded.lease === null ? undefined : classifyExecutionLease(loaded.lease);
            output.detail(
              buildRunStatus(loaded.state, cwd, condition) as unknown as Record<string, unknown>,
              'status',
            );
            output.flush();
            return;
          }

          const states = await manager.list();
          const conditions = new Map(
            [...(await manager.listExecutionLeases())].map(([id, lease]) => [
              id as string,
              classifyExecutionLease(lease),
            ]),
          );
          output.detail(
            buildRunListStatus(states, conditions) as unknown as Record<string, unknown>,
            'status',
          );
          output.flush();
        },
        { text: options.text },
      );
    });
}
