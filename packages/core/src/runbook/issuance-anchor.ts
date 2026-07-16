import type { CallerEvidence } from './actor-context.js';
import {
  type CommandTargetReader,
  resolveCommandTarget,
  unknownRunRefusal,
} from './command-target-resolver.js';
import type { RunId } from './run-id.js';
import type { RunbookState } from './types.js';

/**
 * Outcome of resolving the run a `rd delegate` invocation acts on.
 *
 * Discriminated on `kind`: `ok` carries the anchored run, `unknown_run` is the
 * `--run`-named-but-unresolvable refusal, and `none` means no run is active.
 */
export type IssuanceAnchorResolution =
  | { readonly kind: 'ok'; readonly state: RunbookState }
  | { readonly kind: 'unknown_run'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'none' };

/**
 * Resolve the run a delegation issuance (or retry) anchors on.
 *
 * Precedence:
 *   1. `--run <id>`: the named session-stack member (a missing/foreign/terminal
 *      id refuses as `unknown_run`, carrying the same cause-specific message
 *      pass/complete refuse with).
 *   2. A presented bearer claim (no `--run`): the claim's controlled run,
 *      resolved via the same `resolveCommandTarget` seam every transition
 *      command uses (`getActiveForClaimId` -> `record.controlledRunId`). A claim
 *      unambiguously names its run, so `delegate --claim-id A` acts on A even
 *      when A is not the active default (#586). The divert is ADDITIVE — only a
 *      live `claim` resolution anchors here; a stale/terminal/stashed claim falls
 *      through to (3), where the unchanged authorization gate refuses it.
 *   3. The active default run (`none` when absent).
 *
 * This is the single source of truth for delegate anchor selection: the core
 * issuance seam resolves its target with it, and the CLI resolves the run its
 * Category-A preconditions (`--index` FOR-step validation, the inferred-retry
 * active-substep check) validate against. Both must agree — validating a
 * precondition against a different run than the seam acts on rejects valid
 * commands before the seam is reached.
 *
 * @param reader - Read-side session dependency used to resolve runs and claims
 * @param targetRunId - Explicit `--run` selector; `undefined` when not supplied
 * @param callerEvidence - Typed caller evidence; a `claim_bearer` names its run
 * @returns The anchored run, an `unknown_run` refusal, or `none`
 */
export async function resolveIssuanceAnchor(
  reader: CommandTargetReader,
  targetRunId: RunId | undefined,
  callerEvidence: CallerEvidence,
): Promise<IssuanceAnchorResolution> {
  if (targetRunId !== undefined) {
    const member = await reader.resolveRunningStackMember(targetRunId);
    if (member.kind !== 'running') {
      return unknownRunRefusal(targetRunId, member);
    }
    return { kind: 'ok', state: member.state };
  }
  if (callerEvidence.kind === 'claim_bearer') {
    const target = await resolveCommandTarget(reader, { claimId: callerEvidence.claimId });
    if (target.kind === 'claim') {
      return { kind: 'ok', state: target.state };
    }
  }
  const active = await reader.getActive();
  return active ? { kind: 'ok', state: active } : { kind: 'none' };
}
