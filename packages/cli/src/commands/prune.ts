// packages/cli/src/commands/prune.ts

import type { Command } from 'commander';
import {
  CLIErrorCodes,
  CONCURRENT_MODIFICATION_CODE,
  RunbookStateManager,
  hashRunSecret,
  refuseUnderLease,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getStatus } from '../helpers/status.js';
import {
  TOKEN_OPTION_DESCRIPTION,
  UNKNOWN_TOKEN_MESSAGE,
  parseOptionalTokenOption,
  renderExecutionLeaseRefusal,
  withTokenOption,
} from '../helpers/token-option.js';

async function listAllRunIds(cwd: string): Promise<string[]> {
  // Must include runs whose persisted state is INVALID — they are precisely what
  // the invalid-state prune path exists to clear — so this reads raw ids rather
  // than `manager.list()`, which validates and silently skips them.
  const manager = new RunbookStateManager(cwd);
  return [...(await manager.listRunIds())];
}

interface PruneOptions {
  dryRun?: boolean;
  completed?: boolean;
  stopped?: boolean;
  active?: boolean;
  inactive?: boolean;
  all?: boolean;
  token?: string;
  run?: string;
  text?: boolean;
}

/** Reason a selected run was kept rather than deleted. */
const TOKEN_REQUIRED_REASON = 'token required';

/**
 * Registers the 'prune' command for removing run state.
 *
 * Finished runs (completed, stopped, abandoned) prune by lifecycle filter as
 * before. A RUNNING run is deleted only when `--token` names it — one run per
 * invocation, proven by its Owner Token. `--active` / `--all` without a token
 * skip running runs and report them retained with reason `token required`.
 * The token's run is subject to core's execution-lease rule for `prune`: In
 * Progress refuses the whole invocation `EXECUTION_IN_PROGRESS` with nothing
 * deleted; Interrupted lets the owner delete it.
 * Invalid persisted rows prune with `--inactive` / `--all`. `--token` is
 * parsed by the shared token option, so `--run` (a read-only selector) is
 * refused `INVALID_SYNTAX` here as on every other mutating command.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerPruneCommand(program: Command): void {
  withTokenOption(
    program.command('prune').description('Remove run state (does not delete runbook files)'),
    `${TOKEN_OPTION_DESCRIPTION}; deletes that one running run`,
  )
    .option('--dry-run', 'Show what would be removed without deleting')
    .option('--completed', 'Prune successfully completed run state')
    .option('--stopped', 'Prune stopped (aborted/failed) run state')
    .option('--active', 'Prune running run state (each running run needs its --token)')
    .option('--inactive', 'Prune invalid or abandoned run state')
    .option('--all', 'Prune all run state')
    .option('--text', 'Output as human-readable text')
    .action(async (options: PruneOptions) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text, command: 'prune' });

          const parsedToken = parseOptionalTokenOption(options, 'prune', output);
          if (parsedToken.kind === 'refused') return;
          const token = parsedToken.kind === 'present' ? parsedToken.token : undefined;

          const manager = new RunbookStateManager(cwd);
          const states = await manager.list();
          const allIds = await listAllRunIds(cwd);

          // The one running run the token names, if any.
          const owned =
            token === undefined ? null : await manager.findByOwnerTokenHash(hashRunSecret(token));
          if (token !== undefined && owned === null) {
            output.error(UNKNOWN_TOKEN_MESSAGE, CLIErrorCodes.UNKNOWN_TOKEN);
            output.flush();
            process.exitCode = 1;
            return;
          }
          // Core's lease rule decides whether the owner may delete the run. A
          // refusal stops the whole invocation before anything is deleted.
          const leaseRefusal =
            owned === null
              ? undefined
              : refuseUnderLease(owned.state.id, owned.state, owned.lease, 'prune');
          if (leaseRefusal !== undefined) {
            renderExecutionLeaseRefusal(output, leaseRefusal);
            output.flush();
            process.exitCode = 1;
            return;
          }
          const ownedRunId = owned?.state.id;

          // Default to --completed --stopped (all terminal runs) if no filter
          // flags provided; a bare `--token` selects exactly its run.
          const hasFilter =
            options.completed ??
            options.stopped ??
            options.active ??
            options.inactive ??
            options.all ??
            (token !== undefined ? true : undefined);
          const pruneCompleted = options.all ?? options.completed ?? !hasFilter;
          const pruneStopped = options.all ?? options.stopped ?? !hasFilter;
          const pruneActive = options.all ?? options.active ?? false;
          const pruneInactive = options.all ?? options.inactive ?? false;

          const toDelete: typeof states = [];
          const retained: typeof states = [];
          for (const state of states) {
            const lifecycle = state.lifecycle ?? 'running';
            if (state.id === ownedRunId) {
              toDelete.push(state);
              continue;
            }
            switch (lifecycle) {
              case 'completed':
                if (pruneCompleted) toDelete.push(state);
                break;
              case 'stopped':
                if (pruneStopped) toDelete.push(state);
                break;
              case 'abandoned':
                if (pruneInactive) toDelete.push(state);
                break;
              case 'running':
                // A running run is deleted only under its own token.
                if (pruneActive) retained.push(state);
                break;
              default: {
                const _exhaustive: never = lifecycle;
                throw new Error(`Unhandled lifecycle: ${String(_exhaustive)}`);
              }
            }
          }

          // Invalid rows (skipped by list() due to schema refusal) are invisible
          // to list() but can still be deleted: prune with --inactive or --all.
          const loadedIds = new Set<string>(states.map((s) => s.id));
          const invalidIds = allIds.filter((id) => !loadedIds.has(id));
          const invalidToDelete = pruneInactive ? invalidIds : [];

          type PruneRow = {
            id: string;
            runbook: string;
            title: string | undefined;
            _status: string;
            _retained?: string;
          };

          const rows: PruneRow[] = [
            ...toDelete.map((state) => ({
              id: state.id,
              runbook: state.runbook.path,
              title: state.title,
              _status: getStatus(state),
            })),
            ...invalidToDelete.map((id) => ({
              id,
              runbook: '(invalid)',
              title: undefined,
              _status: 'invalid',
            })),
            ...retained.map((state) => ({
              id: state.id,
              runbook: state.runbook.path,
              title: state.title,
              _status: getStatus(state),
              _retained: TOKEN_REQUIRED_REASON,
            })),
          ];

          const columns = [
            { header: 'ID', key: 'id' as const },
            { header: 'STATUS', key: (item: PruneRow) => item._status },
            { header: 'RUNBOOK', key: 'runbook' as const },
            { header: 'TITLE', key: (item: PruneRow) => (item.title ? `[${item.title}]` : '') },
            {
              header: 'RETAINED',
              key: (item: PruneRow) => item._retained ?? '',
            },
          ];

          // Emit only the documented ActiveRunbookEntry fields plus `retained`
          // (PruneResponseSchema). `step`/`total` are intentionally omitted.
          const jsonMapper = (item: PruneRow): Record<string, unknown> => ({
            id: item.id,
            runbook: item.runbook,
            status: item._status,
            title: item.title,
            ...(item._retained !== undefined ? { retained: item._retained } : {}),
          });

          if (rows.length === 0) {
            output.list([], columns, {
              emptyMessage: 'No run state to prune.',
              jsonMapper,
            });
            output.flush();
            return;
          }

          if (!options.dryRun) {
            // The token's run goes first, conditional on the version whose lease
            // was just checked: a write or a newly taken lease since that read
            // refuses the whole invocation with nothing deleted. Never retried.
            if (owned !== null) {
              const deleted = await manager.deleteAtVersion(owned.state.id, owned.stateVersion);
              if (deleted.kind !== 'deleted') {
                if (deleted.kind === 'concurrent_modification') {
                  output.error(
                    `Run ${owned.state.id} changed after prune read it; nothing was deleted. Re-read it with \`rundown status --run ${owned.state.id}\` and re-issue the prune if it still applies.`,
                    CONCURRENT_MODIFICATION_CODE,
                    { runId: owned.state.id },
                  );
                } else {
                  output.error(UNKNOWN_TOKEN_MESSAGE, CLIErrorCodes.UNKNOWN_TOKEN);
                }
                output.flush();
                process.exitCode = 1;
                return;
              }
            }
            for (const state of toDelete) {
              if (state.id === ownedRunId) continue;
              await manager.delete(state.id);
            }
            for (const id of invalidToDelete) {
              await manager.delete(id);
            }
          }

          output.list(rows, columns, { jsonMapper });
          output.flush();
        },
        { text: options.text },
      );
    });
}
