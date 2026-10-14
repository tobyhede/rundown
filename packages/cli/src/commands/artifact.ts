import type { Command } from 'commander';
import {
  WORK_DIR,
  RunbookStateManager,
  inspectArtifactReference,
  listArtifactAliases,
  projectArtifactPath,
  projectArtifactUri,
  type ArtifactAliasListEntry,
  type ArtifactPathOptions,
  type PublicArtifactRecord,
  type RunbookState,
} from '@rundown-org/core';
import { getProjectRoot } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseRunOption } from '../helpers/run-option.js';

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
  | { readonly kind: 'ambiguous'; readonly runIds: readonly string[] }
  | { readonly kind: 'unknown_run'; readonly runId: string };

interface ArtifactActionContext {
  readonly state: RunbookState;
  readonly artifactPathOptions: ArtifactPathOptions;
  readonly output: OutputEmitter;
}

/**
 * Locate the run whose artifacts are inspected.
 *
 * `--run <id>` names it. Without `--run`, the single running run in the
 * project is used; with several, the caller is asked to name one, because
 * under one writer per run no run is implicitly "active".
 *
 * @param runId - Validated `--run` selector, when supplied
 * @returns The resolved run with its artifact path options, or why none was chosen
 */
async function resolveArtifactState(runId: string | undefined): Promise<ActiveArtifactState> {
  const cwd = getProjectRoot();
  const manager = new RunbookStateManager(cwd);
  let state: RunbookState | null;
  if (runId !== undefined) {
    state = await manager.load(runId);
    if (!state) return { kind: 'unknown_run', runId };
  } else {
    const running = (await manager.list()).filter((s) => (s.lifecycle ?? 'running') === 'running');
    if (running.length === 0) return { kind: 'none' };
    if (running.length > 1) return { kind: 'ambiguous', runIds: running.map((s) => s.id) };
    state = running[0];
  }
  const workPath =
    typeof state.templateVars.WorkPath === 'string' ? state.templateVars.WorkPath : WORK_DIR;
  return { kind: 'ok', state, artifactPathOptions: { cwd, workPath } };
}

async function runArtifactAction(
  command: string,
  options: { readonly text?: boolean; readonly run?: string },
  body: (context: ArtifactActionContext) => Promise<void> | void,
): Promise<void> {
  await withErrorHandling(
    async () => {
      const output = new OutputEmitter({ text: options.text, command });
      const run = parseRunOption(options.run, output);
      if (!run.ok) return;
      const active = await resolveArtifactState(run.runId);
      switch (active.kind) {
        case 'none':
          output.noActiveRunbook('artifact');
          output.flush();
          return;
        case 'ambiguous':
          output.error(
            `Several runs are running (${active.runIds.join(', ')}); name one with --run <id>.`,
            'INVALID_SYNTAX',
            { runIds: active.runIds },
          );
          output.flush();
          process.exitCode = 1;
          return;
        case 'unknown_run':
          output.error(`Run ${active.runId} not found.`, 'RUN_TARGET_UNAVAILABLE', {
            runId: active.runId,
          });
          output.flush();
          process.exitCode = 1;
          return;
        case 'ok':
          await body({
            state: active.state,
            artifactPathOptions: active.artifactPathOptions,
            output,
          });
          output.flush();
          return;
        default: {
          const _exhaustive: never = active;
          return _exhaustive;
        }
      }
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
    .option('--run <runId>', 'Run to inspect (defaults to the single running run)')
    .option('--text', 'Output as human-readable text')
    .action((options: { text?: boolean; run?: string }) =>
      runArtifactAction('artifact ls', options, ({ state, artifactPathOptions, output }) => {
        const rows = listArtifactAliases(state, artifactPathOptions);
        output.list(rows, [
          { header: 'ALIAS', key: 'alias' },
          { header: 'KIND', key: (row) => row.kind },
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
    .option('--run <runId>', 'Run to inspect (defaults to the single running run)')
    .option('--text', 'Output as human-readable text')
    .action((input: string, options: { text?: boolean; run?: string }) =>
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
    .option('--run <runId>', 'Run to inspect (defaults to the single running run)')
    .option('--text', 'Output as human-readable text')
    .action((alias: string, options: { text?: boolean; run?: string }) =>
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
    .option('--run <runId>', 'Run to inspect (defaults to the single running run)')
    .option('--text', 'Output as human-readable text')
    .action((input: string, options: { text?: boolean; run?: string }) =>
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
