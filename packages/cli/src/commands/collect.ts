// packages/cli/src/commands/collect.ts

import type { Command } from 'commander';
import { CONCURRENT_MODIFICATION_CODE, type LifecycleCollectOutcome } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { commandStreamOptionsForOutputMode } from '../services/execution.js';
import { buildLifecycleSeam } from '../helpers/lifecycle-seam-factory.js';
import { resolveCommandTarget } from '../helpers/command-target.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { transitionSinkFromEmitter } from '../helpers/transition-orchestrator.js';
import {
  driveRunProgression,
  progressionFailedClosed,
} from '../helpers/run-progression-adapters.js';
import {
  parseTokenOption,
  renderExecutionLeaseRefusal,
  renderOwnedRunRefusal,
  renderRunFinished,
  withTokenOption,
} from '../helpers/token-option.js';

/**
 * Registers `rundown collect --token <owner_token>` (#904, ADR 0005).
 *
 * The parent owner's read of its Current Children: core applies each terminal
 * Delegation of the run's active entry as one conditional commit and reports
 * every child (`collected`, `already_collected`, `pending`, `unclaimed`,
 * `cancelled`) on a `children_collected` event. When anything was applied,
 * Run Progression continues — announcing the next unit, or finishing the run
 * (and, for an Inline Child that delegates, Collecting it into its parent).
 * It is the only path by which a Delegation's result reaches its parent.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerCollectCommand(program: Command): void {
  withTokenOption(
    program
      .command('collect')
      .description("Collect the results of the run's current delegated children"),
  )
    .option('--text', 'Output as human-readable text')
    .action(async (options: { token?: string; run?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'collect' });
          const token = parseTokenOption(options, 'collect', output);
          if (token === undefined) return;
          const cwd = getCwd();
          const commandStreamOptions = commandStreamOptionsForOutputMode(options.text);
          const { manager, seam } = buildLifecycleSeam(cwd);

          const resolution = await resolveCommandTarget(
            { seam, manager, cwd, output, commandStreamOptions },
            token,
            'collect',
          );
          if (resolution.kind !== 'running') {
            if (renderOwnedRunRefusal(output, 'collect', resolution)) process.exitCode = 1;
            output.flush();
            return;
          }

          const outcome = await seam.runCollect({ run: resolution.run });
          if (outcome.kind !== 'collected') {
            renderCollectRefusal(output, outcome);
            output.flush();
            process.exitCode = 1;
            return;
          }

          const sink = createBridgedEmitter(resolution.run.state, output);
          sink.emit({ type: 'CHILDREN_COLLECTED', payload: { children: outcome.children } });
          const transitions = transitionSinkFromEmitter(sink);
          for (const event of outcome.events) {
            switch (event.type) {
              case 'ERROR_OCCURRED':
                transitions.onErrorOccurred?.(event.payload);
                break;
              case 'STEP_TRANSITIONED':
                transitions.onStepTransitioned(event.payload);
                break;
              case 'RUNBOOK_COMPLETED':
                transitions.onRunbookCompleted(event.payload);
                break;
              case 'RUNBOOK_STOPPED':
                transitions.onRunbookStopped(event.payload);
                break;
              default: {
                const _exhaustive: never = event;
                throw new Error(`unreachable transition observation: ${String(_exhaustive)}`);
              }
            }
          }
          if (outcome.progression.kind === 'activate') {
            const progression = await driveRunProgression(outcome.progression, {
              manager,
              cwd,
              output,
              sink,
              commandStreamOptions,
            });
            if (progressionFailedClosed(progression)) process.exitCode = 1;
          }
          output.flush();
        },
        { text: options.text },
      );
    });
}

/**
 * Render a refused Collect. Core decided every refusal and its wording.
 *
 * @param output - Output emitter for CLI output.
 * @param outcome - A non-`collected` Collect outcome.
 * @throws {Error} When the outcome is outside the closed union.
 */
function renderCollectRefusal(
  output: OutputEmitter,
  outcome: Exclude<LifecycleCollectOutcome, { readonly kind: 'collected' }>,
): void {
  switch (outcome.kind) {
    case 'run_finished':
      renderRunFinished(output, 'collect', outcome.runId, outcome.lifecycle);
      return;
    case 'execution_in_progress':
    case 'execution_interrupted':
      renderExecutionLeaseRefusal(output, outcome);
      return;
    case 'concurrent_modification':
      output.error(outcome.message, CONCURRENT_MODIFICATION_CODE, { runId: outcome.runId });
      return;
    case 'unknown_token':
      renderOwnedRunRefusal(output, 'collect', outcome);
      return;
    case 'refused':
      output.error(outcome.message, outcome.code);
      return;
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`unreachable collect refusal: ${String(_exhaustive)}`);
    }
  }
}
