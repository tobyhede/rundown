# Lifecycle Command Seam — Pinned Contract (pass / fail / delegate)

> **Status:** prospective contract for the core lifecycle command seam
> (`docs/superpowers/plans/2026-06-28-core-lifecycle-command-seam.md`, Task 3).
> This document pins the **current** pass/fail and delegate behaviour so Task 4
> can move it behind one core seam without silent behavioural drift, and Task 5
> can enforce the subprocess caller-evidence boundary before any CLI call is
> stamped `direct_cli`.

This is **code-review-critical**. Task 4's seam-test matrix must map each input,
output, and boundary invariant below to at least one test, or record an explicit
reason it remains frontend-owned.

> **Superseded by Option B (2026-06-28).** This document is a point-in-time
> snapshot of the *pre-migration* contract, not a binding API. Task 7 implemented
> Option B of the pass/fail seam-migration design fork, which changed two items
> below. They are flagged inline at the relevant points; in summary:
>
> 1. **`steps` is no longer a `runTransition` input.** It moved to a
>    `RunbookLifecycleCommandServiceDependencies.loadSteps(state)` callable. The
>    seam resolves the target once and derives the resolved run's steps in-seam
>    via `loadSteps`, so the front end no longer resolves the target first to
>    supply `steps`. See "Required inputs" below.
> 2. **Inline-child reactivation is now core behaviour, not a CLI pre-check.** The
>    "resume the running inline child rather than record a completion" decision
>    moved into the seam's `#driveSubstep` (`SessionService.pushRunbook`); the CLI
>    helpers `findRunningInlineChildRunId` / `reactivateRunningInlineChild` were
>    deleted. See §1a below.
>
> The original contract text is preserved unchanged; these notes record the
> deltas so a later reader is not misled.

## Source of truth (current code)

| Concern | Location |
| --- | --- |
| pass/fail seam entry (resolve → gate → drive) | `packages/core/src/runbook/lifecycle-command-service.ts` (`RunbookLifecycleCommandService.runTransition`) |
| pass/fail execution (substep + top-level paths) | `packages/core/src/runbook/lifecycle-command-service.ts` (`#driveSubstep` / `#driveTopLevel`) |
| pass/fail CLI adapter (caller evidence + outcome rendering) | `packages/cli/src/helpers/transitions.ts` (`readLifecycleCallerEvidence`, renders the seam `LifecycleTransitionOutcome`) |
| pass/fail command wiring, parent propagation, exit codes | `packages/cli/src/helpers/transition-command.ts` |
| core target resolution + strict policy | `packages/core/src/runbook/command-target-resolver.ts` (`resolveTransitionTarget`) |
| core command policy | `packages/core/src/runbook/command-policy.ts` (`resolveCommandIntent`, `CommandTargetSelector`) |
| manual substep completion | `packages/core/src/runbook/completion-service.ts` (`RunbookCompletionService.recordManualCompletion`) |
| delegation issuance | `packages/core/src/runbook/delegation-service.ts` (`createDelegation`, `retryDelegation`) |
| bare delegate issuance gate | `packages/cli/src/commands/delegate.ts` |
| TOCTOU guard around decisive parent advance | `SessionService.runGuardedParentAdvance` |
| reference seam shape | `packages/core/src/runbook/collection-service.ts` (`RunbookCollectionService`, `RunbookCollectionServiceDependencies`) |

## 1. pass / fail contract

`rd pass` and `rd fail` share one end-to-end flow that differs only by event type
(`PASS`/`FAIL`), persisted `lastResult`, and `computeActionResult`. The flow
splits into **two mutation paths**, and the seam MUST preserve the split (do not
collapse to an unconditional `sendAndSync(PASS|FAIL)`).

### 1a. Substep / manual completion path

Taken when the active step is at a substep (`activeState.substep` set and the
resolved step has substeps), or when `--step` / `--index` explicitly targets a
substep.

> **Superseded by Option B (2026-06-28):** the bare (no explicit target)
> "running inline child still open → resume it rather than record a completion"
> decision is now **core behaviour** in the seam's `#driveSubstep`
> (`SessionService.pushRunbook`), not a CLI pre-check. The CLI helpers
> `findRunningInlineChildRunId` / `reactivateRunningInlineChild` were deleted. The
> explicit `--step` / `--index` path never reactivates.

- explicit `--step` / `--index` resolves a `RuntimeTarget` (step, substep,
  iteration, frame); bare form uses the active cursor;
- records via `RunbookCompletionService.recordManualCompletion`
  (`agentId: 'manual'`, `result: config.lastResult`);
- a `duplicate` record emits an `already-resolved` status (idempotent);
- drains resolved completions (`drainResolvedCompletions`), bridging emitter
  events to CLI output;
- may continue into the execution loop (`runExecutionLoop`) when completions were
  applied and the run is still progressing;
- when targeting the default parent bare (`guardOpenChildren`), the decisive
  record runs inside `SessionService.runGuardedParentAdvance`.

### 1b. Top-level run transition path

Taken when the active step is not a substep completion.

- `RunbookActorService.sendAndSync(runId, steps, { type: 'PASS' | 'FAIL' })`;
- `ExecutionLifecycleService.ensureActiveEntry` before and after;
- `orchestrateTransition` applies step-level changes, emits transition
  observations, and applies terminal side-effect `policy`
  (`onStopped.releaseRunbook`, `onComplete.releaseRunbook`);
- may continue into `runExecutionLoop`;
- when targeting the default parent bare (`guardOpenChildren`), `sendAndSync`
  runs inside `SessionService.runGuardedParentAdvance`.

### Required inputs

- `command: 'pass' | 'fail'`;
- `steps: readonly ResolvedStep[]` (parsed from state via `getRunbookFromState`);
  **[Superseded by Option B, 2026-06-28]** — `steps` is no longer a
  `runTransition` input. It moved to a
  `RunbookLifecycleCommandServiceDependencies.loadSteps(state)` callable; the seam
  resolves the target once and derives its steps in-seam;
- **caller evidence** (`CallerEvidence`), mapped to `ActorContext` by core — not a
  prebuilt `ActorContext` from the frontend;
- optional `claimId` (claim-targeted write);
- **explicit target as a discriminated `CommandTargetSelector`** (see §3), not a
  `targeted: boolean` plus a separate optional `claimId`;
- injected core services through a
  `RunbookLifecycleCommandServiceDependencies` interface mirroring
  `RunbookCollectionServiceDependencies` (`manager`, `actorService`,
  `lifecycleService`, `completionService`) plus whatever `transitions.ts`
  currently reads off `TransitionContext` — at minimum `sessionService` (for
  `runGuardedParentAdvance` and target resolution). Not loose positional params;
- terminal release mode (`ExecutionTerminalReleaseMode`: `release-runbook` for a
  claim target, `stack-pop` for the default stack) and execution-loop
  dependencies if the seam owns loop continuation;
- `SessionService.runGuardedParentAdvance` as the TOCTOU guard around decisive
  parent mutations (bare default-target advance only);
- parent-propagation and exit-code semantics currently owned by
  `transition-command.ts` / `pass.ts` / `fail.ts`
  (`extractParentLinkage` + `propagateChildTerminal`; inline children advance the
  composing parent synchronously, delegation children report-only).

### Required outputs

- **target refusals** (each a distinct typed variant, payload-preserving):
  - `none` — no active run (`output.noActiveRunbook`);
  - `stale_claim` — `CLAIMED_RUNBOOK_UNAVAILABLE`, exit 1;
  - `terminal_claim_confirmed` — idempotent `already-resolved` action payload
    (`claimId`, `lifecycle`), exit 0;
  - `terminal_claim_conflict` — `DELEGATION_RESULT_CONFLICT`
    (`claimId`, `expectedResult`, `requestedResult`), exit 1;
  - `delegation_collection_pending` — message literal is
    `typeof DELEGATION_COLLECTION_PENDING_MESSAGE`, payload
    `parentRunId` + `outcomeCompletionKeys`, exit 1;
  - `open_delegated_children` — `OPEN_DELEGATED_CHILDREN`, payload `parentRunId`,
    `claimIds`, `childRunIds`, exit 1;
  - `actor_context_required` — `ACTOR_CONTEXT_REQUIRED`, payload `targetRunId`
    (unreachable from a trusted direct CLI today; must stay renderable for
    non-CLI front ends);
- **transition application data**: updated state, snapshot, lifecycle, and
  transition observation events (`onErrorOccurred`, `onStepTransitioned`,
  `onRunbookCompleted`, `onRunbookStopped`) needed by the existing JSON/text
  renderers and `output.action`/`output.complete`/`output.stopped`;
- **execution-loop continuation result** (`'continue' | 'stopped'`) or a typed
  instruction for the CLI to run the loop;
- **parent-propagation decision data** and final **exit-code responsibility**:
  exit 0 when the orchestrated workflow is still progressing (parent absorbs a
  child terminal non-terminally); exit 1 only when the workflow actually halted
  (local `stopped`, RETRY exhausted, or parent propagation also stopped).

> The confirm/conflict split and the `DELEGATION_COLLECTION_PENDING_MESSAGE`
> literal type already exist on `TransitionTargetResolution` /
> `BuildTransitionContextResult`. The seam SHOULD reuse / take a superset of
> these unions rather than redeclare narrower shapes (no `readonly string[]`
> placeholders for claim ids).

## 2. delegate contract

**Full migration (current).** `rd delegate` — bare, `--step`/`--index`, the
positional-confirmation form, and `--retry` — is owned end-to-end by
`RunbookLifecycleCommandService.issueDelegation` (a discriminated
`mode: 'fresh' | 'retry'` input). The transitional policy-only precheck
(`precheckDelegationIssuance`) has been **deleted**; it is no longer a valid
shape.

`issueDelegation` owns the full operation in core:

- resolve the active target (or, for a `--retry` token, the owning parent run via
  the injected `findDelegationByToken`);
- map caller evidence to `ActorContext` and run delegation-issuance policy
  (`targeted: false` for bare, `targeted: true` for `--step` / positional /
  retry — so a pending collection refuses only bare issuance);
- infer/target the substep, resolve the RD-804 echo/conflict decision **before**
  resolving the authored child, and enforce the RD-822 requested-vs-authored
  mismatch;
- mint via the pure `createDelegation` / `retryDelegation` primitives;
- persist the resulting substep-state changes through the injected
  `persistSubstepStates` (core-managed `manager.update`);
- return typed outcome data for the CLI renderer (`delegated` /
  `already-delegated` / `retried` / `token-not-found` / `no-active-runbook` /
  `refused` / `error`), preserving the `token`, `token_hash`, `parent_run_id`
  fields and the `DELEGATION_COLLECTION_PENDING` refusal byte-for-byte.

**Discovery stays CLI-side (Category A).** `resolveRunbookFile` /
`buildRunbookRef` are not moved into core; the seam reaches them through the
injected `resolveChildRunbook` callable (project → plugin → bundled chain,
`cwd` / `CLAUDE_PLUGIN_ROOT` / bundled `dist/`). The seam invokes it lazily on
the issuable branch only, so an echo never depends on the authored child still
being resolvable.

**Closed policy hole.** Routing `--retry` through the gated `issueDelegation`
now subjects retry to the same actor-context policy as fresh issuance
(`targeted: true`), so an untrusted front end can no longer re-issue a delegation
that bare issuance would have refused. Direct-CLI behaviour is unchanged (a
`direct_cli` caller is always allowed; a pending collection never refuses a
targeted retry).

**Remaining CLI (Category A) work.** Flag parsing, runbook-file discovery, the
`--index`-requires-a-FOR-step validation, the `--retry` locator construction
(token / `--step` / inferred, with the form-specific `INVALID_SYNTAX` /
`NO_ACTIVE_RUNBOOK` / `INVALID_STEP` / `INVALID_INDEX` / `TOKEN_NOT_FOUND`
envelopes), and outcome rendering.

`--retry` (`retryDelegation`) is out of scope for this seam migration; it is
result-agnostic and keeps its current CLI resolution flow.

## 3. Target selector shape

Use the existing `CommandTargetSelector` discriminated union from
`command-policy.ts`:

```
{ kind: 'default' }
| { kind: 'claim'; claimId: ClaimId }
| { kind: 'explicit-step'; step: string }   // current shape
```

Reusing it makes the illegal `{ claimId set AND step set }` combination
unrepresentable by construction, replacing the `targeted: boolean` + separate
optional `claimId` shape.

**Required, source-compatible extension:** the current `explicit-step` variant
carries only `step: string` and cannot carry `--index`. Extend it to
`{ kind: 'explicit-step'; step: string; index?: string }` so the seam can carry
the `--index` iteration target. This is one extended variant, not a parallel
shape; `index` is optional so existing construction sites stay valid.

## 4. Subprocess boundary (plugin / MCP)

- the Claude plugin shells out through `node <cliPath> ...args`
  (`packages/claude-code-plugin/src/workflow/hooks/rundown.ts`,
  `execFileSyncImpl('node', [cliPath, ...args])`);
- MCP shells out through `npx`/`execFile` (`packages/mcp/src/cli.ts`,
  `packages/mcp/src/tools.ts` `buildRundownCommand` — including `pass`, `fail`,
  and `delegate` tools);
- typed `CallerEvidence` cannot cross that process boundary without a new
  explicit CLI/API ingress: the subprocess arrives at the CLI as an ordinary
  `argv`, indistinguishable from a human invocation;
- **source labels are not acceptable evidence** — do not add `--actor-source` or
  `RD_ACTOR_SOURCE`;
- until a purpose-built ingress exists, plugin/MCP spawned **bare** lifecycle
  mutations (bare `rd pass`, bare `rd fail`, bare `rd delegate`) must not silently
  inherit `direct_cli` trust;
- **claim-evidence mutations are preserved.** `rd pass --claim-id <id>` /
  `rd fail --claim-id <id>` are `claim_controller` mutations whose evidence
  (`claimId`, `tokenHash`, `controlledRunId`) is reconstructable CLI-side from the
  resolved claim record (`collect.ts`
  `claimControllerContext({ claimId, tokenHash, controlledRunId })`; the
  resolver's early `--claim-id` return bypasses the `actor_context_required`
  gate). The plugin delegation workflow depends on this
  (`delegation-dispatch.ts` instructs delegated children to run
  `rd pass --claim-id` / `rd fail --claim-id`), so the boundary MUST NOT block
  the `--claim-id` form;
- the CLI process cannot itself distinguish a plugin-spawned bare `rd pass` from
  a human-run one, so "blocking" the bare form happens **plugin/MCP-side** (the
  spawning frontend withholds direct-CLI trust), not inside the CLI bare path.
  Inspect/read-only commands may continue to shell out.
