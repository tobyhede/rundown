import type { ClaimId, RunId } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';
import { parseClaimIdOption, rejectClaimRunCombination } from './claim-id-option.js';
import { parseRunOption } from './run-option.js';

/**
 * Which run a mutating command targets, and by what authority — one logical
 * parameter with three mutually exclusive shapes. Because there is no `both`
 * inhabitant, the illegal "claim-id AND run supplied together" state is
 * unrepresentable once the raw flags have been parsed.
 *
 * - `claim`: `--claim-id` bearer authority (the claim also identifies its run).
 * - `run`: `--run` read-only target selector; not mutation authority.
 * - `active`: neither flag; the implicit active run.
 */
export type TransitionTarget =
  | { readonly kind: 'claim'; readonly claimId: ClaimId }
  | { readonly kind: 'run'; readonly runId: RunId }
  | { readonly kind: 'active' };

/**
 * Parse the raw `--claim-id` / `--run` flag pair into a single
 * {@link TransitionTarget}. The only sanctioned path from the two flags to a
 * target: "both supplied" is a parse-time `INVALID_SYNTAX` that never reaches a
 * caller.
 *
 * Composes the atomic parsers to preserve the fixed precedence
 * (`INVALID_SYNTAX` → `INVALID_CLAIM_ID` → `INVALID_RUN_ID`) and their
 * side-effect contract: on any failure the relevant parser has already emitted
 * its diagnostic, flushed, and set `process.exitCode`; this returns `undefined`
 * and the caller bails.
 *
 * @param raw - Raw Commander option values (`claimId`, `run`), each `undefined`
 *   when absent.
 * @param output - Output emitter used by the atomic parsers to render failures.
 * @returns The parsed target, or `undefined` when a diagnostic has been emitted.
 */
export function parseTransitionTarget(
  raw: { readonly claimId?: string; readonly run?: string },
  output: OutputEmitter,
): TransitionTarget | undefined {
  if (rejectClaimRunCombination({ claimId: raw.claimId, run: raw.run, output })) {
    return undefined;
  }
  const claim = parseClaimIdOption(raw.claimId, output);
  if (!claim.ok) return undefined;
  const run = parseRunOption(raw.run, output);
  if (!run.ok) return undefined;
  if (claim.claimId !== undefined) return { kind: 'claim', claimId: claim.claimId };
  if (run.runId !== undefined) return { kind: 'run', runId: run.runId };
  return { kind: 'active' };
}

/**
 * Map a {@link TransitionTarget} into the optional `{ claimId?, runId? }` fields
 * consumed by core's command-context builders (which mirror core's
 * `CommandTargetSelector`). The single adapter from the union to the legacy
 * spread shape; because the union has no `both` inhabitant, at most one field is
 * ever present.
 *
 * @param target - The parsed transition target.
 * @returns Spreadable fields: `{ claimId }`, `{ runId }`, or `{}`.
 */
export function transitionTargetFields(target: TransitionTarget): {
  readonly claimId?: ClaimId;
  readonly runId?: RunId;
} {
  switch (target.kind) {
    case 'claim':
      return { claimId: target.claimId };
    case 'run':
      return { runId: target.runId };
    case 'active':
      return {};
  }
}
