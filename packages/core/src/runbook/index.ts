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
// `RenderedUnitCommand` is deliberately absent. Its brand is a module-private
// `declare const` unique symbol, so the only way to produce one outside its
// module is a type assertion — and an assertion needs the type's NAME in scope.
// ESLint bans the assertion syntaxes; withholding the name from the barrel is
// what makes them unwritable outside core in the first place, closing the alias
// and namespace-qualified spellings no selector can enumerate. Nothing outside
// core needs it: the value travels on `ExecutionUnitRunnable.command`, which
// callers destructure rather than annotate.
export type {
  DeriveExecutionUnitEntryInput,
  ExecutionUnitAwaiting,
  ExecutionUnitEntry,
  ExecutionUnitRunnable,
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
export * from './duration.js';
export * from './last-action.js';
export * from './run-secrets.js';
export * from './transition-kernel.js';
// The conditional-write vocabulary is public so a front end narrows the store's
// own result union (`saveRun` / `RunbookStateManager.save`) rather than
// re-declaring it, and names the version it read a run at.
export type {
  DeleteRunResult,
  LeaseRefusingSaveResult,
  RunAtVersion,
  RunWriteAtVersion,
  SaveRunResult,
  SaveRunsResult,
  VersionedRunState,
} from './storage/runbook-store.js';
export {
  inlineDescendantsOf,
  planRunDeletions,
  refuseDeletionUnderLease,
  type RunDeletion,
} from './run-deletion.js';
// Prune protection (#906): one rule for every pruning caller.
export {
  CURRENT_CHILD_PROTECTED_CODE,
  childProtection,
  planPrune,
  type ChildProtection,
  type CurrentChildProtectedRefusal,
  type LoadSteps,
  type PlannedDeletion,
  type PrunePlan,
  type PrunePlanInput,
  type PruneRetentionReason,
  type PruneSelection,
  type RetainedRun,
} from './run-pruning.js';
// The human escape hatch (#906): `rundown stop --run`, interactive and audited.
export {
  NOT_A_TOP_LEVEL_RUN_CODE,
  childRunRemedy,
  resolveHumanStopTarget,
  stopByHuman,
  type ChildRunContext,
  type HumanStopDeps,
  type HumanStoppedRun,
  type HumanStopOutcome,
  type HumanStopTargetRefusal,
  type HumanStopTargetResolution,
  type RunLookup,
} from './human-stop.js';
export { assertStateVersion, type StateVersion } from './storage/mutation-result.js';
export {
  applyRunbookStateUpdate,
  generateRunId,
  RunbookStateManager,
  type CreateOptions,
  type RunbookStateUpdate,
  ConcurrentStateModificationError,
  isConcurrentStateModificationError,
  // Barrelled so a front end's fixtures name the version rather than hard-code a
  // literal that goes stale silently — the #775 defect, in the shape it recurs.
  CURRENT_SCHEMA_VERSION,
  InvalidRunbookStateError,
  ExecutionLeaseHeldError,
  LegacySnapshotError,
} from './state.js';
export {
  applyOp,
  merge,
  replace,
  type FrameEntryCountsOp,
  type MergeOp,
  type ReplaceOp,
  type TemplateVarsOp,
  type VariablesOp,
} from './state-update-ops.js';
// XState-owned Run Progression activation (#851 / ADR 0003). The authority's
// minting function is deliberately NOT exported: only core seams that verified
// caller evidence may produce a RunProgressionAuthority.
export {
  activateRunProgression,
  commitRunProgressionEvent,
  CONCURRENT_MODIFICATION_CODE,
  ObservationDeliveryError,
  progressionDirectiveForStartedRun,
  progressionDirectiveForTerminalRun,
  type CommitRunProgressionEventInput,
  type RunProgressionCommitResult,
  type RunProgressionDeps,
  type RunProgressionDirective,
  type RunProgressionEntryBoundary,
  type RunProgressionFailureReason,
  type RunProgressionOutcome,
  type RunProgressionRecovery,
  type RunProgressionRefusalReason,
  type RunProgressionWaitReason,
} from './run-progression.js';
export type { RunProgressionAuthority } from './run-progression-authority.js';
// Inline Children (#903): the frontend prepares a child runbook for launch;
// core reserves, creates, drives and Collects it.
export { INLINE_CHILD_LAUNCH_FAILED_CODE, MAX_INLINE_CHILD_DEPTH } from './inline-progression.js';
export type {
  ChildRunPreparationRequest,
  PrepareChildRun,
  PreparedChildRun,
} from './child-preparation.js';
export { childResultOf, currentInlineReservation, type ChildResult } from './inline-child.js';
// Delegation (#904): `rundown claim` creates a reserved child by its Claim
// Ticket; `rundown collect` is the lifecycle seam's `runCollect`; status reads
// a run's Delegations. The codes their refusals carry.
export {
  ALREADY_CLAIMED_CODE,
  claimDelegation,
  delegationChildrenStatus,
  DELEGATION_CANCELLED_CODE,
  NOTHING_TO_COLLECT_CODE,
  PARENT_RUN_FINISHED_CODE,
  UNKNOWN_TICKET_CODE,
  type ClaimDelegationOutcome,
  type CollectDelegationsOutcome,
  type DelegationChildStatus,
  type DelegationDeps,
  type DelegationRefusal,
} from './delegation-progression.js';
// Which agent runs `claim` / `release` (#907): the `--agent-id` the command
// carried (stamped by the Claude Code plugin's Bash hook), and whether the
// command runs inside Claude Code (read by the front end).
export {
  AGENT_ID_REQUIRED_CODE,
  type DelegationAgent,
  type DelegationAgentResolution,
  recordedAgentId,
  resolveDelegationAgent,
} from './delegation-agent.js';
// Delegation recovery (#905): `rundown retry` by the parent's owner and
// `rundown release` by the claiming agent; and the Delegations that still
// hold an agent, read by `rundown status --claimed-by` for the plugin's
// SubagentStop gate (#907).
export {
  AGENT_MISMATCH_CODE,
  delegationsHeldBy,
  type HeldDelegation,
  NOT_A_DELEGATION_CODE,
  NOTHING_TO_RETRY_CODE,
  RUN_TARGET_UNAVAILABLE_CODE,
  releaseDelegation,
  type DelegationRecoveryDeps,
  type ReleaseDelegationOutcome,
  type RetriedChild,
  type RetryDelegationOutcome,
} from './delegation-recovery.js';
export type {
  ChildKind,
  ChildLinkage,
  OrphanedDelegationLinkage,
  RunLinkage,
} from './child-linkage.js';
// The DI seam of the two above. Type-only, and exported so their signatures are
// nameable by the CLI that calls them; the liveness readers behind it stay
// internal to core.
export type { ProcessIdentity } from './process-identity.js';
// The execution lease (#902): codes the refusals carry and the classification
// `status` renders. Setting and clearing it — and this process's in-flight
// attempts, which the classification consults — stay inside Run Progression
// and the store.
export {
  classifyExecutionLease,
  EXECUTION_IN_PROGRESS_CODE,
  EXECUTION_INTERRUPTED_CODE,
  type ExecutionCondition,
  type ExecutionInProgressRefusal,
  type ExecutionInterruptedRefusal,
  type ExecutionLease,
  type ExecutionLeaseRefusal,
  refuseUnderLease,
  type LeaseDecision,
} from './execution-lease.js';
export {
  RunbookLifecycleCommandService,
  EXECUTION_PENDING_CODE,
  type ExecutionPendingRefusal,
  type ConcurrentModificationRefusal,
  type LifecycleNavigationInput,
  type LifecycleNavigationCapability,
  type LifecycleNavigationMutationInput,
  type LifecycleNavigationMutationOutcome,
  type LifecycleNavigationOutcome,
  type LifecycleTerminalInput,
  type LifecycleTerminalOutcome,
  type LifecycleTransitionInput,
  type LifecycleTransitionOutcome,
  type RunbookLifecycleCommandServiceDependencies,
  type CommandTargetPurpose,
  type CommandTargetResolution,
  type DelegationStandingRefusal,
  type LifecycleCollectInput,
  type LifecycleCollectOutcome,
  type LifecycleRetryInput,
  type LifecycleRetryOutcome,
  type SettleInlineChild,
  type RunFinishedRefusal,
  type TerminalCommandName,
  type TransitionCommandName,
} from './lifecycle-command-service.js';
export {
  resolveTransitionCursor,
  type ExplicitTransitionTarget,
  type InvalidStepTargetRefusal,
  type TransitionCursor,
  type TransitionCursorResolution,
} from './transition-cursor.js';
export {
  findUnsupportedComposition,
  resolveOwnedRun,
  RunbookCompositionUnsupportedError,
  type FinishedLifecycle,
  type OwnedRun,
  type OwnedRunResolution,
} from './run-authority.js';
export { compileRunbookToMachine, runbookSetup, MAX_FILE_ITERATIONS } from './compiler.js';
export type { RunbookMachine } from './compiler.js';
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
  MachineEffectOutcomeUnknownError,
  RunbookActorService,
  type ActorSyncResult,
  type AnyActorRef,
  type EnterExecutionUnitInput,
  type PreparedActorMutation,
  type RunbookActorServiceOptions,
} from './actor-service.js';
export { inferFrameEntryFromState } from './frame-entry.js';
export type { RunbookEvent } from './compiler.js';
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
export {
  ARTIFACT_INPUT_REQUIRED,
  ArtifactInputRequiredError,
  classifyArtifactAssertionValue,
  collectLaunchDecidableArtifactAssertions,
  findArtifactInputRefusal,
  type ArtifactAssertionShape,
  type ArtifactAssertionShapeFailure,
  type ArtifactInputRequiredSite,
} from './artifact-input-required.js';
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
  type ArtifactInputRequiredDetails,
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
