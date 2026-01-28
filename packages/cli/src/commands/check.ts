import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import { parseRunbookDocument, validateRunbook, type ValidationError, type Step } from '@rundown-org/parser';
import { OutputEmitter } from '../services/output-emitter.js';

function formatErrors(errors: ValidationError[]): string {
  return errors
    .map(e => e.line ? `Line ${String(e.line)}: ${e.message}` : e.message)
    .join('\n');
}

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
    .action((file: string, options: { json?: boolean }) => {
      const output = new OutputEmitter({ json: options.json });

      // Resolve file path
      const resolvedPath = path.resolve(file);

      if (!fs.existsSync(resolvedPath)) {
        output.status(false, 'check', `FAIL: File not found: ${file}`, {
          valid: false,
          errors: [{ message: `File not found: ${file}` }]
        });
        output.flush();
        process.exit(1);
      }

      try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const runbook = parseRunbookDocument(content, path.basename(resolvedPath), { skipValidation: true });
        const errors = validateRunbook(runbook.steps);

        if (errors.length > 0) {
          const errorCount = errors.length;
          const errorMessage = `FAIL: ${String(errorCount)} error${errorCount > 1 ? 's' : ''}\n${formatErrors(errors)}`;
          output.status(false, 'check', errorMessage, {
            valid: false,
            errors: errors.map(e => ({ line: e.line, message: e.message }))
          });
          output.flush();
          process.exit(1);
        }

        const stepCount = runbook.steps.length;
        const substepCount = countSubsteps(runbook.steps);
        const statsMessage = substepCount > 0
          ? `PASS: ${String(stepCount)} step${stepCount > 1 ? 's' : ''}, ${String(substepCount)} substep${substepCount > 1 ? 's' : ''}`
          : `PASS: ${String(stepCount)} step${stepCount > 1 ? 's' : ''}`;

        output.status(true, 'check', statsMessage, {
          valid: true,
          errors: [],
          stats: { steps: stepCount, substeps: substepCount }
        });
        output.flush();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        output.status(false, 'check', `FAIL: ${message}`, {
          valid: false,
          errors: [{ message }]
        });
        output.flush();
        process.exit(1);
      }
    });
}
