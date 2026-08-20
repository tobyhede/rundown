// Both evasions at once: the older assertion node AND a qualified name. Covered
// separately because a rule can handle each independently and still miss the
// combination.
import type * as producer from '../../../src/runbook/execution-unit-entry.js';

declare const value: unknown;

/** Forged through both evasions at once: the older node and a qualified name. */
export const forged = <producer.RenderedUnitCommand>value;
