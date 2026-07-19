import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import {
  UNKNOWN_ACTOR_CONTEXT,
  verifiedClaimContext,
  type ActorContext,
  type CallerEvidence,
} from './actor-context.js';
import type { RunbookActorService } from './actor-service.js';
import { INLINE_PARENT_CYCLE_CODE, inlineParentCycleMessage } from './inline-parent-advance.js';
import { authorizeClaim, claimCanReportDelegationResult } from './claim-id.js';
import type { ClaimAuthorizationRequest, ClaimId, ClaimRecord } from './claim-id.js';
import { classifyDelegationExposureDetail } from './delegation-exposure.js';
import type {
  CommandIntent,
  CommandTargetSelector,
  DelegationPolicyOutcome,
} from './command-policy.js';
import { resolveCommandIntent } from './command-policy.js';
import { createDelegation, retryDelegation } from './delegation-service.js';
import { DelegationLockTimeoutError, type DelegationLockLike } from './delegation-lock.js';
import type { TokenScanResult } from './delegation-scan.js';
import { resolveDelegationIssuance, type RequestedRunbookArg } from './delegation-inference.js';
import { heldLock, type ScopedLock } from './file-lock.js';
import { Errors } from '../errors/factory.js';
import type { RundownError } from '../errors/rundown-error.js';
import { sameRunbookRef, type RunbookRef } from './runbook-ref.js';
import {
  resolveCommandTarget,
  resolveMutationAuthority,
  resolveTerminalTarget,
  resolveTransitionTarget,
  unknownRunRefusal,
  type TerminalCommandName,
  type TransitionCommandName,
  type TransitionTargetResolution,
  type UnknownRunRefusal,
} from './command-target-resolver.js';
import type { DELEGATION_COLLECTION_PENDING_MESSAGE } from './delegation-lifecycle-read-model.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import {
  type IssuanceAnchorResolution,
  type ResolveIssuanceAnchorOptions,
  resolveIssuanceAnchor,
} from './issuance-anchor.js';
import { isRunId, type RunId } from './run-id.js';
import {
  resolveManualCompletionCursor,
  type ExplicitTransitionTarget,
} from './manual-completion-cursor.js';
import type { CompletionLockLike } from './completion-lock.js';
import type { SessionService } from './session-service.js';
import type {
  DrainResolvedCompletionsArgs,
  DrainResolvedCompletionsResult,
  RunbookCompletionService,
} from './completion-service.js';
import type { ActionType } from './transition-kernel.js';
import {
  deriveTerminalDrainObservationEvent,
  deriveTransitionObservation,
  type TransitionObservationEvent,
} from '../events/transition-observation.js';
import type { Frame, FrameKey } from './targeting.js';
import {
  activeFrame,
  buildFrameKey,
  completionEntryForFrame,
  deriveActiveFrame,
  deriveExecutionAt,
  findSubstepState,
} from './targeting.js';
import type { ResolvedStep, RunbookState, SubstepState, TemplateVarValue } from './types.js';

/**
 * Core services the lifecycle command seam drives.
 *
 * Mirrors {@link RunbookCollectionServiceDependencies}: the seam takes its
 * collaborators through one structural interface so callers inject already
 * constructed core services and tests pass trivial doubles. The seam adds
 * `sessionService` because the decisive parent-advance write is guarded by
 * {@link SessionService.runGuardedParentAdvance} and terminal release flows
 * through {@link SessionService.releaseRunbook}.
 */
export interface RunbookLifecycleCommandServiceDependencies {
  /** Session service used for target resolution, the TOCTOU guard, and terminal release. */
  readonly sessionService: SessionService;
  /** Actor service used to dispatch top-level PASS/FAIL through the state machine. */
  readonly actorService: RunbookActorService;
  /** Lifecycle service used to ensure the active frame entry before/after a transition. */
  readonly lifecycleService: ExecutionLifecycleService;
  /** Completion service used to record and drain resolved substep completions. */
  readonly completionService: RunbookCompletionService;
  /**
   * Load a run's persisted state by id, or `undefined` when it does not exist.
   *
   * Narrow read capability used by the bare-substep inline-child reactivation
   * decision (it must inspect the running inline child's lifecycle and parent
   * linkage). Deliberately narrower than the whole {@link RunbookStateManager} so
   * test doubles stay trivial.
   */
  readonly loadRun: (runId: RunId) => Promise<RunbookState | undefined>;
  /** Delete a persisted run state by id. Used only for active-child force abort cleanup. */
  readonly deleteRun: (runId: RunId) => Promise<void>;
  /**
   * Derive the parsed steps for a resolved run from its in-memory state.
   *
   * The seam resolves the target run exactly once and then derives its steps from
   * the resolved state's `runbookSrc`. Step derivation is parsing plus an
   * environment-bound helper-registry + render context (Category A), not runbook
   * file IO — so this callable carries only that environment context, letting the
   * seam own the single resolution without taking `steps` as an input the
   * frontend would have to resolve first. The callable receives the resolved
   * state (bare/`--step` → active run; `--claim-id` → the claimed child run).
   */
  readonly loadSteps: (
    state: RunbookState,
  ) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>;
  /**
   * Resolve a child runbook name to its file path + canonical ref.
   *
   * CLI-bound (Category A: filesystem discovery via the project → plugin →
   * bundled chain). The seam invokes it lazily, only on the issuable branch,
   * so an echo of an already-issued delegation never depends on the authored
   * child still being resolvable.
   */
  readonly resolveChildRunbook: ResolveChildRunbook;
  /**
   * Persist a single issued substep entry for a run.
   *
   * CLI-bound wrapper over `RunbookStateManager.updateWithState`; mirrors
   * `loadRun` as a narrow manager capability so test doubles stay trivial. The
   * seam hands over only the one entry it issued (keyed by `(id, frameKey)`) so
   * the wrapper can merge it under a locked read-modify-write — a whole-array
   * overwrite would clobber a concurrent write to a sibling substep that landed
   * after the seam read the active state.
   */
  readonly persistIssuedSubstep: PersistIssuedSubstep;
  /**
   * Locate a delegation across runs by its plain-text token.
   *
   * CLI-bound; wraps `DelegationScanService.findByToken` (which returns
   * `TokenScanResult | null`), coercing `null → undefined`. Used by the retry
   * `token` locator, whose target run is the scan result's parent — not the
   * active run.
   */
  readonly findDelegationByToken: FindDelegationByToken;
  /**
   * Per-parent-run delegation lock serializing manual issuance and retry
   * against the other DelegationLock takers (claim, abort, completion
   * propagation).
   *
   * Narrow acquire/release contract (mirroring the `RunStateLockLike` DI
   * precedent) so test fakes stay trivial; the seam wraps the held lock with
   * `heldLock` + `await using` itself and maps
   * {@link DelegationLockTimeoutError} to a typed RD-810 error outcome.
   */
  readonly delegationLock: DelegationLockLike;
  /**
   * Per-run completion lock serializing the explicit-target transition span
   * (locked re-read → cursor derivation → record → drain) against every other
   * CompletionLock taker (bare record/drain, child-completion propagation,
   * collection). Narrow acquire/release contract mirroring `delegationLock`;
   * the seam wraps the held lock with `heldLock` + `await using` itself and
   * lets {@link CompletionLockTimeoutError} propagate — the same contract the
   * pre-span record path had when its internal lock scope timed out.
   */
  readonly completionLock: CompletionLockLike;
}

/**
 * Where the seam obtains a child runbook's resolved file identity.
 *
 * CLI-bound; wraps `resolveRunbookFile` + `buildRunbookRef`. Returns
 * `undefined` when the runbook name does not resolve to a file on disk.
 *
 * @param runbookName - Child runbook name or reference to resolve.
 * @returns The resolved path + canonical ref, or `undefined` when unresolvable.
 */
export type ResolveChildRunbook = (
  runbookName: string,
) => Promise<{ readonly path: string; readonly ref: RunbookRef } | undefined>;

/**
 * How the seam persists a single issued substep entry.
 *
 * CLI-bound; wraps `RunbookStateManager.updateWithState` so the entry is merged
 * (by `(id, frameKey)`) into the freshly-read array under the per-run lock,
 * rather than overwriting the whole array from a snapshot read outside the lock.
 *
 * @param runId - Run whose substep state is being updated.
 * @param entry - The single issued substep entry to merge by `(id, frameKey)`.
 * @returns A promise that resolves when the write completes.
 */
export type PersistIssuedSubstep = (runId: RunId, entry: SubstepState) => Promise<void>;

/**
 * Cross-run token lookup, CLI-bound (wraps `DelegationScanService.findByToken`).
 *
 * @param token - The plain-text delegation token.
 * @returns The scan result, or `undefined` when no run owns the token.
 */
export type FindDelegationByToken = (token: string) => Promise<TokenScanResult | undefined>;

/**
 * How a retry locates its target delegation.
 *
 * The `step` / `active` locators resolve against the *anchored* run — `--run`,
 * else the presented claim's controlled run, else the active default (see
 * {@link resolveIssuanceAnchor}) — which is not necessarily the active run.
 *
 * - `token` — cross-run lookup by plain-text token; the target is the owning run.
 * - `step` — the anchored run's `--step` (with optional FOR `iteration`).
 * - `active` — the anchored run's current substep cursor.
 */
export type RetryLocator =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'step'; readonly step: string; readonly iteration?: number }
  | { readonly kind: 'active' };

/** Raw explicit fresh-issuance target parsed by a frontend. */
export interface ExplicitDelegationTarget {
  /** Qualified step id, for example `1.1`. */
  readonly stepId: string;
  /** Numeric FOR iteration selected by `--index`, when supplied. */
  readonly iteration?: number;
}

/**
 * Input to {@link RunbookLifecycleCommandService.issueDelegation}.
 *
 * Discriminated on `mode`: `fresh` issues (or echoes) a delegation; `retry`
 * cancels and re-issues an existing one under a fresh token.
 */
export type DelegationIssuanceInput =
  | {
      /** Discriminant selecting the fresh-issuance path. */
      readonly mode: 'fresh';
      /**
       * Typed caller evidence mapped to an actor context for the policy gate.
       *
       * Also selects the target when no `--run` is named: a `claim_bearer`
       * unambiguously names the run it controls, so issuance anchors there even
       * when that run is not the active default (#586). See
       * {@link resolveIssuanceAnchor} for the full precedence.
       */
      readonly callerEvidence: CallerEvidence;
      /**
       * Explicit run id from `--run`. When present the issuance anchor is the
       * named session-stack run instead of the presented claim's controlled run
       * or the active default — it outranks both; a missing or foreign id
       * returns the `unknown_run` outcome. (The CLI rejects `--run` combined
       * with `--claim-id` as `INVALID_SYNTAX`, so the two are never both set
       * from that front end.)
       */
      readonly targetRunId?: RunId;
      /** Raw explicit `--step` / `--index` target; absent for bare inference. */
      readonly explicitTarget?: ExplicitDelegationTarget;
      /** Raw positional runbook arg (RD-822 confirmation); `undefined` when absent. */
      readonly requestedRunbook?: string;
      /**
       * Lazily resolve the child context's extra vars (the frontend does
       * Category-A flag parsing inside this thunk). Invoked ONLY on the issuable
       * path — after the RD-804 echo/conflict decision and the RD-822
       * requested-vs-authored mismatch check, right before `createDelegation`.
       * On the echo / conflict / no-active / refused paths no delegation is
       * minted, so the thunk is never called: an echo never depends on (or warns
       * about) extraVars validity. Mirrors the lazy `resolveChildRunbook`
       * discovery seam, preserving pre-migration ordering by construction.
       */
      readonly resolveExtraVars?: () => Promise<
        Readonly<Record<string, TemplateVarValue>> | undefined
      >;
    }
  | {
      /** Discriminant selecting the retry path. */
      readonly mode: 'retry';
      /**
       * Typed caller evidence mapped to an actor context for the policy gate.
       *
       * Also selects the target when no `--run` is named: a `claim_bearer`
       * unambiguously names the run it controls, so issuance anchors there even
       * when that run is not the active default (#586). See
       * {@link resolveIssuanceAnchor} for the full precedence.
       */
      readonly callerEvidence: CallerEvidence;
      /**
       * Explicit run id from `--run`. Replaces the anchor for the `step` /
       * `active` locators — outranking both the presented claim's controlled run
       * and the active default; a missing or foreign id returns the
       * `unknown_run` outcome. The `token` locator resolves cross-run by token
       * scan, then refuses with `run_target_mismatch` when the token's owning
       * run differs from this id — named authority is never silently discarded.
       */
      readonly targetRunId?: RunId;
      /** How the retry locates its target delegation. */
      readonly locator: RetryLocator;
      /**
       * Lazily resolve the variables overriding the inherited extraVars
       * (unspecified keys inherit). The frontend does Category-A flag parsing
       * inside this thunk. Invoked ONLY after the retry target is located and the
       * policy gate passes — right before `retryDelegation` — so a bad
       * `--input-file` (or other extra-var failure) cannot mask the higher-priority
       * retry precondition (`token-not-found` / `no-active-runbook` / refusal).
       * Mirrors the fresh path's lazy `resolveExtraVars` seam.
       */
      readonly resolveOverrides?: () => Promise<
        Readonly<Record<string, TemplateVarValue>> | undefined
      >;
    };

/**
 * Outcome of {@link RunbookLifecycleCommandService.issueDelegation}.
 *
 * Discriminated on `kind`; the frontend maps each variant to a renderer.
 */
export type DelegationIssuanceOutcome =
  | {
      readonly kind: 'delegated';
      readonly stepId: string;
      readonly runbookRef: string;
      readonly token: string;
      readonly tokenHash: string;
      readonly parentRunId: RunId;
    }
  | {
      readonly kind: 'already-delegated';
      readonly stepId: string;
      readonly runbookRef: string;
      readonly token: string;
      readonly parentRunId: RunId;
    }
  | {
      readonly kind: 'retried';
      readonly stepLabel: string;
      readonly runbookPath: string;
      readonly token: string;
      readonly tokenHash: string;
      readonly parentRunId: RunId;
    }
  | { readonly kind: 'token-not-found'; readonly token: string }
  | { readonly kind: 'no-active-runbook' }
  | UnknownRunRefusal
  | {
      /**
       * Refusal: the retry token's owning run differs from the explicit `--run`
       * target. Named authority is never silently discarded — a mismatch
       * refuses (fail-closed). The message never echoes the token's actual
       * owning run id (accident barrier — see the `unknown_run` rationale).
       */
      readonly kind: 'run_target_mismatch';
      /** Run id named by the caller via `--run`. */
      readonly runId: RunId;
      /** Operator-facing refusal message. */
      readonly message: string;
    }
  | {
      /**
       * Refusal: the presented bearer claim cannot anchor issuance because it is
       * missing, invalid for this session, stashed, or points at missing child
       * state. Carries the resolver's cause-specific message, already redacted
       * to the claim key.
       */
      readonly kind: 'stale_claim';
      /** Bearer claim id presented by the caller. */
      readonly claimId: ClaimId;
      /** Operator-facing refusal message from the shared claim resolution. */
      readonly message: string;
    }
  | {
      /**
       * Refusal: the presented bearer claim points at a terminal child runbook.
       * Unlike pass/fail there is no confirm/conflict split — delegate has no
       * expected result to reconcile a lifecycle against.
       */
      readonly kind: 'terminal_claim';
      /** Bearer claim id presented by the caller. */
      readonly claimId: ClaimId;
      /** Terminal lifecycle of the claim's controlled run. */
      readonly lifecycle: 'completed' | 'stopped';
      /** Operator-facing refusal message from the shared claim resolution. */
      readonly message: string;
    }
  | { readonly kind: 'invalid_index'; readonly message: string }
  | { readonly kind: 'retry_target_required' }
  | { readonly kind: 'refused'; readonly policy: DelegationPolicyOutcome }
  | { readonly kind: 'error'; readonly error: RundownError };

/** Result of cleaning up a force-aborted linked child delegation. */
export type ForceAbortLinkedChildCleanupResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'active_child_failed'; readonly childRunId: RunId }
  | { readonly kind: 'terminal_child_cleaned'; readonly childRunId: RunId }
  | { readonly kind: 'missing_child_cleaned'; readonly childRunId: RunId };

/**
 * Terminal side-effect policy applied when a transition reaches a terminal state.
 *
 * The seam owns terminal release because it is runbook lifecycle logic, not CLI
 * rendering: when a run completes or stops, its session targeting is released
 * (claims retained as terminal tombstones so `--claim-id` can confirm/conflict).
 */
export interface LifecycleTerminalReleasePolicy {
  /** Release the runbook from session targeting when it completes. */
  readonly onComplete: { readonly releaseRunbook: boolean };
  /** Release the runbook from session targeting when it stops. */
  readonly onStopped: { readonly releaseRunbook: boolean };
}

/** How a follow-on terminal release should treat this run during execution-loop continuation. */
export type LifecycleTerminalReleaseMode = 'release-runbook' | 'stack-pop';

/**
 * Directive telling the frontend whether to run the execution loop after the
 * seam applied a transition. The loop spawns command-step subprocesses, which is
 * inherently a CLI side effect (Category A); the seam decides whether it should
 * run and the frontend runs it.
 */
export type LifecycleLoopDirective =
  | { readonly kind: 'none' }
  | { readonly kind: 'run'; readonly prompted: boolean };

/** Input to {@link RunbookLifecycleCommandService.runTransition}. */
export interface LifecycleTransitionInput {
  /**
   * The manual transition being attempted. This is also the result the command
   * persists: `pass` drives PASS, `fail` drives FAIL. The two are the same fact,
   * so the seam derives the persisted result from `command` rather than taking a
   * second field that could silently disagree with it.
   */
  readonly command: TransitionCommandName;
  /** Typed caller evidence mapped to an actor context by core. */
  readonly callerEvidence: CallerEvidence;
  /** Discriminated target selector (default / claim / explicit-step). */
  readonly targetSelector: CommandTargetSelector;
  /** Terminal side-effect policy shared with execution-loop transitions. */
  readonly terminalPolicy: LifecycleTerminalReleasePolicy;
  /** Optional display-result policy for the transition observation projection. */
  readonly computeActionResult?: (actionType: ActionType) => boolean;
  /**
   * Raw explicit `--step` / `--index` target. Present for explicit-target
   * transitions; absent for a bare transition (the seam derives the active
   * cursor). The seam resolves it to a cursor INSIDE its completion-lock
   * scope against the locked re-read (derive-or-refuse), so no pre-resolved
   * cursor can go stale between resolution and record — the #500 TOCTOU is
   * closed by construction.
   */
  readonly explicitTarget?: ExplicitTransitionTarget;
}

/**
 * Result of applying a pass/fail transition through the seam.
 *
 * The refusal variants reuse the {@link TransitionTargetResolution} shapes so the
 * `DELEGATION_COLLECTION_PENDING_MESSAGE` literal type and the distinct terminal
 * claim confirm/conflict payloads are preserved by construction. The `applied`
 * variant carries the transition observation events for the frontend to render,
 * the coarse halted/terminal status, and a loop-continuation directive.
 */
export type LifecycleTransitionOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly result: TransitionCommandName;
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedResult: TransitionCommandName;
      readonly requestedResult: TransitionCommandName;
    }
  | {
      readonly kind: 'open_delegated_children';
      readonly parentRunId: RunId;
      readonly claims: readonly ClaimRecord[];
    }
  | {
      readonly kind: 'delegation_collection_pending';
      readonly parentRunId: RunId;
      readonly outcomeCompletionKeys: readonly string[];
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | { readonly kind: 'actor_context_required' }
  | { readonly kind: 'claim_grant_required'; readonly claimId: ClaimId; readonly runId: RunId }
  | UnknownRunRefusal
  | {
      readonly kind: 'applied';
      /** Run the transition was applied to. */
      readonly runId: RunId;
      /**
       * Which of the two mutation paths produced this outcome. The frontend uses
       * it to pick the matching renderer: a top-level `run-transition` renders a
       * single buffered action; a `manual-completion` (substep) drain renders
       * streamed execution events. (Documented domain distinction — see the Task 3
       * contract's two mutation paths — not a render-only flag.)
       */
      readonly mutation: 'run-transition' | 'manual-completion';
      /** How a follow-on execution loop should release this run terminally. */
      readonly terminalReleaseMode: LifecycleTerminalReleaseMode;
      /** Coarse transition status used by the frontend for exit-code/flow decisions. */
      readonly status: 'continue' | 'done' | 'stopped';
      /** Transition observation events for the frontend to render. */
      readonly events: readonly TransitionObservationEvent[];
      /** Whether/how the frontend should run the execution loop next. */
      readonly loop: LifecycleLoopDirective;
      /** Updated state when the run is still active (`status === 'continue'`). */
      readonly updatedState?: RunbookState;
      /**
       * Idempotent re-record marker. Present when a substep completion was already
       * recorded; the frontend renders an `already-resolved` status.
       */
      readonly duplicate?: {
        readonly at: string;
        readonly frameKey: Frame['frameKey'];
        readonly entry: number;
      };
    };

/**
 * The two {@link TransitionTargetResolution} kinds that carry a resolved run and
 * are therefore ready to drive (as opposed to refuse). Deriving this via
 * `Extract` makes adding a new ready kind a compile error in `#asRefusal`.
 */
type ReadyTransitionResolution = Extract<
  TransitionTargetResolution,
  { kind: 'claim' | 'default' | 'run' }
>;

/**
 * Result of classifying a transition target resolution: either a ready
 * resolution (narrowed so `.state` is reachable without a cast) or a typed
 * refusal outcome to return.
 */
type TransitionRefusalCheck =
  | { readonly ready: true; readonly resolution: ReadyTransitionResolution }
  | { readonly ready: false; readonly outcome: LifecycleTransitionOutcome };

/** Input to {@link RunbookLifecycleCommandService.runTerminal}. */
export interface LifecycleTerminalInput {
  /**
   * The terminal command being run. Drives FORCE_COMPLETE vs FORCE_STOP and the
   * derived delegation outcome (via lifecycleToDelegationOutcome), never a literal.
   */
  readonly command: TerminalCommandName;
  /** Typed caller evidence mapped to an actor context by core. */
  readonly callerEvidence: CallerEvidence;
  /**
   * Target selector — only `default` (bare cascade) or `claim` are valid for a
   * terminal command; an `explicit-step` selector is rejected by `runTerminal`.
   */
  readonly targetSelector: CommandTargetSelector;
  /** Optional terminal message forwarded to the machine (`FORCE_*.message`). */
  readonly message?: string;
  /** Optional display-result policy for the transition observation projection. */
  readonly computeActionResult?: (actionType: ActionType) => boolean;
}

/** Outcome of the record-before-release child propagation, surfaced for rendering/tests. */
export type TerminalReportOutcome = Awaited<
  ReturnType<RunbookCompletionService['recordChildCompletion']>
>;

/**
 * Result of a complete/stop transition through the terminal seam.
 *
 * Refusal variants reuse the {@link TerminalTargetResolution} / policy shapes so
 * the `DELEGATION_COLLECTION_PENDING_MESSAGE` literal type and the terminal-claim
 * confirm/conflict payloads (keyed on `command`) are preserved by construction.
 * There is deliberately NO `open_delegated_children` member (decision #2).
 */
export type LifecycleTerminalOutcome =
  /** No active runbook (bare path) to complete/stop. */
  | { readonly kind: 'none' }
  /** The targeted claim id does not resolve to a live claimed child. */
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  /** Bare terminal needs actor context the caller evidence did not supply. Carries no run id (accident barrier — see the resolver member's rationale). */
  | { readonly kind: 'actor_context_required' }
  /** The targeted claim proved possession but lacks the grant required for this terminal mutation. */
  | { readonly kind: 'claim_grant_required'; readonly claimId: ClaimId; readonly runId: RunId }
  | UnknownRunRefusal
  | {
      /** Refused: the resolved root has reported-but-uncollected delegation outcomes. */
      readonly kind: 'delegation_collection_pending';
      readonly parentRunId: RunId;
      readonly outcomeCompletionKeys: readonly string[];
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /** Idempotent: the claim already resolved to the requested terminal command. */
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly command: TerminalCommandName;
    }
  | {
      /** Conflict: the claim already resolved as a different terminal command. */
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedCommand: TerminalCommandName;
      readonly requestedCommand: TerminalCommandName;
    }
  | {
      /**
       * The resolved bare-cascade root was already terminal; chain cleanup occurs only for an
       * ambient/no-bearer request or a bearer authorized for the resolved chain.
       */
      readonly kind: 'already_terminal';
      readonly targetRunId: RunId;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | {
      /** Bare cascade could not resolve a running root to force. */
      readonly kind: 'inline_plan_unavailable';
      readonly reason: 'missing-inline-parent' | 'inline-cycle' | 'root-unavailable';
      readonly message: string;
      readonly code: string;
    }
  | {
      /** Single-run claim-path terminal applied. */
      readonly kind: 'applied_claim';
      readonly runId: RunId;
      readonly status: 'completed' | 'stopped';
      readonly events: readonly TransitionObservationEvent[];
      /** Outcome of recording the forced child to its parent before release. */
      readonly reported: TerminalReportOutcome;
    }
  | {
      /** Multi-run bare inline-cascade terminal applied. */
      readonly kind: 'applied_bare';
      readonly rootRunId: RunId;
      readonly status: 'completed' | 'stopped';
      /**
       * Ordered observation events (descendant→root) each carrying the id and
       * runbook ref of the state that produced it, so the frontend can stream them
       * with per-descendant attribution across the forced inline chain.
       */
      readonly events: readonly AttributedTerminalObservation[];
      readonly forcedRunIds: readonly RunId[];
      /** Outcome of recording the forced root to its parent before release. */
      readonly reported: TerminalReportOutcome;
    };

/** Input to {@link RunbookLifecycleCommandService.resolveRunNavigation}. */
export interface LifecycleNavigationInput {
  /** The navigation command being run (currently only `goto`). */
  readonly command: 'goto';
  /** Typed caller evidence mapped to an actor context by core. */
  readonly callerEvidence: CallerEvidence;
  /**
   * Target selector — `default`, `claim`, or `run`. An `explicit-step`
   * selector is rejected by `resolveRunNavigation`: the navigation target
   * (which step to jump to) is the command's positional argument, not a
   * run selector.
   */
  readonly targetSelector: CommandTargetSelector;
}

/**
 * Outcome of {@link RunbookLifecycleCommandService.resolveRunNavigation}.
 *
 * Refusal variants mirror the base {@link CommandTargetResolution} shapes; the
 * `allowed` variant carries the resolved run, its parsed steps (derived
 * in-seam via `loadSteps`), and the terminal release mode a follow-on
 * execution loop should apply — everything the frontend needs to drive the
 * navigation without re-resolving or re-gating anything.
 */
export type LifecycleNavigationOutcome =
  /** No active runbook (bare path) to navigate. */
  | { readonly kind: 'none' }
  /** The targeted claim id does not resolve to a live claimed child. */
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      /** The targeted claim id points at a terminal (completed/stopped) child. */
      readonly kind: 'terminal_claim';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly message: string;
    }
  | UnknownRunRefusal
  /**
   * The run-navigation policy gate refused the caller's evidence. Carries no
   * run id (accident barrier — see the resolver member's rationale).
   */
  | { readonly kind: 'actor_context_required' }
  | {
      /** Navigation is allowed against the resolved run. */
      readonly kind: 'allowed';
      /** Run the navigation targets. */
      readonly runId: RunId;
      /** Resolved running state of the target run. */
      readonly state: RunbookState;
      /** Parsed steps of the target run, derived in-seam. */
      readonly steps: readonly ResolvedStep[];
      /** How a follow-on execution loop should release this run terminally. */
      readonly terminalReleaseMode: LifecycleTerminalReleaseMode;
    };

/**
 * A single terminal observation event tagged with the run that produced it.
 *
 * The bare inline-cascade forces multiple runs descendant→root; each event must
 * carry its source run's id and runbook ref so the CLI can attribute streamed
 * events to the correct runbook rather than root-stamping the whole chain.
 */
export interface AttributedTerminalObservation {
  /** Id of the forced run that produced this event. */
  readonly runId: RunId;
  /** Runbook ref of the forced run that produced this event. */
  readonly runbook: RunbookRef;
  /** The projected transition observation event. */
  readonly event: TransitionObservationEvent;
}

/** Internal runtime target derived from the active cursor or an explicit cursor. */
interface ResolvedCursor {
  readonly step: string;
  readonly substep: string | undefined;
  readonly iteration: number | undefined;
  readonly frame: Frame;
  readonly at: string;
}

/**
 * Result of a substep drain-and-observe pass, shared by the bare and explicit
 * substep mutation paths. Terminal side effects are deliberately NOT applied by
 * the drain helper — `terminalStatus` is returned as data so the explicit-target
 * span can apply them only after its CompletionLock scope closes.
 */
interface SubstepDrainObservation {
  /** Observation events derived per applied completion (plus terminal divergence events). */
  readonly drainEvents: TransitionObservationEvent[];
  /** Number of completions applied during the drain. */
  readonly applied: number;
  /** State after the last applied completion (or the start state when none applied). */
  readonly observedState: RunbookState;
  /** Terminal status reached by the drain, pending caller-applied side effects. */
  readonly terminalStatus: 'done' | 'stopped' | undefined;
}

function activeCursor(state: RunbookState): ResolvedCursor {
  const active = deriveActiveFrame(state);
  const frameKey = state.activeFrameKey ?? active.frameKey;
  return {
    step: active.step,
    substep: state.substep,
    iteration: active.iteration,
    frame: activeFrame(frameKey, state.activeEntry ?? 1),
    at: deriveExecutionAt(active.step, state.substep, active.iteration),
  };
}

/**
 * Qualify a `step.substep` id with an explicit FOR iteration, yielding the
 * three-level `step.iteration.substep` form `createDelegation` reads to set the
 * context snapshot's iteration. Returns the id unchanged when no iteration is
 * supplied or the id carries no substep segment to qualify.
 *
 * @param stepId - Qualified step id (e.g. `1.1`).
 * @param iteration - Explicit FOR iteration from `--index`, or undefined.
 * @returns The iteration-qualified id (e.g. `1.2.1`), or `stepId` unchanged.
 */
function withFrameIteration(stepId: string, iteration: number | undefined): string {
  if (iteration === undefined) return stepId;
  const parsed = parseStepIdFromString(stepId);
  if (!parsed?.substep) return stepId;
  return `${parsed.step}.${String(iteration)}.${parsed.substep}`;
}

/**
 * Return the existing CLI-compatible refusal message when an explicit
 * iteration targets an authored non-FOR step. Missing steps deliberately pass
 * through so the delegation resolver retains ownership of RD-801.
 *
 * @param steps - Parsed steps from the locked runbook reread.
 * @param stepId - Raw qualified target from the frontend.
 * @returns The refusal message, or `undefined` when validation should continue.
 */
function invalidDelegationIndexMessage(
  steps: readonly ResolvedStep[],
  stepId: string,
): string | undefined {
  const parsed = parseStepIdFromString(stepId);
  if (!parsed) return undefined;
  const target = steps.find((step) => step.name === parsed.step);
  if (!target || target.kind === 'for' || target.kind === 'prompted-for') return undefined;
  return `--index requires step "${parsed.step}" to be a FOR step, but it is "${target.kind}"`;
}

/**
 * Map a terminal command to its machine FORCE event. Exhaustive over
 * {@link TerminalCommandName} with a `never` fallthrough so a future terminal
 * command cannot silently collapse to `FORCE_STOP` (No silent mapping).
 *
 * @param command - The terminal command being run (`complete` / `stop`).
 * @returns The corresponding machine force event type.
 * @throws {Error} When an unhandled terminal command is supplied.
 */
function terminalForceEvent(command: TerminalCommandName): 'FORCE_COMPLETE' | 'FORCE_STOP' {
  switch (command) {
    case 'complete':
      return 'FORCE_COMPLETE';
    case 'stop':
      return 'FORCE_STOP';
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unsupported terminal command: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Core seam for direct lifecycle command mutations (pass / fail) and the
 * transitional delegation-issuance policy precheck.
 *
 * This is the single place cross-run pass/fail mutations enter core: it maps
 * typed caller evidence to an actor context, resolves the target and runs target
 * policy (refusals), and drives the state machine for both mutation paths —
 * manual substep completion (record + drain) and top-level run transition (send
 * PASS/FAIL) — preserving the {@link SessionService.runGuardedParentAdvance}
 * TOCTOU guard and terminal release behaviour. It returns transition observation
 * events plus a loop-continuation directive as data; the frontend renders the
 * events and runs the execution loop (process spawning stays a CLI concern).
 */
export class RunbookLifecycleCommandService {
  readonly #deps: RunbookLifecycleCommandServiceDependencies;

  /**
   * Construct a lifecycle command service bound to a set of core dependencies.
   *
   * @param deps - Core services the seam drives.
   */
  constructor(deps: RunbookLifecycleCommandServiceDependencies) {
    this.#deps = deps;
  }

  async #resolveMutationActorContext(input: {
    readonly callerEvidence: CallerEvidence;
    readonly targetState: RunbookState;
    readonly request: ClaimAuthorizationRequest;
    readonly intent: CommandIntent['kind'];
  }): Promise<
    | { readonly kind: 'verified'; readonly actorContext: ActorContext }
    | { readonly kind: 'refused'; readonly policy: DelegationPolicyOutcome }
  > {
    const presentedClaimId =
      input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined;
    const authority = await resolveMutationAuthority({
      targetReader: this.#deps.sessionService,
      ...(presentedClaimId !== undefined ? { presentedClaimId } : {}),
      targetState: input.targetState,
      request: input.request,
    });
    if (authority.kind === 'verified') {
      return {
        kind: 'verified',
        actorContext: verifiedClaimContext({
          authority: authority.authority,
          claim: authority.claim,
        }),
      };
    }
    return {
      kind: 'refused',
      policy:
        presentedClaimId !== undefined && authority.reason === 'no-authorizing-claim'
          ? {
              kind: 'claim_grant_required',
              intent: input.intent,
              targetRunId: input.targetState.id,
            }
          : { kind: 'actor_context_required', intent: input.intent },
    };
  }

  /**
   * Issue, echo, or retry a delegation for an authored DELEGATE substep.
   *
   * Single entry point for `rd delegate` (and `--retry`). Maps caller evidence
   * to an actor context, runs the delegation-issuance policy gate, then either
   * mints fresh (unified `resolveDelegationIssuance` → RD-804/RD-811
   * echo/conflict → `createDelegation`) or retries (`retryDelegation`),
   * persisting in both cases. Runbook-file discovery is injected
   * (`resolveChildRunbook`); the seam owns ordering so an echo never resolves
   * the authored child.
   *
   * Inference failures (RD-813 / RD-814) surface as typed `{ kind: 'error' }`
   * outcomes carrying the same `RundownError`, not as throws — the CLI renders
   * the identical envelope by throwing the carried error.
   *
   * @param input - Fresh-issuance or retry request.
   * @returns A typed issuance outcome for the frontend to render.
   * @throws {Error} Propagates anything thrown by the injected
   *   `resolveChildRunbook`, `resolveExtraVars` / `resolveOverrides` thunks, or
   *   `persistIssuedSubstep`.
   */
  async issueDelegation(input: DelegationIssuanceInput): Promise<DelegationIssuanceOutcome> {
    if (input.mode === 'retry') return this.#issueRetry(input);

    // Target identification only — the anchor run's id (the `--run`-named
    // session-stack member, the presented claim's controlled run, or the active
    // default). Every state-dependent decision below runs against the locked
    // re-read, not this snapshot.
    const anchored = await this.#resolveIssuanceAnchor(input);
    if (anchored.kind !== 'ok') {
      switch (anchored.kind) {
        case 'unknown_run':
        case 'stale_claim':
        case 'terminal_claim':
          return anchored;
        case 'none':
          return { kind: 'no-active-runbook' };
        default: {
          const _exhaustive: never = anchored;
          return _exhaustive;
        }
      }
    }
    const active = anchored.state;
    const activeId = active.id;

    // Resolve the requested positional (only) pre-lock: fs-only and
    // state-independent, keeping the critical section tight. Never the
    // authored target — keeps the echo path independent of authored
    // resolvability.
    let requested: RequestedRunbookArg = { kind: 'none' };
    if (input.requestedRunbook) {
      const requestedResolved = await this.#deps.resolveChildRunbook(input.requestedRunbook);
      requested = requestedResolved
        ? { kind: 'resolved', ref: requestedResolved.ref, raw: input.requestedRunbook }
        : { kind: 'unresolvable', raw: input.requestedRunbook };
    }

    // DelegationLock-scoped read-modify-write (#508): read state, decide
    // (gate + resolution), mint, and persist in one critical section so a
    // concurrent delegate/--retry/claim cannot interleave and a caller can
    // never hold a token absent from persisted state.
    const lock = await this.#acquireDelegationLock(activeId);
    if (lock.kind === 'timeout') {
      return { kind: 'error', error: Errors.delegationLockTimeout(activeId) };
    }
    await using _guard = lock.scope;

    // Anchor resolution happened before the DelegationLock was acquired. A
    // session mutation can stash or unlink the claim's controlled run in that
    // window without taking this lock, so bearer/grant verification alone is
    // insufficient here. Re-run the claim resolver before reading or mutating
    // the anchored run.
    //
    // This NARROWS the window; it does not close it. `stashRunbook` serialises
    // on SessionLock, not on this DelegationLock, so the two never mutually
    // exclude — a stash can still land between this check and the write below.
    // Closing it needs an atomic resolve-and-commit under SessionLock (#608).
    const claimRefusal = await this.#revalidatePresentedClaim(input.callerEvidence);
    if (claimRefusal) return claimRefusal;

    // Locked re-read: the authoritative state for every decision below.
    const state = await this.#deps.loadRun(activeId);
    if (!state) return { kind: 'no-active-runbook' };

    // Steps are loaded ABOVE the policy gate: direct_cli classification needs
    // the parsed document (clause a/f static signals) as its input.
    const steps = await this.#deps.loadSteps(state);

    const explicitTarget = input.explicitTarget;
    // Policy gate — `targeted` means the operator named a specific step target
    // (an explicit `--step`). Only that exempts issuance from the bare-advance
    // collection-pending guard. A positional runbook arg is NOT a target: it
    // confirms the already-pending delegate substep (the bare path, subject to
    // RD-804/RD-822), so it stays `targeted: false` and remains gated. This
    // mirrors the pre-seam precheck, which keyed solely on `--step` absence.
    // Classification is from the locked re-read (`state`) — the same instance
    // the issuance resolution below decides from.
    const targeted = explicitTarget !== undefined;
    const authority = await this.#resolveMutationActorContext({
      callerEvidence: input.callerEvidence,
      targetState: state,
      request: { action: 'delegate-from-run', runId: state.id },
      intent: 'delegation-issuance',
    });
    if (authority.kind === 'refused') {
      return { kind: 'refused', policy: authority.policy };
    }

    // Exact bearer/grant authorization is the liveness proof. Observe it before
    // command policy can refuse for collection state and before any validation,
    // no-op resolution, or persistence. No SessionLock is held here.
    if (input.callerEvidence.kind === 'claim_bearer') {
      await this.#deps.sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    const policy = resolveCommandIntent({
      actorContext: authority.actorContext,
      intent: { kind: 'delegation-issuance', command: 'delegate', targeted },
      targetSelector: { kind: 'default' },
      targetState: state,
    });
    if (policy.kind !== 'allowed') return { kind: 'refused', policy };

    // Validate authored target details only after authorization succeeds. This
    // still uses the locked document, while avoiding disclosure of a named
    // step's kind to callers that cannot issue from this run.
    if (explicitTarget?.iteration !== undefined) {
      const message = invalidDelegationIndexMessage(steps, explicitTarget.stepId);
      if (message) return { kind: 'invalid_index', message };
    }

    // Frame key: an explicit --index scopes to a FOR iteration of the active
    // step; otherwise reuse the active frame. The step kind was validated above
    // against this same locked state/steps pair.
    const frameKey =
      explicitTarget?.iteration !== undefined
        ? buildFrameKey(state.step, explicitTarget.iteration)
        : (state.activeFrameKey ?? deriveActiveFrame(state).frameKey);

    // Unified issuance resolution: one pure resolver owns explicit-step
    // validation, document-order frontier scanning, and the RD-804/RD-811
    // echo-vs-conflict decisions for every invocation form (bare, --step,
    // positional). Computed before resolving the authored child so an echo
    // never depends on authored resolvability.
    const resolution = resolveDelegationIssuance(state, steps, frameKey, {
      ...(explicitTarget !== undefined ? { explicitStep: explicitTarget.stepId } : {}),
      requested,
    });
    switch (resolution.kind) {
      case 'already-issued':
        return {
          kind: 'already-delegated',
          stepId: resolution.stepId,
          runbookRef: resolution.runbookRef,
          token: resolution.token,
          parentRunId: state.id,
        };
      case 'conflict':
      case 'none':
        return { kind: 'error', error: resolution.error };
      case 'issuable':
        break; // fall through to authored-child resolution + mint
      default: {
        const _exhaustive: never = resolution;
        return _exhaustive;
      }
    }
    const resolvedStepId = resolution.stepId;
    const resolvedRunbook = resolution.runbookRef;

    // Issuable: resolve the authored child via the injected (CLI-side) resolver.
    const childResolved = await this.#deps.resolveChildRunbook(resolvedRunbook);
    if (!childResolved) {
      return { kind: 'error', error: Errors.delegationRunbookNotFound(resolvedRunbook) };
    }

    // Requested-vs-authored mismatch (RD-822): a positional that names a
    // different child than the authored target is a confirmation failure, not
    // an override. Only fires on the issuable path, where the authored child is
    // resolved anyway.
    const childRunbookRef = childResolved.ref;
    if (requested.kind === 'unresolvable') {
      return {
        kind: 'error',
        error: Errors.delegationRunbookMismatch(resolvedStepId, requested.raw, resolvedRunbook),
      };
    }
    if (requested.kind === 'resolved' && !sameRunbookRef(requested.ref, childRunbookRef)) {
      return {
        kind: 'error',
        error: Errors.delegationRunbookMismatch(resolvedStepId, requested.raw, resolvedRunbook),
      };
    }

    // Issuable path only: resolve extra vars now, after the echo/conflict and
    // requested-vs-authored decisions, so an echo never parses (or warns about)
    // vars that would never be applied.
    const resolvedExtraVars = await input.resolveExtraVars?.();

    // An explicit `--index` targets a FOR iteration that may differ from the live
    // one. `createDelegation` derives the snapshot iteration from the step id's
    // `.at` segment (not the frame key), so a bare `step.substep` id would record
    // the live FOR iteration in the context snapshot even though the frame key
    // scopes the entry to the requested iteration. Pass the iteration-qualified
    // id so the snapshot `index`/`at` match the frame the entry is stored under.
    const createStepId = withFrameIteration(resolvedStepId, explicitTarget?.iteration);

    const result = createDelegation(
      {
        state,
        stepId: createStepId,
        childRunbookPath: childResolved.path,
        childRunbookRef,
        ...(resolvedExtraVars ? { extraVars: resolvedExtraVars } : {}),
        ancestors: [],
        frameKey,
      },
      steps,
    );
    if (result.status !== 'created') return { kind: 'error', error: result.error };

    // Re-delegate-after-cancel over an existing entry supersedes the prior
    // attempt's reported outcome (no-op for a first-time issue, which has no
    // prior row). Consume before persisting the reset substep.
    const freshSubstepId = parseStepIdFromString(createStepId)?.substep ?? createStepId;
    await this.#supersedePendingOutcome(state.id, frameKey, freshSubstepId);
    await this.#persistIssuedSubstep(state.id, result.updatedSubstepStates, createStepId, frameKey);

    return {
      kind: 'delegated',
      stepId: resolvedStepId,
      // Return the canonical persisted child ref (not the authored alias in
      // `resolvedRunbook`) so the fresh `delegated` output matches the echo
      // path, which surfaces `childRunbookRef.path` for the same delegation.
      runbookRef: childRunbookRef.path,
      token: result.token,
      tokenHash: result.tokenHash,
      parentRunId: state.id,
    };
  }

  /**
   * Retry an existing delegation: locate it, gate, cancel + re-issue under a
   * fresh token, and persist.
   *
   * Locator resolution mirrors the pre-migration CLI:
   * - `token` resolves cross-run to the owning parent (not the active run);
   *   an unknown token returns `token-not-found`.
   * - `step` / `active` resolve the anchor run id before locking, then derive
   *   their frame/cursor from the locked reread. Missing step-run state returns
   *   `no-active-runbook`; a missing inferred cursor returns
   *   `retry_target_required` for the CLI's form-specific envelope.
   *
   * Unlike fresh issuance, the policy gate runs as `targeted: true`, so a pending
   * collection never refuses a retry (closing the retry policy hole for untrusted
   * front ends without changing direct-CLI behaviour).
   *
   * @param input - Retry request (locator + caller evidence + overrides).
   * @returns A typed issuance outcome for the frontend to render.
   */
  async #issueRetry(
    input: Extract<DelegationIssuanceInput, { mode: 'retry' }>,
  ): Promise<DelegationIssuanceOutcome> {
    const { locator } = input;

    type RetryCursor = {
      readonly substepId: string;
      readonly frameKey: FrameKey;
      readonly stepLabel: string;
    };

    let targetRunId: RunId;
    let cursor: RetryCursor | undefined;

    if (locator.kind === 'token') {
      const scan = await this.#deps.findDelegationByToken(locator.token);
      if (!scan) return { kind: 'token-not-found', token: locator.token };
      // Fail-closed: an explicit `--run` that names a different run than the
      // token's owner is refused, never silently discarded. The message echoes
      // only the caller-supplied id — never the token's actual owning run
      // (accident barrier).
      if (input.targetRunId !== undefined && scan.parentState.id !== input.targetRunId) {
        return {
          kind: 'run_target_mismatch',
          runId: input.targetRunId,
          message: `Run ${input.targetRunId} does not own the supplied delegation token.`,
        };
      }
      targetRunId = scan.parentState.id;
      const substepId = scan.substepId ?? scan.stepId;
      // The canonical contextSnapshot.at surfaces FOR-iteration retries as e.g.
      // "1.2.1". `buildContextSnapshot` derives `at` unconditionally, so a
      // persisted snapshot always carries it; its absence means the snapshot is
      // from an incompatible/older persisted shape. Fail closed per the
      // no-migration rule (reject; never reconstruct the label from legacy
      // `substep`/`stepId` fields) — mirroring the downstream staleness gate.
      const snapshot = scan.delegation.contextSnapshot;
      if (snapshot.at === undefined) {
        return {
          kind: 'error',
          error: Errors.delegationSnapshotStale(substepId, scan.stepId),
        };
      }
      cursor = { substepId, frameKey: scan.frameKey, stepLabel: snapshot.at };
    } else {
      const anchored = await this.#resolveIssuanceAnchor(input);
      if (anchored.kind !== 'ok') {
        switch (anchored.kind) {
          case 'unknown_run':
          case 'stale_claim':
          case 'terminal_claim':
            return anchored;
          case 'none':
            return locator.kind === 'active'
              ? { kind: 'retry_target_required' }
              : { kind: 'no-active-runbook' };
          default: {
            const _exhaustive: never = anchored;
            return _exhaustive;
          }
        }
      }
      // Target identification only. Every state-dependent locator decision is
      // deferred until after this run's DelegationLock is held and its state is
      // reloaded.
      targetRunId = anchored.state.id;
    }

    // DelegationLock-scoped read-modify-write (#508): the target run id above
    // selects the mutex; locator validation/derivation, gate, retry, and persist
    // all use the authoritative state reread while it is held.
    const lock = await this.#acquireDelegationLock(targetRunId);
    if (lock.kind === 'timeout') {
      return { kind: 'error', error: Errors.delegationLockTimeout(targetRunId) };
    }
    await using _guard = lock.scope;

    // As on fresh issuance, the target may have become stashed or otherwise
    // unlinked after pre-lock anchor/token resolution. Revalidate the presented
    // claim's runnable relationship before the retry decision can mutate it.
    // Narrows the same window the fresh path documents above; #608 closes it.
    const claimRefusal = await this.#revalidatePresentedClaim(input.callerEvidence);
    if (claimRefusal) return claimRefusal;

    const freshState = await this.#deps.loadRun(targetRunId);
    if (!freshState) {
      if (locator.kind === 'token') return { kind: 'token-not-found', token: locator.token };
      return locator.kind === 'active'
        ? { kind: 'retry_target_required' }
        : { kind: 'no-active-runbook' };
    }

    // Steps are loaded before locator validation and policy: both decisions use
    // the same locked state/document pair.
    const steps = await this.#deps.loadSteps(freshState);

    if (locator.kind === 'step') {
      const parsed = parseStepIdFromString(locator.step);
      const stepName = parsed?.step ?? locator.step;
      const substepId = parsed?.substep ?? stepName;
      let frameKey: FrameKey;
      if (locator.iteration !== undefined) {
        frameKey = buildFrameKey(stepName, locator.iteration);
      } else {
        // No explicit iteration: reuse the active frame when it is on the
        // requested step, else fall back to the step's base frame (matching how
        // createDelegation scopes lookup for a step-form caller).
        const activeDerived = deriveActiveFrame(freshState);
        frameKey =
          activeDerived.step === stepName
            ? (freshState.activeFrameKey ?? activeDerived.frameKey)
            : buildFrameKey(stepName);
      }
      // Canonicalize the label to the resolved frame: an explicit `--index`
      // surfaces as e.g. "1.2.1" (matching the token/active retry forms), not the
      // bare "1.1" that drops the iteration.
      const stepLabel =
        locator.iteration !== undefined
          ? deriveExecutionAt(stepName, parsed?.substep, locator.iteration)
          : locator.step;
      cursor = { substepId, frameKey, stepLabel };
    } else if (locator.kind === 'active') {
      if (freshState.substep === undefined) return { kind: 'retry_target_required' };
      // Surface the same canonical location used by token/step retries: an
      // active FOR iteration renders as e.g. "1.2.1", not just "1.1".
      const activeDerived = deriveActiveFrame(freshState);
      cursor = {
        substepId: freshState.substep,
        frameKey: freshState.activeFrameKey ?? activeDerived.frameKey,
        stepLabel: deriveExecutionAt(freshState.step, freshState.substep, activeDerived.iteration),
      };
    }

    if (!cursor) throw new Error('Retry locator did not resolve a cursor');
    const { substepId, frameKey, stepLabel } = cursor;

    // Policy gate — `targeted: true` (a retry re-issues a specific delegation),
    // so a pending collection does not refuse it. Classification is from the
    // locked re-read (`freshState`) — the same instance retryDelegation
    // decides from.
    const authority = await this.#resolveMutationActorContext({
      callerEvidence: input.callerEvidence,
      targetState: freshState,
      request: { action: 'retry-delegation', runId: freshState.id, stepId: substepId },
      intent: 'delegation-issuance',
    });
    if (authority.kind === 'refused') {
      return { kind: 'refused', policy: authority.policy };
    }

    // Retry bearer/grant authorization independently proves liveness before
    // command policy, validation, or persistence. The total recorder cannot
    // prevent or mask any later refusal/outcome (RD-102).
    if (input.callerEvidence.kind === 'claim_bearer') {
      await this.#deps.sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    const policy = resolveCommandIntent({
      actorContext: authority.actorContext,
      intent: {
        kind: 'delegation-issuance',
        command: 'retry',
        targeted: true,
        stepId: substepId,
      },
      targetSelector: { kind: 'default' },
      targetState: freshState,
    });
    if (policy.kind !== 'allowed') return { kind: 'refused', policy };

    // As on the fresh path, authorization precedes authored-step validation so
    // an unauthorized retry cannot probe whether a named step is iterable.
    if (locator.kind === 'step' && locator.iteration !== undefined) {
      const message = invalidDelegationIndexMessage(steps, locator.step);
      if (message) return { kind: 'invalid_index', message };
    }

    // Resolve overrides only now — after the locator resolved and the gate
    // passed — so a bad `--input-file` (or other extra-var failure) cannot mask
    // the higher-priority retry precondition (`token-not-found` /
    // `no-active-runbook` / refusal). Mirrors the fresh path's lazy seam.
    const overrides = await input.resolveOverrides?.();

    const targetSubstep = freshState.substepStates?.find(
      (entry) => entry.id === substepId && entry.frameKey === frameKey,
    );
    const linkedChildRunId = targetSubstep?.delegation?.childRunId ?? null;
    const linkedChild = linkedChildRunId ? await this.#deps.loadRun(linkedChildRunId) : undefined;
    const linkedChildTerminal =
      linkedChild?.lifecycle === 'completed' || linkedChild?.lifecycle === 'stopped';
    const allowLinkedChildRun = linkedChildTerminal;

    const result = retryDelegation(
      {
        state: freshState,
        substepId,
        frameKey,
        allowLinkedChildRun,
        ...(overrides ? { overrides } : {}),
      },
      steps,
    );
    // Every non-`retried` variant carries a `RundownError` (RD-801/802/823 or a
    // propagated createDelegation error), so the dispatch collapses to one arm.
    if (result.status !== 'retried') return { kind: 'error', error: result.error };

    await this.#supersedePendingOutcome(freshState.id, frameKey, substepId);
    if (linkedChildRunId && allowLinkedChildRun) {
      await this.#deps.sessionService.releaseRunbook(linkedChildRunId);
    }
    await this.#persistIssuedSubstep(
      freshState.id,
      result.updatedSubstepStates,
      substepId,
      frameKey,
    );

    return {
      kind: 'retried',
      stepLabel,
      runbookPath: result.delegation.childRunbookPath,
      token: result.token,
      tokenHash: result.tokenHash,
      parentRunId: freshState.id,
    };
  }

  /**
   * Clean up a force-aborted linked child while the caller holds DelegationLock.
   *
   * Active children are explicitly failed and deleted. Terminal or missing
   * linked children have any stale delegated outcome rows superseded without
   * deleting terminal diagnostic state.
   *
   * @param args - Parent, child, frame, and substep cleanup target.
   * @param args.parentState - Parent state whose linked delegation is being cleaned up.
   * @param args.childRunId - Linked child run id, or null when no child was recorded.
   * @param args.frameKey - Parent frame key containing the delegated substep.
   * @param args.substepId - Parent substep id being force-aborted.
   * @returns Cleanup branch that ran.
   */
  async cleanupForceAbortedLinkedChild(args: {
    readonly parentState: RunbookState;
    readonly childRunId: RunId | null;
    readonly frameKey: FrameKey;
    readonly substepId: string;
  }): Promise<ForceAbortLinkedChildCleanupResult> {
    if (!args.childRunId) return { kind: 'none' };

    const childState = await this.#deps.loadRun(args.childRunId);
    const childIsActive = childState?.lifecycle === 'running';
    const childIsTerminal =
      childState?.lifecycle === 'completed' || childState?.lifecycle === 'stopped';

    if (childIsActive) {
      await this.#deps.deleteRun(args.childRunId);
      await this.#deps.sessionService.releaseRunbook(args.childRunId);
      await this.#deps.completionService.recordChildCompletionUnlocked({
        childState,
        result: 'fail',
        ignoreCancellation: true,
      });
      return { kind: 'active_child_failed', childRunId: args.childRunId };
    }

    await this.#deps.sessionService.releaseRunbook(args.childRunId);
    await this.#deps.completionService.supersedeDelegationOutcomeUnlocked({
      runbookId: args.parentState.id,
      frameKey: args.frameKey,
      substepId: args.substepId,
    });
    return {
      kind: childIsTerminal ? 'terminal_child_cleaned' : 'missing_child_cleaned',
      childRunId: args.childRunId,
    };
  }

  /**
   * Resolve the target, run target policy, and drive the state machine for a
   * pass/fail transition.
   *
   * @param input - Command, caller evidence, target selector, and terminal policy.
   *   Steps are derived in-seam via the injected `loadSteps` dependency, not taken
   *   as an input.
   * @returns A typed refusal or an `applied` outcome carrying observation events
   *   and a loop-continuation directive.
   * @throws {Error} When state is stale/mismatched, the machine dispatch fails,
   *   a persisted completion does not match the active cursor, or an explicit
   *   `--step` / `--index` target cannot be satisfied by the locked re-read —
   *   the fail-closed staleness refusal is raised inside the completion-lock
   *   scope by the in-lock cursor derivation (step mismatch), not by pre-lock
   *   re-validation.
   * @throws {CompletionLockTimeoutError} When the explicit-target span cannot
   *   acquire the run's completion lock within the deadline (the same contract
   *   the pre-span record path had when its internal lock scope timed out).
   */
  async runTransition(input: LifecycleTransitionInput): Promise<LifecycleTransitionOutcome> {
    const { sessionService } = this.#deps;
    // `targeted` derives from the presence of an explicit step target, never
    // from the selector kind alone (decision 3): `pass --claim-id <id> --step
    // <n>` is targeted (the sanctioned operator recovery, exempt from the
    // collection guards) while a bare-shaped advance with only target selection
    // is not and stays guarded.
    const targeted = input.explicitTarget !== undefined;
    const claimId =
      input.targetSelector.kind === 'claim' ? input.targetSelector.claimId : undefined;
    const runId = input.targetSelector.kind === 'run' ? input.targetSelector.runId : undefined;

    let actorContext: ActorContext = UNKNOWN_ACTOR_CONTEXT;
    let presenterAuthorized = false;
    if (input.callerEvidence.kind === 'claim_bearer') {
      const target = await resolveCommandTarget(sessionService, {
        ...(claimId ? { claimId } : {}),
        ...(runId ? { runId } : {}),
      });
      switch (target.kind) {
        case 'claim':
        case 'terminal_claim': {
          actorContext = verifiedClaimContext({
            authority: {
              kind: 'bearer',
              claimId: target.claimId,
              claimKey: target.claim.claimKey,
            },
            claim: target.claim,
          });
          const presenterAuthority = await this.#resolveMutationActorContext({
            callerEvidence: input.callerEvidence,
            targetState: target.state,
            request: { action: 'mutate-run', runId: target.state.id },
            intent: 'delegating-run-advance',
          });
          presenterAuthorized = presenterAuthority.kind === 'verified';
          break;
        }
        case 'default':
        case 'run': {
          const authority = await this.#resolveMutationActorContext({
            callerEvidence: input.callerEvidence,
            targetState: target.state,
            request: { action: 'mutate-run', runId: target.state.id },
            intent: 'delegating-run-advance',
          });
          if (authority.kind === 'refused') {
            if (authority.policy.kind === 'claim_grant_required') {
              return {
                kind: 'claim_grant_required',
                claimId: input.callerEvidence.claimId,
                runId: target.state.id,
              };
            }
            return { kind: 'actor_context_required' };
          }
          actorContext = authority.actorContext;
          presenterAuthorized = true;
          break;
        }
        case 'none':
          break;
        case 'unknown_run':
          return { kind: 'unknown_run', runId: target.runId, message: target.message };
        case 'stale_claim':
          break;
        default: {
          const _exhaustive: never = target;
          return _exhaustive;
        }
      }
    }

    if (actorContext.kind === 'unknown' && claimId === undefined && runId === undefined) {
      const target = await resolveCommandTarget(sessionService);
      if (target.kind === 'default') {
        const refusal = await this.#refuseBareMutationOnExposedTarget(target.state, 'any');
        if (refusal) return refusal;
      }
    }

    const resolution = await resolveTransitionTarget(sessionService, {
      command: input.command,
      ...(claimId ? { claimId } : {}),
      ...(runId ? { runId } : {}),
      targeted,
      actorContext,
    });

    // Target resolution runs transition policy after bearer/grant authorization.
    // An independently authorized presenter has been seen alive at this point,
    // regardless of whether policy refuses the transition or dispatch later
    // fails. The recorder is total and self-locking, and no SessionLock is held
    // on this path, so failure cannot block or mask the mutation (RD-102).
    if (input.callerEvidence.kind === 'claim_bearer' && presenterAuthorized) {
      await sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    const checked = this.#asRefusal(resolution);
    if (!checked.ready) return checked.outcome;
    // The ready resolution carries the resolved run (claim / default / run),
    // typed so `.state` is reachable with no cast.
    const ready = checked.resolution;

    // A ready explicit-step transition must carry its raw explicit target.
    // Without it, #drive() would silently fall back to the active cursor /
    // top-level path and mutate the wrong unit. Refusals already returned
    // above, so this only fires on a ready resolution missing its target —
    // fail fast rather than silently mapping to the active cursor. All
    // state-dependent validation of the target (step match, substep existence,
    // FOR bounds, frame construction) happens in-lock inside
    // #driveSubstepExplicit against the locked re-read.
    if (input.targetSelector.kind === 'explicit-step' && input.explicitTarget === undefined) {
      throw new Error('Explicit-step transition requires an explicit target');
    }

    const terminalReleaseMode: LifecycleTerminalReleaseMode =
      ready.kind === 'claim' ? 'release-runbook' : 'stack-pop';
    // The in-lock open-children re-check applies the same rule to a run-shaped
    // ready resolution: guard when bare-shaped, exempt when the transition
    // carries an explicit step target.
    const guardOpenChildren = (ready.kind === 'default' || ready.kind === 'run') && !targeted;

    // Single resolution: derive the resolved run's steps in-seam from its
    // in-memory state, rather than taking `steps` as an input that would force the
    // frontend to resolve the target first (a redundant run-state read).
    const steps = await this.#deps.loadSteps(ready.state);

    return this.#drive(input, steps, ready.state, terminalReleaseMode, guardOpenChildren);
  }

  /**
   * Resolve the target, run terminal policy, and force a run (or an inline chain)
   * terminal for a complete/stop command.
   *
   * @param input - Command, caller evidence, target selector (default/claim), and
   *   optional message.
   * @returns A typed refusal or an `applied_claim` / `applied_bare` outcome.
   * @throws {Error} When an `explicit-step` selector is supplied (complete/stop
   *   have no `--step` surface), or on a stale-state / dispatch failure.
   */
  async runTerminal(input: LifecycleTerminalInput): Promise<LifecycleTerminalOutcome> {
    // Bare (no `--claim-id` / `--run`) complete/stop on a *delegation*-exposed
    // run requires named authority. resolveCommandIntent only forces a bearer for
    // the open-claims / collection-pending clauses; the authored-DELEGATE,
    // delegation-linkage, and sticky-delegation-record clauses would otherwise
    // let a bare direct-CLI force a delegation-exposed run terminal without a
    // `--claim-id`. The gate uses the `delegation` axis alone (not the full
    // classifyDelegationExposure union) so a purely inline-composed chain can
    // still be forced terminal bare — that contiguous-inline force is exactly
    // what #driveTerminalBare exists to do.
    if (input.callerEvidence.kind !== 'claim_bearer' && input.targetSelector.kind === 'default') {
      const target = await resolveCommandTarget(this.#deps.sessionService);
      if (target.kind === 'default') {
        const refusal = await this.#refuseBareMutationOnExposedTarget(target.state, 'delegation');
        if (refusal) return refusal;
      }
    }
    switch (input.targetSelector.kind) {
      case 'claim':
        return this.#driveTerminalClaim(input, input.targetSelector.claimId);
      case 'default':
        return this.#driveTerminalBare(input);
      case 'run':
        return this.#driveTerminalRun(input, input.targetSelector.runId);
      case 'explicit-step':
        throw new Error('complete/stop do not support --step targeting');
      default: {
        const _exhaustive: never = input.targetSelector;
        throw new Error(`Unsupported terminal target selector: ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * Refuse a bare (no `--claim-id` / `--run`) mutation whose resolved default
   * target run requires named authority.
   *
   * Bare `direct_cli` / `plugin` callers may only mutate a run with no exposure
   * on the gated axes. pass/fail/goto gate on *any* exposure (`mode: 'any'`);
   * terminal-force (`complete`/`stop`) gates on the `delegation` axis alone
   * (`mode: 'delegation'`) so it can still force a purely inline-composed chain
   * terminal with a bare command — the contiguous-inline force is the terminal
   * path's designed job, whereas a delegation-exposed run (open/collected
   * children, authored DELEGATE, delegation linkage) always needs a `--claim-id`.
   * Single-sources the exposure gate across every mutation surface so the rule
   * cannot drift.
   *
   * @param state - The resolved default target run to classify.
   * @param mode - `'any'` refuses on delegation or inline-composition exposure;
   *   `'delegation'` refuses on delegation exposure alone.
   * @returns An `actor_context_required` refusal when the run is exposed on a
   *   gated axis, otherwise `undefined`.
   */
  async #refuseBareMutationOnExposedTarget(
    state: RunbookState,
    mode: 'any' | 'delegation',
  ): Promise<{ readonly kind: 'actor_context_required' } | undefined> {
    const detail = classifyDelegationExposureDetail({
      state,
      steps: await this.#deps.loadSteps(state),
      openClaims: await this.#deps.sessionService.listOpenClaimsForParent(state.id),
    });
    const exposed =
      mode === 'delegation' ? detail.delegation : detail.delegation || detail.inlineComposition;
    return exposed ? { kind: 'actor_context_required' } : undefined;
  }

  /**
   * Resolve the target and run the run-navigation policy gate for a goto.
   *
   * The single core seam for navigation authorization — the CLI dispatches
   * into it exactly as pass/fail dispatch into {@link runTransition}, so a
   * future policy input added to core applies to goto automatically. It
   * resolves the selector through the shared target resolver, maps caller
   * evidence to an actor context (a claim-resolved target contributes its own
   * reconstructable claim evidence, exactly as the claim record proves control
   * of the claimed child), and evaluates the `run-navigation` intent: goto is
   * role-gated like an advance (unknown callers are refused) but exempt from
   * the collection-pending / open-claims guards — navigation is operator
   * control flow, not completion.
   *
   * The machine dispatch itself (`GOTO` + execution loop) stays with the
   * frontend, which already drives it through `RunbookActorService` — this
   * seam owns everything decision-shaped: resolution, evidence mapping, and
   * policy.
   *
   * @param input - Command, caller evidence, and target selector.
   * @returns A typed refusal or an `allowed` outcome carrying the resolved
   *   run, its steps, and the terminal release mode.
   * @throws {Error} When an `explicit-step` selector is supplied (the
   *   navigation target is goto's positional argument, not a selector).
   */
  async resolveRunNavigation(input: LifecycleNavigationInput): Promise<LifecycleNavigationOutcome> {
    const selector = input.targetSelector;
    if (selector.kind === 'explicit-step') {
      throw new Error('goto does not support --step run targeting');
    }

    const resolution = await resolveCommandTarget(this.#deps.sessionService, {
      ...(selector.kind === 'claim' ? { claimId: selector.claimId } : {}),
      ...(selector.kind === 'run' ? { runId: selector.runId } : {}),
    });

    switch (resolution.kind) {
      case 'claim':
      case 'default':
      case 'run':
        break;
      case 'none':
        return { kind: 'none' };
      case 'stale_claim':
        return { kind: 'stale_claim', claimId: resolution.claimId, message: resolution.message };
      case 'terminal_claim':
        return {
          kind: 'terminal_claim',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          message: resolution.message,
        };
      case 'unknown_run':
        return { kind: 'unknown_run', runId: resolution.runId, message: resolution.message };
      default: {
        const _exhaustive: never = resolution;
        return _exhaustive;
      }
    }

    const state = resolution.state;

    if (input.callerEvidence.kind !== 'claim_bearer' && selector.kind === 'default') {
      const refusal = await this.#refuseBareMutationOnExposedTarget(state, 'any');
      if (refusal) return refusal;
    }

    const actorContext =
      resolution.kind === 'claim'
        ? verifiedClaimContext({
            authority: {
              kind: 'bearer',
              claimId: resolution.claimId,
              claimKey: resolution.claim.claimKey,
            },
            claim: resolution.claim,
          })
        : await (async (): Promise<ActorContext> => {
            if (input.callerEvidence.kind !== 'claim_bearer') {
              return UNKNOWN_ACTOR_CONTEXT;
            }
            const authority = await this.#resolveMutationActorContext({
              callerEvidence: input.callerEvidence,
              targetState: state,
              request: { action: 'mutate-run', runId: state.id },
              intent: 'run-navigation',
            });
            return authority.kind === 'verified' ? authority.actorContext : UNKNOWN_ACTOR_CONTEXT;
          })();

    const policy = resolveCommandIntent({
      actorContext,
      intent: { kind: 'run-navigation', command: input.command, targeted: true },
      targetSelector: selector,
      targetState: state,
    });
    if (policy.kind !== 'allowed') {
      // The only refusing outcome a run-navigation intent can produce is the
      // role gate (navigation is exempt from the collection guards); carry no
      // run id (accident barrier).
      return { kind: 'actor_context_required' };
    }

    return {
      kind: 'allowed',
      runId: state.id,
      state,
      steps: await this.#deps.loadSteps(state),
      terminalReleaseMode: resolution.kind === 'claim' ? 'release-runbook' : 'stack-pop',
    };
  }

  // Run-targeted terminal: resolve the named session-stack run, then feed it to
  // the existing inline force-terminal plan as the root anchor. Naming a run
  // outside the stack (or a terminal one) refuses as `unknown_run` via the
  // shared stack-member resolution.
  async #driveTerminalRun(
    input: LifecycleTerminalInput,
    runId: RunId,
  ): Promise<LifecycleTerminalOutcome> {
    const member = await this.#deps.sessionService.resolveRunningStackMember(runId);
    if (member.kind !== 'running') {
      return unknownRunRefusal(runId, member);
    }
    return this.#driveTerminalBare(input, member.state);
  }

  // Claim-path terminal: resolve confirm/conflict, else FORCE the live child,
  // record its outcome (core-derived) BEFORE releasing with a retained tombstone.
  async #driveTerminalClaim(
    input: LifecycleTerminalInput,
    claimId: ClaimId,
  ): Promise<LifecycleTerminalOutcome> {
    const { sessionService, actorService, completionService } = this.#deps;
    const resolution = await resolveTerminalTarget(sessionService, {
      command: input.command,
      claimId,
    });

    switch (resolution.kind) {
      case 'stale_claim':
        return { kind: 'stale_claim', claimId: resolution.claimId, message: resolution.message };
      case 'terminal_claim_confirmed':
        // Idempotent no-op: child already terminal. Still release with retain so a
        // later --claim-id can confirm/conflict again (item 4, second site).
        // The resolver verified and authorized the bearer before confirming the
        // prior terminal outcome, so the presentation still proves liveness.
        if (input.callerEvidence.kind === 'claim_bearer') {
          await sessionService.recordClaimSeen(input.callerEvidence.claimId);
        }
        await sessionService.releaseRunbook(resolution.state.id, { retainClaimsAsTerminal: true });
        return {
          kind: 'terminal_claim_confirmed',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          command: resolution.command,
        };
      case 'terminal_claim_conflict':
        // A confirmed terminal conflict is also post-authorization evidence from
        // the claim's holder, despite refusing the requested terminal result.
        if (input.callerEvidence.kind === 'claim_bearer') {
          await sessionService.recordClaimSeen(input.callerEvidence.claimId);
        }
        await sessionService.releaseRunbook(resolution.state.id, { retainClaimsAsTerminal: true });
        return {
          kind: 'terminal_claim_conflict',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          expectedCommand: resolution.expectedCommand,
          requestedCommand: resolution.requestedCommand,
        };
      case 'claim_grant_required':
        return {
          kind: 'claim_grant_required',
          claimId: resolution.claimId,
          runId: resolution.runId,
        };
      case 'claim':
        break;
      default: {
        const _exhaustive: never = resolution;
        return _exhaustive;
      }
    }

    const state = resolution.state;
    // Route by claim SHAPE, not by grant presence: a run-control claim has no
    // delegation linkage and drives the inline force-terminal cascade; a
    // delegated-child claim carries a linkage and forces its single child while
    // reporting the outcome to the parent. Keying off a `collect-for-run` grant
    // would conflate collection authority with claim identity — the schema
    // permits a delegated claim to also hold that grant — and silently route
    // the child's delegation report through the bare cascade instead.
    const isRunControlClaim = resolution.claim.delegation === undefined;
    if (isRunControlClaim) {
      return this.#driveTerminalBare(input, state);
    }

    // `resolveTerminalTarget` verified the bearer and its mutate-run grant.
    // Observe that holder before dispatch; SessionLock is not held here and the
    // total recorder cannot mask a later terminal failure (RD-102).
    if (input.callerEvidence.kind === 'claim_bearer') {
      await sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    const steps = await this.#deps.loadSteps(state);
    const currentStep = this.#findStep(steps, state.step);
    const eventType = terminalForceEvent(input.command);

    const syncResult = await actorService.sendAndSync(state.id, steps, {
      type: eventType,
      ...(input.message !== undefined ? { message: input.message } : {}),
    });
    if (!syncResult) {
      // The claimed child raced to null: its persisted state vanished between the
      // resolver read and this dispatch, so there is nothing to force or record.
      // Release with a retained tombstone (item 4) and report the close per the
      // command's terminal intent — a claim-path race is a benign no-op close
      // (the child is already gone), so it stays command-success and propagates
      // nothing to the parent. (A bare-path race is handled distinctly in
      // #driveTerminalBare as `root-unavailable`, which exits non-zero for retry.)
      await sessionService.releaseRunbook(state.id, { retainClaimsAsTerminal: true });
      return {
        kind: 'applied_claim',
        runId: state.id,
        status: input.command === 'complete' ? 'completed' : 'stopped',
        events: [],
        reported: 'not-applicable',
      };
    }

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState: state,
      updatedState: syncResult.state,
      snapshot: syncResult.snapshot,
      result: input.command === 'complete' ? 'pass' : 'fail',
      ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
    });

    // Record BEFORE release (decision #4), but only when the verified claim also
    // carries the exact parent/child report grant. No explicit `result` → core
    // derives completed→pass / stopped→fail via lifecycleToDelegationOutcome.
    const reported = claimCanReportDelegationResult(resolution.claim, syncResult.state)
      ? await completionService.recordChildCompletion({
          childState: syncResult.state,
        })
      : 'not-applicable';

    await sessionService.releaseRunbook(state.id, { retainClaimsAsTerminal: true });

    return {
      kind: 'applied_claim',
      runId: state.id,
      status: syncResult.state.lifecycle === 'stopped' ? 'stopped' : 'completed',
      events: observation.events,
      reported,
    };
  }

  // Bare-cascade terminal: resolve the inline chain, gate the resolved root, force
  // descendant→root collecting observations, record the root outcome BEFORE
  // releasing (root retains its tombstone; descendants delete). An optional
  // `anchor` (from `--run`) replaces the active default as the chain start.
  async #driveTerminalBare(
    input: LifecycleTerminalInput,
    anchor?: RunbookState,
  ): Promise<LifecycleTerminalOutcome> {
    const { sessionService, actorService, completionService } = this.#deps;
    const plan = await sessionService.resolveActiveInlineForceTerminalPlan(input.command, anchor);

    switch (plan.status) {
      case 'none':
        return { kind: 'none' };
      case 'missing-inline-parent':
        return {
          kind: 'inline_plan_unavailable',
          reason: 'missing-inline-parent',
          message: `Inline parent ${plan.missingParentRunId} is unavailable`,
          code: 'INLINE_PARENT_UNAVAILABLE',
        };
      case 'inline-cycle':
        return {
          kind: 'inline_plan_unavailable',
          reason: 'inline-cycle',
          // Shared with the propagation guard's trip (#602): one fact, one
          // wording, one code — see `inlineParentCycleMessage`.
          message: inlineParentCycleMessage(plan.repeatedRunId),
          code: INLINE_PARENT_CYCLE_CODE,
        };
      case 'resolved':
        break;
      default: {
        const _exhaustive: never = plan;
        return _exhaustive;
      }
    }

    // Gate the resolved ROOT before forcing. A run-control claim for an inline
    // descendant may also force the inline chain it is currently executing; that
    // is the same active inline execution, not authority over an unrelated run.
    const presentedClaimId =
      input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined;
    const descendantAuthority =
      presentedClaimId !== undefined
        ? await (async () => {
            const verified = await sessionService.verifyClaimId(presentedClaimId);
            if (verified.status !== 'verified') return false;
            return plan.forceOrder.some(
              (state) =>
                state.id !== plan.targetState.id &&
                authorizeClaim(verified.claim, { action: 'mutate-run', runId: state.id }).kind ===
                  'allowed',
            );
          })()
        : false;
    const authority =
      input.callerEvidence.kind === 'claim_bearer' && !descendantAuthority
        ? await this.#resolveMutationActorContext({
            callerEvidence: input.callerEvidence,
            targetState: plan.targetState,
            request: { action: 'mutate-run', runId: plan.targetState.id },
            intent: 'terminal-run-force',
          })
        : undefined;

    const presenterAuthorized = descendantAuthority || authority?.kind === 'verified';
    // Bearer/grant authorization is complete before command policy evaluates
    // collection state. Record now so an authorized policy refusal or no-op still
    // observes the holder. No SessionLock is held; the total write is non-masking.
    if (input.callerEvidence.kind === 'claim_bearer' && presenterAuthorized) {
      await sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    if (plan.targetState.lifecycle !== 'running') {
      // Preserve the pre-existing already-terminal outcome for every caller. Clean
      // up for ambient/no-bearer or authorized bearer requests only; an unauthorized
      // bearer receives the same outcome without mutating the resolved chain.
      if (input.callerEvidence.kind !== 'claim_bearer' || presenterAuthorized) {
        await sessionService.releaseRunbooks(plan.releaseRunIds);
      }
      return {
        kind: 'already_terminal',
        targetRunId: plan.targetState.id,
        lifecycle: plan.targetState.lifecycle === 'stopped' ? 'stopped' : 'completed',
      };
    }

    if (authority?.kind === 'refused') {
      return authority.policy.kind === 'claim_grant_required' &&
        input.callerEvidence.kind === 'claim_bearer'
        ? {
            kind: 'claim_grant_required',
            claimId: input.callerEvidence.claimId,
            runId: plan.targetState.id,
          }
        : { kind: 'actor_context_required' };
    }
    const policy = resolveCommandIntent({
      actorContext:
        authority?.kind === 'verified' && !descendantAuthority
          ? authority.actorContext
          : UNKNOWN_ACTOR_CONTEXT,
      intent: { kind: 'terminal-run-force', command: input.command, targeted: false },
      targetSelector: descendantAuthority ? { kind: 'default' } : input.targetSelector,
      targetState: plan.targetState,
      openClaims: await sessionService.listOpenClaimsForParent(plan.targetState.id),
    });
    switch (policy.kind) {
      case 'allowed':
        break;
      case 'actor_context_required':
        return { kind: 'actor_context_required' };
      case 'claim_grant_required': {
        // Verified-claim authority is bearer-only, so the bearer claimId is always
        // present once narrowed to verified_claim.
        const actorContext = authority?.kind === 'verified' ? authority.actorContext : undefined;
        return actorContext?.kind === 'verified_claim'
          ? {
              kind: 'claim_grant_required',
              claimId: actorContext.authority.claimId,
              runId: plan.targetState.id,
            }
          : { kind: 'actor_context_required' };
      }
      case 'delegation_collection_pending':
        return {
          kind: 'delegation_collection_pending',
          parentRunId: policy.parentRunId,
          outcomeCompletionKeys: policy.outcomeCompletionKeys,
          message: policy.message,
        };
      case 'open_claims':
      case 'missing_outcomes':
      case 'already_collected':
      case 'collection_frame_not_active':
      case 'collection_applied':
      case 'collection_failed':
        // Unreachable for a bare terminal-run-force intent: `open_claims` is keyed
        // on `delegating-run-advance` only (decision #2 forces terminal through
        // open children), and the collection-operation / orchestrator outcomes
        // belong to the collection path (emitted by collectDelegationOutcomes,
        // never resolveCommandIntent). A real occurrence is an invariant
        // violation, not an expected refusal, so it stays a throw. Enumerating
        // them (rather than a bare `default: throw`) preserves compile-time
        // exhaustiveness. Mirrors resolveTransitionTarget.
        throw new Error(`Unexpected terminal policy outcome: ${policy.kind}`);
      default: {
        const _exhaustive: never = policy;
        return _exhaustive;
      }
    }

    const eventType = terminalForceEvent(input.command);
    const events: AttributedTerminalObservation[] = [];
    const forcedRunIds: RunId[] = [];
    let finalRootState: RunbookState = plan.targetState;

    // Force descendant→root, collecting observations instead of streaming. Each
    // event is tagged with its producing run so the frontend attributes streamed
    // events across the chain rather than root-stamping the whole cascade.
    for (const state of plan.forceOrder) {
      if (state.lifecycle !== 'running') continue;
      const steps = await this.#deps.loadSteps(state);
      const currentStep = this.#findStep(steps, state.step);
      const result = await actorService.sendAndSync(state.id, steps, {
        type: eventType,
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
      if (!result) continue; // raced to null; skip (matches prior behaviour)
      forcedRunIds.push(state.id);
      const observation = deriveTransitionObservation({
        steps,
        currentStep,
        previousState: state,
        updatedState: result.state,
        snapshot: result.snapshot,
        result: input.command === 'complete' ? 'pass' : 'fail',
        ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
      });
      for (const event of observation.events) {
        events.push({ runId: state.id, runbook: state.runbook, event });
      }
      if (state.id === plan.targetState.id) finalRootState = result.state;
    }

    // Root raced to null → never forced; surface the dedicated non-terminal outcome.
    if (!forcedRunIds.includes(plan.targetState.id)) {
      return {
        kind: 'inline_plan_unavailable',
        reason: 'root-unavailable',
        message: `Runbook state changed during force-${input.command}; retry`,
        code: 'RUNBOOK_STATE_CHANGED',
      };
    }

    // Record the ROOT outcome BEFORE releasing (decision #4). Core derives the
    // outcome; self-guards since the root's linkage is delegation-or-none (inline
    // descendants never reach here as the propagating child — only the root does).
    const reported = await completionService.recordChildCompletion({ childState: finalRootState });

    // Release descendants (no claims → delete) then the root (retain tombstone,
    // decision #3). Descendant ids are the chain minus the root.
    const descendantReleaseIds = plan.releaseRunIds.filter((id) => id !== plan.targetState.id);
    if (descendantReleaseIds.length > 0) {
      await sessionService.releaseRunbooks(descendantReleaseIds);
    }
    await sessionService.releaseRunbook(plan.targetState.id, { retainClaimsAsTerminal: true });

    return {
      kind: 'applied_bare',
      rootRunId: plan.targetState.id,
      status: finalRootState.lifecycle === 'stopped' ? 'stopped' : 'completed',
      events,
      forcedRunIds,
      reported,
    };
  }

  // Resolve the issuance anchor run via the shared `resolveIssuanceAnchor` seam
  // (`--run` > presented claim's controlled run > active default). Frontends
  // pass only raw target syntax; this seam pins the resolved id and owns every
  // state-dependent precondition against the locked reread.
  // Takes the issuance `input` directly: both `DelegationIssuanceInput` variants
  // already carry the anchor fields (`callerEvidence` + optional `targetRunId`),
  // so it satisfies `ResolveIssuanceAnchorOptions` structurally and no call site
  // has to pull those fields apart to call it.
  async #resolveIssuanceAnchor(
    options: ResolveIssuanceAnchorOptions,
  ): Promise<IssuanceAnchorResolution> {
    return resolveIssuanceAnchor(this.#deps.sessionService, options);
  }

  // Re-run the presented bearer's claim-target resolution without an explicit
  // run selector. This deliberately checks the claim's own controlled-run
  // relationship even for token retry (whose target id comes from the token):
  // `verifyClaimId` proves only bearer authenticity, while this resolver also
  // enforces stashed/linkage/terminal eligibility.
  //
  // Best-effort by construction: it reads session state that SessionLock — not
  // the caller's DelegationLock — guards, so it cannot be atomic with the write
  // that follows. It catches the (realistic) case where the mutation already
  // committed, not a concurrent one racing it. See #608.
  async #revalidatePresentedClaim(
    callerEvidence: CallerEvidence,
  ): Promise<
    | Extract<IssuanceAnchorResolution, { readonly kind: 'stale_claim' | 'terminal_claim' }>
    | undefined
  > {
    if (callerEvidence.kind !== 'claim_bearer') return undefined;

    const resolution = await this.#resolveIssuanceAnchor({ callerEvidence });
    switch (resolution.kind) {
      case 'ok':
        return undefined;
      case 'stale_claim':
      case 'terminal_claim':
        return resolution;
      case 'none':
      case 'unknown_run':
        throw new Error(`Claim-only issuance revalidation returned ${resolution.kind}`);
      default: {
        const _exhaustive: never = resolution;
        return _exhaustive;
      }
    }
  }

  // Classify a resolution as either ready (carries the resolved run) or a typed
  // refusal outcome. Returning the narrowed ready resolution lets the caller reach
  // `.state` with no cast — a new *ready* kind then fails to compile here (via the
  // `ReadyTransitionResolution` Extract) rather than silently falling through.
  #asRefusal(resolution: TransitionTargetResolution): TransitionRefusalCheck {
    switch (resolution.kind) {
      case 'claim':
      case 'default':
      case 'run':
        return { ready: true, resolution };
      case 'none':
        return { ready: false, outcome: { kind: 'none' } };
      case 'unknown_run':
        return {
          ready: false,
          outcome: {
            kind: 'unknown_run',
            runId: resolution.runId,
            message: resolution.message,
          },
        };
      case 'stale_claim':
        return {
          ready: false,
          outcome: {
            kind: 'stale_claim',
            claimId: resolution.claimId,
            message: resolution.message,
          },
        };
      case 'terminal_claim_confirmed':
        return {
          ready: false,
          outcome: {
            kind: 'terminal_claim_confirmed',
            claimId: resolution.claimId,
            lifecycle: resolution.lifecycle,
            result: resolution.result,
          },
        };
      case 'terminal_claim_conflict':
        return {
          ready: false,
          outcome: {
            kind: 'terminal_claim_conflict',
            claimId: resolution.claimId,
            lifecycle: resolution.lifecycle,
            expectedResult: resolution.expectedResult,
            requestedResult: resolution.requestedResult,
          },
        };
      case 'open_delegated_children':
        return {
          ready: false,
          outcome: {
            kind: 'open_delegated_children',
            parentRunId: resolution.parentRunId,
            claims: resolution.claims,
          },
        };
      case 'delegation_collection_pending':
        return {
          ready: false,
          outcome: {
            kind: 'delegation_collection_pending',
            parentRunId: resolution.parentRunId,
            outcomeCompletionKeys: resolution.outcomeCompletionKeys,
            message: resolution.message,
          },
        };
      case 'actor_context_required':
        return {
          ready: false,
          outcome: { kind: 'actor_context_required' },
        };
      case 'claim_grant_required':
        return {
          ready: false,
          outcome: {
            kind: 'claim_grant_required',
            claimId: resolution.claimId,
            runId: resolution.runId,
          },
        };
      default: {
        const _exhaustive: never = resolution;
        return _exhaustive;
      }
    }
  }

  // Drive the machine for the resolved target, dispatching on substep vs top-level.
  async #drive(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    state: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    guardOpenChildren: boolean,
  ): Promise<LifecycleTransitionOutcome> {
    const { actorService, lifecycleService } = this.#deps;
    const fresh = await actorService.assertFreshState(state.id, steps);
    if (!fresh) {
      throw new Error('Runbook state is stale or mismatched with current definition');
    }
    const ensured = await lifecycleService.ensureActiveEntry(state.id, undefined, state);
    const activeState = ensured.state;
    const activeStep = this.#findStep(steps, activeState.step);
    if (input.explicitTarget !== undefined) {
      // An explicit target always routes through the locked substep span, even
      // when the live cursor is parked on a top-level step — the in-lock
      // resolver refuses targets the fresh state cannot satisfy.
      return this.#driveSubstepExplicit(
        input,
        input.explicitTarget,
        steps,
        activeState,
        terminalReleaseMode,
      );
    }
    const isSubstepCompletion = Boolean(
      activeState.substep && resolvedStepHasSubsteps(activeStep) && activeStep.substeps.length,
    );
    if (isSubstepCompletion) {
      return this.#driveSubstep(input, steps, activeState, terminalReleaseMode, guardOpenChildren);
    }
    return this.#driveTopLevel(input, steps, activeState, terminalReleaseMode, guardOpenChildren);
  }

  // Manual substep completion path (bare transition): record (guarded, via the
  // locking record) then drain resolved completions via the locking drain
  // wrapper. The explicit `--step` / `--index` path is #driveSubstepExplicit.
  async #driveSubstep(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    activeState: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    guardOpenChildren: boolean,
  ): Promise<LifecycleTransitionOutcome> {
    const { completionService, sessionService } = this.#deps;
    const cursor: ResolvedCursor = activeCursor(activeState);
    const targetSubstep = cursor.substep;
    if (!targetSubstep) {
      throw new Error('Substep completion requires an active or explicit substep target');
    }

    // Bare transition at a substep whose inline child is still running: this is
    // "advance the thing the operator is looking at" — resume the child rather
    // than record a completion against the parent. The decision (is the child
    // still open?) is runbook logic and belongs in core; the effect is
    // `SessionService.pushRunbook`. The explicit `--step` path never
    // reactivates — it is a deliberate completion against a named substep.
    if (await this.#reactivateRunningInlineChild(activeState)) {
      return {
        kind: 'applied',
        runId: activeState.id,
        mutation: 'manual-completion',
        terminalReleaseMode,
        status: 'continue',
        events: [],
        loop: { kind: 'none' },
      };
    }

    const recordManualCompletion = (): ReturnType<
      RunbookCompletionService['recordManualCompletion']
    > =>
      completionService.recordManualCompletion({
        runbookId: activeState.id,
        currentState: activeState,
        targetStep: cursor.step,
        targetSubstep,
        ...(cursor.iteration !== undefined ? { targetIteration: cursor.iteration } : {}),
        targetFrame: cursor.frame,
        result: input.command,
        agentId: 'manual',
      });

    let recordResult: Awaited<ReturnType<RunbookCompletionService['recordManualCompletion']>>;
    if (guardOpenChildren) {
      const guarded = await sessionService.runGuardedParentAdvance(
        activeState.id,
        recordManualCompletion,
      );
      const guardResult = this.#guardRefusal(guarded, activeState.id);
      if (guardResult.kind === 'refusal') return guardResult.outcome;
      recordResult = guardResult.value;
    } else {
      recordResult = await recordManualCompletion();
    }

    const duplicate =
      recordResult.status === 'duplicate'
        ? {
            at: cursor.at,
            frameKey: cursor.frame.frameKey,
            entry: completionEntryForFrame(cursor.frame),
          }
        : undefined;

    const drained = await this.#drainSubstepObservations(
      input,
      steps,
      activeState,
      undefined,
      (args) => completionService.drainResolvedCompletions(args),
    );
    if (drained.terminalStatus) {
      await this.#applyTerminalSideEffects(input, drained.terminalStatus, activeState.id);
    }
    return this.#substepOutcome(activeState.id, terminalReleaseMode, drained, duplicate);
  }

  // Explicit `--step` / `--index` completion path (#500): ONE CompletionLock
  // scope spans the locked re-read, cursor derivation, record, and drain, so a
  // concurrent writer can neither orphan the recorded row nor move the cursor
  // between record and drain.
  //
  // Lock-ordering proof (roadmap item 15, amended by the 2026-07-03 plan
  // review): nothing reachable from inside this span acquires another domain
  // lock.
  // - `guardOpenChildren` is false BY CONSTRUCTION on every explicit-target
  //   path (an explicit-step selector makes the transition targeted; a
  //   claim-with---step combination resolves kind 'claim'), so the SessionLock
  //   guard (`runGuardedParentAdvance`) never nests inside this scope.
  // - `#applyTerminalSideEffects` → `sessionService.releaseRunbook` acquires
  //   the project-wide SessionLock, and IS reachable from a terminal drain —
  //   so `#drainSubstepObservations` returns the pending terminal status as
  //   data and the side effect is applied strictly AFTER the `await using`
  //   scope below closes. Applying it in-span would create a CompletionLock →
  //   SessionLock edge; the bare guarded path holds the opposite SessionLock →
  //   CompletionLock edge (`runGuardedParentAdvance` around the locking
  //   record), which would be an ABBA inversion.
  // - Remaining cross-lock edges stay acyclic: SessionLock → CompletionLock
  //   (bare guarded record — never holds CompletionLock while waiting),
  //   DelegationLock → CompletionLock (`recordChildCompletion` →
  //   `recordManualCompletion`), and every domain lock → RunStateLock (the
  //   sanctioned leaf per run-state-lock.ts). CompletionLock acquires nothing
  //   but RunStateLock inside this span.
  //
  // Hold-time note: the span holds the CompletionLock across the whole drain
  // loop, so the worst case scales with the number of queued resolved
  // completions (substep count × single-apply machine dispatch, each pass an
  // `ensureActiveEntry` + `listResolvedCompletions` + `sendAndSync` under
  // RunStateLock — milliseconds each on a local filesystem). Contenders are
  // bounded by the 5s file-lock deadline, and `recordChildCompletion` waits on
  // this lock WHILE HOLDING the parent DelegationLock, so the hold time must
  // stay well under that deadline; if a step ever carries enough substeps to
  // threaten it, cap applied completions per span and let the next locking
  // drain pick up the surplus.
  //
  // `CompletionLockTimeoutError` propagates as a throw — the same contract the
  // pre-span record path had when its internal lock scope timed out.
  async #driveSubstepExplicit(
    input: LifecycleTransitionInput,
    explicitTarget: ExplicitTransitionTarget,
    steps: readonly ResolvedStep[],
    activeState: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
  ): Promise<LifecycleTransitionOutcome> {
    const { completionService } = this.#deps;

    let drained: SubstepDrainObservation;
    let duplicate: { at: string; frameKey: FrameKey; entry: number } | undefined;
    {
      await this.#deps.completionLock.acquire(activeState.id);
      await using _guard = heldLock(
        () => this.#deps.completionLock.release(activeState.id),
        () => ({ lock: 'completion', runId: activeState.id, site: 'driveSubstepExplicit' }),
      );

      // Locked re-read: the authoritative state for cursor derivation, the
      // duplicate decision, and the drain start.
      const fresh = await this.#deps.loadRun(activeState.id);
      if (!fresh) {
        throw new Error('Runbook state is stale or mismatched with current definition');
      }

      // Derive-or-refuse INSIDE the lock: the cursor is resolved against the
      // locked re-read, so it cannot go stale before the record below (the
      // pre-#500 TOCTOU). A run that advanced off the target step refuses
      // here; a re-entered frame or a drifted FOR iteration resolves to the
      // LIVE frame/entry, so a stale-frame orphan row is unrepresentable.
      const cursor = resolveManualCompletionCursor(steps, fresh, explicitTarget);

      const recordResult = await completionService.recordManualCompletionUnlocked({
        runbookId: fresh.id,
        currentState: fresh,
        targetStep: cursor.step,
        targetSubstep: cursor.substep,
        ...(cursor.iteration !== undefined ? { targetIteration: cursor.iteration } : {}),
        targetFrame: cursor.frame,
        result: input.command,
        agentId: 'manual',
      });

      duplicate =
        recordResult.status === 'duplicate'
          ? {
              at: cursor.at,
              frameKey: cursor.frame.frameKey,
              entry: completionEntryForFrame(cursor.frame),
            }
          : undefined;

      drained = await this.#drainSubstepObservations(input, steps, fresh, cursor.frame, (args) =>
        completionService.drainResolvedCompletionsUnlocked(args),
      );
    }
    // The `await using` scope above has closed: the CompletionLock is released
    // before any terminal side effect can take the SessionLock (see the
    // lock-ordering proof in the method comment).
    if (drained.terminalStatus) {
      await this.#applyTerminalSideEffects(input, drained.terminalStatus, activeState.id);
    }
    return this.#substepOutcome(activeState.id, terminalReleaseMode, drained, duplicate);
  }

  // Drain persisted completions one at a time, deriving observation events per
  // applied completion. `drain` selects the locking variant (bare path) or the
  // unlocked twin (explicit span, which already holds the CompletionLock).
  // Terminal side effects are NOT applied here: a terminal drain returns its
  // status as data and the caller applies #applyTerminalSideEffects — the
  // explicit span must do so only after its CompletionLock scope closes
  // (SessionLock must never nest inside it).
  async #drainSubstepObservations(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    startState: RunbookState,
    frameOverride: Frame | undefined,
    drain: (args: DrainResolvedCompletionsArgs) => Promise<DrainResolvedCompletionsResult>,
  ): Promise<SubstepDrainObservation> {
    const drainEvents: TransitionObservationEvent[] = [];
    let drainState: RunbookState = startState;
    let observedState: RunbookState = startState;
    let applied = 0;
    let terminalStatus: 'done' | 'stopped' | undefined;

    drainLoop: for (;;) {
      const drained = await drain({
        runbookId: startState.id,
        steps,
        currentState: drainState,
        maxApplied: 1,
        ...(frameOverride ? { frameOverride } : {}),
      });

      if (drained.status === 'failed') {
        throw new Error(drained.message);
      }
      if (drained.status === 'not_active') {
        break;
      }

      for (const appliedCompletion of drained.applied) {
        const currentStep = this.#findStep(steps, appliedCompletion.stateBefore.step);
        const observation = deriveTransitionObservation({
          steps,
          currentStep,
          previousState: appliedCompletion.stateBefore,
          updatedState: appliedCompletion.stateAfter,
          snapshot: appliedCompletion.snapshot,
          result: appliedCompletion.completion.result,
          ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
        });
        drainEvents.push(...observation.events);
        applied += 1;
        if (observation.status === 'done' || observation.status === 'stopped') {
          terminalStatus = observation.status;
          break drainLoop;
        }
        observedState = observation.state;
        drainState = observation.state;
      }

      if (drained.status === 'done' || drained.status === 'stopped') {
        // A drain can report terminal even when the last applied completion's
        // observation did not: the drain derives terminal from the applied
        // completion's `state.lifecycle` while `deriveTransitionObservation`
        // derives it from the XState snapshot's top-level status/value, and the
        // two are independent. When that divergence happens the per-completion
        // observation above emitted only a STEP_TRANSITIONED, so emit the matching
        // terminal event here from the drain's authoritative status — otherwise
        // the run is released but the agent-facing output omits the terminal
        // envelope. The terminal status is returned as data so this exit can
        // never skip the caller-owned terminal side effect.
        const last = drained.applied.at(-1);
        if (last !== undefined) {
          drainEvents.push(
            deriveTerminalDrainObservationEvent({
              steps,
              currentStep: this.#findStep(steps, last.stateBefore.step),
              previousState: last.stateBefore,
              updatedState: last.stateAfter,
              snapshot: last.snapshot,
              status: drained.status,
              result: last.completion.result,
            }),
          );
        }
        terminalStatus = drained.status;
        break;
      }
      if (drained.applied.length === 0) {
        break;
      }
    }
    return { drainEvents, applied, observedState, terminalStatus };
  }

  // Assemble the `applied` outcome for a substep mutation, shared by the bare
  // and explicit paths.
  #substepOutcome(
    runId: RunId,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    drained: SubstepDrainObservation,
    duplicate: { at: string; frameKey: FrameKey; entry: number } | undefined,
  ): LifecycleTransitionOutcome {
    if (drained.terminalStatus) {
      return {
        kind: 'applied',
        runId,
        mutation: 'manual-completion',
        terminalReleaseMode,
        status: drained.terminalStatus,
        events: drained.drainEvents,
        loop: { kind: 'none' },
        ...(duplicate ? { duplicate } : {}),
      };
    }

    const loop: LifecycleLoopDirective =
      drained.applied > 0
        ? { kind: 'run', prompted: Boolean(drained.observedState.prompted) }
        : { kind: 'none' };
    return {
      kind: 'applied',
      runId,
      mutation: 'manual-completion',
      terminalReleaseMode,
      status: 'continue',
      events: drained.drainEvents,
      loop,
      ...(drained.applied > 0 ? { updatedState: drained.observedState } : {}),
      ...(duplicate ? { duplicate } : {}),
    };
  }

  // Top-level run transition path: send PASS/FAIL (guarded), observe, release.
  async #driveTopLevel(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    activeState: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    guardOpenChildren: boolean,
  ): Promise<LifecycleTransitionOutcome> {
    const { actorService, lifecycleService, sessionService } = this.#deps;
    const previousState: RunbookState = { ...activeState };
    const currentStep = this.#findStep(steps, previousState.step);
    // Exhaustive map from command to engine event. A `never` fallthrough makes a
    // future `TransitionCommandName` member a compile error here rather than a
    // silent collapse to FAIL (see CLAUDE.md § No silent mapping).
    const eventType = ((): 'PASS' | 'FAIL' => {
      switch (input.command) {
        case 'pass':
          return 'PASS';
        case 'fail':
          return 'FAIL';
        default: {
          const _exhaustive: never = input.command;
          throw new Error(`Unsupported transition command: ${String(_exhaustive)}`);
        }
      }
    })();

    const sendAndSync = (): ReturnType<RunbookActorService['sendAndSync']> =>
      actorService.sendAndSync(activeState.id, steps, { type: eventType });

    let syncResult: Awaited<ReturnType<RunbookActorService['sendAndSync']>>;
    if (guardOpenChildren) {
      const guarded = await sessionService.runGuardedParentAdvance(activeState.id, sendAndSync);
      const guardResult = this.#guardRefusal(guarded, activeState.id);
      if (guardResult.kind === 'refusal') return guardResult.outcome;
      syncResult = guardResult.value;
    } else {
      syncResult = await sendAndSync();
    }
    if (!syncResult) {
      throw new Error('Failed to dispatch transition to runbook engine');
    }

    const ensuredAfter = await lifecycleService.ensureActiveEntry(
      activeState.id,
      previousState,
      syncResult.state,
    );
    const updatedState = ensuredAfter.state;

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: syncResult.snapshot,
      result: input.command,
      ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
    });

    if (observation.status === 'done' || observation.status === 'stopped') {
      await this.#applyTerminalSideEffects(input, observation.status, activeState.id);
      return {
        kind: 'applied',
        runId: activeState.id,
        mutation: 'run-transition',
        terminalReleaseMode,
        status: observation.status,
        events: observation.events,
        loop: { kind: 'none' },
      };
    }

    return {
      kind: 'applied',
      runId: activeState.id,
      mutation: 'run-transition',
      terminalReleaseMode,
      status: 'continue',
      events: observation.events,
      loop: { kind: 'run', prompted: Boolean(updatedState.prompted) },
      updatedState,
    };
  }

  // Apply terminal release per policy when a transition reaches a terminal state.
  async #applyTerminalSideEffects(
    input: LifecycleTransitionInput,
    status: 'done' | 'stopped',
    runId: RunId,
  ): Promise<void> {
    const releaseRunbook =
      status === 'done'
        ? input.terminalPolicy.onComplete.releaseRunbook
        : input.terminalPolicy.onStopped.releaseRunbook;
    if (releaseRunbook) {
      await this.#deps.sessionService.releaseRunbook(runId, { retainClaimsAsTerminal: true });
    }
  }

  // Narrow a guarded-advance result to either the typed advanced value or a
  // refusal outcome. Returning a discriminated result keeps the advanced value
  // typed at both call sites (no unchecked cast), and the `never` exhaustiveness
  // guard turns any future `runGuardedParentAdvance` refusal kind into a compile
  // error here rather than a silent mis-cast of an unhandled refusal as advanced.
  #guardRefusal<V>(
    guarded:
      | { readonly kind: 'advanced'; readonly value: V }
      | { readonly kind: 'open_delegated_children'; readonly claims: ClaimRecord[] }
      | {
          readonly kind: 'delegation_collection_pending';
          readonly parentRunId: RunId;
          readonly outcomeCompletionKeys: readonly string[];
          readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
        },
    parentRunId: RunId,
  ):
    | { readonly kind: 'advanced'; readonly value: V }
    | { readonly kind: 'refusal'; readonly outcome: LifecycleTransitionOutcome } {
    switch (guarded.kind) {
      case 'advanced':
        return { kind: 'advanced', value: guarded.value };
      case 'open_delegated_children':
        return {
          kind: 'refusal',
          outcome: {
            kind: 'open_delegated_children',
            parentRunId,
            claims: guarded.claims,
          },
        };
      case 'delegation_collection_pending':
        return {
          kind: 'refusal',
          outcome: {
            kind: 'delegation_collection_pending',
            parentRunId: guarded.parentRunId,
            outcomeCompletionKeys: guarded.outcomeCompletionKeys,
            message: guarded.message,
          },
        };
      default: {
        const _exhaustive: never = guarded;
        return _exhaustive;
      }
    }
  }

  // Derive the run id of the running inline child launched at the active substep,
  // or `undefined` when the active substep has no running inline child.
  #findRunningInlineChildRunId(state: RunbookState): RunId | undefined {
    if (!state.substep) return undefined;
    const active = deriveActiveFrame(state);
    const frameKey = state.activeFrameKey ?? active.frameKey;
    const substepState = state.substepStates?.find(
      (entry) => entry.id === state.substep && entry.frameKey === frameKey,
    );
    if (substepState?.status !== 'running') return undefined;
    const childRunId = substepState.inline?.childRunId;
    return isRunId(childRunId) ? childRunId : undefined;
  }

  // Resume the active substep's running inline child when its linkage matches the
  // parent cursor, pushing it onto the session if it is not already active.
  // Returns true when the child was reactivated (caller must skip recording).
  async #reactivateRunningInlineChild(parentState: RunbookState): Promise<boolean> {
    const childRunId = this.#findRunningInlineChildRunId(parentState);
    if (!childRunId) return false;

    const childState = await this.#deps.loadRun(childRunId);
    if (childState?.lifecycle !== 'running') return false;
    const linkage = childState.parentLinkage;
    const parentFrame = deriveActiveFrame(parentState);
    const parentFrameKey = parentState.activeFrameKey ?? parentFrame.frameKey;
    const parentEntry = parentState.activeEntry ?? 1;
    if (
      linkage?.kind !== 'inline' ||
      linkage.parentRunId !== parentState.id ||
      linkage.parentStep !== parentState.step ||
      linkage.parentStepId !== parentState.substep ||
      linkage.parentFrameKey !== parentFrameKey ||
      linkage.parentEntry !== parentEntry
    ) {
      return false;
    }

    const active = await this.#deps.sessionService.getActive();
    if (active?.id !== childRunId) {
      await this.#deps.sessionService.pushRunbook(childRunId);
    }
    return true;
  }

  /**
   * Consume any pending reported delegation outcome row for a re-issued substep.
   *
   * Re-issuing (retry, or re-delegate after cancel) supersedes the prior attempt.
   * If that attempt already reported an outcome (e.g. `abort --force` recorded a
   * FAIL), its `resolvedCompletions` row is stale and MUST NOT be drained by a
   * later `rd collect`. Consume it here so collect readiness (which reads live
   * outcome rows) sees no outcome until the fresh attempt reports. Consuming
   * before persisting the reset substep narrows the window a concurrent
   * `rd collect` could drain the stale row (it does not fully close it — a retry
   * is not atomic against a concurrent collect).
   *
   * @param runId - Delegating run that owns the outcome row.
   * @param frameKey - Frame key scoping the (re)issued delegation.
   * @param substepId - Substep whose prior outcome is superseded.
   */
  async #supersedePendingOutcome(
    runId: RunId,
    frameKey: FrameKey,
    substepId: string,
  ): Promise<void> {
    await this.#deps.completionService.supersedeDelegationOutcomeUnlocked({
      runbookId: runId,
      frameKey,
      substepId,
    });
  }

  // Acquire the per-parent-run DelegationLock, wrapping the held lock as a
  // best-effort ScopedLock for `await using` (never released from a bare
  // `finally` — the RD-102 masking defect). A timeout is returned as data so
  // callers map it to a typed RD-810 error outcome rather than a throw.
  async #acquireDelegationLock(
    parentRunId: RunId,
  ): Promise<{ kind: 'held'; scope: ScopedLock } | { kind: 'timeout' }> {
    try {
      await this.#deps.delegationLock.acquire(parentRunId);
    } catch (error) {
      if (error instanceof DelegationLockTimeoutError) {
        return { kind: 'timeout' };
      }
      throw error;
    }
    return {
      kind: 'held',
      scope: heldLock(
        () => this.#deps.delegationLock.release(parentRunId),
        () => ({ lock: 'delegation', parentRunId, site: 'issueDelegation' }),
      ),
    };
  }

  // Persist exactly the issued substep entry under a locked read-modify-write.
  // The seam computes the full post-issuance array from a snapshot read outside
  // the lock; handing the manager the whole array would clobber a concurrent
  // write to a sibling substep that committed in the gap. Extract the single
  // entry the operation touched (by `(id, frameKey)`) and let the CLI-bound
  // wrapper merge it into the freshly-read array. `stepIdOrSubstep` is either a
  // qualified id (`1.2.1` → substep `1`) or a bare substep id (`1`).
  async #persistIssuedSubstep(
    runId: RunId,
    updatedSubstepStates: readonly SubstepState[],
    stepIdOrSubstep: string,
    frameKey: FrameKey,
  ): Promise<void> {
    const substepId = parseStepIdFromString(stepIdOrSubstep)?.substep ?? stepIdOrSubstep;
    const issued = findSubstepState(updatedSubstepStates, substepId, frameKey);
    if (!issued) {
      throw new Error(
        `Issued delegation substep "${substepId}" (frame ${frameKey}) missing from updated state`,
      );
    }
    await this.#deps.persistIssuedSubstep(runId, issued);
  }

  // Find a step by name, throwing on a corrupted state/steps mismatch.
  #findStep(steps: readonly ResolvedStep[], stepName: string): ResolvedStep {
    const step = steps.find((candidate) => candidate.name === stepName);
    if (!step) {
      throw new Error(`Step "${stepName}" not found in runbook definition`);
    }
    return step;
  }
}
