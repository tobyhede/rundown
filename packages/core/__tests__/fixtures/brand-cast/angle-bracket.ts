// The pre-JSX assertion syntax, still legal in `.ts`. A different AST node
// (`TSTypeAssertion`, not `TSAsExpression`), so a selector written for one is
// blind to the other.
import type { RenderedUnitCommand } from '../../../src/runbook/execution-unit-entry.js';

declare const value: unknown;

/** Forged through the pre-JSX assertion node rather than `as`. */
export const forged = <RenderedUnitCommand>value;
