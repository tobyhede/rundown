# Composing Runbooks — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming)
**Author:** Toby Hede

## Goal

Establish reusable **composition patterns** for Rundown runbooks, and prove them by
building the full **plan → review → execute → verify** workflow. Today `write-plan`
and `review-plan` exist, but there is no execute stage and `planning.runbook.md` is a
broken stub. This work codifies how runbooks compose into multi-stage workflows and
delivers the missing execute capability as the worked example.

Rundown's purpose is orchestrating workflow. Composition is how independent,
single-artifact runbooks combine into a larger flow without re-deriving each other's
internals — the patterns make that combination consistent and correct.

## Background — what exists today

- **List composition.** A parent step lists child runbook paths; they run inline, or
  with `- DELEGATE` they fan out to subagents.
- **Fan-out + collate.** `review-plan.runbook.md` delegates four reviewer runbooks
  (step 3) then a collation runbook (step 4).
- **Artifact handoff.** A child's frontmatter `OUTPUTS` forwards into the shared
  `ContextId`; the next stage declares `INPUTS`/`REQUIRED` and rehydrates
  (`write-plan` → `PlanPath` → `review-plan`).

### The constraint that governs composition — RD-819 (single-level delegation)

A *delegated* (claimed) child runbook may not delegate further (`createDelegation`
refuses with `RD-819 DELEGATION_NESTED_FORBIDDEN`). When a claimed child needs another
runbook it must **compose** via `rd run` in a substep body — composition is
unrestricted; delegation is single-level.

This is already implicit in `planning.runbook.md`: `write-plan` uses `- DELEGATE`, but
`review-plan` is composed inline — it *has* to be, because `review-plan` itself
delegates its four reviewers. The undocumented discipline:

> **Delegate leaves; compose orchestrators.** Only terminal work-doing runbooks get
> `- DELEGATE`. Any stage that itself fans out must be composed (inline list / `rd
> run`), never delegated.

### The gaps

1. `planning.runbook.md` is a stub — frontmatter `name: End-to-End Test`, body copied
   from the e2e test; not a plan→review→execute flow, no `INPUTS`/`OUTPUTS` contract.
2. No execute stage — no `execute-plan` runbook and no `executing-plans` skill (the
   superpowers flow has `executing-plans` + `subagent-driven-development`; rundown
   stops at plan + review).
3. The composition patterns are written down nowhere — `writing-runbooks/house-style.md`
   covers *intra*-runbook artifact pipelines; *inter*-runbook composition is not codified.

## Components

### 1. Composition patterns guide — `docs/guides/composing-runbooks.md`

A new guide (sibling to `docs/guides/agent-orchestration.md`, which already holds the
delegation *mechanics*), cross-linked from `writing-runbooks/house-style.md`. It
documents five patterns, each with a minimal example and the rule behind it. The
guide cites the rebuilt `planning.runbook.md` and the execute-stage runbooks as the
canonical worked examples.

| # | Pattern | Rule / example |
|---|---------|----------------|
| 1 | **Workflow pipeline (artifact handoff)** | Stages run in sequence; each stage's frontmatter `OUTPUTS` forwards into the shared `ContextId`; the next stage declares `INPUTS`/`REQUIRED` and rehydrates. `write-plan → PlanPath → review-plan / execute-plan`. |
| 2 | **Leaf-delegate, orchestrator-compose** (the RD-819 discipline) | Delegate only terminal work-doing runbooks; compose any stage that itself fans out or delegates. Decision test: *does this child delegate? → compose it. Is it a leaf? → delegate it.* |
| 3 | **Fan-out + collate** | A composed stage delegates N sibling analysis runbooks, then a collation runbook (`review-plan`). |
| 4 | **Gate loop / iterate-until-clean** | A composed stage holds work behind a gate and `FAIL GOTO`s a focused fix step until the gate is met — the runbook's value is the loop shape: *refusing to advance* until a passing verdict. The gate may be a **command** (exit code is the verdict — `execute-plan`'s `npm run verify`) or a **delegated verdict** (a child owns its verdict and reports it as terminal status; `COMPLETE`→pass, `STOP`→fail — `execute-plan`'s `code-review`, which ends in a prompted gate the agent judges). The parent reads the delegation result, not the review JSON. |
| 5 | **Top-level workflow runbook** | A thin parent that sequences pipeline stages with explicit aggregation (`planning.runbook.md`). |
| — | *Documented, not yet dogfooded:* **iterate-and-delegate** (FOR + DELEGATE per item) | The intuitive "loop a data source, delegate one worker per item" has two sharp edges validated by spike (see [Mechanism constraints](#mechanism-constraints-validated)): a `FOR` source must resolve at the **launch** of the runbook that contains the `FOR` (a runbook cannot iterate data it produces itself), and the loop variable + `Index` **do not cross the delegation boundary** (only inherited artifacts/template vars do). The guide documents the pattern, both constraints, and the orchestrator-extracts / explicit-`--input`-forward workarounds, flagged future work and pointing at the root `runbooks/for-loops/` + `runbooks/delegation/` fixtures. The first-pass execute stage deliberately avoids it. |

### 2. The execute stage (dogfood-converted from superpowers)

The task walk stays in the agent + skill; Rundown owns the **gates**. The agent is
already good at "for each task, do the steps" (the superpowers `executing-plans` skill
*is* that prompt). What an agent is bad at is stopping too early — declaring work done
on a dirty review or red tests. `execute-plan` therefore does **not** re-encode the
task iteration as `FOR`; it delegates the whole implementation, then loops review and
verify gates until they pass. This sidesteps both mechanism constraints above and
relies only on proven mechanisms (compose, delegate-fan-out-collate, `FAIL GOTO`, and
artifact inheritance across delegation).

Use the `converting-skills-to-runbooks` skill to distill the superpowers
`executing-plans` + `subagent-driven-development` skills into:

- **`executing-plans` skill** (`skills/executing-plans/`) — the *context*: the per-task
  walk (mark in-progress → follow the plan's bite-sized steps → run verifications →
  commit → mark complete), commit discipline, and when to escalate. Cross-links, does
  not restate, `writing-runbooks` / `running-runbooks` / `delegating-runbooks`.
- **`execute-plan.runbook.md`** (`runbooks/planning/`, composed orchestrator) —
  `skill: executing-plans`, `INPUTS:[PlanPath]` / `REQUIRED:[PlanPath]`,
  `OUTPUTS:[CodeReviewPath]`:
  1. Invoke & read the `executing-plans` skill; bind the review schema read-only;
     rehydrate `PlanPath`.
  2. **Implement** — `- DELEGATE implement-plan.runbook.md`. The delegated leaf walks
     all tasks. The only data crossing the boundary is the `PlanPath` artifact — the
     exact, proven handoff the e2e runtime test already exercises.
  3. **Code review** — `- DELEGATE code-review.runbook.md` → `CodeReviewPath`. The
     review owns its verdict: a clean review `COMPLETE`s (→ parent `pass`) and jumps to
     Verify; a review with blocking findings `STOP`s (→ parent `fail`) and falls through
     to Address. `PASS ALL GOTO` step 5 (verify) / `FAIL ANY CONTINUE`. The parent reads
     only the delegation result — it never inspects the review JSON.
  4. **Address findings** — `- DELEGATE address-review.runbook.md` (the dedicated fix
     leaf, given `PlanPath` + `CodeReviewPath`). Loops back to step 3 (re-review) on
     success; `FAIL ANY STOP` if it cannot resolve in scope. A dedicated leaf — not a
     re-run of `implement-plan` — so a fix touches only the findings, and no runbook
     carries an optional/unbound `CodeReviewPath`.
  5. **Verify** — `npm run verify`; `PASS COMPLETE` / `FAIL GOTO` step 4 until green.

  `CodeReviewPath` is produced (and schema-validated) by the delegated `code-review`
  leaf and re-exported via `execute-plan`'s frontmatter `OUTPUTS`.
- **`implement-plan.runbook.md`** (`runbooks/planning/`, delegated leaf) —
  `INPUTS:[PlanPath]` / `REQUIRED:[PlanPath]`: invoke the `executing-plans` skill, read
  `{{ path PlanPath }}`, walk every task per the skill (committing per task as the
  plan's `commit` blocks direct). A claimed child, so it **cannot delegate**.
- **`code-review.runbook.md`** (`runbooks/planning/`, delegated leaf) —
  `INPUTS:[PlanPath]` / `REQUIRED:[PlanPath]`, `OUTPUTS:[CodeReviewPath]`: review the
  implemented changes against the plan, write `CodeReviewPath` validated against
  `review.schema.json` (produce → validate → retry), then **own the verdict** in a final
  prompted gate — `PASS COMPLETE` (clean) / `FAIL STOP` (blocking findings). The verdict
  is agent judgment over the recorded review, not a machine count, so the review carries
  both its artifact and its pass/fail signal across the delegation boundary. Single
  reviewer for the first pass; dimension fan-out (mirroring `review-plan`) is future work.
- **`address-review.runbook.md`** (`runbooks/planning/`, delegated leaf) —
  `skill: executing-plans`, `INPUTS:[PlanPath, CodeReviewPath]` /
  `REQUIRED:[PlanPath, CodeReviewPath]`: read the recorded `error`-level findings and
  resolve them, committing the fix. The `GOTO` target of the code-review verdict and the
  verify gate. A claimed child, so it **cannot delegate**.

The plan task shape is fixed by `schemas/plan.schema.json`: each task is
`{ name, files, subtasks, commit }`; the implementer reads them directly from the plan.

### 3. Rebuilt `planning.runbook.md` (the worked example)

Replace the stub with the true pipeline. Frontmatter declares the contract
(`OUTPUTS:[PlanPath, ReviewPlanPath, CodeReviewPath]`). Steps, each stating aggregation
explicitly and threading `PlanPath` through the shared context:

1. **Write plan** — `- DELEGATE` (leaf), `planning/write-plan.runbook.md`.
2. **Review plan** — composed inline (it fans out), `planning/review-plan.runbook.md`.
3. **Execute plan** — composed inline (it delegates + loops gates),
   `planning/execute-plan.runbook.md`. The `npm run verify` gate lives inside
   `execute-plan`, so the pipeline terminates on execute completion.

This makes the leaf-delegate / orchestrator-compose discipline visible in one file:
step 1 delegates (leaf); steps 2–3 compose (orchestrators).

## FOR + delegation semantics (validated)

Two mechanisms were confirmed by live spikes against the built CLI and are now
exercised by the `iterate-and-delegate` pattern:

1. **A `FOR` source resolves at step entry, not at launch.** A runbook may
   `FOR`-iterate a data source it produces itself in an earlier step; the source is
   resolved when the `FOR` step is entered, so no upstream seed or parent populate is
   required. (`runbooks/patterns/iterate-and-delegate.runbook.md` captures `Items`
   via `OUTPUTS` in step 1 and loops it in step 2.)
2. **Iteration bindings cross the delegation boundary.** Within a `FOR` step a
   delegated child inherits `Index` unconditionally, and the loop variable when the
   child declares that name in its frontmatter `inputs` (language spec §10.4); an
   explicit `--input` of the same name still overrides the inherited binding. A child
   that does not declare the loop variable does not receive it.

## Data flow

`planning` (context C) →
`write-plan` [delegated] writes `PlanPath` artifact in C, exports via frontmatter
`OUTPUTS` →
`review-plan` [composed] rehydrates `PlanPath`, fan-out reviewers → collate →
`ReviewPlanPath` →
`execute-plan` [composed] rehydrates `PlanPath` → `implement-plan` [delegated] reads
`PlanPath`, walks tasks → `code-review` [delegated] writes `CodeReviewPath` and reports
its own verdict (`COMPLETE`/`STOP`) → that verdict + `npm run verify` loops
(`FAIL GOTO` address-findings) → `COMPLETE`.

## Error handling

- Each artifact-producing runbook keeps its produce → validate → retry loop
  (`FAIL GOTO <write-step>`).
- `execute-plan`'s code-review verdict and verify gate `FAIL GOTO` a focused **address-findings**
  step (never back to implement), so each loop iteration is small and convergent.
  `GOTO` loops have no engine-level max-iteration cap — the step body instructs the
  agent when to escalate rather than spin.
- Stage failures propagate as themselves (`STOP`) — no silent downgrade.
- No new core/CLI delegation semantics; patterns operate within today's RD-819 model.

## Testing

- **Static.** `rd check` every new/changed runbook. Extend
  `__tests__/runbooks/validation.test.ts` to pin the rebuilt `planning.runbook.md`
  structure (it currently asserts nothing about it) and the `execute-plan` /
  `implement-plan` / `code-review` contracts (`INPUTS`/`OUTPUTS`, the delegate frontiers
  on implement + review + address, that the code-review verdict and verify gate `GOTO`
  the address-findings step, and that `code-review` ends in a prompted verdict gate).
- **Mechanic / runtime.** A small fixture plan JSON → drive `execute-plan` in prompted
  mode and assert it (a) issues a delegation token for `implement-plan` carrying the
  inherited `PlanPath`, (b) issues a token for `code-review`, and (c) the review-clean /
  verify gate steps resolve their `GOTO` targets — a runtime integration test alongside
  the existing `end-to-end-test-runtime` integration test.
- **Dogfood validation.** The converted `executing-plans` skill + runbooks pass
  `rd check` and the `converting-skills-to-runbooks` checklist (backbone coverage,
  no-duplication scan, contract consistency).
- `npm run verify` passes (format, spell, lint, test).

## Out of scope (YAGNI)

- No changes to `@rundown-org/core`, `cli`, or `parser` delegation/FOR semantics — the
  patterns work within today's RD-819 single-level model.
- **No `FOR`-based per-task delegation in the execute stage** — the task walk lives in
  the agent + skill for the first pass. Iterate-and-delegate is documented (with its two
  validated constraints) but not dogfooded; per-task isolation and per-task review
  checkpoints are future work.
- No code-review dimension fan-out yet — `code-review` is a single delegated reviewer;
  the `review-plan`-style fan-out + collate is future work.
- Not converting every superpowers skill — only `executing-plans` /
  `subagent-driven-development` for the execute stage.

## Success criteria

1. `docs/guides/composing-runbooks.md` documents the patterns (incl. the gate loop and
   the documented-not-dogfooded iterate-and-delegate with its two constraints) and is
   cross-linked from `writing-runbooks/house-style.md`.
2. `executing-plans` skill + `execute-plan.runbook.md` + `implement-plan.runbook.md` +
   `code-review.runbook.md` + `address-review.runbook.md` exist, follow house style, and
   pass `rd check` + the conversion checklist.
3. `planning.runbook.md` is a correct `write → review → execute` pipeline (no stub
   frontmatter/body) with explicit aggregation and `PlanPath` threading; the verify gate
   lives inside `execute-plan`.
4. `validation.test.ts` pins the new/rebuilt runbook structures; a runtime test
   exercises `execute-plan`'s delegate-implement + code-review + gate-loop wiring.
5. `npm run verify` passes.

## Dependencies

Builds on the `converting-skills-to-runbooks` skill (PR #432, branch
`feat/converting-skills-to-runbooks`). This work branches from it; rebase onto `main`
after #432 merges.
