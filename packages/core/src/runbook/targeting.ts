import type { StepPosition } from '../cli/types.js';
import type { ForContext, RunbookState } from './types.js';

/**
 * Derive execution location notation for runtime targets.
 *
 * - Non-loop step/substep: `STEP.SUBSTEP` (for example, `2.1`)
 * - Loop-scoped step/substep: `STEP.INDEX.SUBSTEP` (for example, `1.2.1`)
 */
export function deriveExecutionAt(step: string, substep?: string, iteration?: number): string {
  if (iteration !== undefined) {
    return substep ? `${step}.${String(iteration)}.${substep}` : `${step}.${String(iteration)}`;
  }
  return substep ? `${step}.${substep}` : step;
}

/**
 * Derive execution location notation for a position payload.
 */
export function derivePositionAt(position: {
  current: string;
  substep?: string;
  for?: { index: number };
}): string {
  return deriveExecutionAt(position.current, position.substep, position.for?.index);
}

/**
 * Canonical runtime key for target identity.
 *
 * Format: `<step>|<substep-or-empty>|<iteration-or-empty>`
 */
export function buildTargetKey(step: string, substep?: string, iteration?: number): string {
  return `${step}|${substep ?? ''}|${iteration !== undefined ? String(iteration) : ''}`;
}

/**
 * Runtime frame identity key.
 *
 * Format: `<step>|<iteration-or-empty>`
 */
export function buildFrameKey(step: string, iteration?: number): string {
  return `${step}|${iteration !== undefined ? String(iteration) : ''}`;
}

/**
 * Runtime completion identity key.
 *
 * Format: `<frameKey>|<entry>|<substep-or-empty>`
 */
export function buildCompletionKey(frameKey: string, entry: number, substep?: string): string {
  return `${frameKey}|${String(entry)}|${substep ?? ''}`;
}

/**
 * Parse a completion key into frame/entry/substep components.
 */
export function parseCompletionKey(
  key: string,
): { frameKey: string; entry: number; substep?: string } | null {
  const parts = key.split('|');
  if (parts.length !== 4) return null;
  const [step, iterationRaw, entryRaw, substepRaw] = parts;
  if (!step || !entryRaw) return null;
  const entry = Number.parseInt(entryRaw, 10);
  if (!Number.isFinite(entry) || entry < 1) return null;
  const frameKey = `${step}|${iterationRaw ?? ''}`;
  return {
    frameKey,
    entry,
    ...(substepRaw ? { substep: substepRaw } : {}),
  };
}

/**
 * Get the active FOR context for the current step, if present.
 *
 * Implicit synthetic contexts are not exposed as loop scope.
 */
export function getActiveForContext(
  forStack: readonly ForContext[] | undefined,
  step: string,
): ForContext | undefined {
  if (!forStack || forStack.length === 0) return undefined;
  const top = forStack[forStack.length - 1];
  if (top.implicit || top.stepId !== step) return undefined;
  return top;
}

/**
 * Derive active runtime frame from persisted runbook state.
 */
export function deriveActiveFrame(state: RunbookState): {
  frameKey: string;
  step: string;
  iteration?: number;
} {
  const activeFor = getActiveForContext(state.forStack, state.step);
  return {
    frameKey: buildFrameKey(state.step, activeFor?.iteration),
    step: state.step,
    ...(activeFor ? { iteration: activeFor.iteration } : {}),
  };
}

/**
 * Build a StepPosition enriched with optional loop scope and expanded path.
 */
export function buildStepPosition(
  current: string,
  total: number,
  substep: string | undefined,
  forStack?: readonly ForContext[],
): StepPosition {
  const activeFor = getActiveForContext(forStack, current);

  return {
    current,
    total,
    ...(substep ? { substep } : {}),
    ...(activeFor
      ? {
          for: {
            index: activeFor.iteration,
            ...(activeFor.end !== undefined ? { end: activeFor.end } : {}),
          },
        }
      : {}),
  };
}
