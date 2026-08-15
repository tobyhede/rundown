import {
  assertRunId,
  classifyInlineLaunchOwnership,
  isInlineLaunchIntentWithoutParentEntry,
  recordInlineLaunchStart,
  type FrameKey,
  type InlineLaunchIntent,
  type InlineLaunchOwnership,
  type InlineLaunchStart,
  type InlineLinkage,
  type ParentLinkage,
  type ResolvedStep,
  type RunbookActorService,
  type RunbookState,
  type RunbookStateManager,
} from '@rundown-org/core';

/**
 * Whether an already-persisted inline child describes the launch its parent is
 * currently attempting, and if not, why not.
 *
 * The two refusal arms are deliberately distinct conditions with distinct
 * remedies, so they are separate variants rather than one "not equal" boolean:
 *
 * - `superseded-entry` — the child names the same parent, substep and frame, at
 *   a *different* frame entry. This is the staleness rule, not corruption. A
 *   self-targeting GOTO/RETRY is a genuine frame re-entry that advances the
 *   entry counter, and a child stamped at the previous entry belongs to that
 *   previous entry — the same judgement `classifyDelegationLiveness` makes when
 *   it closes a delegated child `cursor-advanced` because the parent's current
 *   entry no longer matches the one captured at delegation time. Inline children
 *   follow the delegation rule.
 * - `conflicting-parent` — the child names a different parent run, substep,
 *   step or frame, or was not linked inline at all. That is inconsistent state,
 *   not a superseded generation.
 */
export type InlineChildLinkageMatch =
  | { readonly kind: 'matched' }
  | {
      readonly kind: 'superseded-entry';
      /** Frame entry the persisted child was launched at. */
      readonly recordedEntry: number;
      /** Frame entry the parent has now reached for the same frame. */
      readonly currentEntry: number;
    }
  | { readonly kind: 'conflicting-parent' };

/**
 * Classify a persisted inline child's parent linkage against the linkage the
 * parent's current launch intent describes.
 *
 * This is the inline-child staleness check. `parentEntry` is not one field
 * among several here: the four coordinate fields answer "is this the same
 * launch site?" and `parentEntry` answers "is this the same *visit* to it?".
 * Collapsing the two would make a genuinely stale child indistinguishable from
 * a live one, which is the failure the entry counter exists to prevent, so the
 * coordinate check is evaluated first and reported as its own outcome.
 *
 * @param recorded - Parent linkage persisted on the existing child run, if any.
 * @param current - Linkage the parent's active inline launch intent describes.
 * @returns The typed match outcome; callers must narrow before refusing.
 */
export function classifyInlineChildLinkage(
  recorded: ParentLinkage | undefined,
  current: InlineLinkage,
): InlineChildLinkageMatch {
  if (
    recorded?.kind !== 'inline' ||
    recorded.parentRunId !== current.parentRunId ||
    recorded.parentStepId !== current.parentStepId ||
    recorded.parentStep !== current.parentStep ||
    recorded.parentFrameKey !== current.parentFrameKey
  ) {
    return { kind: 'conflicting-parent' };
  }
  if (recorded.parentEntry !== current.parentEntry) {
    return {
      kind: 'superseded-entry',
      recordedEntry: recorded.parentEntry,
      currentEntry: current.parentEntry,
    };
  }
  return { kind: 'matched' };
}

/**
 * Whether the parent's persisted intent still names the launch being observed.
 *
 * The shape guard is core's, not a local copy. Core drives it from a field-guard
 * map keyed by `keyof InlineLaunchIntentWithoutParentEntry`, so adding a field to
 * the intent breaks compilation there until the runtime check catches up — a
 * property a hand-rolled `&&` chain in this package could not have, and would
 * have silently lost the first time the intent grew a field.
 *
 * What is decided HERE is the comparison the guard cannot make: whether the
 * intent that survived validation names *this* launch rather than some other one
 * the parent has since prepared.
 *
 * @param state - Parent state read inside the compare-and-swap cycle.
 * @param observed - Intent the observer is acting on.
 * @returns `true` when the persisted intent names this exact launch.
 */
function persistedInlineLaunchIntentMatches(
  state: RunbookState,
  observed: InlineLaunchIntent,
): boolean {
  // Optional at every hop, because `RunbookState.snapshot` is genuinely
  // optional: a run created but never initialised carries none. The cast used to
  // assert it away while still guarding `context`, so a parent with no snapshot threw
  // a TypeError out of the compare-and-swap callback instead of refusing. Absent
  // means "no intent I can read", which is `superseded` — the fail-closed answer,
  // and the same one an intent that names another launch gets.
  const snapshot = state.snapshot as
    | { readonly context?: { readonly inlineLaunchIntent?: unknown } }
    | undefined;
  const candidate = snapshot?.context?.inlineLaunchIntent;
  if (!isInlineLaunchIntentWithoutParentEntry(candidate)) return false;
  return (
    candidate.parentRunId === observed.parentRunId &&
    candidate.parentStepId === observed.parentStepId &&
    candidate.parentStep === observed.parentStep &&
    candidate.parentFrameKey === observed.parentFrameKey &&
    candidate.childRunId === observed.childRunId &&
    candidate.childRunbookPath === observed.childRunbookPath &&
    candidate.childRunbookRef.source === observed.childRunbookRef.source &&
    candidate.childRunbookRef.path === observed.childRunbookRef.path
  );
}

/**
 * What the parent's substep row says about this intent's launch.
 *
 * `unrecorded` is NOT a kind of `unlatched`, and conflating the two is a
 * soundness bug rather than a naming choice. The latch lives on the substep
 * row's `inline`, and `updateInlineStarted` writes it only when that row records
 * THIS child: a row with no inline at all makes the write a silent no-op, so an
 * observer that read it as `unlatched` would report `won`, enter the launch span
 * and reach `manager.create` with nothing latched — and so would the next
 * observer, racing the store's bare `INSERT INTO runs`. A row naming a different
 * child is worse: the machine throws `Inline child run mismatch` out of the
 * compare-and-swap callback, bypassing every typed refusal.
 */
type ParentInlineLatch =
  /** The substep row does not record this launch; nothing here can be latched. */
  | { readonly kind: 'unrecorded'; readonly reason: 'no-inline-metadata' | 'other-child' }
  | InlineLaunchOwnership;

/**
 * Read the parent's latch for this intent and classify what it says.
 *
 * @param state - Parent state the compare-and-swap captured for this attempt.
 * @param intent - Inline launch intent being latched.
 * @returns Whether this launch is recorded at all and, if so, who owns its latch.
 */
function classifyParentInlineLatch(
  state: RunbookState,
  intent: InlineLaunchIntent,
): ParentInlineLatch {
  const substepState = state.substepStates?.find(
    (entry) => entry.id === intent.parentStepId && entry.frameKey === intent.parentFrameKey,
  );
  const inline = substepState?.inline;
  if (!inline) return { kind: 'unrecorded', reason: 'no-inline-metadata' };
  if (inline.childRunId !== intent.childRunId) {
    return { kind: 'unrecorded', reason: 'other-child' };
  }
  return classifyInlineLaunchOwnership(inline.started);
}

/**
 * Outcome of the atomic inline-launch latch.
 *
 * Every arm is decided against the exact version the compare-and-swap commits
 * onto, so a loser re-derives against the committed row instead of replaying a
 * decision made against a version that has moved.
 *
 * `missing` is an arm rather than a `null` beside the union so callers narrow
 * one value: "may this launch proceed, and if not, why not" is one question,
 * and answering part of it through a nullable second channel puts that part
 * outside the union a caller can switch over. The caller today routes `missing`
 * and `inactive` to the same refusal, which is unchanged and deliberate — a run
 * that vanished mid-launch is no more launchable than one that ended. The arm is
 * what makes that a decision the code states rather than a `latch === null` the
 * types never asked anyone about.
 */
export type InlineLaunchLatch =
  /** The parent run does not exist. */
  | { readonly kind: 'missing' }
  /** The parent run has ended; nothing may be launched under it. */
  | { readonly kind: 'inactive' }
  /** The persisted intent is gone or names a different launch. */
  | { readonly kind: 'superseded' }
  /** A run already exists under the intent's child id, but is not this launch's. */
  | {
      readonly kind: 'linkage-refused';
      readonly mismatch: Exclude<InlineChildLinkageMatch, { kind: 'matched' }>;
    }
  /**
   * The parent's substep row does not record this launch, so it cannot be
   * latched — see {@link ParentInlineLatch} for why launching anyway would
   * reintroduce the duplicate `INSERT INTO runs` the latch exists to prevent.
   */
  | {
      readonly kind: 'unrecorded';
      readonly reason: 'no-inline-metadata' | 'other-child';
    }
  /**
   * A LIVE process already latched this exact launch.
   *
   * Carries no child, deliberately. Whether the owner has reached
   * `manager.create` yet does not change the answer — the launch is its owner's
   * to finish either way — and an `existingChild` here would only invite a
   * caller to adopt a run another process is executing.
   */
  | {
      readonly kind: 'already-latched';
      /** Process holding the launch, so the wait can be named rather than opaque. */
      readonly ownerPid: number;
    }
  /** This observer latched the launch and owns it. */
  | {
      readonly kind: 'won';
      readonly existingChild: RunbookState | null;
      /**
       * Pid of the dead owner this launch was taken over from, or null when the
       * latch was free.
       *
       * Carried because the two are not the same event: taking a free latch is
       * ordinary, while taking one over means a previous process died mid-launch
       * and the operator should be told so.
       */
      readonly reclaimedFrom: number | null;
    };

/**
 * The linkage an inline launch intent describes.
 *
 * The intent is the single source for every coordinate, so this is a projection
 * rather than a parallel record. It exists because both the latch and the launch
 * span need the linkage and a hand-built literal at each site is a place for one
 * of them to drift — which is also why the latch derives its own rather than
 * accepting one.
 *
 * @param intent - Inline launch intent observed on step entry.
 * @returns The linkage the intent describes.
 * @throws {Error} When `intent.parentRunId` is not a valid run id, which means
 *   the persisted intent is not one this code wrote.
 */
export function inlineLinkageFromIntent(intent: InlineLaunchIntent): InlineLinkage {
  return {
    kind: 'inline',
    parentRunId: assertRunId(intent.parentRunId),
    parentStepId: intent.parentStepId,
    parentStep: intent.parentStep,
    parentFrameKey: intent.parentFrameKey as FrameKey,
    parentEntry: intent.parentEntry,
  };
}

/**
 * Everything the latch decides against.
 *
 * The intent carries the parent run, the child run id and the linkage, so none
 * of the three is a parameter: passing them alongside would make "an intent and
 * a child id that disagree" representable, and the latch's whole job is to be
 * exactly-once for the child id the intent names.
 */
export interface InlineLaunchLatchArgs {
  /** State manager owning the parent's compare-and-swap cycle. */
  readonly manager: RunbookStateManager;
  /** Actor service used to derive the `INLINE_CHILD_STARTED` transition. */
  readonly actorService: RunbookActorService;
  /** Parsed steps the parent machine is compiled from. */
  readonly steps: readonly ResolvedStep[];
  /** Inline launch intent observed on step entry. */
  readonly intent: InlineLaunchIntent;
}

/**
 * Latch one inline launch, atomically, before any of it is performed.
 *
 * `inline.started` is the durable "I am launching this child" record, and this
 * is the single cycle that writes it. Reading the intent, testing the latch and
 * committing `INLINE_CHILD_STARTED` all happen inside one
 * {@link RunbookStateManager.mutateStateReturning} build callback, so the state
 * the decision is derived from is the state the write commits onto. That is what
 * makes the launch exactly-once: two observers of one intent cannot both reach
 * `manager.create` for the intent's fixed `childRunId` and race the store's bare
 * `INSERT INTO runs`.
 *
 * The record names its owner, so a latch is only binding while that owner runs.
 * Committing before the create is what makes the launch exactly-once, and it is
 * also what strands a launch whose process dies inside the span — the file lock
 * this replaced recovered that case through PID-aware staleness, and
 * {@link classifyInlineLaunchOwnership} is where the latch gets it back. A
 * provably dead owner is taken over; a live one is never touched, whether or not
 * the child run exists yet.
 *
 * Every refusal is decided here too, ahead of the latch write, so a refused
 * launch never records a start it did not perform. That is not tidiness: the
 * machine's own `inlineLaunchIntentActor` carries `started` forward into the
 * next intent it prepares for the same substep, so a spurious latch would make
 * every later re-entry of that frame report an already-started launch.
 *
 * The launch span itself stays OUTSIDE this callback. It resolves a runbook ref,
 * reads files, imports modules and writes warnings — external effects, which a
 * callback that re-runs once per compare-and-swap attempt must not perform.
 *
 * @remarks
 * The callback re-runs per attempt (up to 8), so it must be safe to repeat. Its
 * own work is three reads and a derivation — the liveness probe is the third.
 * The probe is a pure read, which is what makes it admissible here, but it is
 * not uniformly as cheap as the `kill(pid, 0)` it starts with: a LIVE foreign
 * owner with a recorded start id also costs one `identity.of(pid)`, and on BSD
 * hosts that is a synchronous `/bin/ps` spawn (2s ceiling) that
 * {@link ProcessIdentity} deliberately does not memoize for foreign pids. The
 * repeat exposure is bounded by which arm pays it: `unlatched` never probes,
 * `reclaimable` on a dead pid short-circuits before the spawn, and `held`
 * commits nothing — a `null` next ends the cycle with no retry. Only the rare
 * recycled-pid reclaim (live pid, start ids disagree) can pay it more than once.
 * The record this observer would write is built ONCE, outside the callback, so a
 * retried attempt commits the identity the caller reasoned about rather than
 * re-probing the host per attempt. It reaches
 * {@link RunbookActorService.prepareActorMutation}, and for this event nothing
 * effectful is reachable: `INLINE_CHILD_STARTED` is a root-level handler with no
 * `target`, so the transition is internal — no state is exited or entered, no
 * `invoke` is started, and entry-time producer ARTIFACTS resolution (the drain's
 * one effectful exception) cannot fire. Its single action,
 * `storeInlineChildStarted`, is a pure `assign` over `substepStates`. The actor
 * hydration that precedes the send restarts nothing either: a persisted parent
 * sitting on a substep is asserted to be in the leaf's `idle` substate, which
 * declares no `invoke`. Reading the child inside the callback is safe for the
 * same reason it is correct: {@link RunbookStore.mutateState} holds no
 * transaction open across the build, so this is an ordinary read.
 *
 * @param args - Everything the latch decides against.
 * @returns The latch outcome; `missing` when the parent run does not exist.
 * @throws {Error} If {@link RunbookActorService.prepareActorMutation} rejects the
 *   derived snapshot (invalid state, actor error state).
 * @throws {ConcurrentStateModificationError} When sustained contention on the
 *   parent spends the store's optimistic retry budget. Transient: the CLI
 *   wrapper reports it as RD-308 and the gesture is safe to repeat, because a
 *   spent budget wrote nothing and left the intent unlatched.
 */
export async function latchInlineLaunch(args: InlineLaunchLatchArgs): Promise<InlineLaunchLatch> {
  const parentLinkage = inlineLinkageFromIntent(args.intent);
  const childRunId = assertRunId(args.intent.childRunId);
  // Memoized rather than eager: the refusal arms below never write, so they must
  // not pay the process-identity probe (a `/bin/ps` spawn on BSD hosts the first
  // time a process asks). Memoized rather than per-attempt because every attempt
  // must offer the identical record, so the one that commits is the one this call
  // reasoned about.
  let startedRecord: InlineLaunchStart | undefined;
  const started = (): InlineLaunchStart =>
    (startedRecord ??= recordInlineLaunchStart(new Date().toISOString()));
  const { value } = await args.manager.mutateStateReturning<InlineLaunchLatch>(
    parentLinkage.parentRunId,
    async (current) => {
      if (current.lifecycle === 'completed' || current.lifecycle === 'stopped') {
        return { next: null, value: { kind: 'inactive' } };
      }
      if (!persistedInlineLaunchIntentMatches(current, args.intent)) {
        return { next: null, value: { kind: 'superseded' } };
      }
      // Ownership first, and before the child load: a launch held by a live
      // process is refused whatever the child looks like, so loading and
      // classifying that child would be a round-trip per attempt for a decision
      // this arm discards. Liveness, never age, and never the child run's
      // absence — an observer that has latched and is still resolving the child
      // runbook leaves exactly the state a crashed one leaves.
      const ownership = classifyParentInlineLatch(current, args.intent);
      if (ownership.kind === 'held') {
        return { next: null, value: { kind: 'already-latched', ownerPid: ownership.ownerPid } };
      }
      if (ownership.kind === 'unrecorded') {
        return { next: null, value: { kind: 'unrecorded', reason: ownership.reason } };
      }
      const existingChild = await args.manager.load(childRunId);
      if (existingChild) {
        const linkageMatch = classifyInlineChildLinkage(existingChild.parentLinkage, parentLinkage);
        if (linkageMatch.kind !== 'matched') {
          return { next: null, value: { kind: 'linkage-refused', mismatch: linkageMatch } };
        }
      }
      switch (ownership.kind) {
        case 'unlatched':
        case 'reclaimable': {
          // The two arms that launch, and they differ only in what they report:
          // one takes a free latch, the other takes over a dead owner's.
          const mutation = await args.actorService.prepareActorMutation(
            parentLinkage.parentRunId,
            current,
            args.steps,
            {
              type: 'INLINE_CHILD_STARTED',
              parentStepId: args.intent.parentStepId,
              parentFrameKey: parentLinkage.parentFrameKey,
              childRunId,
              // Overwrites a dead owner's record with this process's own, so the
              // launch this observer is about to perform is the one a third
              // observer finds held. Leaving the dead pid there would let the
              // reclamation be reclaimed again, mid-span.
              started: started(),
            },
          );
          // Committed verbatim, so the latch this observer reads back is the
          // latch that was written.
          return {
            next: mutation.nextState,
            value: {
              kind: 'won',
              existingChild,
              reclaimedFrom: ownership.kind === 'reclaimable' ? ownership.ownerPid : null,
            },
          };
        }
        default: {
          const _exhaustive: never = ownership;
          return _exhaustive;
        }
      }
    },
  );
  // `value` is null exactly when the callback never ran, which happens only for
  // a missing run.
  return value ?? { kind: 'missing' };
}
