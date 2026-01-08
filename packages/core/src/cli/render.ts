import type { Step } from '../workflow/types.js';

/**
 * Render step for CLI output.
 * Order: heading → prompts → command block
 * Excludes: transitions, substeps (not needed for CLI display)
 */
export function renderStepForCLI(step: Step): string {
  const lines: string[] = [];

  // Header
  lines.push(`## ${String(step.number)}. ${step.description}`);

  // Prompts (before command per spec)
  for (const prompt of step.prompts) {
    lines.push('');
    lines.push(prompt.text);
  }

  // Command block
  if (step.command) {
    lines.push('');
    lines.push('```bash');
    lines.push(step.command.code);
    lines.push('```');
  }

  return lines.join('\n');
}
