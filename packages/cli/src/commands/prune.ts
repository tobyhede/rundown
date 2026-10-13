// packages/cli/src/commands/prune.ts

import type { Command } from 'commander';
import {
  CLIErrorCodes,
  CONCURRENT_MODIFICATION_CODE,
  RunbookStateManager,
  hasRunningInlineAncestor,
  hashRunSecret,
  planRunDeletions,
  refuseDeletionUnderLease,
  type RunDeletion,
  type VersionedRunState,
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

/** Reason a selected running run was kept: only its Owner Token deletes it. */
const TOKEN_REQUIRED_REASON = 'token required';
/**
 * Reason a finished Inline Child was kept: its running parent has not finished
 * with it, and it goes only with its root.
 */
const PARENT_RUNNING_REASON = 'parent running';
/** Reason a finished run was kept: an attempt in its inline chain is In Progress. */
const EXECUTION_IN_PROGRESS_REASON = 'execution in progress';

/**
 * Registers the 'prune' command for removing run state.
 *
 * Finished runs (completed, stopped, abandoned) prune by lifecycle filter as
 * before. A RUNNING run is deleted only when `--token` names it — one run per
 * invocation, proven by its Owner Token. `--active` / `--all` without a token
 * skip running runs and report them retained with reason `token required`.
 * Deleting a run deletes its Inline Children with it (#903), so core's
 * execution-lease rule for `prune` covers the whole inline chain: In Progress
 * anywhere in the token's chain refuses the whole invocation
 * `EXECUTION_IN_PROGRESS` with nothing deleted, and keeps a filter-selected
 * run (`retained: "execution in progress"`); Interrupted lets the delete
 * proceed. A finished Inline Child whose parent is still running is never
 * deleted on its own (`retained: "parent running"`); it goes with its root.
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
          const runs = await manager.listWithVersion();
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

          const selected: VersionedRunState[] = owned === null ? [] : [owned];
          const retained: { readonly run: VersionedRunState; readonly reason: string }[] = [];
          for (const run of runs) {
            if (run.state.id === ownedRunId) continue;
            const lifecycle = run.state.lifecycle ?? 'running';
            let chosen: boolean;
            switch (lifecycle) {
              case 'completed':
                chosen = pruneCompleted;
                break;
              case 'stopped':
                chosen = pruneStopped;
                break;
              case 'abandoned':
                chosen = pruneInactive;
                break;
              case 'running':
                // A running run is deleted only under its own token.
                if (pruneActive) retained.push({ run, reason: TOKEN_REQUIRED_REASON });
                chosen = false;
                break;
              default: {
                const _exhaustive: never = lifecycle;
                throw new Error(`Unhandled lifecycle: ${String(_exhaustive)}`);
              }
            }
            if (!chosen) continue;
            // A finished Inline Child its running parent has not finished with
            // goes only with its root (core's linkage rule).
            if (hasRunningInlineAncestor(run, runs)) {
              retained.push({ run, reason: PARENT_RUNNING_REASON });
            } else {
              selected.push(run);
            }
          }

          // Each delete removes its root's Inline Children too, so core's lease
          // rule applies to every run in the chain. For the token's run a
          // refusal stops the whole invocation before anything is deleted; a
          // run selected by filter is kept and reported instead.
          const deletions: RunDeletion[] = [];
          for (const deletion of planRunDeletions(selected, runs)) {
            const refusal = refuseDeletionUnderLease(deletion);
            if (refusal === undefined) {
              deletions.push(deletion);
            } else if (deletion.root.state.id === ownedRunId) {
              renderExecutionLeaseRefusal(output, refusal);
              output.flush();
              process.exitCode = 1;
              return;
            } else {
              retained.push({ run: deletion.root, reason: EXECUTION_IN_PROGRESS_REASON });
            }
          }

          // Invalid rows (skipped by list() due to schema refusal) are invisible
          // to list() but can still be deleted: prune with --inactive or --all.
          const loadedIds = new Set<string>(runs.map((run) => run.state.id));
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
            ...deletions
              .flatMap((deletion) => [deletion.root, ...deletion.inlineDescendants])
              .map(({ state }) => ({
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
            ...retained.map(({ run: { state }, reason }) => ({
              id: state.id,
              runbook: state.runbook.path,
              title: state.title,
              _status: getStatus(state),
              _retained: reason,
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
            // The token's run goes first (it heads `selected`). Every delete is
            // one conditional write on the versions just read, of its root and
            // of each inline descendant: a write, a newly taken lease or a newly
            // launched child since that read refuses it. Never retried.
            for (const { root, inlineDescendants } of deletions) {
              const deleted = await manager.deleteAtVersion(
                root.state.id,
                root.stateVersion,
                inlineDescendants.map((run) => ({
                  runId: run.state.id,
                  stateVersion: run.stateVersion,
                })),
              );
              if (deleted.kind === 'deleted') continue;
              const isOwned = root.state.id === ownedRunId;
              if (deleted.kind === 'missing' && !isOwned) continue;
              if (deleted.kind === 'concurrent_modification') {
                output.error(
                  `Run ${root.state.id} or one of its inline children changed after prune read it, so it was not deleted. Re-read it with \`rundown status --run ${root.state.id}\` and re-issue the prune if it still applies.`,
                  CONCURRENT_MODIFICATION_CODE,
                  { runId: root.state.id },
                );
              } else {
                output.error(UNKNOWN_TOKEN_MESSAGE, CLIErrorCodes.UNKNOWN_TOKEN);
              }
              output.flush();
              process.exitCode = 1;
              return;
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
