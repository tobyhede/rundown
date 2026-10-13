// packages/cli/src/commands/prune.ts

import type { Command } from 'commander';
import {
  CLIErrorCodes,
  CONCURRENT_MODIFICATION_CODE,
  RunbookStateManager,
  hashRunSecret,
  planPrune,
  type HumanConfirmationAudit,
  type RunDeletion,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getStatus } from '../helpers/status.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import {
  TOKEN_OPTION_DESCRIPTION,
  UNKNOWN_TOKEN_MESSAGE,
  parseOptionalTokenOption,
  renderExecutionLeaseRefusal,
  withTokenOption,
} from '../helpers/token-option.js';
import {
  NO_HUMAN,
  humanAt,
  humanAtTerminal,
  type HumanConfirmation,
} from '../services/human-confirmation.js';

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

/**
 * The question put to the human before a running run is deleted without its
 * Owner Token.
 *
 * @param deletion - The delete: the running run, and the Inline Children it removes with it.
 * @param deletion.root - The running run.
 * @param deletion.inlineDescendants - The Inline Children its delete removes.
 * @param who - The user and host the confirmation is recorded as.
 * @param who.user - The login name.
 * @param who.host - The host name.
 * @returns The question.
 */
function confirmRunningQuestion(
  { root, inlineDescendants }: RunDeletion,
  who: { readonly user: string; readonly host: string },
): string {
  const children =
    inlineDescendants.length === 0
      ? ''
      : `, with the ${String(inlineDescendants.length)} inline child run(s) it composes,`;
  return `Run ${root.state.id} (${root.state.runbook.path}) is still running. Delete it${children} without its owner token? This is recorded in the prune output as confirmed by ${who.user} on ${who.host}.`;
}

/**
 * Ask the human about one running run's delete, recording who confirmed it.
 *
 * @param person - The human at the terminal.
 * @param deletion - The delete to confirm.
 * @returns Who confirmed it and when, or `undefined` for anything but yes.
 */
async function confirmDeletion(
  person: HumanConfirmation,
  deletion: RunDeletion,
): Promise<HumanConfirmationAudit | undefined> {
  const who = humanAtTerminal();
  if (!(await person.confirm(confirmRunningQuestion(deletion, who)))) return undefined;
  return { at: new Date().toISOString(), ...who };
}

/**
 * Registers the 'prune' command for removing run state.
 *
 * A thin front end over core's prune rule (`planPrune`, #906): core decides
 * which selected runs are deleted and why each other one is kept; this
 * command lists the store, renders the plan and makes its deletes. Finished
 * runs (completed, stopped, abandoned) prune by lifecycle filter. A Current
 * Child its running parent still counts is never deleted, whatever the
 * filter (`retained: "uncollected"` once terminal, `"current child"` while it
 * runs), and `--token` naming one is refused `CURRENT_CHILD_PROTECTED`; a
 * finished child the selection picks goes after a parent this prune deletes.
 * A RUNNING run is deleted when `--token` names it, or — a top-level run
 * selected by `--active` / `--all` — when the human at an interactive
 * terminal confirms it, and its row then records who confirmed it
 * (`confirmedBy`); otherwise it is kept as `token required` (no terminal, or
 * `--dry-run`) or `not confirmed`. A running child run is never offered: it is
 * kept as `child run`, with the recoveries that reach it (`detail`). Deleting
 * a run deletes its Inline Children with it (#903),
 * so core's execution-lease rule covers the whole chain: In Progress in the
 * token's chain refuses the invocation `EXECUTION_IN_PROGRESS` with nothing
 * deleted, and keeps any other run (`retained: "execution in progress"`).
 * Invalid persisted rows prune with `--inactive` / `--all`. `--run` (a
 * read-only selector) is refused `INVALID_SYNTAX` as on every other
 * mutating command.
 *
 * @param program - Commander program instance to register the command on
 * @param human - The human at the terminal, asked before a running run is
 *   deleted without its token; none by default
 */
export function registerPruneCommand(program: Command, human: HumanConfirmation = NO_HUMAN): void {
  withTokenOption(
    program.command('prune').description('Remove run state (does not delete runbook files)'),
    `${TOKEN_OPTION_DESCRIPTION}; deletes that one running run`,
  )
    .option('--dry-run', 'Show what would be removed without deleting')
    .option('--completed', 'Prune successfully completed run state')
    .option('--stopped', 'Prune stopped (aborted/failed) run state')
    .option(
      '--active',
      'Prune running run state (each needs its --token, or your confirmation at a terminal)',
    )
    .option('--inactive', 'Prune invalid or abandoned run state')
    .option('--all', 'Prune all run state')
    .option('--text', 'Output as human-readable text')
    .action(async (options: PruneOptions, command: Command) => {
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

          // The one run the token names, if any.
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
          const pruneInactive = options.all ?? options.inactive ?? false;

          // A dry run never asks: it deletes nothing to confirm.
          const person = options.dryRun === true ? NO_HUMAN : humanAt(command, human);
          const plan = await planPrune({
            runs,
            owned,
            select: {
              completed: options.all ?? options.completed ?? !hasFilter,
              stopped: options.all ?? options.stopped ?? !hasFilter,
              abandoned: pruneInactive,
              running: options.all ?? options.active ?? false,
            },
            ...(person.interactive
              ? { confirmRunning: (deletion) => confirmDeletion(person, deletion) }
              : {}),
            loadSteps: (state) => getRunbookFromState(state, cwd),
          });
          if (plan.kind === 'refused') {
            const { refusal } = plan;
            if (refusal.kind === 'current_child_protected') {
              output.error(refusal.message, refusal.code, {
                runId: refusal.runId,
                parentRunId: refusal.parentRunId,
                parentStep: refusal.parentStep,
              });
            } else {
              renderExecutionLeaseRefusal(output, refusal);
            }
            output.flush();
            process.exitCode = 1;
            return;
          }
          const { deletions, retained } = plan;

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
            _detail?: string;
            _confirmedBy?: HumanConfirmationAudit;
          };

          const rows: PruneRow[] = [
            // A delete the human confirmed records them on every row it removes.
            ...deletions.flatMap(({ root, inlineDescendants, confirmedBy }) =>
              [root, ...inlineDescendants].map(({ state }) => ({
                id: state.id,
                runbook: state.runbook.path,
                title: state.title,
                _status: getStatus(state),
                ...(confirmedBy !== undefined ? { _confirmedBy: confirmedBy } : {}),
              })),
            ),
            ...invalidToDelete.map((id) => ({
              id,
              runbook: '(invalid)',
              title: undefined,
              _status: 'invalid',
            })),
            ...retained.map((kept) => ({
              id: kept.run.state.id,
              runbook: kept.run.state.runbook.path,
              title: kept.run.state.title,
              _status: getStatus(kept.run.state),
              _retained: kept.reason,
              ...('detail' in kept ? { _detail: kept.detail } : {}),
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
            {
              header: 'NOTE',
              key: (item: PruneRow) =>
                item._confirmedBy !== undefined
                  ? `confirmed by ${item._confirmedBy.user}@${item._confirmedBy.host} at ${item._confirmedBy.at}`
                  : (item._detail ?? ''),
            },
          ];

          // Emit only the documented ActiveRunbookEntry fields plus `retained`,
          // `detail` and `confirmedBy` (PruneResponseSchema). `step`/`total` are
          // intentionally omitted.
          const jsonMapper = (item: PruneRow): Record<string, unknown> => ({
            id: item.id,
            runbook: item.runbook,
            status: item._status,
            title: item.title,
            ...(item._retained !== undefined ? { retained: item._retained } : {}),
            ...(item._detail !== undefined ? { detail: item._detail } : {}),
            ...(item._confirmedBy !== undefined ? { confirmedBy: item._confirmedBy } : {}),
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
            // The token's run goes first (it heads the plan). Every delete is
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
