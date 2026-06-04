---
name: delegating-runbooks
description: Use when orchestrating multi-agent work through rundown delegation, dispatching substeps to child agents, or managing delegation tokens
---

# Delegating Work

Rundown delegation dispatches substeps to child agents. The parent delegates, a child claims the work, executes it, and reports back. The plugin automates token detection and claim injection.

If you want the parent to walk the child runbook inline instead of dispatching a subagent, omit `- DELEGATE` — see the inline-linkage pattern in [running-runbooks](../running-runbooks/SKILL.md#nested-runbooks-inline-linkage).

## Quick Reference

```bash
rd delegate                                  # Infer substep and runbook from state
rd delegate --step 2.1                       # Delegate specific substep
rd delegate <runbook> --step 2.1             # Explicit runbook and substep
rd delegate --step 2.1 --input k=v           # With input
rd delegate --step 2.1 --input-json k=json   # With JSON input
rd delegate --step 2.1 --input-file <path>   # Inputs from YAML

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

# With inputs
rd delegate --step 2.1 --input environment=staging
rd delegate --step 2.1 --input-json config='{"debug":true}'
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

Also include the running-runbooks skill in the dispatched prompt so the child knows how to execute the claimed runbook:

```text
Skill(skill: "rundown:running-runbooks")
```

### 3. Child claims and executes

The plugin normally detects `RD_CLAIM_TOKEN=rdtk_...` in the child prompt and injects the claim instructions automatically. If automatic token injection is unavailable, or you are recovering manually, the child can run `rd claim <token>` to start the delegated runbook.

After claiming, the child follows normal [runbook execution](../running-runbooks/SKILL.md) — follow steps, pass/fail.

```bash
rd claim <token>
rd claim <token> --input key=value
rd claim <token> --input-json key=json
rd claim <token> --input-file path
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

Delegated runbooks automatically inherit available parent variables. Do not manually pass every variable as `--input`; add explicit inputs only when you intentionally want to change or add a value for the child.

Each child gets its own `RunId`. `ContextId` stays stable across the delegation tree so shared paths and correlation IDs continue to line up, including paths created with `{{ path "..." }}` under the same `.rd-<ContextId>/` directory. Override with `--input ContextId=sprint-42` only when you want a meaningful new shared context identifier.

Explicit inputs override inherited values:

```bash
rd delegate --step 2.1 --input environment=staging
rd delegate --step 2.1 --input-json config='{"debug":true}'
```

## Context Passing (OUTPUTS)

Outputs exported by a completed child become available as inherited inputs to later delegated children. Use this for handoffs such as "write a plan, then delegate review of that plan" without manually copying paths or values between delegations.

**Example — write-plan produces PlanPath, review-plan consumes it:**

```markdown
---
name: write-plan
OUTPUTS:
  - PlanPath
---

## 7. Output Path
- ARTIFACTS
  - PlanPath "plan.json"
- OUTPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

## 8. Write the plan
- PASS COMPLETE
- FAIL STOP

Write the plan to `{{ PlanPath }}`.
```

```markdown
---
name: review-plan
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
---

## 1. Load plan
- PASS CONTINUE
- FAIL STOP

Read the plan from `{{ PlanPath }}`.
```

When the parent delegates `write-plan` at step 2 and `review-plan` at step 3 (with the same `ContextId`), `PlanPath` flows through automatically — no `--input PlanPath=...` needed at the parent.

**Authoring notes:**
- Export values with `OUTPUTS` in the producing runbook.
- Declare required inherited values with frontmatter `INPUTS` and `REQUIRED` in the consuming runbook.
- Missing required values fail before work starts.
- Explicit inputs on `rd delegate` or `rd claim` override inherited values.

See [Template Variables](../../../../CLAUDE.md#template-variables) and [Context Passing](../../../../docs/spec/language.md#10-context-passing) for detailed syntax and precedence.

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
| Overriding ContextId unnecessarily | Children inherit automatically; only pass `--input ContextId=...` to override with a meaningful name |

## Reference

- [Subagent delegation](../../../../docs/guides/agent-orchestration.md)
- [Delegation patterns](../../../../runbooks/delegation/)
- [Rundown specification](../../../../docs/spec/language.md)
- [CLI reference](../../../../CLAUDE.md)
