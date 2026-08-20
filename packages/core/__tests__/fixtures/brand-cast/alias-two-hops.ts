// Two hops, which is the point: a rule that unwraps exactly one level of aliasing
// passes `local-type-alias.ts` and fails here. The checker's symbol resolution has
// no depth limit, so both must resolve to the same declaration.
import type { RenderedUnitCommand } from '../../../src/runbook/execution-unit-entry.js';

type First = RenderedUnitCommand;
type Second = First;

declare const value: unknown;

/** Forged two alias hops from the brand, past any single-level unwrap. */
export const forged = value as Second;
