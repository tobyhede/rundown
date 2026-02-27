import type { Command } from 'commander';
import { RunbookStateManager, SessionService, createDelegation, Errors } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { collect } from './echo.js';

/**
 * Parse `--var key=value` entries into a record.
 */
function parseVarFlags(vars: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of vars) {
    const eqIndex = entry.indexOf('=');
    if (eqIndex > 0) {
      result[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
    } else {
      process.stderr.write(
        `Warning: ignored malformed --var entry '${entry}' (expected key=value)\n`,
      );
    }
  }
  return result;
}

/**
 * Registers the 'delegate' command for creating delegation tokens.
 *
 * Creates a delegation token for a substep, allowing a child agent to claim
 * and execute a child runbook on behalf of the parent.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerDelegateCommand(program: Command): void {
  program
    .command('delegate <runbook>')
    .description('Create a delegation token for a child runbook')
    .requiredOption('--step <stepId>', 'Step or substep to delegate (e.g., 1.1)')
    .option('--var <key=value>', 'Set variable for child context (repeatable)', collect, [])
    .option('--json', 'Output as JSON')
    .action(async (runbook: string, options: { step: string; var: string[]; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });
          const cwd = getCwd();

          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const state = await sessionService.getActive();

          if (!state) {
            output.noActiveRunbook('delegate');
            output.flush();
            return;
          }

          // Resolve child runbook path
          const childPath = await resolveRunbookFile(cwd, runbook);
          if (!childPath) {
            throw Errors.delegationRunbookNotFound(runbook);
          }

          // Load parent steps from state
          const steps = getRunbookFromState(state, cwd);

          // Parse extra vars
          const extraVars = options.var.length > 0 ? parseVarFlags(options.var) : undefined;

          // Create delegation (pure function — validates and returns token)
          const result = createDelegation(
            {
              state,
              stepId: options.step,
              childRunbookPath: childPath,
              extraVars,
              ancestors: [],
            },
            steps,
          );

          // Persist updated substep states
          await manager.update(state.id, {
            substepStates: result.updatedSubstepStates,
          });

          // Output
          if (options.json) {
            output.json({
              action: 'delegated',
              step: options.step,
              runbook,
              token: result.token,
              tokenHash: result.tokenHash,
              parentRunId: state.id,
            });
          } else {
            output.message(`Delegated step ${options.step} → ${runbook}`);
            output.message(`Token: ${result.token}`);
          }

          output.flush();
        },
        { json: options.json },
      );
    });
}
