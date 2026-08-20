// A qualified name. The annotation is a `TSQualifiedName`, so it has no
// `typeName.name` for a selector to match against.
import type * as producer from '../../../src/runbook/execution-unit-entry.js';

declare const value: unknown;

/** Forged through a qualified name, so the annotation carries no bare identifier. */
export const forged = value as producer.RenderedUnitCommand;
