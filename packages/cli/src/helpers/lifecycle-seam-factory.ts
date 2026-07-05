// packages/cli/src/helpers/lifecycle-seam-factory.ts
//
// Shared construction of a `RunbookLifecycleCommandService` for the CLI front
// ends that drive pass/fail (`runSeamTransition`) and complete/stop
// (`runSeamTerminal`). Both wire the identical five core services and, because
// neither front end issues delegations, a single shared throwing guard for the
// issuance-only dependencies. Single-sourcing that here keeps the "this front
// end never issues delegations" contract in one place and off each command's
// import graph.

import {
  CompletionLock,
  DelegationLock,
  RunbookStateManager,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  SessionService,
  ExecutionLifecycleService,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { getRunbookFromState } from './runbook-loader.js';

/** The core services and seam bound to a single command's cwd. */
export interface NonDelegatingLifecycleSeam {
  /** State manager bound to `cwd`; returned so callers can reload mutated runs. */
  readonly manager: RunbookStateManager;
  /** Session service over the same manager (target resolution, orphan cleanup). */
  readonly sessionService: SessionService;
  /** The lifecycle command seam driving transitions / terminals. */
  readonly seam: RunbookLifecycleCommandService;
}

/**
 * Build a lifecycle command seam for a front end that never issues delegations.
 *
 * Constructs the manager, actor service, session service, execution-lifecycle
 * service, and completion service over one `cwd`, then wires them into a
 * `RunbookLifecycleCommandService`. The three delegation-issuance dependencies
 * (`resolveChildRunbook` / `persistIssuedSubstep` / `findDelegationByToken`) are
 * unreachable on the pass/fail and complete/stop paths, so they share a single
 * throwing guard — keeping these front ends off the runbook-resolver / scan
 * import graphs.
 *
 * @param cwd - Current working directory the state manager and steps resolve against.
 * @returns The bound `manager`, `sessionService`, and `seam`.
 */
export function buildNonDelegatingLifecycleSeam(cwd: string): NonDelegatingLifecycleSeam {
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
  // Single-source the "this front end never issues delegations" contract: one
  // guard, referenced by all three issuance-only dependencies, so the invariant
  // cannot drift between them (and every call site trips the identical error).
  const refuseIssuance = (): never => {
    throw new Error('non-delegating lifecycle seam does not issue delegations');
  };
  const seam = new RunbookLifecycleCommandService({
    sessionService,
    actorService,
    lifecycleService,
    completionService,
    loadRun: async (id) => (await manager.load(id)) ?? undefined,
    deleteRun: async (id) => {
      await manager.delete(id);
    },
    loadSteps: (state) => getRunbookFromState(state, cwd),
    resolveChildRunbook: refuseIssuance,
    persistIssuedSubstep: refuseIssuance,
    findDelegationByToken: refuseIssuance,
    // Real lock (not a throwing stub): these front ends never issue, but the
    // lock is only touched by issueDelegation, so a real DelegationLock is
    // harmless and avoids a stub that would lie if that ever changed.
    delegationLock: new DelegationLock(cwd),
    // Real per-run completion lock: the explicit-target transition span runs
    // its locked re-read → derive → record → drain under it, serialized
    // against bare record/drain, child-completion propagation, and collect.
    completionLock: new CompletionLock(cwd),
  });
  return { manager, sessionService, seam };
}
