// packages/cli/src/commands/retry.ts

import type { Command } from 'commander';
import { CONCURRENT_MODIFICATION_CODE, type LifecycleRetryOutcome } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { commandStreamOptionsForOutputMode } from '../services/execution.js';
import { buildLifecycleSeam } from '../helpers/lifecycle-seam-factory.js';
import { resolveCommandTarget } from '../helpers/command-target.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { validateIndexRequiresStep } from '../helpers/index-option.js';
import { parseTransitionTarget } from '../helpers/transitions.js';
import {
  parseTokenOption,
  renderExecutionLeaseRefusal,
  renderOwnedRunRefusal,
  renderRunFinished,
  withTokenOption,
} from '../helpers/token-option.js';

/**
 * Registers `rundown retry --token <owner_token> --step <substep> [--index]`
 * (#905, ADR 0005).
 *
 * The parent owner's recovery of a Delegation: core cancels the Current Child
 * of the named delegated substep and reserves a fresh one in its place with a
 * new Claim Ticket, through the machine in one conditional save. The fresh
 * child and its ticket are printed once, on a `delegation_retried` event; the
 * cancelled child's commands and its old ticket are refused
 * `DELEGATION_CANCELLED`. This is how a lost ticket, an unclaimed child or a
 * lost child token is recovered — there is no re-claim and no re-reveal.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerRetryCommand(program: Command): void {
  withTokenOption(
    program
      .command('retry')
      .description('Cancel a delegated child and reserve a fresh one with a new claim ticket'),
  )
    .option('--step <stepId>', 'The delegated substep to retry (required, e.g. 2.1)')
    .option('--index <number>', 'Current FOR loop iteration (requires --step)')
    .option('--text', 'Output as human-readable text')
    .action(
      async (options: {
        token?: string;
        run?: string;
        step?: string;
        index?: string;
        text?: boolean;
      }) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'retry' });
            const depError = validateIndexRequiresStep(options.index, options.step);
            if (depError !== undefined) {
              output.error(depError, 'INVALID_SYNTAX');
              output.flush();
              process.exitCode = 1;
              return;
            }
            const token = parseTokenOption(options, 'retry', output);
            if (token === undefined) return;
            const parsed = parseTransitionTarget(options.step, options.index);
            if (parsed.kind === 'invalid') {
              output.error(parsed.message, parsed.code);
              output.flush();
              process.exitCode = 1;
              return;
            }
            const cwd = getCwd();
            const { manager, seam } = buildLifecycleSeam(cwd);
            const resolution = await resolveCommandTarget(
              {
                seam,
                manager,
                cwd,
                output,
                commandStreamOptions: commandStreamOptionsForOutputMode(options.text),
              },
              token,
              'retry',
            );
            if (resolution.kind !== 'running') {
              if (renderOwnedRunRefusal(output, 'retry', resolution)) process.exitCode = 1;
              output.flush();
              return;
            }

            const outcome = await seam.runRetry({ run: resolution.run, target: parsed.target });
            if (outcome.kind !== 'retried') {
              renderRetryRefusal(output, outcome);
              output.flush();
              process.exitCode = 1;
              return;
            }
            const { child, cancelledRunId } = outcome;
            createBridgedEmitter(resolution.run.state, output).emit({
              type: 'DELEGATION_RETRIED',
              payload: {
                step: child.step,
                ...(child.index !== undefined ? { index: child.index } : {}),
                cancelledRunId,
                children: [child],
              },
            });
            output.flush();
          },
          { text: options.text },
        );
      },
    );
}

/**
 * Render a refused retry. Core decided every refusal and its wording.
 *
 * @param output - Output emitter for CLI output.
 * @param outcome - A non-`retried` retry outcome.
 * @throws {Error} When the outcome is outside the closed union.
 */
function renderRetryRefusal(
  output: OutputEmitter,
  outcome: Exclude<LifecycleRetryOutcome, { readonly kind: 'retried' }>,
): void {
  switch (outcome.kind) {
    case 'run_finished':
      renderRunFinished(output, 'retry', outcome.runId, outcome.lifecycle);
      return;
    case 'execution_in_progress':
    case 'execution_interrupted':
      renderExecutionLeaseRefusal(output, outcome);
      return;
    case 'invalid_step_target':
      output.error(outcome.message, 'INVALID_STEP');
      return;
    case 'concurrent_modification':
      output.error(outcome.message, CONCURRENT_MODIFICATION_CODE, { runId: outcome.runId });
      return;
    case 'unknown_token':
      renderOwnedRunRefusal(output, 'retry', outcome);
      return;
    case 'refused':
      output.error(outcome.message, outcome.code);
      return;
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`unreachable retry refusal: ${String(_exhaustive)}`);
    }
  }
}
