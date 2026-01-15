// packages/cli/src/commands/goto.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  WorkflowStateManager,
  parseWorkflow,
  parseStepIdFromString,
  stepIdToString,
} from '@rundown/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import { runExecutionLoop } from '../services/execution.js';
import { printSeparator, printActionBlock } from '@rundown/core';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'goto' command for jumping to specific steps.
 * @param program - Commander program instance to register the command on
 */
export function registerGotoCommand(program: Command): void {
  program
    .command('goto <step>')
    .description('Jump to specific step (e.g., "3" or "3.1" for substep)')
    .action(async (stepArg: string) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new WorkflowStateManager(cwd);
        const state = await manager.getActive();

        if (!state) {
          console.log('No active runbook');
          return;
        }
        // Parse target with StepId
        const target = parseStepIdFromString(stepArg);
        if (!target) {
          console.error(`Error: Invalid step target: ${stepArg}`);
          console.error('Format: N (step) or N.M (step.substep)');
          process.exit(1);
        }

        // Reject NEXT via CLI
        if (target.step === 'NEXT') {
          console.error('Error: GOTO NEXT is only valid as a runbook transition, not via CLI');
          process.exit(1);
        }

        const workflowPath = await resolveRunbookFile(cwd, state.workflow);
        if (!workflowPath) {
          console.error(`Error: Workflow file ${state.workflow} not found`);
          process.exit(1);
        }
        const content = await fs.readFile(workflowPath, 'utf8');
        const steps = parseWorkflow(content);

        // Validate step exists (numeric steps and named steps - dynamic {N} references are validated at runtime)
        if (target.step !== '{N}') {
          // Look up step by name (includes numeric names like "1", "2")
          const stepIndex = steps.findIndex(s => s.name === target.step);
          if (stepIndex === -1) {
            console.error(`Error: Step "${target.step}" does not exist`);
            process.exit(1);
          }

          // Validate substep exists (if specified)
          if (target.substep) {
            const step = steps[stepIndex];
            if (!step.substeps || step.substeps.length === 0) {
              console.error(`Error: Step ${stepIdToString({ step: target.step })} has no substeps`);
              process.exit(1);
            }
            if (step.substeps.some(s => s.isDynamic)) {
              console.error(`Error: Cannot goto substep of dynamic step. Use: rd goto ${target.step}`);
              process.exit(1);
            }
            const substepExists = step.substeps.some(s => s.id === target.substep);
            if (!substepExists) {
              console.error(`Error: Substep ${stepIdToString(target)} does not exist`);
              process.exit(1);
            }
          }
        }

        // Create XState actor
        const actor = await manager.createActor(state.id, steps);
        if (!actor) {
          console.error('Error: Failed to initialize workflow engine');
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

        // Print output
        printSeparator();
        printActionBlock({
          action: `GOTO ${stepIdToString(target)}`,
          from: { current: prevStep, total: steps.length, substep: prevSubstep },
        });

        // Continue with execution loop
        // Goto doesn't have --agent option, so use default stack
        const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, undefined);

        if (loopResult === 'stopped') {
          process.exit(1);
        }
      });
    });
}
