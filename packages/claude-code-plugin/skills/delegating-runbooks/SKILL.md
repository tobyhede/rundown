---
name: delegating-runbooks
description: Use when orchestrating multi-agent work through rundown delegation, dispatching substeps to child agents, or managing delegation tokens
---

# Delegating Work

Rundown delegation dispatches substeps to child agents. The parent delegates, a child claims the work, executes it, and reports back. The plugin automates token detection and claim injection.

To walk the child runbook inline instead of dispatching a subagent, omit `- DELEGATE` — see the inline-linkage pattern in [running-runbooks](../running-runbooks/SKILL.md#nested-runbooks).

## Choreography

Capture the run id when you start the runbook: `rundown run` prints it at start and every subsequent event carries it as `runbookId`. You need it for every mutating command you issue as the orchestrator. A delegation-exposed run refuses bare mutating commands, so each lane names its own authority:

```bash
# Orchestrator lane — driving a delegation-exposed run
rundown run rundown:planning        # capture the run id (printed at start; runbookId on every event)
rundown delegate --step 1.1 --run <rd_…>
rundown collect --run <rd_…>
rundown pass --run <rd_…>

# Child lane — completing delegated work
rundown claim <rdtk_…>              # capture claim_id from the output
rundown pass --claim-id <claim_id>

# Read-only commands stay bare
rundown status
rundown ls
```

## When to Use

- Orchestrating multi-agent work where substeps are dispatched to separate child agents
- A runbook step carries `- DELEGATE`; entering it auto-issues a token (`rdtk_...`) that must be dispatched
- Managing the parent side of delegation: issuing, monitoring, aborting, or aggregating delegated substeps
- Fanning out independent substeps (or FOR-loop iterations) to run concurrently across agents

## When NOT to Use

- Executing an already-claimed runbook as the child — use the [running-runbooks](../running-runbooks/SKILL.md) skill instead
- Walking a nested child runbook inline without a subagent — omit `- DELEGATE` (see [running-runbooks](../running-runbooks/SKILL.md#nested-runbooks))
- Authoring or editing runbook files — use the writing-runbooks skill instead
- Running unrelated shell commands outside a Rundown-controlled workflow

## Quick Reference

```bash
# Orchestrator commands name the run you control with --run <rd_…>
rundown delegate --step 2.1 --run <rd_…>              # Delegate specific substep
rundown delegate <runbook> --step 2.1 --run <rd_…>   # Explicit runbook and substep
rundown delegate --step 2.1 --input k=v --run <rd_…> # With input
rundown delegate --step 2.1 --input-json k=json --run <rd_…>  # With JSON input
rundown delegate --step 2.1 --input-file <path> --run <rd_…>  # Inputs from YAML
rundown collect --run <rd_…>               # Aggregate delegated results
rundown pass --run <rd_…>                  # Advance the run you orchestrate

rundown abort <token>                      # Cancel unclaimed delegation
rundown abort <token> --force              # Cancel claimed delegation

rundown status                             # Monitor delegation state (JSON by default)
rundown ls                                 # List runbooks (read-only, stays bare)
```

On a standalone run with no delegation activity, bare `rundown delegate` / `rundown pass` still work; the `--run <rd_…>` form is required once the run is delegation-exposed. Read-only commands (`rundown status`, `rundown ls`) stay bare everywhere.

## Delegation Flow

```
Parent                          Child
  |                               |
  |  rundown delegate --step 2.1 --run <rd_…>
  |  --> token issued             |
  |                               |
  |  Dispatch agent with token    |
  |  -------------------------→   |
  |                               |  rundown claim <token>
  |                               |  (plugin injects automatically)
  |                               |
  |                               |  ... does work ...
  |                               |
  |                               |  rundown pass --claim-id <claim_id>
  |  ←-------------------------   |  (or rundown fail --claim-id <claim_id>)
  |  Result propagates to step    |
  |                               |
```

## Step-by-Step

### 1. Delegate a substep

```bash
# Explicit substep
rundown delegate --step 2.1 --run <rd_…>

# Explicit runbook + substep
rundown delegate my-runbook --step 2.1 --run <rd_…>

# With inputs
rundown delegate --step 2.1 --input environment=staging --run <rd_…>
rundown delegate --step 2.1 --input-json config='{"debug":true}' --run <rd_…>
```

**Delegate is an idempotent confirm / re-issue — not the minting step.** Entering
a delegating step auto-issues its frontier tokens, so `rundown delegate --step X
--run <rd_…>` on an already-entered step returns `action: "already-delegated"`,
echoing the existing token (`rdtk_...`) rather than minting a new one. Use it to
read the token, and `--retry` to re-issue after a failed dispatch (#522).

This idempotency holds in every form — `--step S` and the positional
`rundown delegate <runbook>` alike: when the target substep already carries an
in-flight (auto-issued, unclaimed) delegation, it echoes the existing token
instead of erroring. Naming a **different** runbook than the in-flight one is a
conflict (RD-804). Targeting a delegation already **claimed** by a live child is
refused (RD-811) — recover with `rundown abort <token> --force` or
`rundown delegate --retry --run <rd_…>`.

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

The plugin normally detects `RD_CLAIM_TOKEN=rdtk_...` in the child prompt and injects the claim instructions automatically. If automatic token injection is unavailable, or you are recovering manually, the child can run `rundown claim <token>` to start the delegated runbook, which returns a `claim_id`.

After claiming, the child follows normal [runbook execution](../running-runbooks/SKILL.md), passing that claim id to child-targeting commands (e.g. `rundown pass --claim-id <claim_id>`).

```bash
rundown claim <token>
rundown claim <token> --input key=value
rundown claim <token> --input-json key=json
rundown claim <token> --input-file path
# ... work through steps ...
rundown pass --claim-id <claim_id>     # Report success
rundown fail --claim-id <claim_id>     # Report failure
```

### 4. Result propagates

When the child calls `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>`, the result flows back to the parent's substep. The parent step's aggregation rules determine the overall outcome. **The child's job ends there** — once its claim is reported, it must stop and return control to the orchestrator. The orchestrator (you, the parent side) drives every subsequent step, including any stage the parent auto-advances into.

On a delegation-exposed run, every bare mutating command (`rundown pass`, `rundown fail`, `rundown goto`, `rundown collect`, `rundown complete`, `rundown stop`, `rundown delegate`) is refused with `ACTOR_CONTEXT_REQUIRED`. Exposure is sticky: claim closure and prune never flip a run back to standalone, so the bare form never "falls through" to the parent. The remediation names both lanes — `--run <rd_…>` for the orchestrator, `--claim-id <claim_id>` for a child — and deliberately never echoes the target run id. Target the child with `--claim-id` and the orchestrator with `--run`; a claimed child must still stop the moment it reports its result.

`OPEN_DELEGATED_CHILDREN` is a separate, still-current guard: a `--run`-targeted parent advance is refused while a claimed child is open. If you see it, wait for the child to report (or `rundown abort <token> --force`) before advancing the parent with `--run <rd_…>`.

### Inline composition and derived authority

When a delegation-exposed step links child runbooks **inline** (no `- DELEGATE`), a bare `rundown pass` on an inline unit is refused too. `--run <rd_…>` naming any member of a contiguous inline composition chain carries controller authority over the chain's walked-to root, so one `--run` targeting the chain advances the inline unit you are on. A delegation boundary severs the chain: claimed children are never `--run`-reachable (they are not members of the default stack — reach them only with their `--claim-id`). Run ids are not secrets; they are freely available from `rundown run` output and every event's `runbookId` (names are not capabilities), so `--run` names authority you already hold — it does not grant it.

## FOR Loop Delegation

Without `--index`, delegation targets the active iteration. Use `--index` to target a specific iteration:

```bash
rundown delegate --step 2.1 --index 3 --run <rd_…>
```

Each iteration maintains independent delegation state, so iterations can be delegated to different agents for parallel processing.

## Aborting Delegations

Cancel a delegation when the child agent fails, gets stuck, or the work is no longer needed:

```bash
rundown abort <token>           # Cancel unclaimed delegation
rundown abort <token> --force   # Cancel already-claimed delegation
```

- **Unclaimed**: token is cancelled, substep reverts to un-delegated state
- **Claimed**: requires `--force` since a child is actively working; the child's next CLI call will fail

## Variable Pass-Through

Delegated runbooks automatically inherit available parent variables. Do not manually pass every variable as `--input`; add explicit inputs only when you intentionally want to change or add a value for the child.

Each child gets its own `RunId`. `ContextId` stays stable across the delegation tree so shared paths and correlation IDs continue to line up, including paths created with `{{ path "..." }}` under the same `.rd-<ContextId>/` directory. Override with `--input ContextId=sprint-42` only when you want a meaningful new shared context identifier.

Explicit inputs override inherited values:

```bash
rundown delegate --step 2.1 --input environment=staging --run <rd_…>
rundown delegate --step 2.1 --input-json config='{"debug":true}' --run <rd_…>
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
- Export values with frontmatter `OUTPUTS:` in the producing runbook.
- Declare required inherited values with frontmatter `INPUTS:` and `REQUIRED:` in the consuming runbook.
- Missing required values fail before work starts.
- Explicit inputs on `rundown delegate` or `rundown claim` override inherited values.

See [Template Variables](../../../../CLAUDE.md#template-variables) and [Context Passing](../../../../docs/spec/language.md#10-context-passing) for detailed syntax and precedence.

## Patterns

**Sequential:** Delegate substeps one at a time, waiting for each result before delegating the next.

**Parallel fan-out:** Delegate multiple substeps simultaneously — all children work concurrently, parent aggregates results via ALL/ANY:

```bash
rundown delegate --step 2.1 --run <rd_…>
rundown delegate --step 2.2 --run <rd_…>
rundown delegate --step 2.3 --run <rd_…>
```

**Nested:** A child can itself delegate, creating a delegation tree. ContextId flows through the tree for correlation.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `--step 2` when substeps exist | Use qualified ID: `--step 2.1` |
| `rundown abort` on claimed token | Add `--force` for already-claimed tokens |
| Overriding ContextId unnecessarily | Children inherit automatically; only pass `--input ContextId=...` to override with a meaningful name |

## Reference

- [Subagent delegation](../../../../docs/guides/agent-orchestration.md)
- [Delegation patterns](../../../../runbooks/delegation/)
- [Rundown specification](../../../../docs/spec/language.md)
- [CLI reference](../../../../docs/reference/cli.md)
- [Project overview and command list](../../../../CLAUDE.md)
