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
| 2 | **Leaf-delegate, orchestrator-compose** (the RD-819 discipline) | Delegate only terminal work-doing runbooks; compose any stage that itself fans out. Decision test: *does this child delegate? → compose it. Is it a leaf? → delegate it.* |
| 3 | **Fan-out + collate** | A composed stage delegates N sibling analysis runbooks, then a collation runbook (`review-plan`). |
| 4 | **Iterate-and-delegate** (FOR + DELEGATE per item) | Loop a data source, delegate one worker runbook per iteration, aggregate, then a terminal review (`execute-plan`). |
| 5 | **Top-level workflow runbook** | A thin parent that sequences pipeline stages with explicit aggregation and terminates in a verify (`planning.runbook.md`). |
| — | *Supporting:* **data-source extraction** | Turn a structured artifact (plan JSON object) into a FOR data source (`tasks.jsonl`) with an extraction step. |

### 2. The execute stage (dogfood-converted from superpowers)

Use the `converting-skills-to-runbooks` skill to distill the superpowers
`executing-plans` + `subagent-driven-development` skills into:

- **`executing-plans` skill** (`skills/executing-plans/`) — the *context*: per-task
  TDD cycle, commit discipline, review gates, when to escalate. Cross-links, does not
  restate, `writing-runbooks` / `running-runbooks` / `delegating-runbooks`.
- **`execute-plan.runbook.md`** (`runbooks/planning/`) — `skill: executing-plans`,
  `INPUTS:[PlanPath]` / `REQUIRED:[PlanPath]`, `OUTPUTS:[CodeReviewPath]`:
  1. Invoke & read the `executing-plans` skill.
  2. Bind the plan schema read-only.
  3. **Extract tasks** — read `{{ path PlanPath }}`, write `.tasks` to a `TasksPath`
     `tasks.jsonl` artifact (one task object per line) via a bash/jq step.
  4. **`FOR task IN {{ TasksPath }}`** with a single `### implement-task` substep
     marked `- DELEGATE`; iteration transitions `PASS DEFER` / `FAIL DEFER`. Tasks run
     sequentially (ordering preserved); each is delegated to a fresh subagent.
  5. **Review at end** — one review/verify stage after the loop (composed; may itself
     fan out across review dimensions since `execute-plan` is composed, not delegated),
     writing `CodeReviewPath` validated against `review.schema.json`.
  6. **Verify gate** — build/tests pass (`PASS COMPLETE` / `FAIL GOTO` the review step).
- **`implement-task.runbook.md`** (`runbooks/planning/`) — the delegated leaf,
  `INPUTS` for the task fields it needs: TDD a single task (write failing test → run →
  implement → run → commit). It is a claimed child, so it **cannot delegate**; any
  internal review uses `rd run` composition.

The plan task shape is fixed by `schemas/plan.schema.json`: each task is
`{ name, files, subtasks, commit }`; dotted access (`{{ task.name }}`) works because
`.jsonl` items parse as JSON objects.

### 3. Rebuilt `planning.runbook.md` (the worked example)

Replace the stub with the true pipeline. Frontmatter declares the contract
(`OUTPUTS:[PlanPath, ReviewPlanPath, CodeReviewPath]` as applicable). Steps, each stating aggregation
explicitly and threading `PlanPath` through the shared context:

1. **Write plan** — `- DELEGATE` (leaf), `planning/write-plan.runbook.md`.
2. **Review plan** — composed inline (it fans out), `planning/review-plan.runbook.md`.
3. **Execute plan** — composed inline (it iterates + delegates),
   `planning/execute-plan.runbook.md`.
4. **Verify** — build/tests pass; terminal.

This makes the leaf-delegate / orchestrator-compose discipline visible in one file:
step 1 delegates (leaf); steps 2–3 compose (orchestrators).

## Data flow

`planning` (context C) →
`write-plan` [delegated] writes `PlanPath` artifact in C, exports via frontmatter
`OUTPUTS` →
`review-plan` [composed] rehydrates `PlanPath`, fan-out reviewers → collate →
`ReviewPlanPath` →
`execute-plan` [composed] rehydrates `PlanPath`, extracts `TasksPath`, `FOR task` →
`implement-task` [delegated] per task → end code review → `CodeReviewPath` → verify.

## Error handling

- Each artifact-producing runbook keeps its produce → validate → retry loop
  (`FAIL GOTO <write-step>`).
- `FOR`+`DELEGATE` iteration transitions use `DEFER`; aggregation resolves on the
  parent step. Per-iteration retry budgets apply (existing engine behaviour).
- Stage failures propagate as themselves (`STOP`) — no silent downgrade.
- No new core/CLI delegation semantics; patterns operate within today's RD-819 model.

## Testing

- **Static.** `rd check` every new/changed runbook. Extend
  `__tests__/runbooks/validation.test.ts` to pin the rebuilt `planning.runbook.md`
  structure (it currently asserts nothing about it) and the `execute-plan` /
  `implement-task` contracts (`INPUTS`/`OUTPUTS`, the `FOR`+`DELEGATE` frontier, the
  extraction step).
- **Mechanic / runtime.** A small fixture plan JSON → run `execute-plan` and assert the
  extraction produces `tasks.jsonl` and the `FOR` emits a `delegateFrontier` record per
  task — a runtime integration test alongside the existing `end-to-end-test-runtime`
  integration test.
- **Dogfood validation.** The converted `executing-plans` skill + runbooks pass
  `rd check` and the `converting-skills-to-runbooks` checklist (backbone coverage,
  no-duplication scan, contract consistency).
- `npm run verify` passes (format, spell, lint, test).

## Out of scope (YAGNI)

- No changes to `@rundown-org/core`, `cli`, or `parser` delegation/FOR semantics — the
  patterns work within today's RD-819 single-level model.
- No new retry/resume policy beyond what `FOR`+`DELEGATE` already provides.
- Not converting every superpowers skill — only `executing-plans` /
  `subagent-driven-development` for the execute stage.
- The execute stage delegates per task but does not parallelize tasks (ordering deps);
  parallel task execution is future work.

## Success criteria

1. `docs/guides/composing-runbooks.md` documents the five patterns with examples and
   is cross-linked from `writing-runbooks/house-style.md`.
2. `executing-plans` skill + `execute-plan.runbook.md` + `implement-task.runbook.md`
   exist, follow house style, and pass `rd check` + the conversion checklist.
3. `planning.runbook.md` is a correct `write → review → execute → verify` pipeline
   (no stub frontmatter/body) with explicit aggregation and `PlanPath` threading.
4. `validation.test.ts` pins the new/rebuilt runbook structures; a runtime test
   exercises the `execute-plan` extraction + `FOR`/`DELEGATE` frontier.
5. `npm run verify` passes.

## Dependencies

Builds on the `converting-skills-to-runbooks` skill (PR #432, branch
`feat/converting-skills-to-runbooks`). This work branches from it; rebase onto `main`
after #432 merges.
