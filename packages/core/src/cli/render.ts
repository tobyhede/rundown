import type { Step } from '../workflow/types.js';

/**
 * Render step for CLI output.
 * Order: heading → prompts → command block
 * Excludes: transitions, substeps (not needed for CLI display)
 */
export function renderStepForCLI(step: Step): string {
  const lines: string[] = [];

  // Header - use step.name directly
  lines.push(`## ${step.name}. ${step.description}`);

  // Prompt (before command per spec)
  if (step.prompt) {
    lines.push('');
    lines.push(step.prompt);
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
