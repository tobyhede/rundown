import { fromPromise } from 'xstate';
import { readCapturedOutputs, type PreparedChannel } from '../output-channels.js';

/**
 * Input shape for {@link outputCaptureActor}.
 */
export interface OutputCaptureInput {
  /** Pre-created channel files to read values from. */
  readonly channels: readonly PreparedChannel[];
}

/**
 * Machine-invoked actor that reads naked OUTPUT channel files and returns the
 * captured `{ name → value }` record.
 *
 * Establishes the Category B actor-factory pattern for the artifacts-as-variables
 * migration: a `fromPromise` over an existing pure side effect, invoked by the
 * machine via `invoke.src = 'outputCaptureActor'`. See the architectural principle
 * in `.work/artifacts-as-variables-batch-1-outputs-machine-invoke-pilot.md`.
 *
 * Resolution semantics: always resolves with a record (possibly empty). Channel
 * files that are missing, non-UTF-8, or empty are logged by `readCapturedOutputs`
 * and omitted from the result. The actor itself never rejects under normal
 * filesystem conditions; the machine's `onError` branch exists as a defensive
 * fail-closed contract for truly catastrophic I/O failures.
 *
 * @param input - Channels to read; supplied via `{ input: OutputCaptureInput }` at actor construction
 * @returns Record of variable names to trimmed UTF-8 values
 */
export const outputCaptureActor = fromPromise<Record<string, string>, OutputCaptureInput>(
  async ({ input }) => {
    return await readCapturedOutputs(input.channels);
  },
);
