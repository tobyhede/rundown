// packages/cli/src/helpers/lifecycle-seam-factory.ts
//
// Shared construction of a `RunbookLifecycleCommandService` for the CLI front
// ends that drive pass/fail (`runSeamTransition`), complete/stop
// (`runSeamTerminal`) and goto (`buildGotoContext`). All three wire the
// identical core services over one `cwd`; single-sourcing that here keeps the
// wiring off each command's import graph.

import {
  RunbookStateManager,
  RunbookLifecycleCommandService,
  type RunbookLifecycleCommandServiceDependencies,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { getRunbookFromState } from './runbook-loader.js';

/** The core services and seam bound to a single command's cwd. */
export interface LifecycleSeam {
  /** State manager bound to `cwd`; returned so callers can reload mutated runs. */
  readonly manager: RunbookStateManager;
  /** The lifecycle command seam driving transitions / terminals / navigation. */
  readonly seam: RunbookLifecycleCommandService;
}

/**
 * Build the core services a lifecycle seam drives, for one command invocation.
 *
 * Constructs the manager and actor service over one `cwd`, with step
 * derivation that parses the run's own stored source against this process's
 * helper registry. The escape hatch hands them to core directly
 * (`stopByHuman`); every other command wraps them in the seam.
 *
 * @param cwd - Current working directory the state manager and steps resolve against.
 * @returns The bound core services.
 */
export function buildLifecycleDeps(cwd: string): RunbookLifecycleCommandServiceDependencies {
  const manager = new RunbookStateManager(cwd);
  return {
    manager,
    actorService: createCliRunbookActorService(manager),
    loadSteps: (state) => getRunbookFromState(state, cwd),
  };
}

/**
 * Build the lifecycle command seam for one command invocation.
 *
 * Constructs the manager and actor service over one `cwd`, then wires them
 * into a `RunbookLifecycleCommandService` whose step derivation parses the
 * run's own stored source against this process's helper registry.
 *
 * @param cwd - Current working directory the state manager and steps resolve against.
 * @returns The bound `manager` and `seam`.
 */
export function buildLifecycleSeam(cwd: string): LifecycleSeam {
  const deps = buildLifecycleDeps(cwd);
  return { manager: deps.manager, seam: new RunbookLifecycleCommandService(deps) };
}
