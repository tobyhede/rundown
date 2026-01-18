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
 * @param instanceNumber - For dynamic steps/substeps, the current instance number (replaces {N})
 * @param substepNumber - For dynamic substeps, the current substep number (replaces {n})
 * @returns Markdown string suitable for CLI output
 */
export function renderStepForCLI(
  item: Readonly<RenderableItem>,
  instanceNumber?: string,
  substepNumber?: string
): string {
  const lines: string[] = [];

  const isStep = 'name' in item;
  const rawId = isStep ? item.name : item.id;
  let resolvedId = rawId;

  if (item.isDynamic) {
    if (isStep && instanceNumber) {
      resolvedId = rawId.replace('{N}', instanceNumber);
    } else if (!isStep && substepNumber) {
      resolvedId = rawId.replace('{n}', substepNumber);
    }
  }

  const headingPrefix = isStep ? '##' : '###';
  const heading = isStep
    ? `${headingPrefix} ${resolvedId}. ${item.description}`
    : `${headingPrefix} ${instanceNumber ? `${instanceNumber}.${resolvedId}` : resolvedId}. ${item.description}`;

  lines.push(heading);

  if (item.prompt) {
    let resolvedPrompt = item.prompt;
    if (instanceNumber) {
      resolvedPrompt = resolvedPrompt.replace(/\{N\}/g, instanceNumber);
    }
    if (substepNumber) {
      resolvedPrompt = resolvedPrompt.replace(/\{n\}/g, substepNumber);
    }
    lines.push('');
    lines.push(resolvedPrompt);
  }

  // Command is not rendered here - it's shown via printCommandExec() with colored prompt
  return lines.join('\n');
}
