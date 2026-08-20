// Inheritance rather than aliasing. `Laundered` is its own declared symbol — it is
// NOT the brand's symbol — so resolving the annotation to a declaration is not
// enough on its own; the rule has to walk base types as well.
import type { RenderedUnitCommand } from '../../../src/runbook/execution-unit-entry.js';

interface Laundered extends RenderedUnitCommand {}

declare const value: unknown;

/** Forged through a distinct symbol that merely inherits the brand. */
export const forged = value as Laundered;
