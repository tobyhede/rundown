import type { Command } from 'commander';
import {
  WORK_DIR,
  RunbookStateManager,
  SessionService,
  inspectArtifactReference,
  listArtifactAliases,
  projectArtifactPath,
  projectArtifactUri,
  type ArtifactAliasListEntry,
  type ArtifactPathOptions,
  type PublicArtifactRecord,
  type RunbookState,
} from '@rundown-org/core';
import { resolveActiveRunbook } from '../helpers/active-runbook-resolver.js';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/** A resolved artifact projection: an alias entry (scalar or array) or a bare record. */
type ArtifactProjection = ArtifactAliasListEntry | PublicArtifactRecord;

/** Active runbook resolution scoped to the artifact command's needs. */
type ActiveArtifactState =
  | {
      readonly kind: 'ok';
      readonly state: RunbookState;
      readonly artifactPathOptions: ArtifactPathOptions;
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly message: string };

/** Context handed to an artifact action body once an active runbook is resolved. */
interface ArtifactActionContext {
  readonly state: RunbookState;
  readonly artifactPathOptions: ArtifactPathOptions;
  readonly output: OutputEmitter;
}

/**
 * Resolve the active runbook and derive artifact path options. Pure: no output,
 * no exit-code mutation — the caller decides how to surface each outcome.
 *
 * @returns Discriminated resolution: `ok` with state + path options, `none`, or `stale_claim`
 */
async function resolveActiveArtifactState(): Promise<ActiveArtifactState> {
  const cwd = getCwd();
  const manager = new RunbookStateManager(cwd);
  const sessionService = new SessionService(manager);
  const active = await resolveActiveRunbook(sessionService, { allowStashed: true });
  if (active.kind === 'none') return { kind: 'none' };
  if (active.kind === 'stale_claim') return { kind: 'stale_claim', message: active.message };
  const workPath =
    typeof active.state.templateVars?.WorkPath === 'string'
      ? active.state.templateVars.WorkPath
      : WORK_DIR;
  return { kind: 'ok', state: active.state, artifactPathOptions: { cwd, workPath } };
}

/**
 * Run an artifact subcommand body against the active runbook, centralising error
 * handling, output construction, inactive-state reporting, and flushing.
 *
 * @param command - Command name for the output envelope (e.g. `artifact ls`)
 * @param options - Parsed subcommand options
 * @param options.text - When true, render human-readable text instead of JSON
 * @param body - Action body invoked only when an active runbook resolves
 */
async function runArtifactAction(
  command: string,
  options: { readonly text?: boolean },
  body: (context: ArtifactActionContext) => Promise<void> | void,
): Promise<void> {
  await withErrorHandling(
    async () => {
      const output = new OutputEmitter({ text: options.text, command });
      const active = await resolveActiveArtifactState();
      if (active.kind === 'none') {
        output.noActiveRunbook('artifact');
        output.flush();
        return;
      }
      if (active.kind === 'stale_claim') {
        output.error(active.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
        output.flush();
        process.exitCode = 1;
        return;
      }
      await body({ state: active.state, artifactPathOptions: active.artifactPathOptions, output });
      output.flush();
    },
    { text: options.text },
  );
}

function formatArtifactPaths(record: ArtifactProjection): string {
  if ('items' in record) {
    return record.items.map((item) => item.path).join('\n');
  }
  return record.path;
}

function formatArtifactUris(record: ArtifactProjection): string {
  if ('items' in record) {
    return record.items.map((item) => item.uri).join('\n');
  }
  return record.uri;
}

/**
 * Register artifact inspection commands.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerArtifactCommand(program: Command): void {
  const artifact = program.command('artifact').description('Inspect Rundown artifact aliases');

  artifact
    .command('ls')
    .option('--text', 'Output as human-readable text')
    .action((options: { text?: boolean }) =>
      runArtifactAction('artifact ls', options, ({ state, artifactPathOptions, output }) => {
        const rows = listArtifactAliases(state, artifactPathOptions);
        output.list(rows, [
          { header: 'ALIAS', key: 'alias' },
          { header: 'KIND', key: (row) => ('items' in row ? 'artifact-array' : row.kind) },
          {
            header: 'URI',
            key: (row) => ('items' in row ? `${String(row.items.length)} artifacts` : row.uri),
          },
          {
            header: 'PATH',
            key: (row) => ('items' in row ? `${String(row.items.length)} paths` : row.path),
          },
        ]);
      }),
    );

  artifact
    .command('path')
    .argument('<alias-or-uri>')
    .option('--text', 'Output as human-readable text')
    .action((input: string, options: { text?: boolean }) =>
      runArtifactAction(
        'artifact path',
        options,
        async ({ state, artifactPathOptions, output }) => {
          const record = await projectArtifactPath(state, input, artifactPathOptions);
          if (options.text) {
            output.message(formatArtifactPaths(record), 'info');
          } else {
            output.detail(record as Record<string, unknown>, 'custom');
          }
        },
      ),
    );

  artifact
    .command('uri')
    .argument('<alias>')
    .option('--text', 'Output as human-readable text')
    .action((alias: string, options: { text?: boolean }) =>
      runArtifactAction('artifact uri', options, ({ state, artifactPathOptions, output }) => {
        const record = projectArtifactUri(state, alias, artifactPathOptions);
        if (options.text) {
          output.message(formatArtifactUris(record), 'info');
        } else {
          output.detail(record as Record<string, unknown>, 'custom');
        }
      }),
    );

  artifact
    .command('inspect')
    .argument('<alias-or-uri>')
    .option('--text', 'Output as human-readable text')
    .action((input: string, options: { text?: boolean }) =>
      runArtifactAction(
        'artifact inspect',
        options,
        async ({ state, artifactPathOptions, output }) => {
          const record = await inspectArtifactReference(state, input, artifactPathOptions);
          output.detail(record as Record<string, unknown>, 'custom');
        },
      ),
    );
}
