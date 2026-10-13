#!/usr/bin/env node
/**
 * CLI entry point for the rdpath path-assembly tool.
 *
 * Assembles artifact paths with optional context scoping and date-prefixed filenames.
 * Provides glob-based file discovery within artifact directories.
 *
 * Scope comes from the invocation only: `--dir` / `--ctx`, falling back to
 * `RD_WORK_PATH` / `RD_CONTEXT_ID`, which the CLI exports into every command
 * block it runs. `rdpath` never opens the run store — under one writer per run
 * there is no "active run" to read a scope from (ADR 0005), so a missing base
 * directory is an invocation error, not a lookup to attempt.
 *
 * @module
 */

import { Command } from 'commander';
import { assembleRdPath, findRdPathFiles } from '@rundown-org/core';
import { getErrorMessage } from './shared/errors.js';

const program = new Command();
program
  .name('rdpath')
  .description('Assemble artifact paths with optional context scoping')
  .enablePositionalOptions()
  .helpCommand(false)
  .option('--dir <path>', 'Base directory (defaults to $RD_WORK_PATH)')
  .option('--ctx <id>', 'Context scope (defaults to $RD_CONTEXT_ID)');

interface ResolvedScope {
  dir: string;
  ctx?: string;
}

/**
 * Resolve `--dir` / `--ctx` from the program-level options, falling back to
 * `RD_WORK_PATH` / `RD_CONTEXT_ID`. Writes the canonical "--dir is required"
 * error to stderr and sets `process.exitCode = 1` when no base directory is
 * available.
 *
 * @returns The resolved scope, or `null` when no `dir` could be determined.
 */
function resolveScope(): ResolvedScope | null {
  const opts = program.opts<{ dir?: string; ctx?: string }>();
  const dir = opts.dir ?? process.env.RD_WORK_PATH;
  const ctx = opts.ctx ?? process.env.RD_CONTEXT_ID;
  if (!dir) {
    process.stderr.write('error: --dir is required (or set $RD_WORK_PATH)\n');
    process.exitCode = 1;
    return null;
  }
  return ctx === undefined ? { dir } : { dir, ctx };
}

const pathCmd = new Command('path')
  .description('Assemble an artifact path')
  .option('--file <name>', 'Filename to date-prefix (YYYY-MM-DD)')
  .action((options: { file?: string }) => {
    try {
      const scope = resolveScope();
      if (!scope) return;
      process.stdout.write(`${assembleRdPath({ ...scope, file: options.file })}\n`);
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
      const scope = resolveScope();
      if (!scope) return;
      const results = await findRdPathFiles(scope, pattern);
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
