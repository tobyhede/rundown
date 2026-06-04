// packages/cli/src/helpers/transition-command.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService, lifecycleToResult } from '@rundown-org/core';
import { getCwd } from './context.js';
import { withErrorHandling } from './wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  executeTransition,
  type ExplicitTarget,
  type TransitionConfig,
} from './transitions.js';
import { extractParentLinkage, handleParentCompletion } from './delegation-completion.js';
import { validateIndexRequiresStep } from './index-option.js';
import { parseClaimIdOption } from './claim-id-option.js';

/**
 * Definition for a transition command (pass / fail).
 *
 * Both `rd pass` and `rd fail` share an identical end-to-end flow — option
 * parsing, dependency validation, transition-context construction, transition
 * execution, parent-propagation handling, and exit-code assignment. The only
 * differences are a handful of labels and the transition-config factory.
 * Capturing those differences in this struct lets the registration helper
 * own the shared body in one place.
 */
export interface TransitionCommandDef {
  /** Command name as registered with commander (e.g. 'pass', 'fail'). */
  readonly name: string;
  /** Aliases for the command (e.g. ['yes', 'ok'] for pass, ['no'] for fail). */
  readonly aliases: readonly string[];
  /** Description shown in `--help`. */
  readonly description: string;
  /** Factory producing the transition config — invoked per action call. */
  readonly buildConfig: () => TransitionConfig;
  /** Label passed to `output.noActiveRunbook` (typically the command name). */
  readonly noActiveLabel: string;
}

/**
 * Register a transition command (pass/fail) on the commander program.
 *
 * Both commands share the same flow: parse options, build the transition
 * context, execute the transition, and propagate the outcome to the parent if
 * this run is a delegated child. Only the transition factory and a few labels
 * differ; this helper centralizes everything else so behavior stays in lock-step.
 *
 * @param program - Commander program instance to register the command on
 * @param def - Per-command definition supplying name, aliases, description,
 *   transition-config factory, and the `noActiveRunbook` label
 */
export function registerTransitionCommand(program: Command, def: TransitionCommandDef): void {
  program
    .command(def.name)
    .aliases([...def.aliases])
    .description(def.description)
    .option('--step <stepId>', 'Target specific substep')
    .option('--index <number>', 'FOR loop iteration to target (requires --step)')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(
      async (options: { step?: string; index?: string; claimId?: string; text?: boolean }) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: def.name });

            const depError = validateIndexRequiresStep(options.index, options.step);
            if (depError) {
              output.error(depError, 'INVALID_SYNTAX');
              output.flush();
              process.exit(1);
            }

            const cwd = getCwd();
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;

            // Idempotent confirm/conflict against a terminal claim tombstone.
            // A delegated child that ran to its natural end leaves its claim as
            // a `terminal` record (lifecycle encodes the result). The documented
            // post-work `rd pass --claim-id` lands here; confirm it instead of
            // erroring, and surface a genuine pass/fail mismatch distinctly.
            if (claimTarget.claimId !== undefined) {
              const sessionService = new SessionService(new RunbookStateManager(cwd));
              const resolution = await sessionService.getActiveForClaimId(claimTarget.claimId);
              if (resolution.status === 'terminal') {
                // Reuse core's mapping — the same signal the machine's
                // aggregation uses; do not re-derive inline.
                const childResult = lifecycleToResult(resolution.lifecycle);
                if (def.name === childResult) {
                  if (!options.text) {
                    output.json({
                      kind: def.name,
                      action: def.name,
                      status: 'already-resolved',
                      claimId: claimTarget.claimId,
                      lifecycle: resolution.lifecycle,
                    });
                  } else {
                    output.message(
                      `ALREADY ${def.name.toUpperCase()}  claim ${claimTarget.claimId} (child ${resolution.lifecycle})`,
                    );
                  }
                  output.flush();
                  return;
                }
                output.error(
                  `Claim ${claimTarget.claimId} already resolved as ${childResult}; cannot ${def.name} it.`,
                  'DELEGATION_RESULT_CONFLICT',
                );
                output.flush();
                process.exitCode = 1;
                return;
              }
            }

            const contextResult = await buildTransitionContext(output, cwd, {
              claimId: claimTarget.claimId,
            });
            switch (contextResult.kind) {
              case 'ready':
                break;
              case 'none':
                output.noActiveRunbook(def.noActiveLabel);
                output.flush();
                return;
              case 'stale_claim':
              case 'terminal_claim':
                output.error(contextResult.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
                output.flush();
                process.exitCode = 1;
                return;
              default: {
                const _exhaustive: never = contextResult;
                return _exhaustive;
              }
            }
            const ctx = contextResult.ctx;

            // Exit-code contract: when this runbook is a delegated child whose
            // terminal outcome is absorbed non-terminally by the parent (e.g.
            // the parent's FAIL transition is RETRY), the orchestrated workflow
            // is still progressing — `rd pass` / `rd fail` exits 0 so scripted
            // orchestrators can use exit codes as flow control. Exit 1 is
            // reserved for cases where the workflow has actually halted (parent
            // propagation also stopped, RETRY exhausted, or no parent linkage
            // and the local lifecycle is `stopped`).
            let shouldExitWithError = false;
            const config = def.buildConfig();
            const explicitTarget: ExplicitTarget | undefined = options.step
              ? { stepId: options.step, index: options.index }
              : undefined;

            const result = await executeTransition(ctx, config, explicitTarget);
            if (result === 'stopped') shouldExitWithError = true;

            // Parent propagation supersedes the local-stop signal:
            // 'handled'        → parent absorbed non-terminally (RETRY/CONTINUE).
            // 'stopped'        → parent also terminated (e.g. RETRY exhausted).
            // 'not-applicable' → keep the local signal unchanged.
            const freshState = await ctx.manager.load(ctx.state.id);
            if (freshState && extractParentLinkage(freshState)) {
              const isTerminal =
                freshState.lifecycle === 'completed' || freshState.lifecycle === 'stopped';
              if (isTerminal) {
                const propResult = freshState.lifecycle === 'completed' ? 'pass' : 'fail';
                const propagationResult = await handleParentCompletion(
                  freshState,
                  propResult,
                  cwd,
                  output,
                );
                if (propagationResult === 'handled') {
                  shouldExitWithError = false;
                } else if (propagationResult === 'stopped') {
                  shouldExitWithError = true;
                }
              }
            }
            if (shouldExitWithError) {
              process.exitCode = 1;
            }
          },
          { text: options.text },
        );
      },
    );
}
