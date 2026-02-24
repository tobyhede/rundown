import type { Step, Substep } from '../runbook/types.js';

type RenderableItem = Step | Substep;

/**
 * Render a step or substep for CLI output.
 *
 * Generates a simplified Markdown representation optimized for CLI display.
 * Includes the heading, prompt, and command block while ignoring transitions
 * and nested runbook details that are not part of the CLI view.
 *
 * @param item - The Step or Substep to render
 * @param instanceNumber - Current instance number for step/substep display
 * @param _substepNumber - Current substep number for nested substep display
 * @param showCommand - Whether to include the command code block in the output
 * @returns Markdown string suitable for CLI output
 */
export function renderStepForCLI(
  item: Readonly<RenderableItem>,
  instanceNumber?: string,
  _substepNumber?: string,
  showCommand?: boolean,
): string {
  const lines: string[] = [];

  const isStep = 'name' in item;
  const id = isStep ? item.name : item.id;
  const description = item.description.trim();

  const headingPrefix = isStep ? '##' : '###';
  const headingId = isStep ? id : instanceNumber ? `${instanceNumber}.${id}` : id;
  const heading = description
    ? `${headingPrefix} ${headingId}. ${description}`
    : `${headingPrefix} ${headingId}`;

  lines.push(heading);

  if (item.prompt) {
    lines.push('');
    lines.push(item.prompt);
  }

  if (showCommand && item.command) {
    lines.push('');
    lines.push(`\`\`\`${item.command.lang ?? ''}`);
    lines.push(item.command.code);
    lines.push('```');
  }

  // Command is not rendered here - it's shown via printCommandExec() with colored prompt
  return lines.join('\n');
}
