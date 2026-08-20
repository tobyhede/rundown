// The brand reached as one constituent of a union. The annotation resolves to a
// `TSUnionType` whose own symbol is nothing, so the rule has to descend into
// constituents rather than stopping at the top-level type.
//
// `| undefined` and not `| never`: TypeScript normalises `T | never` back to `T`
// before the checker ever hands it over, so that spelling silently degrades into
// a duplicate of `direct-as.ts` and exercises no union code at all. It did, until
// deleting the rule's union branch failed to fail this test.
import type { RenderedUnitCommand } from '../../../src/runbook/execution-unit-entry.js';

declare const value: unknown;

export const forged = value as RenderedUnitCommand | undefined;
