// `as unknown as T`, the standard way past a "neither type sufficiently overlaps"
// error and so the first thing reached for when a direct cast is refused. The
// outer assertion is a `TSAsExpression` like any other; what changes is that the
// operand is a `string`, which a direct cast would not accept.
import type { RenderedUnitCommand } from '../../../src/runbook/execution-unit-entry.js';

declare const value: string;

/** Forged from a `string`, which only the detour through `unknown` makes assignable. */
export const forged = value as unknown as RenderedUnitCommand;
