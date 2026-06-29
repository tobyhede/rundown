# Core Lifecycle Command Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make direct-CLI cross-run delegation mutations enter core through one lifecycle command seam that maps caller evidence, resolves policy, and drives the state machine, while first preventing plugin/MCP subprocess calls from silently inheriting direct-CLI trust.

**Architecture:** Follow `RunbookCollectionService.collectDelegationOutcomes` as the existing model for policy-gate + machine-driving, but do not over-copy it: collect already receives a resolved target and an actor context, while the new seam must also handle target resolution and caller-evidence mapping. The state machine continues to own per-run transitions; cross-run IO and policy stay out of XState guards.

**Tech Stack:** TypeScript (ESM), XState v5 via existing `RunbookActorService`, Jest, `@rundown-org/core`, `@rundown-org/cli`, `@rundown-org/claude-code-plugin`, `@rundown-org/mcp`.

---

## Global Constraints

- Source tagging is not a trust mechanism. Do not add `--actor-source` or
  `RD_ACTOR_SOURCE`.
- Frontends pass typed caller evidence, not final `ActorContext`.
- Core maps caller evidence to `ActorContext`.
- Plugin/MCP map to `unknown` unless they provide explicit trusted evidence.
- Plugin and MCP currently shell out to the CLI. Typed caller evidence cannot
  cross that process boundary without a new explicit CLI/API ingress. Until that
  ingress exists, plugin/MCP spawned `rd` commands must not silently inherit
  direct-CLI trust for role-specific mutation.
- Direct local CLI compatibility remains explicit and does not bypass collection
  pending or open-claim policy.
- Do not move cross-run IO or policy into XState guards.
- Do not migrate persisted runbook state.
- JSON remains the CLI default output format.
- Run `pnpm run verify` before pushing the branch.

## File Structure

| File | Role | Change |
| --- | --- | --- |
| `packages/core/src/runbook/actor-context.ts` | Actor evidence model | Remove `ActorContext.source`; add typed caller-evidence mapping owned by core |
| `packages/core/src/runbook/lifecycle-command-service.ts` | New core seam | Own fully specified resolve -> gate -> drive-machine flows after Task 3 pins the current contracts |
| `packages/core/src/runbook/index.ts` | Core barrel | Export the new seam and evidence types |
| `packages/core/src/runbook/command-target-resolver.ts` | Existing target/policy resolver | Keep target resolution in core; adapt to caller-evidence mapping |
| `packages/core/src/runbook/command-policy.ts` | Existing policy API | Keep role derivation and policy outcomes source-free |
| `packages/cli/src/helpers/transitions.ts` | CLI pass/fail adapter | Replace resolve/gate/drive orchestration with one core seam call; **extract** the explicit-target cursor parsing (~587–668) into an exported pure `resolveManualCompletionCursor(steps, activeState, explicitTarget): ManualCompletionCursor` — Category-A input handling that stays CLI-side and feeds the seam |
| `packages/cli/__tests__/helpers/transitions-explicit-target.test.ts` | CLI white-box cursor tests | Re-home the cursor-VALIDATION cases onto `resolveManualCompletionCursor`; delete the now-redundant drive-coupled assertions (covered by the seam's own tests) |
| `packages/cli/__tests__/integration/delegation-propagation.test.ts` | CLI delegation integration | Rewrite the single direct `executeTransition` atomic re-check (~307) to drive through the seam, preserving the `OPEN_DELEGATED_CHILDREN` refusal + no-parent-advance assertions |
| `packages/cli/src/commands/delegate.ts` | CLI delegate adapter | Replace inline policy gating and actor-context construction with one core seam call |
| `packages/cli/src/commands/collect.ts` | Existing model | Keep as reference; only adjust if shared evidence types require it |
| `packages/claude-code-plugin/src/workflow/hooks/*` | Plugin subprocess boundary | Task 5 designs and implements the evidence/blocking boundary before CLI lifecycle migration |
| `packages/mcp/src/tools.ts` | MCP subprocess boundary | Task 5 designs and implements the evidence/blocking boundary before CLI lifecycle migration |
| `docs/superpowers/plans/2026-06-26-*.md` | Superseded plans | Already bannered as superseded by the boundary addendum |

## Task 1: Close the source-tagging path and remove `ActorContext.source`

**Files:**
- Modify: `packages/core/src/runbook/actor-context.ts`
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/commands/delegate.ts`
- Modify: `packages/core/__tests__/runbook/command-target-resolver.test.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.properties.test.ts`
- Modify: `packages/core/__tests__/runbook/command-policy.test.ts`
- Modify: `packages/core/__tests__/runbook/command-policy.properties.test.ts`
- Modify: `packages/cli/__tests__/commands/collect.test.ts`
- Modify: `packages/cli/__tests__/commands/delegate.test.ts`
- Modify: `packages/cli/__tests__/commands/pass.test.ts`
- Modify: `packages/cli/__tests__/commands/fail.test.ts`

- [ ] **Step 1: Write failing source-removal tests**

Add or update tests so `trusted_run_controller` contexts no longer expose a
`source` field, and policy behavior remains unchanged.

Run:
```bash
pnpm --filter @rundown-org/core test -- actor-context command-policy
pnpm --filter @rundown-org/core test -- command-target-resolver collection-service
```

Expected: FAIL until the type and call sites are updated.

- [ ] **Step 2: Remove `source` from core actor context**

In `packages/core/src/runbook/actor-context.ts`, change:

```typescript
export type ActorContext =
  | {
      readonly kind: 'trusted_run_controller';
      readonly runId: RunId;
      readonly source: ActorContextSource;
    }
```

to:

```typescript
export type ActorContext =
  | {
      readonly kind: 'trusted_run_controller';
      readonly runId: RunId;
    }
```

Delete `ActorContextSource` unless another current type still needs it. Change
`trustedRunControllerContext` to accept only `runId`.

- [ ] **Step 3: Update all constructor call sites**

Replace calls like:

```typescript
trustedRunControllerContext(state.id, 'direct-cli')
```

with:

```typescript
trustedRunControllerContext(state.id)
```

- [ ] **Step 4: Run focused tests**

Run:
```bash
pnpm --filter @rundown-org/core test -- actor-context command-policy command-target-resolver collection-service
pnpm --filter @rundown-org/cli test -- collect delegate pass fail
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/actor-context.ts \
        packages/core/src/runbook/index.ts \
        packages/core/src/runbook/command-target-resolver.ts \
        packages/cli/src/commands/collect.ts \
        packages/cli/src/commands/delegate.ts \
        packages/core/__tests__/runbook \
        packages/cli/__tests__
git commit -m "refactor(core): remove actor context source tag"
```

## Task 2: Introduce typed caller evidence in core

**Files:**
- Modify: `packages/core/src/runbook/actor-context.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Test: `packages/core/__tests__/runbook/actor-context.test.ts`

- [ ] **Step 1: Add failing evidence-mapping tests**

Cover:

- direct CLI evidence maps to `trusted_run_controller`;
- insufficient plugin/MCP evidence maps to `unknown`;
- complete claim evidence maps to `claim_controller`;
- plugin/MCP names, agent ids, session ids, tool names, and other non-claim
  metadata never grant trust by themselves.

Run:
```bash
pnpm --filter @rundown-org/core test -- actor-context
```

Expected: FAIL until the evidence type and mapper exist.

- [ ] **Step 2: Add the evidence type and mapper**

Add a typed envelope in `actor-context.ts`:

```typescript
export type CallerEvidence =
  | { readonly kind: 'direct_cli' }
  | { readonly kind: 'plugin'; readonly agentId?: string; readonly sessionId?: string }
  | { readonly kind: 'mcp'; readonly toolName?: string }
  | {
      readonly kind: 'claim';
      readonly claimId: ClaimId;
      readonly tokenHash: DelegationTokenHash;
      readonly controlledRunId: RunId;
    }
  | { readonly kind: 'unknown' };

export function actorContextFromEvidence(
  evidence: CallerEvidence,
  targetRunId: RunId,
): ActorContext {
  switch (evidence.kind) {
    case 'direct_cli':
      return trustedRunControllerContext(targetRunId);
    case 'claim':
      return claimControllerContext({
        claimId: evidence.claimId,
        tokenHash: evidence.tokenHash,
        controlledRunId: evidence.controlledRunId,
      });
    case 'plugin':
    case 'mcp':
    case 'unknown':
      return UNKNOWN_ACTOR_CONTEXT;
  }
}
```

Extend the envelope only when plugin/MCP can supply real trusted controller
evidence. Do not let `plugin` or `mcp` alone grant trust.

Add a property test alongside the table tests: arbitrary `agentId`, `sessionId`,
and `toolName` values on `plugin`/`mcp` evidence must always map to
`UNKNOWN_ACTOR_CONTEXT` unless a future task adds an explicit trusted-evidence
variant with its own tests.

Name and implement these property tests:

- totality: `actorContextFromEvidence(e, targetRunId)` never throws for any
  generated `CallerEvidence`;
- role composition: `deriveEffectiveRole(actorContextFromEvidence(e, t), state(t))`
  is `orchestrator_for_target` iff `e.kind === 'direct_cli'` or `e.kind ===
  'claim' && e.controlledRunId === t`;
- claim anchoring: `claim_controller.controlledRunId` comes from
  `CallerEvidence.controlledRunId`, not from the target run id argument.

- [ ] **Step 3: Export the new API**

Export `CallerEvidence` and `actorContextFromEvidence` from
`packages/core/src/runbook/index.ts`.

- [ ] **Step 4: Run focused tests**

Run:
```bash
pnpm --filter @rundown-org/core test -- actor-context
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/actor-context.ts \
        packages/core/src/runbook/index.ts \
        packages/core/__tests__/runbook/actor-context.test.ts
git commit -m "feat(core): map caller evidence to actor context"
```

## Task 3: Pin the current pass/fail and delegate contracts

**Files:**
- Create: `docs/superpowers/issues/2026-06-28-lifecycle-command-seam-contract.md`
- Read: `packages/cli/src/helpers/transitions.ts`
- Read: `packages/cli/src/helpers/transition-command.ts`
- Read: `packages/cli/src/commands/delegate.ts`
- Read: `packages/core/src/runbook/completion-service.ts`
- Read: `packages/core/src/runbook/delegation-service.ts`
- Read: `packages/core/src/runbook/command-target-resolver.ts`

- [ ] **Step 1: Document the pass/fail contract**

Create `docs/superpowers/issues/2026-06-28-lifecycle-command-seam-contract.md`
with a pass/fail section that names both mutation paths:

- substep/manual completion: explicit `--step` / `--index`, active substep,
  `RunbookCompletionService.recordManualCompletion`, drain resolved completions,
  possible execution-loop continuation;
- top-level run transition: `RunbookActorService.sendAndSync(PASS|FAIL)`,
  transition orchestration, terminal release behavior, possible execution-loop
  continuation.

The section must list required inputs:

- `command: 'pass' | 'fail'`;
- `steps: readonly ResolvedStep[]`;
- caller evidence;
- optional `claimId`;
- explicit target as a discriminated `CommandTargetSelector` (see delegate
  section), not a `targeted: boolean` plus a separate optional `claimId`;
- the injected core services the seam depends on, to be supplied through a
  `RunbookLifecycleCommandServiceDependencies` interface mirroring
  `RunbookCollectionServiceDependencies` (`manager`, `actorService`,
  `lifecycleService`, `completionService`, plus whatever `transitions.ts`
  currently reads off `TransitionContext`), not loose ad-hoc parameters;
- terminal release mode and execution-loop dependencies if the seam owns loop
  continuation.
- `SessionService.runGuardedParentAdvance` as the TOCTOU guard around decisive
  parent mutations.
- parent-propagation and exit-code semantics currently owned by
  `transition-command.ts` / `pass.ts` / `fail.ts`.

The section must list required outputs:

- target refusals: no active run, stale claim, terminal claim confirmed,
  terminal claim conflict, collection pending, open delegated children, actor
  context required;
- transition application data: updated state, snapshot, lifecycle, and
  observation events needed by existing JSON/text renderers;
- execution-loop continuation result or a typed instruction for the CLI to run
  the loop.
- parent-propagation decision data and final exit-code responsibility.

Document the target shape as the existing `CommandTargetSelector` discriminated
union (`command-policy.ts` — `{ kind: 'default' }` | `{ kind: 'claim'; claimId }`
| `{ kind: 'explicit-step'; step }`), already consumed via
`ResolveCommandIntentInput.targetSelector`. Reusing it makes the illegal
`{ claimId set AND stepId set }` combination unrepresentable by construction
instead of a `targeted: boolean` plus separate optional `claimId`. Caveat:
the current `explicit-step` variant carries only `step: string` with no `index`,
so the contract must call out extending that variant to
`{ kind: 'explicit-step'; step: string; index?: string }` to carry `--index`;
note this as a required, source-compatible extension, not a parallel shape.

- [ ] **Step 2: Document the delegate contract**

Add a delegate section that states the seam must own the full bare delegate
operation if delegate is called "migrated":

- resolve the active target;
- map caller evidence;
- run delegation-issuance policy;
- resolve child runbook and variables;
- call `createDelegation`;
- persist the resulting parent/child state changes through core-managed
  services;
- return typed output data for the CLI renderer.

A policy-only precheck is allowed only if the document explicitly calls it a
short-lived transitional step and does **not** claim delegate has migrated behind
the seam.

- [ ] **Step 3: Document the subprocess boundary**

Add a plugin/MCP section:

- the Claude plugin currently shells out through `node <cliPath> ...args`;
- MCP currently shells out through `npx --no rundown ...args`;
- typed `CallerEvidence` cannot cross that process boundary without a new
  explicit CLI/API ingress;
- source labels are not acceptable evidence;
- until a purpose-built ingress exists, plugin/MCP spawned lifecycle mutations
  must not silently inherit direct-CLI trust.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/issues/2026-06-28-lifecycle-command-seam-contract.md
git commit -m "docs: pin lifecycle command seam contract"
```

Treat this contract as code-review-critical. Task 4's test matrix must map each
listed input, output, and boundary invariant to at least one test or an explicit
reason it remains frontend-owned.

## Task 4: Add the core lifecycle command seam

**Files:**
- Create: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

- [ ] **Step 1: Add failing seam tests**

Write tests from the Task 3 contract. Build a checklist in the test file or test
description comments that maps every Task 3 contract item to a test. At minimum,
cover:

- pass/fail target refusals, including terminal claim confirm/conflict;
- explicit `--step` / `--index` substep completion;
- top-level `PASS` / `FAIL`;
- collection-pending and open-children refusals;
- machine dispatch failure;
- claim-controller cross-run cases: claim controller can mutate the controlled
  run and cannot mutate an ancestor/peer run;
- delegate issuance as a full core operation or explicitly marked transitional
  precheck.
- if delegate remains a transitional precheck, assert the precheck does not
  create or persist a delegation by itself.

Run:
```bash
pnpm --filter @rundown-org/core test -- lifecycle-command-service
```

Expected: FAIL until the service exists.

- [ ] **Step 2: Add public seam types with full payloads**

Define outcome variants by reusing or taking a superset of
`TransitionTargetResolution` and existing policy outcome members where possible.
Do not redeclare narrower shapes for target refusals: this preserves the
`DELEGATION_COLLECTION_PENDING_MESSAGE` literal type and the distinct terminal
claim confirm/conflict payloads by construction. Do not use lossy placeholders
such as `readonly string[]` for claim ids. Include payloads required by current
renderers, including parent run id, child run ids, claim ids, outcome completion
keys, updated state/snapshot, lifecycle, and transition observations.

Inject the seam's core service dependencies through a
`RunbookLifecycleCommandServiceDependencies` interface and a
`constructor(deps: RunbookLifecycleCommandServiceDependencies)` that stores
`#deps`, mirroring `RunbookCollectionService`
(`collection-service.ts` — `RunbookCollectionServiceDependencies` with
`manager`, `actorService`, `lifecycleService`, `completionService`). Add the
extra services the transition path needs (e.g. `sessionService` for
`runGuardedParentAdvance`). Do not take loose positional service parameters.

Do not retire `directCliCompatibility` in this task. Its only production
consumer is `transitions.ts:291` (an object literal passed straight to
`resolveTransitionTarget`), which is not migrated until Task 7. Removing the
field from `ResolveTransitionTargetOptions` here would raise a TS2353
excess-property error at `transitions.ts:291` and drop every bare `rd pass` /
`rd fail` to `UNKNOWN_ACTOR_CONTEXT` -> `actor_context_required`, failing this
task's own integration/scenario gate. The retirement lands in Task 7, in the
same commit that migrates the last consumer.

- [ ] **Step 3: Implement pass/fail without collapsing paths**

The seam must preserve the current split:

- manual substep completion records and drains completions;
- top-level pass/fail sends `PASS` or `FAIL`;
- both paths preserve `runGuardedParentAdvance`, transition observation,
  orchestration, and execution-loop continuation behavior.

Do not implement pass/fail as unconditional `sendAndSync(PASS|FAIL)`.

- [ ] **Step 4: Implement delegate according to the chosen contract**

If the seam owns delegate migration in this plan, move the full bare delegate
operation into core. If the implementation chooses a transitional policy precheck
only, keep the task and docs named accordingly and do not claim delegate is fully
migrated.

- [ ] **Step 5: Export the service**

Export `RunbookLifecycleCommandService` and its public types from
`packages/core/src/runbook/index.ts`. Add TSDoc for every exported symbol.

- [ ] **Step 6: Run focused tests**

Run:
```bash
pnpm --filter @rundown-org/core test -- lifecycle-command-service command-target-resolver command-policy
pnpm run test:integration
pnpm run test:scenarios:all
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts \
        packages/core/src/runbook/index.ts \
        packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): add lifecycle command seam"
```

## Task 5: Implement the subprocess caller-evidence boundary

**Files:**
- Create: `docs/superpowers/specs/2026-06-28-plugin-mcp-caller-evidence-ingress-design.md`
- Modify: `packages/cli/src/helpers/transition-command.ts`
- Modify: `packages/cli/src/commands/delegate.ts`
- Modify: `packages/mcp/src/tools.ts`
- Modify: `packages/claude-code-plugin/src/workflow/hooks/rundown.ts`
- Test: `packages/cli/__tests__/commands/pass.test.ts`
- Test: `packages/cli/__tests__/commands/fail.test.ts`
- Test: `packages/cli/__tests__/commands/delegate.test.ts`
- Test: `packages/mcp/__tests__/tools.test.ts`
- Test: `packages/claude-code-plugin/__tests__/workflow/hooks/rundown.test.ts`

- [ ] **Step 1: Choose and document the ingress/blocking shape**

Create `docs/superpowers/specs/2026-06-28-plugin-mcp-caller-evidence-ingress-design.md`
and choose one implemented path for this cycle:

- plugin/MCP lifecycle operations call an in-process core API and pass
  `CallerEvidence`;
- the CLI grows a narrow evidence ingress that carries claim/controller metadata
  without source labels;
- plugin/MCP role-specific mutation is blocked/unknown until such an ingress
  exists.

The design must explicitly preserve the MCP environment-inheritance rule and
must not reintroduce `--actor-source` or `RD_ACTOR_SOURCE`.

- [ ] **Step 2: Implement the boundary before CLI migration**

Before Tasks 6 and 7 stamp any CLI call as `direct_cli`, implement the chosen
boundary. The blocking scope is **bare (default-target) role-specific mutations
only**: bare `rd pass`, bare `rd fail`, and bare `rd delegate`. These are the
invocations whose only available trust is `direct_cli`, so a plugin/MCP
subprocess must not silently inherit it.

**Preserve `--claim-id` claim-evidence mutations.** `rd pass --claim-id <id>` /
`rd fail --claim-id <id>` are `claim_controller` mutations whose evidence
(`claimId`, `tokenHash`, `controlledRunId`) is fully reconstructable CLI-side
from the resolved claim record — no source label and no `direct_cli` trust is
involved (see `collect.ts` `claimControllerContext({ claimId, tokenHash,
controlledRunId })`, and the resolver's early `--claim-id` return that bypasses
the `actor_context_required` gate). The plugin delegation workflow depends on
this: `delegation-dispatch.ts:167-177` instructs delegated children to run
`rd pass --claim-id` / `rd fail --claim-id`. Blocking the `--claim-id` form would
regress delegated-child completion, so this task must NOT block it.

Note that the CLI cannot itself distinguish a plugin-spawned bare `rd pass` from
a human-run one — both arrive as the same process. "Blocking" the bare form
therefore happens plugin/MCP-side (the spawning frontend withholds direct-CLI
trust), not inside the CLI bare path. Inspect/read-only commands may continue to
shell out.

- [ ] **Step 3: Add subprocess trust-regression tests**

Tests must prove that MCP/plugin subprocess calls to **bare** role-specific
mutation commands either carry explicit trusted evidence through the new ingress
or are blocked/treated as `unknown`. A spawned MCP/plugin bare `rd pass`, bare
`rd fail`, or bare `rd delegate` must not become `{ kind: 'direct_cli' }` merely
because the CLI process received it. Add a complementary test asserting the
`--claim-id` form is still honored as a `claim_controller` mutation — claim
evidence must survive the boundary so delegated children can complete.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-28-plugin-mcp-caller-evidence-ingress-design.md \
        packages/cli/src/helpers/transition-command.ts \
        packages/cli/src/commands/delegate.ts \
        packages/mcp/src/tools.ts \
        packages/claude-code-plugin/src/workflow/hooks/rundown.ts \
        packages/cli/__tests__/commands/pass.test.ts \
        packages/cli/__tests__/commands/fail.test.ts \
        packages/cli/__tests__/commands/delegate.test.ts \
        packages/mcp/__tests__/tools.test.ts \
        packages/claude-code-plugin/__tests__/workflow/hooks/rundown.test.ts
git commit -m "feat(frontends): enforce caller evidence boundary for subprocess mutations"
```

## Task 6: Migrate `delegate` to the seam

**Files:**
- Modify: `packages/cli/src/commands/delegate.ts`
- Test: `packages/cli/__tests__/commands/delegate.test.ts`

- [ ] **Step 1: Add failing CLI adapter tests**

Pin that bare `delegate` calls the core seam and no longer constructs
`ActorContext` in the CLI.

Include or adapt existing delegation integration coverage for
`delegate-workflow`, `delegation-claim`, `delegation-propagation`,
`report-then-collect`, and `collection-pending-lifecycle` paths so the migration
cannot pass unit tests while breaking cross-process behavior.

Run:
```bash
pnpm --filter @rundown-org/cli test -- delegate
pnpm run test:integration
pnpm run test:scenarios:all
```

Expected: FAIL until `delegate.ts` uses the seam.

- [ ] **Step 2: Replace inline policy construction**

Remove the inline `resolveCommandIntent` /
`trustedRunControllerContext(state.id)` branch from `delegate.ts`. Obtain caller
evidence from the Task 5 boundary helper. It may return direct-CLI evidence only
for an invocation that is actually allowed to use the direct local CLI
compatibility lane; plugin/MCP subprocess mutations without explicit trusted
evidence must be blocked or mapped to `unknown` before this point.

```typescript
const evidence = readLifecycleCallerEvidence(command);
```

Call the delegate seam method from Task 4. If Task 4 implemented only a
transitional precheck, this task is limited to removing CLI actor-context
construction and must be renamed in the commit message as a precheck migration,
not a full delegate migration.

- [ ] **Step 3: Render typed outcomes**

Map seam outcomes to existing JSON error/action envelopes. Preserve the current
`DELEGATION_COLLECTION_PENDING` rendering.

- [ ] **Step 4: Run focused tests**

Run:
```bash
pnpm --filter @rundown-org/cli test -- delegate
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/delegate.ts \
        packages/cli/__tests__/commands/delegate.test.ts
git commit -m "refactor(cli): route delegate through lifecycle seam"
```

If Task 4 implemented only a transitional precheck, use:

```bash
git commit -m "refactor(cli): route delegate policy precheck through lifecycle seam"
```

## Task 7: Migrate `pass` and `fail` to the seam (Option B)

> **Design decision:** This task implements **Option B** of
> `docs/superpowers/issues/2026-06-28-pass-fail-seam-migration-design-fork.md`.
> The two non-mechanical problems that block a straight find-and-replace are
> resolved *inside the seam*, not deferred:
> 1. **Inline-child reactivation** moves into the seam's `#driveSubstep` — the
>    runbook-logic decision ("the inline child is still open, resume it rather
>    than record a completion") belongs in core, and core already owns
>    `SessionService.pushRunbook`.
> 2. **Double-resolution** is eliminated — the seam resolves the target once and
>    derives steps in-seam via an injected `loadSteps(state)` callable. Per the
>    design note's Issue 2 correction, step derivation is parsing of the resolved
>    state's in-memory `runbookSrc`, *not* runbook-file IO; the callable carries
>    only the environment-bound helper-registry + render context (Category A),
>    so `steps` stops being a required `runTransition` input.
> No follow-up debt is carried. The CLI keeps only Category-A work: caller
> evidence, output rendering, and running the execution loop (process spawning).
>
> **Cursor parsing stays CLI-side (Category A).** Turning raw `--step` / `--index`
> strings into a validated `ManualCompletionCursor` (parse the step id, match the
> active step, require/validate the substep, resolve `--index` vs AT, check FOR
> bounds, build the targeting frame) is input handling on inherently external CLI
> arguments — Category A per CLAUDE.md, not runbook logic. It is therefore
> **extracted into a pure CLI helper (`resolveManualCompletionCursor`), not moved
> to core.** The seam consumes the resulting cursor as its `manualTarget`
> (`ManualCompletionCursor`). Only the drive half (record/drain, send/sync,
> guarded parent advance, terminal release) is runbook logic and moves to the
> seam. Extracting the parser also turns the white-box `executeTransition` cursor
> tests into pure-function tests — a coverage win, since they no longer have to
> mock all of `@rundown-org/core` to exercise validation branches.

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Modify: `packages/cli/src/helpers/transitions.ts` (extract exported `resolveManualCompletionCursor`)
- Modify: `packages/cli/src/helpers/transition-command.ts`
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Test: `packages/core/__tests__/runbook/command-target-resolver.test.ts`
- Test: `packages/cli/__tests__/commands/pass.test.ts`
- Test: `packages/cli/__tests__/commands/fail.test.ts`
- Test: `packages/cli/__tests__/helpers/transitions-explicit-target.test.ts` (re-home cursor-validation cases onto the pure function; delete redundant drive assertions)
- Test: `packages/cli/__tests__/integration/delegation-propagation.test.ts` (rewrite the direct `executeTransition` re-check through the seam)

### Part 1 — extend the seam (core)

- [ ] **Step 1: Add failing seam tests for inline-child reactivation**

Add `lifecycle-command-service.test.ts` cases pinning the new `#driveSubstep`
behaviour for a *bare* (no `manualTarget`) substep transition whose active
substep has a running inline child:

- **resume, not record:** when the running inline child's `parentLinkage` matches
  the parent cursor (`kind: 'inline'`, `parentRunId`/`parentStep`/`parentStepId`/
  `parentFrameKey`/`parentEntry` all equal), the seam pushes the child via
  `SessionService.pushRunbook` and returns an `applied` outcome with **no manual
  completion recorded**. Pin the full shape: `events: []`, `loop: { kind: 'none' }`,
  `status: 'continue'`, and **`updatedState` omitted** (the parent did not change;
  the child is now the active run). The decisive assertion is **behavioural**:
  `SessionService.pushRunbook` called exactly once with the child run id, and
  `RunbookCompletionService.recordManualCompletion` **not called** — assert against
  the collaborators, not only the returned payload;
- **record when no running child:** no matching running inline child →
  unchanged record + drain behaviour;
- **record when linkage mismatches:** a running child whose linkage does not
  match the parent cursor → falls through to record (does **not** reactivate);
- **explicit `--step` is exempt:** a `manualTarget` cursor never reactivates
  (mirrors the CLI's `!explicitTarget` guard) — it always records.

These mirror the CLI helpers being deleted (`findRunningInlineChildRunId`,
`reactivateRunningInlineChild` in `transitions.ts:426-467`) and the integration
suites `inline-child-launch`, `inline-linkage`, `delegation-inline-handoff`.

Run:
```bash
pnpm --filter @rundown-org/core test -- lifecycle-command-service
```

Expected: FAIL until `#driveSubstep` reactivates.

- [ ] **Step 2: Implement inline-child reactivation in `#driveSubstep`**

Port the reactivation decision into core. Add the child-state load capability the
decision needs to `RunbookLifecycleCommandServiceDependencies` — prefer a narrow
loader (`readonly loadRun: (runId: RunId) => Promise<RunbookState | undefined>`)
over exposing the whole `RunbookStateManager`, keeping test doubles trivial
(consistent with the existing structural-dependency convention). In
`#driveSubstep`, before recording, when `input.manualTarget` is **absent**:
derive the running inline child run id from the active state, load it, verify
`lifecycle === 'running'` and inline linkage matches the parent cursor, and if so
`pushRunbook` (only when it is not already active) and **return before** any
`recordManualCompletion` / drain call, with the no-record `applied` outcome from
Step 1 (`events: []`, `loop: { kind: 'none' }`, `status: 'continue'`, no
`updatedState`). Otherwise record as today. Do **not** reactivate on the
explicit-target path.

Run:
```bash
pnpm --filter @rundown-org/core test -- lifecycle-command-service
```

Expected: PASS.

- [ ] **Step 3: Add failing seam tests for single-resolution `loadSteps`**

Pin that `runTransition` no longer requires `steps` and derives them once from
the resolved target:

- the seam calls the injected `loadSteps` **exactly once, with the resolved
  state**, and uses the returned steps for the drive. (This is the observable
  proxy for "resolve once": `resolveTransitionTarget` is a free function, not an
  injected collaborator, so it cannot be spied directly — assert on `loadSteps`
  call count + argument instead of trying to count resolver calls.);
- a `--claim-id` target derives steps for the **claimed child** run (different
  runbook), proving `loadSteps` sees the resolved state, not the active default.

Run:
```bash
pnpm --filter @rundown-org/core test -- lifecycle-command-service
```

Expected: FAIL until the input/seam shape changes.

- [ ] **Step 4: Replace `steps` input with a `loadSteps` dependency**

Remove `steps` from `LifecycleTransitionInput`. Add
`readonly loadSteps: (state: RunbookState) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>`
to `RunbookLifecycleCommandServiceDependencies`. In `runTransition`, after the
single `resolveTransitionTarget`, call `loadSteps(resolution.state)` and thread
the result through `#drive`/`#driveSubstep`/`#driveTopLevel` in place of
`input.steps`. The seam still resolves exactly once; the redundant CLI-side
resolution is removed in Part 2. Update TSDoc and the `index.ts` exports for any
changed public types.

Run:
```bash
pnpm --filter @rundown-org/core test -- lifecycle-command-service
```

Expected: PASS.

### Part 2 — migrate the CLI adapter and retire `directCliCompatibility`

- [ ] **Step 5: Add failing pass/fail adapter tests**

Pin that pass/fail call the core seam (`runTransition`), construct **no**
`ActorContext` in the CLI, and preserve:

- terminal claim confirmation/conflict behavior;
- collection-pending refusal;
- open delegated children refusal;
- targeted `--step` / `--index` behavior;
- **bare inline-child reactivation** (now satisfied by the seam, exercised
  through the CLI);
- parent propagation and exit-code behavior.

Include or adapt the existing integration/scenario coverage for
`inline-child-launch`, `inline-linkage`, `delegation-inline-handoff`,
`collection-pending-lifecycle`, `report-then-collect`, `delegation-claim`, and
`delegation-propagation`.

Run:
```bash
pnpm --filter @rundown-org/cli test -- pass fail
pnpm run test:integration
pnpm run test:scenarios:all
```

Expected: FAIL until the transition helper uses the seam.

- [ ] **Step 6: Gather direct CLI evidence at the adapter boundary**

In the CLI transition path, obtain caller evidence from the Task 5 boundary
helper. It may return direct-CLI evidence only for an invocation that is actually
allowed to use the direct local CLI compatibility lane; plugin/MCP subprocess
mutations without explicit trusted evidence must be blocked or mapped to
`unknown` before this point.

```typescript
const evidence = readLifecycleCallerEvidence(command);
```

Do not construct `ActorContext` in the CLI.

- [ ] **Step 6a: Extract `resolveManualCompletionCursor` (pure refactor)**

Lift the explicit-target cursor-parsing block out of `executeTransition`
(`transitions.ts` ~587–668) into a new exported pure function in
`transitions.ts`:

```typescript
export function resolveManualCompletionCursor(
  steps: readonly ResolvedStep[],
  activeState: RunbookState,
  explicitTarget?: ExplicitTarget,
): ManualCompletionCursor { /* parse, match, validate, build frame, return cursor */ }
```

It owns exactly the Category-A validation that exists today: `parseStepIdFromString`,
active-step match, substep-required, substep-exists, `resolveIndexOption`,
AT-vs-`--index` conflict, FOR-bounds, `buildFrameKey` / `deriveActiveFrame` /
`activeFrame` / `inactiveFrame`. It returns the seam's `ManualCompletionCursor`
(`@rundown-org/core` — `{ step, substep, iteration?, frame, at }`). The bare
(no-`explicitTarget`) branch derives the active cursor exactly as today. This is a
behaviour-preserving extraction — `executeTransition` calls the new function in
place of the inlined block. Do not change any thrown-error messages.

Run:
```bash
pnpm --filter @rundown-org/cli test -- transitions-explicit-target
```

Expected: PASS (existing white-box tests still pass against the unchanged
`executeTransition` surface).

- [ ] **Step 6b: Re-home the cursor-VALIDATION tests onto the pure function**

In `transitions-explicit-target.test.ts`, retarget every cursor-shape /
validation case from `executeTransition(asCtx(ctx), config, target)` to a direct
`resolveManualCompletionCursor(ctx.steps, activeState, target)` call. Same
inputs, same thrown-error assertions (invalid step id, step mismatch, missing
substep, substep-does-not-exist, `--index` vs AT conflict, FOR over/under bounds,
non-FOR `--index`, active/inactive frame selection, `--index` default-to-active),
and assert the returned cursor's `step` / `substep` / `iteration` / `frame`
instead of asserting `recordManualCompletion` arguments. These no longer mock all
of `@rundown-org/core` to reach a validation branch — a coverage win.

Run:
```bash
pnpm --filter @rundown-org/cli test -- transitions-explicit-target
```

Expected: PASS.

- [ ] **Step 6c: Delete the now-redundant drive-coupled assertions**

Delete the cases in `transitions-explicit-target.test.ts` that assert the *drive*
collaborators were called — i.e. that `recordManualCompletion` /
`drainResolvedCompletions` / `actorService.assertFreshState` / `actor.send` were
invoked (e.g. "validates invalid state before recording", the inline-child
"does not reactivate when … stale" cases, and the `recordManualCompletion`
called-with assertions). These are **not lost**: the drive path now lives in the
seam and is covered by
`packages/core/__tests__/runbook/lifecycle-command-service.test.ts` (Part 1
Steps 1–4 pin record/drain, freshness, and inline-child reactivation). Leave only
the pure-cursor cases re-homed in Step 6b.

Run:
```bash
pnpm --filter @rundown-org/cli test -- transitions-explicit-target
pnpm --filter @rundown-org/core test -- lifecycle-command-service
```

Expected: PASS (cursor coverage preserved CLI-side; drive coverage preserved in
core).

- [ ] **Step 7: Route pass/fail through the seam and delete dead CLI logic**

Replace the CLI resolve/gate/drive orchestration with a single `runTransition`
call constructed with the seam dependencies (including a `loadSteps` that wraps
`getRunbookFromState(state, cwd)` — the closure carries `cwd`, the helper
registry, and the render context). Map the seam's `LifecycleTransitionOutcome`
variants to the existing JSON/text renderers and exit codes, and run the
execution loop per the returned `loop` directive. Then **delete** the now-dead
CLI logic:

- `reactivateRunningInlineChild` and `findRunningInlineChildRunId`
  (`transitions.ts:426-467`) — reactivation now lives in the seam;
- the redundant `resolveTransitionTarget` + `getRunbookFromState` pre-call where
  it existed only to feed the seam (collect and other base-path callers keep
  `buildTransitionContext` as needed).

**Preserve the post-transition parent-propagation/exit-code block.** The subtlest
part of pass/fail is `transition-command.ts:200-219` (run *after* the transition):
`extractParentLinkage(freshState)` → `propagateChildTerminal(...)`, with the exit
resolution at `:220-227` (inline children flip exit 1 on a propagated STOP;
delegation children report-only and never flip it; a parent that HANDLES a child
failure clears the code to exit 0). This block currently keys off `ctx.state.id`
and `ctx.manager`; after `executeTransition` is gutted, re-point it at the seam
outcome's `runId` (reload via the same manager) so it is **not** lost. Step 5
pins it as a test; this step must keep the block itself, not just "map exit
codes".

Do not drop explicit `--step` / `--index`, manual completion/drain, terminal
claim confirm/conflict, transition observations, or execution-loop continuation.

- [ ] **Step 7b: Rewrite the `delegation-propagation` atomic re-check through the seam**

`delegation-propagation.test.ts` has one test — "refuses the parent advance when
a claim lands after resolution but before the decisive write" (~265–324) — that
calls `executeTransition(contextResult.ctx, createPassTransitionConfig())`
directly to drive the atomic re-check. With `executeTransition` gutted, rewrite
that call to drive the bare `pass` through the seam instead (e.g. a bare
`runCliInProcess('pass', workspace)` after the racing `claim`, or a direct
`runTransition({ command: 'pass', targetSelector: { kind: 'default' }, … })`
matching how Step 7 wires the adapter). The behaviour under test is unchanged —
`runGuardedParentAdvance` still closes the TOCTOU window inside the seam — so keep
the assertions intact: the transition refuses with an `OPEN_DELEGATED_CHILDREN`
error event carrying `details.claimIds === [claimId]`, and the parent does **not**
advance (`parent.step === '1'`, no substep marked `done`). Only the call shape
changes; do not weaken the race setup (claim must still land after the pre-check,
before the decisive write).

Run:
```bash
pnpm --filter @rundown-org/cli test -- delegation-propagation
```

Expected: PASS.

- [ ] **Step 8: Retire `directCliCompatibility` in the same commit**

With the bare pass/fail path now flowing through the seam (`CallerEvidence` →
`actorContextFromEvidence`), the last `directCliCompatibility: true` consumer at
`transitions.ts:291` is gone. Delete the `directCliCompatibility` field from
`ResolveTransitionTargetOptions` and the
`directCliCompatibility ? trustedRunControllerContext(...) : UNKNOWN_ACTOR_CONTEXT`
branch in `command-target-resolver.ts` (the parallel trusted-controller mapping).
Update `command-target-resolver.test.ts` to drop the option. Removal and
last-consumer migration land together so the build never has a window with a
dangling excess property or a refused bare transition.

- [ ] **Step 9: Run focused tests**

Run:
```bash
pnpm --filter @rundown-org/core test -- lifecycle-command-service command-target-resolver
pnpm --filter @rundown-org/cli test -- pass fail transitions-explicit-target delegation-propagation
pnpm run test:integration
pnpm run test:scenarios:all
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts \
        packages/core/src/runbook/command-target-resolver.ts \
        packages/core/src/runbook/index.ts \
        packages/core/__tests__/runbook/lifecycle-command-service.test.ts \
        packages/core/__tests__/runbook/command-target-resolver.test.ts \
        packages/cli/src/helpers/transitions.ts \
        packages/cli/src/helpers/transition-command.ts \
        packages/cli/__tests__/commands/pass.test.ts \
        packages/cli/__tests__/commands/fail.test.ts \
        packages/cli/__tests__/helpers/transitions-explicit-target.test.ts \
        packages/cli/__tests__/integration/delegation-propagation.test.ts
git commit -m "refactor: route pass fail through lifecycle seam, extract cursor parser, move inline reactivation to core, retire directCliCompatibility"
```

## Task 8: Update descriptive architecture docs after code lands

**Files:**
- Modify: `docs/internal/architecture.md`
- Modify: `docs/superpowers/issues/2026-06-28-lifecycle-command-seam-contract.md`
- Modify: `CLAUDE.md` or `AGENTS.md` source if applicable

- [ ] **Step 1: Update current-design docs**

After Tasks 1-7 land, document the new current boundary:

- direct CLI gathers native evidence and renders outcomes;
- core maps evidence, resolves policy, and drives the machine;
- XState guards do not perform cross-run IO/policy.
- plugin/MCP role-specific subprocess mutations either use the Task 5 explicit
  evidence boundary or are blocked/unknown; do not describe plugin/MCP as
  direct-CLI trusted callers.

- [ ] **Step 1b: Reconcile the Task-3 contract snapshot with Option B**

The Task-3 contract (`2026-06-28-lifecycle-command-seam-contract.md`) still lists
`steps: readonly ResolvedStep[]` as a *required seam input*. Option B (Task 7)
removed it: the seam now derives steps in-seam via the injected `loadSteps(state)`
dependency. The contract is a point-in-time snapshot, not a binding API, but
reconcile it so a later reader is not misled — note that `steps` moved from a
`runTransition` input to a `RunbookLifecycleCommandServiceDependencies.loadSteps`
callable, and that inline-child reactivation is now a core (`#driveSubstep`)
behaviour rather than a CLI pre-check. Add a dated "Superseded by Option B" note
rather than silently rewriting the original contract.

- [ ] **Step 2: Run docs checks**

Run:
```bash
pnpm run check:spell
pnpm run check:format
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/internal/architecture.md \
        docs/superpowers/issues/2026-06-28-lifecycle-command-seam-contract.md \
        CLAUDE.md AGENTS.md
git commit -m "docs: record cross-run policy boundary"
```

## Verification

Before pushing:

```bash
pnpm run verify
pnpm run test:integration
pnpm run test:scenarios:all
pnpm run test:mutate:core -- --mutate src/runbook/actor-context.ts,src/runbook/lifecycle-command-service.ts
```

`test:mutate:core` runs `stryker run` with cwd `packages/core/`, and
`stryker.config.mjs` uses package-relative `mutate` globs (`src/**/*.ts`). The
`--mutate` paths MUST therefore be package-relative (`src/runbook/...`). Passing
repo-root-relative `packages/core/src/...` resolves to
`packages/core/packages/core/src/...`, matches nothing, and the gate passes
vacuously — the exact false-green this gate exists to prevent.

Expected: PASS.
