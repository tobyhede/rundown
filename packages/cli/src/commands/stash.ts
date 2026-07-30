// packages/cli/src/commands/stash.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
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
import { claimUnavailable, sharedClaimRefusal } from '../helpers/claim-refusal.js';

/** Symbolic codes `stash --claim-id` can refuse with. */
type StashRefusalCode = StaleClaimRefusalCode | 'ALREADY_STASHED';

/**
 * Map a non-success `stashForClaimId` result to its user-facing envelope.
 *
 * Only the two stash-specific arms are mapped here. The six arms `pop
 * --claim-id` refuses with identically are delegated to `sharedClaimRefusal`,
 * which is the single place that taxonomy is spelled. The `default` arm is what
 * keeps that delegation honest: an arm core adds to `StashForClaimIdResult` is
 * not covered by the grouped cases, so it fails to compile here rather than
 * being absorbed by the shared mapper.
 *
 * @param claimId - Bearer the caller presented; only its redacted key is shown
 * @param result - The refusal arm returned by `stashForClaimId`
 * @returns Message and symbolic code for `OutputEmitter.error`
 */
function claimStashRefusal(
  claimId: ClaimId,
  result: Exclude<StashForClaimIdResult, { status: 'stashed' }>,
): { readonly message: string; readonly code: StashRefusalCode } {
  switch (result.status) {
    case 'already-stashed':
      // Same wording the target resolver used before this path became atomic,
      // so a caller re-stashing its own parked run sees no change. Identifies
      // the claim by its non-secret lookup key, never the bearer `claimId`
      // (which carries the live secret segment).
      return claimUnavailable(
        `Claim id ${redactClaimId(claimId)} is currently stashed. Run \`rundown pop\` with its claim id to resume.`,
      );
    case 'slot-occupied':
      return { message: 'A runbook is already stashed. Pop it first.', code: 'ALREADY_STASHED' };
    case 'missing-claim':
    case 'missing-child':
    case 'terminal-child':
    case 'child-linkage-mismatch':
    case 'parent-missing':
    case 'superseded':
      return sharedClaimRefusal(claimId, result);
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
            // One transaction, for the same reason the claim path uses one:
            // `getActive()` followed by a separate stash write resolves the
            // target in an unlocked read, so a concurrent push parks a run the
            // caller never resolved. Core returns the state to render with.
            const stashResult = await sessionService.stash();
            if (stashResult.kind !== 'committed') {
              renderSessionMutationRefusal(output, stashResult);
              output.flush();
              process.exitCode = 1;
              return;
            }
            const stashed = stashResult.value;
            switch (stashed.status) {
              case 'stashed':
                state = stashed.state;
                break;
              case 'no-active-runbook':
                // A warning, not an error: exit 0, matching what the separate
                // `getActive()` read produced.
                output.noActiveRunbook();
                output.flush();
                return;
              case 'slot-occupied':
                output.error('A runbook is already stashed. Pop it first.', 'ALREADY_STASHED');
                output.flush();
                process.exitCode = 1;
                return;
              default: {
                const _exhaustive: never = stashed;
                return _exhaustive;
              }
            }
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
