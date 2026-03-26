#!/usr/bin/env node
/**
 * CLI entry point for the rdx JSON-to-Markdown tool.
 *
 * Renders any JSON file to readable Markdown following structural conventions.
 * Validates against a schema when one is discoverable (via `--schema` flag
 * or `$schema` field in the JSON data).
 *
 * @module
 */

import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import { renderToMarkdown } from './rdx-core.js';
import {
  stripSchema,
  resolveSchemaName,
  loadValidator,
  formatValidationErrors,
} from './rdx-validate.js';
import { getErrorMessage } from './shared/errors.js';

const program = new Command();
program
  .name('rdx')
  .description('Transform JSON to Markdown')
  .argument('<file>', 'JSON file to process')
  .option('--check', 'Validate without rendering')
  .option('--schema <name>', 'Schema name for validation (e.g. "plan")')
  .option('-o, --output <path>', 'Write to file instead of stdout')
  .action(async (file: string, options: { check?: boolean; schema?: string; output?: string }) => {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const data: unknown = JSON.parse(raw);

      // Extract $schema and prepare clean data
      const { cleanData, schemaName: dataSchema, rawSchema } = stripSchema(data);
      const schema = resolveSchemaName(options.schema, dataSchema);

      // Reject unrecognized $schema URIs — don't silently skip validation
      if (rawSchema && !schema) {
        process.stderr.write(`error: unrecognized schema: ${rawSchema}\n`);
        process.exitCode = 1;
        return;
      }

      // Validate against schema when available, capturing typed result
      let dataToRender: unknown = cleanData;
      if (schema) {
        try {
          const validate = await loadValidator(schema);
          dataToRender = validate(cleanData);
        } catch (error) {
          process.stderr.write(formatValidationErrors(error, schema));
          process.exitCode = 1;
          return;
        }
      }

      if (options.check) {
        process.stdout.write('Valid.\n');
        return;
      }

      const md = renderToMarkdown(dataToRender);
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
