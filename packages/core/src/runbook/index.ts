export type * from './types.js';
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
export { resolveCurrentExecutionUnit } from './execution-units.js';
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
  isRunId,
  RUN_ID_PATTERN,
  RUN_ID_PREFIX,
  type RunId,
} from './run-id.js';
export * from './claim-id.js';
export * from './last-action.js';
export * from './transition-kernel.js';
export {
  generateRunId,
  RunbookStateManager,
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
  type InlineForceTerminalKind,
  type ReleaseRunbookResult,
  type ReleaseRunbooksResult,
  type RunningStackMemberResolution,
  type UnstashForClaimIdResult,
} from './session-service.js';
export {
  resolveCommandTarget,
  resolveTerminalTarget,
  resolveTransitionTarget,
  type CommandTargetResolution,
  type ResolveCommandTargetOptions,
  type ResolveTransitionTargetOptions,
  type TerminalCommandName,
  type TerminalTargetResolution,
  type TransitionCommandName,
  type TransitionTargetResolution,
} from './command-target-resolver.js';
export {
  UNKNOWN_ACTOR_CONTEXT,
  actorContextFromEvidence,
  claimControllerContext,
  trustedRunControllerContext,
  type ActorContext,
  type CallerEvidence,
  type EffectiveRole,
  type EvidenceTarget,
} from './actor-context.js';
export {
  classifyDelegationExposure,
  type DelegationExposure,
  type DelegationExposureInput,
} from './delegation-exposure.js';
export {
  COLLECT_REQUIRES_ORCHESTRATOR_MESSAGE,
  deriveEffectiveRole,
  resolveCommandIntent,
  type CommandIntent,
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
  SUBPROCESS_MUTATION_WITHHELD_CODE,
  type GlobalValueTakingOptionName,
  type PassFailValueTakingOptionName,
  type RoleSpecificMutationCommand,
} from './subprocess-mutation-boundary.js';
export { readActiveRunScope, type ActiveRunScope } from './session-reader.js';
export { ExecutionLifecycleService } from './execution-lifecycle-service.js';
export {
  RunbookCompletionService,
  brandCurrentCursorResolvedCompletionForTest,
  lifecycleToDelegationOutcome,
  // Deprecated alias kept on the public surface for callers still on generic
  // result terminology; the re-export itself must not trip no-deprecated.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  lifecycleToResult,
  type AppliedResolvedCompletion,
  type CompletionTargetMismatch,
  type CurrentCursorResolvedCompletion,
  type DrainResolvedCompletionsArgs,
  type DrainResolvedCompletionsResult,
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
export {
  RunbookLifecycleCommandService,
  type AttributedTerminalObservation,
  type DelegationIssuanceInput,
  type DelegationIssuanceOutcome,
  type FindDelegationByToken,
  type LifecycleLoopDirective,
  type LifecycleTerminalInput,
  type LifecycleTerminalOutcome,
  type LifecycleTerminalReleaseMode,
  type LifecycleTerminalReleasePolicy,
  type LifecycleTransitionInput,
  type LifecycleTransitionOutcome,
  type PersistIssuedSubstep,
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
  type RunbookActorServiceOptions,
} from './actor-service.js';
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
export {
  DELEGATION_CLAIM_MARKER,
  DELEGATION_TOKEN_PATTERN,
  DELEGATION_TOKEN_HASH_PATTERN,
  assertDelegationTokenHash,
  findDelegationClaimToken,
  generateDelegationToken,
  hashDelegationToken,
  isDelegationToken,
  isDelegationTokenHash,
  truncateDelegationToken,
  TOKEN_PREFIX as DELEGATION_TOKEN_PREFIX,
  type DelegationTokenHash,
} from './delegation-token.js';
export {
  DelegationLock,
  DelegationLockTimeoutError,
  type DelegationLockLike,
} from './delegation-lock.js';
export {
  CompletionLock,
  CompletionLockTimeoutError,
  type CompletionLockLike,
} from './completion-lock.js';
export { SessionLock, SessionLockTimeoutError } from './session-lock.js';
export { FileLockTimeoutError, heldLock, heldLockSync } from './file-lock.js';
export type { ScopedLock, ScopedLockSync } from './file-lock.js';
export {
  openVerifiedRegularFile,
  openVerifiedRegularFileSync,
  readVerifiedUtf8File,
  readVerifiedUtf8FileSync,
  UnsafeFileError,
  type UnsafeFileReason,
} from './safe-fs.js';
export { DelegationScanService, type TokenScanResult } from './delegation-scan.js';
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
