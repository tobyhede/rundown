import { hashDelegationToken, type DelegationTokenHash } from './delegation-token.js';
import type { RunbookStateManager } from './state.js';
import type { FrameKey } from './targeting.js';
import type { RunbookState, StepDelegation } from './types.js';

/**
 * Result of scanning for a delegation token across persisted runs.
 */
export interface TokenScanResult {
  /** The parent runbook state containing the delegation. */
  readonly parentState: RunbookState;
  /** Step name that owns the delegation (e.g., "1"). */
  readonly stepId: string;
  /** Substep ID if delegation is on a substep. */
  readonly substepId?: string;
  /** Frame key from the substep state. */
  readonly frameKey: FrameKey;
  /** The delegation metadata. */
  readonly delegation: StepDelegation;
}

/**
 * Both token-index answers a retry locator needs, resolved from one scan.
 *
 * The two lookups are asked together and always about the same bearer, so they
 * are answered together: `current` matches `tokenHash`, `superseding` matches
 * `credential.supersedesTokenHash`. Keeping them one value is what makes the
 * single walk expressible without the caller re-deriving which walk produced
 * which half.
 */
export interface DelegationTokenScan {
  /** The delegation still carrying the token as its own bearer, if any. */
  readonly current: TokenScanResult | undefined;
  /**
   * Every delegation recording the token as superseded, in state-listing order.
   *
   * All of them, not the first: "more than one attempt records this bearer as
   * superseded" is a distinct condition the caller must refuse (RD-828).
   */
  readonly superseding: readonly TokenScanResult[];
}

/**
 * Service for scanning persisted runs to find delegation tokens.
 *
 * Scans all active run states to locate which parent step/substep owns
 * a given token hash, or to find orphaned child runs.
 */
export class DelegationScanService {
  /**
   * Create a new DelegationScanService.
   *
   * @param manager - State manager used to list and load persisted runs for scanning
   */
  constructor(private readonly manager: RunbookStateManager) {}

  /**
   * Build the five-field {@link TokenScanResult} for one delegated substep row.
   *
   * Single-sourced on purpose: a `stepId` derivation that drifted between
   * hand-written copies would report the same row under two different owner
   * steps depending on which lookup found it. Every scan below constructs its
   * rows here, whatever traversal reached them.
   *
   * @param state - Run state the row was found in.
   * @param substepId - Substep row id carrying the delegation.
   * @param frameKey - Frame the substep row is scoped to.
   * @param delegation - The persisted delegation.
   * @returns The scan result for that row.
   */
  #row(
    state: RunbookState,
    substepId: string,
    frameKey: FrameKey,
    delegation: StepDelegation,
  ): TokenScanResult {
    return {
      parentState: state,
      stepId: delegation.contextSnapshot.step ?? state.step,
      substepId,
      frameKey,
      delegation,
    };
  }

  /**
   * Walk every active run's delegated substep rows, collecting the ones a
   * predicate accepts.
   *
   * The single walk the single-predicate lookups below are expressed in; the
   * two-predicate {@link scanByTokenHash} walks separately so it can answer both
   * questions from one listing, and shares row construction through
   * {@link DelegationScanService.(#row:member)}.
   *
   * **Performance note:** `manager.list()` eagerly loads every persisted run.
   * This is acceptable because the expected number of concurrent active
   * runs is small (< 100). If active run counts grow significantly, consider
   * adding a `tokenHash → runId` index to avoid the full scan.
   *
   * @param matches - Predicate over a persisted delegation row.
   * @param stopAtFirst - Stop the walk as soon as one row matches.
   * @returns Matching rows in state-listing order; empty when none match.
   */
  async #scan(
    matches: (delegation: StepDelegation) => boolean,
    stopAtFirst: boolean,
  ): Promise<TokenScanResult[]> {
    const states = await this.manager.list();
    const found: TokenScanResult[] = [];

    for (const state of states) {
      for (const ss of state.substepStates ?? []) {
        const delegation = ss.delegation;
        if (delegation === undefined || !matches(delegation)) continue;
        found.push(this.#row(state, ss.id, ss.frameKey, delegation));
        if (stopAtFirst) return found;
      }
    }

    return found;
  }

  /**
   * Find the parent step that owns a delegation matching the given raw token.
   *
   * Hashes the token and performs an O(N) scan over all active persisted runs,
   * checking each state's substepStates for a matching tokenHash. Exits early on
   * the first match.
   *
   * @param rawToken - The plain-text delegation token
   * @returns The scan result with parent state and delegation info, or null
   */
  async findByToken(rawToken: string): Promise<TokenScanResult | null> {
    const hash = hashDelegationToken(rawToken);
    // `.at(0)`, not destructuring: `noUncheckedIndexedAccess` is off, so an
    // index read types as always-present and the `?? null` below would read as
    // dead code — while an empty scan still yields `undefined` at runtime.
    const match = (await this.#scan((delegation) => delegation.tokenHash === hash, true)).at(0);
    return match ?? null;
  }

  /**
   * Answer both token-index questions about one bearer from a single scan.
   *
   * {@link findByToken} matches `tokenHash` only, so a replayed retry naming a
   * bearer that has since been rotated away resolves to nothing there. The
   * companion question — which delegations record this bearer as *superseded* —
   * is asked of the same listing here rather than by a second lookup. The
   * supersession half is consulted unconditionally rather than as a fallback,
   * because skipping it on a hit would hide cross-run ambiguity in exactly the
   * case a current row also matches. Resolving both predicates in one walk also
   * guarantees the two halves observed the same listing rather than two
   * successive ones.
   *
   * `superseding` reports **all** matches rather than the first, because "more
   * than one attempt records this bearer as superseded" is a distinct condition
   * the caller must refuse (RD-828). It is unreachable by construction;
   * surfacing it as data is what lets the caller refuse rather than silently
   * resolve one of them.
   *
   * `current` keeps {@link findByToken}'s first-match semantics: the walk cannot
   * stop there, because `superseding` must be complete, but only the first
   * `tokenHash` match is reported so both entry points name the same owner.
   *
   * Same O(N) full-scan cost profile as {@link findByToken} — see the note on
   * {@link DelegationScanService.(#scan:member)}.
   *
   * @param tokenHash - Verifier of the delegation bearer being located.
   * @returns The current row (or `undefined`) and every superseding row.
   */
  async scanByTokenHash(tokenHash: DelegationTokenHash): Promise<DelegationTokenScan> {
    const states = await this.manager.list();
    let current: TokenScanResult | undefined;
    const superseding: TokenScanResult[] = [];

    for (const state of states) {
      for (const ss of state.substepStates ?? []) {
        const delegation = ss.delegation;
        if (delegation === undefined) continue;
        const isCurrent = delegation.tokenHash === tokenHash;
        const isSuperseding = delegation.credential.supersedesTokenHash === tokenHash;
        if (!isCurrent && !isSuperseding) continue;
        const row = this.#row(state, ss.id, ss.frameKey, delegation);
        if (isCurrent) current ??= row;
        if (isSuperseding) superseding.push(row);
      }
    }

    return { current, superseding };
  }

  /**
   * Find an orphaned child run that carries the given token hash in its linkage.
   *
   * Used during crash recovery: if the parent's childRunId wasn't set before
   * a crash, this locates the child run so it can be adopted.
   *
   * @param tokenHash - The SHA-256 hash of the delegation token
   * @returns The orphaned child RunbookState, or null
   */
  async findOrphanedChild(tokenHash: string): Promise<RunbookState | null> {
    const states = await this.manager.list();

    for (const state of states) {
      if (
        state.parentLinkage?.kind === 'delegation' &&
        state.parentLinkage.tokenHash === tokenHash
      ) {
        return state; // Early exit on first match — at most one orphan per token
      }
    }

    return null;
  }
}
