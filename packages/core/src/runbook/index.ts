export type * from './types.js';
export {
  pipeCommandOutputToStderr,
  stdioForCommandOutput,
  type CommandExecutionStreamOptions,
  type CommandOutputStreamPolicy,
} from './command-stream-policy.js';
export {
  createJsonArrayStream,
  isJsonObject,
  isJsonArray,
  isJsonArrayStream,
  isJsonValue,
  isResolvedVariableForContext,
  assertResolvedVariableForContext,
} from './types.js';
export * from './step-id.js';
export * from './step-utils.js';
export * from './targeting.js';
// Explicit re-export so consumers importing through the package barrel under
// Jest's ESM VM (which does not resolve nested `export *` values) can reach the
// delegation-liveness classifier, matching the DelegationScanService pattern.
export {
  classifyDelegationLiveness,
  type DelegationLiveness,
  type DelegationLivenessLinkage,
  type DelegationLivenessParent,
} from './targeting.js';
// Storage is otherwise internal; the incompatible-schema error is public so the
// CLI can classify it by type and surface the RD-305 envelope.
export { IncompatibleSchemaError } from './storage/schema.js';
// The WAL refusal is public for exactly the same reason, and surfaces RD-306.
// Both fire on EVERY command, read-only ones included, because opening the store
// precedes all of them — so an unclassifiable throw here is an RD-999 / "Unknown
// error" on `rundown status` as readily as on `rundown pass`.
export { WalJournalModeUnavailableError } from './storage/native-sqlite-driver.js';
// Every unreadable-database path ends here — a corrupt file, a directory where
// the database should be, a host without a usable `node:sqlite`. Public so a
// consumer classifying storage failures can use `instanceof` instead of matching
// the class name as a string, which is what the plugin's `rdpath` guard had to
// do while this stayed internal.
// `SqljsUnavailableError` is public for the same reason and travels with it: it
// is the other half of the store-open failure surface (WebContainer takes the
// sql.js path, every other host the native one), so a consumer classifying
// "the database would not open" needs both arms or it still falls through to
// RD-999 on exactly one class of host.
export { NativeSqliteUnavailableError, SqljsUnavailableError } from './storage/driver-factory.js';
// A claim row whose mirrored run-id columns contradict its delegation blob is
// the same kind of surface: it escapes on a session READ, so `rdpath` needs an
// `instanceof` arm or a corrupt row turns a hook invocation whose base directory
// was already supplied into a non-zero exit.
export { InvalidPersistedClaimError } from './storage/runbook-store.js';
// The ownership-refusal result surface is public for the same reason: a CLI
// front end must be able to narrow a session mutation's typed refusal.
export type {
  SessionMutationRefusal,
  SessionMutationResult,
} from './storage/runbook-store.js';
// The optimistic-cycle budget and pacing are public for a narrower reason: a
// front end that owns a read-derive-write span the store cannot hold (an async
// derivation committed by a synchronous session transaction) must re-derive on
// the same budget, and a mirrored constant is where that pacing drifts.
export { DEFAULT_MUTATE_ATTEMPTS, mutateBackoffMs } from './storage/runbook-store.js';
// `GuardedMutationResult` and `AbandonedAttemptSetOutcome` are public for the
// same narrow reason: a CLI renderer must DERIVE the refusal union it renders
// from these rather than re-declaring it. A hand-restatement compiles while
// silently de-branding `RunId`/`ExecutionEpoch` and dropping fields — the
// "no parallel result types" defect the PR 11-head planning audit names.
export type {
  AbandonedAttemptSetOutcome,
  InterruptedAttemptRef,
} from './storage/execution-lease.js';
export {
  assertExecutionEpoch,
  type ExecutionEpoch,
  type GuardedMutationResult,
} from './storage/mutation-result.js';
export {
  extractUnitOutputs,
  findStepOrThrow,
  resolveCurrentExecutionUnit,
} from './execution-units.js';
// The renderer behind the entry seam. `RunbookActorService.enterExecutionUnit`
// is the one production door — it binds the process-scoped dependencies and runs
// the persisted-snapshot guards first — so the bare function is banned from every
// front end's `src/**` by an ESLint no-restricted-imports boundary. It is exported
// for core's own tests and for front-end test doubles, which stand in for the
// service and must not re-implement its rendering.
export { deriveExecutionUnitEntry } from './execution-unit-entry.js';
export type {
  DeriveExecutionUnitEntryInput,
  ExecutionUnitAwaiting,
  ExecutionUnitEntry,
  ExecutionUnitInlineLaunch,
  ExecutionUnitRunnable,
  RenderedUnitCommand,
} from './execution-unit-entry.js';
export {
  buildContextVars,
  buildStepVariables,
  validateForVariables,
  type BuildStepVariablesInput,
  type ExecutionVarValue,
  type StepVariables,
  type TemplateVariables,
} from './runtime-frame.js';
export {
  BUILTIN_RENDER_HELPERS,
  collectUnresolvedRunbookVariables,
  collectUnresolvedVariables,
  expandLoopVariables,
  expandLoopVariablesForCommand,
  isBuiltinRenderHelper,
  resolveForBounds,
  shellEscapeValue,
  substituteRunbookVariables,
  substituteText,
  warnUnresolvedRunbookVariables,
  type HelperDescriptor,
  type TemplateRenderContext,
  type TemplateRenderOptions,
} from './template-renderer.js';
export type {
  HelperArity,
  HelperKind,
  TemplateHelper,
  TemplateHelperRegistry,
} from './helper-invoke.js';
export { RUNBOOK_SOURCES } from './runbook-ref.js';
export {
  assertRunId,
  InvalidRunIdError,
  isRunId,
  RUN_ID_PATTERN,
  RUN_ID_PREFIX,
  type RunId,
} from './run-id.js';
export * from './claim-activity.js';
export * from './claim-id.js';
export * from './duration.js';
export * from './last-action.js';
export * from './session-release.js';
export * from './transition-kernel.js';
// `manual-delegation-machine.js` is deliberately NOT barrelled. Publishing
// `prepareManualDelegation` would invite a front end to drive delegation around
// `RunbookActorService`, which owns the fenced commit — exactly the parallel
// execution path CLAUDE.md forbids. The sanctioned entry point is
// `RunbookActorService.prepareManualDelegationMutation`; its event and result
// types return to this barrel if and when a front end legitimately needs them.
export {
  generateRunId,
  RunbookStateManager,
  ConcurrentStateModificationError,
  isConcurrentStateModificationError,
  InvalidRunbookStateError,
  LegacySnapshotError,
  type SessionData,
} from './state.js';
export {
  applyOp,
  merge,
  replace,
  type FrameEntryCountsOp,
  type MergeOp,
  type ReplaceOp,
  type ResolvedCompletionsOp,
  type TemplateVarsOp,
  type VariablesOp,
} from './state-update-ops.js';
export {
  SessionService,
  type ActiveInlineForceTerminalPlan,
  type ClaimAndInitialLinkInput,
  type ClaimAndInitialLinkResult,
  type RollbackInitialLinkInput,
  type ClaimSeenRecordResult,
  type InlineForceTerminalKind,
  type PopIfActiveResult,
  type PreparedRunControlClaim,
  type PushIfNotActiveResult,
  type ReleaseRunbookResult,
  type ReleaseRunbooksResult,
  type RunningStackMemberResolution,
  type SessionMutationRefusalOutcome,
  type StashActiveResult,
  type StashForClaimIdResult,
  type UnstashForClaimIdResult,
} from './session-service.js';
export {
  describeSupersededClaim,
  resolveClaimTarget,
  resolveCommandTarget,
  resolveMutationAuthority,
  resolveTerminalTarget,
  resolveTransitionTarget,
  type ClaimTargetResolution,
  type CommandTargetResolution,
  type StaleClaimRefusal,
  type StaleClaimRefusalCode,
  type UnknownRunRefusal,
  type ResolveCommandTargetOptions,
  type ResolveTransitionTargetOptions,
  type MutationAuthorityResolution,
  type TerminalCommandName,
  type TerminalTargetResolution,
  type TransitionCommandName,
  type TransitionTargetResolution,
} from './command-target-resolver.js';
export {
  resolveIssuanceAnchor,
  type IssuanceAnchorResolution,
  type ResolveIssuanceAnchorOptions,
} from './issuance-anchor.js';
export {
  UNKNOWN_ACTOR_CONTEXT,
  verifiedClaimContext,
  type ActorContext,
  type CallerEvidence,
  type EffectiveRole,
} from './actor-context.js';
export {
  classifyDelegationExposure,
  classifyDelegationExposureDetail,
  type DelegationExposure,
  type DelegationExposureDetail,
  type DelegationExposureInput,
} from './delegation-exposure.js';
export {
  deriveEffectiveRole,
  resolveCommandIntent,
  type CommandIntent,
  type CollectionWorkflowResult,
  type CommandTargetSelector,
  type DelegationPolicyOutcome,
  type ResolveCommandIntentInput,
} from './command-policy.js';
export {
  bareRoleSpecificMutation,
  delegateClaimIdRejectionMessage,
  delegateClaimIdValidationError,
  mutationCommandAliases,
  subprocessMutationWithheldMessage,
  DELEGATE_CLAIM_ID_REJECTED_CODE,
  GLOBAL_VALUE_TAKING_OPTION_NAMES,
  PASS_FAIL_VALUE_TAKING_OPTION_NAMES,
  SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS,
  SUBPROCESS_MUTATION_WITHHELD_CODE,
  type GlobalValueTakingOptionName,
  type PassFailValueTakingOptionName,
  type RoleSpecificMutationCommand,
} from './subprocess-mutation-boundary.js';
export { readActiveRunScope, type ActiveRunScope } from './session-reader.js';
export { ExecutionLifecycleService } from './execution-lifecycle-service.js';
export {
  createEffectfulActorMutationRunner,
  type EffectfulActorMutationRunner,
  type EffectfulActorMutationRunnerInput,
  type EffectfulActorMutationSetRunnerInput,
  type EffectfulActorMutationSetRunnerResult,
  type EffectfulActorMutationSetTarget,
  type CapturedActorMutationRun,
  type PreparedActorMutationSet,
  type PreparedActorMutationSetMember,
  type AggregateTerminalRelease,
} from './effectful-actor-mutation-runner.js';
export {
  RunbookCompletionService,
  brandCurrentCursorResolvedCompletionForTest,
  lifecycleToDelegationOutcome,
  projectDelegationTerminalOutcome,
  // Deprecated alias kept on the public surface for callers still on generic
  // result terminology; the re-export itself must not trip no-deprecated.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  lifecycleToResult,
  type AppliedResolvedCompletion,
  type CompletionTargetMismatch,
  type CurrentCursorResolvedCompletion,
  type DelegationTerminalProjection,
  type ApplyNextResolvedCompletionArgs,
  type ApplyNextResolvedCompletionResult,
  type RecordChildCompletionArgs,
  type RecordCompletionResult,
  type RecordManualCompletionArgs,
} from './completion-service.js';
export {
  RunbookCollectionService,
  collectDelegationOutcomes,
  type CollectDelegationOutcomesInput,
  type CollectDelegationOutcomesOperationInput,
  type RunbookCollectionServiceDependencies,
} from './collection-service.js';
// Shared re-entry frontier seam (F6). Consumed by `collectDelegationOutcomes`
// above and by the CLI execution loop, which is why it is exported.
export {
  prepareReEntryFrontierConsume,
  projectAndConsumeReEntryFrontier,
  readPersistedReEntryFrontier,
  type PrepareReEntryFrontierActorService,
  type PrepareReEntryFrontierConsumeInput,
  type PreparedReEntryProjection,
  type ProjectAndConsumeReEntryFrontierInput,
  type ReEntryFrontierActorService,
  type ReEntryProjection,
} from './re-entry-frontier.js';
export {
  propagateTerminalChildUpward,
  INLINE_PARENT_CYCLE_CODE,
  MAX_INLINE_PROPAGATION_CHAIN,
  type AdvanceInlineParent,
  type AdvanceInlineParentInput,
  type AdvanceInlineParentOutcome,
  type InlineParentAdvanceSessionService,
  type InlineParentAdvanceStateReader,
  type InlineUpwardPropagationResult,
  type LinkageCycleTrip,
  type PropagateTerminalChildUpwardDeps,
  type TerminalUpwardPropagationResult,
} from './inline-parent-advance.js';
export {
  classifyInlineLaunchOwnership,
  recordInlineLaunchStart,
  type InlineLaunchOwnership,
} from './inline-launch-start.js';
// The DI seam of the two above. Type-only, and exported so their signatures are
// nameable by the CLI that calls them; the liveness readers behind it stay
// internal to core.
export type { ProcessIdentity } from './process-identity.js';
export {
  RunbookLifecycleCommandService,
  type AttributedTerminalObservation,
  type DelegationIssuanceInput,
  type DelegationIssuanceOutcome,
  type ExplicitDelegationTarget,
  type FindDelegationsByTokenHash,
  type DelegationAbortOutcome,
  type LifecycleLoopDirective,
  type LifecycleNavigationInput,
  type LifecycleNavigationMutationInput,
  type LifecycleNavigationMutationOutcome,
  type LifecycleNavigationOutcome,
  type LifecycleTerminalInput,
  type LifecycleTerminalOutcome,
  type LifecycleTerminalReleaseMode,
  type LifecycleTerminalReleasePolicy,
  type LifecycleTransitionInput,
  type LifecycleTransitionOutcome,
  type ResolveChildRunbook,
  type RetryLocator,
  type RunbookLifecycleCommandServiceDependencies,
  type TerminalReportOutcome,
} from './lifecycle-command-service.js';
export {
  resolveManualCompletionCursor,
  type ExplicitCompletionCursor,
  type ExplicitTransitionTarget,
  // Deprecated alias kept on the public surface: `manualTarget` was removed
  // from LifecycleTransitionInput (#500) but the published type name is
  // retained. The re-export itself must not trip no-deprecated.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  type ManualCompletionCursor,
} from './manual-completion-cursor.js';
export { compileRunbookToMachine, runbookSetup, MAX_FILE_ITERATIONS } from './compiler.js';
export type { RunbookMachine } from './compiler.js';
export { runRetryHook } from './retry-hook.js';
export type { RetryHookResult, RetryHookSuccess, RetryHookError } from './retry-hook.js';
export {
  executeCommand,
  executeCommandWithPolicy,
  executeCommandWithEnv,
  POLICY_DENIED_EXIT_CODE,
  type ExecutionResult,
  type PolicyExecutionOptions,
} from './executor.js';
export { renderRunbook, renderStep } from './renderer/renderer.js';
export {
  renderArtifactValue,
  renderArtifactPathValue,
  renderArtifactRecordValue,
  renderLiteralArtifactPath,
  type RenderArtifactOptions,
} from './renderer/artifact-helper.js';
export { evaluateFailCondition, evaluatePassCondition } from './transition-handler.js';
export { createFileProvider, computeFileSnapshot, validateFileSnapshot } from './file-provider.js';
export type { FileProvider } from './file-provider.js';
export { resolveForValue, ForResolutionError, type ResolvedIteration } from './source-resolver.js';
export {
  // Deprecated inference helpers (superseded by resolveDelegationIssuance) are
  // retained on the public surface: @rundown-org/core is published and repo
  // grep cannot rule out external consumers. The re-exports themselves must
  // not trip no-deprecated.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  deriveDelegateFrontier,
  findPendingDelegation,
  inferAllDelegateSubsteps,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  inferDelegationTarget,
  inferRunbookFromStep,
  isPostDelegateAggregationCursor,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  resolveDelegateTarget,
  resolveDelegationIssuance,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  resolveTargetedDelegation,
  type DelegateTargetResolution,
  type DelegationIssuanceRequest,
  type DelegationIssuanceResolution,
  type DelegationInferenceState,
  type InferredDelegation,
  type RequestedRunbookArg,
  type ResolvedDelegationRunbook,
  type ResolveDelegationRunbook,
  type TargetedDelegateResolution,
} from './delegation-inference.js';
export {
  forIterateActor,
  type ForIterateInput,
  type ForIterateOutput,
  type ForResolutionFailureCode,
} from './actors/for-iterate-actor.js';
// The persisted-intent SHAPE guard is public so the CLI's inline-launch latch
// narrows an opaque snapshot through core rather than a local `&&` chain. Core
// drives it from a field-guard map keyed by
// `keyof InlineLaunchIntentWithoutParentEntry`, so adding a field to the intent
// breaks compilation here until the runtime check catches up — a property a copy
// in the CLI would lose the first time the intent grew a field.
export {
  isInlineLaunchIntentWithoutParentEntry,
  type InlineLaunchIntentWithoutParentEntry,
} from './actors/inline-launch-intent-actor.js';
export {
  commandExecActor,
  type CommandExecutionInput,
  type CommandExecutionOutput,
  type CommandExecutionServices,
  type CommandRunnerInput,
  type CommandInternalRunner,
  type CommandExternalRunner,
} from './actors/command-exec-actor.js';
export {
  isRunbookComplete,
  isRunbookStopped,
  asTerminalSnapshot,
  asTerminalSnapshotOrDefault,
} from './snapshot-utils.js';
export {
  extractEnteredArtifacts,
  RunbookActorService,
  type ActorSyncResult,
  type AnyActorRef,
  type EnterExecutionUnitInput,
  type PreparedDelegationChildLink,
  type PreparedDelegationChildUnlink,
  type PrepareDelegationChildLinkResult,
  type PrepareDelegationChildUnlinkResult,
  type RunbookActorServiceOptions,
} from './actor-service.js';
// The runtime capability types ARE public: a front end that owns the CLI
// execution loop threads verified delegation capabilities through its own
// option bags, so it must be able to name them. `DelegationRuntimeCapabilities`
// is the shape those bags should carry — the individual callables remain
// exported for the narrow seams that genuinely take only one.
export type {
  DelegationCredentialIssuer,
  DelegationRuntimeCapabilities,
  DelegationTokenDeriver,
} from './delegation-credential.js';
export { inferFrameEntryFromState } from './frame-entry.js';
export type { RunbookEvent } from './compiler.js';
export {
  createDelegation,
  abortDelegation,
  retryDelegation,
  type DelegateOptions,
  type CreateDelegationResult,
  type CreateDelegationCreatedResult,
  type CreateDelegationStepNotFoundResult,
  type CreateDelegationStepNotCurrentResult,
  type CreateDelegationSubstepRequiredResult,
  type CreateDelegationSubstepNotFoundResult,
  type CreateDelegationExistsResult,
  type AbortDelegationOptions,
  type AbortDelegationResult,
  type AbortDelegationCancelledResult,
  type AbortDelegationAlreadyCancelledResult,
  type AbortDelegationNeedsForceResult,
  type AbortDelegationNotFoundResult,
  type ConsumedDelegationClosureReadModel,
  type RetryDelegationOptions,
  type RetryDelegationResult,
  type RetryDelegationRetriedResult,
  type RetryDelegationNotFoundResult,
  type RetryDelegationNotCurrentResult,
  type RetryDelegationInFlightResult,
  type RetryDelegationErrorResult,
  readConsumedDelegationClosure,
  readConsumedDelegationClosureForCwd,
} from './delegation-service.js';
export {
  DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPending,
  readDelegationCollectionPendingForPolicy,
  readDelegationOutcomeReportedFacts,
  type DelegationCollectionPendingPolicyReadModel,
  type DelegationCollectionPendingReadModel,
  type DelegationOutcomeReportedFact,
} from './delegation-lifecycle-read-model.js';
// Credential *derivation* is not public. `deriveDelegationToken` and the nonce
// primitives around it are reachable only through the claim-bound
// `DelegationCredentialIssuer` / `DelegationTokenDeriver` capabilities above, so
// no consumer can mint or reproduce a bearer without a verified claim.
// `DelegationCredentialDescriptor` stays public because it is the parameter type
// of those two published callables — a caller that cannot name it cannot type
// its own deriver.
export {
  DELEGATION_CLAIM_MARKER,
  DELEGATION_TOKEN_PATTERN,
  DELEGATION_TOKEN_HASH_PATTERN,
  assertDelegationTokenHash,
  findDelegationClaimToken,
  hashDelegationToken,
  isDelegationToken,
  isDelegationTokenHash,
  truncateDelegationToken,
  TOKEN_PREFIX as DELEGATION_TOKEN_PREFIX,
  type DelegationCredentialDescriptor,
  type DelegationTokenHash,
} from './delegation-token.js';
export {
  acquireFileLock,
  FileLockTimeoutError,
  heldLock,
  heldLockSync,
  releaseFileLock,
} from './file-lock.js';
export type { ScopedLock, ScopedLockSync } from './file-lock.js';
export {
  openVerifiedRegularFile,
  openVerifiedRegularFileSync,
  readVerifiedUtf8File,
  readVerifiedUtf8FileSync,
  UnsafeFileError,
  type UnsafeFileReason,
} from './safe-fs.js';
export {
  DelegationScanService,
  type DelegationTokenScan,
  type TokenScanResult,
} from './delegation-scan.js';
export {
  reconstituteContextVars,
  buildContextSnapshot,
  extractInheritedUserVars,
  surfaceIterationBinding,
  MAX_ANCESTOR_DEPTH,
} from './delegation-context.js';
export {
  assembleArtifactPath,
  assembleRunArtifactPath,
  validateArtifactCtx,
  VALID_CTX,
  VALID_FILE,
} from './artifact-paths.js';
export {
  assembleRdPath,
  findRdPathFiles,
  resolveRdPathBaseDir,
  validateRdPathCtx,
  validateRdPathFile,
  type RdPathFindOptions,
  type RdPathOptions,
} from './rdpath.js';
export { ARTIFACT_ERROR_TEXT, formatArtifactManifestLineError } from './artifact-errors.js';
export {
  artifactUriToPath,
  assertConcreteRunId,
  buildArtifactUri,
  parseExactArtifactUriParts,
  parseArtifactUri,
  type ArtifactPathOptions,
  type ArtifactIdentity,
  type ArtifactRef,
  type ExactArtifactRef,
  type SelectorArtifactRef,
} from './artifact-uri.js';
export {
  RUNBOOK_REF_ERROR_TEXT,
  RunbookRefSchema,
  RunbookSourceSchema,
  formatRunbookRef,
  sameRunbookRef,
  type RunbookRef,
  type RunbookSource,
} from './runbook-ref.js';
export {
  ArtifactKeySchema,
  ArtifactManifestRecordSchema,
  FileArtifactRecordSchema,
  ArtifactMetadataSchema,
  ManagedArtifactRecordSchema,
  ArtifactRecordSchema,
  PublicArtifactRecordSchema,
  isArtifactRecord,
  isArtifactValue,
  isPublicArtifactRecord,
  toPublicArtifactMap,
  toPublicArtifactRecord,
  toPublicArtifactVarValue,
  type ArtifactKey,
  type FileArtifactRecord,
  type ArtifactMetadata,
  type ArtifactRecord,
  type PublicArtifactRecord,
  type PublicArtifactVarValue,
} from './artifact-schema.js';
export {
  appendArtifactManifestRecord,
  appendArtifactManifestRecordSync,
  coalesceManifestRecords,
  findArtifactMatches,
  isExistingRegularArtifactFile,
  manifestPathForContext,
  readAllArtifactManifestRecords,
  readArtifactManifest,
  type ArtifactManifestRecord,
  type ArtifactSelectorMatch,
  type FindArtifactOptions,
} from './artifact-manifest.js';
export {
  getArtifactByAlias,
  inspectArtifactReference,
  listArtifactAliases,
  projectArtifactPath,
  projectArtifactUri,
  type ArtifactAliasArrayEntry,
  type ArtifactAliasEntry,
  type ArtifactAliasListEntry,
} from './artifact-service.js';
export {
  resolveArtifactDeclarations,
  type ResolveArtifactDeclarationsOptions,
} from './artifact-directive-resolver.js';
export { extractFileArtifactReferences } from './artifact-reference-extractor.js';
export {
  applyRunArtifactHelper,
  buildExecutionFrame,
  evaluateFrontmatterOutputDeclarations,
  evaluateOutputExpression,
  evaluateStepOutputDeclarations,
  flattenTemplateVars,
  type EvaluateOutputOptions,
  type FlattenedTemplateVars,
  type OutputFrameState,
  type OutputCursor,
  type OutputVars,
} from './output-evaluator.js';
export {
  invokeHelperSafely,
  resetHelperInvokeWarnings,
  resolveTemplateHelperCall,
} from './helper-invoke.js';
export {
  ArtifactChannelError,
  BUILTIN_VARIABLES,
  FileSourcePolicyError,
  RUNTIME_RESERVED_VARIABLES,
  RESERVED_TEMPLATE_HELPER_NAMES,
  VALID_IDENTIFIER,
  createBuiltinVariables,
  detectTemplateHelperCollisions,
  isRuntimeReservedVariable,
  isValidVariableName,
  resolveVariableLayers,
  routeExtraVars,
  buildTemplateVars,
  prepareParsedRunbook,
  partitionVariables,
  withPreparedVariables,
  withRunnableVariables,
  type CreateBuiltinVariablesInput,
  type PrepareParsedRunbookIdentity,
  type PrepareParsedRunbookInput,
  type PrepareParsedRunbookResult,
  type PreparedTemplateVariables,
  type ResolveVariableLayersOptions,
  type ResolvedVariables,
  type RunnableTemplateVariables,
  type VariablePartition,
  type BoundaryChannel,
  type VariableLayer,
  type VariableLayerKind,
  type VariableSecurityContext,
} from './variable-preparation.js';
export {
  mergeEffectiveVars,
  brandInitialTemplateVars,
  brandStoredOutputs,
  brandEffectiveVars,
  isTrustedArtifactRecord,
  isTrustedArtifactArray,
  isTrustedArtifactValue,
  type EffectiveVars,
  type InitialTemplateVars,
  type PublicArtifactValue,
  type RoutedVariableValue,
  type StoredOutputs,
  type TrustedArtifactRecord,
  type TrustedArtifactArray,
  type TrustedArtifactValue,
  type VariableValue,
} from './effective-vars.js';
export {
  deriveOutputScope,
  partitionOutputDeclarations,
  outputsDirForRun,
  outputChannelPath,
  buildOutputChannelEnv,
  prepareOutputChannels,
  readCapturedOutputs,
  type NakedOutput,
  type OutputScope,
  type PrepareOutputChannelsArgs,
  type PreparedChannel,
} from './output-channels.js';
export {
  analyzeForSources,
  collectProducedNames,
  forSourceWarnings,
  type ForSourceFacts,
  type SourcedForFact,
} from './for-source-analysis.js';
