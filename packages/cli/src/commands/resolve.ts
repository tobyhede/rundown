/**
 * Resolve command: validates runbook structure AND full variable/source resolution.
 *
 * Unlike `check` (syntax/structure only), `resolve` runs the complete variable
 * discovery and substitution pipeline as a diagnostic tool without executing
 * commands or starting actors.
 *
 * @module commands/resolve
 */

import { type Command, Option } from 'commander';
import type {
  ResolveSourceInfo,
  CheckValidationWarning,
  TemplateVarValue,
} from '@rundown-org/core';
import { isJsonArray, isJsonArrayStream } from '@rundown-org/core';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseVarOption, parseVarJsonOption, collect } from '../helpers/option-utils.js';
import { prepareRunbook } from '../helpers/runbook-pipeline.js';

/**
 * Build source info for JSON/text output from resolved template variables.
 *
 * Extracts source information from JsonArray and JsonArrayStream variables
 * that are used for FOR loop iteration.
 *
 * @param vars - Template variables that may contain JsonArray or JsonArrayStream
 * @returns Source info map suitable for output rendering
 */
function buildSourceInfo(
  vars: Readonly<Record<string, TemplateVarValue>>,
): Record<string, ResolveSourceInfo> {
  const result: Record<string, ResolveSourceInfo> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (isJsonArray(value)) {
      result[key] = { kind: 'array', items: value.length };
    } else if (isJsonArrayStream(value)) {
      result[key] = { kind: 'file', path: value.path, format: 'jsonl' };
    }
  }
  return result;
}

/**
 * Options for the resolve command parsed from CLI flags.
 *
 * The --schema flag is handled at the program level in cli.ts before
 * Commander dispatch and is not part of these options.
 */
interface ResolveOptions {
  /** Paths to YAML variable files (repeatable) */
  varFile?: string[];
  /** CLI variable assignments (key=value) */
  var?: string[];
  /** CLI variable assignments with JSON values (key=json) */
  varJson?: string[];
  /** Output as JSON */
  json?: boolean;
}

/**
 * Registers the 'resolve' command for full variable/source resolution diagnostics.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerResolveCommand(program: Command): void {
  program
    .command('resolve <file>')
    .description('Resolve and validate runbook variables and data sources')
    .addOption(
      new Option('--var-file <path>', 'Load variables from YAML file (repeatable)')
        .argParser(collect)
        .default([])
        .helpGroup('Variable options:'),
    )
    .addOption(
      new Option('--var <key=value>', 'Set variable (repeatable, omit =value to inherit from env)')
        .argParser(parseVarOption)
        .default([])
        .helpGroup('Variable options:'),
    )
    .addOption(
      new Option('--var-json <key=json>', 'Set variable with JSON value (repeatable)')
        .argParser(parseVarJsonOption)
        .default([])
        .helpGroup('Variable options:'),
    )
    .option('--json', 'Output as JSON')
    .action(async (file: string, options: ResolveOptions) => {
      const output = new OutputEmitter({ json: options.json });
      const cwd = process.cwd();

      const result = await prepareRunbook(
        file,
        { varFile: options.varFile, var: options.var, varJson: options.varJson },
        cwd,
      );

      if (!result.ok) {
        // Build output from partial results (variables, stats, diagnostics) + error
        const errors: Array<{ line?: number; message: string }> = [{ message: result.error }];
        const warnings: CheckValidationWarning[] = [];

        // Surface structural diagnostics when pipeline progressed past parse
        if (result.diagnostics) {
          for (const d of result.diagnostics) {
            if (d.severity === 'error') {
              errors.push({ line: d.line, message: d.message });
            } else {
              warnings.push({ line: d.line, message: d.message });
            }
          }
        }

        // Surface pipeline warnings
        if (result.warnings) {
          for (const msg of result.warnings) {
            warnings.push({ message: msg, kind: 'variable-discovery' });
          }
        }

        const sourceInfo = result.variables ? buildSourceInfo(result.variables) : undefined;

        output.detail(
          {
            kind: 'resolve' as const,
            valid: false,
            errors,
            warnings: warnings.length > 0 ? warnings : undefined,
            stats: result.stats,
            variables: result.variables,
            sources: sourceInfo && Object.keys(sourceInfo).length > 0 ? sourceInfo : undefined,
          },
          'resolve',
        );
        output.flush();
        process.exit(1);
      }

      // Build output from prepared result
      const { prepared, diagnostics, unresolved, warnings: pipelineWarnings } = result;
      const errors: Array<{ line?: number; message: string }> = [];
      const warnings: CheckValidationWarning[] = [];

      for (const d of diagnostics) {
        if (d.severity === 'error') {
          errors.push({ line: d.line, message: d.message });
        } else {
          warnings.push({ line: d.line, message: d.message });
        }
      }

      // Surface pipeline warnings (variable discovery only)
      if (pipelineWarnings) {
        for (const msg of pipelineWarnings) {
          warnings.push({ message: msg, kind: 'variable-discovery' });
        }
      }

      // Unresolved variables as structured warnings
      if (unresolved.length > 0) {
        for (const name of unresolved) {
          warnings.push({
            line: undefined,
            message: `Unresolved variable: {{${name}}}`,
            kind: 'unresolved',
          });
        }
      }

      const sourceInfo = buildSourceInfo(prepared.mergedVariables);
      const hasErrors = errors.length > 0;

      output.detail(
        {
          kind: 'resolve' as const,
          valid: !hasErrors,
          errors,
          warnings: warnings.length > 0 ? warnings : undefined,
          stats: prepared.stats,
          variables: prepared.mergedVariables,
          sources: Object.keys(sourceInfo).length > 0 ? sourceInfo : undefined,
          unresolved: unresolved.length > 0 ? unresolved : undefined,
        },
        'resolve',
      );
      output.flush();

      if (hasErrors) {
        process.exit(1);
      }
    });
}
