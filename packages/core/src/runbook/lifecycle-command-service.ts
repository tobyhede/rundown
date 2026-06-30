import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import {
  UNKNOWN_ACTOR_CONTEXT,
  actorContextFromEvidence,
  type ActorContext,
  type CallerEvidence,
} from './actor-context.js';
import type { RunbookActorService } from './actor-service.js';
import type { ClaimId, ClaimRecord } from './claim-id.js';
import type { CommandTargetSelector, DelegationPolicyOutcome } from './command-policy.js';
import { resolveCommandIntent } from './command-policy.js';
import { createDelegation, retryDelegation } from './delegation-service.js';
import type { TokenScanResult } from './delegation-scan.js';
import {
  deriveDelegateFrontier,
  inferDelegationTarget,
  inferRunbookFromStep,
  resolveDelegateTarget,
  resolveTargetedDelegation,
  type RequestedRunbookArg,
} from './delegation-inference.js';
import { Errors } from '../errors/factory.js';
import type { RundownError } from '../errors/rundown-error.js';
import { sameRunbookRef, type RunbookRef } from './runbook-ref.js';
import {
  resolveTransitionTarget,
  type TransitionCommandName,
  type TransitionTargetResolution,
} from './command-target-resolver.js';
import type { DELEGATION_COLLECTION_PENDING_MESSAGE } from './delegation-lifecycle-read-model.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import { isRunId, type RunId } from './run-id.js';
import type { SessionService } from './session-service.js';
import type { RunbookCompletionService } from './completion-service.js';
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
 * - `token` — cross-run lookup by plain-text token; the target is the owning run.
 * - `step` — the active run's `--step` (with optional FOR `iteration`).
 * - `active` — the active run's current substep cursor.
 */
export type RetryLocator =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'step'; readonly step: string; readonly iteration?: number }
  | { readonly kind: 'active' };

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
      /** Typed caller evidence mapped to an actor context for the policy gate. */
      readonly callerEvidence: CallerEvidence;
      /** Explicit step id from `--step`; `undefined` => bare inference. */
      readonly explicitStep?: string;
      /** Explicit FOR iteration from `--index`. */
      readonly explicitIteration?: number;
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
      /** Typed caller evidence mapped to an actor context for the policy gate. */
      readonly callerEvidence: CallerEvidence;
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
  | { readonly kind: 'refused'; readonly policy: DelegationPolicyOutcome }
  | { readonly kind: 'error'; readonly error: RundownError };

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

/**
 * Pre-resolved explicit substep cursor for `--step` / `--index` transitions.
 *
 * The frontend parses and validates the raw `--step` / `--index` CLI input
 * (Category A input handling) and hands the seam a resolved cursor. A bare
 * transition supplies no cursor and the seam derives the active cursor itself.
 */
export interface ManualCompletionCursor {
  /** Target step id. */
  readonly step: string;
  /** Target substep id. */
  readonly substep: string;
  /** Target FOR iteration, when applicable. */
  readonly iteration?: number;
  /** Resolved targeting frame for the completion. */
  readonly frame: Frame;
  /** Qualified position string (e.g. `1.2.1`) used in idempotent status output. */
  readonly at: string;
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
   * Pre-resolved explicit substep cursor. Present for `--step` / `--index`
   * targets; absent for a bare transition (the seam derives the active cursor).
   */
  readonly manualTarget?: ManualCompletionCursor;
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
  | { readonly kind: 'actor_context_required'; readonly targetRunId: RunId }
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

/** Internal runtime target derived from the active cursor or an explicit cursor. */
interface ResolvedCursor {
  readonly step: string;
  readonly substep: string | undefined;
  readonly iteration: number | undefined;
  readonly frame: Frame;
  readonly at: string;
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

  /**
   * Issue, echo, or retry a delegation for an authored DELEGATE substep.
   *
   * Single entry point for `rd delegate` (and `--retry`). Maps caller evidence
   * to an actor context, runs the delegation-issuance policy gate, then either
   * mints fresh (infer/target → RD-804 echo/conflict → `createDelegation`) or
   * retries (`retryDelegation`), persisting in both cases. Runbook-file discovery
   * is injected (`resolveChildRunbook`); the seam owns ordering so an echo never
   * resolves the authored child.
   *
   * @param input - Fresh-issuance or retry request.
   * @returns A typed issuance outcome for the frontend to render.
   * @throws {RundownError} When a fresh `--step` / positional / bare inference
   *   resolves a non-delegatable or runbook-less substep (the injected inference
   *   helpers throw RD-813 / RD-814); also propagates anything thrown by the
   *   injected `resolveChildRunbook`, `resolveExtraVars` / `resolveOverrides`
   *   thunks, or `persistIssuedSubstep`.
   */
  async issueDelegation(input: DelegationIssuanceInput): Promise<DelegationIssuanceOutcome> {
    if (input.mode === 'retry') return this.#issueRetry(input);

    const state = await this.#deps.sessionService.getActive();
    if (!state) return { kind: 'no-active-runbook' };

    // Policy gate — `targeted` means the operator named a specific step target
    // (an explicit `--step`). Only that exempts issuance from the bare-advance
    // collection-pending guard. A positional runbook arg is NOT a target: it
    // confirms the already-pending delegate substep (the bare path, subject to
    // RD-804/RD-822), so it stays `targeted: false` and remains gated. This
    // mirrors the pre-seam precheck, which keyed solely on `--step` absence.
    const targeted = input.explicitStep !== undefined;
    const actorContext = actorContextFromEvidence(input.callerEvidence, state.id);
    const policy = resolveCommandIntent({
      actorContext,
      intent: { kind: 'delegation-issuance', command: 'delegate', targeted },
      targetSelector: { kind: 'default' },
      targetState: state,
    });
    if (policy.kind !== 'allowed') return { kind: 'refused', policy };

    const steps = await this.#deps.loadSteps(state);

    // Inference: map the four CLI branches into the seam.
    //   - explicit --step: the authored runbook is inferred from the substep.
    //   - bare (no step, no positional): derive the frontier and echo or pick.
    //   - positional only (no step): infer the first pending delegate substep.
    // `inferRunbookFromStep` / `inferDelegationTarget` throw RD-813/814 on a
    // non-delegatable or runbook-less substep, matching the pre-migration CLI,
    // which called them inside the same error-handling boundary.
    let resolvedStepId: string;
    let resolvedRunbook: string;

    if (input.explicitStep !== undefined) {
      resolvedRunbook = inferRunbookFromStep(state, steps, input.explicitStep);
      resolvedStepId = input.explicitStep;
    } else if (input.requestedRunbook === undefined) {
      const frontier = deriveDelegateFrontier(state);
      const resolution = resolveDelegateTarget(state, steps, frontier);
      if (resolution.kind === 'already-issued') {
        return {
          kind: 'already-delegated',
          stepId: resolution.stepId,
          runbookRef: resolution.runbookRef,
          token: resolution.token,
          parentRunId: state.id,
        };
      }
      if (resolution.kind === 'none') {
        return { kind: 'error', error: Errors.delegationNoDelegatableSubstep(state.step) };
      }
      resolvedRunbook = resolution.target.runbookRef;
      resolvedStepId = resolution.target.stepId;
    } else {
      const inferred = inferDelegationTarget(state, steps);
      resolvedRunbook = inferred.runbookRef;
      resolvedStepId = inferred.stepId;
    }

    // Frame key: an explicit --index scopes to a FOR iteration of the active
    // step; otherwise reuse the active frame. `--index` is pre-validated
    // (Category A) by the frontend, so the seam trusts `explicitIteration`.
    const frameKey =
      input.explicitIteration !== undefined
        ? buildFrameKey(state.step, input.explicitIteration)
        : (state.activeFrameKey ?? deriveActiveFrame(state).frameKey);

    // Resolve the requested positional (only) to serializable data; never the
    // authored target — keeps the echo path independent of authored resolvability.
    let requested: RequestedRunbookArg = { kind: 'none' };
    if (input.requestedRunbook) {
      const requestedResolved = await this.#deps.resolveChildRunbook(input.requestedRunbook);
      requested = requestedResolved
        ? { kind: 'resolved', ref: requestedResolved.ref, raw: input.requestedRunbook }
        : { kind: 'unresolvable', raw: input.requestedRunbook };
    }

    // RD-804 echo-vs-conflict — computed before resolving the authored child.
    const targeted804 = resolveTargetedDelegation(state, resolvedStepId, frameKey, requested);
    if (targeted804.kind === 'echo') {
      return {
        kind: 'already-delegated',
        stepId: targeted804.stepId,
        runbookRef: targeted804.runbookRef,
        token: targeted804.token,
        parentRunId: state.id,
      };
    }
    if (targeted804.kind === 'conflict') {
      return { kind: 'error', error: targeted804.error };
    }
    // targeted804.kind === 'issuable' falls through to child resolution.

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
    const createStepId = withFrameIteration(resolvedStepId, input.explicitIteration);

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
   * - `step` / `active` resolve against the active run; a missing active run (or,
   *   for `active`, a missing substep cursor) returns `no-active-runbook` — the
   *   CLI renders the form-specific message.
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

    let targetState: RunbookState;
    let substepId: string;
    let frameKey: FrameKey;
    let stepLabel: string;

    if (locator.kind === 'token') {
      const scan = await this.#deps.findDelegationByToken(locator.token);
      if (!scan) return { kind: 'token-not-found', token: locator.token };
      targetState = scan.parentState;
      substepId = scan.substepId ?? scan.stepId;
      frameKey = scan.frameKey;
      // Prefer the canonical contextSnapshot.at so FOR-iteration retries surface
      // as e.g. "1.2.1"; fall back for snapshots predating the `at` field.
      const snapshot = scan.delegation.contextSnapshot;
      stepLabel =
        snapshot.at ?? (snapshot.substep ? `${scan.stepId}.${snapshot.substep}` : scan.stepId);
    } else if (locator.kind === 'step') {
      const active = await this.#deps.sessionService.getActive();
      if (!active) return { kind: 'no-active-runbook' };
      targetState = active;
      const parsed = parseStepIdFromString(locator.step);
      const stepName = parsed?.step ?? locator.step;
      substepId = parsed?.substep ?? stepName;
      if (locator.iteration !== undefined) {
        frameKey = buildFrameKey(stepName, locator.iteration);
      } else {
        // No explicit iteration: reuse the active frame when it is on the
        // requested step, else fall back to the step's base frame (matching how
        // createDelegation scopes lookup for a step-form caller).
        const activeDerived = deriveActiveFrame(active);
        frameKey =
          activeDerived.step === stepName
            ? (active.activeFrameKey ?? activeDerived.frameKey)
            : buildFrameKey(stepName);
      }
      // Canonicalize the label to the resolved frame: an explicit `--index`
      // surfaces as e.g. "1.2.1" (matching the token/active retry forms), not the
      // bare "1.1" that drops the iteration.
      stepLabel =
        locator.iteration !== undefined
          ? deriveExecutionAt(stepName, parsed?.substep, locator.iteration)
          : locator.step;
    } else {
      const active = await this.#deps.sessionService.getActive();
      if (active?.substep === undefined) return { kind: 'no-active-runbook' };
      targetState = active;
      substepId = active.substep;
      // Surface the same canonical location used by token/step retries: an
      // active FOR iteration renders as e.g. "1.2.1", not just "1.1".
      const activeDerived = deriveActiveFrame(active);
      frameKey = active.activeFrameKey ?? activeDerived.frameKey;
      stepLabel = deriveExecutionAt(active.step, active.substep, activeDerived.iteration);
    }

    // Policy gate — `targeted: true` (a retry re-issues a specific delegation),
    // so a pending collection does not refuse it.
    const actorContext = actorContextFromEvidence(input.callerEvidence, targetState.id);
    const policy = resolveCommandIntent({
      actorContext,
      intent: { kind: 'delegation-issuance', command: 'delegate', targeted: true },
      targetSelector: { kind: 'default' },
      targetState,
    });
    if (policy.kind !== 'allowed') return { kind: 'refused', policy };

    const steps = await this.#deps.loadSteps(targetState);

    // Resolve overrides only now — after the locator resolved and the gate
    // passed — so a bad `--input-file` (or other extra-var failure) cannot mask
    // the higher-priority retry precondition (`token-not-found` /
    // `no-active-runbook` / refusal). Mirrors the fresh path's lazy seam.
    const overrides = await input.resolveOverrides?.();

    const result = retryDelegation(
      {
        state: targetState,
        substepId,
        frameKey,
        ...(overrides ? { overrides } : {}),
      },
      steps,
    );
    // Every non-`retried` variant carries a `RundownError` (RD-801/802/823 or a
    // propagated createDelegation error), so the dispatch collapses to one arm.
    if (result.status !== 'retried') return { kind: 'error', error: result.error };

    await this.#persistIssuedSubstep(
      targetState.id,
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
      parentRunId: targetState.id,
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
   *   `--step` cursor no longer matches the run's active step — or, for an
   *   `active`-kind cursor frame, the run's active frame (frame key + entry) —
   *   after re-resolution (fail-closed TOCTOU guard).
   */
  async runTransition(input: LifecycleTransitionInput): Promise<LifecycleTransitionOutcome> {
    const { sessionService } = this.#deps;
    const targeted = input.targetSelector.kind === 'explicit-step';
    const claimId =
      input.targetSelector.kind === 'claim' ? input.targetSelector.claimId : undefined;

    const actorContext = await this.#resolveActorContext(input.callerEvidence, claimId);

    const resolution = await resolveTransitionTarget(sessionService, {
      command: input.command,
      ...(claimId ? { claimId } : {}),
      targeted,
      actorContext,
    });

    const refusal = this.#asRefusal(resolution);
    if (refusal) return refusal;
    // Narrow to the two states carrying a resolved run.
    if (resolution.kind !== 'claim' && resolution.kind !== 'default') {
      // Exhaustiveness guard: every non-ready variant is handled by #asRefusal.
      const _unreachable: never = resolution as never;
      return _unreachable;
    }

    // A ready explicit-step transition must carry its resolved cursor. Without
    // it, #drive() would silently fall back to the active cursor / top-level
    // path and mutate the wrong unit. Refusals already returned above, so this
    // only fires on a ready resolution missing its target — fail fast rather
    // than silently mapping to the active cursor.
    if (targeted && input.manualTarget === undefined) {
      throw new Error('Explicit-step transition requires a resolved manual target cursor');
    }

    // Fail-closed TOCTOU guard. The frontend parses `--step` / `--index` into the
    // cursor against a *prior* snapshot (Category-A input handling), then this
    // seam resolves the target independently here. The two resolutions can
    // observe different snapshots, so if the run advanced off the cursor's step
    // in that window the cursor is stale — refuse rather than record a completion
    // against a step the run has already left. (Substep / FOR-iteration targeting
    // within the step stays legitimate; only the step itself is pinned.)
    if (input.manualTarget !== undefined && input.manualTarget.step !== resolution.state.step) {
      throw new Error(
        `Explicit-step target "${input.manualTarget.step}" no longer matches the resolved run's active step "${resolution.state.step}"; the run advanced after the target was resolved`,
      );
    }

    // Fail-closed TOCTOU guard for the active frame. An `active`-kind cursor frame
    // asserts it WAS the run's active frame when the frontend resolved `--step` /
    // `--index` against the prior snapshot (transitions.ts builds `active` only
    // when the target frame key equals the snapshot's active frame key). If the
    // run re-entered the frame (entry bump on GOTO/RETRY) or advanced to a
    // different FOR iteration of the same step in that window, that assertion is
    // stale: recording against the stale active frame persists a
    // resolved-completion row at an entry/iteration the drain can never consume
    // (`listResolvedCompletions` is entry-filtered), orphaning it and prematurely
    // flipping the substep to `done`. Refuse instead. Deliberate non-active
    // targeting is encoded by the frontend as an `inactive` frame (sentinel entry,
    // frame-only match) and is intentionally exempt — only the active-frame
    // identity is re-validated here, so legitimate explicit non-active-substep /
    // non-active-iteration completion is unaffected.
    if (input.manualTarget?.frame.kind === 'active') {
      const activeFrameKey =
        resolution.state.activeFrameKey ?? deriveActiveFrame(resolution.state).frameKey;
      const activeEntry = resolution.state.activeEntry ?? 1;
      if (
        input.manualTarget.frame.frameKey !== activeFrameKey ||
        input.manualTarget.frame.entry !== activeEntry
      ) {
        throw new Error(
          `Explicit-step target frame "${input.manualTarget.frame.frameKey}#${String(input.manualTarget.frame.entry)}" no longer matches the resolved run's active frame "${activeFrameKey}#${String(activeEntry)}"; the run advanced after the target was resolved`,
        );
      }
    }

    const terminalReleaseMode: LifecycleTerminalReleaseMode =
      resolution.kind === 'claim' ? 'release-runbook' : 'stack-pop';
    const guardOpenChildren = resolution.kind === 'default' && !targeted;

    // Single resolution: derive the resolved run's steps in-seam from its
    // in-memory state, rather than taking `steps` as an input that would force the
    // frontend to resolve the target first (a redundant run-state read).
    const steps = await this.#deps.loadSteps(resolution.state);

    return this.#drive(input, steps, resolution.state, terminalReleaseMode, guardOpenChildren);
  }

  // Map caller evidence to an actor context anchored on the resolved run.
  // `direct_cli` evidence anchors on the active default run; `claim` evidence
  // anchors on its own controlled run; everything else maps to the unknown
  // context. Returns the unknown context when no anchor run exists (a direct-CLI
  // caller with no active run is refused downstream as `none`).
  async #resolveActorContext(
    evidence: CallerEvidence,
    claimId: ClaimId | undefined,
  ): Promise<ActorContext> {
    if (evidence.kind === 'claim') {
      return actorContextFromEvidence(evidence, evidence.controlledRunId);
    }
    if (claimId !== undefined) {
      // Claim-targeted writes resolve through the resolver's claim path, which
      // does not consult the actor context for the bare-advance gate.
      return UNKNOWN_ACTOR_CONTEXT;
    }
    const active = await this.#deps.sessionService.getActive();
    if (!active) return UNKNOWN_ACTOR_CONTEXT;
    return actorContextFromEvidence(evidence, active.id);
  }

  // Map a non-ready resolution to its refusal outcome, or `undefined` when ready.
  #asRefusal(resolution: TransitionTargetResolution): LifecycleTransitionOutcome | undefined {
    switch (resolution.kind) {
      case 'claim':
      case 'default':
        return undefined;
      case 'none':
        return { kind: 'none' };
      case 'stale_claim':
        return { kind: 'stale_claim', claimId: resolution.claimId, message: resolution.message };
      case 'terminal_claim_confirmed':
        return {
          kind: 'terminal_claim_confirmed',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          result: resolution.result,
        };
      case 'terminal_claim_conflict':
        return {
          kind: 'terminal_claim_conflict',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          expectedResult: resolution.expectedResult,
          requestedResult: resolution.requestedResult,
        };
      case 'open_delegated_children':
        return {
          kind: 'open_delegated_children',
          parentRunId: resolution.parentRunId,
          claims: resolution.claims,
        };
      case 'delegation_collection_pending':
        return {
          kind: 'delegation_collection_pending',
          parentRunId: resolution.parentRunId,
          outcomeCompletionKeys: resolution.outcomeCompletionKeys,
          message: resolution.message,
        };
      case 'actor_context_required':
        return { kind: 'actor_context_required', targetRunId: resolution.targetRunId };
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
    // A `manualTarget` is always an explicit substep cursor (`--step` / `--index`),
    // so it must route through the substep completion path even when the live
    // cursor is parked on a top-level step (`activeState.substep` unset) — the
    // top-level path ignores `manualTarget` entirely.
    const isSubstepCompletion =
      input.manualTarget !== undefined ||
      Boolean(
        activeState.substep && resolvedStepHasSubsteps(activeStep) && activeStep.substeps.length,
      );

    if (isSubstepCompletion) {
      return this.#driveSubstep(input, steps, activeState, terminalReleaseMode, guardOpenChildren);
    }
    return this.#driveTopLevel(input, steps, activeState, terminalReleaseMode, guardOpenChildren);
  }

  // Manual substep completion path: record (guarded) then drain resolved completions.
  async #driveSubstep(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    activeState: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    guardOpenChildren: boolean,
  ): Promise<LifecycleTransitionOutcome> {
    const { completionService, sessionService } = this.#deps;
    const explicit = input.manualTarget;
    const cursor: ResolvedCursor = explicit
      ? {
          step: explicit.step,
          substep: explicit.substep,
          iteration: explicit.iteration,
          frame: explicit.frame,
          at: explicit.at,
        }
      : activeCursor(activeState);
    const targetSubstep = cursor.substep;
    if (!targetSubstep) {
      throw new Error('Substep completion requires an active or explicit substep target');
    }

    // Bare (non-explicit) transition at a substep whose inline child is still
    // running: this is "advance the thing the operator is looking at" — resume
    // the child rather than record a completion against the parent. The decision
    // (is the child still open?) is runbook logic and belongs in core; the effect
    // is `SessionService.pushRunbook`. The explicit `--step` path never
    // reactivates — it is a deliberate completion against a named substep.
    if (!explicit && (await this.#reactivateRunningInlineChild(activeState))) {
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

    const drainEvents: TransitionObservationEvent[] = [];
    let drainState: RunbookState = activeState;
    let observedState: RunbookState = activeState;
    let applied = 0;
    let terminalStatus: 'done' | 'stopped' | undefined;

    drainLoop: for (;;) {
      const drained = await completionService.drainResolvedCompletions({
        runbookId: activeState.id,
        steps,
        currentState: drainState,
        maxApplied: 1,
        ...(explicit ? { frameOverride: explicit.frame } : {}),
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
          await this.#applyTerminalSideEffects(input, observation.status, activeState.id);
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
        // envelope. Apply terminal release here too so this exit can never skip
        // the seam-owned terminal side effect.
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
        await this.#applyTerminalSideEffects(input, drained.status, activeState.id);
        terminalStatus = drained.status;
        break;
      }
      if (drained.applied.length === 0) {
        break;
      }
    }

    if (terminalStatus) {
      return {
        kind: 'applied',
        runId: activeState.id,
        mutation: 'manual-completion',
        terminalReleaseMode,
        status: terminalStatus,
        events: drainEvents,
        loop: { kind: 'none' },
        ...(duplicate ? { duplicate } : {}),
      };
    }

    const loop: LifecycleLoopDirective =
      applied > 0 ? { kind: 'run', prompted: Boolean(observedState.prompted) } : { kind: 'none' };
    return {
      kind: 'applied',
      runId: activeState.id,
      mutation: 'manual-completion',
      terminalReleaseMode,
      status: 'continue',
      events: drainEvents,
      loop,
      ...(applied > 0 ? { updatedState: observedState } : {}),
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
