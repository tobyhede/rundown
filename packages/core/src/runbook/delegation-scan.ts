import { hashDelegationToken } from './delegation-token.js';
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
   * Find the parent step that owns a delegation matching the given raw token.
   *
   * Hashes the token and performs an O(N) scan over all active persisted runs
   * via `manager.list()`, checking each state's substepStates for a matching
   * tokenHash. Exits early on the first match.
   *
   * **Performance note:** `manager.list()` eagerly loads every persisted run.
   * This is acceptable because the expected number of concurrent active
   * runs is small (< 100). If active run counts grow significantly, consider
   * adding a `tokenHash → runId` index to avoid the full scan.
   *
   * @param rawToken - The plain-text delegation token
   * @returns The scan result with parent state and delegation info, or null
   */
  async findByToken(rawToken: string): Promise<TokenScanResult | null> {
    const hash = hashDelegationToken(rawToken);
    const states = await this.manager.list();

    for (const state of states) {
      const substepStates = state.substepStates ?? [];
      for (const ss of substepStates) {
        if (ss.delegation?.tokenHash === hash) {
          return {
            parentState: state,
            stepId: ss.delegation.contextSnapshot.step ?? state.step,
            substepId: ss.id,
            frameKey: ss.frameKey,
            delegation: ss.delegation,
          };
        }
      }
    }

    return null;
  }

  /**
   * Find every delegation that records the given raw token as superseded.
   *
   * {@link findByToken} matches `tokenHash` only, so a replayed retry naming a
   * bearer that has since been rotated away resolves to nothing there. This is
   * the companion lookup: it hashes the token and scans every active run's
   * substep states for a credential whose `supersedesTokenHash` matches.
   *
   * Returns **all** matches rather than the first, because "more than one
   * attempt records this bearer as superseded" is a distinct, refusable
   * condition (RD-828). It is unreachable by construction; surfacing it as data
   * is what lets the caller refuse rather than silently resolve one of them.
   *
   * Same O(N) full-scan cost profile as {@link findByToken} — see its
   * performance note.
   *
   * @param rawToken - The plain-text delegation token that may have been superseded.
   * @returns Every matching scan result, in state-listing order; empty when none match.
   */
  async findBySupersededToken(rawToken: string): Promise<readonly TokenScanResult[]> {
    const hash = hashDelegationToken(rawToken);
    const states = await this.manager.list();
    const matches: TokenScanResult[] = [];

    for (const state of states) {
      for (const ss of state.substepStates ?? []) {
        if (ss.delegation?.credential.supersedesTokenHash === hash) {
          matches.push({
            parentState: state,
            stepId: ss.delegation.contextSnapshot.step ?? state.step,
            substepId: ss.id,
            frameKey: ss.frameKey,
            delegation: ss.delegation,
          });
        }
      }
    }

    return matches;
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
