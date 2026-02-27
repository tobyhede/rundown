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
  constructor(private readonly manager: RunbookStateManager) {}

  /**
   * Find the parent step that owns a delegation matching the given raw token.
   *
   * Hashes the token and scans all run states, checking substepStates
   * for a matching tokenHash.
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
            stepId: state.step,
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
        return state;
      }
    }

    return null;
  }
}
