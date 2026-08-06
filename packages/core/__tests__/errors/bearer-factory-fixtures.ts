// packages/core/__tests__/errors/bearer-factory-fixtures.ts
//
// Shared fixtures for the two halves of the delegation-bearer redaction guard
// (#608 PR 12, F8): `token-redaction.test.ts` proves each listed factory
// truncates, and `token-redaction-coverage.source-text.test.ts` proves the list
// names every bearer-taking factory in `src/errors/factory.ts`. Both halves must
// read the SAME list or the pair guards nothing, and a test file may not export
// (biome `noExportsInTest`), so the list lives here.

import { Errors } from '../../src/errors/factory.js';
import type { RundownError } from '../../src/errors/rundown-error.js';

/**
 * A canonical bearer: `rdtk_` plus 32 RFC 4648 base32 characters.
 *
 * Deliberately a real, well-formed token rather than a sentinel — the redaction
 * helper is prefix- and length-sensitive, so a short stand-in would be returned
 * unchanged and the guard would pass without proving anything.
 */
// cspell:disable-next-line
export const FULL_BEARER = 'rdtk_A2B3C4D5E6F7G2H3J4K5L6M7N2P3Q4R5';

/** Parameter names that carry a raw delegation bearer. */
export const BEARER_PARAM_NAMES = ['token', 'bearer'];

/**
 * The factories that take a raw bearer, typed so the guard invokes them directly.
 *
 * Kept honest by the source-text half: the two must name the same set, so a
 * bearer factory added to `factory.ts` cannot ship without landing here and
 * being proved to truncate.
 */
export const BEARER_FACTORIES = {
  invalidToken: Errors.invalidToken,
  tokenNotFound: Errors.tokenNotFound,
  tokenCancelled: Errors.tokenCancelled,
} satisfies Record<string, (token: string) => RundownError>;
