// packages/cli/src/commands/status.ts

import type { Command } from 'commander';
import {
  classifyExecutionLease,
  currentInlineReservation,
  delegationChildrenStatus,
  delegationsHeldBy,
  RunbookStateManager,
  type CurrentChildStatus,
} from '@rundown-org/core';
import { getProjectRoot } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildParentStatus,
  buildRunListStatus,
  buildRunStatus,
} from '../helpers/status-builder.js';
import { parseRunOption } from '../helpers/run-option.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';

/**
 * Registers the 'status' command for displaying run state.
 *
 * Bare `rundown status` lists every persisted run (id, runbook, lifecycle,
 * position); `--run <id>` shows one run in detail. A run whose step holds the
 * execution lease carries `execution` (In Progress or Interrupted, classified
 * by core). `--claimed-by <agent-id>` lists the Delegations that still hold
 * that agent — running, claimed under its id, and counted by their parent, as
 * core decides — which the plugin's SubagentStop gate reads (#907). Status is
 * read-only and never renders an Owner Token or Claim Ticket.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show run state (all runs, or one run with --run)')
    .option('--run <runId>', 'Show one run in detail')
    .option(
      '--claimed-by <agent-id>',
      'List the delegated children this agent claimed that are still running and counted',
    )
    .option('--text', 'Output as human-readable text')
    .action(async (options: { run?: string; claimedBy?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getProjectRoot();
          const output = new OutputEmitter({ text: options.text, command: 'status' });
          const run = parseRunOption(options.run, output);
          if (!run.ok) return;

          const manager = new RunbookStateManager(cwd);

          if (options.claimedBy !== undefined) {
            const refusal =
              options.run !== undefined
                ? '--claimed-by cannot be combined with --run.'
                : options.claimedBy.trim() === ''
                  ? '--claimed-by must not be empty.'
                  : undefined;
            if (refusal !== undefined) {
              output.error(refusal, 'INVALID_SYNTAX');
              output.flush();
              process.exitCode = 1;
              return;
            }
            const delegations = await delegationsHeldBy(
              { manager, loadSteps: (state) => getRunbookFromState(state, cwd) },
              options.claimedBy,
            );
            output.detail(
              { kind: 'claimed_delegations', agentId: options.claimedBy, delegations },
              'custom',
            );
            output.flush();
            return;
          }

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
              loaded.lease === null
                ? undefined
                : classifyExecutionLease(loaded.state.id, loaded.lease);
            // The chain around this run (#903, #904): its parent, and the
            // Current Children its step counts. Run ids, lifecycles and
            // results only — never a Claim Ticket.
            const parent = buildParentStatus(loaded.linkage);
            const reservation = currentInlineReservation(loaded.state);
            let child: CurrentChildStatus | undefined;
            if (reservation !== undefined) {
              const childState = await manager.load(reservation.runId);
              child = {
                runId: reservation.runId,
                kind: reservation.kind,
                status: childState === null ? 'reserved' : (childState.lifecycle ?? 'running'),
              };
            }
            const children = await delegationChildrenStatus(manager, loaded.state);
            output.detail(
              buildRunStatus(loaded.state, cwd, condition, {
                ...(parent !== undefined ? { parent } : {}),
                ...(child !== undefined ? { child } : {}),
                children,
              }) as unknown as Record<string, unknown>,
              'status',
            );
            output.flush();
            return;
          }

          // One read: each run's state and lease come from the same snapshot.
          const runs = await manager.listWithVersion();
          const states = runs.map((listed) => listed.state);
          const conditions = new Map(
            runs.flatMap((listed) =>
              listed.lease === null
                ? []
                : [
                    [
                      listed.state.id as string,
                      classifyExecutionLease(listed.state.id, listed.lease),
                    ] as const,
                  ],
            ),
          );
          const parents = new Map(
            runs.flatMap((listed) => {
              const parent = buildParentStatus(listed.linkage);
              return parent === undefined ? [] : [[listed.state.id, parent] as const];
            }),
          );
          output.detail(
            buildRunListStatus(states, conditions, parents) as unknown as Record<string, unknown>,
            'status',
          );
          output.flush();
        },
        { text: options.text },
      );
    });
}
