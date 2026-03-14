/**
 * Resolve command: validates runbook structure AND full variable/source resolution.
 *
 * Unlike `check` (syntax/structure only), `resolve` runs the complete variable
 * discovery and substitution pipeline as a diagnostic tool without executing
 * commands or starting actors.
 *
 * @module commands/resolve
 */

import type { Command } from 'commander';
import type { DataSource, ResolveSourceInfo, CheckValidationWarning } from '@rundown-org/core';
import { OutputEmitter } from '../services/output-emitter.js';
import { collect } from './echo.js';
import { prepareRunbook } from '../helpers/runbook-pipeline.js';

/**
 * Build source info for JSON/text output from resolved data sources.
 *
 * @param sources - Resolved data sources from the variable discovery pipeline
 * @returns Source info map suitable for output rendering
 */
function buildSourceInfo(
  sources: Readonly<Record<string, DataSource>>,
): Record<string, ResolveSourceInfo> {
  const result: Record<string, ResolveSourceInfo> = {};
  for (const [key, source] of Object.entries(sources)) {
    if (source.kind === 'array') {
      result[key] = { kind: 'array', items: source.items.length };
    } else {
      result[key] = { kind: 'file', path: source.path, format: source.format };
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
  /** Path to YAML variable file */
  varFile?: string;
  /** CLI variable assignments (key=value) */
  var?: string[];
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
    .option('--var-file <path>', 'Load variables from YAML file')
    .option('--var <key=value>', 'Set variable (repeatable)', collect, [])
    .option('--json', 'Output as JSON')
    .action(async (file: string, options: ResolveOptions) => {
      const output = new OutputEmitter({ json: options.json });
      const cwd = process.cwd();

      const result = await prepareRunbook(
        file,
        { varFile: options.varFile, var: options.var },
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

        const sourceInfo = result.sources ? buildSourceInfo(result.sources) : undefined;

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

      const sourceInfo = buildSourceInfo(prepared.sources);
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
