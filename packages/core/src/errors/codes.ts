/**
 * Error categories for Rundown CLI.
 */
export enum ErrorCategory {
  FILE_IO = 'FILE_IO',
  PARSE_SYNTAX = 'PARSE_SYNTAX',
  STATE = 'STATE',
  VALIDATION = 'VALIDATION',
  EXECUTION = 'EXECUTION',
  COMMAND = 'COMMAND',
  AGENT = 'AGENT',
  DELEGATION = 'DELEGATION',
}

/**
 * Error code definition with metadata.
 */
export interface ErrorCodeDefinition {
  /** Unique error code (e.g., 'RD-101') */
  readonly code: string;
  /** Error category */
  readonly category: ErrorCategory;
  /** Short human-readable title */
  readonly title: string;
  /** Detailed description with resolution guidance */
  readonly description: string;
  /**
   * Stable documentation slug for this code (e.g., `'file-not-found'`).
   *
   * **Deliberately has no runtime consumer today, and that is not an
   * oversight — do not "clean it up".** `RundownError` used to render it as
   * `https://rundown.dev/docs/errors/<docSlug>` in `--verbose` text and in the
   * JSON error envelope's `details`. That link was dead for every one of the
   * codes below: `rundown.dev` does not resolve at all, the real site is
   * `rundown.cool` (`site/astro.config.mjs`), and neither host has ever served
   * a `/docs/errors/` route. A URL that has never resolved for any code is
   * worse than no URL, so the field that emitted it was removed.
   *
   * The slug itself survives because it is the durable identifier a future
   * `/docs/errors/` route would key on. Deleting it would be a large mechanical
   * diff with no behavioural benefit, and re-deriving the slugs later would be
   * guesswork. Keep one on every new code, and keep it stable.
   */
  readonly docSlug: string;
}

/**
 * All Rundown error codes.
 */
export const ErrorCodes = {
  // File/IO Errors (1xx)
  FILE_NOT_FOUND: {
    code: 'RD-101',
    category: ErrorCategory.FILE_IO,
    title: 'Runbook file not found',
    description: 'The specified runbook file does not exist or cannot be accessed.',
    docSlug: 'file-not-found',
  },
  FILE_NOT_READABLE: {
    code: 'RD-102',
    category: ErrorCategory.FILE_IO,
    title: 'File not readable',
    description: 'The runbook file exists but cannot be read due to permission restrictions.',
    docSlug: 'file-not-readable',
  },
  STATE_DIR_NOT_ACCESSIBLE: {
    code: 'RD-103',
    category: ErrorCategory.FILE_IO,
    title: 'State directory not accessible',
    description: 'The .rundown directory cannot be accessed or created.',
    docSlug: 'state-dir-not-accessible',
  },

  // Parse/Syntax Errors (2xx)
  EMPTY_RUNBOOK: {
    code: 'RD-201',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Empty runbook file',
    description: 'The runbook file contains no content.',
    docSlug: 'empty-runbook',
  },
  NO_STEPS_FOUND: {
    code: 'RD-202',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'No valid steps found',
    description: 'The runbook file does not contain any valid step headings (## headers).',
    docSlug: 'no-steps-found',
  },
  INVALID_FRONTMATTER: {
    code: 'RD-203',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Invalid frontmatter',
    description: 'The YAML frontmatter is malformed or contains invalid syntax.',
    docSlug: 'invalid-frontmatter',
  },
  SYNTAX_ERROR: {
    code: 'RD-204',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Runbook syntax error',
    description: 'The runbook file contains invalid syntax.',
    docSlug: 'syntax-error',
  },

  // State Errors (3xx)
  NO_ACTIVE_RUNBOOK: {
    code: 'RD-301',
    category: ErrorCategory.STATE,
    title: 'No active runbook',
    description: 'No runbook is currently running. Start a runbook with "rundown run <file>".',
    docSlug: 'no-active-runbook',
  },
  STATE_PARSE_ERROR: {
    code: 'RD-302',
    category: ErrorCategory.STATE,
    title: 'State file parse error',
    description:
      'The runbook state file contains invalid JSON. Try running "rundown prune" to clean up.',
    docSlug: 'state-parse-error',
  },
  RUNBOOK_COMPLETED: {
    code: 'RD-303',
    category: ErrorCategory.STATE,
    title: 'Runbook already completed',
    description: 'This runbook has already been marked as complete. Start a new run.',
    docSlug: 'runbook-completed',
  },
  RUNBOOK_STOPPED: {
    code: 'RD-304',
    category: ErrorCategory.STATE,
    title: 'Runbook stopped',
    description:
      'This runbook was stopped. Start a new run or use "rundown pop" to resume if stashed.',
    docSlug: 'runbook-stopped',
  },
  INCOMPATIBLE_STATE_SCHEMA: {
    code: 'RD-305',
    category: ErrorCategory.STATE,
    title: 'Incompatible runbook database schema',
    description:
      'The runbook database uses a schema version this build cannot read, and Rundown never migrates persisted state. Any in-flight runs are unrecoverable — delete `.rundown/rundown.db` and restart your runbooks from source.',
    docSlug: 'incompatible-state-schema',
  },
  WAL_JOURNAL_MODE_UNAVAILABLE: {
    code: 'RD-306',
    category: ErrorCategory.STATE,
    title: 'Runbook database is not in WAL journal mode',
    description:
      "The runbook database did not enter WAL journal mode. SQLite still serializes cross-process writers through file locking in rollback-journal mode, but that mode does not provide WAL's reader/writer concurrency and is not a validated Rundown deployment mode. SQLite returned a non-WAL mode or no readable mode, which narrows the cause to one of: a filesystem whose VFS provides no shared memory (a network mount such as NFS or SMB is the common one), a temporary database opened with no filename, or a connection already inside a write transaction. A read-only database file or directory is NOT among them — that fails the pragma outright and surfaces as RD-307. Establish which applies before moving the project directory.",
    docSlug: 'wal-journal-mode-unavailable',
  },
  STATE_STORE_UNAVAILABLE: {
    code: 'RD-307',
    category: ErrorCategory.STATE,
    title: 'Runbook database unavailable',
    description:
      'The runbook database at .rundown/rundown.db could not be opened, so commands that access persisted run state cannot continue; commands that do not open the store, such as rundown check, remain available. The driver reports the underlying cause verbatim: a read-only database file or directory, a file that is not a database, lock contention that outlasted the bounded timeout and retries, or a host whose SQLite adapter cannot be initialized. Retry after transient lock contention; repair the host or file for persistent failures. Rundown never downgrades to the single-writer sql.js adapter outside WebContainer.',
    docSlug: 'state-store-unavailable',
  },
  // The THROWN face of the same condition the CLI renders as the symbolic
  // `CONCURRENT_MODIFICATION` code. The two are not duplicates and must not be
  // collapsed: a command that receives `StateMutationResult` narrows the
  // `concurrent_modification` arm and renders it itself (symbolic code), whereas
  // `RunbookStateManager`'s throwing seam escapes to the top-level CLI error
  // wrapper, which only speaks RD-NNN. Before this code that escape was RD-999
  // "Unknown error" — the one surface where the condition was undiagnosable.
  CONCURRENT_STATE_MODIFICATION: {
    code: 'RD-308',
    category: ErrorCategory.STATE,
    title: 'Runbook state lost to a concurrent writer',
    description:
      'A run-state read-modify-write spent its optimistic compare-and-swap budget because another process committed to the same run first. Nothing was written and the persisted state is intact and consistent. Unlike the other 3xx state errors this is transient, not a refusal: re-run the command.',
    docSlug: 'concurrent-state-modification',
  },
  // The ONE persisted-state refusal CLAUDE.md writes a required behaviour for:
  // "The CLI should detect invalid state (via schema version or structural
  // guard) and prompt the user to finish or prune — never silently adapt".
  // Before this code that instruction was unreachable from the error surface,
  // because `InvalidRunbookStateError` and `LegacySnapshotError` — the two
  // classes `RunbookStateManager.load` raises for exactly that detection —
  // reached the CLI wrapper untyped and rendered as RD-999 "Unknown error".
  //
  // NOT RD-305. That code is the whole DATABASE's schema (`PRAGMA user_version`)
  // and its recovery is "delete .rundown/rundown.db"; this is ONE run row inside
  // an otherwise healthy database, where deleting the database would destroy
  // every other run. Nor RD-302, whose title and description name invalid JSON
  // only — one of the four causes here — and still speak of a "state file" that
  // the single-store cutover removed.
  INVALID_PERSISTED_RUN_STATE: {
    code: 'RD-309',
    category: ErrorCategory.STATE,
    title: 'Invalid persisted run state',
    description:
      'A run in the runbook database does not match the state contract this build reads: unparseable persisted state, a schema version other than 1, a missing required field such as templateVars, or a deprecated dynamic-step snapshot. Rundown never migrates persisted state, so the run cannot be resumed and is never silently repaired. Only that run is affected — the database and every other run in it are intact. Recover by finishing the run ("rundown complete"), stopping it ("rundown stop"), or discarding it ("rundown prune --inactive", which a bare "rundown prune" cannot do because its default completed/stopped selection never sees an invalid row), then re-run the runbook from source.',
    docSlug: 'invalid-persisted-run-state',
  },

  // Validation Errors (4xx)
  GOTO_TARGET_NOT_FOUND: {
    code: 'RD-401',
    category: ErrorCategory.VALIDATION,
    title: 'GOTO target not found',
    description: 'The specified step or substep does not exist in the runbook.',
    docSlug: 'goto-target-not-found',
  },
  INVALID_STEP_SEQUENCE: {
    code: 'RD-402',
    category: ErrorCategory.VALIDATION,
    title: 'Invalid step sequence',
    description: 'Step numbers must be sequential starting from 1.',
    docSlug: 'invalid-step-sequence',
  },
  MISSING_REQUIRED_VARS: {
    code: 'RD-403',
    category: ErrorCategory.VALIDATION,
    title: 'Missing required variables',
    description:
      'One or more required variables declared in frontmatter were not provided via CLI flags, config, environment, or delegation.',
    docSlug: 'missing-required-vars',
  },

  // Execution Errors (5xx)
  ENGINE_INIT_FAILED: {
    code: 'RD-501',
    category: ErrorCategory.EXECUTION,
    title: 'Failed to initialize runbook engine',
    description: 'The XState runbook engine could not be initialized.',
    docSlug: 'engine-init-failed',
  },
  RUNBOOK_HAS_NO_STEPS: {
    code: 'RD-502',
    category: ErrorCategory.EXECUTION,
    title: 'Runbook has no steps',
    description: 'The runbook file does not contain any executable steps.',
    docSlug: 'runbook-has-no-steps',
  },
  CHILD_RUNBOOK_ACTIVE: {
    code: 'RD-503',
    category: ErrorCategory.EXECUTION,
    title: 'Child runbook still active',
    description: 'A child runbook is still running. Complete or stop it first.',
    docSlug: 'child-runbook-active',
  },

  // Command Errors (6xx)
  INVALID_STEP_FORMAT: {
    code: 'RD-601',
    category: ErrorCategory.COMMAND,
    title: 'Invalid step ID format',
    description: 'Step ID must be in format "N" (step) or "N.M" (step.substep).',
    docSlug: 'invalid-step-format',
  },
  MISSING_REQUIRED_ARG: {
    code: 'RD-602',
    category: ErrorCategory.COMMAND,
    title: 'Missing required argument',
    description: 'A required argument was not provided.',
    docSlug: 'missing-required-arg',
  },
  SCENARIO_NOT_FOUND: {
    code: 'RD-603',
    category: ErrorCategory.COMMAND,
    title: 'Scenario not found',
    description: 'The specified scenario does not exist in the runbook.',
    docSlug: 'scenario-not-found',
  },

  // Substep Targeting Errors (8xx) — shared by delegation and inline linkage
  DELEGATION_STEP_NOT_FOUND: {
    code: 'RD-801',
    category: ErrorCategory.DELEGATION,
    title: 'Step not found',
    description: 'The specified step does not exist in the active runbook.',
    docSlug: 'delegation-step-not-found',
  },
  DELEGATION_STEP_NOT_CURRENT: {
    code: 'RD-802',
    category: ErrorCategory.DELEGATION,
    title: 'Step not at execution frontier',
    description: 'The target step must be the current step.',
    docSlug: 'delegation-step-not-current',
  },
  DELEGATION_SUBSTEP_REQUIRED: {
    code: 'RD-803',
    category: ErrorCategory.DELEGATION,
    title: 'Substep ID required',
    description: 'This step has substeps. Specify a substep ID (e.g., --step 2.1).',
    docSlug: 'delegation-substep-required',
  },
  DELEGATION_ALREADY_EXISTS: {
    code: 'RD-804',
    category: ErrorCategory.DELEGATION,
    title: 'Active delegation exists',
    description: 'This substep already has an active (non-cancelled) delegation.',
    docSlug: 'delegation-already-exists',
  },
  DELEGATION_RUNBOOK_NOT_FOUND: {
    code: 'RD-805',
    category: ErrorCategory.DELEGATION,
    title: 'Child runbook not found',
    description: 'The specified child runbook cannot be resolved.',
    docSlug: 'delegation-runbook-not-found',
  },
  DELEGATION_SUBSTEP_NOT_FOUND: {
    code: 'RD-806',
    category: ErrorCategory.DELEGATION,
    title: 'Substep not found',
    description: 'The specified substep ID does not exist in the target step.',
    docSlug: 'delegation-substep-not-found',
  },
  INVALID_TOKEN: {
    code: 'RD-807',
    category: ErrorCategory.DELEGATION,
    title: 'Invalid delegation token',
    description: 'Token format is invalid. Tokens must start with "rdtk_".',
    docSlug: 'invalid-token',
  },
  TOKEN_NOT_FOUND: {
    code: 'RD-808',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation token not found',
    description: 'No active run contains a delegation with this token.',
    docSlug: 'token-not-found',
  },
  TOKEN_CANCELLED: {
    code: 'RD-809',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation token cancelled',
    description: 'This delegation has been cancelled and cannot be claimed.',
    docSlug: 'token-cancelled',
  },
  DELEGATION_LOCK_TIMEOUT: {
    code: 'RD-810',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation lock timeout',
    description: 'Could not acquire delegation lock. Another operation may be in progress.',
    docSlug: 'delegation-lock-timeout',
  },
  DELEGATION_ALREADY_CLAIMED: {
    code: 'RD-811',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation already claimed',
    description:
      'This delegation has been claimed by a child run. Use --force to cancel in-flight.',
    docSlug: 'delegation-already-claimed',
  },
  DELEGATION_ALREADY_RESOLVED: {
    code: 'RD-812',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation already resolved',
    description: 'This delegation has already been resolved. Propagation already completed.',
    docSlug: 'delegation-already-resolved',
  },
  DELEGATION_NO_DELEGATABLE_SUBSTEP: {
    code: 'RD-813',
    category: ErrorCategory.DELEGATION,
    title: 'No delegatable substep',
    description: 'No pending substep with a runbook reference found on the current step.',
    docSlug: 'delegation-no-delegatable-substep',
  },
  DELEGATION_SUBSTEP_NO_RUNBOOK: {
    code: 'RD-814',
    category: ErrorCategory.DELEGATION,
    title: 'Substep has no runbook reference',
    description:
      'The specified substep does not have a runbook reference (e.g., "- child.runbook.md").',
    docSlug: 'delegation-substep-no-runbook',
  },
  DELEGATION_STEP_NO_SUBSTEPS: {
    code: 'RD-815',
    category: ErrorCategory.DELEGATION,
    title: 'Step has no substeps',
    description:
      'Inline linkage requires targeting a substep. The specified step has no substeps to target.',
    docSlug: 'delegation-step-no-substeps',
  },
  LAUNCH_FAILED: {
    code: 'RD-816',
    category: ErrorCategory.DELEGATION,
    title: 'Runbook launch failed',
    description:
      'Failed to initialize runbook state, actor, session, or post-init hook before execution started.',
    docSlug: 'launch-failed',
  },
  DELEGATION_SNAPSHOT_STALE: {
    code: 'RD-817',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation snapshot missing owner step',
    description:
      `Cannot retry: the persisted delegation snapshot does not record an owner step. ` +
      `This indicates the delegation was created by an older schema and cannot be safely re-issued.`,
    docSlug: 'delegation-snapshot-stale',
  },
  DELEGATION_OWNER_LOST_SUBSTEPS: {
    code: 'RD-818',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation owner step lost substeps',
    description:
      `A persisted delegation references a substep, but the resolved runbook no longer ` +
      `declares substeps on the owner step. Silently retargeting the replacement token ` +
      `onto the bare step would corrupt the persisted entry. Resolve by completing or ` +
      `stopping the running runbook and starting a fresh run.`,
    docSlug: 'delegation-owner-lost-substeps',
  },
  DELEGATION_NESTED_FORBIDDEN: {
    code: 'RD-819',
    category: ErrorCategory.DELEGATION,
    title: 'Nested delegation forbidden',
    description:
      'A claimed (delegated) child runbook may not issue further delegations. ' +
      'Delegation is single-level: subagents cannot spawn subagents. Use `rundown run` ' +
      'for runbook composition inside a claimed child.',
    docSlug: 'delegation-nested-forbidden',
  },
  CLAIM_INVARIANT_VIOLATED: {
    code: 'RD-820',
    category: ErrorCategory.DELEGATION,
    title: 'Claim invariant violated during fresh launch',
    description:
      `A freshly launched delegated child failed write-side claim validation. ` +
      `The child was just created with the same delegation linkage now being ` +
      `rejected — indicates internal inconsistency between manager.create() ` +
      `and SessionService.claimRunbook(). State may be corrupted; inspect the ` +
      `child run by ID and the parent's substep delegation.`,
    docSlug: 'claim-invariant-violated',
  },
  DELEGATION_INVARIANT_VIOLATED: {
    code: 'RD-821',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation invariant violated',
    description:
      `A delegation credential failed verification, or a delegation operation ` +
      `reached an unreachable result branch. The operator-reachable cause is ` +
      `presenting a claim that cannot reconstruct an in-flight delegation ` +
      `credential — typically a rotated or foreign issuing claim — in which case ` +
      `no bearer is disclosed. Otherwise it indicates an internal inconsistency ` +
      `in delegation state handling rather than stale runbook source. Inspect the ` +
      `reported reason and the persisted run state.`,
    docSlug: 'delegation-invariant-violated',
  },
  DELEGATION_RUNBOOK_MISMATCH: {
    code: 'RD-822',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation runbook mismatch',
    description:
      'The requested child runbook does not match the runbook authored on the DELEGATE substep.',
    docSlug: 'delegation-runbook-mismatch',
  },
  DELEGATION_IN_FLIGHT: {
    code: 'RD-823',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation child run in flight',
    description:
      'Cannot retry a delegation while its child run is still linked. Use `rundown abort <token> --claim-id <claim_id> --force` first to stop and record the child failure before retrying.',
    docSlug: 'delegation-in-flight',
  },
  CLAIM_SEEN_UNREADABLE: {
    code: 'RD-824',
    category: ErrorCategory.DELEGATION,
    title: 'Claim seen timestamp unreadable',
    description:
      'A claim record has a lastSeenAt that is not a parseable ISO timestamp. The claim activity signal cannot be derived, so it is reported as unreadable rather than guessed. Finish or prune active runbooks and restart.',
    docSlug: 'claim-seen-unreadable',
  },
  DELEGATION_SUPERSEDED: {
    code: 'RD-825',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation superseded',
    description:
      'The parent has moved past this delegation. Do not retry this token; report the superseded delegation to the orchestrator. The durable claim latch refuses a claim once the parent advances, ends, resets, or reissues the token.',
    docSlug: 'delegation-superseded',
  },
  DELEGATION_REPLACEMENT_CONSUMED: {
    code: 'RD-826',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation replacement consumed',
    description:
      'The named bearer was already replaced, and the replacement shows committed evidence of use — it was claimed, cancelled, or its frame entry advanced. Retrying it would mint a third bearer over work already in progress. Target the current delegation instead, or abort it and re-delegate.',
    docSlug: 'delegation-replacement-consumed',
  },
  DELEGATION_RETRY_IDENTITY_UNMATCHED: {
    code: 'RD-827',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation retry identity unmatched',
    description:
      'The named bearer identifies neither the delegation currently recorded at the target nor one that it superseded. The retry is refused rather than re-minted against an identity the parent does not recognise.',
    docSlug: 'delegation-retry-identity-unmatched',
  },
  DELEGATION_SUPERSESSION_AMBIGUOUS: {
    code: 'RD-828',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation supersession ambiguous',
    description:
      'More than one delegation attempt records this bearer as superseded, so there is no single replacement to echo or judge. Unreachable by construction; it is refused, never resolved. Prune invalid runbook state and restart execution.',
    docSlug: 'delegation-supersession-ambiguous',
  },
  DELEGATION_FRONTIER_CONSUME_FAILED: {
    code: 'RD-829',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation frontier consume failed',
    description:
      `A persisted delegation re-entry frontier projected successfully, but the ` +
      `machine did not accept the DELEGATE_FRONTIER_CONSUMED synchronization, so ` +
      `the frontier is still pending and its freshly derived bearers were not ` +
      `surfaced. This is transient, not a refusal: no authority was rejected and ` +
      `no credential failed verification. Retry the operation — the next attempt ` +
      `re-projects and re-consumes the same frontier.`,
    docSlug: 'delegation-frontier-consume-failed',
  },
  INLINE_CHILD_FRAME_SUPERSEDED: {
    code: 'RD-830',
    category: ErrorCategory.DELEGATION,
    title: 'Inline child superseded by frame re-entry',
    description:
      `The inline child recorded at this frame was launched at an earlier entry, ` +
      `and the parent has since re-entered the frame. A re-entered frame never ` +
      `adopts the previous entry's child — the same judgement delegation makes ` +
      `when it closes a child cursor-advanced (RD-826). Reachable from an ` +
      `ordinary gesture rather than corrupt state: a self-targeting GOTO or RETRY ` +
      `advances the frame's entry counter. Finish, stop, or prune the superseded ` +
      `child run, after which the same re-entry launches a fresh child under the ` +
      `current entry.`,
    docSlug: 'inline-child-frame-superseded',
  },
  INLINE_CHILD_LINKAGE_MISMATCH: {
    code: 'RD-831',
    category: ErrorCategory.DELEGATION,
    title: 'Inline child linkage mismatch',
    description:
      `The persisted inline child names a different parent run, step, substep, or ` +
      `frame than the launch intent describes. Distinct from RD-830: that is a ` +
      `superseded generation of the same linkage, reachable by an ordinary ` +
      `re-entry, whereas this is inconsistent state. Prune the child run and ` +
      `restart execution rather than adopting a child the parent does not claim.`,
    docSlug: 'inline-child-linkage-mismatch',
  },
  // Retry hook (9xx) — sub-range of ErrorCategory.EXECUTION reserved for
  // retry-hook lifecycle failures (delegation re-issuance, frame-key invariants,
  // canonical-at requirements). Kept as EXECUTION rather than a dedicated
  // category because consumers route on the structured RETRY_ERROR LastAction
  // variant, not on category. New 9xx codes must stay scoped to retry-hook
  // semantics — file unrelated runtime failures under 5xx EXECUTION.
  RETRY_HOOK_NO_FRAME: {
    code: 'RD-902',
    category: ErrorCategory.EXECUTION,
    title: 'Retry hook invoked without an active frame key',
    description:
      `The retry hook fired while context.activeFrameKey was undefined and ` +
      `live delegations were present — an invariant violation. Retry transitions ` +
      `only fire from drainResolvedCompletions, which requires an active frame. ` +
      `This indicates upstream state corruption (actor hydration bug, state-file ` +
      `tampering, or missing frame setup in a new feature path).`,
    docSlug: 'retry-hook-no-frame',
  },
  RETRY_HOOK_MISSING_RUN_ID: {
    code: 'RD-903',
    category: ErrorCategory.EXECUTION,
    title: 'Retry hook has no current run id',
    description:
      `The retry hook must re-issue delegation credentials against the run that ` +
      `is executing the retry, and reads that run's id from the machine's ` +
      `\`RunId\` template variable. The variable is absent or is not a canonical ` +
      `\`rd_<32 hex>\` id, so no credential coordinate can be derived. The run id ` +
      `is HMAC derivation input, so the hook refuses rather than deriving against ` +
      `a guessed or inherited identity.`,
    docSlug: 'retry-hook-missing-run-id',
  },
  RETRY_HOOK_MISSING_CANONICAL_AT: {
    code: 'RD-904',
    category: ErrorCategory.EXECUTION,
    title: 'Retry delegation produced no canonical execution location',
    description:
      `The fresh delegation snapshot returned by retryDelegation has no ` +
      `contextSnapshot.at value. The retry frontier id would lose FOR-iteration ` +
      `context (e.g. "1.1" instead of "1.2.1"), causing the re-entry frontier ` +
      `to point at the wrong execution location. Rollback is the safe action ` +
      `rather than silently emitting a degraded id.`,
    docSlug: 'retry-hook-missing-canonical-at',
  },
  RETRY_HOOK_STALE_SUBSTEP: {
    code: 'RD-905',
    category: ErrorCategory.EXECUTION,
    title: 'Retry hook references undeclared substep',
    description:
      `An active-frame delegation in persisted state targets a substep that the ` +
      `resolved runbook no longer declares on the parent step. The per-substep ` +
      `loop walks parentStep.substeps only, so silently skipping the orphan would ` +
      `consume the retry transition without re-issuing any token. Resolve by ` +
      `completing or stopping the running runbook and starting a fresh run.`,
    docSlug: 'retry-hook-stale-substep',
  },

  // Generic
  UNKNOWN_ERROR: {
    code: 'RD-999',
    category: ErrorCategory.EXECUTION,
    title: 'Unknown error',
    description: 'An unexpected error occurred.',
    docSlug: 'unknown-error',
  },
} as const;

/**
 * Type for error code keys.
 */
export type ErrorCodeKey = keyof typeof ErrorCodes;
