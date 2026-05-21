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
import { getErrorMessage, isNodeError } from './shared/errors.js';

const program = new Command();
program
  .name('rdx')
  .description('Transform JSON to Markdown')
  .argument('<file>', 'JSON file to process')
  .option('--validate', 'Validate without rendering')
  .option('--schema <name>', 'Schema name for validation (e.g. "plan")')
  .option('-o, --output <path>', 'Write to file instead of stdout')
  .action(
    async (file: string, options: { validate?: boolean; schema?: string; output?: string }) => {
      // Stage 1: Read file
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf-8');
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          process.stderr.write(`error: file not found: ${file}\n`);
        } else {
          process.stderr.write(`error: cannot read ${file}: ${getErrorMessage(error)}\n`);
        }
        process.exitCode = 1;
        return;
      }

      // Stage 2: Parse JSON
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch (error) {
        process.stderr.write(`error: invalid JSON in ${file}: ${getErrorMessage(error)}\n`);
        process.exitCode = 1;
        return;
      }

      // Stage 3: Schema resolution, validation, rendering
      try {
        // Extract $schema and prepare clean data
        const { cleanData, schemaName: dataSchema, rawSchema } = stripSchema(data);
        const schema = resolveSchemaName(options.schema, dataSchema);

        // Reject unrecognized $schema URIs — don't silently skip validation
        if (rawSchema && !schema) {
          process.stderr.write(`error: unrecognized schema: ${rawSchema}\n`);
          process.exitCode = 1;
          return;
        }

        // No schema discoverable — error in validate mode, warn in render mode
        if (!schema) {
          if (options.validate) {
            process.stderr.write(
              'error: --validate requires a schema (use $schema in JSON or --schema flag)\n',
            );
            process.exitCode = 1;
            return;
          }
          process.stderr.write('warning: no schema found, skipping validation\n');
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

        if (options.validate) {
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
    },
  );

program.parse();
