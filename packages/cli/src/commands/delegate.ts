import path from 'node:path';
import type { Command } from 'commander';
import { RunbookStateManager, SessionService, createDelegation, Errors } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { loadVariablesFromFile } from '../services/variable-discovery.js';
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
    .option('--var-file <path>', 'Load variables from YAML file')
    .option('--json', 'Output as JSON')
    .action(
      async (
        runbook: string,
        options: { step: string; var: string[]; varFile?: string; json?: boolean },
      ) => {
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

            // Parse extra vars: --var-file (lower precedence) merged with --var (higher precedence)
            let extraVars: Record<string, string> | undefined;
            if (options.varFile) {
              const varFilePath = path.isAbsolute(options.varFile)
                ? options.varFile
                : path.join(cwd, options.varFile);
              extraVars = await loadVariablesFromFile(varFilePath);
            }
            if (options.var.length > 0) {
              const flagVars = parseVarFlags(options.var);
              extraVars = extraVars ? { ...extraVars, ...flagVars } : flagVars;
            }

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
                token_hash: result.tokenHash,
                parent_run_id: state.id,
              });
            } else {
              output.message(`DELEGATED  step ${options.step} -> ${runbook}`);
              output.message(`Token:     ${result.token}`);
              output.message('');
              output.message(`RD_CLAIM_TOKEN=${result.token}`);
            }

            output.flush();
          },
          { json: options.json },
        );
      },
    );
}
