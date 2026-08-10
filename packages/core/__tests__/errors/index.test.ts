import { describe, it, expect } from '@jest/globals';
import * as errorsBarrel from '../../src/errors/index.js';
import type {
  ErrorCodeDefinition,
  ErrorCodeKey,
  ErrorContext,
  InvalidRunStateDefect,
  InvalidRunStateReason,
} from '../../src/errors/index.js';

/**
 * The errors barrel is this package's public error surface — `src/errors.ts`
 * re-exports it wholesale — so a symbol dropped here vanishes from
 * `@rundown-org/core` without any other file changing.
 *
 * It also had no test importing it *directly*: every suite reaches it through
 * `src/errors.js`, and jest's `--findRelatedTests` did not follow that
 * `export *` edge. A scoped mutation run over this file therefore aborted with
 * "No tests were executed" instead of reporting a result, so the one file whose
 * whole job is the public surface was the one the gate could not evaluate.
 */
describe('errors barrel', () => {
  it('exports exactly the runtime error surface', () => {
    expect(Object.keys(errorsBarrel).sort()).toEqual([
      'ErrorCategory',
      'ErrorCodes',
      'Errors',
      'RundownError',
    ]);
  });

  it('exports the type surface', () => {
    // Each annotation is the assertion: a dropped `export type` fails
    // `check:types` here rather than at some distant consumer. The runtime
    // expectations exist so the bindings are load-bearing and cannot be
    // stripped as unused.
    const defect: InvalidRunStateDefect = { runId: 'rd_x', reason: 'invalid_schema_version' };
    const reason: InvalidRunStateReason = defect.reason;
    const context: ErrorContext = { message: 'why' };
    const key: ErrorCodeKey = 'FILE_NOT_FOUND';
    const definition: ErrorCodeDefinition = errorsBarrel.ErrorCodes[key];

    expect([reason, context.message, definition.code]).toEqual([
      'invalid_schema_version',
      'why',
      'RD-101',
    ]);
  });
});
