// packages/core/__tests__/errors/token-redaction-coverage.source-text.test.ts
//
// Coverage half of the delegation-bearer redaction guard (#608 PR 12, F8).
//
// `token-redaction.test.ts` proves that every factory in its typed
// `BEARER_FACTORIES` table truncates. That is three instance tests unless
// something keeps the table complete — the defect this phase fixed was
// introduced by factories that already existed, and the next one will arrive on
// a factory that does not yet. So this file reads `src/errors/factory.ts` and
// asserts the table names exactly the factories whose parameter list declares a
// raw bearer. A new `Errors.somethingToken` fails HERE, and the only way to
// satisfy it is to add the factory to the table — at which point the sibling
// proves it truncates.
//
// Named `*.source-text.test.ts` because it reads a `src/**` file as a STRING.
// Inside Stryker's sandbox every mutate-matched source file is instrumented, so
// the parameter lists it scans are rewritten and the scan finds nothing — a hard
// dry-run abort, not a skipped assertion. `jest.config.shared.js` excludes this
// pattern in the sandbox and runs it normally. It asserts on source text, not
// behaviour, so it contributes nothing to mutation coverage; the behavioural
// half deliberately stays in a normally-named file.

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BEARER_FACTORIES, BEARER_PARAM_NAMES } from './bearer-factory-fixtures.js';

/** Absolute path to the factory module whose bearer parameters are guarded. */
const FACTORY_PATH = fileURLToPath(new URL('../../src/errors/factory.ts', import.meta.url));

/**
 * Names of the `Errors` factories that declare a bearer parameter, read from source.
 *
 * @returns Factory names whose parameter list names a raw bearer, in source order.
 */
function discoverBearerFactories(): string[] {
  const source = readFileSync(FACTORY_PATH, 'utf-8');
  const names: string[] = [];
  // Matches an object-literal factory entry: `name: (params): RundownError =>`.
  for (const match of source.matchAll(/^\s{2}(\w+):\s*\(([^)]*)\)/gm)) {
    const [, name, params] = match;
    const declared = params
      .split(',')
      .map((param) => param.trim().split(/[?:]/)[0].trim())
      .filter((param) => param.length > 0);
    if (declared.some((param) => BEARER_PARAM_NAMES.includes(param))) {
      names.push(name);
    }
  }
  return names;
}

describe('bearer-factory coverage of the redaction guard (#608 F8)', () => {
  const discovered = discoverBearerFactories();

  it('finds the known bearer factories (sanity: the scan is not vacuous)', () => {
    expect(discovered).toEqual(
      expect.arrayContaining(['invalidToken', 'tokenNotFound', 'tokenCancelled']),
    );
  });

  it('guards exactly the bearer factories declared in the factory source', () => {
    expect([...discovered].sort()).toEqual(Object.keys(BEARER_FACTORIES).sort());
  });
});
