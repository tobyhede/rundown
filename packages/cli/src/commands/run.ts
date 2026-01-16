// packages/cli/src/commands/start.ts

import type { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  RunbookStateManager,
  parseRunbookDocument,
  RunbookSyntaxError,
  stepIdToString,
  parseStepIdFromString,
  isNodeError,
  getErrorMessage,
  printMetadata,
  printActionBlock,
  type PendingStep,
} from '@rundown/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import {
  runExecutionLoop,
  buildMetadata,
} from '../services/execution.js';

/**
 * Registers the 'run' command for starting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run [file]')
    .description('Run a runbook or queue a step')
    .option('--step <stepId>', 'Mark step as started (adds to pending queue)')
    .option('--agent <agentId>', 'Bind agent to pending step')
    .option('--prompted', 'Prompted mode: show commands without auto-executing')
    .action(async (file: string | undefined, options: { step?: string; agent?: string; prompted?: boolean }) => {
      try {
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);

        // Mode 1: --step - Push step to pending queue
        if (options.step && !options.agent) {
          const state = await manager.getActive();
          if (!state) {
            console.error('Error: No active runbook');
            process.exit(1);
          }

          const stepId = parseStepIdFromString(options.step);
          if (!stepId) {
            console.error(`Error: Invalid step ID format: ${options.step}`);
            console.error('Expected format: "3" or "3.1"');
            process.exit(1);
          }

          const pendingStep: PendingStep = {
            stepId,
            runbook: file
          };

          await manager.pushPendingStep(state.id, pendingStep);

          const runbookInfo = file ? ` with runbook ${file}` : '';
          console.log(`Step ${stepIdToString(stepId)} queued for agent binding${runbookInfo}`);
          return;
        }

        // Mode 2: File start (must come before Mode 3 to handle file + --agent case)
        if (file && !options.step) {
          const filePath = await resolveRunbookFile(cwd, file);

          if (!filePath) {
            console.error(`Error: Runbook not found: ${file}`);
            console.error(`Try 'rd ls --all' to list available runbooks.`);
            process.exit(1);
          }

          const content = await fs.readFile(filePath, 'utf8');
          const runbook = parseRunbookDocument(content, path.basename(filePath));

          if (runbook.steps.length === 0) {
            console.error('Error: Runbook has no steps');
            process.exit(1);
          }

          const runbookPath = path.isAbsolute(file) ? path.relative(cwd, file) : file;
          const state = await manager.create(runbookPath, runbook, {
            prompted: options.prompted,
            agentId: options.agent  // Pass agent ID
          });

          // Use pushRunbook instead of setActive
          await manager.pushRunbook(state.id, options.agent);

          if (runbook.steps[0].substeps && runbook.steps[0].substeps.length > 0) {
            await manager.initializeSubsteps(state.id, runbook.steps[0].substeps);
          }

          // Print metadata and action
          printMetadata(buildMetadata(state));
          printActionBlock({ action: 'START' });

          // Update lastAction
          await manager.update(state.id, { lastAction: 'START' });

          // Run execution loop (chains command steps automatically)
          // For new runbooks started without --agent, use default stack (no agentId)
          const result = await runExecutionLoop(manager, state.id, [...runbook.steps], cwd, !!options.prompted, undefined);

          if (result === 'stopped') {
            process.exit(1);
          }
          return;
        }

        // Mode 3: --agent - Bind agent to pending step
        if (options.agent) {
          const state = await manager.getActive();
          if (!state) {
            console.error('Error: No active runbook');
            process.exit(1);
          }

          const pending = await manager.popPendingStep(state.id);
          if (!pending) {
            console.error('Error: No pending step to bind');
            process.exit(1);
          }

          await manager.bindAgent(state.id, options.agent, pending.stepId);
          console.log(`Agent ${options.agent} bound to step ${stepIdToString(pending.stepId)}`);

          if (pending.runbook) {
            const runbookPath = await resolveRunbookFile(cwd, pending.runbook);
            if (!runbookPath) {
              console.error(`Error: Runbook file not found: ${pending.runbook}`);
              process.exit(1);
            }

            const content = await fs.readFile(runbookPath, 'utf8');
            const runbook = parseRunbookDocument(content, path.basename(runbookPath));

            if (runbook.steps.length === 0) {
              console.error('Error: Child runbook has no steps');
              process.exit(1);
            }

            // Inherit prompted flag from parent runbook
            const parentState = await manager.load(state.id);
            const parentPrompted = parentState?.prompted ?? false;

            const childState = await manager.create(pending.runbook, runbook, {
              agentId: options.agent,
              parentRunbookId: state.id,
              parentStepId: pending.stepId,
              prompted: parentPrompted  // Inherit from parent
            });

            await manager.updateAgentBinding(state.id, options.agent, {
              childRunbookId: childState.id
            });

            await manager.pushRunbook(childState.id, options.agent);

            // Print metadata and action
            printMetadata(buildMetadata(childState));
            printActionBlock({ action: 'START' });

            // Update lastAction
            await manager.update(childState.id, { lastAction: 'START' });

            // Run execution loop (chains command steps automatically)
            const result = await runExecutionLoop(manager, childState.id, [...runbook.steps], cwd, parentPrompted, options.agent);

            if (result === 'stopped') {
              process.exit(1);
            }
          }
          return;
        }

        if (!file && !options.step && !options.agent) {
          console.error('Error: Runbook file, --step, or --agent option required');
          process.exit(1);
        }
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          console.error(`Error: Runbook not found: ${file ?? 'unknown'}`);
          console.error(`Try 'rd ls --all' to list available runbooks.`);
        } else if (error instanceof RunbookSyntaxError) {
          console.error(`Syntax error: ${error.message}`);
        } else {
          console.error(`Error: ${getErrorMessage(error)}`);
        }
        process.exit(1);
      }
    });
}
