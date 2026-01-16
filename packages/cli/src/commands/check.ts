import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import { parseRunbookDocument, validateRunbook, type ValidationError, type Step } from '@rundown/parser';
import { OutputManager } from '../services/output-manager.js';

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
      const output = new OutputManager({ json: options.json });
      const writer = output.getWriter();

      // Resolve file path
      const resolvedPath = path.resolve(file);

      if (!fs.existsSync(resolvedPath)) {
        if (output.isJson()) {
          writer.writeJson({ valid: false, errors: [{ message: `File not found: ${file}` }] });
        } else {
          writer.writeError(`FAIL: File not found: ${file}`);
        }
        process.exit(1);
      }

      try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const runbook = parseRunbookDocument(content, path.basename(resolvedPath), { skipValidation: true });
        const errors = validateRunbook(runbook.steps);

        if (errors.length > 0) {
          if (output.isJson()) {
            writer.writeJson({ 
              valid: false, 
              errors: errors.map(e => ({ line: e.line, message: e.message })) 
            });
          } else {
            writer.writeError(`FAIL: ${String(errors.length)} error${errors.length > 1 ? 's' : ''}\n`);
            writer.writeError(formatErrors(errors));
          }
          process.exit(1);
        }

        const stepCount = runbook.steps.length;
        const substepCount = countSubsteps(runbook.steps);

        if (output.isJson()) {
          writer.writeJson({
            valid: true,
            errors: [],
            stats: {
              steps: stepCount,
              substeps: substepCount
            }
          });
        } else {
          if (substepCount > 0) {
            writer.writeLine(`PASS: ${String(stepCount)} step${stepCount > 1 ? 's' : ''}, ${String(substepCount)} substep${substepCount > 1 ? 's' : ''}`);
          } else {
            writer.writeLine(`PASS: ${String(stepCount)} step${stepCount > 1 ? 's' : ''}`);
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (output.isJson()) {
          writer.writeJson({ valid: false, errors: [{ message }] });
        } else {
          writer.writeError(`FAIL: ${message}`);
        }
        process.exit(1);
      }
    });
}
