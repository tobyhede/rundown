/**
 * Compile-time half of the entry-seam public-surface gate.
 *
 * Intentionally compile-only, following `runbook/xstate-patterns.typecheck.ts`:
 * `pnpm --filter @rundown-org/core check:types` evaluates the
 * `@ts-expect-error` directives below, and each one fails the build if the error
 * it expects stops occurring — which is exactly what happens when one of these
 * names returns to the barrel.
 *
 * Type-only names are erased at runtime, so the runtime suite in
 * `entry-seam-barrel.test.ts` cannot see them. It covers the value export
 * (`deriveStepEnteredEffect`); these three are the types it cannot reach. The
 * rationale for each is in that suite's header.
 *
 * Every name is referenced below, which is load-bearing rather than tidy: an
 * unreferenced type-only import can itself be an error on the import line, and
 * `@ts-expect-error` cannot tell one error from another. A directive satisfied
 * by "this import is unused" would pass whether or not the export exists, which
 * is the exact failure this file is meant to catch.
 *
 * The references live on interface properties, not type aliases. Aliasing
 * `RenderedUnitCommand` is itself banned outside its producing module — the alias
 * is how you launder the brand into a name no assertion selector recognises — and
 * a file asserting the type is unreachable has no business demonstrating the one
 * route around that.
 */

// @ts-expect-error - StepEntryMetadata is core-internal; the deriver's single-producer invariant depends on it
import type { StepEntryMetadata } from '../../src/index.js';
// @ts-expect-error - StepEntryObservationInput is core-internal, for the same reason
import type { StepEntryObservationInput } from '../../src/index.js';
// @ts-expect-error - RenderedUnitCommand is unnameable outside core so its brand cannot be asserted into existence
import type { RenderedUnitCommand } from '../../src/index.js';
import type { ExecutionUnitEntry } from '../../src/index.js';

/** Holds the three names the barrel must not carry. */
export interface UnreachableFromTheBarrel {
  /** Entry metadata the deriver consumes. */
  readonly metadata: StepEntryMetadata;
  /** Its observation input wrapper. */
  readonly input: StepEntryObservationInput;
  /** The provenance brand on a rendered command. */
  readonly command: RenderedUnitCommand;
}

/**
 * The positive control.
 *
 * `ExecutionUnitEntry` is the seam's public return type and MUST stay reachable.
 * Without this, deleting the whole `execution-unit-entry` export block would
 * satisfy every negative above.
 */
export interface ReachableFromTheBarrel {
  /** The classified entry `enterExecutionUnit` returns. */
  readonly entry: ExecutionUnitEntry;
}
