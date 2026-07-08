import type { Command } from 'commander';
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

/** Optional per-command help text for the transition-target flag pair. */
export interface TransitionTargetDescriptions {
  /** `--claim-id` help; defaults to the standard shared wording. */
  readonly claimId?: string;
  /** `--run` help; defaults to the standard shared wording. */
  readonly run?: string;
}

/**
 * Register `--claim-id` and `--run` on a command as an inseparable pair. This is
 * the single registrar of the transition-target flag pair: a command opts in
 * with one call and cannot register one flag of the pair without the other. The
 * whole-program single-source test asserts that `--run` appears only on commands
 * that register the pair, so the pair and its parser cannot drift apart.
 *
 * The registrar owns the *bonding*, not the copy: descriptions default to the
 * standard shared wording (matching what `pass`/`fail` and the selector commands
 * already display) and may be overridden per command where the standard wording
 * is inaccurate — notably `delegate`, whose `--claim-id` authorizes the issuing
 * run rather than "a claimed delegated child."
 *
 * @param command - The Commander command to register the option pair on.
 * @param descriptions - Optional per-command help overrides.
 * @returns The same command, for chaining.
 */
export function withTransitionTargetOptions(
  command: Command,
  descriptions?: TransitionTargetDescriptions,
): Command {
  return command
    .option(
      '--claim-id <claimId>',
      descriptions?.claimId ?? 'Target a claimed delegated child runbook',
    )
    .option('--run <runId>', descriptions?.run ?? 'Target a runbook by run id');
}
