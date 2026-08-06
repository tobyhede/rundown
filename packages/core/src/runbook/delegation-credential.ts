import type { VerifiedClaimAuthority } from './claim-id.js';
import { parseClaimBearer } from './claim-id.js';
import {
  deriveDelegationToken,
  generateDelegationIssuanceNonce,
  hashDelegationToken,
  type DelegationCredentialCoordinate,
  type DelegationCredentialDescriptor,
  type DelegationTokenHash,
} from './delegation-token.js';

/** Public coordinates known after delegation target validation. */
export type DelegationCredentialLocation = Omit<DelegationCredentialCoordinate, 'issuanceNonce'>;

/** In-memory credential material returned by an authorized issuer. */
export interface IssuedDelegationCredential {
  /** Plaintext bearer delivered only through an intentional output boundary. */
  readonly token: string;
  /** Persistable one-way lookup hash. */
  readonly tokenHash: DelegationTokenHash;
  /** Persistable non-secret reconstruction coordinates. */
  readonly credential: DelegationCredentialDescriptor;
}

/** Least-privilege runtime capability for issuing one delegation credential. */
export type DelegationCredentialIssuer = (
  location: DelegationCredentialLocation,
  supersedesTokenHash?: DelegationTokenHash,
) => IssuedDelegationCredential;

/** Least-privilege runtime capability for reproducing an existing credential. */
export type DelegationTokenDeriver = (descriptor: DelegationCredentialDescriptor) => string;

/**
 * Bind delegation credential derivation to one already verified claim authority.
 *
 * The returned callable closes over the claim secret, so neither the bearer nor
 * secret needs to enter machine context or persisted state.
 *
 * @param authority - Exact verified issuing claim bearer.
 * @returns A callable that derives only descriptors owned by that claim.
 * @throws {Error} Eagerly, when the authority's bearer encodes a different claim
 *   key than the authority names. The returned callable additionally throws when
 *   a descriptor names a different issuer claim, and propagates
 *   {@link deriveDelegationToken}'s rejection of a non-positive parent entry.
 */
export function createDelegationTokenDeriver(
  authority: VerifiedClaimAuthority,
): DelegationTokenDeriver {
  const parsed = parseClaimBearer(authority.claimId);
  if (parsed.claimKey !== authority.claimKey) {
    throw new Error('Verified claim authority does not match its bearer');
  }
  return (descriptor) => {
    if (descriptor.issuerClaimKey !== authority.claimKey) {
      throw new Error('Delegation credential belongs to a different issuer claim');
    }
    return deriveDelegationToken(parsed.secret, descriptor);
  };
}

/**
 * Bind fresh credential issuance to one already verified claim authority.
 *
 * Issuance derives through {@link createDelegationTokenDeriver}, so the bound
 * authority is validated once here rather than on every issuance, and the
 * returned issuer inherits that closure's remaining runtime failure modes.
 *
 * @param authority - Exact verified issuing claim bearer.
 * @param generateNonce - Public issuance nonce source.
 * @returns A callable that creates descriptor, token and hash together.
 * @throws {Error} Eagerly, when the authority's bearer encodes a different claim
 *   key than the authority names ('Verified claim authority does not match its
 *   bearer'), raised by {@link createDelegationTokenDeriver} before any issuer
 *   is returned. The returned issuer itself throws when `location.parentEntry`
 *   is not a positive safe integer, propagated from
 *   {@link deriveDelegationToken}.
 */
export function createDelegationCredentialIssuer(
  authority: VerifiedClaimAuthority,
  generateNonce: typeof generateDelegationIssuanceNonce = generateDelegationIssuanceNonce,
): DelegationCredentialIssuer {
  const derive = createDelegationTokenDeriver(authority);
  return (location, supersedesTokenHash) => {
    const credential: DelegationCredentialDescriptor = {
      version: 1,
      issuerClaimKey: authority.claimKey,
      issuanceNonce: generateNonce(),
      ...location,
      ...(supersedesTokenHash === undefined ? {} : { supersedesTokenHash }),
    };
    const token = derive(credential);
    return { token, tokenHash: hashDelegationToken(token), credential };
  };
}
