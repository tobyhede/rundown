import { fromPromise } from 'xstate';
import type { EffectiveVars } from '../effective-vars.js';
import { ForResolutionError, resolveForValue } from '../source-resolver.js';
import type { FileSnapshot, ForContext, JsonValue } from '../types.js';

/** Discriminant for typed FOR resolution failures bubbled through onError. */
export type ForResolutionFailureCode =
  | 'undefined-variable'
  | 'type-mismatch'
  | 'parse-failure'
  | 'policy-violation'
  | 'drift-detected';

/**
 * Input shape for {@link forIterateActor}.
 *
 * `templateVars` is the {@link EffectiveVars} merged view at fire time:
 * the seeded `InitialTemplateVars` (CLI/init inputs, including
 * `JsonArrayStream` refs) layered with the runtime `context.variables`
 * accumulator (step OUTPUTS and ARTIFACTS resolutions). Mirrors the
 * precedence used by `{{ var }}` template expansion so FOR sources see
 * the same variable space.
 */
export interface ForIterateInput {
  /** The current top-of-stack FOR frame to resolve. */
  readonly forContext: ForContext;
  /** Merged effective variables: initial seed layered with runtime accumulator. */
  readonly templateVars: EffectiveVars;
  /**
   * Project root for JsonArrayStream path containment. May be `undefined`
   * for runbooks that only iterate in-memory `JsonArray` sources; file-backed
   * `JsonArrayStream` resolution fails closed inside `resolveFromJsonArrayStream`
   * when this is missing.
   */
  readonly cwd: string | undefined;
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
      readonly snapshot?: FileSnapshot;
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

  const result = await resolveForValue(fc, input.templateVars, input.cwd);
  if (result.kind === 'resolved') {
    return {
      kind: 'ready',
      forIndex: result.context.iteration,
      forValue: result.context.currentValue,
      total: result.total,
      snapshot: result.context.snapshot,
    };
  }

  return { kind: 'exhausted', forIndex: result.capped.iteration };
});

export { ForResolutionError };
