// cspell:words injectivity injective canonicality
import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { MAX_FOR_BOUND } from '@rundown-org/parser';
import {
  assertDelegationIssuanceNonce,
  deriveDelegationToken,
  isDelegationToken,
  DELEGATION_TOKEN_PATTERN,
  TOKEN_PREFIX,
  type DelegationCredentialCoordinate,
  type DelegationIssuanceNonce,
} from '../../src/runbook/delegation-token.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import { buildFrameKey, isFrameKey, type FrameKey } from '../../src/runbook/targeting.js';
import { DelegationCredentialDescriptorSchema } from '../../src/schemas.js';
import { makeDelegationCredentialDescriptor } from '../../src/testing/delegation-fixtures.js';

/**
 * Properties of `deriveDelegationToken`, the security-critical primitive that
 * turns a verified claim secret plus public issuance coordinates into a bearer
 * delegation token.
 *
 * `delegation-token.test.ts` pins single points: one v1 test vector, one
 * hand-picked concatenation-collision pair, the `parentEntry === 1` boundary,
 * nonce distinctness. This suite asserts the same guarantees hold across the
 * input space rather than at those points.
 *
 * ## Which domain each property is stated over
 *
 * `deriveDelegationToken` takes RAW values -- nothing re-validates the branded
 * coordinate at the call boundary -- so the two domains answer different
 * questions, and each property is deliberately placed in one of them:
 *
 * - **Schema-valid domain** (`coordinateArb`, `adjacentCoordinateArb`): every
 *   field is a value the system can actually produce and persist -- a 43-char
 *   base64url `issuanceNonce` (`DelegationIssuanceNonceSchema`), an
 *   `rd_<32 hex>` `parentRunId` (`RunIdSchema`), a `<step>|<iteration?>`
 *   `parentFrameKey` (`FrameKeySchema`, via its owner `isFrameKey`), a non-empty
 *   `parentStepId`, and a `parentEntry` inside the `1..MAX_FOR_BOUND` band that
 *   `activeEntry` and `frameEntryCounts` are bounded to. Injectivity and secret
 *   sensitivity are stated here: they are claims about the credentials the
 *   system mints, and generating inputs it cannot mint would prove nothing about
 *   it. `generates only coordinates the persisted credential schema admits`
 *   holds the generators to that promise against the schema itself.
 * - **Full type domain** (`rawCoordinateArb`, `RAW_ADJACENT_POOL`): any string
 *   in any coordinate field, any positive safe integer entry. Output
 *   canonicality and the `parentEntry` guard are stated here, because both are
 *   unconditional contracts of the function signature rather than of the
 *   persisted schema -- a caller reaching this primitive with an unvalidated
 *   field must still get a canonical `rdtk_` token or an error, never a
 *   malformed token. Injectivity is stated a second time over raw fields
 *   because the empty string, which no schema admits, is the sharpest test of
 *   the length framing.
 *
 * ## Two domain edges excluded on purpose
 *
 * - **Secrets are drawn from the production bearer-secret shape** (32 random
 *   bytes rendered base64url: the `[A-Za-z0-9_-]{43}` secret segment of a
 *   `ClaimId`), never from `fc.string()`. HMAC zero-pads a key shorter than its
 *   64-byte block, so a secret and that same secret with a trailing NUL byte are
 *   literally the SAME HMAC key and derive the SAME token. "Distinct secrets
 *   derive distinct tokens" is therefore FALSE over arbitrary strings and true
 *   over the fixed-length, NUL-free domain the claim system actually mints --
 *   which is the claim worth pinning.
 * - **Coordinate fields exclude lone surrogates.** Coordinates are hashed as
 *   message content, so the key padding above does not apply to them, but
 *   `Buffer.from(value, 'utf8')` replaces every unpaired surrogate with U+FFFD:
 *   `'\uD800'` and `'\uD801'` encode identically and collide. Nothing the system
 *   produces can carry one (nonce and run id are ASCII by construction, frame
 *   keys and step ids come from parsed step names), so the injectivity
 *   properties are stated over well-formed strings. Canonicality is NOT
 *   restricted this way: `fc.string({ unit: 'binary' })` generates lone
 *   surrogates there on purpose, since a canonical token is owed for them too.
 */

const ENTRY_GUARD_MESSAGE = 'Invalid delegation parent entry: expected a positive safe integer';

/**
 * Brand a frame-key literal, refusing anything `FrameKeySchema` would reject.
 *
 * Keeps the hand-written adversarial pool inside the schema-valid domain by
 * construction rather than by a trailing assertion.
 *
 * @param value - Raw frame key literal.
 * @returns The branded frame key.
 * @throws {Error} When the literal is not a well-formed frame key.
 */
function asFrameKey(value: string): FrameKey {
  if (!isFrameKey(value)) {
    throw new Error(`Test pool contains a value FrameKeySchema rejects: ${value}`);
  }
  return value;
}

/** 32 random bytes as base64url -- the exact shape of a bearer claim's secret segment. */
const claimSecretArb: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('base64url'));

/**
 * A few fixed secrets mixed into secret samples so repeats occur.
 *
 * Two independently drawn 32-byte secrets never collide, so a sample of only
 * random secrets can never exercise "the same secret derives the same token":
 * the injective half of the secret property would be tested and the
 * deterministic half silently would not.
 */
const SECRET_POOL: readonly string[] = [0, 1, 2].map((fill) =>
  Buffer.alloc(32, fill).toString('base64url'),
);

const secretArb: fc.Arbitrary<string> = fc.oneof(fc.constantFrom(...SECRET_POOL), claimSecretArb);

const issuanceNonceArb: fc.Arbitrary<DelegationIssuanceNonce> = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => assertDelegationIssuanceNonce(Buffer.from(bytes).toString('base64url')));

const runIdArb: fc.Arbitrary<RunId> = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((bytes) => assertRunId(`rd_${Buffer.from(bytes).toString('hex')}`));

/** Step ids in the shapes the parser produces: "1", "1.1", "ErrorHandler". */
const stepIdArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/);

const parentEntryArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: MAX_FOR_BOUND });

const frameKeyArb: fc.Arbitrary<FrameKey> = fc
  .tuple(stepIdArb, fc.option(parentEntryArb, { nil: undefined }))
  .map(([step, iteration]) => buildFrameKey(step, iteration));

const coordinateArb: fc.Arbitrary<DelegationCredentialCoordinate> = fc.record({
  issuanceNonce: issuanceNonceArb,
  parentRunId: runIdArb,
  parentStepId: stepIdArb,
  parentFrameKey: frameKeyArb,
  parentEntry: parentEntryArb,
});

/**
 * Field values whose ADJACENT concatenations are ambiguous.
 *
 * Unframed, `'a' + 'ab|'` and `'aa' + 'b|'` both spell `'aab|'`, and
 * `'a|' + '123'`, `'a|1' + '23'`, `'a|12' + '3'` all spell `'a|123'`. Length
 * prefixing is exactly what keeps those apart. The existing example test hits
 * one such pair by hand; this pool makes the ambiguity dense enough to be
 * sampled rather than hoped for. Nonce and run id are fixed-length by schema and
 * so cannot participate in an ambiguous concatenation -- they are drawn from two
 * constants each purely so equal coordinates recur inside a sample.
 */
const ADJACENT_STEP_IDS: readonly string[] = ['a', 'aa', 'aab', 'ab', 'b', '1', '12', '123'];
const ADJACENT_FRAME_KEYS: readonly FrameKey[] = [
  'a|',
  'ab|',
  'b|',
  'aab|',
  'a|1',
  'a|12',
  'a|123',
  '1|',
  '1|2',
].map(asFrameKey);
const ADJACENT_ENTRIES: readonly number[] = [1, 2, 3, 12, 23, 123];
const NONCE_POOL: readonly DelegationIssuanceNonce[] = [0, 1].map((fill) =>
  assertDelegationIssuanceNonce(Buffer.alloc(32, fill).toString('base64url')),
);
const RUN_ID_POOL: readonly RunId[] = ['1', '2'].map((digit) =>
  assertRunId(`rd_${digit.repeat(32)}`),
);

const adjacentCoordinateArb: fc.Arbitrary<DelegationCredentialCoordinate> = fc.record({
  issuanceNonce: fc.constantFrom(...NONCE_POOL),
  parentRunId: fc.constantFrom(...RUN_ID_POOL),
  parentStepId: fc.constantFrom(...ADJACENT_STEP_IDS),
  parentFrameKey: fc.constantFrom(...ADJACENT_FRAME_KEYS),
  parentEntry: fc.constantFrom(...ADJACENT_ENTRIES),
});

/**
 * Raw values for the two ADJACENT variable-length fields (`parentStepId` and
 * `parentFrameKey`), outside the schema-valid domain.
 *
 * The empty string is the case length framing exists for and no schema admits
 * (`parentStepId` is `min(1)`; a frame key needs a non-empty step segment), so
 * it is reachable only through the raw entry point -- and it is the sharpest
 * ambiguity available: unframed, `'' + 'aab'`, `'a' + 'ab'`, `'aa' + 'b'` and
 * `'aab' + ''` are one and the same byte string.
 */
const RAW_ADJACENT_POOL: readonly string[] = ['', 'a', 'aa', 'aab', 'ab', 'b'];

/** Raw values for the fixed-length fields, kept narrow so the pool above repeats. */
const RAW_FIXED_POOL: readonly string[] = ['', '|', 'x', '1'];

const rawStringArb: fc.Arbitrary<string> = fc.string({ unit: 'binary', maxLength: 40 });

/** Any string in any field, any positive safe integer entry -- the raw signature domain. */
const rawCoordinateArb: fc.Arbitrary<DelegationCredentialCoordinate> = fc.record({
  issuanceNonce: rawStringArb.map((value) => value as DelegationIssuanceNonce),
  parentRunId: rawStringArb.map((value) => value as RunId),
  parentStepId: rawStringArb,
  parentFrameKey: rawStringArb.map((value) => value as FrameKey),
  parentEntry: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
});

/** Raw coordinates drawn from the ambiguity pools above. */
const rawPoolCoordinateArb: fc.Arbitrary<DelegationCredentialCoordinate> = fc.record({
  issuanceNonce: fc
    .constantFrom(...RAW_FIXED_POOL)
    .map((value) => value as DelegationIssuanceNonce),
  parentRunId: fc.constantFrom(...RAW_FIXED_POOL).map((value) => value as RunId),
  parentStepId: fc.constantFrom(...RAW_ADJACENT_POOL),
  parentFrameKey: fc.constantFrom(...RAW_ADJACENT_POOL).map((value) => value as FrameKey),
  parentEntry: fc.constantFrom(1, 2, 12),
});

/**
 * Assert a derived token is canonical by every published test of canonicality.
 *
 * @param token - Token returned by `deriveDelegationToken`.
 */
function expectCanonicalToken(token: string): void {
  expect(token).toMatch(DELEGATION_TOKEN_PATTERN);
  expect(isDelegationToken(token)).toBe(true);
  expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
  expect(token).toHaveLength(TOKEN_PREFIX.length + 32);
}

/**
 * Independent identity for a coordinate -- the injectivity oracle.
 *
 * Deliberately NOT the production encoding: JSON escaping is injective over the
 * field tuple while sharing no structure with length-prefixed UTF-8 framing, so
 * it disagrees with a derivation that dropped a field or concatenated fields
 * unframed. An oracle that re-implemented the production encoding would agree
 * with every such mutation and prove nothing.
 *
 * @param coordinate - Coordinate to identify.
 * @returns A string equal for exactly the coordinates that are field-wise equal.
 */
function coordinateKey(coordinate: DelegationCredentialCoordinate): string {
  return JSON.stringify([
    coordinate.issuanceNonce,
    coordinate.parentRunId,
    coordinate.parentStepId,
    coordinate.parentFrameKey,
    coordinate.parentEntry,
  ]);
}

/**
 * Assert coordinate and token stand in bijection across a whole sample.
 *
 * Checks both directions rather than the weaker "these two coordinates differ":
 * key-to-token must be a function (determinism -- an equal coordinate seen again
 * re-derives its earlier token) and token-to-key must be a function
 * (injectivity -- a token seen again came from the same coordinate). The pools
 * are narrow and the samples small, so equal and near-equal coordinates recur
 * within a single run and both directions are genuinely exercised.
 *
 * @param secret - Claim secret held fixed across the sample.
 * @param coordinates - Coordinates to derive tokens for.
 */
function expectCoordinateTokenBijection(
  secret: string,
  coordinates: readonly DelegationCredentialCoordinate[],
): void {
  const tokenByKey = new Map<string, string>();
  const keyByToken = new Map<string, string>();

  for (const coordinate of coordinates) {
    const key = coordinateKey(coordinate);
    const token = deriveDelegationToken(secret, coordinate);

    const priorToken = tokenByKey.get(key);
    if (priorToken === undefined) {
      tokenByKey.set(key, token);
    } else {
      expect(token).toBe(priorToken);
    }

    const priorKey = keyByToken.get(token);
    if (priorKey === undefined) {
      keyByToken.set(token, key);
    } else {
      expect(priorKey).toBe(key);
    }
  }

  expect(keyByToken.size).toBe(tokenByKey.size);
}

describe('deriveDelegationToken generator fidelity', () => {
  it('generates only coordinates the persisted credential schema admits', () => {
    fc.assert(
      fc.property(fc.oneof(coordinateArb, adjacentCoordinateArb), (coordinate) => {
        // A property over inputs the system cannot mint proves nothing about the
        // system, so the schema-valid generators are held to the persisted schema
        // itself rather than to a regex restated here.
        const parsed = DelegationCredentialDescriptorSchema.safeParse(
          makeDelegationCredentialDescriptor(coordinate),
        );
        expect(parsed.success).toBe(true);
        expect(isFrameKey(coordinate.parentFrameKey)).toBe(true);
        expect(coordinate.parentEntry).toBeLessThanOrEqual(MAX_FOR_BOUND);
      }),
      { numRuns: 200 },
    );
  });
});

describe('deriveDelegationToken determinism', () => {
  it('re-derives the same token for a structurally equal coordinate', () => {
    fc.assert(
      fc.property(secretArb, coordinateArb, (secret, coordinate) => {
        const first = deriveDelegationToken(secret, coordinate);
        // Rebuilt field by field in a different key order: derivation must be by
        // value, never by object identity or property insertion order.
        const second = deriveDelegationToken(secret, {
          parentEntry: coordinate.parentEntry,
          parentFrameKey: coordinate.parentFrameKey,
          parentStepId: coordinate.parentStepId,
          parentRunId: coordinate.parentRunId,
          issuanceNonce: coordinate.issuanceNonce,
        });

        expect(second).toBe(first);
      }),
      { numRuns: 200 },
    );
  });
});

describe('deriveDelegationToken injectivity across coordinates', () => {
  it('maps distinct schema-valid coordinates to distinct tokens', () => {
    fc.assert(
      fc.property(
        secretArb,
        // Weighted toward the adjacency pool: unconstrained coordinates almost
        // never land on an ambiguous concatenation, so an even mix would spend
        // most of its budget in the easy part of the space.
        fc.array(
          fc.oneof(
            { arbitrary: adjacentCoordinateArb, weight: 3 },
            { arbitrary: coordinateArb, weight: 1 },
          ),
          { minLength: 1, maxLength: 24 },
        ),
        expectCoordinateTokenBijection,
      ),
      { numRuns: 200 },
    );
  });

  it('maps distinct raw coordinates to distinct tokens, including empty fields', () => {
    fc.assert(
      fc.property(
        secretArb,
        fc.array(rawPoolCoordinateArb, { minLength: 1, maxLength: 24 }),
        expectCoordinateTokenBijection,
      ),
      { numRuns: 200 },
    );
  });

  it('separates coordinates that differ in exactly one field', () => {
    // The bijection properties above vary fields jointly; this one varies a
    // single field at a time, so no field can hide behind another's
    // contribution to the digest.
    fc.assert(
      fc.property(
        secretArb,
        adjacentCoordinateArb,
        adjacentCoordinateArb,
        (secret, base, other) => {
          const variants: readonly DelegationCredentialCoordinate[] = [
            base,
            { ...base, issuanceNonce: other.issuanceNonce },
            { ...base, parentRunId: other.parentRunId },
            { ...base, parentStepId: other.parentStepId },
            { ...base, parentFrameKey: other.parentFrameKey },
            { ...base, parentEntry: other.parentEntry },
          ];

          expectCoordinateTokenBijection(secret, variants);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('deriveDelegationToken secret sensitivity', () => {
  it('maps distinct claim secrets to distinct tokens at a fixed coordinate', () => {
    fc.assert(
      fc.property(
        fc.array(secretArb, { minLength: 1, maxLength: 16 }),
        coordinateArb,
        (secrets, coordinate) => {
          const secretByToken = new Map<string, string>();

          for (const secret of secrets) {
            const token = deriveDelegationToken(secret, coordinate);
            const priorSecret = secretByToken.get(token);
            if (priorSecret === undefined) {
              secretByToken.set(token, secret);
            } else {
              // A repeated token must come from the repeated secret, never from
              // a different one.
              expect(priorSecret).toBe(secret);
            }
          }

          expect(secretByToken.size).toBe(new Set(secrets).size);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('deriveDelegationToken output canonicality', () => {
  it('returns a canonical rdtk_ token for any raw coordinate', () => {
    fc.assert(
      fc.property(secretArb, rawCoordinateArb, (secret, coordinate) => {
        expectCanonicalToken(deriveDelegationToken(secret, coordinate));
      }),
      { numRuns: 200 },
    );
  });

  it('returns a canonical rdtk_ token for any arbitrary secret', () => {
    // Secrets are unconstrained here: canonicality holds for any HMAC key, and
    // only the injectivity claim needs the production secret domain.
    fc.assert(
      fc.property(rawStringArb, coordinateArb, (secret, coordinate) => {
        expectCanonicalToken(deriveDelegationToken(secret, coordinate));
      }),
      { numRuns: 200 },
    );
  });
});

describe('deriveDelegationToken parent entry guard', () => {
  const invalidEntryArb: fc.Arbitrary<number> = fc.oneof(
    fc.integer({ min: -MAX_FOR_BOUND, max: 0 }),
    fc.double({ min: -1e6, max: 1e6, noNaN: true }).filter((value) => !Number.isInteger(value)),
    // 0 and -0 are named rather than left to the range above: they are the only
    // values separating `< 1` from `< 0`, and a range generator reaches them
    // only by luck.
    fc.constantFrom(
      0,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MIN_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER + 1,
      2 ** 53,
      1e21,
      0.5,
      -0.5,
    ),
  );

  const validEntryArb: fc.Arbitrary<number> = fc.oneof(
    parentEntryArb,
    fc.constantFrom(1, 2, MAX_FOR_BOUND, MAX_FOR_BOUND + 1, Number.MAX_SAFE_INTEGER),
  );

  it('rejects every non-positive or non-safe-integer parent entry', () => {
    fc.assert(
      fc.property(secretArb, coordinateArb, invalidEntryArb, (secret, coordinate, parentEntry) => {
        expect(() => deriveDelegationToken(secret, { ...coordinate, parentEntry })).toThrow(
          ENTRY_GUARD_MESSAGE,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('accepts every positive safe integer parent entry', () => {
    fc.assert(
      fc.property(secretArb, coordinateArb, validEntryArb, (secret, coordinate, parentEntry) => {
        expectCanonicalToken(deriveDelegationToken(secret, { ...coordinate, parentEntry }));
      }),
      { numRuns: 300 },
    );
  });

  it('rejects at the boundary regardless of how the entry is written', () => {
    // 0 and 1 are the only integers the `< 1` comparison separates, so they are
    // the only draws that can tell it apart from `<= 0`, `< 0` or `< 2`. A
    // generator spread over a wide range effectively never revisits them.
    fc.assert(
      fc.property(
        secretArb,
        coordinateArb,
        fc.constantFrom(-1, 0, 1, 2),
        (secret, coordinate, parentEntry) => {
          const derive = (): string =>
            deriveDelegationToken(secret, { ...coordinate, parentEntry });

          if (parentEntry >= 1) {
            expectCanonicalToken(derive());
          } else {
            expect(derive).toThrow(ENTRY_GUARD_MESSAGE);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
