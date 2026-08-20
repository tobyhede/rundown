// The plain spelling. A `TSAsExpression` whose type annotation is the bare
// identifier — the only route the original name-matching selector caught.
import type { RenderedUnitCommand } from '../../../src/runbook/execution-unit-entry.js';

declare const value: unknown;

/** Forged by the plainest route: one `as` naming the brand directly. */
export const forged = value as RenderedUnitCommand;
