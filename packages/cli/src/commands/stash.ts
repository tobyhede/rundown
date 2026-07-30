// packages/cli/src/commands/stash.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  describeSupersededClaim,
  redactClaimId,
  type ClaimId,
  type RunbookState,
  type StaleClaimRefusalCode,
  type StashForClaimIdResult,
} from '@rundown-org/core';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { renderSessionMutationRefusal } from '../helpers/session-mutation-result.js';

/** Symbolic codes `stash --claim-id` can refuse with. */
type StashRefusalCode = StaleClaimRefusalCode | 'ALREADY_STASHED';

/**
 * Map a non-success `stashForClaimId` result to its user-facing envelope.
 *
 * Mirrors `claimPopRefusal` in `pop.ts`, including its RD-825 handling: core
 * owns the superseded wording and code, so a superseded bearer carries the
 * no-retry signal rather than a generic unavailable envelope.
 *
 * @param claimId - Bearer the caller presented; only its redacted key is shown
 * @param result - The refusal arm returned by `stashForClaimId`
 * @returns Message and symbolic code for `OutputEmitter.error`
 */
function claimStashRefusal(
  claimId: ClaimId,
  result: Exclude<StashForClaimIdResult, { status: 'stashed' }>,
): { readonly message: string; readonly code: StashRefusalCode } {
  // User- and log-facing refusal: identify the claim by its non-secret lookup
  // key, never the bearer `claimId` (which carries the live secret segment).
  const claimKey = redactClaimId(claimId);
  const unavailable = (message: string) =>
    ({ message, code: 'CLAIMED_RUNBOOK_UNAVAILABLE' }) as const;
  switch (result.status) {
    case 'missing-claim':
      return unavailable(`Claim id ${claimKey} does not exist.`);
    case 'missing-child':
      return unavailable(
        `Claim id ${claimKey} no longer has readable child runbook state. Recover with \`rundown prune\` and restart from source.`,
      );
    case 'already-stashed':
      // Same wording the target resolver used before this path became atomic,
      // so a caller re-stashing its own parked run sees no change.
      return unavailable(
        `Claim id ${claimKey} is currently stashed. Run \`rundown pop\` with its claim id to resume.`,
      );
    case 'slot-occupied':
      return { message: 'A runbook is already stashed. Pop it first.', code: 'ALREADY_STASHED' };
    case 'terminal-child':
      return unavailable(`Claim id ${claimKey} points at a ${result.lifecycle} child runbook.`);
    case 'child-linkage-mismatch':
      return unavailable(`Claim id ${claimKey} is no longer linked to its child runbook.`);
    case 'parent-missing':
      return unavailable(`Claim id ${claimKey} parent runbook is missing.`);
    case 'superseded':
      return describeSupersededClaim(claimKey, result.reason);
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

/**
 * Registers the 'stash' command for pausing runbook enforcement.
 * @param program - Commander program instance to register the command on
 */
export function registerStashCommand(program: Command): void {
  program
    .command('stash')
    .description('Pause runbook enforcement, preserve state')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (options: { claimId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text, command: 'stash' });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;

          let state: RunbookState;
          if (claimTarget.claimId !== undefined) {
            // Bearer as mutation authority: core verifies it inside the same
            // transaction that writes the stash slot. Deliberately NOT
            // `resolveCommandTarget` — that resolves in a separate, unlocked
            // read, which is the #666 defect.
            const stashResult = await sessionService.stashForClaimId(claimTarget.claimId);
            if (stashResult.kind !== 'committed') {
              renderSessionMutationRefusal(output, stashResult);
              output.flush();
              process.exitCode = 1;
              return;
            }
            const stashed = stashResult.value;
            if (stashed.status !== 'stashed') {
              const refusal = claimStashRefusal(claimTarget.claimId, stashed);
              output.error(refusal.message, refusal.code);
              output.flush();
              process.exitCode = 1;
              return;
            }
            state = stashed.state;
          } else {
            const active = await sessionService.getActive();
            if (!active) {
              output.noActiveRunbook();
              output.flush();
              return;
            }
            const stashResult = await sessionService.stashRunbook(active.id);
            if (stashResult.kind !== 'committed') {
              renderSessionMutationRefusal(output, stashResult);
              output.flush();
              process.exitCode = 1;
              return;
            }
            if (stashResult.value === null) {
              output.error('A runbook is already stashed. Pop it first.', 'ALREADY_STASHED');
              output.flush();
              process.exitCode = 1;
              return;
            }
            state = active;
          }

          const totalSteps = await getStepTotal(cwd, state.runbook);

          // Emit structured output - TextRenderer handles stash action specially
          output.metadata(buildMetadata(state));
          output.status('stash', 'Runbook stashed', {
            position: {
              current: state.step,
              total: totalSteps,
            },
            stashedId: state.id,
          });
          output.flush();
        },
        { text: options.text },
      );
    });
}
