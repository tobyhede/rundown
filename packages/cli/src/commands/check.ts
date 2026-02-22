import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Command } from 'commander';
import { parseRunbookDocument, validateRunbook, type Step } from '@rundown-org/parser';
import { OutputEmitter } from '../services/output-emitter.js';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';

function countSubsteps(steps: readonly Step[]): number {
  return steps.reduce((count, step) => {
    return count + (step.substeps?.length ?? 0);
  }, 0);
}

/**
 * Registers the 'check' command for validating runbook files.
 * @param program - Commander program instance to register the command on
 */
export function registerCheckCommand(program: Command): void {
  program
    .command('check <file>')
    .description('Check a runbook file for errors')
    .option('--json', 'Output as JSON')
    .action(async (file: string, options: { json?: boolean }) => {
      const output = new OutputEmitter({ json: options.json });
      const cwd = process.cwd();

      // Resolve file path using discovery system (supports namespace:name syntax)
      const resolvedPath = await resolveRunbookFile(cwd, file);

      if (!resolvedPath) {
        // File not found
        output.detail(
          {
            valid: false,
            errors: [{ message: `File not found: ${file}` }],
          },
          'check',
        );
        output.flush();
        process.exit(1);
      }

      try {
        const content = await fs.readFile(resolvedPath, 'utf-8');
        const runbook = parseRunbookDocument(content, path.basename(resolvedPath), {
          skipValidation: true,
        });
        const diagnostics = validateRunbook(runbook.steps);
        const errors = diagnostics.filter((d) => d.severity === 'error');
        const warnings = diagnostics.filter((d) => d.severity === 'warning');

        if (errors.length > 0) {
          // Emit structured data - renderer handles formatting
          output.detail(
            {
              valid: false,
              errors: errors.map((e) => ({ line: e.line, message: e.message })),
              warnings: warnings.map((w) => ({ line: w.line, message: w.message })),
            },
            'check',
          );
          output.flush();
          process.exit(1);
        }

        const stepCount = runbook.steps.length;
        const substepCount = countSubsteps(runbook.steps);

        // Emit structured data - renderer handles formatting
        output.detail(
          {
            valid: true,
            errors: [],
            warnings: warnings.map((w) => ({ line: w.line, message: w.message })),
            stats: { steps: stepCount, substeps: substepCount },
          },
          'check',
        );
        output.flush();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        output.detail(
          {
            valid: false,
            errors: [{ message }],
          },
          'check',
        );
        output.flush();
        process.exit(1);
      }
    });
}
