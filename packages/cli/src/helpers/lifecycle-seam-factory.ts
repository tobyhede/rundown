// packages/cli/src/helpers/lifecycle-seam-factory.ts
//
// Shared construction of a `RunbookLifecycleCommandService` for the CLI front
// ends that drive pass/fail (`runSeamTransition`), complete/stop
// (`runSeamTerminal`) and goto (`buildGotoContext`). All three wire the
// identical core services over one `cwd`; single-sourcing that here keeps the
// wiring off each command's import graph.

import { RunbookStateManager, RunbookLifecycleCommandService } from '@rundown-org/core';
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
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const seam = new RunbookLifecycleCommandService({
    manager,
    actorService,
    loadSteps: (state) => getRunbookFromState(state, cwd),
  });
  return { manager, seam };
}
