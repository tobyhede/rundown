/**
 * Resolve command: validates runbook structure AND full variable/source resolution.
 *
 * Unlike `check` (syntax/structure only), `resolve` runs the complete variable
 * discovery and substitution pipeline as a diagnostic tool without executing
 * commands or starting actors.
 *
 * @module commands/resolve
 */

import * as path from 'node:path';
import type { Command } from 'commander';
import {
  parseRunbookDocument,
  type DataSource,
  type ResolveSourceInfo,
  type CheckValidationWarning,
  getErrorMessage,
} from '@rundown-org/core';
import { validateRunbook } from '@rundown-org/parser';
import { OutputEmitter } from '../services/output-emitter.js';
import { loadAndValidateRunbook } from '../helpers/runbook-validator.js';
import { collect } from './echo.js';
import { resolveVariables, FileSourcePolicyError } from '../services/variable-discovery.js';
import { buildTemplateVars, validateSources } from '../helpers/runbook-pipeline.js';
import {
  substituteRunbookVariables,
  expandForClauseVariables,
  collectUnresolvedRunbookVariables,
} from '../services/template-renderer.js';
import { getPolicyEvaluator, getPolicyPrompter } from '../services/policy-context.js';

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

      // Phase 1: Structural validation (same as check)
      const loadResult = await loadAndValidateRunbook(file, cwd);

      if (!loadResult.ok) {
        output.detail(
          {
            type: 'resolve' as const,
            valid: false,
            errors: [{ message: loadResult.error }],
          },
          'resolve',
        );
        output.flush();
        process.exit(1);
      }

      const { content: rawContent, diagnostics, stats } = loadResult.loaded;
      const structuralErrors = diagnostics.filter((d) => d.severity === 'error');
      const structuralWarnings = diagnostics.filter((d) => d.severity === 'warning');

      // Phase 2: Variable resolution pipeline
      let mergedVariables: Record<string, string>;
      let sources: Record<string, DataSource>;
      const errors = structuralErrors.map((e) => ({ line: e.line, message: e.message }));
      const warnings: CheckValidationWarning[] = structuralWarnings.map((w) => ({
        line: w.line,
        message: w.message,
      }));

      let resolutionFailed = false;
      try {
        const resolvedVariables = await resolveVariables(
          { varFile: options.varFile, var: options.var, markdown: rawContent },
          cwd,
          {
            evaluator: getPolicyEvaluator(),
            prompter: getPolicyPrompter(),
          },
        );
        mergedVariables = { ...resolvedVariables.vars };
        sources = { ...resolvedVariables.sources };

        // Surface variable discovery warnings as structured output
        for (const msg of resolvedVariables.warnings) {
          warnings.push({ message: msg, kind: 'variable-discovery' });
        }
      } catch (error) {
        resolutionFailed = true;
        if (error instanceof FileSourcePolicyError) {
          errors.push({ line: undefined, message: error.message });
        } else {
          errors.push({ line: undefined, message: getErrorMessage(error) });
        }
        mergedVariables = {};
        sources = {};
      }

      const templateVars = buildTemplateVars(mergedVariables);

      // Phase 3: FOR clause expansion + re-parse + substitution
      // Skip when variable resolution failed — running with empty variables would
      // produce misleading "unresolved variable" warnings that mask the root cause.
      let unresolvedNames: string[] = [];
      if (!resolutionFailed) {
        try {
          const sourceKeys = new Set(Object.keys(sources));
          const forExpandedContent = expandForClauseVariables(rawContent, templateVars, sourceKeys);
          const runbook = parseRunbookDocument(
            forExpandedContent,
            path.basename(loadResult.loaded.resolvedPath),
            { skipValidation: true },
          );

          // Validate expanded AST (mirrors run path which validates by default)
          const postExpansionDiagnostics = validateRunbook(runbook.steps);
          for (const d of postExpansionDiagnostics) {
            if (d.severity === 'error') {
              errors.push({ line: d.line, message: d.message });
            } else {
              warnings.push({ line: d.line, message: d.message });
            }
          }

          const substituted = substituteRunbookVariables(runbook, templateVars);
          unresolvedNames = [...collectUnresolvedRunbookVariables(substituted)];

          // Validate sourced FOR clauses reference defined data sources
          validateSources(substituted.steps, sources);
        } catch (error) {
          errors.push({
            line: undefined,
            message: `During FOR expansion: ${getErrorMessage(error)}`,
          });
        }
      }

      // Phase 4: Build output
      const hasErrors = errors.length > 0;

      // Unresolved variables are warnings, not errors
      if (unresolvedNames.length > 0) {
        for (const name of unresolvedNames) {
          warnings.push({
            line: undefined,
            message: `Unresolved variable: {{${name}}}`,
            kind: 'unresolved',
          });
        }
      }

      const sourceInfo = buildSourceInfo(sources);

      output.detail(
        {
          type: 'resolve' as const,
          valid: !hasErrors,
          errors,
          warnings: warnings.length > 0 ? warnings : undefined,
          stats,
          variables: templateVars,
          sources: Object.keys(sourceInfo).length > 0 ? sourceInfo : undefined,
          unresolved: unresolvedNames.length > 0 ? unresolvedNames : undefined,
        },
        'resolve',
      );
      output.flush();

      if (hasErrors) {
        process.exit(1);
      }
    });
}
