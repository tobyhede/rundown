import { fromPromise } from 'xstate';
import { readCapturedOutputs, type PreparedChannel } from '../output-channels.js';

/**
 * Result discriminant carried opaquely through the actor.
 *
 * The actor itself never branches on this value; it is passed through from
 * input to output unchanged so the machine's `onDone` transition can `raise`
 * the corresponding `PASS` or `FAIL` event without a context-resident
 * discriminant.
 */
export type OutputCapturePassthroughResult = 'pass' | 'fail';

/** Input shape for {@link outputCaptureActor}. */
export interface OutputCaptureInput {
  /** Pre-created channel files to read values from. */
  readonly channels: readonly PreparedChannel[];
  /** Command result, passed through to {@link OutputCaptureOutput} unchanged. */
  readonly result: OutputCapturePassthroughResult;
}

/** Resolved output of {@link outputCaptureActor}. */
export interface OutputCaptureOutput {
  /** Captured `{ name → value }` record. */
  readonly variables: Record<string, string>;
  /** The {@link OutputCaptureInput#result} value, unchanged. */
  readonly result: OutputCapturePassthroughResult;
}

/**
 * Machine-invoked actor that reads naked OUTPUT channel files and returns the
 * captured `{ name → value }` record alongside the input's `result` field,
 * passed through unchanged.
 *
 * The `result` passthrough is the structural mechanism by which the leaf's
 * `COMMAND_RESULT` discriminant reaches the nested `__capture` child's
 * `onDone`-raised `PASS`/`FAIL` event. The actor never branches on it.
 *
 * Resolution semantics: always resolves with a record (possibly empty). Channel
 * files that are missing, non-UTF-8, or empty are logged by `readCapturedOutputs`
 * and omitted from the result. The actor itself never rejects under normal
 * filesystem conditions; the machine's `onError` branch exists as a defensive
 * fail-closed contract for truly catastrophic I/O failures.
 *
 * @param input - Channels to read and result to pass through; supplied via
 *   `{ input: OutputCaptureInput }` at actor construction
 * @returns `{ variables, result }` — captured `{ name → value }` and the
 *   unchanged passthrough result
 */
export const outputCaptureActor = fromPromise<OutputCaptureOutput, OutputCaptureInput>(
  async ({ input }) => {
    const variables = await readCapturedOutputs(input.channels);
    return { variables, result: input.result };
  },
);
