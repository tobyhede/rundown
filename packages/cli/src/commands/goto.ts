// packages/cli/src/commands/goto.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  parseStepIdFromString,
  stepIdToString,
  countNumberedSteps,
  ExecutionEventEmitter,
  type RunbookState,
} from '@rundown-org/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import { runExecutionLoop } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Create an event emitter for a runbook execution and bridge to OutputEmitter.
 *
 * @param runbookState - The runbook state to create the emitter for
 * @param output - The OutputEmitter to bridge events to
 * @returns The ExecutionEventEmitter
 */
function createBridgedEmitter(
  runbookState: RunbookState,
  output: OutputEmitter
): ExecutionEventEmitter {
  const emitter = new ExecutionEventEmitter(
    runbookState.id,
    { name: runbookState.runbook, path: runbookState.runbookPath }
  );

  // Bridge execution events to the unified output system
  emitter.subscribe((event) => {
    output.executionEvent(event);
  });

  return emitter;
}

/**
 * Registers the 'goto' command for jumping to specific steps.
 * @param program - Commander program instance to register the command on
 */
export function registerGotoCommand(program: Command): void {
  program
    .command('goto <step>')
    .description('Jump to specific step (e.g., "3" or "3.1" for substep)')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (stepArg: string, options: { json?: boolean }) => {
      await withErrorHandling(async () => {
        const output = new OutputEmitter({ json: options.json });
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);
        const state = await manager.getActive();

        if (!state) {
          output.status(false, 'goto', 'No active runbook');
          output.flush();
          return;
        }
        // Parse target with StepId
        const target = parseStepIdFromString(stepArg);
        if (!target) {
          output.error(`Invalid step target: ${stepArg}. Format: N (step) or N.M (step.substep)`, 'INVALID_SYNTAX', {
            provided: stepArg
          });
          output.flush();
          process.exit(1);
        }

        // Reject NEXT via CLI
        if (target.step === 'NEXT') {
          output.error('GOTO NEXT is only valid as a runbook transition, not via CLI', 'INVALID_SYNTAX');
          output.flush();
          process.exit(1);
        }

        const runbookPath = await resolveRunbookFile(cwd, state.runbook);
        if (!runbookPath) {
          output.error(`Runbook file ${state.runbook} not found`, 'RUNBOOK_NOT_FOUND', {
            runbook: state.runbook
          });
          output.flush();
          process.exit(1);
        }
        const content = await fs.readFile(runbookPath, 'utf8');
        const steps = parseRunbook(content);

        // Validate step exists (numeric steps and named steps - dynamic {N} references are validated at runtime)
        if (target.step !== '{N}') {
          // Look up step by name (includes numeric names like "1", "2")
          const stepIndex = steps.findIndex(s => s.name === target.step);
          if (stepIndex === -1) {
            output.error(`Step "${target.step}" does not exist`, 'STEP_NOT_FOUND', {
              requested: target.step,
              available: steps.map(s => s.name)
            });
            output.flush();
            process.exit(1);
          }

          // Validate substep exists (if specified)
          if (target.substep) {
            const step = steps[stepIndex];
            if (!step.substeps || step.substeps.length === 0) {
              output.error(`Step ${stepIdToString({ step: target.step })} has no substeps`, 'STEP_NOT_FOUND', {
                step: target.step
              });
              output.flush();
              process.exit(1);
            }
            if (step.substeps.some(s => s.isDynamic)) {
              output.error(`Cannot goto substep of dynamic step. Use: rd goto ${target.step}`, 'INVALID_SYNTAX', {
                step: target.step,
                suggestion: `rd goto ${target.step}`
              });
              output.flush();
              process.exit(1);
            }
            const substepExists = step.substeps.some(s => s.id === target.substep);
            if (!substepExists) {
              output.error(`Substep ${stepIdToString(target)} does not exist`, 'STEP_NOT_FOUND', {
                requested: stepIdToString(target),
                available: step.substeps.map(s => s.id)
              });
              output.flush();
              process.exit(1);
            }
          }
        }

        // Create XState actor
        const actor = await manager.createActor(state.id, steps);
        if (!actor) {
          output.error('Failed to initialize runbook engine', 'UNKNOWN_ERROR');
          output.flush();
          process.exit(1);
        }

        const prevStep = state.step;
        const prevSubstep = state.substep;

        // SEND GOTO EVENT TO XSTATE (not direct state manipulation!)
        actor.send({ type: 'GOTO', target });

        // Update state from XState (single source of truth)
        // Note: We call updateFromActor to persist the new state, but don't use the return value
        // since we show "from" position in the action block
        await manager.updateFromActor(state.id, actor, steps);

        // Update lastAction and CLEAR lastResult (prevent stale PASS/FAIL leaking)
        await manager.update(state.id, {
          lastAction: 'GOTO',
          lastResult: undefined  // CRITICAL: Clear stale result on manual goto
        });

        // Compute new position (the target of the goto)
        const totalSteps = countNumberedSteps(steps);
        const newPos = {
          current: target.step,
          total: totalSteps,
          substep: target.substep,
        };
        const prevPos = { current: prevStep, total: totalSteps, substep: prevSubstep };

        // Build action data for goto
        const actionData = {
          action: `GOTO ${stepIdToString(target)}`,
          from: prevPos,
          at: newPos,
        };

        // Emit structured action output
        output.action(actionData);

        // Create emitter bridged to unified output
        const emitter = createBridgedEmitter(state, output);

        // Continue with execution loop
        // Goto doesn't have --agent option, so use default stack
        const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, undefined, emitter);

        // Flush any remaining output
        output.flush();

        if (loopResult === 'stopped') {
          process.exit(1);
        }
      }, { json: options.json });
    });
}
