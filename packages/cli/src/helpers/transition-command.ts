// packages/cli/src/helpers/transition-command.ts

import type { Command } from 'commander';
import { getCwd } from './context.js';
import { withErrorHandling } from './wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { runSeamTransition, type TransitionConfig } from './transitions.js';
import { extractParentLinkage, propagateChildTerminal } from './delegation-completion.js';
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
  /** Command name as registered with commander ('pass' or 'fail'). */
  readonly name: 'pass' | 'fail';
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

            const config = def.buildConfig();

            // The core lifecycle seam owns evidence mapping, target resolution,
            // policy gating (refusals), record/drain or send, inline-child
            // reactivation, and terminal release. The CLI keeps only Category-A
            // work: cursor parsing, output rendering, and the execution loop. The
            // seam renders refusals/applied events itself (inside runSeamTransition);
            // here we own the post-transition parent-propagation/exit-code contract.
            const { manager, applied, exitError } = await runSeamTransition(output, cwd, config, {
              ...(claimTarget.claimId !== undefined ? { claimId: claimTarget.claimId } : {}),
              ...(options.step !== undefined ? { step: options.step } : {}),
              ...(options.index !== undefined ? { index: options.index } : {}),
            });

            // Exit-code contract: when this runbook is a delegated child whose
            // terminal outcome is absorbed non-terminally by the parent (e.g.
            // the parent's FAIL transition is RETRY), the orchestrated workflow
            // is still progressing — `rd pass` / `rd fail` exits 0 so scripted
            // orchestrators can use exit codes as flow control. Exit 1 is
            // reserved for cases where the workflow has actually halted (parent
            // propagation also stopped, RETRY exhausted, or no parent linkage
            // and the local lifecycle is `stopped`).
            let shouldExitWithError = exitError;

            // Propagate this child's terminal outcome to its parent, dispatching
            // on linkage kind (Plan 5). Inline children drain and advance the
            // composing parent synchronously; delegation children report-only (the
            // delegating run collects later). For inline, if advancing the parent
            // reaches a STOP terminal the close exits 1; delegation reporting
            // returns 'reported' and never flips the exit code (the child's own
            // lifecycle, captured in `shouldExitWithError` above when it locally
            // STOPped, governs). Re-pointed at the seam outcome's runId (reloaded
            // via the same manager) now that the resolve/drive lives in core.
            if (applied) {
              const freshState = await manager.load(applied.runId);
              const linkage = freshState ? extractParentLinkage(freshState) : undefined;
              if (freshState && linkage) {
                const isTerminal =
                  freshState.lifecycle === 'completed' || freshState.lifecycle === 'stopped';
                if (isTerminal) {
                  const propResult = freshState.lifecycle === 'completed' ? 'pass' : 'fail';
                  const propagation = await propagateChildTerminal(
                    freshState,
                    propResult,
                    cwd,
                    output,
                  );
                  if (linkage.kind === 'inline') {
                    shouldExitWithError = propagation === 'stopped';
                  } else if (propagation === 'stopped') {
                    shouldExitWithError = true;
                  }
                }
              }
            }
            if (shouldExitWithError) {
              process.exitCode = 1;
            } else {
              // Clear any non-zero code set earlier in this command (e.g. by an
              // inline child's own STOP) when the parent HANDLES that failure
              // (FAIL ANY CONTINUE): a handled failure must exit 0.
              process.exitCode = undefined;
            }
          },
          { text: options.text },
        );
      },
    );
}
