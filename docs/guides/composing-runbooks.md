# Composing Runbooks

How independent, single-artifact runbooks combine into multi-stage workflows. This guide covers *inter*-runbook composition; for *intra*-runbook conventions see [writing-runbooks/house-style.md](../../packages/claude-code-plugin/skills/writing-runbooks/house-style.md), and for delegation mechanics see [agent-orchestration.md](agent-orchestration.md).

The worked example throughout is the planning pipeline: `planning.runbook.md` composes `write-plan` → `review-plan` → `execute-plan`.

## Pattern 1 — Workflow pipeline (artifact handoff)

Stages run in sequence in a shared `ContextId`. Each stage declares what it publishes via frontmatter `OUTPUTS`; the next declares `INPUTS` / `REQUIRED` and rehydrates a naked `ARTIFACTS` alias. `write-plan` publishes `PlanPath`; `review-plan` and `execute-plan` consume it. Never re-derive a child's output path in the parent — consume its declared `OUTPUTS`.

## Pattern 2 — Leaf-delegate, orchestrator-compose (the RD-819 discipline)

A delegated (claimed) child cannot delegate further (`RD-819 DELEGATION_NESTED_FORBIDDEN`). So **delegate only leaves; compose any stage that itself delegates or fans out.** Decision test: *does this child delegate? → compose it (list it inline / `rd run`). Is it a terminal worker? → delegate it (`- DELEGATE`).* In `planning.runbook.md` this is visible in one file: step 1 delegates `write-plan` (a leaf); steps 2–3 compose `review-plan` and `execute-plan` (both delegate internally).

## Pattern 3 — Fan-out + collate

A composed stage delegates N sibling analysis runbooks, then delegates a collation runbook that gathers them with a wildcard artifact or `rdpath find`, deduplicates, and validates against the shared schema. `review-plan` delegates four reviewers then `review-plan-collate`. Never collate from the parent.

## Pattern 4 — Gate loop (iterate-until-clean)

A composed stage holds work behind a gate and `FAIL GOTO`s a focused fix step until the gate is met. The runbook's value here is the **loop shape** — *refusing to advance* until a step renders a passing verdict, and routing every failure to one small, convergent fix step. What that verdict *is* is the author's choice; the gate can be machine-checkable or agent-judged:

- **Command gate (machine-checkable):** a step runs a command and its exit code is the verdict — e.g. `execute-plan`'s **verify gate** (`npm run verify`; red routes to the fix step). Use this when the gate is mechanically decidable and you want enforcement an agent prompt cannot soften.
- **Verdict gate (agent-judged):** a delegated child *owns its own verdict* and reports it as its terminal status — `COMPLETE` → `pass`, `STOP` → `fail`. `execute-plan`'s **review gate** is this: `code-review` ends in a prompted step where the agent judges its recorded review and passes (clean) or stops (blocking findings). The parent reads only the delegation result — `PASS ALL GOTO` verify, `FAIL ANY` falls to the fix step — and never inspects the review JSON. The trade-off is deliberate: an agent *can* rationalize a pass, so reach for a verdict gate when the judgment is inherently qualitative (code review, design sign-off) and a command gate when it isn't.

Both gates `GOTO` a single dedicated fix leaf (`address-review`), so each iteration is small and convergent. `GOTO` loops have no engine-level iteration cap — the fix step's body tells the agent when to escalate rather than spin.

The verdict-gate form leans on the engine's child-status mapping (a delegated child's `COMPLETE`/`STOP` becomes the parent's `pass`/`fail`). Keeping the verdict *inside* the child — rather than re-deriving it in the parent — also keeps the encapsulation rule of "never re-derive a child's output in the parent" intact: the review owns both its artifact and its verdict.

## Pattern 5 — Top-level workflow runbook

A thin parent that sequences pipeline stages with explicit aggregation (`- PASS ALL ...` / `- FAIL ANY ...`) and terminates when the final stage completes. `planning.runbook.md` is four frontmatter lines plus three composition steps; all the work lives in the leaves it composes.

## Passing data to a delegated child

A delegated child inherits the shared **artifacts** (e.g. `PlanPath`) and persisted **template variables**. This is the handoff to reach for: produce an artifact upstream, declare it `REQUIRED` in the child, rehydrate it with a naked `ARTIFACTS` alias. `execute-plan` hands the whole plan to `implement-plan` this way and nothing else crosses.

## Future work — iterate-and-delegate (FOR + DELEGATE per item)

The intuitive "loop a data source, delegate one worker per item" has two sharp edges, both validated against the engine. Until there is a first-class pattern for them, the planning pipeline deliberately keeps the per-task walk inside the agent + the [executing-plans](../../packages/claude-code-plugin/skills/executing-plans/SKILL.md) skill rather than expressing it as `FOR`.

1. **A `FOR` source must resolve at the launch of the runbook that contains the `FOR`.** Launch-time validation rejects a `FOR` over a variable or artifact the same runbook produces in an earlier step (`VALIDATION_ERROR: FOR loop references undefined variable`); a frontmatter `inputs:` declaration is not a value. The workaround is to have a *parent* populate the source (via `OUTPUTS`, which needs no seed) and compose a child that iterates the inherited, already-populated source.

2. **The loop variable and `Index` do not cross the delegation boundary.** A delegated child inherits the whole array (and supports index-in like `{{ Tasks.0.name }}`) but not the per-iteration loop variable or `Index`. Passing per-item data to a delegated child therefore needs explicit `--input` forwarding or a per-iteration artifact.

The syntax for `FOR` + `DELEGATE` lives in the parser/core fixtures under `runbooks/for-loops/` and `runbooks/delegation/`.
