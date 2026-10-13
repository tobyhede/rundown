// packages/cli/src/commands/release.ts

import type { Command } from 'commander';
import {
  CONCURRENT_MODIFICATION_CODE,
  isRunId,
  releaseDelegation,
  RunbookStateManager,
  type ReleaseDelegationOutcome,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { renderExecutionLeaseRefusal, renderRunFinished } from '../helpers/token-option.js';

/**
 * Registers `rundown release <child-id> [--agent-id <id>]` (#905, ADR 0005).
 *
 * A sub-agent that cannot finish the Delegation it claimed — for example
 * because it lost the child's Owner Token — ends it `abandoned` in the child's
 * own record, so its parent's Collect reads a definite result (a fail). The
 * authority is the agent id `rundown claim` recorded, matched by core (both
 * absent match); the plugin's hook stamps `--agent-id`. Release grants nothing
 * else and never touches the parent.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerReleaseCommand(program: Command): void {
  program
    .command('release <child-id>')
    .description('Abandon a delegated child you claimed but cannot finish (collected as a fail)')
    .option('--agent-id <id>', 'Identity of the releasing agent; must match the claim')
    .option('--text', 'Output as human-readable text')
    .action(async (rawId: string, options: { agentId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'release' });
          if (!isRunId(rawId)) {
            output.error('Invalid run id. Expected rd_<32 hex characters>.', 'INVALID_RUN_ID');
            output.flush();
            process.exitCode = 1;
            return;
          }
          if (options.agentId?.trim() === '') {
            output.error('--agent-id must not be empty.', 'INVALID_SYNTAX');
            output.flush();
            process.exitCode = 1;
            return;
          }
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
          const outcome = await releaseDelegation(
            {
              manager,
              actorService: createCliRunbookActorService(manager),
              loadSteps: (state) => getRunbookFromState(state, cwd),
            },
            {
              runId: rawId,
              ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
            },
          );
          if (outcome.kind !== 'released') {
            renderReleaseRefusal(output, outcome);
            output.flush();
            process.exitCode = 1;
            return;
          }
          const child = await manager.load(outcome.runId);
          if (child === null) throw new Error(`Run ${outcome.runId} vanished after its release`);
          createBridgedEmitter(child, output).emit({
            type: 'RUNBOOK_ABANDONED',
            payload: outcome.parent === undefined ? {} : { parent: outcome.parent },
          });
          output.flush();
        },
        { text: options.text },
      );
    });
}

/**
 * Render a refused release. Core decided every refusal and its wording.
 *
 * @param output - Output emitter for CLI output.
 * @param outcome - A non-`released` release outcome.
 * @throws {Error} When the outcome is outside the closed union.
 */
function renderReleaseRefusal(
  output: OutputEmitter,
  outcome: Exclude<ReleaseDelegationOutcome, { readonly kind: 'released' }>,
): void {
  switch (outcome.kind) {
    case 'run_finished':
      renderRunFinished(output, 'release', outcome.runId, outcome.lifecycle);
      return;
    case 'execution_in_progress':
    case 'execution_interrupted':
      renderExecutionLeaseRefusal(output, outcome);
      return;
    case 'concurrent_modification':
      output.error(outcome.message, CONCURRENT_MODIFICATION_CODE, { runId: outcome.runId });
      return;
    case 'refused':
      output.error(outcome.message, outcome.code);
      return;
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`unreachable release refusal: ${String(_exhaustive)}`);
    }
  }
}
