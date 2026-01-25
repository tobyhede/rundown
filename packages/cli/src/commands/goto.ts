// packages/cli/src/commands/goto.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  parseStepIdFromString,
  stepIdToString,
  countNumberedSteps,
  printNoActiveRunbook,
  // Event system imports for JSON mode
  ExecutionEventEmitter,
  CLISubscriber,
  JSONSubscriber,
  getWriter,
  type RunbookState,
} from '@rundown-org/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import { runExecutionLoop } from '../services/execution.js';
import { printStepSeparator, printActionBlock } from '@rundown-org/core';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputManager } from '../services/output-manager.js';

/**
 * Set up an emitter with the appropriate subscriber based on output mode.
 */
function setupEmitterWithSubscriber(
  runbookState: RunbookState,
  jsonMode: boolean
): { emitter: ExecutionEventEmitter; jsonSubscriber: JSONSubscriber | undefined } {
  const emitter = new ExecutionEventEmitter(
    runbookState.id,
    { name: runbookState.runbook, path: runbookState.runbookPath }
  );
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
        const output = new OutputManager({ json: options.json });
        const writer = output.getWriter();
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);
        const state = await manager.getActive();

        if (!state) {
          if (output.isJson()) {
            writer.writeJson({ success: false, error: 'No active runbook' });
          } else {
            printNoActiveRunbook(writer);
          }
          return;
        }
        // Parse target with StepId
        const target = parseStepIdFromString(stepArg);
        if (!target) {
          if (output.isJson()) {
            output.getWriter().writeJson({ success: false, error: `Invalid step target: ${stepArg}. Format: N (step) or N.M (step.substep)` });
          } else {
            console.error(`Error: Invalid step target: ${stepArg}`);
            console.error('Format: N (step) or N.M (step.substep)');
          }
          process.exit(1);
        }

        // Reject NEXT via CLI
        if (target.step === 'NEXT') {
          if (output.isJson()) {
            output.getWriter().writeJson({ success: false, error: 'GOTO NEXT is only valid as a runbook transition, not via CLI' });
          } else {
            console.error('Error: GOTO NEXT is only valid as a runbook transition, not via CLI');
          }
          process.exit(1);
        }

        const runbookPath = await resolveRunbookFile(cwd, state.runbook);
        if (!runbookPath) {
          if (output.isJson()) {
            output.getWriter().writeJson({ success: false, error: `Runbook file ${state.runbook} not found` });
          } else {
            console.error(`Error: Runbook file ${state.runbook} not found`);
          }
          process.exit(1);
        }
        const content = await fs.readFile(runbookPath, 'utf8');
        const steps = parseRunbook(content);

        // Validate step exists (numeric steps and named steps - dynamic {N} references are validated at runtime)
        if (target.step !== '{N}') {
          // Look up step by name (includes numeric names like "1", "2")
          const stepIndex = steps.findIndex(s => s.name === target.step);
          if (stepIndex === -1) {
            if (output.isJson()) {
              output.getWriter().writeJson({ success: false, error: `Step "${target.step}" does not exist` });
            } else {
              console.error(`Error: Step "${target.step}" does not exist`);
            }
            process.exit(1);
          }

          // Validate substep exists (if specified)
          if (target.substep) {
            const step = steps[stepIndex];
            if (!step.substeps || step.substeps.length === 0) {
              if (output.isJson()) {
                output.getWriter().writeJson({ success: false, error: `Step ${stepIdToString({ step: target.step })} has no substeps` });
              } else {
                console.error(`Error: Step ${stepIdToString({ step: target.step })} has no substeps`);
              }
              process.exit(1);
            }
            if (step.substeps.some(s => s.isDynamic)) {
              if (output.isJson()) {
                output.getWriter().writeJson({ success: false, error: `Cannot goto substep of dynamic step. Use: rd goto ${target.step}` });
              } else {
                console.error(`Error: Cannot goto substep of dynamic step. Use: rd goto ${target.step}`);
              }
              process.exit(1);
            }
            const substepExists = step.substeps.some(s => s.id === target.substep);
            if (!substepExists) {
              if (output.isJson()) {
                output.getWriter().writeJson({ success: false, error: `Substep ${stepIdToString(target)} does not exist` });
              } else {
                console.error(`Error: Substep ${stepIdToString(target)} does not exist`);
              }
              process.exit(1);
            }
          }
        }

        // Create XState actor
        const actor = await manager.createActor(state.id, steps);
        if (!actor) {
          if (output.isJson()) {
            output.getWriter().writeJson({ success: false, error: 'Failed to initialize runbook engine' });
          } else {
            console.error('Error: Failed to initialize runbook engine');
          }
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

        if (output.isJson()) {
          output.getWriter().writeJson({
            success: true,
            action: 'goto',
            from: { current: prevStep, total: totalSteps, substep: prevSubstep },
            to: { current: target.step, total: totalSteps, substep: target.substep },
          });
        } else {
          // Print separator with new step number and action block
          printStepSeparator(newPos);
          printActionBlock({
            action: `GOTO ${stepIdToString(target)}`,
            from: { current: prevStep, total: totalSteps, substep: prevSubstep },
            at: newPos,
          });
        }

        // Set up emitter for execution loop (for JSON mode)
        const { emitter, jsonSubscriber } = setupEmitterWithSubscriber(state, !!options.json);

        // Continue with execution loop
        // Goto doesn't have --agent option, so use default stack
        const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, undefined, emitter);

        // Output JSON summary if in JSON mode
        if (jsonSubscriber) {
          getWriter().writeJson(jsonSubscriber.getSummary());
        }

        if (loopResult === 'stopped') {
          process.exit(1);
        }
      }, { json: options.json });
    });
}
