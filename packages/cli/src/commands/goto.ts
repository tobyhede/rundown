// packages/cli/src/commands/goto.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  parseStepIdFromString,
  stepIdToString,
  countNumberedSteps,
  type Step,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { runExecutionLoop } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { EXIT_COMMAND_ERROR, EXIT_RUNBOOK_FAILED } from '../helpers/exit-codes.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';

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
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const state = await sessionService.getActive();

          if (!state) {
            output.noActiveRunbook('goto');
            output.flush();
            return;
          }
          // Parse target with StepId
          const target = parseStepIdFromString(stepArg);
          if (!target) {
            output.error(
              `Invalid step target: ${stepArg}. Format: N (step) or N.M (step.substep)`,
              'INVALID_SYNTAX',
              {
                provided: stepArg,
              },
            );
            output.flush();
            process.exit(EXIT_COMMAND_ERROR);
          }

          let steps: Step[];
          try {
            steps = [...getRunbookFromState(state, cwd)];
          } catch (err) {
            output.error(`Runbook state error: ${(err as Error).message}`, 'STATE_ERROR');
            output.flush();
            process.exit(EXIT_COMMAND_ERROR);
          }

          // Validate step exists
          const stepIndex = steps.findIndex((s) => s.name === target.step);
          if (stepIndex === -1) {
            output.error(`Step "${target.step}" does not exist`, 'STEP_NOT_FOUND', {
              requested: target.step,
              available: steps.map((s) => s.name),
            });
            output.flush();
            process.exit(EXIT_COMMAND_ERROR);
          }

          // Validate AT - target must be a FOR step
          if (target.at !== undefined) {
            const step = steps[stepIndex];
            if (!step.forClause) {
              output.error(
                `GOTO AT is only valid when the target step has a FOR clause (step "${target.step}" has no FOR)`,
                'INVALID_AT_TARGET',
                { step: target.step, at: target.at },
              );
              output.flush();
              process.exit(EXIT_COMMAND_ERROR);
            }
          }

          // Validate substep exists (if specified)
          if (target.substep) {
            const step = steps[stepIndex];
            if (!step.substeps || step.substeps.length === 0) {
              output.error(
                `Step ${stepIdToString({ step: target.step })} has no substeps`,
                'STEP_NOT_FOUND',
                {
                  step: target.step,
                },
              );
              output.flush();
              process.exit(EXIT_COMMAND_ERROR);
            }
            const substepExists = step.substeps.some((s) => s.id === target.substep);
            if (!substepExists) {
              output.error(`Substep ${stepIdToString(target)} does not exist`, 'STEP_NOT_FOUND', {
                requested: stepIdToString(target),
                available: step.substeps.map((s) => s.id),
              });
              output.flush();
              process.exit(EXIT_COMMAND_ERROR);
            }
          }

          const actorService = new RunbookActorService(manager);

          const prevStep = state.step;
          const prevSubstep = state.substep;

          const syncResult = await actorService.sendAndSync(state.id, steps, {
            type: 'GOTO',
            target,
          });
          if (!syncResult) {
            output.error('Failed to initialize runbook engine', 'ENGINE_INIT_FAILED');
            output.flush();
            process.exit(EXIT_COMMAND_ERROR);
          }

          // Update lastAction and CLEAR lastResult (prevent stale PASS/FAIL leaking)
          await manager.update(state.id, {
            lastAction: {
              type: 'GOTO',
              target: target.step,
              ...(target.substep && { substep: target.substep }),
            },
            lastResult: undefined, // CRITICAL: Clear stale result on manual goto
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
          const loopResult = await runExecutionLoop(
            manager,
            state.id,
            steps,
            cwd,
            !!state.prompted,
            undefined,
            emitter,
          );

          // Flush any remaining output
          output.flush();

          if (loopResult === 'stopped') {
            process.exit(EXIT_RUNBOOK_FAILED);
          }
        },
        { json: options.json },
      );
    });
}
