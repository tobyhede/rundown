import { parseStepIdFromString, resolvedStepHasSubsteps, type StepId } from '@rundown-org/parser';
import {
  UNKNOWN_ACTOR_CONTEXT,
  verifiedClaimContext,
  type ActorContext,
  type CallerEvidence,
} from './actor-context.js';
import type { RunbookActorService } from './actor-service.js';
import type { ParentAdvanceGuard } from './storage/runbook-store.js';
import { INLINE_PARENT_CYCLE_CODE, inlineParentCycleMessage } from './inline-parent-advance.js';
import {
  authorizeClaim,
  claimCanReportDelegationResult,
  claimKeyFromBearer,
  isDelegatedChildClaim,
} from './claim-id.js';
import type {
  ClaimAuthorizationRequest,
  ClaimId,
  ClaimRecord,
  VerifiedClaimAuthority,
} from './claim-id.js';
import { classifyDelegationExposureDetail } from './delegation-exposure.js';
import type {
  CommandIntent,
  CommandTargetSelector,
  DelegationPolicyOutcome,
} from './command-policy.js';
import { resolveCommandIntent } from './command-policy.js';
import {
  createDelegationCredentialIssuer,
  createDelegationTokenDeriver,
  delegationRuntimeCapabilities,
  type DelegationCredentialIssuer,
  type DelegationRuntimeCapabilities,
  type DelegationTokenDeriver,
} from './delegation-credential.js';
import type { DelegationTokenScan, TokenScanResult } from './delegation-scan.js';
import {
  hashDelegationToken,
  truncateDelegationToken,
  type DelegationCredentialDescriptor,
  type DelegationTokenHash,
} from './delegation-token.js';
import {
  buildRetryIssuanceCapture,
  resolveDelegationIssuance,
  resolveRetryIssuance,
  type DelegationIssuanceResolution,
  type RequestedRunbookArg,
} from './delegation-inference.js';
import { deriveActiveCompletionFrame, inferFrameEntryFromState } from './frame-entry.js';
import { Errors } from '../errors/factory.js';
import type { RundownError } from '../errors/rundown-error.js';
import { sameRunbookRef, type RunbookRef } from './runbook-ref.js';
import {
  resolveCommandTarget,
  resolveMutationAuthority,
  resolveTerminalTarget,
  resolveTransitionTarget,
  unknownRunRefusal,
  type StaleClaimRefusal,
  type TerminalCommandName,
  type TransitionCommandName,
  type TransitionTargetResolution,
  type UnknownRunRefusal,
} from './command-target-resolver.js';
import type { DELEGATION_COLLECTION_PENDING_MESSAGE } from './delegation-lifecycle-read-model.js';
import type { EffectfulActorMutationRunner } from './effectful-actor-mutation-runner.js';
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
import type { SessionMutationRefusalOutcome, SessionService } from './session-service.js';
import type { RunbookCompletionService } from './completion-service.js';
import type { ActionType } from './transition-kernel.js';
import {
  deriveTransitionObservation,
  reconcileFencedTerminalObservation,
  type TransitionObservationEvent,
} from '../events/transition-observation.js';
import type { Frame, FrameKey } from './targeting.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  completionEntryForFrame,
  deriveActiveFrame,
  deriveExecutionAt,
  findSubstepState,
  inactiveFrame,
  replaceSubstepStateEntry,
} from './targeting.js';
import type { ResolvedStep, RunbookState, SubstepState, TemplateVarValue } from './types.js';
import type { RunbookContext } from './compiler.js';
import { isInlineLaunchIntentWithoutParentEntry } from './actors/inline-launch-intent-actor.js';
import type { GuardedMutationResult } from './storage/mutation-result.js';
import type { AbandonedAttemptSetOutcome } from './storage/execution-lease.js';
import type { PreparedActorMutation } from './effectful-mutation-executor.js';

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
  /** Completion service used to record and drain resolved substep completions. */
  readonly completionService: RunbookCompletionService;
  /** Core-owned execution fence for actor-derived lifecycle mutations. */
  readonly actorMutationRunner: EffectfulActorMutationRunner;
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
   * Locate a delegation bearer across runs, by verifier.
   *
   * CLI-bound; wraps `DelegationScanService.scanByTokenHash`. One dependency
   * rather than two because the seam's two questions about a bearer — which row
   * still carries it, and which rows record it as superseded — are always asked
   * together about the same hash, and answering them from one state listing is
   * what keeps the retry locator to a single full scan.
   */
  readonly findDelegationsByTokenHash: FindDelegationsByTokenHash;
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
 * Cross-run bearer lookup, CLI-bound (wraps `DelegationScanService.scanByTokenHash`).
 *
 * Takes the verifier rather than the raw bearer: the seam hashes the token once
 * to identify the retry and passes that hash on, instead of handing the token
 * back for the scan to hash a second time. It also keeps the plain-text bearer
 * off one more callable boundary.
 *
 * @param tokenHash - Verifier of the delegation bearer being located.
 * @returns The row still carrying the bearer (or `undefined`), plus every row
 *   recording it as superseded.
 */
export type FindDelegationsByTokenHash = (
  tokenHash: DelegationTokenHash,
) => Promise<DelegationTokenScan>;

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
  | {
      /**
       * The retry was already applied: a replacement exists with no committed
       * evidence its bearer was used. The response echoes that bearer so the
       * caller can rotate deliberately by naming it. Nothing was written.
       */
      readonly kind: 'retry-already-applied';
      readonly stepLabel: string;
      readonly runbookPath: string;
      readonly token: string;
      readonly tokenHash: string;
      readonly parentRunId: RunId;
    }
  | {
      /**
       * Refusal: no delegation matches the named bearer, on either the current
       * `tokenHash` index or the supersession index.
       *
       * Carries a pre-truncated `tokenHint`, never the raw bearer. The hint is
       * built at this boundary by {@link truncateDelegationToken}, so the leak
       * is unrepresentable on this outcome rather than merely unrendered —
       * matching what `Errors.tokenNotFound` already does for `rundown abort`.
       */
      readonly kind: 'token-not-found';
      readonly tokenHint: string;
    }
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
    } // Refusal: the presented bearer claim cannot anchor issuance because it is
  // missing, invalid for this session, stashed, superseded, or points at missing
  // child state. Carries the resolver's cause-specific message (already redacted
  // to the claim key) and the symbolic code it renders as.
  | StaleClaimRefusal
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
  | { readonly kind: 'error'; readonly error: RundownError }
  /** Refusal: releasing the retried delegation's linked child hit execution ownership. */
  | SessionMutationRefusalOutcome
  | Extract<
      GuardedMutationResult<never>,
      { readonly kind: 'claim_superseded' | 'concurrent_modification' | 'missing' }
    >
  | AbandonedAttemptSetOutcome;

function replaceIssuedDelegation(
  state: RunbookState,
  updatedSubstepStates: readonly SubstepState[],
  stepIdOrSubstep: string,
  frameKey: FrameKey,
): RunbookState {
  // Equivalent mutant: `parseStepIdFromString` returns null only for input it
  // cannot parse, and no call site can reach here with such a string. Every
  // caller derives `stepIdOrSubstep` from an id the delegation resolver already
  // matched against an authored substep (fresh issuance and retry) or from a
  // persisted descriptor whose substep was just located by `findSubstepState`
  // (abort); an unparsable id is refused upstream, so the null branch of `?.` is
  // unreachable and dropping the guard is unobservable.
  // Stryker disable next-line OptionalChaining: unreachable — callers cannot supply an unparsable step id
  const substepId = parseStepIdFromString(stepIdOrSubstep)?.substep ?? stepIdOrSubstep;
  const issued = findSubstepState(updatedSubstepStates, substepId, frameKey);
  // Unreachable invariant, not a branch: every caller performs this exact
  // `findSubstepState(prepared.nextState.substepStates, substepId, frameKey)`
  // lookup and throws on a miss BEFORE calling in, so `issued` is always
  // present here. Emptying the guard, forcing it false, or blanking its message
  // therefore cannot change any observable outcome — the throw exists to keep a
  // future caller from silently persisting a state with no issued substep.
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable — callers already asserted the substep exists
  if (!issued) {
    throw new Error(
      // Stryker disable next-line StringLiteral: unreachable — this throw cannot fire (see above)
      `Issued delegation substep "${substepId}" (frame ${frameKey}) missing from updated state`,
    );
  }
  const resolvedCompletions = Object.fromEntries(
    Object.entries(state.resolvedCompletions ?? {}).filter(
      ([, completion]) =>
        completion.targetFrameKey !== frameKey ||
        completion.targetSubstep !== substepId ||
        completion.agentId !== 'delegation',
    ),
  );
  return {
    ...state,
    // Equivalent mutant (the `[]` literal only): `state` is always the machine's
    // freshly prepared next state, which cannot reach here without
    // `substepStates` — the `findSubstepState` lookup above found `issued` in
    // exactly that array. The `??` fallback is a type-level nullability
    // formality whose right operand is never evaluated, so its contents are
    // unobservable. The `??` operator itself is NOT disabled: replacing it with
    // `&&` collapses the base array to `[]` and drops every sibling substep,
    // which is killed by "keeps a sibling substep state when a second
    // delegation is issued on the same step".
    // Stryker disable next-line ArrayDeclaration: unreachable — substepStates is always present on a prepared state
    substepStates: replaceSubstepStateEntry(state.substepStates ?? [], issued),
    resolvedCompletions,
  };
}

/**
 * Outcome of verifying the bearer an already-issued delegation would echo.
 *
 * Discriminated so the caller cannot reach a token without having passed the
 * verification: the refusal arm carries no token at all.
 */
type EchoedDelegationToken =
  | { readonly kind: 'verified'; readonly token: string }
  | { readonly kind: 'unverifiable'; readonly error: RundownError };

/**
 * Reconstruct and verify a bearer before any seam discloses it.
 *
 * An echo is a credential disclosure, so it is gated on the invariant
 * `projectDelegateFrontier` enforces at the observation boundary: the token
 * reconstructed from the persisted descriptor MUST hash to the verifier the
 * parent recorded at issuance. Without that check the seam would hand back
 * whatever the descriptor happens to derive to, which is a forged or corrupted
 * record's own choosing.
 *
 * Derivation itself can fail — a rotated issuing claim cannot reproduce its
 * predecessor's credential — and that throw must not escape a seam whose
 * contract is typed data, so it collapses into the same refusal. Neither arm
 * carries the reconstructed token, so a caller cannot leak a bearer it was
 * refused.
 *
 * @param credential - The persisted, non-secret credential descriptor.
 * @param tokenHash - The verifier recorded alongside it.
 * @param subject - Step or substep label used in the refusal message.
 * @param deriveToken - Verified runtime deriver bound to the presenting claim.
 * @returns The verified bearer, or the typed refusal to return in its place.
 */
function verifyDerivedBearer(
  credential: DelegationCredentialDescriptor,
  tokenHash: DelegationTokenHash,
  subject: string,
  deriveToken: DelegationTokenDeriver,
): EchoedDelegationToken {
  let token: string;
  try {
    token = deriveToken(credential);
  } catch {
    return {
      kind: 'unverifiable',
      error: Errors.delegationInvariantViolated(
        `the presented claim cannot reconstruct the in-flight delegation credential for ${subject}`,
      ),
    };
  }
  if (hashDelegationToken(token) !== tokenHash) {
    return {
      kind: 'unverifiable',
      error: Errors.delegationInvariantViolated(
        `reconstructed delegation credential for ${subject} does not match its persisted verifier`,
      ),
    };
  }
  // Equivalent mutant: the sole consumer narrows on the OTHER arm
  // (`if (echoed.kind === 'unverifiable')`) and reads `.token` from whatever
  // remains, so this discriminant's value is never compared against anything.
  // The literal is retained because the union is the contract that keeps a
  // token unreachable without passing verification.
  // Stryker disable next-line StringLiteral: equivalent — the 'verified' discriminant is never read
  return { kind: 'verified', token };
}

/**
 * Verify the bearer an already-issued fresh delegation would echo.
 *
 * @param echo - The `already-issued` resolution the seam matched.
 * @param deriveToken - Verified runtime deriver bound to the presenting claim.
 * @returns The verified bearer, or the typed refusal to return in its place.
 */
function verifyEchoedDelegationToken(
  echo: Extract<DelegationIssuanceResolution, { readonly kind: 'already-issued' }>,
  deriveToken: DelegationTokenDeriver,
): EchoedDelegationToken {
  return verifyDerivedBearer(echo.credential, echo.tokenHash, echo.stepId, deriveToken);
}

/**
 * The policy refusals the mutation-authority resolution can produce.
 *
 * `#resolveMutationActorContext` is the sole authority gate on the abort path
 * and yields exactly these two kinds: "no authority was named at all"
 * (`actor_context_required`) and "the presented claim lacks this grant"
 * (`claim_grant_required`). Publishing that narrow union — rather than the whole
 * {@link DelegationPolicyOutcome} — is what lets a frontend switch exhaustively
 * over it: a third kind added here becomes a compile error at every consumer
 * instead of silently landing in a fallback that renders some other refusal's
 * envelope (CLAUDE.md "No silent mapping").
 *
 * Deliberately NOT reused for {@link DelegationIssuanceOutcome}'s `refused` arm:
 * issuance also runs `resolveCommandIntent`, which can refuse for collection
 * state, so that seam legitimately carries the wider union.
 */
export type MutationAuthorityRefusalPolicy = Extract<
  DelegationPolicyOutcome,
  { readonly kind: 'actor_context_required' | 'claim_grant_required' }
>;

/** Input for the core-owned delegation abort workflow. */
export interface DelegationAbortInput {
  /** Plaintext delegation bearer used only for lookup and exact hash revalidation. */
  readonly token: string;
  /** Verified caller evidence authorizing mutation of the owning parent. */
  readonly callerEvidence: CallerEvidence;
  /** Whether a linked child should be stopped and reported as failed. */
  readonly force: boolean;
}

/** Result of the core-owned delegation abort workflow. */
export type DelegationAbortOutcome =
  | { readonly kind: 'token_not_found' }
  | {
      readonly kind: 'already_cancelled';
      readonly parentRunId: RunId;
      readonly substepId: string;
      readonly childRunbookPath: string;
    }
  | {
      readonly kind: 'needs_force';
      readonly substepId: string;
      readonly childRunId: RunId;
    }
  | {
      readonly kind: 'cancelled';
      readonly parentRunId: RunId;
      readonly substepId: string;
      readonly childRunbookPath: string;
      readonly childRunId: RunId | null;
      /**
       * Which linked-child cleanup branch ran.
       *
       * `none` means no child was ever linked — deliberately NOT reused for a
       * linked child whose run has vanished, which is `missing_child_cleaned`:
       * that branch superseded a stale delegated outcome, and collapsing the
       * two would hide the cleanup behind "nothing to clean".
       */
      readonly cleanup:
        | 'none'
        | 'active_child_failed'
        | 'terminal_child_cleaned'
        | 'missing_child_cleaned';
    }
  | { readonly kind: 'refused'; readonly policy: MutationAuthorityRefusalPolicy }
  | { readonly kind: 'error'; readonly error: RundownError }
  | Extract<
      GuardedMutationResult<never>,
      {
        readonly kind:
          | 'claim_superseded'
          | 'concurrent_modification'
          | 'execution_in_progress'
          | 'recovery_required'
          | 'missing';
      }
    >
  | AbandonedAttemptSetOutcome;

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

/**
 * Refusal: the caller named a claim-shaped target without presenting that
 * claim's bearer (#613).
 *
 * Distinct from `actor_context_required`, which means "no authority was named
 * at all" and whose remediation is to supply `--claim-id`. Here the caller
 * supplied one; it just is not the bearer for the claim it targeted, so
 * repeating that advice would misdiagnose the refusal.
 *
 * Carries no payload. The seams refuse this BEFORE resolving either claim, so
 * there is no verified claim record to name — no `claimKey` to redact down to,
 * and echoing either raw `claimId` would put a bearer secret in output. The
 * caller already holds both values it supplied, so it needs no echo to act.
 */
export type ClaimBearerMismatchRefusal = { readonly kind: 'claim_bearer_mismatch' };

/** Input to {@link RunbookLifecycleCommandService.runTransition}. */
export interface LifecycleTransitionInput {
  /**
   * The manual transition being attempted. This is also the result the command
   * persists: `pass` drives PASS, `fail` drives FAIL. The two are the same fact,
   * so the seam derives the persisted result from `command` rather than taking a
   * second field that could silently disagree with it.
   */
  readonly command: TransitionCommandName;
  /**
   * Typed caller evidence mapped to an actor context by core. A `claim` target
   * selector is the same fact as `claim_bearer` evidence naming that id, so the
   * seam refuses `claim_bearer_mismatch` when the two disagree rather than
   * authorizing as the target (#613).
   */
  readonly callerEvidence: CallerEvidence;
  /**
   * Discriminated target selector (default / claim / run / explicit-step). A
   * `claim` selector names its run by the bearer itself, so it is only valid
   * alongside `claim_bearer` evidence carrying that same claim id.
   */
  readonly targetSelector: CommandTargetSelector;
  /** Terminal side-effect policy shared with execution-loop transitions. */
  readonly terminalPolicy: LifecycleTerminalReleasePolicy;
  /** Optional display-result policy for the transition observation projection. */
  readonly computeActionResult?: (actionType: ActionType) => boolean;
  /**
   * Raw explicit `--step` / `--index` target. Present for explicit-target
   * transitions; absent for a bare transition (the seam derives the active
   * cursor). The seam resolves it to a cursor INSIDE its guarded
   * compute-and-commit cycle, against the captured state that cycle's
   * compare-and-swap commits onto (derive-or-refuse), so no pre-resolved
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
  | StaleClaimRefusal
  /**
   * Every fenced-mutation refusal. Subsumes the `execution_in_progress` /
   * `recovery_required` pair that {@link SessionMutationRefusalOutcome} also
   * carries, so no narrower Extract of the same union belongs here.
   */
  | Exclude<GuardedMutationResult<never>, { readonly kind: 'committed' }>
  /** Refusal: the terminal release this transition owes hit execution ownership. */
  | SessionMutationRefusalOutcome
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
  | ClaimBearerMismatchRefusal
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
      /**
       * Verified runtime-only delegation capabilities for the follow-on
       * execution loop. One branded pair — see {@link TransitionDelegationRuntime}.
       */
      readonly delegationRuntime?: DelegationRuntimeCapabilities;
    };

/** Canonical command-facing result of one fenced lifecycle computation. */
export type EffectfulLifecycleCommandResult<T> = GuardedMutationResult<T>;

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
  /**
   * Typed caller evidence mapped to an actor context by core. As on the
   * transition seam, a `claim` target selector must name the same bearer this
   * evidence presents; a divergence refuses `claim_bearer_mismatch` (#613).
   */
  readonly callerEvidence: CallerEvidence;
  /**
   * Target selector — only `default` (bare cascade), `run`, or `claim` are
   * valid for a terminal command; an `explicit-step` selector is rejected by
   * `runTerminal`. A `claim` selector is only valid alongside `claim_bearer`
   * evidence carrying that same claim id.
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
  /** Refusal: a release this terminal owes hit execution ownership on the named run. */
  | SessionMutationRefusalOutcome
  | Extract<
      GuardedMutationResult<never>,
      { readonly kind: 'claim_superseded' | 'concurrent_modification' | 'missing' }
    >
  /** Aggregate force crossed its effect boundary and every named attempt requires recovery. */
  | AbandonedAttemptSetOutcome
  /** The targeted claim id does not resolve to a live claimed child. */
  | StaleClaimRefusal
  /** Bare terminal needs actor context the caller evidence did not supply. Carries no run id (accident barrier — see the resolver member's rationale). */
  | { readonly kind: 'actor_context_required' }
  /** The caller did not present the bearer naming its claim-shaped terminal target. */
  | ClaimBearerMismatchRefusal
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
  /**
   * Typed caller evidence mapped to an actor context by core. As on the
   * mutating seams, a `claim` target selector must name the same bearer this
   * evidence presents; a divergence refuses `claim_bearer_mismatch` (#613).
   */
  readonly callerEvidence: CallerEvidence;
  /**
   * Target selector — `default`, `claim`, or `run`. An `explicit-step`
   * selector is rejected by `resolveRunNavigation`: the navigation target
   * (which step to jump to) is the command's positional argument, not a
   * run selector. A `claim` selector is only valid alongside `claim_bearer`
   * evidence carrying that same claim id.
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
  | StaleClaimRefusal
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
  /** The caller did not present the bearer naming its claim-shaped goto target. */
  | ClaimBearerMismatchRefusal
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
      /**
       * Verified runtime-only delegation capabilities for a navigation that
       * lands on a DELEGATE frontier. One branded pair — see
       * {@link TransitionDelegationRuntime}.
       */
      readonly delegationRuntime?: DelegationRuntimeCapabilities;
    };

/** Input to an already-authorized fenced GOTO mutation. */
export interface LifecycleNavigationMutationInput {
  readonly runId: RunId;
  readonly callerEvidence: CallerEvidence;
  readonly steps: readonly ResolvedStep[];
  readonly target: StepId;
  readonly terminalReleaseMode: LifecycleTerminalReleaseMode;
  /** Verified runtime-only issuer for a GOTO that enters a delegation frontier. */
  readonly issueDelegationCredential?: DelegationCredentialIssuer;
}

/** Result of applying an already-authorized GOTO through the execution fence. */
export type LifecycleNavigationMutationOutcome =
  | Exclude<GuardedMutationResult<never>, { readonly kind: 'committed' }>
  | {
      readonly kind: 'applied';
      readonly runId: RunId;
      readonly previousState: RunbookState;
      readonly updatedState: RunbookState;
      readonly snapshot: unknown;
      readonly steps: readonly ResolvedStep[];
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
 * substep mutation paths. The terminal session release is committed inside the
 * fenced mutation, so `terminalStatus` is carried out as data purely for the
 * caller's reported outcome — it drives no side effect of its own.
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
 * The two ways an explicit `--index` can be illegal, as the outcome each seam
 * returns verbatim. Both members are already `DelegationIssuanceOutcome`
 * variants, so a caller narrows nothing: it forwards what it is handed.
 *
 * Returning the OUTCOME rather than a message is what lets one function own
 * both conditions despite their different surfaces — a document-shape refusal
 * (`invalid_index`, rendered `INVALID_INDEX`) and a state refusal carrying a
 * registered code (RD-832). Splitting them across two call sites is how the two
 * seams drift.
 */
type DelegationIndexRefusal = Extract<
  DelegationIssuanceOutcome,
  { readonly kind: 'invalid_index' | 'error' }
>;

/**
 * Decide whether an explicit `--index` may name the frame it names.
 *
 * TWO conditions, in this order:
 *
 * 1. The named step must be a FOR (or prompted-FOR) step. A document-shape
 *    question, decidable from the parsed steps alone. Missing steps
 *    deliberately pass through so the delegation resolver retains ownership of
 *    RD-801.
 * 2. The named iteration must be the one the parent is EXECUTING (#738). A
 *    state question, which is why this takes the captured state: the rule
 *    belongs to core, and the only state the seams may read it from is the
 *    document-and-state pair the aggregate fence captured.
 *
 * The second condition is not a tightening of the first — it closes a distinct
 * hole. The FOR model is strictly single-iteration: `ForContext.iteration` is
 * one number the advance transition overwrites, `activeFrameKey`/`activeEntry`
 * are a singular pair, and there is one cursor and one XState leaf. So a
 * not-yet-entered iteration is not a frame that merely is not current — it does
 * not exist, has no entry ordinal, and cannot carry a live credential.
 * Accepting `--index 2` from iteration 1 minted a bearer for a frame the parent
 * had not reached; when iteration 2 finally opened, `hasActiveDelegation` saw
 * the early row and skipped issuance, so the run wedged with no token for the
 * iteration and the child's claim closed `cursor-advanced`.
 *
 * It ABSTAINS wherever no active iteration is knowable, which is the whole of
 * its conservatism:
 * - a prompted-FOR step, which has no `forClause` and therefore no iteration
 *   machinery — the agent drives its frames by hand and `--index` is how it
 *   names them;
 * - a step the cursor is not on, whose currency the delegation resolver already
 *   owns (RD-802);
 * - a FOR step with no live non-implicit context, where there is no active
 *   iteration to compare against.
 *
 * Shared by the fresh and retry seams unchanged. Retry is deliberately NOT
 * exempt: re-minting onto a closed iteration produces the same unusable bearer
 * as minting onto an unopened one. Retrying the ACTIVE iteration — the verified
 * recovery from the wedge above — is untouched, because that names the frame
 * the parent is on.
 *
 * @param steps - Parsed steps from the locked runbook reread.
 * @param stepId - Raw qualified target from the frontend.
 * @param iteration - The explicit iteration the caller named.
 * @param state - The parent state captured inside the same fence.
 * @returns The refusal to propagate, or `undefined` when validation continues.
 */
function invalidDelegationIndexOutcome(
  steps: readonly ResolvedStep[],
  stepId: string,
  iteration: number,
  state: RunbookState,
): DelegationIndexRefusal | undefined {
  const parsed = parseStepIdFromString(stepId);
  if (!parsed) return undefined;
  const target = steps.find((step) => step.name === parsed.step);
  if (!target) return undefined;
  if (target.kind !== 'for' && target.kind !== 'prompted-for') {
    return {
      kind: 'invalid_index',
      message: `--index requires step "${parsed.step}" to be a FOR step, but it is "${target.kind}"`,
    };
  }
  // `deriveActiveFrame` reports an iteration only for a live, non-implicit FOR
  // context naming the CURSOR's step, so `active.step` is the only step this
  // iteration can legitimately be compared against. Comparing a foreign
  // target's `--index` to it would refuse the caller with a number from a
  // different loop; step currency belongs to the delegation resolver (RD-802).
  const active = deriveActiveFrame(state);
  if (active.step !== parsed.step) return undefined;
  if (active.iteration === undefined || active.iteration === iteration) return undefined;
  return {
    kind: 'error',
    error: Errors.delegationIndexNotActive(parsed.step, iteration, active.iteration),
  };
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
 * Reconcile caller evidence against a claim-shaped target, returning the refusal
 * to propagate when they diverge.
 *
 * A `claim` selector names its target BY THE BEARER ITSELF — the claim id
 * carries the live secret segment — so naming one is an act of presentation,
 * not merely of selection. Caller evidence and a claim-shaped target are
 * therefore one fact rather than two independent fields, and the only
 * consistent combination is "the caller presented the bearer it named".
 * Anything else — a different bearer, or no bearer at all — is a divergence the
 * seams refuse, instead of deriving authority from the TARGET's own claim and
 * so acting as the target while the caller's evidence said something else
 * (#613).
 *
 * Returns the refusal rather than a boolean so the outcome is constructed once
 * here instead of at each seam: a caller cannot consult this and then forget to
 * refuse, and every seam propagates an identical refusal by construction. Every
 * non-claim selector reconciles trivially, so all three seams can call this
 * unconditionally at entry rather than narrowing first.
 *
 * Authority keys on the DECLARED evidence kind, never on the mere presence of a
 * `claimId` property: `CallerEvidence` has no non-bearer variant carrying one,
 * and an untyped frontend must not be able to smuggle authority through a stray
 * field.
 *
 * @param evidence - Typed caller evidence supplied by the frontend.
 * @param selector - The command's target selector, any variant.
 * @returns A `claim_bearer_mismatch` refusal when a claim-shaped target was not
 *   presented by the caller; `undefined` when there is nothing to refuse.
 */
function reconcileClaimTarget(
  evidence: CallerEvidence,
  selector: CommandTargetSelector,
): ClaimBearerMismatchRefusal | undefined {
  if (selector.kind !== 'claim') return undefined;
  const presented = evidence.kind === 'claim_bearer' && evidence.claimId === selector.claimId;
  return presented ? undefined : { kind: 'claim_bearer_mismatch' };
}

/**
 * The runtime-only delegation capabilities a transitioning caller may exercise.
 *
 * ONE optional field carrying a branded pair, not two independently optional
 * callables. Issuance and derivation are two halves of one authority — a
 * descriptor minted by an issuer is refused RD-821 by a deriver bound to a
 * different issuer claim — so the authorization decision below is binary and the
 * type now says so. The old shape made a one-sided value expressible while no
 * producer could build one, which is what let consumers branch on the deriver
 * alone or forward the issuer alone.
 */
interface TransitionDelegationRuntime {
  /** Both capabilities, present iff the claim authorizes delegation from this run. */
  readonly delegationRuntime?: DelegationRuntimeCapabilities;
}

/**
 * Build the delegation runtime a transitioning caller is authorized to exercise.
 *
 * A lifecycle mutation that crosses into a credential-issuing state must carry
 * VERIFIED RUN-CONTROL authority — the `delegate-from-run` grant on the run
 * being advanced — not merely the `mutate-run` grant that authorized the
 * transition itself. Deriving the pair from the actor context alone conflated
 * the two: a bearer authorized to advance a run also received the capability to
 * mint bearers from it.
 *
 * RD-819-DEPENDENT: transitionDelegationRuntime.
 * Enumerated at the RD-819 guard in `delegation-service.ts`.
 *
 * The check is structural on purpose. The weaker gate has never been
 * exploitable, because the only bearer holding `mutate-run` without
 * `delegate-from-run` is a delegated child's, and nested delegation is refused
 * RD-819 before the issuer is exercised. That is a coincidence of two
 * independent rules, not an authority decision, and it evaporates the day the
 * nested prohibition moves or a narrower run-control grant set exists.
 *
 * Pure: reads only the verified claim's grants and the target run id. No
 * filesystem, network, or process access.
 *
 * @param actorContext - Caller context after core verified bearer proof.
 * @param runId - The run this transition mutates, and the only run the returned
 *   capabilities may be exercised for.
 * @returns The branded capability pair when the claim authorizes delegation from
 *   this run; an empty object otherwise.
 */
function transitionDelegationRuntime(
  actorContext: ActorContext,
  runId: RunId,
): TransitionDelegationRuntime {
  if (actorContext.kind !== 'verified_claim') return {};
  const decision = authorizeClaim(actorContext.claim, { action: 'delegate-from-run', runId });
  if (decision.kind !== 'allowed') return {};
  return { delegationRuntime: delegationRuntimeCapabilities(actorContext.authority) };
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
    | {
        readonly kind: 'verified';
        readonly actorContext: ActorContext;
        readonly authority: VerifiedClaimAuthority;
      }
    | { readonly kind: 'refused'; readonly policy: MutationAuthorityRefusalPolicy }
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
        authority: authority.authority,
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
   *   the aggregate actor-mutation transaction.
   */
  async issueDelegation(input: DelegationIssuanceInput): Promise<DelegationIssuanceOutcome> {
    if (input.mode === 'retry') return this.#issueRetry(input);

    // Target identification only — the anchor run's id (the `--run`-named
    // session-stack member, the presented claim's controlled run, or the active
    // default). Every state-dependent decision below runs against the exact
    // aggregate capture, not this advisory snapshot.
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

    // Resolve the requested positional before aggregate capture: it is fs-only
    // and state-independent. Never resolve the
    // authored target — keeps the echo path independent of authored
    // resolvability.
    let requested: RequestedRunbookArg = { kind: 'none' };
    if (input.requestedRunbook) {
      const requestedResolved = await this.#deps.resolveChildRunbook(input.requestedRunbook);
      requested = requestedResolved
        ? { kind: 'resolved', ref: requestedResolved.ref, raw: input.requestedRunbook }
        : { kind: 'unresolvable', raw: input.requestedRunbook };
    }

    const explicitTarget = input.explicitTarget;
    const targeted = explicitTarget !== undefined;
    const authority = await this.#resolveMutationActorContext({
      callerEvidence: input.callerEvidence,
      targetState: active,
      request: { action: 'delegate-from-run', runId: active.id },
      intent: 'delegation-issuance',
    });
    if (authority.kind === 'refused') {
      return { kind: 'refused', policy: authority.policy };
    }
    // Unreachable invariant: `#resolveMutationActorContext` returns
    // `kind: 'verified'` only alongside an actor context built by
    // `verifiedClaimContext`, whose `kind` is `verified_claim` by
    // construction — the refusal arm above is the only other outcome. The
    // guard exists to narrow the type for the issuer built below, so neither
    // forcing it false, emptying its body, nor blanking its message is
    // observable.
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable — a verified authority always carries a verified_claim context
    if (authority.actorContext.kind !== 'verified_claim') {
      // Stryker disable next-line StringLiteral: unreachable — this throw cannot fire (see above)
      throw new Error('Delegation issuance requires verified claim authority');
    }
    const issueCredential = createDelegationCredentialIssuer(authority.actorContext.authority);
    const deriveToken = createDelegationTokenDeriver(authority.actorContext.authority);

    // Exact bearer/grant authorization is the liveness proof. Observe it before
    // command policy can refuse for collection state and before any validation,
    // no-op resolution, or persistence. The recorder commits its own short
    // session transaction; no transaction is open across this call.
    if (input.callerEvidence.kind === 'claim_bearer') {
      await this.#deps.sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    const stepsByRun = new Map<RunId, readonly ResolvedStep[]>();
    let preparedFresh:
      | { readonly nextState: RunbookState; readonly value: DelegationIssuanceOutcome }
      | undefined;
    const aggregate = await this.#deps.actorMutationRunner.runAll<DelegationIssuanceOutcome>({
      targets: [{ runId: activeId, claimKey: authority.actorContext.authority.claimKey }],
      makeRecoveryActor: (runId, recoveryState) => {
        const recoverySteps = stepsByRun.get(runId);
        // Unreachable invariant: recovery only runs for a member whose attempt
        // crossed the effect boundary, which happens strictly after
        // `beforeEffect` recorded that run's steps in `stepsByRun`. The guard
        // keeps a future member added to `targets` without a steps entry from
        // rehydrating the wrong runbook graph, so forcing it false (or blanking
        // its message) is unobservable. Forcing it TRUE or inverting it skips
        // the factory entirely and is killed by "rehydrates the interrupted
        // issuance member from its own captured steps".
        // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable — beforeEffect always records the member's steps first
        if (!recoverySteps) throw new Error(`Missing recovery steps for delegation run ${runId}.`);
        return this.#deps.actorService.createRecoveryActor(recoveryState, recoverySteps);
      },
      beforeEffect: async ([captured]) => {
        const capturedSteps = await this.#deps.loadSteps(captured.state);
        stepsByRun.set(captured.state.id, capturedSteps);
        const policy = resolveCommandIntent({
          actorContext: authority.actorContext,
          intent: { kind: 'delegation-issuance', command: 'delegate', targeted },
          // Equivalent mutants: `resolveCommandIntent` reads `targetSelector`
          // at exactly one place — `input.targetSelector.kind === 'run'`, one
          // disjunct of the `requiresBearer` OR whose EARLIER disjunct
          // (`intent.kind === 'delegation-issuance'`) is already true here — so
          // neither this literal's shape nor its `kind` value can be observed.
          // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — targetSelector is unread on the delegation-issuance path
          targetSelector: { kind: 'default' },
          targetState: captured.state,
        });
        if (policy.kind !== 'allowed') {
          return { kind: 'return', value: { kind: 'refused', policy } };
        }
        if (explicitTarget?.iteration !== undefined) {
          const refusal = invalidDelegationIndexOutcome(
            capturedSteps,
            explicitTarget.stepId,
            explicitTarget.iteration,
            captured.state,
          );
          if (refusal) return { kind: 'return', value: refusal };
        }
        const frameKey =
          explicitTarget?.iteration !== undefined
            ? buildFrameKey(captured.state.step, explicitTarget.iteration)
            : (captured.state.activeFrameKey ?? deriveActiveFrame(captured.state).frameKey);
        const exact = resolveDelegationIssuance(captured.state, capturedSteps, frameKey, {
          ...(explicitTarget !== undefined ? { explicitStep: explicitTarget.stepId } : {}),
          requested,
        });
        if (exact.kind === 'already-issued') {
          // Never echo a bearer this claim cannot reproduce and verify against
          // the persisted verifier — a refused echo returns data, not a token.
          const echoed = verifyEchoedDelegationToken(exact, deriveToken);
          if (echoed.kind === 'unverifiable') {
            return { kind: 'return', value: { kind: 'error', error: echoed.error } };
          }
          return {
            kind: 'return',
            value: {
              kind: 'already-delegated',
              stepId: exact.stepId,
              runbookRef: exact.runbookRef,
              token: echoed.token,
              parentRunId: captured.state.id,
            },
          };
        }
        if (exact.kind !== 'issuable') {
          return { kind: 'return', value: { kind: 'error', error: exact.error } };
        }
        const childResolved = await this.#deps.resolveChildRunbook(exact.runbookRef);
        if (!childResolved) {
          return {
            kind: 'return',
            value: { kind: 'error', error: Errors.delegationRunbookNotFound(exact.runbookRef) },
          };
        }
        if (
          requested.kind === 'unresolvable' ||
          (requested.kind === 'resolved' && !sameRunbookRef(requested.ref, childResolved.ref))
        ) {
          return {
            kind: 'return',
            value: {
              kind: 'error',
              error: Errors.delegationRunbookMismatch(
                exact.stepId,
                requested.raw,
                exact.runbookRef,
              ),
            },
          };
        }
        const resolvedExtraVars = await input.resolveExtraVars?.();
        const createStepId = withFrameIteration(exact.stepId, explicitTarget?.iteration);
        const prepared = await this.#deps.actorService.prepareManualDelegationMutation(
          captured.state,
          capturedSteps,
          {
            type: 'ISSUE',
            stepId: createStepId,
            frameKey,
            childRunbookPath: childResolved.path,
            childRunbookRef: childResolved.ref,
            // Equivalent mutant (`=== undefined` → `!== undefined` inverted to
            // always-spread only): spreading `{ extraVars: undefined }` is
            // indistinguishable from omitting the key — `createDelegation`
            // stores it as `...(extraVars ? { extraVars } : {})` and the machine
            // re-tests `event.extraVars === undefined`. The conditional is kept
            // for exact-optional-property typing. Dropping the value when it IS
            // present is observable and killed by "forwards resolved extraVars
            // into the persisted delegation and its context snapshot".
            // Stryker disable next-line ConditionalExpression: equivalent — an explicit undefined extraVars is treated as absent downstream
            ...(resolvedExtraVars === undefined ? {} : { extraVars: resolvedExtraVars }),
          },
          issueCredential,
        );
        if (prepared.status !== 'prepared') {
          if (prepared.status === 'error' || prepared.status === 'child_in_flight') {
            return { kind: 'return', value: { kind: 'error', error: prepared.error } };
          }
          throw new Error(`Issue preparation returned ${prepared.status}`);
        }
        const issued = findSubstepState(
          // Stryker disable next-line ArrayDeclaration: unreachable — a prepared ISSUE always carries substepStates
          prepared.nextState.substepStates ?? [],
          // Stryker disable next-line OptionalChaining: unreachable — `createStepId` is built from an id the resolver already matched
          parseStepIdFromString(createStepId)?.substep ?? createStepId,
          frameKey,
        );
        // Unreachable invariant: `prepared.status === 'prepared'` means the
        // machine committed the ISSUE, which is the only thing that writes this
        // substep's `delegation`. Neither forcing the guard false, dropping the
        // `?.`, nor blanking the message can change an observable outcome; the
        // throw exists so a machine that silently stopped issuing cannot persist
        // a delegation-less state as a successful mint.
        // Stryker disable next-line ConditionalExpression,OptionalChaining,StringLiteral: unreachable — a prepared ISSUE always carries the delegation
        if (!issued?.delegation) throw new Error('Machine did not prepare the issued delegation.');
        preparedFresh = {
          nextState: replaceIssuedDelegation(
            prepared.nextState,
            // Stryker disable next-line ArrayDeclaration: unreachable — see the lookup above
            prepared.nextState.substepStates ?? [],
            createStepId,
            frameKey,
          ),
          value: {
            kind: 'delegated',
            stepId: exact.stepId,
            runbookRef: childResolved.ref.path,
            token: deriveToken(issued.delegation.credential),
            tokenHash: issued.delegation.tokenHash,
            parentRunId: captured.state.id,
          },
        };
        // Equivalent mutant: the aggregate runner tests only for the OTHER arm
        // (`beforeEffect?.kind === 'return'`) and treats every other value —
        // including `{}` and an empty discriminant — as "continue". The literal
        // is the readable half of a union whose refusing arm carries a value.
        // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — only the 'return' discriminant is ever compared
        return { kind: 'continue' };
      },
      compute: ([captured]) => {
        const prepared = preparedFresh;
        // Unreachable invariant: `compute` runs only after `beforeEffect`
        // returned `continue`, and the sole `continue` path assigns
        // `preparedFresh` immediately above it. The throw guards a future
        // `continue` that forgets to.
        // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable — a continuing beforeEffect always assigned preparedFresh
        if (!prepared) throw new Error('Delegation transaction lost its prepared issuance.');
        return Promise.resolve({
          members: [{ runId: captured.state.id, nextState: prepared.nextState }],
          value: prepared.value,
        });
      },
    });
    return aggregate.kind === 'committed' ? aggregate.value : aggregate;
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
    let supersedingScan: readonly TokenScanResult[] = [];

    if (locator.kind === 'token') {
      // Both halves come from ONE scan. `current` matches `tokenHash` only, so a
      // replayed retry naming a bearer that has since been rotated away resolves
      // to nothing there.
      //
      // The supersession index is populated UNCONDITIONALLY — not as a fallback
      // when `current` misses. Skipping it on a hit would make "more than one
      // attempt records this bearer as superseded" invisible in exactly the case
      // where a current row also matches, which is the corrupted state the
      // refusal exists for. Collecting always is the fail-closed choice, and it
      // is what lets `resolveRetryIssuance` remain the single place the priority
      // between ambiguity and a matching current row is expressed. Answering
      // both from one listing also removes the window in which the two lookups
      // observed different disk states. This seam decides nothing from the
      // result but *where* the target run is.
      const { current: scan, superseding } = await this.#deps.findDelegationsByTokenHash(
        hashDelegationToken(locator.token),
      );
      supersedingScan = superseding;
      // `.at(0)` for the same reason as `resolveRetryIssuance`'s `replacement`:
      // an index read is typed as always-present, so the guard below would read
      // as dead code even though an empty scan yields `undefined` and must fall
      // through to `token-not-found`.
      const located = scan ?? supersedingScan.at(0);
      if (!located)
        return { kind: 'token-not-found', tokenHint: truncateDelegationToken(locator.token) };
      // Fail-closed: an explicit `--run` that names a different run than the
      // token's owner is refused, never silently discarded. The message echoes
      // only the caller-supplied id — never the token's actual owning run
      // (accident barrier).
      if (input.targetRunId !== undefined && located.parentState.id !== input.targetRunId) {
        return {
          kind: 'run_target_mismatch',
          runId: input.targetRunId,
          message: `Run ${input.targetRunId} does not own the supplied delegation token.`,
        };
      }
      targetRunId = located.parentState.id;
      const substepId = located.substepId ?? located.stepId;
      // The canonical contextSnapshot.at surfaces FOR-iteration retries as e.g.
      // "1.2.1". `buildContextSnapshot` derives `at` unconditionally, so a
      // persisted snapshot always carries it; its absence means the snapshot is
      // from an incompatible/older persisted shape. Fail closed per the
      // no-migration rule (reject; never reconstruct the label from legacy
      // `substep`/`stepId` fields) — mirroring the downstream staleness gate.
      const snapshot = located.delegation.contextSnapshot;
      if (snapshot.at === undefined) {
        return {
          kind: 'error',
          error: Errors.delegationSnapshotStale(substepId, located.stepId),
        };
      }
      cursor = { substepId, frameKey: located.frameKey, stepLabel: snapshot.at };
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
      // deferred until the aggregate runner captures the authoritative state.
      targetRunId = anchored.state.id;
    }

    const freshState = await this.#deps.loadRun(targetRunId);
    if (!freshState) {
      if (locator.kind === 'token')
        return { kind: 'token-not-found', tokenHint: truncateDelegationToken(locator.token) };
      return locator.kind === 'active'
        ? { kind: 'retry_target_required' }
        : { kind: 'no-active-runbook' };
    }

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
    const { substepId, frameKey } = cursor;

    // Policy gate — `targeted: true` (a retry re-issues a specific delegation),
    // so a pending collection does not refuse it. Final classification is
    // repeated against the aggregate capture in `beforeEffect`; this earlier
    // state only identifies aggregate members and verifies authority.
    const authority = await this.#resolveMutationActorContext({
      callerEvidence: input.callerEvidence,
      targetState: freshState,
      request: { action: 'retry-delegation', runId: freshState.id, stepId: substepId },
      intent: 'delegation-issuance',
    });
    if (authority.kind === 'refused') {
      return { kind: 'refused', policy: authority.policy };
    }
    // Unreachable invariant: `#resolveMutationActorContext` returns
    // `kind: 'verified'` only alongside an actor context built by
    // `verifiedClaimContext`, whose `kind` is `verified_claim` by
    // construction — the refusal arm above is the only other outcome. The
    // guard exists to narrow the type for the issuer built below, so neither
    // forcing it false, emptying its body, nor blanking its message is
    // observable.
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable — a verified authority always carries a verified_claim context
    if (authority.actorContext.kind !== 'verified_claim') {
      // Stryker disable next-line StringLiteral: unreachable — this throw cannot fire (see above)
      throw new Error('Delegation retry requires verified claim authority');
    }
    const issueCredential = createDelegationCredentialIssuer(authority.actorContext.authority);
    const deriveToken = createDelegationTokenDeriver(authority.actorContext.authority);

    // Retry bearer/grant authorization independently proves liveness before
    // command policy, validation, or persistence. The total recorder cannot
    // prevent or mask any later refusal/outcome (RD-102).
    if (input.callerEvidence.kind === 'claim_bearer') {
      await this.#deps.sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    const targetSubstep = freshState.substepStates?.find(
      (entry) => entry.id === substepId && entry.frameKey === frameKey,
    );
    const linkedChildRunId = targetSubstep?.delegation?.childRunId ?? null;
    const linkedChild = linkedChildRunId ? await this.#deps.loadRun(linkedChildRunId) : undefined;
    const linkedChildTerminal =
      linkedChild?.lifecycle === 'completed' || linkedChild?.lifecycle === 'stopped';
    const allowLinkedChildRun = linkedChildTerminal;

    const stepsByRun = new Map<RunId, readonly ResolvedStep[]>();
    const hasTerminalChild = linkedChildRunId !== null && allowLinkedChildRun;
    let preparedRetry:
      | { readonly nextState: RunbookState; readonly value: DelegationIssuanceOutcome }
      | undefined;
    const aggregate = await this.#deps.actorMutationRunner.runAll<DelegationIssuanceOutcome>({
      targets: [
        ...(hasTerminalChild
          ? [{ runId: linkedChildRunId, optionalWhenClaimSuperseded: true }]
          : []),
        { runId: freshState.id, claimKey: authority.actorContext.authority.claimKey },
      ],
      ...(hasTerminalChild
        ? { releases: [{ runId: linkedChildRunId, retainClaimsAsTerminal: false }] }
        : {}),
      makeRecoveryActor: (runId, recoveryState) => {
        const recoverySteps = stepsByRun.get(runId);
        // Unreachable invariant: recovery only runs for a member whose attempt
        // crossed the effect boundary, which happens strictly after
        // `beforeEffect` recorded that run's steps in `stepsByRun`. The guard
        // keeps a future member added to `targets` without a steps entry from
        // rehydrating the wrong runbook graph, so forcing it false (or blanking
        // its message) is unobservable. Forcing it TRUE or inverting it skips
        // the factory entirely and is killed by "rehydrates the interrupted
        // issuance member from its own captured steps".
        // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable — beforeEffect always records the member's steps first
        if (!recoverySteps) throw new Error(`Missing recovery steps for delegation run ${runId}.`);
        return this.#deps.actorService.createRecoveryActor(recoveryState, recoverySteps);
      },
      beforeEffect: async (captured) => {
        // Equivalent mutant (`=== null` → always-false only): with no linked
        // child the `find` runs over captured states whose ids are branded run
        // ids, so nothing can equal `null` and the result is `undefined` either
        // way. Forcing it TRUE (never look the child up) drops the linked-child
        // re-check and is killed by "refuses RD-823 when the linked child is no
        // longer terminal at capture".
        // Stryker disable next-line ConditionalExpression: equivalent — a null linked child id matches no captured run
        const child =
          linkedChildRunId === null
            ? undefined
            : captured.find(({ state }) => state.id === linkedChildRunId);
        const parent = captured.find(({ state }) => state.id === freshState.id);
        // Unreachable invariant: the parent is a REQUIRED aggregate target, so a
        // capture that failed to produce it returns a refusal before
        // `beforeEffect` ever runs. Forcing the guard false, dropping the `?.`,
        // emptying the body or blanking the message therefore cannot change an
        // observable outcome; the throw pins the ordering contract for a future
        // target list.
        // Stryker disable next-line ConditionalExpression,OptionalChaining,BlockStatement: unreachable — a required target always appears in `captured`
        if (parent?.state.id !== freshState.id) {
          // Stryker disable next-line StringLiteral: unreachable — this throw cannot fire (see above)
          throw new Error('Delegation retry did not capture its parent in dependency order.');
        }
        const parentSteps = await this.#deps.loadSteps(parent.state);
        stepsByRun.set(parent.state.id, parentSteps);
        let exactCursor = cursor;
        if (locator.kind === 'step') {
          const parsed = parseStepIdFromString(locator.step);
          const stepName = parsed?.step ?? locator.step;
          const activeDerived = deriveActiveFrame(parent.state);
          exactCursor = {
            substepId: parsed?.substep ?? stepName,
            frameKey:
              locator.iteration !== undefined
                ? buildFrameKey(stepName, locator.iteration)
                : activeDerived.step === stepName
                  ? (parent.state.activeFrameKey ?? activeDerived.frameKey)
                  : buildFrameKey(stepName),
            stepLabel:
              locator.iteration !== undefined
                ? deriveExecutionAt(stepName, parsed?.substep, locator.iteration)
                : locator.step,
          };
        } else if (locator.kind === 'active') {
          if (parent.state.substep === undefined) {
            return { kind: 'return', value: { kind: 'retry_target_required' } };
          }
          const activeDerived = deriveActiveFrame(parent.state);
          exactCursor = {
            substepId: parent.state.substep,
            frameKey: parent.state.activeFrameKey ?? activeDerived.frameKey,
            stepLabel: deriveExecutionAt(
              parent.state.step,
              parent.state.substep,
              activeDerived.iteration,
            ),
          };
        }
        const policy = resolveCommandIntent({
          actorContext: authority.actorContext,
          intent: {
            kind: 'delegation-issuance',
            command: 'retry',
            targeted: true,
            stepId: exactCursor.substepId,
          },
          // Equivalent mutants: `resolveCommandIntent` reads `targetSelector`
          // at exactly one place — `input.targetSelector.kind === 'run'`, one
          // disjunct of the `requiresBearer` OR whose EARLIER disjunct
          // (`intent.kind === 'delegation-issuance'`) is already true here — so
          // neither this literal's shape nor its `kind` value can be observed.
          // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — targetSelector is unread on the delegation-issuance path
          targetSelector: { kind: 'default' },
          targetState: parent.state,
        });
        if (policy.kind !== 'allowed') {
          return { kind: 'return', value: { kind: 'refused', policy } };
        }
        // Equivalent mutant (the `locator.kind === 'step'` operand only): the
        // other locator variants have no `iteration` member at all, so the right
        // operand is already false for them and the guard's left half cannot be
        // observed. It is spelled out so the `locator.step` read below narrows.
        // Stryker disable next-line ConditionalExpression: equivalent — only a step locator can carry an iteration
        if (locator.kind === 'step' && locator.iteration !== undefined) {
          const refusal = invalidDelegationIndexOutcome(
            parentSteps,
            locator.step,
            locator.iteration,
            parent.state,
          );
          if (refusal) return { kind: 'return', value: refusal };
        }
        const exactSubstep = findSubstepState(
          parent.state.substepStates ?? [],
          exactCursor.substepId,
          exactCursor.frameKey,
        );
        const exactChildRunId = exactSubstep?.delegation?.childRunId ?? null;
        if (exactChildRunId !== linkedChildRunId) {
          return {
            kind: 'return',
            value: {
              kind: 'error',
              error: Errors.delegationInFlight(
                exactCursor.substepId,
                exactChildRunId ?? linkedChildRunId ?? 'unknown',
              ),
            },
          };
        }
        if (child !== undefined) {
          const childSteps = await this.#deps.loadSteps(child.state);
          stepsByRun.set(child.state.id, childSteps);
          if (child.state.lifecycle !== 'completed' && child.state.lifecycle !== 'stopped') {
            return {
              kind: 'return',
              value: {
                kind: 'error',
                error: Errors.delegationInFlight(exactCursor.substepId, child.state.id),
              },
            };
          }
        }
        // Retry idempotency (#681). Placed exactly here on purpose: after the
        // linked-child guards, whose refusals outrank a committed-result echo,
        // and BEFORE `resolveOverrides`, which is deliberately deferred so a bad
        // `--input-file` cannot mask a higher-priority precondition. This mirrors
        // the fresh path, where `resolveDelegationIssuance` decides
        // echo-versus-issue in `beforeEffect` and the machine runs only on the
        // issuable branch.
        //
        // Both halves are pure and live in `delegation-inference.ts`:
        // `buildRetryIssuanceCapture` owns how superseding rows are collected
        // and tagged with the coordinate they came from, and
        // `resolveRetryIssuance` owns the decision. This seam supplies the
        // captured state and the resolved cursor, and narrows on the result.
        const retryResolution = resolveRetryIssuance(
          buildRetryIssuanceCapture(
            {
              token: locator.kind === 'token' ? locator.token : undefined,
              capturedState: parent.state,
              scannedSuperseding: supersedingScan,
              current: exactSubstep?.delegation,
              substepId: exactCursor.substepId,
              frameKey: exactCursor.frameKey,
              frameEntry: inferFrameEntryFromState(parent.state, exactCursor.frameKey),
            },
            hashDelegationToken,
          ),
        );
        switch (retryResolution.kind) {
          case 'ambiguous':
            return {
              kind: 'return',
              value: {
                kind: 'error',
                error: Errors.delegationSupersessionAmbiguous(exactCursor.substepId),
              },
            };
          case 'identity-unmatched':
            return {
              kind: 'return',
              value: {
                kind: 'error',
                error: Errors.delegationRetryIdentityUnmatched(exactCursor.substepId),
              },
            };
          case 'replacement-consumed':
            return {
              kind: 'return',
              value: {
                kind: 'error',
                error: Errors.delegationReplacementConsumed(
                  exactCursor.substepId,
                  retryResolution.reason,
                ),
              },
            };
          case 'already-replaced': {
            const echoed = verifyDerivedBearer(
              retryResolution.delegation.credential,
              retryResolution.delegation.tokenHash,
              exactCursor.substepId,
              deriveToken,
            );
            if (echoed.kind === 'unverifiable') {
              return { kind: 'return', value: { kind: 'error', error: echoed.error } };
            }
            return {
              kind: 'return',
              value: {
                kind: 'retry-already-applied',
                stepLabel: exactCursor.stepLabel,
                runbookPath: retryResolution.delegation.childRunbookPath,
                token: echoed.token,
                tokenHash: retryResolution.delegation.tokenHash,
                parentRunId: parent.state.id,
              },
            };
          }
          case 'rotatable':
            break;
          default: {
            const _exhaustive: never = retryResolution;
            throw new Error(`Unhandled retry resolution: ${JSON.stringify(_exhaustive)}`);
          }
        }
        const overrides = await input.resolveOverrides?.();
        const prepared = await this.#deps.actorService.prepareManualDelegationMutation(
          parent.state,
          parentSteps,
          {
            type: 'RETRY',
            substepId: exactCursor.substepId,
            frameKey: exactCursor.frameKey,
            allowLinkedChildRun,
            // Equivalent mutant (inverting to always-spread only): an explicit
            // `overrides: undefined` is indistinguishable from omitting the key —
            // `retryDelegation` composes with `...(overrides ?? {})`. Dropping a
            // PRESENT value is observable and killed by "forwards resolved
            // overrides into the re-minted delegation".
            // Stryker disable next-line ConditionalExpression: equivalent — an explicit undefined overrides is treated as absent downstream
            ...(overrides === undefined ? {} : { overrides }),
          },
          issueCredential,
        );
        if (prepared.status !== 'prepared') {
          if (prepared.status === 'error' || prepared.status === 'child_in_flight') {
            return { kind: 'return', value: { kind: 'error', error: prepared.error } };
          }
          throw new Error(`Retry preparation returned ${prepared.status}`);
        }
        const issued = findSubstepState(
          // Stryker disable next-line ArrayDeclaration: unreachable — a prepared RETRY always carries substepStates
          prepared.nextState.substepStates ?? [],
          exactCursor.substepId,
          exactCursor.frameKey,
        );
        // Unreachable invariant: `prepared.status === 'prepared'` means the
        // machine committed the RETRY, which is the only thing that writes this
        // substep's `delegation`. The throw keeps a machine that silently stopped
        // re-issuing from persisting a delegation-less state as a fresh mint.
        // Stryker disable next-line ConditionalExpression,OptionalChaining,StringLiteral: unreachable — a prepared RETRY always carries the delegation
        if (!issued?.delegation) throw new Error('Machine did not prepare the retried delegation.');
        preparedRetry = {
          nextState: replaceIssuedDelegation(
            prepared.nextState,
            // Stryker disable next-line ArrayDeclaration: unreachable — see the lookup above
            prepared.nextState.substepStates ?? [],
            exactCursor.substepId,
            exactCursor.frameKey,
          ),
          value: {
            kind: 'retried',
            stepLabel: exactCursor.stepLabel,
            runbookPath: issued.delegation.childRunbookPath,
            token: deriveToken(issued.delegation.credential),
            tokenHash: issued.delegation.tokenHash,
            parentRunId: parent.state.id,
          },
        };
        // Equivalent mutant: the aggregate runner tests only for the OTHER arm
        // (`beforeEffect?.kind === 'return'`); every other value continues.
        // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — only the 'return' discriminant is ever compared
        return { kind: 'continue' };
      },
      compute: (captured) => {
        // Stryker disable next-line ConditionalExpression: equivalent — a null linked child id matches no captured run (see beforeEffect)
        const child =
          linkedChildRunId === null
            ? undefined
            : captured.find(({ state }) => state.id === linkedChildRunId);
        const parent = captured.find(({ state }) => state.id === freshState.id);
        // Unreachable invariants: `compute` runs only after `beforeEffect`
        // returned `continue`, which requires the required parent target to have
        // been captured and assigns `preparedRetry` on its way out.
        // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable — a required target is always captured
        if (!parent) throw new Error('Delegation retry lost its parent capture.');
        const prepared = preparedRetry;
        // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable — a continuing beforeEffect always assigned preparedRetry
        if (!prepared) throw new Error('Delegation retry lost its prepared replacement.');
        return Promise.resolve({
          members: [
            ...(child ? [{ runId: child.state.id, nextState: child.state }] : []),
            { runId: parent.state.id, nextState: prepared.nextState },
          ],
          value: prepared.value,
        });
      },
    });
    return aggregate.kind === 'committed' ? aggregate.value : aggregate;
  }

  /**
   * Cancel a delegation and atomically stop/report/release its linked child.
   *
   * The token scan only identifies the aggregate. Every behavior-bearing
   * decision is repeated against the exact captured parent and child. A forced
   * running child is retained as stopped terminal evidence; physical deletion
   * is deferred to pruning so exact execution-attempt evidence survives crash
   * reconciliation. A linked child whose run no longer exists is cleaned rather
   * than refused, so a pruned or deleted child cannot strand the parent's
   * delegation permanently linked.
   *
   * @param input - Token, caller authority, and force policy.
   * @returns Domain, policy, transaction, or committed abort outcome.
   */
  async abortDelegation(input: DelegationAbortInput): Promise<DelegationAbortOutcome> {
    // Hashed once, here: the lookup takes the verifier, so the abort no longer
    // hashes the same bearer a second time to compare it below.
    const tokenHash = hashDelegationToken(input.token);
    const { current: scan } = await this.#deps.findDelegationsByTokenHash(tokenHash);
    if (!scan) return { kind: 'token_not_found' };
    const parentRunId = scan.parentState.id;
    const substepId = scan.substepId ?? scan.stepId;
    const frameKey = scan.frameKey;
    const scannedChildRunId = scan.delegation.childRunId;

    const authority = await this.#resolveMutationActorContext({
      callerEvidence: input.callerEvidence,
      targetState: scan.parentState,
      request: { action: 'abort-delegation', runId: parentRunId, stepId: substepId },
      intent: 'delegation-issuance',
    });
    if (authority.kind === 'refused') return { kind: 'refused', policy: authority.policy };
    // Unreachable invariant: `#resolveMutationActorContext` returns
    // `kind: 'verified'` only alongside an actor context built by
    // `verifiedClaimContext`, whose `kind` is `verified_claim` by
    // construction — the refusal arm above is the only other outcome. The
    // guard exists to narrow the type for the issuer built below, so neither
    // forcing it false, emptying its body, nor blanking its message is
    // observable.
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable — a verified authority always carries a verified_claim context
    if (authority.actorContext.kind !== 'verified_claim') {
      // Stryker disable next-line StringLiteral: unreachable — this throw cannot fire (see above)
      throw new Error('Delegation abort requires verified claim authority');
    }
    const verifiedAuthority = authority.actorContext.authority;
    // Equivalent mutant: `resolveMutationAuthority` refuses outright when no
    // bearer was presented, and only `claim_bearer` evidence presents one — so a
    // verified authority here implies bearer evidence and the guard is always
    // true. It is written out because the narrowing is what reaches `claimId`.
    // Stryker disable next-line ConditionalExpression: equivalent — a verified authority implies claim_bearer evidence
    if (input.callerEvidence.kind === 'claim_bearer') {
      await this.#deps.sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    // A linked child whose run no longer exists is CLEANABLE, not a refusal.
    // Its stale `childRunId` is precisely what `abort --force` exists to clear,
    // so refusing here would leave the delegation permanently linked and the
    // token impossible to force-abort — a stuck state with no operator
    // recovery. Only a child that is genuinely absent is dropped: a child whose
    // state loads stays a REQUIRED aggregate member, so every other reason it
    // cannot be mutated (an execution in progress, a superseded claim, a
    // concurrent modification) still refuses the whole force-abort rather than
    // being silently discarded. That distinction is why the drop is decided
    // here, from the absence of state, and not by marking the aggregate target
    // `optional` — which would drop the child on ANY capture refusal.
    const scannedChild =
      scannedChildRunId === null ? undefined : await this.#deps.loadRun(scannedChildRunId);
    // Equivalent mutants: `missingChildRunId` is READ at exactly one place — the
    // `else if` arm of `if (scannedChild !== undefined)` — so every evaluation
    // that can be observed already has `scannedChild === undefined`. Under that
    // condition the conjunction (and each half of it, and `||` in its place)
    // reduces to `scannedChildRunId`, which is what the arm needs. The
    // conjunction is written out so the value cannot leak into the branch that
    // DOES have a child state.
    // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — only read where `scannedChild === undefined`
    const missingChildRunId =
      scannedChildRunId !== null && scannedChild === undefined ? scannedChildRunId : null;
    const stepsByRun = new Map<RunId, readonly ResolvedStep[]>();
    let prepared:
      | {
          readonly parent: RunbookState;
          readonly child?: RunbookState;
          readonly value: Extract<DelegationAbortOutcome, { readonly kind: 'cancelled' }>;
        }
      | undefined;
    const aggregate = await this.#deps.actorMutationRunner.runAll<DelegationAbortOutcome>({
      targets: [
        ...(scannedChild === undefined ? [] : [{ runId: scannedChild.id }]),
        { runId: parentRunId, claimKey: verifiedAuthority.claimKey },
      ],
      ...(scannedChild === undefined
        ? {}
        : { releases: [{ runId: scannedChild.id, retainClaimsAsTerminal: false }] }),
      makeRecoveryActor: (runId, recoveryState) => {
        const recoverySteps = stepsByRun.get(runId);
        // Unreachable invariant: recovery only runs for a member whose attempt
        // crossed the effect boundary, which happens strictly after
        // `beforeEffect` recorded that run's steps in `stepsByRun`. The guard
        // keeps a future member added to `targets` without a steps entry from
        // rehydrating the wrong runbook graph, so forcing it false (or blanking
        // its message) is unobservable. Forcing it TRUE or inverting it skips
        // the factory entirely and is killed by "rehydrates the interrupted
        // issuance member from its own captured steps".
        // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable — beforeEffect always records the member's steps first
        if (!recoverySteps) throw new Error(`Missing recovery steps for abort run ${runId}.`);
        return this.#deps.actorService.createRecoveryActor(recoveryState, recoverySteps);
      },
      beforeEffect: async (captured) => {
        // Equivalent mutant (the `undefined` arm only): `child` is read solely
        // inside `if (scannedChild !== undefined)`, so when no child was scanned
        // the value is never observed — taking `captured.at(0)` there just aliases
        // the parent into a variable nothing reads.
        // Stryker disable next-line ConditionalExpression: equivalent — `child` is unread when no child was scanned
        const child = scannedChild === undefined ? undefined : captured.at(0);
        const parent = captured.at(scannedChild === undefined ? 0 : 1);
        // Unreachable invariant: the parent is a REQUIRED aggregate target and is
        // listed LAST, so a capture that did not produce it in that position
        // refuses before `beforeEffect` runs. The throw pins the ordering
        // contract the index above depends on.
        // Stryker disable next-line ConditionalExpression,OptionalChaining,BlockStatement: unreachable — the required parent is always captured last
        if (parent?.state.id !== parentRunId) {
          // Stryker disable next-line StringLiteral: unreachable — this throw cannot fire (see above)
          throw new Error('Delegation abort did not capture its parent last.');
        }
        const parentSteps = await this.#deps.loadSteps(parent.state);
        stepsByRun.set(parent.state.id, parentSteps);
        // Stryker disable next-line ArrayDeclaration: unreachable — an aborting parent always has substepStates
        const exact = findSubstepState(parent.state.substepStates ?? [], substepId, frameKey);
        if (exact?.delegation?.tokenHash !== tokenHash) {
          return { kind: 'return', value: { kind: 'token_not_found' } };
        }
        if (exact.delegation.childRunId !== scannedChildRunId) {
          return { kind: 'return', value: { kind: 'token_not_found' } };
        }
        const parentPrepared = await this.#deps.actorService.prepareManualDelegationMutation(
          parent.state,
          parentSteps,
          { type: 'ABORT', substepId, frameKey, force: input.force },
          createDelegationCredentialIssuer(verifiedAuthority),
        );
        switch (parentPrepared.status) {
          case 'prepared':
            break;
          case 'error':
          case 'child_in_flight':
            return { kind: 'return', value: { kind: 'error', error: parentPrepared.error } };
          case 'needs_force':
            return {
              kind: 'return',
              value: {
                kind: 'needs_force',
                substepId,
                childRunId: parentPrepared.childRunId,
              },
            };
          case 'already_cancelled':
            return {
              kind: 'return',
              value: {
                kind: 'already_cancelled',
                parentRunId,
                substepId,
                childRunbookPath: exact.delegation.childRunbookPath,
              },
            };
          // Unreachable by construction: `parentPrepared` is narrowed to `never`
          // here, so this arm exists to turn a future preparation status into a
          // COMPILE error rather than a silent fallthrough. It has no runtime
          // behaviour to observe.
          // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable — exhaustive `never` arm
          default: {
            const _exhaustive: never = parentPrepared;
            return _exhaustive;
          }
        }

        let nextParent = parentPrepared.nextState;
        let nextChild: RunbookState | undefined;
        let cleanup: Extract<DelegationAbortOutcome, { readonly kind: 'cancelled' }>['cleanup'] =
          'none';
        if (scannedChild !== undefined) {
          // Unreachable invariant: when a child was scanned it is target 0, so
          // `captured.at(0)` is that child by construction. The throw pins the
          // ordering the index above depends on.
          // Stryker disable next-line ConditionalExpression,OptionalChaining,BlockStatement: unreachable — the scanned child is always captured first
          if (child?.state.id !== scannedChild.id) {
            // Stryker disable next-line StringLiteral: unreachable — this throw cannot fire (see above)
            throw new Error('Delegation abort did not capture its linked child first.');
          }
          if (
            child.state.parentLinkage?.kind !== 'delegation' ||
            child.state.parentLinkage.parentRunId !== parentRunId ||
            child.state.parentLinkage.parentStepId !== substepId ||
            child.state.parentLinkage.parentFrameKey !== frameKey ||
            child.state.parentLinkage.tokenHash !== tokenHash
          ) {
            return { kind: 'return', value: { kind: 'token_not_found' } };
          }
          const childSteps = await this.#deps.loadSteps(child.state);
          stepsByRun.set(child.state.id, childSteps);
          if (child.state.lifecycle === 'running') {
            nextChild = (
              await this.#deps.actorService.prepareActorMutation(
                child.state.id,
                child.state,
                childSteps,
                { type: 'FORCE_STOP', message: 'Delegation force-aborted' },
              )
            ).nextState;
            cleanup = 'active_child_failed';
          } else {
            nextChild = child.state;
            cleanup = 'terminal_child_cleaned';
          }
          nextParent = replaceIssuedDelegation(
            nextParent,
            // Stryker disable next-line ArrayDeclaration: unreachable — a prepared ABORT always carries substepStates
            nextParent.substepStates ?? [],
            substepId,
            frameKey,
          );
          const report = this.#deps.completionService.prepareChildCompletion(
            { childState: nextChild, result: 'fail', ignoreCancellation: true },
            nextParent,
          );
          if (report.kind !== 'recorded') {
            throw new Error(`Force abort could not prepare child failure: ${report.kind}`);
          }
          nextParent = report.nextParentState;
        } else if (missingChildRunId !== null) {
          // The linked child's run is gone, so there is nothing to stop and no
          // terminal child state to report as a failure. What survives it is
          // the delegated outcome it left on the parent, which no collect can
          // ever resolve against a run that no longer exists: supersede it
          // alongside the cancellation, exactly as the pre-aggregate cleanup
          // path did. Superseding is the whole of this branch's effect — no
          // child completion is fabricated from a state we do not have.
          nextParent = replaceIssuedDelegation(
            nextParent,
            // Stryker disable next-line ArrayDeclaration: unreachable — a prepared ABORT always carries substepStates
            nextParent.substepStates ?? [],
            substepId,
            frameKey,
          );
          cleanup = 'missing_child_cleaned';
        }
        prepared = {
          parent: nextParent,
          // Equivalent mutant (inverting to always-spread only): an explicit
          // `child: undefined` reads identically to an absent key at the single
          // consumer below (`exactPrepared.child === undefined`). Dropping a
          // PRESENT child is observable and killed by the force-stop tests.
          // Stryker disable next-line ConditionalExpression: equivalent — an explicit undefined child is treated as absent
          ...(nextChild === undefined ? {} : { child: nextChild }),
          value: {
            kind: 'cancelled',
            parentRunId,
            substepId,
            childRunbookPath: exact.delegation.childRunbookPath,
            childRunId: scannedChildRunId,
            cleanup,
          },
        };
        // Equivalent mutant: the aggregate runner tests only for the OTHER arm
        // (`beforeEffect?.kind === 'return'`); every other value continues.
        // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — only the 'return' discriminant is ever compared
        return { kind: 'continue' };
      },
      compute: () => {
        const exactPrepared = prepared;
        // Unreachable invariant: `compute` runs only after `beforeEffect`
        // returned `continue`, and the sole `continue` path assigns `prepared`.
        // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable — a continuing beforeEffect always assigned prepared
        if (!exactPrepared) throw new Error('Delegation abort lost its prepared mutation.');
        return Promise.resolve({
          members: [
            ...(exactPrepared.child === undefined
              ? []
              : [{ runId: exactPrepared.child.id, nextState: exactPrepared.child }]),
            { runId: exactPrepared.parent.id, nextState: exactPrepared.parent },
          ],
          value: exactPrepared.value,
        });
      },
    });
    return aggregate.kind === 'committed' ? aggregate.value : aggregate;
  }

  /**
   * Resolve the target, run target policy, and drive the state machine for a
   * pass/fail transition.
   *
   * @param input - Command, caller evidence, target selector, and terminal policy.
   *   Steps are derived in-seam via the injected `loadSteps` dependency, not taken
   *   as an input.
   * @returns A typed refusal or an `applied` outcome carrying observation events
   *   and a loop-continuation directive. A claim-shaped target that the caller
   *   did not present refuses `claim_bearer_mismatch` before anything resolves.
   * @throws {Error} When state is stale/mismatched, the machine dispatch fails,
   *   a persisted completion does not match the active cursor, or an explicit
   *   `--step` / `--index` target cannot be satisfied by the state captured
   *   under the execution lease — the fail-closed staleness refusal is raised
   *   inside the fenced preparation by the in-fence cursor derivation (step
   *   mismatch), not by pre-capture re-validation.
   */
  async runTransition(input: LifecycleTransitionInput): Promise<LifecycleTransitionOutcome> {
    const { sessionService } = this.#deps;
    // `targeted` derives from the presence of an explicit step target, never
    // from the selector kind alone (decision 3): `pass --claim-id <id> --step
    // <n>` is targeted (the sanctioned operator recovery, exempt from the
    // collection guards) while a bare-shaped advance with only target selection
    // is not and stays guarded.
    const targeted = input.explicitTarget !== undefined;
    // A claim-shaped target is reconciled against the caller's evidence before
    // anything is resolved from it, so the claim id below is always the bearer
    // the caller presented (#613).
    const claimMismatch = reconcileClaimTarget(input.callerEvidence, input.targetSelector);
    if (claimMismatch) return claimMismatch;
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
          // Sound because the entry reconciliation already refused any
          // divergence: `target.claimId` IS the presented bearer, so this
          // context is the caller's own verified claim, not the target's.
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
    // fails. The recorder is total and commits its own session transaction, and
    // no transaction is open across this call, so failure cannot block or mask
    // the mutation (RD-102).
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
    // FOR bounds, frame construction) happens inside #driveSubstepFenced,
    // against the state captured under the execution lease.
    if (input.targetSelector.kind === 'explicit-step' && input.explicitTarget === undefined) {
      throw new Error('Explicit-step transition requires an explicit target');
    }

    const terminalReleaseMode: LifecycleTerminalReleaseMode =
      ready.kind === 'claim' ? 'release-runbook' : 'stack-pop';
    // Every resolution shape is guarded by the in-transaction open-children
    // re-check, with one exemption this expression actually applies: a
    // delegated-child bearer. Stated as an exemption rather than as an
    // enumeration of guarded shapes because that is the rule — and because
    // enumerating would re-test `kind === 'claim'` inside a branch reachable
    // only when it holds, an equivalent mutant no test can distinguish.
    //
    // `!targeted` restates an exemption enforced elsewhere: `#drive` routes an
    // explicit target to `#driveSubstepFenced` with a hardcoded `false`, so the
    // value computed here is discarded exactly when the conjunct would matter.
    // Kept as a statement of the rule where the rule is described, not as the
    // thing that applies it — `#drive` is where an explicit target stops being
    // guarded.
    //
    // A run-control claim is guarded too, and is in practice the arm that
    // matters: on a delegation-exposed run a bare mutation is refused
    // ACTOR_CONTEXT_REQUIRED and `--run` cannot carry a bearer, so `--claim-id`
    // is the only invocation the post-R1 protocol leaves an orchestrator.
    // Guarding only the bare/run shapes would guard the arms an orchestrator
    // cannot reach and leave the prescribed one unguarded (#700).
    //
    // RD-819-DEPENDENT: guardOpenChildren.
    // Enumerated at the RD-819 guard in `delegation-service.ts`.
    //
    // A delegated-child bearer is exempt, mirroring the pre-check exemption in
    // `resolveTransitionTarget`. That is a coincidence of two independent rules,
    // not an authority decision, and it evaporates the day the nested
    // prohibition moves.
    //
    // FALSE HERE SUPPRESSES THREE CHECKS, not one — `#runGuardedOrPlain` routes
    // to `unguarded()`, skipping everything `runGuardedParentAdvance` does. All
    // three are empty for a delegated child, but by two different mechanisms,
    // and enumerating them is the point: the exemption is sound only while every
    // one of them stays empty.
    //   1. The open-children pre-check and 3. the in-transaction guard both read
    //      `claims WHERE parent_run_id = <target>`. A delegated child can never
    //      be a delegation parent — RD-819 refuses nested delegation — so the
    //      set is provably empty.
    //   2. The `delegation_collection_pending` re-check reads delegation-outcome
    //      facts off the target's OWN state
    //      (`readDelegationCollectionPendingForPolicy`). Same rule, different
    //      mechanism: a run that cannot issue a delegation has no outcome to
    //      collect, so `pending` is always false. Called out because the
    //      claims-set argument above does not cover it, and a reader who checks
    //      only that argument would find this exemption unjustified.
    const guardOpenChildren =
      !targeted && !(ready.kind === 'claim' && isDelegatedChildClaim(ready.claim));

    // Single resolution: derive the resolved run's steps in-seam from its
    // in-memory state, rather than taking `steps` as an input that would force the
    // frontend to resolve the target first (a redundant run-state read).
    const steps = await this.#deps.loadSteps(ready.state);

    const { delegationRuntime } = transitionDelegationRuntime(actorContext, ready.state.id);
    const outcome = await this.#drive(
      input,
      steps,
      ready.state,
      terminalReleaseMode,
      guardOpenChildren,
      delegationRuntime?.issueDelegationCredential,
    );
    // Equivalent mutant on the third conjunct: forcing it false skips the early
    // return and yields `{ ...outcome, delegationRuntime: undefined }` instead of
    // `outcome` untouched. Those differ only in whether the KEY is present — the
    // value is `undefined` either way — and no consumer observes key presence:
    // all ten read the value (`.delegationRuntime`,
    // `?.issueDelegationCredential`), none uses `in` or `Object.hasOwn`. The
    // opposite direction IS killed, by "carries the delegation runtime for a
    // bearer holding delegate-from-run".
    // Stryker disable ConditionalExpression: equivalent — absent key and undefined value are indistinguishable to every consumer
    if (
      outcome.kind !== 'applied' ||
      outcome.loop.kind !== 'run' ||
      delegationRuntime === undefined
    ) {
      // Stryker restore ConditionalExpression
      return outcome;
    }
    return { ...outcome, delegationRuntime };
  }

  /**
   * Resolve the target, run terminal policy, and force a run (or an inline chain)
   * terminal for a complete/stop command.
   *
   * @param input - Command, caller evidence, target selector (default/claim), and
   *   optional message.
   * @returns A typed refusal or an `applied_claim` / `applied_bare` outcome. A
   *   claim-shaped target that the caller did not present refuses
   *   `claim_bearer_mismatch` before the claim is resolved.
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
    // Same entry reconciliation as the other two seams, in the same shape and
    // ahead of the dispatch: the forced claim is the bearer the caller
    // presented, never a divergent selector value that would force (and
    // release) a run on the target's own authority (#613).
    const claimMismatch = reconcileClaimTarget(input.callerEvidence, input.targetSelector);
    if (claimMismatch) return claimMismatch;
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
   *   run, its steps, and the terminal release mode. A claim-shaped target that
   *   the caller did not present refuses `claim_bearer_mismatch`.
   * @throws {Error} When an `explicit-step` selector is supplied (the
   *   navigation target is goto's positional argument, not a selector).
   */
  async resolveRunNavigation(input: LifecycleNavigationInput): Promise<LifecycleNavigationOutcome> {
    const selector = input.targetSelector;
    if (selector.kind === 'explicit-step') {
      throw new Error('goto does not support --step run targeting');
    }

    // Same entry reconciliation as the mutating seams. Navigation needs it just
    // as much: without it a claim-shaped target derives a verified actor
    // context from the TARGET's claim, which both authorizes a divergent
    // presenter and satisfies the run-navigation role gate (#613).
    const claimMismatch = reconcileClaimTarget(input.callerEvidence, selector);
    if (claimMismatch) return claimMismatch;

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
        return {
          kind: 'stale_claim',
          claimId: resolution.claimId,
          message: resolution.message,
          code: resolution.code,
        };
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

    const presenterAuthority =
      input.callerEvidence.kind === 'claim_bearer'
        ? await this.#resolveMutationActorContext({
            callerEvidence: input.callerEvidence,
            targetState: state,
            request: { action: 'mutate-run', runId: state.id },
            intent: 'run-navigation',
          })
        : undefined;
    const presenterAuthorized = presenterAuthority?.kind === 'verified';

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
        : presenterAuthority?.kind === 'verified'
          ? presenterAuthority.actorContext
          : UNKNOWN_ACTOR_CONTEXT;

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

    if (input.callerEvidence.kind === 'claim_bearer' && presenterAuthorized) {
      await this.#deps.sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    return {
      kind: 'allowed',
      runId: state.id,
      state,
      steps: await this.#deps.loadSteps(state),
      terminalReleaseMode: resolution.kind === 'claim' ? 'release-runbook' : 'stack-pop',
      // Navigation can land the cursor ON a DELEGATE frontier, so the same
      // run-control gate applies: the issuer follows `delegate-from-run`, not
      // the `mutate-run` grant that authorized the navigation.
      ...transitionDelegationRuntime(actorContext, state.id),
    };
  }

  /**
   * Apply an authorized GOTO through core-owned execution fencing.
   *
   * @param input - Selected run, caller evidence, parsed steps, and validated target.
   * @returns Applied transition data or a typed capture/execution refusal.
   * @throws {Error} When a committed mutation has no captured previous state.
   */
  async runNavigationMutation(
    input: LifecycleNavigationMutationInput,
  ): Promise<LifecycleNavigationMutationOutcome> {
    let previousState: RunbookState | undefined;
    const result = await this.#deps.actorMutationRunner.run({
      runId: input.runId,
      ...(input.callerEvidence.kind === 'claim_bearer'
        ? { claimKey: claimKeyFromBearer(input.callerEvidence.claimId) }
        : {}),
      makeRecoveryActor: (state) => this.#deps.actorService.createRecoveryActor(state, input.steps),
      compute: async (capturedState) => {
        previousState = capturedState;
        const prepared = await this.#deps.actorService.prepareActorMutation(
          capturedState.id,
          previousState,
          input.steps,
          { type: 'GOTO', target: input.target },
          { issueDelegationCredential: input.issueDelegationCredential },
        );
        return { ...prepared, previousState };
      },
    });
    if (result.kind !== 'committed') return result;
    if (previousState === undefined) {
      throw new Error('Fenced GOTO committed without a captured previous state');
    }
    return {
      kind: 'applied',
      runId: input.runId,
      previousState,
      updatedState: result.value.state,
      snapshot: result.value.snapshot,
      steps: input.steps,
      terminalReleaseMode: input.terminalReleaseMode,
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
        return {
          kind: 'stale_claim',
          claimId: resolution.claimId,
          message: resolution.message,
          code: resolution.code,
        };
      case 'terminal_claim_confirmed': {
        // Idempotent no-op: child already terminal. Still release with retain so a
        // later --claim-id can confirm/conflict again (item 4, second site).
        // The resolver verified and authorized the bearer before confirming the
        // prior terminal outcome, so the presentation still proves liveness.
        if (input.callerEvidence.kind === 'claim_bearer') {
          await sessionService.recordClaimSeen(input.callerEvidence.claimId);
        }
        const release = await sessionService.releaseRunbook(resolution.state.id, {
          retainClaimsAsTerminal: true,
        });
        if (release.kind !== 'committed') return release;
        return {
          kind: 'terminal_claim_confirmed',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          command: resolution.command,
        };
      }
      case 'terminal_claim_conflict': {
        // A confirmed terminal conflict is also post-authorization evidence from
        // the claim's holder, despite refusing the requested terminal result.
        if (input.callerEvidence.kind === 'claim_bearer') {
          await sessionService.recordClaimSeen(input.callerEvidence.claimId);
        }
        const release = await sessionService.releaseRunbook(resolution.state.id, {
          retainClaimsAsTerminal: true,
        });
        if (release.kind !== 'committed') return release;
        return {
          kind: 'terminal_claim_conflict',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          expectedCommand: resolution.expectedCommand,
          requestedCommand: resolution.requestedCommand,
        };
      }
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
    const isRunControlClaim = !isDelegatedChildClaim(resolution.claim);
    if (isRunControlClaim) {
      return this.#driveTerminalBare(input, state);
    }

    // `resolveTerminalTarget` verified the bearer and its mutate-run grant.
    // Observe that holder before dispatch; the recorder commits its own session
    // transaction with none open across this call, and it is total, so it cannot
    // mask a later terminal failure (RD-102).
    if (input.callerEvidence.kind === 'claim_bearer') {
      await sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    // A delegated child's ONLY route back to its parent is this bearer's
    // report grant, and that grant must match the child's persisted delegation
    // linkage on every coordinate. Two gates upstream — the six-field
    // `linkageMatchesClaim` in `getActiveForClaimId` and `SessionDataSchema`,
    // which requires a matching `report-delegation-result` grant on every claim
    // read — make a divergence unreachable for a loadable session. If one ever
    // arrives anyway, refuse with the same shape the missing-grant arm returns
    // instead of forcing the child terminal with nothing to report: closing it
    // would burn the last actor able to report and strand the parent's substep
    // forever, whereas refusing leaves a running child an operator can prune.
    //
    // Narrow the LINKAGE rather than reading a field off it behind `?.`. The
    // predicate's own first statement is `linkage?.kind !== 'delegation' →
    // false`, so its true arm already proves `parentLinkage` is a
    // `DelegationLinkage`; an optional chain here could never short-circuit and
    // was dead syntax that TypeScript — which cannot narrow through a `boolean`
    // return — nonetheless demanded. Binding the linkage and refusing on it
    // carries that proof in the types instead, at no runtime cost: the guard
    // below is the same single refusal, just keyed on the value the branch
    // actually established.
    const linkage = claimCanReportDelegationResult(resolution.claim, state)
      ? state.parentLinkage
      : undefined;
    if (linkage === undefined) {
      return { kind: 'claim_grant_required', claimId, runId: state.id };
    }
    const parentRunId = linkage.parentRunId;
    const targets = [
      {
        runId: state.id,
        claimKey: claimKeyFromBearer(claimId),
      },
      // The report is opportunistic: a delegating parent that holds no
      // controlling claim of its own still must not veto closing this child.
      { runId: parentRunId, optional: true },
    ];
    const { stepsByRun, stepsFor } = this.#createStepsMemo();
    for (const target of targets) {
      const targetState =
        target.runId === state.id ? state : await this.#deps.loadRun(target.runId);
      if (targetState !== undefined) await stepsFor(targetState);
    }
    const eventType = terminalForceEvent(input.command);
    const aggregate = await this.#deps.actorMutationRunner.runAll({
      targets,
      releases: [{ runId: state.id, retainClaimsAsTerminal: true }],
      makeRecoveryActor: (runId, recoveryState) => {
        const recoverySteps = stepsByRun.get(runId);
        if (recoverySteps === undefined) {
          throw new Error(`Missing recovery steps for aggregate run ${runId}.`);
        }
        return actorService.createRecoveryActor(recoveryState, recoverySteps);
      },
      compute: async (captured) => {
        const child = captured.at(0);
        if (child?.state.id !== state.id) {
          throw new Error('Aggregate claimed terminal capture order changed.');
        }
        const childSteps = await stepsFor(child.state);
        const currentStep = this.#findStep(childSteps, child.state.step);
        const prepared = await actorService.prepareActorMutation(
          child.state.id,
          child.state,
          childSteps,
          {
            type: eventType,
            ...(input.message !== undefined ? { message: input.message } : {}),
          },
        );
        const observation = deriveTransitionObservation({
          steps: childSteps,
          currentStep,
          previousState: child.state,
          updatedState: prepared.nextState,
          snapshot: prepared.snapshot,
          result: input.command === 'complete' ? 'pass' : 'fail',
          ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
        });
        let reported: TerminalReportOutcome = 'not-applicable';
        const members = [{ runId: child.state.id, nextState: prepared.nextState }];
        const parent = captured.at(1);
        if (parent !== undefined) {
          const report = completionService.prepareChildCompletion(
            { childState: prepared.nextState },
            parent.state,
          );
          reported = report.kind;
          members.push({
            runId: parent.state.id,
            nextState: report.kind === 'recorded' ? report.nextParentState : parent.state,
          });
        }
        return {
          members,
          value: {
            kind: 'applied_claim' as const,
            runId: child.state.id,
            status:
              prepared.nextState.lifecycle === 'stopped'
                ? ('stopped' as const)
                : ('completed' as const),
            events: observation.events,
            reported,
          },
        };
      },
    });
    return aggregate.kind === 'committed' ? aggregate.value : aggregate;
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
    // observes the holder. It commits its own session transaction with none open
    // across this call; the total write is non-masking.
    if (input.callerEvidence.kind === 'claim_bearer' && presenterAuthorized) {
      await sessionService.recordClaimSeen(input.callerEvidence.claimId);
    }

    if (plan.targetState.lifecycle !== 'running') {
      // Preserve the pre-existing already-terminal outcome for every caller. Clean
      // up for ambient/no-bearer or authorized bearer requests only; an unauthorized
      // bearer receives the same outcome without mutating the resolved chain.
      if (input.callerEvidence.kind !== 'claim_bearer' || presenterAuthorized) {
        const release = await sessionService.releaseRunbooks(plan.releaseRunIds, {
          retainClaimsAsTerminalRunId: plan.targetState.id,
        });
        if (release.kind !== 'committed') return release;
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
    const externalParentRunId = plan.targetState.parentLinkage?.parentRunId;
    const presentedClaim =
      input.callerEvidence.kind === 'claim_bearer'
        ? await sessionService.verifyClaimId(input.callerEvidence.claimId)
        : undefined;
    const controlledRunId =
      presentedClaim?.status === 'verified' ? presentedClaim.claim.controlledRunId : undefined;
    const claimKey =
      input.callerEvidence.kind === 'claim_bearer'
        ? claimKeyFromBearer(input.callerEvidence.claimId)
        : undefined;
    const targets = [
      ...plan.forceOrder.map((member) => ({
        runId: member.id,
        ...(member.id === controlledRunId && claimKey !== undefined ? { claimKey } : {}),
      })),
      // Opportunistic, as in the claim path: the root's own close must not
      // depend on the delegating parent being captured.
      ...(externalParentRunId === undefined ||
      plan.forceOrder.some(({ id }) => id === externalParentRunId)
        ? []
        : [{ runId: externalParentRunId, optional: true }]),
    ];
    const { stepsByRun, stepsFor } = this.#createStepsMemo();
    for (const target of targets) {
      const targetState =
        plan.forceOrder.find(({ id }) => id === target.runId) ??
        (await this.#deps.loadRun(target.runId));
      if (targetState !== undefined) await stepsFor(targetState);
    }
    const aggregate = await this.#deps.actorMutationRunner.runAll<
      Extract<LifecycleTerminalOutcome, { readonly kind: 'already_terminal' | 'applied_bare' }>
    >({
      targets,
      releases: plan.releaseRunIds.map((runId) => ({
        runId,
        retainClaimsAsTerminal: runId === plan.targetState.id,
      })),
      makeRecoveryActor: (runId, recoveryState) => {
        const recoverySteps = stepsByRun.get(runId);
        if (recoverySteps === undefined) {
          throw new Error(`Missing recovery steps for aggregate run ${runId}.`);
        }
        return actorService.createRecoveryActor(recoveryState, recoverySteps);
      },
      beforeEffect: (captured) => {
        const root = captured.find(({ state }) => state.id === plan.targetState.id)?.state;
        if (root === undefined) {
          throw new Error(`Aggregate force-${input.command} did not capture its root run.`);
        }
        return root.lifecycle === 'running'
          ? { kind: 'continue' as const }
          : {
              kind: 'return' as const,
              value: {
                kind: 'already_terminal' as const,
                targetRunId: root.id,
                lifecycle:
                  root.lifecycle === 'stopped' ? ('stopped' as const) : ('completed' as const),
              },
            };
      },
      compute: async (captured) => {
        const events: AttributedTerminalObservation[] = [];
        const forcedRunIds: RunId[] = [];
        const members: { runId: RunId; nextState: RunbookState }[] = [];
        let finalRootState: RunbookState | undefined;

        for (let index = 0; index < plan.forceOrder.length; index += 1) {
          const exact = captured.at(index);
          const planned = plan.forceOrder[index];
          if (exact?.state.id !== planned.id) {
            throw new Error('Aggregate inline force order changed during capture.');
          }
          const nextPlanned = plan.forceOrder.at(index + 1);
          if (
            nextPlanned !== undefined &&
            (exact.state.parentLinkage?.kind !== 'inline' ||
              exact.state.parentLinkage.parentRunId !== nextPlanned.id)
          ) {
            throw new Error('Aggregate inline linkage changed during capture.');
          }
          const steps = await stepsFor(exact.state);
          let nextState = exact.state;
          if (exact.state.lifecycle === 'running') {
            const currentStep = this.#findStep(steps, exact.state.step);
            const prepared = await actorService.prepareActorMutation(
              exact.state.id,
              exact.state,
              steps,
              {
                type: eventType,
                ...(input.message !== undefined ? { message: input.message } : {}),
              },
            );
            nextState = prepared.nextState;
            forcedRunIds.push(exact.state.id);
            const observation = deriveTransitionObservation({
              steps,
              currentStep,
              previousState: exact.state,
              updatedState: nextState,
              snapshot: prepared.snapshot,
              result: input.command === 'complete' ? 'pass' : 'fail',
              ...(input.computeActionResult
                ? { computeActionResult: input.computeActionResult }
                : {}),
            });
            for (const event of observation.events) {
              events.push({ runId: exact.state.id, runbook: exact.state.runbook, event });
            }
          }
          members.push({ runId: exact.state.id, nextState });
          if (exact.state.id === plan.targetState.id) finalRootState = nextState;
        }

        if (finalRootState === undefined || !forcedRunIds.includes(plan.targetState.id)) {
          throw new Error(`Runbook state changed during force-${input.command}.`);
        }
        let reported: TerminalReportOutcome = 'not-applicable';
        const externalParent = captured.at(plan.forceOrder.length);
        if (externalParent !== undefined) {
          await stepsFor(externalParent.state);
          const report = completionService.prepareChildCompletion(
            { childState: finalRootState },
            externalParent.state,
          );
          reported = report.kind;
          members.push({
            runId: externalParent.state.id,
            nextState: report.kind === 'recorded' ? report.nextParentState : externalParent.state,
          });
        }
        return {
          members,
          value: {
            kind: 'applied_bare' as const,
            rootRunId: plan.targetState.id,
            status:
              finalRootState.lifecycle === 'stopped'
                ? ('stopped' as const)
                : ('completed' as const),
            events,
            forcedRunIds,
            reported,
          },
        };
      },
    });
    if (aggregate.kind !== 'committed') return aggregate;
    if (aggregate.value.kind === 'already_terminal') {
      const release = await sessionService.releaseRunbooks(plan.releaseRunIds, {
        retainClaimsAsTerminalRunId: plan.targetState.id,
      });
      if (release.kind !== 'committed') return release;
    }
    return aggregate.value;
  }

  // Resolve the issuance anchor run via the shared `resolveIssuanceAnchor` seam
  // (`--run` > presented claim's controlled run > active default). Frontends
  // pass only raw target syntax; this seam pins the resolved id and owns every
  // state-dependent precondition against the aggregate capture.
  // Takes the issuance `input` directly: both `DelegationIssuanceInput` variants
  // already carry the anchor fields (`callerEvidence` + optional `targetRunId`),
  // so it satisfies `ResolveIssuanceAnchorOptions` structurally and no call site
  // has to pull those fields apart to call it.
  async #resolveIssuanceAnchor(
    options: ResolveIssuanceAnchorOptions,
  ): Promise<IssuanceAnchorResolution> {
    return resolveIssuanceAnchor(this.#deps.sessionService, options);
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
            code: resolution.code,
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
    issueDelegationCredential?: DelegationCredentialIssuer,
  ): Promise<LifecycleTransitionOutcome> {
    const { actorService } = this.#deps;
    const fresh = await actorService.assertFreshState(state.id, steps);
    if (!fresh) {
      throw new Error('Runbook state is stale or mismatched with current definition');
    }
    const activeStep = this.#findStep(steps, state.step);
    const isSubstepCompletion = Boolean(
      state.substep && resolvedStepHasSubsteps(activeStep) && activeStep.substeps.length,
    );
    // An explicit target always routes through the substep span, even when the
    // live cursor is parked on a top-level step — the in-fence resolver refuses
    // targets the captured state cannot satisfy. It never reactivates: naming a
    // substep is a deliberate completion against it, not "advance what I see".
    if (input.explicitTarget !== undefined) {
      return this.#driveSubstepFenced(
        input,
        steps,
        state,
        terminalReleaseMode,
        false,
        input.explicitTarget,
        issueDelegationCredential,
      );
    }
    if (!isSubstepCompletion) {
      return this.#driveTopLevel(
        input,
        steps,
        state,
        terminalReleaseMode,
        guardOpenChildren,
        issueDelegationCredential,
      );
    }
    // A bare transition means "advance the thing currently in front of the
    // operator". When that thing is an already-running inline child, resume
    // it instead of recording a completion against its parent substep.
    const reactivation = await this.#reactivateRunningInlineChild(state);
    if (reactivation) {
      return {
        kind: 'applied',
        runId: state.id,
        mutation: 'manual-completion',
        terminalReleaseMode,
        status: 'continue',
        events: [],
        loop: reactivation,
      };
    }
    return this.#driveSubstepFenced(
      input,
      steps,
      state,
      terminalReleaseMode,
      guardOpenChildren,
      undefined,
      issueDelegationCredential,
    );
  }

  async #driveSubstepFenced(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    activeState: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    guardOpenChildren: boolean,
    explicitTarget?: ExplicitTransitionTarget,
    issueDelegationCredential?: DelegationCredentialIssuer,
  ): Promise<LifecycleTransitionOutcome> {
    const { actorService, actorMutationRunner, completionService } = this.#deps;
    let preparedOutcome:
      | {
          readonly events: readonly TransitionObservationEvent[];
          readonly applied: number;
          readonly state: RunbookState;
          readonly terminalStatus?: 'done' | 'stopped';
          readonly duplicate?: { at: string; frameKey: FrameKey; entry: number };
        }
      | undefined;

    const run = (guard?: ParentAdvanceGuard): ReturnType<EffectfulActorMutationRunner['run']> =>
      actorMutationRunner.run({
        runId: activeState.id,
        ...(input.callerEvidence.kind === 'claim_bearer'
          ? { claimKey: claimKeyFromBearer(input.callerEvidence.claimId) }
          : {}),
        ...(guard === undefined ? {} : { guard }),
        terminalRelease: {
          onComplete: input.terminalPolicy.onComplete.releaseRunbook,
          onStopped: input.terminalPolicy.onStopped.releaseRunbook,
          retainClaimsAsTerminal: true,
        },
        makeRecoveryActor: (state) => actorService.createRecoveryActor(state, steps),
        compute: async (capturedState) => {
          const initial = capturedState;
          const cursor =
            explicitTarget === undefined
              ? activeCursor(initial)
              : resolveManualCompletionCursor(steps, initial, explicitTarget);
          if (!cursor.substep) {
            throw new Error('Substep completion requires an active or explicit substep target');
          }
          const record = completionService.prepareManualCompletion({
            runbookId: initial.id,
            currentState: initial,
            targetStep: cursor.step,
            targetSubstep: cursor.substep,
            ...(cursor.iteration !== undefined ? { targetIteration: cursor.iteration } : {}),
            targetFrame: cursor.frame,
            result: input.command,
            agentId: 'manual',
          });
          const duplicate =
            record.status === 'duplicate'
              ? {
                  at: cursor.at,
                  frameKey: cursor.frame.frameKey,
                  entry: completionEntryForFrame(cursor.frame),
                }
              : undefined;
          const events: TransitionObservationEvent[] = [];
          let state = record.nextState;
          let snapshot: unknown = state.snapshot;
          let effects: PreparedActorMutation['effects'] = [];
          let applied = 0;
          let terminalStatus: 'done' | 'stopped' | undefined;

          for (;;) {
            const currentStep = this.#findStep(steps, state.step);
            if (!resolvedStepHasSubsteps(currentStep) || !state.substep) break;
            // One derivation of the live frame, shared with the drain and the
            // collection-pending guard (#749), so the key this looks up and the
            // cursor the validation narrows against cannot name different entries.
            const frame = deriveActiveCompletionFrame(state);
            const completions = state.resolvedCompletions ?? {};
            const exactKey = buildCompletionKey(frame, state.substep);
            const sentinelKey = buildCompletionKey(inactiveFrame(frame.frameKey), state.substep);
            const current = Object.hasOwn(completions, exactKey)
              ? ([exactKey, completions[exactKey]] as const)
              : Object.hasOwn(completions, sentinelKey)
                ? ([sentinelKey, completions[sentinelKey]] as const)
                : undefined;
            if (current === undefined) break;
            const validated = completionService.validateCurrentCompletion(state, current[1]);
            if ('status' in validated) throw new Error(validated.message);
            const prepared = await actorService.prepareActorMutation(
              state.id,
              state,
              steps,
              {
                type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
                completionKey: current[0],
                completion: validated,
              },
              { issueDelegationCredential },
            );
            const next = prepared.nextState;
            const observation = deriveTransitionObservation({
              steps,
              currentStep,
              previousState: state,
              updatedState: next,
              snapshot: prepared.snapshot,
              result: validated.result,
              ...(input.computeActionResult
                ? { computeActionResult: input.computeActionResult }
                : {}),
            });
            // Same reconciliation as `#driveTopLevel`: the fence releases on the
            // committed `lifecycle`, so a drain pass that carried the run
            // terminal by lifecycle alone must still emit its terminal event and
            // stop the loop, or the caller drains on past a released run.
            const reconciled = reconcileFencedTerminalObservation({
              observation,
              steps,
              currentStep,
              previousState: state,
              updatedState: next,
              snapshot: prepared.snapshot,
              result: validated.result,
            });
            events.push(...reconciled.events);
            applied += 1;
            state = next;
            snapshot = prepared.snapshot;
            effects = [...effects, ...prepared.effects];
            if (reconciled.status !== 'continue') {
              terminalStatus = reconciled.status;
              break;
            }
          }
          preparedOutcome = {
            events,
            applied,
            state,
            ...(terminalStatus === undefined ? {} : { terminalStatus }),
            ...(duplicate === undefined ? {} : { duplicate }),
          };
          return {
            previousState: capturedState,
            nextState: state,
            snapshot,
            effects,
          };
        },
      });

    const fenced = await this.#runGuardedOrPlain(
      guardOpenChildren,
      activeState.id,
      (guard) => run(guard),
      () => run(),
    );
    if (fenced.kind === 'refusal') return fenced.outcome;
    if (fenced.value.kind !== 'committed') return fenced.value;
    if (preparedOutcome === undefined) {
      throw new Error('Fenced substep transition committed without a prepared outcome');
    }
    const drained: SubstepDrainObservation = {
      drainEvents: [...preparedOutcome.events],
      applied: preparedOutcome.applied,
      observedState: preparedOutcome.state,
      terminalStatus: preparedOutcome.terminalStatus,
    };
    return this.#substepOutcome(
      activeState.id,
      terminalReleaseMode,
      drained,
      preparedOutcome.duplicate,
    );
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
    issueDelegationCredential?: DelegationCredentialIssuer,
  ): Promise<LifecycleTransitionOutcome> {
    const { actorService, actorMutationRunner } = this.#deps;
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

    // Guarded: thread the in-transaction guard into the decisive write. Unguarded
    // (explicit-target / claim-authorized): no guarded advance, no guard.
    let previousState: RunbookState | undefined;
    const transitionSteps = steps;
    // One mutation description, optionally armed with the guard — the guarded and
    // plain branches must differ in exactly that and nothing else.
    const run = (guard?: ParentAdvanceGuard): ReturnType<EffectfulActorMutationRunner['run']> =>
      actorMutationRunner.run({
        runId: activeState.id,
        ...(input.callerEvidence.kind === 'claim_bearer'
          ? { claimKey: claimKeyFromBearer(input.callerEvidence.claimId) }
          : {}),
        ...(guard === undefined ? {} : { guard }),
        terminalRelease: {
          onComplete: input.terminalPolicy.onComplete.releaseRunbook,
          onStopped: input.terminalPolicy.onStopped.releaseRunbook,
          retainClaimsAsTerminal: true,
        },
        makeRecoveryActor: (state) => actorService.createRecoveryActor(state, transitionSteps),
        compute: async (capturedState) => {
          previousState = capturedState;
          const prepared = await actorService.prepareActorMutation(
            capturedState.id,
            previousState,
            transitionSteps,
            { type: eventType },
            { issueDelegationCredential },
          );
          return { ...prepared, previousState };
        },
      });

    const sync = await this.#runGuardedOrPlain(
      guardOpenChildren,
      activeState.id,
      (guard) => run(guard),
      () => run(),
    );
    if (sync.kind === 'refusal') return sync.outcome;
    const syncResult = sync.value;
    if (syncResult.kind !== 'committed') {
      return syncResult;
    }
    if (previousState === undefined) {
      throw new Error('Fenced transition committed without a prepared observation context');
    }
    const updatedState = syncResult.value.state;
    const currentStep = this.#findStep(transitionSteps, previousState.step);

    const observation = deriveTransitionObservation({
      steps: transitionSteps,
      currentStep,
      previousState,
      updatedState,
      snapshot: syncResult.value.snapshot,
      result: input.command,
      ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
    });

    // The fence released on `updatedState.lifecycle`; report on the same signal
    // so an `applied` outcome can never claim execution continues on a run this
    // transaction already took off the session stack.
    const reconciled = reconcileFencedTerminalObservation({
      observation,
      steps: transitionSteps,
      currentStep,
      previousState,
      updatedState,
      snapshot: syncResult.value.snapshot,
      result: input.command,
    });

    if (reconciled.status !== 'continue') {
      return {
        kind: 'applied',
        runId: activeState.id,
        mutation: 'run-transition',
        terminalReleaseMode,
        status: reconciled.status,
        events: reconciled.events,
        loop: { kind: 'none' },
      };
    }

    return {
      kind: 'applied',
      runId: activeState.id,
      mutation: 'run-transition',
      terminalReleaseMode,
      status: 'continue',
      events: reconciled.events,
      loop: { kind: 'run', prompted: Boolean(updatedState.prompted) },
      updatedState,
    };
  }

  // Run a parent-advancing write under the open-delegated-children guard when the
  // caller's shape is guarded, or plainly when it is exempt — see
  // `guardOpenChildren` in `runTransition` for which is which (every shape but a
  // delegated-child bearer, since #700). The single place that pairs
  // `runGuardedParentAdvance` with `#guardRefusal`; every guarded decisive write
  // in this service goes through it.
  //
  // Both callbacks are REQUIRED, so the guarded path cannot be skipped by omission
  // — a new call site must write the guarded form and then decide, explicitly, what
  // the unguarded one does. And a `guarded` body that ACCEPTS the guard without
  // threading it into its store write is an `@typescript-eslint/no-unused-vars`
  // error (verified: `'guard' is defined but never used`), so the "guard accepted
  // and silently dropped" shape — which is exactly what the duplicate-drain defect
  // was — fails `check:lint:typed` instead of shipping.
  //
  // What this deliberately does NOT do is recognize a NEW decisive write. A future
  // parent-advancing write that never calls this helper is exactly as unguarded as
  // one that never hand-wrote the branch. That was the duplicate-drain defect's
  // real cause, and no signature prevents it — only noticing that a write advances
  // the parent does.
  async #runGuardedOrPlain<T>(
    guardOpenChildren: boolean,
    parentRunId: RunId,
    guarded: (guard: ParentAdvanceGuard) => Promise<T>,
    unguarded: () => Promise<T>,
  ): Promise<
    | { readonly kind: 'advanced'; readonly value: T }
    | { readonly kind: 'refusal'; readonly outcome: LifecycleTransitionOutcome }
  > {
    if (!guardOpenChildren) {
      return { kind: 'advanced', value: await unguarded() };
    }
    const advance = await this.#deps.sessionService.runGuardedParentAdvance(parentRunId, guarded);
    return this.#guardRefusal(advance, parentRunId);
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

  // Does the parent still carry the one-shot launch intent that named this
  // child? Only an interrupted launch does: the launcher writes the latch
  // (`inline.started`) and consumes the intent in the same continuation, so a
  // launch that ran to completion leaves neither behind. That makes the surviving intent the exact
  // discriminant for "this launch is unfinished", and it is the same value the
  // launch seam re-projects, so the two agree by construction rather than by a
  // second rule about what "interrupted" means.
  #hasUnconsumedInlineLaunchIntent(parentState: RunbookState, childRunId: RunId): boolean {
    const context = (parentState.snapshot as { readonly context?: Partial<RunbookContext> } | null)
      ?.context;
    const intent = context?.inlineLaunchIntent;
    return isInlineLaunchIntentWithoutParentEntry(intent) && intent.childRunId === childRunId;
  }

  // Resume the active substep's running inline child when its linkage matches the
  // parent cursor, pushing it onto the session if it is not already active.
  // Returns the seam's loop directive for the parent, or `undefined` when there
  // was no child to reactivate (caller then records the completion as usual).
  async #reactivateRunningInlineChild(
    parentState: RunbookState,
  ): Promise<LifecycleLoopDirective | undefined> {
    const childRunId = this.#findRunningInlineChildRunId(parentState);
    if (!childRunId) return undefined;

    const childState = await this.#deps.loadRun(childRunId);
    if (childState?.lifecycle !== 'running') return undefined;
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
      return undefined;
    }

    const active = await this.#deps.sessionService.getActive();
    if (active?.id !== childRunId) {
      await this.#deps.sessionService.pushRunbook(childRunId);
    }
    // An unfinished launch needs the parent's own loop to finish it: taking the
    // latch — writing `inline.started`, or reclaiming it from an owner that
    // died holding it — consuming the intent and re-establishing the child's
    // run-control authority are Category-A continuation work the launch seam
    // owns, and nothing else reaches it. A launch that already finished has
    // none of that left to do, so running the loop there would only re-enter an
    // execution unit the parent never left — re-announcing the step and
    // re-running any command it carries.
    return this.#hasUnconsumedInlineLaunchIntent(parentState, childRunId)
      ? { kind: 'run', prompted: Boolean(parentState.prompted) }
      : { kind: 'none' };
  }

  // Per-run step memo shared by both aggregate terminal paths. The map is what
  // `makeRecoveryActor` reads to rebuild an interrupted member's graph, and the
  // accessor is what preparation uses, so a run's steps are parsed at most once
  // however the two interleave.
  #createStepsMemo(): {
    readonly stepsByRun: Map<RunId, readonly ResolvedStep[]>;
    readonly stepsFor: (target: RunbookState) => Promise<readonly ResolvedStep[]>;
  } {
    const stepsByRun = new Map<RunId, readonly ResolvedStep[]>();
    return {
      stepsByRun,
      stepsFor: async (target) => {
        const cached = stepsByRun.get(target.id);
        if (cached !== undefined) return cached;
        const loaded = await this.#deps.loadSteps(target);
        stepsByRun.set(target.id, loaded);
        return loaded;
      },
    };
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
