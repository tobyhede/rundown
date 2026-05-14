import { fromPromise } from 'xstate';
import type { InitialTemplateVars } from '../effective-vars.js';
import { MAX_FILE_ITERATIONS } from '../for-iteration-constants.js';
import { ForResolutionError, resolveForValue } from '../source-resolver.js';
import type { ForContext, JsonValue } from '../types.js';

/** Discriminant for typed FOR resolution failures bubbled through onError. */
export type ForResolutionFailureCode =
  | 'undefined-variable'
  | 'type-mismatch'
  | 'parse-failure'
  | 'policy-violation';

/**
 * Input shape for {@link forIterateActor}.
 *
 * `templateVars` is the {@link InitialTemplateVars} seed established at runbook start.
 * It MUST NOT be a merged runtime variable view that includes captured OUTPUTS
 * or helper-side additions.
 */
export interface ForIterateInput {
  /** The current top-of-stack FOR frame to resolve. */
  readonly forContext: ForContext;
  /** Initial template variable seed, not the merged runtime variable view. */
  readonly templateVars: InitialTemplateVars;
  /** Project root for JsonArrayStream path containment. */
  readonly cwd: string;
}

/**
 * Discriminated output of {@link forIterateActor}.
 *
 * `ready` means a value is available for the current iteration. `exhausted`
 * means the data source has no value at the requested iteration index.
 */
export type ForIterateOutput =
  | {
      readonly kind: 'ready';
      readonly forIndex: number;
      readonly forValue: JsonValue;
      readonly total?: number;
    }
  | {
      readonly kind: 'exhausted';
      readonly forIndex: number;
    };

/**
 * Machine-invoked Category B actor that resolves the current FOR iteration value.
 *
 * The actor owns no persistence and makes no transition decisions. It adapts
 * {@link resolveForValue} into a typed `ready | exhausted` output consumed by
 * the compiler's `__resolve-iteration` child state.
 *
 * @param input - Current FOR frame plus closure-bound template seed and cwd.
 * @returns The resolved iteration value or an exhaustion signal.
 * @throws {ForResolutionError} Propagates resolver failures for the machine's
 * typed `FOR_RESOLUTION_FAILED` terminal path.
 */
// TODO(nested-FOR): the actor reads one top-of-stack frame. When nested FOR
// support lands, this input shape must be re-evaluated to pass all active frames.
export const forIterateActor = fromPromise<ForIterateOutput, ForIterateInput>(async ({ input }) => {
  const fc = input.forContext;

  if (fc.currentValue !== undefined) {
    return { kind: 'ready', forIndex: fc.iteration, forValue: fc.currentValue };
  }

  if (fc.implicit) {
    return { kind: 'ready', forIndex: fc.iteration, forValue: String(fc.iteration) };
  }

  // Defense in depth alongside hasMoreIterations(). Treat the safety cap as
  // clean source exhaustion, not a resolution failure.
  if (fc.iteration > MAX_FILE_ITERATIONS) {
    return { kind: 'exhausted', forIndex: fc.iteration };
  }

  const result = await resolveForValue(fc, input.templateVars, input.cwd);
  if (result.kind === 'resolved') {
    return {
      kind: 'ready',
      forIndex: result.context.iteration,
      forValue: result.context.currentValue,
      total: result.total,
    };
  }

  return { kind: 'exhausted', forIndex: result.capped.iteration };
});

export { ForResolutionError };
