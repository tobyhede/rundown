import type { CallerEvidence } from './actor-context.js';
import type { ClaimId } from './claim-id.js';
import {
  type CommandTargetReader,
  type UnknownRunRefusal,
  resolveClaimTarget,
  unknownRunRefusal,
} from './command-target-resolver.js';
import type { RunId } from './run-id.js';
import type { RunbookState } from './types.js';

/**
 * Outcome of resolving the run a `rd delegate` invocation acts on.
 *
 * Discriminated on `kind`: `ok` carries the anchored run, `unknown_run` is the
 * `--run`-named-but-unresolvable refusal, `stale_claim` / `terminal_claim` are
 * the presented-claim refusals (each carrying the resolver's cause-specific,
 * redacted message), and `none` means no run is active.
 */
export type IssuanceAnchorResolution =
  | { readonly kind: 'ok'; readonly state: RunbookState }
  | UnknownRunRefusal
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly message: string;
    }
  | { readonly kind: 'none' };

/** Options for {@link resolveIssuanceAnchor}. */
export interface ResolveIssuanceAnchorOptions {
  /**
   * Typed caller evidence; a `claim_bearer` unambiguously names the run it
   * controls, so it anchors issuance when no `targetRunId` is supplied.
   */
  readonly callerEvidence: CallerEvidence;
  /**
   * Explicit run id from `--run`. Outranks the presented claim's controlled run
   * and the active default; a missing/foreign/terminal id refuses as
   * `unknown_run`.
   */
  readonly targetRunId?: RunId;
}

/**
 * Resolve the run a delegation issuance (or retry) anchors on.
 *
 * Precedence:
 *   1. `--run <id>`: the named session-stack member (a missing/foreign/terminal
 *      id refuses as `unknown_run`, carrying the same cause-specific message
 *      pass/complete refuse with).
 *   2. A presented bearer claim (no `--run`): the claim's controlled run,
 *      resolved via `resolveClaimTarget` — the same claim seam every transition
 *      command funnels through (`getActiveForClaimId` -> `record.controlledRunId`),
 *      reached directly here for its exhaustive return type. A claim
 *      unambiguously names its run, so `delegate --claim-id A` acts on A even
 *      when A is not the active default (#586). A claim that cannot anchor is
 *      the caller's real problem, so it refuses as `stale_claim` /
 *      `terminal_claim` carrying the resolver's cause-specific message rather
 *      than falling through to (3) and refusing against an unrelated run.
 *   3. The active default run (`none` when absent), for non-claim evidence.
 *
 * This is the single source of truth for delegate anchor selection. The core
 * issuance seam resolves through it once, pins the selected run id, then
 * performs state-dependent validation against the DelegationLock-scoped reread.
 *
 * @param reader - Read-side session dependency used to resolve runs and claims
 * @param options - Caller evidence and the optional explicit `--run` selector
 * @param options.callerEvidence - Typed caller evidence; a `claim_bearer` names its run
 * @param options.targetRunId - Explicit `--run` selector; `undefined` when not supplied
 * @returns The anchored run (`ok`); an `unknown_run` refusal for an unresolvable
 *   `--run`; a `stale_claim` / `terminal_claim` refusal carrying the claim
 *   resolver's cause-specific message; or `none` when no run is active
 */
export async function resolveIssuanceAnchor(
  reader: CommandTargetReader,
  options: ResolveIssuanceAnchorOptions,
): Promise<IssuanceAnchorResolution> {
  const { callerEvidence, targetRunId } = options;
  if (targetRunId !== undefined) {
    const member = await reader.resolveRunningStackMember(targetRunId);
    if (member.kind !== 'running') {
      return unknownRunRefusal(targetRunId, member);
    }
    return { kind: 'ok', state: member.state };
  }
  if (callerEvidence.kind === 'claim_bearer') {
    // The narrow claim seam, not `resolveCommandTarget`: same resolution logic,
    // but its three-kind union makes the `never` below a compile error if a new
    // claim outcome is ever added — the alternative is a silent fall-through to
    // the active default, which is the #586 defect this function exists to fix.
    const target = await resolveClaimTarget(reader, callerEvidence.claimId, {
      includeStashed: false,
    });
    switch (target.kind) {
      case 'claim':
        return { kind: 'ok', state: target.state };
      // A presented claim that cannot anchor is the operator's real problem.
      // Surface the resolver's cause-specific message (already redacted to the
      // claim key) instead of discarding it and refusing against an unrelated
      // active default.
      case 'stale_claim':
        return { kind: 'stale_claim', claimId: target.claimId, message: target.message };
      case 'terminal_claim':
        return {
          kind: 'terminal_claim',
          claimId: target.claimId,
          lifecycle: target.lifecycle,
          message: target.message,
        };
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  }
  const active = await reader.getActive();
  return active ? { kind: 'ok', state: active } : { kind: 'none' };
}
