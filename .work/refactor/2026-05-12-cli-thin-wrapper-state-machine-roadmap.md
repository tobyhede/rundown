# CLI Thin Wrapper / State Machine Refactor Audit and Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this roadmap task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Rundown so all runbook behavior is driven by the `@rundown-org/core` XState machine, while CLI, MCP, and Claude Code plugin front ends only collect external inputs, invoke typed core APIs, and observe/render machine output.

**Architecture:** Category B/C runbook side effects move into machine-invoked actors under `packages/core/src/runbook/actors/`. Front ends must not duplicate step transitions, lifecycle decisions, result aggregation, variable propagation, ARTIFACTS/OUTPUTS semantics, delegation semantics, FOR advancement, or command-result routing. CLI-owned Category A side effects remain limited to terminal rendering, argv/env/config collection, session targeting, and low-level process-callable DI.

**Tech Stack:** TypeScript, XState 5, Jest, existing `RunbookActorService` / `RunbookStateManager` persistence seam.

---

## Source Set

Read before executing this roadmap:

- `CLAUDE.md`
- `docs/internal/architecture.md`
- `.work/handoff/HANDOFF-2026-05-11.md`
- `.work/handoff/artifacts-as-variables-batch-1b-outputs-simplification.md`
- `.work/handoff/artifacts-as-variables-batch-2-artifacts-resolution.md`
- `.work/handoff/artifacts-as-variables-batch-2b-artifacts-nested-child.md`
- `.work/handoff/batch-2-design-review.md`

The older `.work/handoff/artifacts-as-variables-batch-2-artifacts-resolution.md` is useful for inventory and typed-failure details, but its flat sibling-state implementation strategy is superseded by `.work/handoff/artifacts-as-variables-batch-2b-artifacts-nested-child.md`.

## Executive Summary

Current state:

- OUTPUTS naked-channel capture is already machine-owned through `outputCaptureActor` and the compound leaf `__capture` child.
- ARTIFACTS resolution is functionally wired into production execution through a machine-owned `artifactResolveActor`, `__resolve-artifacts` leaf states, and parent-entry ARTIFACTS states. Batch 0-2 hardening added compiler invariants and bundled-plugin execution coverage around that graph shape; remaining ARTIFACTS raw-token helper/template semantics are still Batch 7 debt.
- The next ARTIFACTS batch must not start by only adding another tagged machine effect. Several front-end transition paths still bypass `RunbookActorService.sendAndSync()` or directly mutate terminal lifecycle, which can tear off entry-time invokes and skip terminal entry actions.
- `stop`, `complete`, policy denial, FOR exhaustion, delegation fan-out failure, GOTO metadata, substep drain, and delegation propagation all still contain state/lifecycle logic outside the machine.
- MCP is currently a thin shell-out facade over CLI, so it inherits CLI debt rather than adding separate machine drift.
- The Claude Code plugin has separate drift around delegation inheritance, delegation closure checks, token parsing/hash duplication, and artifact path assembly.

Immediate ordering:

1. Consolidate actor dispatch/persistence boundaries first.
2. Move forced STOP/COMPLETE through the machine.
3. Treat Batch 2 ARTIFACTS resolution as functionally implemented and hardened by compiler/plugin regressions, but do not treat ARTIFACTS helper/raw-token templating as solved while CLI pre-substitution remains.
4. Then migrate FOR, delegation in split phases, command execution plus step-entry observation, helpers/templates, and cross-frontend parity.

## Verified Current State

### Core

- The main dynamic compiler is `packages/core/src/runbook/compiler.ts`.
- `runbookSetup` currently registers only `outputCaptureActor` as a machine actor at `packages/core/src/runbook/compiler.ts:134`.
- `COMMAND_RESULT` enters the nested `.__capture` child at `packages/core/src/runbook/compiler.ts:2787`.
- `__capture` invokes `outputCaptureActor`, merges captured variables, and raises `PASS`/`FAIL` at `packages/core/src/runbook/compiler.ts:2713`.
- `outputCaptureActor` is the only actor under `packages/core/src/runbook/actors/` today, at `packages/core/src/runbook/actors/output-capture-actor.ts:50`.
- `stateValueAsString()` only recognizes `idle` and `__capture` compound child values at `packages/core/src/runbook/actor-service.ts:57`.
- Terminal states set machine lifecycle on entry at `packages/core/src/runbook/compiler.ts:2887` and `packages/core/src/runbook/compiler.ts:2897`.
- Parent aggregation is machine-owned in `buildParentStateConfig()` at `packages/core/src/runbook/compiler.ts:950`.
- General action dispatch is centralized in `buildActionTransition()` around `packages/core/src/runbook/compiler.ts:2244`.
- `resolveArtifactDeclarations()` is called by the machine-owned ARTIFACTS actor, not by CLI orchestration.
- `ARTIFACT_RESOLUTION_FAILED` is represented in core transition/state schemas and routes resolver failures through the machine stopped path.

### CLI

- Manual `pass` / `fail` calls still send directly to an actor then call `updateFromActor()` at `packages/cli/src/helpers/transitions.ts:479`, bypassing `sendAndSync()` and its `PENDING_MACHINE_EFFECT_TAG` wait.
- `goto` uses `sendAndSync()` at `packages/cli/src/helpers/goto-workflow.ts:253`, then rewrites `lastAction` and clears `lastResult` directly at `packages/cli/src/helpers/goto-workflow.ts:261`.
- `stop` directly writes `lastAction`, `lastResult`, and `lifecycle` at `packages/cli/src/commands/stop.ts:89`.
- `complete` directly moves the cursor to the last step and writes `lifecycle: completed` at `packages/cli/src/commands/complete.ts:99`.
- `runExecutionLoop()` constructs and calls `ForIterationService` at `packages/cli/src/services/execution.ts:643`, handles FOR exhaustion and terminal lifecycle at `packages/cli/src/services/execution.ts:686`, and handles FOR policy-denial stop behavior at `packages/cli/src/services/execution.ts:660`.
- `runExecutionLoop()` still owns delegation auto-issuance and persistence at `packages/cli/src/services/execution.ts:831` through `packages/cli/src/services/execution.ts:910`.
- `drainResolvedCompletions()` consumes substep completions and sends `PASS`/`FAIL` itself at `packages/cli/src/services/execution.ts:504`.
- `STEP_ENTERED` is emitted from the top of `runExecutionLoop()` rather than from state-machine observation, so ARTIFACTS `STEP_ENTERED.artifacts` cannot be made correct purely by the transition-observation work.
- Command expansion, OUTPUT channel env prep, command execution, policy-denial terminal handling, `lastResult`, and `COMMAND_RESULT` dispatch are CLI-owned at `packages/cli/src/services/execution.ts:937` through `packages/cli/src/services/execution.ts:1068`.
- `COMMAND_STARTED` and `COMMAND_COMPLETED` are emitted from the imperative command-spawn path, not from machine observation.
- AST-level ARTIFACTS token substitution exists in the CLI renderer at `packages/cli/src/services/template-renderer.ts:1161`; this is substitution only, not resolver execution.
- Run initialization still uses core service/manager bootstrap for active entries and substep state at `packages/cli/src/helpers/runbook-pipeline.ts:1032`, `packages/cli/src/helpers/runbook-pipeline.ts:1061`, and `packages/cli/src/helpers/runbook-pipeline.ts:1066`. This was acceptable as Batch 0 foundation work, but it is not fully machine-owned launch bootstrap.
- `substituteRunbookVariables()` still performs CLI pre-substitution of ARTIFACTS raw tokens before parsing/execution. Helper/template semantics for ARTIFACTS raw tokens remain Batch 7 debt and must move behind a core-owned templating seam before they are considered solved.

### MCP

- MCP tools call `runCli()` and shell out to `npx --no rundown` at `packages/mcp/src/cli.ts:116`.
- MCP registers tools as direct CLI command wrappers in `packages/mcp/src/index.ts:30`.
- MCP currently has no separate state-machine implementation drift, but also no parity tests and inherits all CLI orchestration debt.

### Claude Code Plugin

- Delegation dispatch builds child `rd claim --input...` flags by reading child frontmatter and parent `rd status` vars in `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts:69` and `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts:168`.
- Delegation closure checks scan run state locally in `packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts:124` and instantiate `RunbookStateManager` at `packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts:158`.
- Token detection and hashing are duplicated in plugin code; core exports token utilities from `packages/core/src/runbook/index.ts:108`.
- `rdpath` duplicates artifact path assembly instead of using core helpers, and current tests pin soft fallback on corrupt active state.
- Bundled plugin runbooks already declare ARTIFACTS, e.g. `packages/claude-code-plugin/runbooks/planning/write-plan.runbook.md:70`, so ARTIFACTS wiring is blocking real plugin behavior.

## Architectural Violations

### High Severity

- **Terminal commands bypass machine terminal entry.** `stop` and `complete` mutate lifecycle directly, skipping `COMPLETE` / `STOPPED` state entry actions, including frontmatter `outputs:` capture into `finalVars`.
- **Manual pass/fail bypass pending-effect synchronization.** Direct `actor.send()` plus `updateFromActor()` will persist mid-effect once an entry-time actor such as ARTIFACTS exists.
- **Command execution is CLI-owned.** The CLI expands commands, prepares output channels, runs commands, decides pass/fail, handles policy denial, writes `lastResult`, then sends `COMMAND_RESULT`. Spawn/env reads can be CLI callables, but command execution semantics belong in a Category C actor.
- **FOR advancement is CLI-orchestrated.** `ForIterationService.prepareIteration()` is a core class, but the CLI decides when to call it, how exhaustion routes, and how terminal lifecycle is emitted.
- **Delegation issuance and substep drain are CLI-orchestrated.** Token creation, frontier consumption, completion drain, and parent propagation are runbook semantics and must move to machine-owned core actors/events.
- **ARTIFACTS raw-token templating remains CLI-owned.** Resolution is now machine-owned, but raw-token helper/template pre-substitution still happens in the CLI renderer. Batch 7 must move those semantics behind a core-owned API rather than expanding CLI orchestration.

### Medium Severity

- **Transition observation mutates state.** `transition-orchestrator.ts`, `transitions.ts`, and `goto-workflow.ts` still write `lastAction`, `lastResult`, and terminal lifecycle after the machine has produced a snapshot.
- **Run initialization is not fully machine-owned.** Batch 0 established enough core service/manager bootstrap for active entries and substep state to support entry-time actors, but launch bootstrap still needs to be collapsed into machine-owned/core-owned initialization rather than remaining split across CLI pipeline code.
- **Variable/template semantics are largely CLI-owned.** Env/config collection is Category A, but precedence, runtime context variables, FOR-bound handling, helper invocation, and AST substitution need a shared core API.
- **Plugin delegation read models duplicate core.** The plugin should not reconstruct inherited variables or decide whether delegation still requires closure.
- **Plugin artifact path logic duplicates core.** Path assembly and invalid-state behavior must be core-owned and fail closed on corrupt state unless an explicit core policy says otherwise.

## Non-Negotiable Constraints

- Do not add CLI orchestration for ARTIFACTS as a transitional shortcut.
- Do not add persisted-state migrations or compatibility shims. Stale state must fail closed with explicit prune/restart guidance.
- Do not persist process/runtime references in machine context. Runtime callables flow through invoke-input closures.
- Do not branch on free-form strings where a typed discriminant is required.
- Do not silently map STOP, COMPLETE, BREAK, DEFER, or internal failure variants to another action.
- Do not implement the old flat ARTIFACTS sibling-state plan as-is.
- Do not add side-effect child states without `PENDING_MACHINE_EFFECT_TAG` coverage, actor-service wait tests, and compiler graph invariants proving their targets resolve to known children and their error exits route to terminal machine states.


## Roadmap

### Batch 0: Consolidate Actor Dispatch and Pending-Effect Persistence

**Goal:** Ensure every frontend transition path that can enter a machine-owned effect waits for `PENDING_MACHINE_EFFECT_TAG` before persistence.

**Batch 0 blockers before ARTIFACTS:**

- Transition dispatch blocker: every CLI path that sends a machine event must use `RunbookActorService.sendAndSync()` and the shared core wait-before-persist path. No CLI transition helper may call raw `actor.send()` or `updateFromActor()` for runbook transitions.
- Launch initialization blocker: normal launch in `runbook-pipeline.ts` must stop writing semantic state directly. Initial substep cursor, active frame/entry bootstrap, first-step substep state, and `START` must come from core initialization / machine launch.

**Files:**

- Modify: `packages/core/src/runbook/actor-service.ts`
- Modify: `packages/core/src/runbook/compiler.ts`
- Modify: `packages/cli/src/helpers/transitions.ts`
- Modify: `packages/cli/src/helpers/goto-workflow.ts`
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts`
- Test: `packages/core/__tests__/runbook/actor-service.test.ts`
- Test: core initialization tests
- Test: CLI run/pass/fail/goto regression tests

- [x] Replace direct `actor.send()` + `updateFromActor()` in `executeTransition()` with `RunbookActorService.sendAndSync()`.
- [x] Make `RunbookActorService.initializeState()` wait for pending machine effects before `updateFromActor()`. This is required before any initial entry-time actor can exist.
- [ ] Move semantic run initialization fully into core: initial substep cursor, `START` `lastAction`, active frame/entry bootstrap, and any first-step substep state initialization must be produced by `initializeState()` or machine entry actions, not ad hoc `runbook-pipeline.ts` writes. Batch 0 currently uses core service/manager bootstrap for active entries and substep state; this is foundation, not completion.
- [ ] Remove manual `lastAction` rewrite from `goto` or move the clearing of stale `lastResult` into a typed machine/core operation. If `lastResult` remains a persisted compatibility field, provide a core-owned operation for clearing it.
- [ ] Add tests with a synthetic pending machine effect proving `initializeState()`, `pass`, `fail`, and `goto` do not persist while the actor is tagged.
- [ ] Add a guard test that CLI transition helpers no longer import/use raw actor send for runbook transitions.
- [ ] Add a launch test proving first-step initialization writes the same persisted state through core as before, including first substep and `START`.

**Acceptance criteria:**

- `rg "actor\\.send\\(" packages/cli/src` has no runbook transition call sites.
- CLI transition helpers do not call `updateFromActor()` for persistence.
- `initializeState()` and `sendAndSync()` share the same wait-before-persist behavior.
- `runbook-pipeline.ts` no longer calls `ensureActiveEntry()`, `initializeSubsteps()`, or writes initial substep cursor / `lastAction: START` directly for normal launches.
- Existing OUTPUTS capture tests still pass.

### Batch 1: Machine-Owned Forced STOP and COMPLETE

**Goal:** Make user-forced stop/complete enter machine terminal states so lifecycle, final outputs, messages, and parent propagation derive from one state-machine path.

**Files:**

- Modify: `packages/core/src/runbook/compiler.ts`
- Modify: `packages/core/src/runbook/types.ts`
- Modify: `packages/core/src/runbook/transition-kernel.ts`
- Modify: `packages/cli/src/commands/stop.ts`
- Modify: `packages/cli/src/commands/complete.ts`
- Test: core compiler/actor-service terminal event tests
- Test: CLI stop/complete tests

- [ ] Add `FORCE_STOP` and `FORCE_COMPLETE` machine events, distinct from `LastAction` `STOP` / `COMPLETE`, handled by root transitions into `STOPPED` / `COMPLETE`.
- [ ] Use inline actions, dynamic params, or `assertEvent()` for forced-event message narrowing. Do not branch on raw `event.type` inside shared actions.
- [ ] Ensure forced terminal events set `lastAction`, `lastMessage`, `lifecycle`, and frontmatter `finalVars` via machine entry/action logic.
- [ ] Replace direct `manager.update(... lifecycle ...)` in `stop` and `complete` with the new core path.
- [ ] Preserve cleanup behavior for missing/corrupt active stack as a separate Category A cleanup path.
- [ ] Add tests proving `rd stop` and `rd complete` populate `finalVars` and terminal snapshots.

**Acceptance criteria:**

- `stop.ts` and `complete.ts` do not write `lifecycle`, `lastAction`, `lastResult`, or `step` directly for valid active runs.
- Terminal output still matches existing user-facing CLI behavior.
- Parent propagation for claimed/delegated child runs still works, but reads terminal state produced by core.

### Batch 2: ARTIFACTS Resolution Actor and Entry-Time Machine Wiring

**Goal:** Wire `resolveArtifactDeclarations()` into the state machine as a Category B actor. Do not add CLI resolver orchestration.

**Status:** Functionally implemented and hardened by Batch 0-2 guardrails. Parent-entry compiler invariants and bundled-plugin execution coverage now protect the generated ARTIFACTS graph. Remaining helper/raw-token template semantics are deferred to Batch 7 because CLI `substituteRunbookVariables()` still performs pre-substitution today.

**Use as base:** `.work/handoff/artifacts-as-variables-batch-2b-artifacts-nested-child.md`, amended by this roadmap. That handoff is useful for the compound-leaf actor pattern, but this roadmap supersedes any text that merges parent-step ARTIFACTS into only the first substep.

**Files:**

- Create: `packages/core/src/runbook/actors/artifact-resolve-actor.ts`
- Modify: `packages/core/src/runbook/compiler.ts`
- Modify: `packages/core/src/runbook/actor-service.ts`
- Modify: `packages/core/src/runbook/types.ts`
- Modify: `packages/core/src/runbook/transition-kernel.ts`
- Modify: `packages/core/src/schemas.ts`
- Modify: `packages/core/src/events/types.ts`
- Modify: CLI observer/event-schema tests as needed
- Test: core actor/compiler/actor-service/kernel/schema tests
- Test: ARTIFACTS end-to-end tests using plugin runbooks

**Decision gates before implementation:**

- [ ] Decide `STEP_ENTERED.artifacts`: current specs require it (`docs/spec/language.md:445`, `docs/spec/cli-output.md:234`). Either implement it in this batch through a core-owned event projection helper, or immediately update specs to mark it deferred. Do not leave docs and runtime contradictory.
- [ ] Decide retry binding semantics. If ARTIFACTS resolve on every retry re-entry, pin that in tests and docs. If ARTIFACTS bind once per execution-unit entry, target retry to `idle` or guard resolution accordingly.
- [ ] Decide whether helper calls inside ARTIFACTS raw tokens are a normative global templating capability. If yes, helper/renderer callables must be supplied through `compileRunbookToMachine` options and captured by per-state `invoke.input` closures. Never store callables, service instances, cwd-derived process state, or other runtime references in `RunbookContext`, `RunbookState`, or `snapshot`.

**Settled parent ARTIFACTS requirement:**

- Step-level ARTIFACTS on a step with substeps MUST resolve through a real machine-owned parent-entry resolution path before any child substep opens.
- The resolved parent ARTIFACTS values MUST merge into the global runbook `context.variables` map, not into a substep-local bag. Example: `ParentPath` declared on `## 1` must be visible to `### 1.1`, `### 1.2`, later steps, and rendered prompts/commands after resolution.
- Direct targeting must be correct. `rd goto 1.2`, `GOTO 1.2`, retry re-entry, and initial entry to step `1` must all pass through the parent-entry resolver before entering the requested child. Implementers must not merge parent declarations into only the first substep.
- The old Batch 2b handoff text that merges parent declarations into the first substep is superseded. Replace it with parent-entry routing or another graph shape that proves equivalent GOTO semantics.

**Implementation steps:**

- [x] Add `artifactResolveActor` wrapping `resolveArtifactDeclarations()` with typed input/output.
- [x] Add a shared `LEAF_SUBSTATES` / compound-value predicate so actor-service flattening can recognize `__resolve-artifacts` without hard-coded drift.
- [x] Add compiler invariants for all side-effect child states: every child target must resolve to a known child from `LEAF_SUBSTATES`, and every side-effect actor `onError` must target the canonical stopped state.
- [x] Register `artifactResolveActor` in `runbookSetup`.
- [x] Add `__resolve-artifacts` as a `PENDING_MACHINE_EFFECT_TAG`-tagged entry-time nested child for supported ARTIFACTS-bearing execution units, with actor-service tests proving initial start and transition paths never persist while the tag is active.
- [x] Add a parent-entry ARTIFACTS resolution path for substepped steps with step-level ARTIFACTS. All incoming targets to that step's child substeps must route through parent resolution first, then continue to the originally requested child.
- [x] Merge resolved artifact values into `context.variables`.
- [x] Add typed `ARTIFACT_RESOLUTION_FAILED` to `LastAction`, `ActionType`, schema, stopped reason, and internal-failure helpers.
- [x] Route actor errors to `STOPPED` with `RUNBOOK_STOPPED.reason === 'artifact_resolution_failed'`.
- [x] Add ARTIFACTS projection for `STEP_ENTERED.artifacts` if the decision gate chooses spec conformance now.

**Acceptance criteria:**

- `rg "resolveArtifactDeclarations\\(" packages/core/src packages/cli/src` shows production use only from core actor code, not CLI orchestration.
- ARTIFACTS manifest rows are written before command execution for producer declarations.
- Resolved artifacts, including parent-step ARTIFACTS on substepped steps, are available in global `state.variables` before command/prompt rendering.
- Direct `GOTO` to a non-first substep of a step with parent ARTIFACTS resolves parent ARTIFACTS before entering that child.
- Resolver failures stop the runbook through the machine with typed lastAction and public stopped reason.
- Initial run start, `pass`, `fail`, and `goto` all wait for entry-time resolution.
- Compiler graph validation fails closed if a side-effect child state has an unknown target or non-terminal `onError`.
- Plugin runbooks that declare ARTIFACTS have at least one end-to-end regression test.

### Batch 3: Core-Owned Transition Observation Payloads

**Goal:** Move post-transition observation semantics out of CLI mutation code and into core-derived payloads.

**Files:**

- Modify: `packages/core/src/events/`
- Modify: `packages/core/src/runbook/transition-kernel.ts`
- Modify: `packages/cli/src/helpers/transition-orchestrator.ts`
- Modify: `packages/cli/src/helpers/transitions.ts`
- Modify: `packages/cli/src/helpers/goto-workflow.ts`
- Test: core event projection tests
- Test: CLI output parity tests

- [ ] Add a core function/service that derives `STEP_TRANSITIONED`, `RUNBOOK_COMPLETED`, `RUNBOOK_STOPPED`, retry metadata, positions, and internal-failure messages from previous state + machine snapshot.
- [ ] Replace CLI `orchestrateTransition()` state mutations with render-only calls to the core projection.
- [ ] Remove CLI writes to `lastAction`, `lastResult`, and `lifecycle` after actor sync.
- [ ] Keep terminal session release in CLI as Category A session bookkeeping.
- [ ] Explicitly leave `STEP_ENTERED`, `COMMAND_STARTED`, and `COMMAND_COMPLETED` out of this batch. They are not post-transition events today; they move with the command-execution/step-entry observer work later.

**Acceptance criteria:**

- CLI transition orchestration emits events but does not alter runbook semantic fields.
- MCP can reuse the same projection or validated CLI output.
- Scenario output schemas continue to pass.

### Batch 4: Machine-Owned FOR Iteration Advancement

**Goal:** Move FOR current-value hydration, exhaustion, and iteration-boundary transitions into machine-owned core behavior.

**Files:**

- Create: `packages/core/src/runbook/actors/for-iteration-actor.ts`
- Modify: `packages/core/src/runbook/compiler.ts`
- Modify: `packages/core/src/runbook/for-iteration-service.ts` or retire it as orchestration
- Modify: `packages/cli/src/services/execution.ts`
- Test: core compiler/actor tests for range, array, JSONL stream, exhaustion, NEXT, BREAK, retry
- Test: CLI tests asserting no `ForIterationService` construction in execution loop

- [ ] Classify file-backed JSONL reads and source resolution as machine-owned Category B.
- [ ] Invoke the actor at iteration boundaries and on exhaustion paths.
- [ ] Preserve policy-denial semantics for file path containment as a typed machine failure rather than CLI direct stop.
- [ ] Remove `runExecutionLoop()` responsibility for `prepareIteration()` and terminal lifecycle on exhaustion.

**Acceptance criteria:**

- CLI no longer decides when a FOR loop is exhausted.
- FOR state persists only through actor-service sync.
- Existing FOR integration/property tests pass.

### Batch 5a: Delegation Core Read Models and Plugin Drift Cleanup

**Goal:** Remove plugin-specific delegation interpretation before moving delegation write paths into the machine.

**Files:**

- Modify: `packages/core/src/runbook/delegation-service.ts`
- Modify: `packages/core/src/runbook/delegation-token.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Modify: `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts`
- Modify: `packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts`
- Test: plugin delegation inheritance and closure tests

- [ ] Add typed core read model for "does this consumed delegation still require closure?"
- [ ] Remove plugin-side `buildChildInputFlags`; `rd claim` must rely on persisted core delegation snapshot inheritance.
- [ ] Replace plugin token regex/hash duplication with core exports.
- [ ] Add tests for pending, claimed-active, completed, stopped, cancelled, missing, and corrupt delegation states through the core read model.

**Acceptance criteria:**

- Delegation inheritance preserves strings, numbers, arrays/objects, and artifact records without plugin-injected overrides.
- SubagentStop decisions are made through a core API.
- Plugin token detection and hashing use core exports.

### Batch 5b: Machine-Owned Delegation Issuance and Frontier

**Goal:** Move delegation token fan-out and pending frontier state from CLI execution-loop observation into core machine behavior.

**Files:**

- Create/modify core delegation actors/services
- Modify: `packages/core/src/runbook/compiler.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: `packages/cli/src/helpers/transitions.ts`
- Test: core delegation fan-out/retry tests
- Test: CLI run/delegate retry tests

- [ ] Move auto fan-out token issuance from CLI execution loop into machine-owned actor/action.
- [ ] Move `PENDING_FRONTIER_CONSUMED` semantics into core or replace with observer acknowledgement that does not require CLI clearing machine context.
- [ ] Preserve retry-hook frontier behavior and nested-delegation rejection semantics as typed machine outcomes.

**Acceptance criteria:**

- CLI no longer creates delegation tokens during execution-loop observation.
- Delegate frontier emission observes machine-produced state and does not mutate machine context from the renderer path.
- Retry re-issuance remains uniform across delegated substeps.

### Batch 5c: Machine-Owned Completion Recording, Drain, Collect, and Parent Propagation

**Goal:** Move child completion recording, ordered substep drain, collection, and parent propagation into core machine APIs/actors.

**Files:**

- Create/modify core completion/drain actors/services
- Modify: `packages/core/src/runbook/compiler.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/helpers/delegation-completion.ts`
- Modify: `packages/cli/src/helpers/transitions.ts`
- Test: core completion drain and aggregation tests
- Test: CLI collect/pass/fail/claim/abort tests

- [ ] Move `drainResolvedCompletions()` ordering and per-substep PASS/FAIL dispatch into core.
- [ ] Reduce `rd collect` to target validation + typed core dispatch + render.
- [ ] Move child-to-parent `finalVars` propagation through a typed core event/API rather than CLI `SET_VARIABLES` orchestration where feasible.
- [ ] Keep CLI claim-id option parsing and terminal rendering as Category A/frontend concerns.

**Acceptance criteria:**

- Mixed pass/fail delegated substeps aggregate identically across CLI and MCP.
- `rd pass --step`, `rd fail --step`, `rd collect`, `rd claim`, and `rd abort` use typed core APIs for runbook semantics.
- Parent propagation reads and writes through core-owned semantics.

### Batch 6: Command Execution and Step-Entry Observation as Category C

**Goal:** Make the machine invoke command execution and own execution-unit entry/command lifecycle observation while CLI supplies external callables for process spawn, policy prompts/evaluation, env access, and internal command handling.

**Files:**

- Create: `packages/core/src/runbook/actors/command-exec-actor.ts`
- Modify: `packages/core/src/runbook/compiler.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: policy/context services as DI providers
- Test: core actor tests for success, failure, policy denied, sandboxed, internal command fallback
- Test: core event projection tests for `STEP_ENTERED`, `COMMAND_STARTED`, `COMMAND_COMPLETED`, and `POLICY_DENIED`
- Test: CLI smoke tests proving runner DI and observation rendering are wired

- [ ] Define typed input/output for command execution actor, including rendered command, output channels, policy result, exit code, sandbox metadata, and display command.
- [ ] Supply command runner, policy evaluator, prompt handler, env reader, and internal-command handler through `compileRunbookToMachine` options / invoke-input closures. Persisted context must contain only serializable data.
- [ ] Move `STEP_ENTERED` generation into a core-owned observation pattern tied to execution-unit entry. This must include resolved `artifacts` if Batch 2 chose spec conformance rather than deferral.
- [ ] Move command-result-to-transition dispatch inside the machine.
- [ ] Keep the actual spawn syscall and terminal prompting as CLI callables.
- [ ] Emit or project `COMMAND_STARTED`, `COMMAND_COMPLETED`, and `POLICY_DENIED` from machine/core observation rather than mid-loop imperative code. The CLI may still render these events; it must not decide runbook state from them.
- [ ] Remove direct policy-denial lifecycle mutation from CLI.

**Acceptance criteria:**

- CLI no longer decides pass/fail from command exit code outside core.
- `STEP_ENTERED` is emitted from machine/core observation, not from the top of `runExecutionLoop()`.
- `COMMAND_STARTED` and `COMMAND_COMPLETED` are owned by the command-exec actor/observer contract, with CLI limited to rendering.
- `COMMAND_RESULT` transitional event can be removed or demoted to an internal machine event if no frontend sends it.
- OUTPUTS capture still runs through `outputCaptureActor`.

### Batch 7: Shared Core Template, Helper, and Variable Preparation

**Goal:** Move semantic variable preparation and template/helper behavior into a shared core API used by CLI, MCP, and plugin.

**Files:**

- Move/refactor pieces of `packages/cli/src/services/variable-discovery.ts`
- Move/refactor pieces of `packages/cli/src/services/template-renderer.ts`
- Keep CLI config/env/module loading as Category A
- Test: core variable precedence, required inputs, data source routing, helper collision, runtime `Step`/`Index`, ARTIFACTS token expansion

- [ ] Separate external input collection from semantic variable resolution.
- [ ] Move runtime context frame construction to core.
- [ ] Move helper invocation semantics to a core DI boundary.
- [ ] Preserve explicit CLI flag/env/config precedence.

**Acceptance criteria:**

- CLI and MCP use the same core preparation output.
- Helper syntax works consistently in descriptions, prompts, commands, OUTPUTS, and ARTIFACTS according to spec.

### Batch 8: Frontend Parity and Plugin Cleanup

**Goal:** Ensure MCP and Claude plugin are thin wrappers over core/CLI behavior, with no duplicated runbook semantics.

**Files:**

- Modify: `packages/mcp/src/*`
- Modify: `packages/claude-code-plugin/src/*`
- Modify: plugin tests
- Add: MCP parity tests

- [ ] Decide whether MCP remains an intentional CLI facade. If yes, add parity tests for CLI command output. If no, introduce a shared core-facing adapter and stop shelling out.
- [ ] Make `rdpath` use core artifact path helpers or a core `rdpath` API.
- [ ] Fail closed on corrupt/stale active state unless a core policy explicitly allows fallback.
- [ ] Remove stale step-tracker unsupported `rd run --step` path or route it through a supported core/CLI API.
- [ ] Add end-to-end tests for bundled plugin runbooks with ARTIFACTS.

**Acceptance criteria:**

- MCP package no longer has "No tests yet" coverage gap.
- Plugin token, delegation, and artifact path behavior are driven by core utilities/services.
- Cross-frontend parity exists for `run`, `status`, `pass`, `fail`, `goto`, `stop`, `complete`, `delegate`, `claim`, and `collect`.

## Open Design Questions

These must be answered before the relevant batch is implemented:

- **ARTIFACTS parent-entry graph shape:** Parent ARTIFACTS on substepped steps must resolve before any child substep opens and merge into global `context.variables`. The implementation still needs to choose the exact XState graph shape and tests for initial entry, `GOTO 1.2`, and retry re-entry.
- **ARTIFACTS retry binding:** Are ARTIFACTS resolved on every retry attempt or once per execution-unit entry?
- **`STEP_ENTERED.artifacts`:** Implement now for spec conformance, or amend docs to defer?
- **Helper syntax in ARTIFACTS tokens:** Confirm whether global helper syntax is normative in ARTIFACTS raw tokens.
- **Manifest corruption:** Handoff recommends fail-fast for manifest corruption with a future `manifest_corruption` reason. Track this as an independent hardening batch.
- **MCP architecture:** Is MCP intentionally a CLI facade, or should it move to a shared core adapter?

## Verification Matrix

Run targeted tests per batch, then:

- `npm test`
- `npm run test:integration`
- `npm run verify`

Additional grep gates:

- `rg "actor\\.send\\(" packages/cli/src` should not show transition dispatch.
- `rg "updateFromActor\\(" packages/cli/src` should not show transition persistence.
- `rg "ensureActiveEntry\\(|initializeSubsteps\\(|lastAction: \\{ type: 'START'" packages/cli/src/helpers/runbook-pipeline.ts` should not show normal launch semantic initialization after Batch 0.
- `rg "lifecycle: 'completed'|lifecycle: 'stopped'" packages/cli/src` should only show cleanup/error cases explicitly classified as Category A or temporary debt.
- `rg "resolveArtifactDeclarations\\(" packages/cli/src packages/mcp/src packages/claude-code-plugin/src` should stay empty.
- `rg "hashToken|delegation token" packages/claude-code-plugin/src` should not duplicate core token utilities after Batch 5.

## Do Not Implement

- Do not implement `.work/handoff/artifacts-as-variables-batch-1-execution-loop-wiring.md`; it is deprecated and CLI-orchestrated.
- Do not implement the flat sibling-state ARTIFACTS wiring from `.work/handoff/artifacts-as-variables-batch-2-artifacts-resolution.md` without adapting it to the Batch 1b compound-leaf pattern and the blocker batches above.
- Do not add more `manager.update()` calls in CLI for `lastAction`, `lastResult`, semantic cursor movement, result aggregation, or lifecycle.
- Do not treat existing CLI behavior as precedent when it conflicts with `CLAUDE.md`.
