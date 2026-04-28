#!/usr/bin/env node
/**
 * CLI entry point for the rdpath path-assembly tool.
 *
 * Assembles artifact paths with optional context scoping and date-prefixed filenames.
 * Provides glob-based file discovery within artifact directories.
 *
 * @module
 */

import { Command } from 'commander';
import { readActiveRunScope } from '@rundown-org/core/session-reader';
import { assemblePath, findFiles } from './rdpath-core.js';
import { getErrorMessage, isNodeError } from './shared/errors.js';

const program = new Command();
program
  .name('rdpath')
  .description('Assemble artifact paths with optional context scoping')
  .enablePositionalOptions()
  .option('--dir <path>', 'Base directory (defaults to $RD_WORK_PATH)')
  .option('--ctx <id>', 'Context scope (defaults to $RD_CONTEXT_ID)');

interface ResolvedScope {
  dir: string;
  ctx?: string;
}

interface ActiveStateScope {
  dir?: string;
  ctx?: string;
}

/**
 * Resolve WorkPath / ContextId from the active runbook state.
 *
 * This goes through the core session-reader helper rather than parsing
 * persisted state files directly.
 *
 * @returns Active-state scope values, or an empty object when no runbook is active.
 */
async function resolveActiveStateScope(): Promise<ActiveStateScope> {
  const { workPath, contextId } = await readActiveRunScope(process.cwd());
  const activeScope: ActiveStateScope = {};

  if (workPath !== undefined) {
    activeScope.dir = workPath;
  }
  if (contextId !== undefined) {
    activeScope.ctx = contextId;
  }

  return activeScope;
}

function isRecoverableActiveStateLookupError(error: unknown): boolean {
  if (!Error.isError(error)) return false;

  if (error.name === 'StaleRunbookStateError' || error instanceof SyntaxError) {
    return true;
  }

  const message = error.message;
  if (
    message.includes('schema validation failed') ||
    message.includes('previous schema version') ||
    message.includes('Legacy per-agent session format detected') ||
    message.includes('Session file contains invalid entries')
  ) {
    return true;
  }

  if (isNodeError(error)) {
    const activeStateReadErrorCodes = new Set(['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR']);
    const errorPath = typeof error.path === 'string' ? error.path : '';
    return (
      typeof error.code === 'string' &&
      activeStateReadErrorCodes.has(error.code) &&
      errorPath.includes('.rundown')
    );
  }

  return false;
}

/**
 * Resolve `--dir` / `--ctx` from the program-level options, falling back to
 * `RD_WORK_PATH` / `RD_CONTEXT_ID`, then the active runbook state. Writes the
 * canonical "--dir is required" error to stderr and sets `process.exitCode = 1`
 * when no base directory is available.
 *
 * Active-state lookup runs in two modes. When `dir` cannot be resolved from
 * flag or env, the lookup is mandatory and any error from the state manager
 * (stale schema, corrupt JSON) propagates so the user sees the real cause.
 * When only `ctx` is missing, the lookup is best-effort: stale or unreadable
 * state is silently skipped so the path resolves without a context segment
 * rather than failing an otherwise valid invocation.
 *
 * @returns The resolved scope, or `null` when no `dir` could be determined.
 */
async function resolveScope(): Promise<ResolvedScope | null> {
  const opts = program.opts<{ dir?: string; ctx?: string }>();
  const flagOrEnvDir = opts.dir ?? process.env.RD_WORK_PATH;
  const flagOrEnvCtx = opts.ctx ?? process.env.RD_CONTEXT_ID;

  let activeScope: ActiveStateScope = {};
  if (flagOrEnvDir === undefined) {
    activeScope = await resolveActiveStateScope();
  } else if (flagOrEnvCtx === undefined) {
    try {
      activeScope = await resolveActiveStateScope();
    } catch (error) {
      if (!isRecoverableActiveStateLookupError(error)) {
        throw error;
      }
      activeScope = {};
    }
  }

  const dir = flagOrEnvDir ?? activeScope.dir;
  const ctx = flagOrEnvCtx ?? activeScope.ctx;
  if (!dir) {
    process.stderr.write('error: --dir is required (or set $RD_WORK_PATH)\n');
    process.exitCode = 1;
    return null;
  }
  return { dir, ctx };
}

const pathCmd = new Command('path')
  .description('Assemble an artifact path')
  .option('--file <name>', 'Filename to date-prefix (YYYY-MM-DD)')
  .action(async (options: { file?: string }) => {
    try {
      const scope = await resolveScope();
      if (!scope) return;
      process.stdout.write(`${assemblePath({ ...scope, file: options.file })}\n`);
    } catch (error) {
      const message = getErrorMessage(error);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    }
  });

const findCmd = new Command('find')
  .description(
    'Find files matching a glob pattern in an artifact directory. ' +
      'Exits 1 when zero files match (for runbook flow control); ' +
      'pass --allow-empty to treat an empty result as success.',
  )
  .argument('<pattern>', 'Glob pattern to match files against')
  .option('--allow-empty', 'Exit 0 when zero files match (default: exit 1 on empty)')
  .action(async (pattern: string, options: { allowEmpty?: boolean }) => {
    try {
      const scope = await resolveScope();
      if (!scope) return;
      const results = await findFiles(scope, pattern);
      for (const result of results) {
        process.stdout.write(`${result}\n`);
      }
      // Empty-match is a signal, not an error: exit 1 with no stderr output
      // so callers can distinguish "no matches" (stderr empty) from a real
      // error like a bad pattern (stderr starts with "error:").
      if (results.length === 0 && !options.allowEmpty) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = getErrorMessage(error);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    }
  });

program.addCommand(pathCmd, { isDefault: true });
program.addCommand(findCmd);

program.parse();
