import type { Step } from '../workflow/types.js';

/**
 * Render step for CLI output.
 *
 * Generates a simplified Markdown representation of a step optimized
 * for CLI display. Includes heading, prompt, and command block.
 * Excludes transitions and substeps which are not needed for CLI display.
 *
 * @param step - The Step to render
 * @param instanceNumber - For dynamic steps, the current instance number (replaces {N})
 * @param substepNumber - For dynamic substeps, the current substep number (replaces {n})
 * @returns Markdown string suitable for CLI output
 */
export function renderStepForCLI(step: Step, instanceNumber?: string, substepNumber?: string): string {
  const lines: string[] = [];

  // Resolve step name: replace {N} with instance number for dynamic steps
  const resolvedName = step.isDynamic && instanceNumber
    ? step.name.replace('{N}', instanceNumber)
    : step.name;

  // Header - use resolved name
  lines.push(`## ${resolvedName}. ${step.description}`);

  // Prompt (before command per spec)
  if (step.prompt) {
    // Substitute {N} and {n} in prompt text
    let resolvedPrompt = step.prompt;
    if (instanceNumber) {
      resolvedPrompt = resolvedPrompt.replace(/\{N\}/g, instanceNumber);
    }
    if (substepNumber) {
      resolvedPrompt = resolvedPrompt.replace(/\{n\}/g, substepNumber);
    }
    lines.push('');
    lines.push(resolvedPrompt);
  }

  // Command block
  if (step.command) {
    lines.push('');
    lines.push('```bash');
    // Substitute {N} and {n} in command code
    let resolvedCode = step.command.code;
    if (instanceNumber) {
      resolvedCode = resolvedCode.replace(/\{N\}/g, instanceNumber);
    }
    if (substepNumber) {
      resolvedCode = resolvedCode.replace(/\{n\}/g, substepNumber);
    }
    lines.push(resolvedCode);
    lines.push('```');
  }

  return lines.join('\n');
}
