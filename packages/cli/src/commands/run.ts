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
  printMetadata,
  printActionBlock,
  type PendingStep,
} from '@rundown-org/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import {
  runExecutionLoop,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputManager } from '../services/output-manager.js';

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
    .option('--json', 'Output as JSON')
    .action(async (file: string | undefined, options: { step?: string; agent?: string; prompted?: boolean; json?: boolean }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);
        const output = new OutputManager({ json: options.json });

        // Mode 1: --step - Push step to pending queue
        if (options.step && !options.agent) {
          const state = await manager.getActive();
          if (!state) {
            throw new Error('No active runbook');
          }

          const stepId = parseStepIdFromString(options.step);
          if (!stepId) {
            throw new Error(`Invalid step ID format: ${options.step}. Expected format: "3" or "3.1"`);
          }

          const pendingStep: PendingStep = {
            stepId,
            runbook: file
          };

          await manager.pushPendingStep(state.id, pendingStep);

          if (output.isJson()) {
            output.getWriter().writeJson({ action: 'step_queued', stepId: stepIdToString(stepId), runbook: file });
            return;
          }

          const runbookInfo = file ? ` with runbook ${file}` : '';
          console.log(`Step ${stepIdToString(stepId)} queued for agent binding${runbookInfo}`);
          return;
        }

        // Mode 2: File start (must come before Mode 3 to handle file + --agent case)
        if (file && !options.step) {
          const filePath = await resolveRunbookFile(cwd, file);

          if (!filePath) {
            throw new Error(`Runbook not found: ${file}. Try 'rd ls --all' to list available runbooks.`);
          }

          const content = await fs.readFile(filePath, 'utf8');
          const runbook = parseRunbookDocument(content, path.basename(filePath));

          if (runbook.steps.length === 0) {
            throw new Error('Runbook has no steps');
          }

          const runbookPath = path.relative(cwd, filePath);
          const state = await manager.create(file, runbook, {
            runbookPath,
            prompted: options.prompted,
            agentId: options.agent  // Pass agent ID
          });

          await manager.pushRunbook(state.id, options.agent);

          if (runbook.steps[0].substeps && runbook.steps[0].substeps.length > 0) {
            await manager.initializeSubsteps(state.id, runbook.steps[0].substeps);
            // Set the current substep to the first substep
            await manager.update(state.id, { substep: runbook.steps[0].substeps[0].id });
          }

          const metadata = buildMetadata(state);

          if (output.isJson()) {
            output.getWriter().writeJson({
              action: 'started',
              runbook: metadata,
              currentStep: { index: state.step }
            });
            return;
          }

          // Print metadata and action
          printMetadata(metadata);
          printActionBlock({ action: 'START' });

          // Update lastAction
          await manager.update(state.id, { lastAction: 'START' });

          // Run execution loop (chains command steps automatically)
          // For new runbooks started without --agent, use default stack (no agentId)
          const result = await runExecutionLoop(manager, state.id, [...runbook.steps], cwd, !!options.prompted, undefined);

          if (result === 'stopped') {
            throw new Error('Runbook stopped');
          }
          return;
        }

        // Mode 3: --agent - Bind agent to pending step
        if (options.agent) {
          const state = await manager.getActive();
          if (!state) {
            throw new Error('No active runbook');
          }

          const pending = await manager.popPendingStep(state.id);
          if (!pending) {
            throw new Error('No pending step to bind');
          }

          await manager.bindAgent(state.id, options.agent, pending.stepId);

          if (output.isJson()) {
            output.getWriter().writeJson({ action: 'agent_bound', agent: options.agent, stepId: stepIdToString(pending.stepId) });
          } else {
            console.log(`Agent ${options.agent} bound to step ${stepIdToString(pending.stepId)}`);
          }

          if (pending.runbook) {
            const runbookPath = await resolveRunbookFile(cwd, pending.runbook);
            if (!runbookPath) {
              throw new Error(`Runbook file not found: ${pending.runbook}`);
            }

            const content = await fs.readFile(runbookPath, 'utf8');
            const runbook = parseRunbookDocument(content, path.basename(runbookPath));

            if (runbook.steps.length === 0) {
              throw new Error('Child runbook has no steps');
            }

            // Inherit prompted flag from parent runbook
            const parentState = await manager.load(state.id);
            const parentPrompted = parentState?.prompted ?? false;

            const childRunbookPath = path.relative(cwd, runbookPath);
            const childState = await manager.create(pending.runbook, runbook, {
              runbookPath: childRunbookPath,
              agentId: options.agent,
              parentRunbookId: state.id,
              parentStepId: pending.stepId,
              prompted: parentPrompted  // Inherit from parent
            });

            await manager.updateAgentBinding(state.id, options.agent, {
              childRunbookId: childState.id
            });

            await manager.pushRunbook(childState.id, options.agent);

            const childMetadata = buildMetadata(childState);

            if (output.isJson()) {
              output.getWriter().writeJson({
                action: 'child_runbook_started',
                agent: options.agent,
                childRunbook: childMetadata,
                currentStep: { index: childState.step }
              });
              return;
            }

            // Print metadata and action
            printMetadata(childMetadata);
            printActionBlock({ action: 'START' });

            // Update lastAction
            await manager.update(childState.id, { lastAction: 'START' });

            // Run execution loop (chains command steps automatically)
            const result = await runExecutionLoop(manager, childState.id, [...runbook.steps], cwd, parentPrompted, options.agent);

            if (result === 'stopped') {
              throw new Error('Runbook stopped');
            }
          }
          return;
        }

        if (!file && !options.step && !options.agent) {
          throw new Error('Runbook file, --step, or --agent option required');
        }
      }, { json: options.json });
    });
}
