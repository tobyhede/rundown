---
name: delegating-runbooks
description: Use when orchestrating multi-agent work through rundown delegation, dispatching substeps to child agents, or managing delegation tokens
---

# Delegating Work

Rundown delegation dispatches substeps to child agents. The parent delegates, a child claims the work, executes it, and reports back. The plugin automates token detection and claim injection.

## Quick Reference

```
rd delegate                                # Infer substep and runbook from state
rd delegate --step 2.1                     # Delegate specific substep
rd delegate <runbook> --step 2.1           # Explicit runbook and substep
rd delegate --step 2.1 --var k=v           # With variables
rd delegate --step 2.1 --var-json k=json   # With JSON variable
rd delegate --step 2.1 --var-file <path>   # Variables from YAML

rd abort <token>                      # Cancel unclaimed delegation
rd abort <token> --force              # Cancel claimed delegation

rd status                             # Monitor delegation state (JSON by default)
```

## Delegation Flow

```
Parent                          Child
  |                               |
  |  rd delegate --step 2.1       |
  |  --> token issued             |
  |                               |
  |  Dispatch agent with token    |
  |  -------------------------→   |
  |                               |  rd claim <token>
  |                               |  (plugin injects automatically)
  |                               |
  |                               |  ... does work ...
  |                               |
  |                               |  rd pass (or rd fail)
  |  ←-------------------------   |
  |  Result propagates to step    |
  |                               |
```

## Step-by-Step

### 1. Delegate a substep

```bash
# Infer everything from current state
rd delegate

# Explicit substep
rd delegate --step 2.1

# Explicit runbook + substep
rd delegate my-runbook --step 2.1

# With variables
rd delegate --step 2.1 --var environment=staging
rd delegate --step 2.1 --var-json config='{"debug":true}'
```

The `delegate` command issues a token (`rdtk_...`) and queues the substep for external execution.

**Constraints:**
- `--step` must target the active step frontier
- When the active step has substeps, bare step IDs (e.g., `2`) are rejected — use qualified IDs (e.g., `2.1`)
- In FOR loops, delegation defaults to the active iteration — use `--index` to target a specific iteration

### 2. Dispatch a child agent

Dispatch a subagent whose prompt contains the delegation token:

```
Agent(
  description="2.1 - Code review",
  prompt="Review the implementation. RD_CLAIM_TOKEN=rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  subagent_type="code-review-agent"
)
```

Include `RD_CLAIM_TOKEN=rdtk_...` anywhere in the prompt. The plugin detects the token and injects claim instructions into the child's context.

### 3. Child claims and executes

The child agent runs `rd claim <token>`, which starts the delegated runbook. The child then follows normal [runbook execution](../running-runbooks/SKILL.md) — follow steps, pass/fail.

```bash
rd claim <token>
rd claim <token> --var key=value
rd claim <token> --var-json key=json
rd claim <token> --var-file path
# ... work through steps ...
rd pass                # Report success
```

### 4. Result propagates

When the child calls `rd pass` or `rd fail`, the result flows back to the parent's substep. The parent step's aggregation rules determine the overall outcome.

## FOR Loop Delegation

Without `--index`, delegation targets the active iteration. Use `--index` to target a specific iteration:

```bash
rd delegate --step 2.1 --index 3
```

Each iteration maintains independent delegation state, so iterations can be delegated to different agents for parallel processing.

## Aborting Delegations

Cancel a delegation when the child agent fails, gets stuck, or the work is no longer needed:

```bash
rd abort <token>           # Cancel unclaimed delegation
rd abort <token> --force   # Cancel already-claimed delegation
```

- **Unclaimed**: token is cancelled, substep reverts to un-delegated state
- **Claimed**: requires `--force` since a child is actively working; the child's next CLI call will fail

## Variable Pass-Through

`ContextId` provides shared identity across a delegation tree — children inherit the parent's ContextId automatically via `--var`. Override for meaningful names: `--var ContextId=sprint-42`. Each child gets its own `RunId`; use `ContextId` to correlate across the tree.

## Context Passing (INPUTS / OUTPUTS)

`ContextId` inheritance enables data to flow between steps via OUTPUTS and INPUTS — no manual variable threading required.

**How it works:**
1. A parent step writes values with OUTPUTS when that step or substep transition completes → stored in the live runbook variable space
2. A child runbook (or subsequent step) declares INPUTS → values are injected from the inherited live variable space
3. A completed child runbook writes frontmatter `outputs:` to `state.finalVars`, and the parent automatically merges those into its own live runbook variable space

**Key rules:**
- Step OUTPUTS fire on both PASS and FAIL when the completing step declares outputs
- Frontmatter `outputs:` fire on both `COMPLETE` and `STOPPED`
- INPUTS sit below CLI `--var` in precedence — `--var` always wins
- Frontmatter `inputs:` inject at runbook startup (before step 1)
- `required:` causes a hard error if the variable is missing from all sources

**Example — write-plan produces PlanPath, review-plan consumes it:**

```markdown
## 8. Write the plan          ← in write-plan.runbook.md
- OUTPUTS
  - PlanPath {{ path "plan.json" }}
- PASS CONTINUE
- FAIL STOP
```

```yaml
# review-plan.runbook.md frontmatter
required:
  - PlanPath
inputs:
  PlanPath:
```

```markdown
## 1. Load plan               ← in review-plan.runbook.md
- PASS CONTINUE
- FAIL STOP

Read the plan from `{{ PlanPath }}`.
```

When `write-plan` is delegated first and `review-plan` is delegated second under the same parent's variable space, `PlanPath` flows automatically via the forwarded `--var` flags — no manual threading needed.

## Patterns

**Sequential:** Delegate substeps one at a time, waiting for each result before delegating the next.

**Parallel fan-out:** Delegate multiple substeps simultaneously — all children work concurrently, parent aggregates results via ALL/ANY:

```bash
rd delegate --step 2.1
rd delegate --step 2.2
rd delegate --step 2.3
```

**Nested:** A child can itself delegate, creating a delegation tree. ContextId flows through the tree for correlation.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `--step 2` when substeps exist | Use qualified ID: `--step 2.1` |
| `rd abort` on claimed token | Add `--force` for already-claimed tokens |
| Overriding ContextId unnecessarily | Children inherit automatically; only pass `--var ContextId=...` to override with a meaningful name |

## Reference

- [Subagent delegation](../../../../docs/AGENT-ORCHESTRATION.md)
- [Delegation patterns](../../../../runbooks/delegation/)
- [Rundown specification](../../../../docs/SPEC.md)
- [CLI reference](../../../../CLAUDE.md)
