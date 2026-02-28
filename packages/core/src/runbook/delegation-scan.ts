import { hashDelegationToken } from './delegation-token.js';
import type { RunbookStateManager } from './state.js';
import type { RunbookState, StepDelegation } from './types.js';

/**
 * Result of scanning for a delegation token across run state files.
 */
export interface TokenScanResult {
  /** The parent runbook state containing the delegation. */
  readonly parentState: RunbookState;
  /** Step name that owns the delegation (e.g., "1"). */
  readonly stepId: string;
  /** Substep ID if delegation is on a substep. */
  readonly substepId?: string;
  /** The delegation metadata. */
  readonly delegation: StepDelegation;
}

/**
 * Service for scanning run state files to find delegation tokens.
 *
 * Scans all active run states to locate which parent step/substep owns
 * a given token hash, or to find orphaned child runs.
 */
export class DelegationScanService {
  /**
   * Create a new DelegationScanService.
   *
   * @param manager - State manager used to list and load run state files for scanning
   */
  constructor(private readonly manager: RunbookStateManager) {}

  /**
   * Find the parent step that owns a delegation matching the given raw token.
   *
   * Hashes the token and performs an O(N) scan over all active run state files
   * via `manager.list()`, checking each state's substepStates for a matching
   * tokenHash. Exits early on the first match.
   *
   * **Performance note:** `manager.list()` eagerly loads and parses every state
   * file. This is acceptable because the expected number of concurrent active
   * runs is small (< 100). If active run counts grow significantly, consider
   * adding a `tokenHash → runId` index file to avoid the full scan.
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
            delegation: ss.delegation,
          };
        }
      }
    }

    return null;
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
      if (state.delegation?.tokenHash === tokenHash) {
        return state; // Early exit on first match — at most one orphan per token
      }
    }

    return null;
  }
}
