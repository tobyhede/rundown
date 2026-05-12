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
 * ## Contract: per-channel failures resolve, not reject
 *
 * This actor **always resolves** with a record (possibly empty) under normal
 * filesystem conditions. Per-channel failures (missing files, non-UTF-8
 * payloads, empty files) are logged by {@link readCapturedOutputs} and the
 * channel is silently omitted from the result. The actor itself does NOT
 * reject for these conditions.
 *
 * The machine wiring relies on this contract. The `__capture` state in
 * `compiler.ts` routes `onError → #STOPPED` as a fail-closed branch for
 * **catastrophic** I/O failures only (out-of-memory, hard OS-level errors,
 * etc.). If this contract weakens — i.e. the actor starts rejecting on
 * per-channel failures — every benign missing channel will tear the runbook
 * down via `ARTIFACT_RESOLUTION_FAILED` / STOPPED. The reciprocal TSDoc on
 * the `__capture` state builder in `compiler.ts` references this contract
 * so the two surfaces stay in sync.
 *
 * @param input - Channels to read and result to pass through; supplied via
 *   `{ input: OutputCaptureInput }` at actor construction
 * @returns `{ variables, result }` — captured `{ name → value }` and the
 *   unchanged passthrough result
 * @throws {Error} Propagates unexpected runtime or I/O failures from
 *   `readCapturedOutputs`; the machine's `invoke.onError` handles this
 *   fail-closed path.
 */
export const outputCaptureActor = fromPromise<OutputCaptureOutput, OutputCaptureInput>(
  async ({ input }) => {
    const variables = await readCapturedOutputs(input.channels);
    return { variables, result: input.result };
  },
);
