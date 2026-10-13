// packages/cli/src/commands/release.ts

import type { Command } from 'commander';
import {
  CONCURRENT_MODIFICATION_CODE,
  releaseDelegation,
  RunbookStateManager,
  type ReleaseDelegationOutcome,
} from '@rundown-org/core';
import { collectAgentId, resolveAgentIdOption } from '../helpers/agent-id-option.js';
import { getCwd } from '../helpers/context.js';
import { parseRunId } from '../helpers/run-option.js';
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
 * absent match); `--agent-id` given more than once is refused
 * `INVALID_SYNTAX`. In Claude Code the plugin's Bash hook stamps the
 * sub-agent's own `agent_id` on a plain `rundown release`, the same id it
 * stamped on `claim` (#907); elsewhere the agent passes the id its claim
 * used. Release grants nothing else
 * and never touches the parent; the running Inline Children the child composes
 * are abandoned with it.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerReleaseCommand(program: Command): void {
  program
    .command('release <child-id>')
    .description('Abandon a delegated child you claimed but cannot finish (collected as a fail)')
    .option(
      '--agent-id <id>',
      'Identity of the releasing agent; must match the claim (once)',
      collectAgentId,
    )
    .option('--text', 'Output as human-readable text')
    .action(async (rawId: string, options: { agentId?: string[]; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'release' });
          const runId = parseRunId(rawId, output);
          if (runId === undefined) return;
          const agent = resolveAgentIdOption('release', options.agentId, output);
          if (agent === undefined) return;
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
          const outcome = await releaseDelegation(
            {
              manager,
              actorService: createCliRunbookActorService(manager),
              loadSteps: (state) => getRunbookFromState(state, cwd),
            },
            { runId, agent },
          );
          if (outcome.kind !== 'released') {
            renderReleaseRefusal(output, outcome);
            output.flush();
            process.exitCode = 1;
            return;
          }
          // The child as the release committed it: never re-read, so a prune
          // of the now-finished row cannot turn a committed release into a
          // failure.
          createBridgedEmitter(outcome.state, output).emit({
            type: 'RUNBOOK_ABANDONED',
            payload: { parent: outcome.parent, abandonedInline: outcome.abandonedInline },
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
