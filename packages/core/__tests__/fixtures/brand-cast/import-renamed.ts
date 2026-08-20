// The gap a name-matching selector cannot close at any level of effort: the
// identifier at the assertion site is `Renamed`, chosen freely by whoever writes
// the import, so no enumeration of spellings of `RenderedUnitCommand` can
// anticipate it. The checker resolves it back to the same declared symbol.
import type { RenderedUnitCommand as Renamed } from '../../../src/runbook/execution-unit-entry.js';

declare const value: unknown;

/** Forged through an import rename, the spelling no selector can anticipate. */
export const forged = value as Renamed;
