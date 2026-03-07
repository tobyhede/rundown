import type { StepPosition } from '../cli/types.js';
import type { ForContext, ResolvedCompletion, RunbookState, SubstepState } from './types.js';

/**
 * Derive execution location notation for runtime targets.
 *
 * - Non-loop step/substep: `STEP.SUBSTEP` (for example, `2.1`)
 * - Loop-scoped step/substep: `STEP.INDEX.SUBSTEP` (for example, `1.2.1`)
 *
 * @param step - Step identifier (e.g. "1", "ErrorHandler")
 * @param substep - Optional substep identifier within the step
 * @param iteration - Optional FOR loop iteration number
 * @returns Dot-separated location string (e.g. "2.1", "1.2.1")
 */
export function deriveExecutionAt(step: string, substep?: string, iteration?: number): string {
  if (iteration !== undefined) {
    return substep ? `${step}.${String(iteration)}.${substep}` : `${step}.${String(iteration)}`;
  }
  return substep ? `${step}.${substep}` : step;
}

/**
 * Derive execution location notation for a position payload.
 *
 * @param position - Position object with current step, optional substep and FOR context
 * @returns Dot-separated location string
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
 *
 * @param step - Step identifier
 * @param substep - Optional substep identifier
 * @param iteration - Optional FOR loop iteration number
 * @returns Pipe-delimited target key
 */
export function buildTargetKey(step: string, substep?: string, iteration?: number): string {
  return `${step}|${substep ?? ''}|${iteration !== undefined ? String(iteration) : ''}`;
}

/**
 * Runtime frame identity key.
 *
 * Format: `<step>|<iteration-or-empty>`
 *
 * @param step - Step identifier
 * @param iteration - Optional FOR loop iteration number
 * @returns Pipe-delimited frame key
 */
export function buildFrameKey(step: string, iteration?: number): string {
  return `${step}|${iteration !== undefined ? String(iteration) : ''}`;
}

/**
 * Runtime completion identity key.
 *
 * Format: `<frameKey>|<entry>|<substep-or-empty>`
 *
 * @param frameKey - Frame key from {@link buildFrameKey}
 * @param entry - Monotonic entry counter within the frame
 * @param substep - Optional substep identifier
 * @returns Pipe-delimited completion key
 */
export function buildCompletionKey(frameKey: string, entry: number, substep?: string): string {
  return `${frameKey}|${String(entry)}|${substep ?? ''}`;
}

/**
 * Parse a completion key into frame/entry/substep components.
 *
 * @param key - Pipe-delimited completion key to parse
 * @returns Parsed components, or null if the key format is invalid
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
  const frameKey = `${step}|${iterationRaw}`;
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
 *
 * @param forStack - Current FOR context stack
 * @param step - Step identifier to match against the top context
 * @returns The active FOR context, or undefined if none applies
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
 *
 * @param state - Current runbook state
 * @returns Frame key, step, and optional iteration for the active frame
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
 *
 * @param current - Current step identifier
 * @param total - Total number of numbered steps in the runbook
 * @param substep - Optional active substep identifier
 * @param forStack - Optional FOR context stack for loop scope
 * @returns StepPosition with loop and substep fields populated as needed
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

/**
 * Build a ResolvedCompletion with conditional optional fields and defaulted completedAt.
 *
 * @param fields - Completion fields; `targetSubstep`, `targetIteration`, and `completedAt` are optional
 * @returns A fully-formed ResolvedCompletion
 */
export function buildResolvedCompletion(fields: {
  agentId: string;
  result: 'pass' | 'fail';
  targetStep: string;
  targetSubstep?: string;
  targetIteration?: number;
  targetFrameKey: string;
  targetEntry: number;
  completedAt?: string;
}): ResolvedCompletion {
  return {
    agentId: fields.agentId,
    result: fields.result,
    targetStep: fields.targetStep,
    ...(fields.targetSubstep ? { targetSubstep: fields.targetSubstep } : {}),
    ...(fields.targetIteration !== undefined ? { targetIteration: fields.targetIteration } : {}),
    targetFrameKey: fields.targetFrameKey,
    targetEntry: fields.targetEntry,
    completedAt: fields.completedAt ?? new Date().toISOString(),
  };
}

/**
 * Find a SubstepState by `(id, frameKey)`.
 *
 * Strict match: both `id` and `frameKey` must equal.
 *
 * @param substepStates - Array of substep states to search
 * @param substepId - Substep ID to match
 * @param frameKey - Frame key to match
 * @returns The matching SubstepState, or undefined
 */
export function findSubstepState(
  substepStates: readonly SubstepState[],
  substepId: string,
  frameKey?: string,
): SubstepState | undefined {
  return substepStates.find((ss) => ss.id === substepId && ss.frameKey === frameKey);
}

/**
 * Map over substep states, applying a transform to entries matching `(id, frameKey)`.
 *
 * @param substepStates - Array of substep states
 * @param substepId - Substep ID to match
 * @param frameKey - Frame key to match
 * @param transform - Transform function applied to matching entries
 * @returns New array with transformed matching entries
 */
export function mapSubstepState(
  substepStates: readonly SubstepState[],
  substepId: string,
  frameKey: string | undefined,
  transform: (ss: SubstepState) => SubstepState,
): SubstepState[] {
  return substepStates.map((ss) =>
    ss.id === substepId && ss.frameKey === frameKey ? transform(ss) : ss,
  );
}
