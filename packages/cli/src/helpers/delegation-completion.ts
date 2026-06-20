/**
 * Report a terminal child run's outcome to its delegating run.
 *
 * When a child run reaches a terminal state (complete or stopped), its result
 * must be REPORTED back to the delegating run's substep. This applies to both
 * delegation children (`rd delegate` / `rd claim`) and inline children
 * (`rd run --step`).
 *
 * This module is the REPORT half of report-then-collect (Plan 5): it records
 * the outcome and stops. Applying the outcome (advancing the delegating run) is
 * the COLLECT half and lives entirely behind `rd collect`
 * (core's `collectDelegationOutcomes`).
 *
 * @module helpers/delegation-completion
 */

import {
  RunbookStateManager,
  ExecutionLifecycleService,
  RunbookCompletionService,
  type RunbookState,
  type ParentLinkageBase,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Extract parent linkage from a child state.
 *
 * Checks both inline linkage (`rd run --step`) and delegation linkage
 * (`rd delegate`/`rd claim`), preferring inline when both are present.
 *
 * @param state - The child run's state
 * @returns The parent linkage base fields, or undefined if no linkage exists
 */
export function extractParentLinkage(state: RunbookState): ParentLinkageBase | undefined {
  return state.parentLinkage;
}

/**
 * Report a child run's terminal outcome to its immediate delegating run.
 *
 * This is the REPORT half of report-then-collect (Plan 5). It records ONE
 * delegation outcome row on the immediate delegating run (via core's
 * `recordChildCompletion`) and returns. It does NOT collect, drain, apply, or
 * advance the delegating run, and it does NOT recurse to ancestors. The
 * delegating run is left collection pending; its orchestrator must run
 * `rd collect` to apply the outcome.
 *
 * Works for both delegation children (`rd delegate`/`rd claim`) and inline
 * children (`rd run --step`).
 *
 * @param childState - The terminal child run's state (must carry parentLinkage)
 * @param result - Terminal result of the child ('pass' or 'fail')
 * @param cwd - Current working directory
 * @param output - Output emitter for CLI output
 * @returns 'reported' when an outcome row was recorded (or was already present,
 *          or the slot was ordinarily cancelled so nothing needed reporting),
 *          'not-applicable' when the child has no parent linkage
 * @throws {Error} If state I/O fails.
 */
export async function reportTerminalToDelegatingRun(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
): Promise<'reported' | 'not-applicable'> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';

  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);

  const recorded = await completionService.recordChildCompletion({ childState, result });
  // 'not-applicable' means the child had no linkage to report against (the
  // early guard above already handled the common case; core re-checks). Every
  // other outcome — 'recorded', 'duplicate', and 'cancelled' — means there is
  // nothing more for the close path to do: 'recorded'/'duplicate' leave the
  // delegating run collection pending, and 'cancelled' (ordinary cancel
  // short-circuit) preserves the cancellation split by writing no fail outcome.
  if (recorded === 'not-applicable') return 'not-applicable';
  output.flush();
  return 'reported';
}
