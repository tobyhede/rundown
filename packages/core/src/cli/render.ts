import type { Step, Substep } from '../runbook/types.js';
import { renderCodeFence, renderHeading } from '../runbook/renderer/primitives.js';

type RenderableItem = Step | Substep;

/**
 * Normalized display model for CLI step/substep rendering.
 */
export interface DisplayStepModel {
  /** Markdown heading depth: 2 for steps (##), 3 for substeps (###). */
  readonly headingLevel: 2 | 3;
  /** Qualified identifier shown in the heading (e.g. "3" or "3.1"). */
  readonly headingId: string;
  readonly description: string;
  readonly prompt?: string;
  readonly command?: {
    readonly code: string;
    /** Optional language tag for the fenced code block (e.g. "bash", "sql"). */
    readonly lang?: string;
  };
}

/**
 * Normalize a step or substep into a display model for CLI rendering.
 *
 * Converts runtime step/substep items into a format-only model so rendering
 * can stay branch-free.
 *
 * @param item - The Step or Substep to normalize
 * @param instanceNumber - Current instance number for step/substep display
 * @param showCommand - Whether to include the command code block in the output
 * @returns Normalized display model
 */
export function buildDisplayStepModel(
  item: Readonly<RenderableItem>,
  instanceNumber?: string,
  showCommand?: boolean,
): DisplayStepModel {
  const isStep = 'name' in item;
  const id = isStep ? item.name : item.id;
  return {
    headingLevel: isStep ? 2 : 3,
    headingId: isStep ? id : instanceNumber ? `${instanceNumber}.${id}` : id,
    description: item.description.trim(),
    ...(item.prompt ? { prompt: item.prompt } : {}),
    ...(showCommand && item.command
      ? {
          command: {
            code: item.command.code,
            ...(item.command.lang ? { lang: item.command.lang } : {}),
          },
        }
      : {}),
  };
}

/**
 * Render a normalized CLI display model.
 *
 * @param model - Normalized display model
 * @returns Markdown string suitable for CLI output
 */
export function renderStepForCLI(model: Readonly<DisplayStepModel>): string {
  const lines: string[] = [];
  lines.push(renderHeading(model.headingLevel, model.headingId, model.description, '. '));

  if (model.prompt) {
    lines.push('');
    lines.push(model.prompt);
  }

  if (model.command) {
    lines.push('');
    lines.push(renderCodeFence(model.command.code, model.command.lang));
  }

  return lines.join('\n');
}
