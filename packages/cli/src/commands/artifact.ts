import type { Command } from 'commander';
import {
  WORK_DIR,
  RunbookStateManager,
  SessionService,
  inspectArtifactReference,
  listArtifactAliases,
  projectArtifactPath,
  projectArtifactUri,
} from '@rundown-org/core';
import { resolveActiveRunbook } from '../helpers/active-runbook-resolver.js';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

type ArtifactProjection =
  | { readonly path: string; readonly uri: string }
  | { readonly items: ReadonlyArray<{ readonly path: string; readonly uri: string }> };

async function loadActiveState(output: OutputEmitter) {
  const cwd = getCwd();
  const manager = new RunbookStateManager(cwd);
  const sessionService = new SessionService(manager);
  const active = await resolveActiveRunbook(sessionService, { allowStashed: true });
  if (active.kind === 'none') {
    output.noActiveRunbook('artifact');
    output.flush();
    return null;
  }
  if (active.kind === 'stale_claim') {
    output.error(active.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
    output.flush();
    process.exitCode = 1;
    return null;
  }
  const workPath =
    typeof active.state.templateVars?.WorkPath === 'string'
      ? active.state.templateVars.WorkPath
      : WORK_DIR;
  return { state: active.state, artifactPathOptions: { cwd, workPath } };
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
    .action(async (options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'artifact ls' });
          const active = await loadActiveState(output);
          if (!active) return;
          const rows = listArtifactAliases(active.state, active.artifactPathOptions);
          output.list(rows, [
            { header: 'ALIAS', key: 'alias' },
            { header: 'KIND', key: (row) => ('items' in row ? 'artifact-array' : row.kind) },
            {
              header: 'URI',
              key: (row) => ('items' in row ? `${row.items.length} artifacts` : row.uri),
            },
            {
              header: 'PATH',
              key: (row) => ('items' in row ? `${row.items.length} paths` : row.path),
            },
          ]);
          output.flush();
        },
        { text: options.text },
      );
    });

  artifact
    .command('path')
    .argument('<alias-or-uri>')
    .option('--text', 'Output as human-readable text')
    .action(async (input: string, options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'artifact path' });
          const active = await loadActiveState(output);
          if (!active) return;
          const record = await projectArtifactPath(active.state, input, active.artifactPathOptions);
          if (options.text) {
            output.message(formatArtifactPaths(record), 'info');
          } else {
            output.detail(record as unknown as Record<string, unknown>, 'custom');
          }
          output.flush();
        },
        { text: options.text },
      );
    });

  artifact
    .command('uri')
    .argument('<alias>')
    .option('--text', 'Output as human-readable text')
    .action(async (alias: string, options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'artifact uri' });
          const active = await loadActiveState(output);
          if (!active) return;
          const record = projectArtifactUri(active.state, alias, active.artifactPathOptions);
          if (options.text) {
            output.message(formatArtifactUris(record), 'info');
          } else {
            output.detail(record as unknown as Record<string, unknown>, 'custom');
          }
          output.flush();
        },
        { text: options.text },
      );
    });

  artifact
    .command('inspect')
    .argument('<alias-or-uri>')
    .option('--text', 'Output as human-readable text')
    .action(async (input: string, options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'artifact inspect' });
          const active = await loadActiveState(output);
          if (!active) return;
          const record = await inspectArtifactReference(
            active.state,
            input,
            active.artifactPathOptions,
          );
          output.detail(record as unknown as Record<string, unknown>, 'custom');
          output.flush();
        },
        { text: options.text },
      );
    });
}
