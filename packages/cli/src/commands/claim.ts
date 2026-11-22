// packages/cli/src/commands/claim.ts

import type { Command } from 'commander';
import {
  claimDelegation,
  InvalidRunSecretError,
  parseClaimTicket,
  RunbookStateManager,
  type ClaimTicket,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  commandStreamOptionsForOutputMode,
  createCliCommandServices,
} from '../services/execution.js';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import { createChildRunPreparer } from '../helpers/child-run-preparer.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { emitRunbookStarted } from '../helpers/runbook-pipeline.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import {
  driveRunProgression,
  progressionFailedClosed,
} from '../helpers/run-progression-adapters.js';

/**
 * Registers `rundown claim <ticket>` (#904, ADR 0005).
 *
 * The Claim Ticket is the command's only authority: core locates the
 * reservation by the ticket's hash and, in one transaction, verifies it is
 * still the parent's Current Child and inserts the child run under its
 * preallocated id. The child's Owner Token is printed once, as `owner_token`
 * on its `runbook_started` event, and the child's Run Progression starts
 * exactly as `rundown run`'s does. A second claim of the same ticket is
 * refused `ALREADY_CLAIMED`. `--agent-id` records the claiming agent on the
 * child, the identity a later `release` is matched against. The agent passes
 * it itself, and must pass the same id to `release`: no hook stamps it yet
 * (#907).
 *
 * @param program - Commander program instance to register the command on
 */
export function registerClaimCommand(program: Command): void {
  program
    .command('claim <ticket>')
    .description(
      'Claim a delegated child by its Claim Ticket and start it (prints its owner token)',
    )
    .option('--agent-id <id>', 'Identity of the claiming agent, recorded on the child')
    .option('--text', 'Output as human-readable text')
    .action(async (rawTicket: string, options: { agentId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'claim' });
          let ticket: ClaimTicket;
          try {
            ticket = parseClaimTicket(rawTicket);
          } catch (error) {
            if (!(error instanceof InvalidRunSecretError)) throw error;
            // Never echo the value: it may be a near-miss of a real secret.
            output.error(
              'Invalid ticket: expected a Claim Ticket of the form rdt_<43 base64url characters>, as printed in the children of a step_entered event.',
              'INVALID_SYNTAX',
            );
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
          const commandStreamOptions = commandStreamOptionsForOutputMode(options.text);
          const outcome = await claimDelegation(
            {
              manager,
              actorService: createCliRunbookActorService(
                manager,
                createCliCommandServices(commandStreamOptions),
              ),
              loadSteps: (state) => getRunbookFromState(state, cwd),
              prepareChildRun: createChildRunPreparer(cwd, output),
            },
            { ticket, ...(options.agentId !== undefined ? { agentId: options.agentId } : {}) },
          );
          if (outcome.kind === 'refused') {
            output.error(outcome.message, outcome.code);
            output.flush();
            process.exitCode = 1;
            return;
          }

          const { child } = outcome;
          const sink = createBridgedEmitter(child.state, output);
          emitRunbookStarted(
            sink,
            child.state,
            child.state.prompted,
            outcome.ownerToken,
            child.linkage?.kind === 'delegation'
              ? { runId: child.linkage.parentRunId, step: child.linkage.parentStep }
              : undefined,
          );
          const progression = await driveRunProgression(outcome.progression, {
            manager,
            cwd,
            output,
            sink,
            commandStreamOptions,
          });
          output.flush();
          if (progressionFailedClosed(progression)) process.exitCode = 1;
        },
        { text: options.text },
      );
    });
}
