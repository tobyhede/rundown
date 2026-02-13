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
  type ExecutionEventEmitter,
} from '@rundown-org/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import { runExecutionLoop } from '../services/execution.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { collect } from './echo.js';
import {
  collectVariables,
  extractVarsFromMarkdown,
  resolveVariables,
} from '../services/variable-discovery.js';
import {
  substituteRunbookVariables,
  expandForClauseVariables,
} from '../services/template-renderer.js';

/**
 * Emit RUNBOOK_STARTED event with metadata.
 */
function emitRunbookStarted(
  emitter: ExecutionEventEmitter,
  runbookState: RunbookState,
  prompted: boolean,
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
    .description('Start a runbook, queue a step, or bind an agent')
    .option('--step <stepId>', 'Mark step as started (adds to pending queue)')
    .option('--agent <agentId>', 'Bind agent to pending step')
    .option('--prompted', 'Prompted mode: show commands without auto-executing')
    .option('--json', 'Output execution events as JSON')
    .option('--var-file <path>', 'Load variables from YAML file')
    .option('--var <key=value>', 'Set variable (repeatable)', collect, [])
    .action(
      async (
        file: string | undefined,
        options: {
          step?: string;
          agent?: string;
          prompted?: boolean;
          json?: boolean;
          varFile?: string;
          var?: string[];
        },
      ) => {
        // OutputEmitter for non-loop output (step_queued, agent_bound)
        const output = new OutputEmitter({ json: options.json });

        try {
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);

          // Mode 1: --step - Push step to pending queue
          if (options.step && !options.agent) {
            const state = await manager.getActive();
            if (!state) {
              output.error('No active runbook', 'NO_ACTIVE_RUNBOOK');
              output.flush();
              process.exit(1);
            }

            const stepId = parseStepIdFromString(options.step);
            if (!stepId) {
              output.error(
                `Invalid step ID format: ${options.step}. Expected format: "3" or "3.1"`,
                'INVALID_SYNTAX',
                {
                  provided: options.step,
                },
              );
              output.flush();
              process.exit(1);
            }

            const pendingStep: PendingStep = {
              stepId,
              runbook: file,
            };

            await manager.pushPendingStep(state.id, pendingStep);

            const runbookInfo = file ? ` with runbook ${file}` : '';
            output.status(
              true,
              'step_queued',
              `Step ${stepIdToString(stepId)} queued for agent binding${runbookInfo}`,
              {
                stepId: stepIdToString(stepId),
                runbook: file,
              },
            );
            output.flush();
            return;
          }

          // Mode 2: File start (must come before Mode 3 to handle file + --agent case)
          if (file && !options.step) {
            const filePath = await resolveRunbookFile(cwd, file);

            if (!filePath) {
              output.error(
                `Runbook not found: ${file}. Try 'rd ls --all' to list available runbooks.`,
                'RUNBOOK_NOT_FOUND',
                {
                  runbook: file,
                },
              );
              output.flush();
              process.exit(1);
            }

            // Load raw markdown and collect variables
            const rawContent = await fs.readFile(filePath, 'utf8');
            const frontmatterVars = extractVarsFromMarkdown(rawContent);
            const { vars: mergedVariables, sources } = await resolveVariables(
              { varFile: options.varFile, var: options.var, frontmatterVars },
              cwd,
            );

            // Pre-expand FOR clause bounds (parser needs numeric values)
            const forExpandedContent = expandForClauseVariables(
              rawContent,
              mergedVariables,
              new Set(Object.keys(sources)),
            );

            // Parse markdown ({{variables}} in non-FOR contexts are literal text in mdast)
            const rawRunbook = parseRunbookDocument(forExpandedContent, path.basename(filePath));

            // Then substitute variables into parsed AST with context-aware escaping
            const runbook = substituteRunbookVariables(rawRunbook, mergedVariables);

            if (runbook.steps.length === 0) {
              output.error('Runbook has no steps', 'VALIDATION_ERROR', {
                runbook: file,
              });
              output.flush();
              process.exit(1);
            }

            const runbookPath = path.relative(cwd, filePath);
            const state = await manager.create(file, runbook, {
              runbookPath,
              prompted: options.prompted,
              agentId: options.agent,
              runbookSrc: rawContent, // Store raw markdown (not expanded)
              templateVars: mergedVariables, // Store variables for resume re-application
              sources,
            });

            await manager.pushRunbook(state.id, options.agent);

            if (runbook.steps[0].substeps && runbook.steps[0].substeps.length > 0) {
              await manager.initializeSubsteps(state.id, runbook.steps[0].substeps);
              // Set the current substep to the first substep
              await manager.update(state.id, { substep: runbook.steps[0].substeps[0].id });
            }

            // Update lastAction
            await manager.update(state.id, { lastAction: { type: 'START' } });

            // Create emitter bridged to unified output
            const emitter = createBridgedEmitter(state, output);

            // Emit RUNBOOK_STARTED (replaces printMetadata + printActionBlock)
            emitRunbookStarted(emitter, state, !!options.prompted);

            // Run execution loop with emitter
            const result = await runExecutionLoop(
              manager,
              state.id,
              [...runbook.steps],
              cwd,
              !!options.prompted,
              undefined,
              emitter,
            );

            // Flush any remaining output
            output.flush();

            if (result === 'stopped') {
              process.exit(1);
            }
            return;
          }

          // Mode 3: --agent - Bind agent to pending step
          if (options.agent) {
            const state = await manager.getActive();
            if (!state) {
              output.error('No active runbook', 'NO_ACTIVE_RUNBOOK');
              output.flush();
              process.exit(1);
            }

            const pending = await manager.popPendingStep(state.id);
            if (!pending) {
              output.error('No pending step to bind', 'AGENT_BINDING_ERROR', {
                agent: options.agent,
              });
              output.flush();
              process.exit(1);
            }

            await manager.bindAgent(state.id, options.agent, pending.stepId);

            output.status(
              true,
              'agent_bound',
              `Agent ${options.agent} bound to step ${stepIdToString(pending.stepId)}`,
              {
                agent: options.agent,
                stepId: stepIdToString(pending.stepId),
              },
            );
            output.flush();

            if (pending.runbook) {
              const runbookPath = await resolveRunbookFile(cwd, pending.runbook);
              if (!runbookPath) {
                output.error(`Runbook file not found: ${pending.runbook}`, 'RUNBOOK_NOT_FOUND', {
                  runbook: pending.runbook,
                });
                output.flush();
                process.exit(1);
              }

              // Load raw child markdown and collect variables
              const rawContent = await fs.readFile(runbookPath, 'utf8');
              const frontmatterVars = extractVarsFromMarkdown(rawContent);
              const { vars: mergedVariables, sources: childSources } = await resolveVariables(
                { varFile: options.varFile, var: options.var, frontmatterVars },
                cwd,
              );

              // Pre-expand FOR clause bounds, then parse and substitute into AST
              const forExpandedContent = expandForClauseVariables(
                rawContent,
                mergedVariables,
                new Set(Object.keys(childSources)),
              );
              const rawRunbook = parseRunbookDocument(
                forExpandedContent,
                path.basename(runbookPath),
              );
              const runbook = substituteRunbookVariables(rawRunbook, mergedVariables);

              if (runbook.steps.length === 0) {
                output.error('Child runbook has no steps', 'VALIDATION_ERROR', {
                  runbook: pending.runbook,
                });
                output.flush();
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
                prompted: parentPrompted,
                runbookSrc: rawContent, // Store raw markdown
                templateVars: mergedVariables, // Store variables for resume
                sources: childSources,
              });

              await manager.updateAgentBinding(state.id, options.agent, {
                childRunbookId: childState.id,
              });

              await manager.pushRunbook(childState.id, options.agent);

              // Update lastAction
              await manager.update(childState.id, { lastAction: { type: 'START' } });

              // Create emitter for CHILD runbook (uses childState, NOT state!)
              const emitter = createBridgedEmitter(childState, output);

              // Emit RUNBOOK_STARTED for child (replaces printMetadata + printActionBlock)
              emitRunbookStarted(emitter, childState, parentPrompted);

              // Run execution loop with emitter
              const result = await runExecutionLoop(
                manager,
                childState.id,
                [...runbook.steps],
                cwd,
                parentPrompted,
                options.agent,
                emitter,
              );

              // Flush any remaining output
              output.flush();

              if (result === 'stopped') {
                process.exit(1);
              }
            }
            return;
          }

          if (!file && !options.step && !options.agent) {
            output.error('Runbook file, --step, or --agent option required', 'INVALID_SYNTAX');
            output.flush();
            process.exit(1);
          }
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') {
            output.error(`Runbook not found: ${file ?? 'unknown'}`, 'RUNBOOK_NOT_FOUND', {
              runbook: file ?? 'unknown',
            });
            output.message("Try 'rd ls --all' to list available runbooks.", 'dim');
          } else if (error instanceof RunbookSyntaxError) {
            output.error(`Syntax error: ${error.message}`, 'INVALID_SYNTAX');
          } else {
            output.error(getErrorMessage(error), 'UNKNOWN_ERROR');
          }
          output.flush();
          process.exit(1);
        }
      },
    );
}
