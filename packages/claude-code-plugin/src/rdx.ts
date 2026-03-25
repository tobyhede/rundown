#!/usr/bin/env node
/**
 * CLI entry point for the rdx JSON-to-Markdown tool.
 *
 * Renders any JSON file to readable Markdown following structural conventions.
 * Optionally validates JSON parse-ability without rendering.
 *
 * @module
 */

import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import { renderToMarkdown } from './rdx-core.js';
import { getErrorMessage } from './shared/errors.js';

const program = new Command();
program
  .name('rdx')
  .description('Transform JSON to Markdown')
  .argument('<file>', 'JSON file to process')
  .option('--check', 'Validate JSON without rendering')
  .option('-o, --output <path>', 'Write to file instead of stdout')
  .action(async (file: string, options: { check?: boolean; output?: string }) => {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const data: unknown = JSON.parse(raw);
      if (options.check) {
        process.stdout.write('Valid.\n');
        return;
      }
      const md = renderToMarkdown(data);
      if (options.output) {
        await fs.writeFile(options.output, md);
      } else {
        process.stdout.write(md);
      }
    } catch (error) {
      process.stderr.write(`error: ${getErrorMessage(error)}\n`);
      process.exitCode = 1;
    }
  });

program.parse();
