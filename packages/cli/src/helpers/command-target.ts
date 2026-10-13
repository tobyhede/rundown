/**
 * Resolve a mutating command's target run through core (#903).
 *
 * The Owner Token resolves to its root run; core then descends to the deepest
 * running Inline Child, Collecting first any terminal child a crashed command
 * left uncollected. The Collect continues the parent's progression, which
 * this module supplies with the CLI's standard activation wiring — the only
 * frontend part of the decision.
 *
 * @module helpers/command-target
 */

import type {
  CommandExecutionStreamOptions,
  CommandTargetResolution,
  OwnerToken,
  RunbookLifecycleCommandService,
  RunbookStateManager,
} from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';
import { driveRunProgression } from './run-progression-adapters.js';

/** Context for {@link resolveCommandTarget}. */
export interface CommandTargetContext {
  /** The lifecycle seam deciding the target. */
  readonly seam: RunbookLifecycleCommandService;
  /** State manager bound to the project directory. */
  readonly manager: RunbookStateManager;
  /** Project directory. */
  readonly cwd: string;
  /** The command's output emitter. */
  readonly output: OutputEmitter;
  /** Runtime-only routing for command subprocess stdout/stderr. */
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
}

/**
 * Resolve the Owner Token to the run the command acts on.
 *
 * @param ctx - Seam, manager and rendering context.
 * @param token - The presented Owner Token.
 * @returns Core's resolution: the target with its root, or a refusal.
 */
export function resolveCommandTarget(
  ctx: CommandTargetContext,
  token: OwnerToken,
): Promise<CommandTargetResolution> {
  return ctx.seam.resolveCommandTarget(token, (directive) =>
    driveRunProgression(directive, {
      manager: ctx.manager,
      cwd: ctx.cwd,
      output: ctx.output,
      ...(ctx.commandStreamOptions !== undefined
        ? { commandStreamOptions: ctx.commandStreamOptions }
        : {}),
    }),
  );
}
