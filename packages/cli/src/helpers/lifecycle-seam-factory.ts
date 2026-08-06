// packages/cli/src/helpers/lifecycle-seam-factory.ts
//
// Shared construction of a `RunbookLifecycleCommandService` for the CLI front
// ends that drive pass/fail (`runSeamTransition`) and complete/stop
// (`runSeamTerminal`). Both wire the identical core services and, because
// neither front end issues delegations, a shared throwing guard for child
// resolution. Single-sourcing that here keeps the "this front
// end never issues delegations" contract in one place and off each command's
// import graph.

import {
  RunbookStateManager,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  SessionService,
  ExecutionLifecycleService,
  createEffectfulActorMutationRunner,
  DelegationScanService,
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
 * `RunbookLifecycleCommandService`. Child resolution remains guarded because
 * these front ends never issue. Token scanning is read-only and is shared with
 * the abort front end, whose mutation remains core-owned.
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
  // The "this front end never issues delegations" contract, as one named guard
  // rather than an inline throw, so the invariant reads as a decision and every
  // call site trips the identical error. Token scanning is deliberately NOT
  // guarded: it is read-only, and `abort` drives its refusals through this same
  // seam.
  const refuseIssuance = (): never => {
    throw new Error('non-delegating lifecycle seam does not issue delegations');
  };
  const seam = new RunbookLifecycleCommandService({
    sessionService,
    actorService,
    completionService,
    actorMutationRunner: createEffectfulActorMutationRunner(cwd),
    loadRun: async (id) => (await manager.load(id)) ?? undefined,
    loadSteps: (state) => getRunbookFromState(state, cwd),
    resolveChildRunbook: refuseIssuance,
    findDelegationsByTokenHash: (tokenHash) =>
      new DelegationScanService(manager).scanByTokenHash(tokenHash),
  });
  return { manager, sessionService, seam };
}
