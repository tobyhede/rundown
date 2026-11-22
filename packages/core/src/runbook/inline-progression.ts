/**
 * Launch and implicit Collect of an Inline Child inside Run Progression (#903,
 * ADR 0005).
 *
 * Run Progression reaches an inline runbook-list substep through the machine's
 * `inline_child` entry. This module holds the pieces of the child's life from
 * the parent's side; both writes are performed by the parent owner's command,
 * the only writer of either row:
 *
 * - {@link launchInlineChild} creates the child row under the id the parent's
 *   reservation preallocated, with its linkage, no token of its own, and its
 *   machine already initialised — one write, or none. Preparing the child
 *   runbook (reading the file, resolving its variables under policy) is the
 *   frontend's service, injected as {@link PrepareChildRun} (Category C).
 * - {@link childResultEvent} is the implicit Collect's event: Run Progression
 *   reads the child's terminal from the child's own row and commits it into
 *   the parent as one `CHILD_RESULT`. The child never writes its parent.
 *   {@link inlineParentCounting} decides whether a terminal child's parent
 *   still counts it, so a stale child is never collected.
 *
 * @module runbook/inline-progression
 */

import type { ExecutionEventEmitter } from '../events/emitter.js';
import type { PrepareChildRun } from './child-preparation.js';
import { getErrorMessage } from '../errors.js';
import type { RunbookActorService } from './actor-service.js';
import {
  childResultOf,
  currentInlineReservation,
  inlineChildContext,
  type ChildResult,
} from './inline-child.js';
import type { ChildLinkage } from './child-linkage.js';
import { RunbookCompositionUnsupportedError } from './run-authority.js';
import type { VariableValue } from './effective-vars.js';
import type { RunId } from './run-id.js';
import type { RunbookStateManager } from './state.js';
import type { VersionedRunState } from './storage/runbook-store.js';
import { deriveActiveFrame } from './targeting.js';
import type { InlineChildReservation, RunbookState } from './types.js';

/** Symbolic code for an Inline Child that could not be launched (#903). */
export const INLINE_CHILD_LAUNCH_FAILED_CODE = 'INLINE_CHILD_LAUNCH_FAILED';

/**
 * Deepest chain of Inline Children one root may drive. A runbook that lists
 * itself, directly or through its children, would otherwise launch forever.
 */
export const MAX_INLINE_CHILD_DEPTH = 32;

/** A child's machine could not be initialised; carries the cause. */
class InlineChildInitializationError extends Error {
  /**
   * Wrap what initializing the child's machine threw.
   *
   * @param cause - What initializing the child's machine threw.
   */
  constructor(cause: unknown) {
    super(`Inline child could not be initialised: ${getErrorMessage(cause)}`, { cause });
    this.name = 'InlineChildInitializationError';
  }
}

/** Services a launch needs. */
export interface InlineChildLaunchDeps {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly prepareChildRun?: PrepareChildRun;
}

/** Outcome of {@link launchInlineChild}. */
export type InlineChildLaunchOutcome =
  | {
      readonly kind: 'launched';
      /** The child row as created and initialised. */
      readonly child: VersionedRunState;
    }
  | {
      readonly kind: 'refused';
      /** Stable diagnostic code. */
      readonly code: string;
      /** Operator-facing message. */
      readonly message: string;
      /** Whether repeating the command can succeed. */
      readonly recovery: 'retryable' | 'permanent';
    };

/**
 * The linkage a reservation's child row records.
 *
 * @param parent - The parent run.
 * @param reservation - The reservation being launched.
 * @returns The inline linkage.
 * @throws {Error} When the parent's cursor rests on no substep.
 */
export function inlineLinkageFor(
  parent: RunbookState,
  reservation: InlineChildReservation,
): ChildLinkage {
  if (parent.substep === undefined) {
    throw new Error(`Run ${parent.id} reserved an inline child outside a substep`);
  }
  return {
    kind: 'inline',
    parentRunId: parent.id,
    parentStep: `${parent.step}.${parent.substep}`,
    parentFrameKey: deriveActiveFrame(parent).frameKey,
    parentEntry: reservation.entry,
  };
}

/**
 * Create the reserved Inline Child's row and initialise its machine.
 *
 * Emits the child's `RUNBOOK_STARTED` through `childSink` once the row exists.
 * It carries no Owner Token: the parent's token authorizes the child.
 *
 * @param args - The launch.
 * @param args.parent - The parent run, as Run Progression read it.
 * @param args.reservation - The reservation being launched.
 * @param args.deps - Store, actor service and the frontend's preparer.
 * @param args.childSink - Factory for the child run's observation sink.
 * @returns The launched child, or a typed refusal. Nothing is written on a
 *   refusal — a child whose machine cannot be initialised included — and a
 *   race with the owner's own second command is reported rather than
 *   overwritten.
 */
export async function launchInlineChild(args: {
  readonly parent: VersionedRunState;
  readonly reservation: InlineChildReservation;
  readonly deps: InlineChildLaunchDeps;
  readonly childSink: (state: RunbookState) => Pick<ExecutionEventEmitter, 'emit'>;
}): Promise<InlineChildLaunchOutcome> {
  const { parent, reservation, deps } = args;
  const at = `${parent.state.step}.${parent.state.substep ?? ''}`;
  if (deps.prepareChildRun === undefined) {
    return {
      kind: 'refused',
      code: INLINE_CHILD_LAUNCH_FAILED_CODE,
      message: `Run ${parent.state.id} cannot launch the inline child at ${at}: this frontend does not launch inline children`,
      recovery: 'permanent',
    };
  }
  const prepared = await deps.prepareChildRun({
    parent: parent.state,
    reservation,
    contextSnapshot: inlineChildContext(parent.state, reservation),
  });
  if (prepared.kind === 'refused') {
    return {
      kind: 'refused',
      code: prepared.code,
      message: `Inline child ${reservation.runbook} at ${at} could not be launched: ${prepared.message}`,
      // The child runbook's own content or configuration refused; repeating
      // the same launch cannot change that.
      recovery: 'permanent',
    };
  }
  // The row lands with its initialised machine in one write, or not at all:
  // a child whose machine cannot be built leaves nothing behind.
  let created: RunbookState;
  try {
    created = await deps.manager.createInlineChild(
      prepared.runbookRef,
      prepared.runbook,
      {
        runId: reservation.runId,
        linkage: inlineLinkageFor(parent.state, reservation),
        prompted: parent.state.prompted,
        runbookPath: prepared.runbookPath,
        runbookSrc: prepared.runbookSrc,
        templateVars: prepared.templateVars,
        initialVariables: prepared.initialVariables,
        frontmatterOutputs: prepared.frontmatterOutputs,
      },
      async (draft) => {
        try {
          return await deps.actorService.deriveInitialState(draft, prepared.runbook.steps);
        } catch (error: unknown) {
          throw new InlineChildInitializationError(error);
        }
      },
    );
  } catch (error: unknown) {
    if (error instanceof RunbookCompositionUnsupportedError) {
      return {
        kind: 'refused',
        code: 'RUNBOOK_COMPOSITION_UNSUPPORTED',
        message: `Inline child ${reservation.runbook} at ${at} could not be launched: ${error.message}`,
        recovery: 'permanent',
      };
    }
    if (error instanceof InlineChildInitializationError) {
      return {
        kind: 'refused',
        code: INLINE_CHILD_LAUNCH_FAILED_CODE,
        message: `Inline child ${reservation.runId} at ${at} could not be initialised: ${getErrorMessage(error.cause)}; nothing was written`,
        recovery: 'permanent',
      };
    }
    // The reserved id is a primary key: a row already under it means another
    // of the owner's commands launched this child first.
    if ((await deps.manager.loadWithVersion(reservation.runId)) !== null) {
      return {
        kind: 'refused',
        code: 'CONCURRENT_MODIFICATION',
        message: `Inline child ${reservation.runId} at ${at} was launched by another command while this one prepared it; nothing was written — re-read the run and re-issue the command`,
        recovery: 'retryable',
      };
    }
    throw error;
  }
  const child = await deps.manager.loadWithVersion(created.id);
  if (child === null) {
    throw new Error(`Inline child ${created.id} vanished during its own launch`);
  }
  args.childSink(child.state).emit({
    type: 'RUNBOOK_STARTED',
    payload: {
      title: child.state.title,
      description: child.state.description,
      prompted: child.state.prompted,
    },
  });
  return { kind: 'launched', child };
}

/**
 * The `CHILD_RESULT` event that Collects a terminal Inline Child.
 *
 * The child's terminal lifecycle is its Child Result; its final variables are
 * the frontmatter OUTPUTS it evaluated at termination.
 *
 * @param child - The child run, read from its own row.
 * @returns The machine event, and the Child Result it carries.
 * @throws {Error} When the child is still running.
 */
export function childResultEvent(child: RunbookState): {
  readonly event: {
    readonly type: 'CHILD_RESULT';
    readonly childRunId: RunId;
    readonly result: ChildResult;
    readonly vars: Readonly<Record<string, VariableValue>>;
  };
  readonly result: ChildResult;
} {
  const result = childResultOf(child.lifecycle);
  if (result === undefined) {
    throw new Error(`Inline child ${child.id} is still running and has no Child Result`);
  }
  return {
    event: { type: 'CHILD_RESULT', childRunId: child.id, result, vars: child.finalVars ?? {} },
    result,
  };
}

/**
 * How many Inline Children deep `run` sits below its root.
 *
 * Counted from the root along the linkage chain, never from where an
 * activation started: a chain that grows one level per command (a runbook that
 * lists itself, entered again by each `pass`) reaches the same bound as one
 * built in a single activation. The walk stops one past
 * {@link MAX_INLINE_CHILD_DEPTH}, which no chain can reach.
 *
 * @param manager - State manager.
 * @param run - The run, with its linkage.
 * @returns The run's depth: 0 for a root.
 */
export async function inlineDepthOf(
  manager: RunbookStateManager,
  run: Pick<VersionedRunState, 'linkage'>,
): Promise<number> {
  let depth = 0;
  let linkage = run.linkage;
  while (linkage?.kind === 'inline' && depth <= MAX_INLINE_CHILD_DEPTH) {
    depth++;
    linkage = (await manager.loadWithVersion(linkage.parentRunId))?.linkage ?? null;
  }
  return depth;
}

/**
 * The running parent that still counts `childRunId` as its Current Child, or
 * `undefined`.
 *
 * The ascent rule of Run Progression: when a child reaches a terminal, its
 * parent is driven next — only if the parent is running and the child is the
 * reservation of the parent's active entry. A stale child (an earlier entry,
 * since re-entered by GOTO, RETRY or the next iteration) is never collected.
 *
 * @param manager - State manager.
 * @param child - The child row.
 * @returns The parent run, or `undefined`.
 */
export async function inlineParentCounting(
  manager: RunbookStateManager,
  child: VersionedRunState,
): Promise<VersionedRunState | undefined> {
  const linkage = child.linkage;
  if (linkage?.kind !== 'inline') return undefined;
  const parent = await manager.loadWithVersion(linkage.parentRunId);
  if (parent === null || (parent.state.lifecycle ?? 'running') !== 'running') return undefined;
  return currentInlineReservation(parent.state)?.runId === child.state.id ? parent : undefined;
}
