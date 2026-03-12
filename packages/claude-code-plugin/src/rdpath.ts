#!/usr/bin/env node
/**
 * CLI entry point for the rdpath path-assembly tool.
 *
 * Assembles artifact paths with optional context scoping and date-prefixed filenames.
 *
 * @module
 */

import { Command } from 'commander';
import { assemblePath, type RdPathOptions } from './rdpath-core.js';

const program = new Command();
program
  .name('rdpath')
  .description('Assemble artifact paths with optional context scoping')
  .requiredOption('--dir <path>', 'Base directory')
  .option('--ctx <id>', 'Context scope (creates .rd-<id>/ subdirectory)')
  .option('--file <name>', 'Filename to date-prefix (YYYY-MM-DD)')
  .action((options: RdPathOptions) => {
    process.stdout.write(assemblePath(options) + '\n');
  });

program.parse();
