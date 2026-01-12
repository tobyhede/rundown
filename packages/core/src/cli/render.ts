import type { Step } from '../workflow/types.js';

/**
 * Render step for CLI output.
 *
 * Generates a simplified Markdown representation of a step optimized
 * for CLI display. Includes heading, prompt, and command block.
 * Excludes transitions and substeps which are not needed for CLI display.
 *
 * @param step - The Step to render
 * @returns Markdown string suitable for CLI output
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
