// One hop through a local alias. The identifier at the assertion site is a name
// this repository has never seen, and the alias declaration is a different
// statement entirely — nothing at the cast site mentions the brand.
import type { RenderedUnitCommand } from '../../../src/runbook/execution-unit-entry.js';

type Laundered = RenderedUnitCommand;

declare const value: unknown;

export const forged = value as Laundered;
