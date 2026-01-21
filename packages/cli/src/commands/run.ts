// packages/cli/src/commands/run.ts

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
  type PendingStep,
  type RunbookState,
  // Event system imports
  ExecutionEventEmitter,
  CLISubscriber,
  JSONSubscriber,
  getWriter,
} from '@rundown-org/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import { runExecutionLoop } from '../services/execution.js';

/**
 * Create an event emitter for a runbook execution.
 * OUTPUT PARITY: Uses runbookState.runbook for "File:" line (matches buildMetadata).
 */
function createEmitter(runbookState: RunbookState): ExecutionEventEmitter {
  return new ExecutionEventEmitter(
    runbookState.id,
    { name: runbookState.runbook, path: runbookState.runbookPath }
  );
}

/**
 * Result of setting up an emitter with subscriber for runbook execution.
 */
interface EmitterSetupResult {
  emitter: ExecutionEventEmitter;
  jsonSubscriber: JSONSubscriber | undefined;
}

/**
 * Set up an emitter with the appropriate subscriber based on output mode.
 *
 * @param runbookState - The runbook state to create the emitter for
 * @param jsonMode - Whether to use JSON output mode
 * @returns The emitter and optional JSON subscriber
 */
function setupEmitterWithSubscriber(
  runbookState: RunbookState,
  jsonMode: boolean
): EmitterSetupResult {
  const emitter = createEmitter(runbookState);
  const jsonSubscriber = jsonMode ? new JSONSubscriber() : undefined;

  if (jsonSubscriber) {
    emitter.subscribe(jsonSubscriber.handle);
  } else {
    const cliSubscriber = new CLISubscriber(getWriter());
    emitter.subscribe(cliSubscriber.handle);
  }

  return { emitter, jsonSubscriber };
}

/**
 * Output JSON summary from a JSON subscriber if present.
 *
 * @param jsonSubscriber - The JSON subscriber to get summary from, or undefined
 */
function outputJsonSummary(jsonSubscriber: JSONSubscriber | undefined): void {
  if (jsonSubscriber) {
    const writer = getWriter();
    writer.writeJson(jsonSubscriber.getSummary());
  }
}

/**
 * Emit RUNBOOK_STARTED event with metadata.
 */
function emitRunbookStarted(
  emitter: ExecutionEventEmitter,
  runbookState: RunbookState,
  prompted: boolean
): void {
  emitter.emit('RUNBOOK_STARTED', {
    title: runbookState.title,
    description: runbookState.description,
    prompted,
    statePath: `.claude/rundown/runs/${runbookState.id}.json`,
  });
}

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
    .option('--json', 'Output execution events as JSON')
    .action(async (file: string | undefined, options: { step?: string; agent?: string; prompted?: boolean; json?: boolean }) => {
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

          // Update lastAction
          await manager.update(state.id, { lastAction: 'START' });

          // Create emitter and attach subscriber based on --json flag
          const { emitter, jsonSubscriber } = setupEmitterWithSubscriber(state, !!options.json);

          // Emit RUNBOOK_STARTED (replaces printMetadata + printActionBlock)
          emitRunbookStarted(emitter, state, !!options.prompted);

          // Run execution loop with emitter
          const result = await runExecutionLoop(manager, state.id, [...runbook.steps], cwd, !!options.prompted, undefined, emitter);

          // Output JSON summary if --json flag was used
          outputJsonSummary(jsonSubscriber);

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

            // Update lastAction
            await manager.update(childState.id, { lastAction: 'START' });

            // Create emitter for CHILD runbook (uses childState, NOT state!)
            const { emitter, jsonSubscriber } = setupEmitterWithSubscriber(childState, !!options.json);

            // Emit RUNBOOK_STARTED for child (replaces printMetadata + printActionBlock)
            emitRunbookStarted(emitter, childState, parentPrompted);

            // Run execution loop with emitter
            const result = await runExecutionLoop(manager, childState.id, [...runbook.steps], cwd, parentPrompted, options.agent, emitter);

            // Output JSON summary if --json flag was used
            outputJsonSummary(jsonSubscriber);

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
