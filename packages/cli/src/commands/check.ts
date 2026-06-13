import type { Command } from 'commander';
import { analyzeForSources, forSourceWarnings } from '@rundown-org/core';
import { OutputEmitter } from '../services/output-emitter.js';
import { loadAndParseRunbook } from '../helpers/runbook-pipeline.js';

/**
 * Registers the 'check' command for validating runbook files.
 * @param program - Commander program instance to register the command on
 */
export function registerCheckCommand(program: Command): void {
  program
    .command('check <file>')
    .description('Check a runbook file for errors')
    .option('--text', 'Output as human-readable text')
    .action(async (file: string, options: { text?: boolean }) => {
      const output = new OutputEmitter({ text: options.text, command: 'check' });
      const cwd = process.cwd();

      const result = await loadAndParseRunbook(file, cwd);

      if (!result.ok) {
        output.detail(
          {
            kind: 'check' as const,
            valid: false,
            errors: [{ message: result.error }],
          },
          'check',
        );
        output.flush();
        process.exit(1);
      }

      const { diagnostics, stats } = result;
      const errors = diagnostics.filter((d) => d.severity === 'error');
      const warnings = diagnostics.filter((d) => d.severity === 'warning');

      // SHOULD-level FOR-source diagnostics (language spec §8.2, §10.4): an
      // unsatisfiable source (neither declared nor produced) and a multi-ref
      // shared-binding warning. Derived from the same produced-name analysis as
      // the C1 launch deferral so the two tiers cannot disagree.
      const forWarnings = forSourceWarnings(
        analyzeForSources(result.runbook.steps, result.frontmatter),
      ).map((message) => ({ severity: 'warning' as const, message }));
      warnings.push(...forWarnings);

      if (errors.length > 0) {
        output.detail(
          {
            kind: 'check' as const,
            valid: false,
            errors: errors.map((e) => ({ line: e.line, message: e.message })),
            warnings: warnings.map((w) => ({ line: w.line, message: w.message })),
          },
          'check',
        );
        output.flush();
        process.exit(1);
      }

      output.detail(
        {
          kind: 'check' as const,
          valid: true,
          errors: [],
          warnings: warnings.map((w) => ({ line: w.line, message: w.message })),
          stats,
        },
        'check',
      );
      output.flush();
    });
}
