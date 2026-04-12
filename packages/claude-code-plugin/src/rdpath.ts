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
import { assemblePath, findFiles } from './rdpath-core.js';
import { getErrorMessage } from './shared/errors.js';

const program = new Command();
program
  .name('rdpath')
  .description('Assemble artifact paths with optional context scoping')
  .enablePositionalOptions()
  .requiredOption('--dir <path>', 'Base directory')
  .option('--ctx <id>', 'Context scope (creates .rd-<id>/ subdirectory)');

const pathCmd = new Command('path')
  .description('Assemble an artifact path')
  .option('--file <name>', 'Filename to date-prefix (YYYY-MM-DD)')
  .action((options: { file?: string }) => {
    const { dir, ctx } = program.opts<{ dir: string; ctx?: string }>();
    try {
      process.stdout.write(`${assemblePath({ dir, ctx, file: options.file })}\n`);
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
    const { dir, ctx } = program.opts<{ dir: string; ctx?: string }>();
    try {
      const results = await findFiles({ dir, ctx }, pattern);
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
