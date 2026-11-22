/**
 * Resolve a mutating command's target run through core (#903).
 *
 * The Owner Token resolves to its root run; core then descends to the deepest
 * running Inline Child, Collecting first any terminal child a crashed command
 * left uncollected. That Collect is a scoped Run Progression activation —
 * core mints its directive with the `collect_inline_child` entry boundary, so
 * it commits only the Collect and runs no command or launch before the
 * owner's command — and this module supplies it with the CLI's standard
 * activation wiring, the only frontend part of the decision.
 *
 * @module helpers/command-target
 */

import type {
  CommandExecutionStreamOptions,
  CommandTargetPurpose,
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
 * @param command - The mutating command the target is resolved for; core
 *   decides which commands a cancelled or orphaned Delegation still accepts.
 * @returns Core's resolution: the target with its root, or a refusal.
 */
export function resolveCommandTarget(
  ctx: CommandTargetContext,
  token: OwnerToken,
  command: CommandTargetPurpose,
): Promise<CommandTargetResolution> {
  return ctx.seam.resolveCommandTarget(
    token,
    (directive) =>
      driveRunProgression(directive, {
        manager: ctx.manager,
        cwd: ctx.cwd,
        output: ctx.output,
        ...(ctx.commandStreamOptions !== undefined
          ? { commandStreamOptions: ctx.commandStreamOptions }
          : {}),
      }),
    command,
  );
}
