# Subagent Delegation

How Rundown delegates substep execution to subagents via the plugin's hook system.

**Related docs:**
- [docs/reference/cli.md](../reference/cli.md) — CLI command reference and user guide
- [docs/reference/runtime.md](../reference/runtime.md) — Execution model, state, variables
- [docs/spec/language.md](../spec/language.md) — Rundown format specification (steps, substeps, transitions)
- [runbooks/](../../runbooks/) — Runbook pattern examples

---

## Delegation Workflow

A runbook defines substeps, each delegated to a subagent. The parent agent orchestrates; subagents execute. The plugin's hook system handles token detection, context injection, and result routing.

Two flows are available:

- **DELEGATE annotation** (recommended for multi-substep delegation) — the step declares its substeps are delegated, and the engine auto-issues tokens on step entry. See [DELEGATE Annotation](#delegate-annotation).
- **Manual `rd delegate --step`** — for single-delegation or ad-hoc dispatch from an orchestrating agent.

### Single-Level Delegation Invariant

Delegation is single-level: a claimed (delegated) child runbook may not issue further delegations. Subagents do not spawn subagents. The CLI enforces this at runtime at the issuance source (`createDelegation`), so the rule covers every path that mints a token: manual `rd delegate`, the executor's auto-fan-out on entry to a step with delegating substeps, and `rd delegate --retry` re-issuance. Issuance refuses with error `RD-819 DELEGATION_NESTED_FORBIDDEN` when the active runbook is itself a delegated child.

When a claimed child needs to invoke another runbook, use composition (`rd run`) inside a substep body — composition is unrestricted. The fenced-bash form is parsed as a shell command rather than a delegation list:

```markdown
### 1.1 Compose another runbook

```bash
rd run other.runbook.md
```
```

Claimed children are never pushed onto `defaultStack`; bare commands always target the project-default active runbook (the parent), and claim-targeted commands (`pass`, `fail`, `stop`, `complete`, `goto`, `status`, `stash`, `pop`, `collect`) require explicit `--claim-id`. `rd delegate` does not accept `--claim-id` because delegating from a claimed child is forbidden by this invariant.

### Manual `rd delegate --step`

**Example runbook:**
```markdown
## 2. Review changes
- PASS ALL CONTINUE
- FAIL ANY GOTO 4

### 2.1 Code review
Review the implementation for correctness and style.

### 2.2 Test review
Verify test coverage and assertions.
```

**Command sequence:**

```bash
# 1. Parent delegates substep to child runbook
rd delegate <runbook> --step 2.1

# 2. Parent dispatches a subagent with the token in its prompt
#    The plugin detects the token and injects claim instructions

# 3. Subagent claims the delegation token
rd claim <token>

# 4. Subagent works through the delegated runbook, then reports result
rd pass --claim-id <claim_id>   # or: rd fail --claim-id <claim_id>
```

### Dispatch Frontier and Identity

- `delegate --step` requires a parseable step identifier; when the active step has substeps, step-only dispatch (`N`) is rejected — use qualified IDs (`N.M`).
- `delegate [runbook] --step <id>` accepts an optional runbook argument; when omitted, the runbook is inferred from the substep's `runbooks` field.
- `delegate --step` is constrained to the active step frontier.
- If the active step is in a FOR loop, queueing is constrained to the active iteration frontier.
- Plugin dispatch descriptions must begin with a step identifier matching the runbook's ID format — either a numeric qualified ID (e.g., `1.2 - Review`) or a named identifier (e.g., `ErrorHandler: Recover`).

---

## DELEGATE Annotation

`- DELEGATE` is a structural bullet annotation that marks substeps for delegation. When the parent step is entered, the execution engine auto-issues a delegation token for each marked substep, so the orchestrating agent does not need to call `rd delegate` per substep. This is the recommended flow for any step that delegates more than one substep to subagents.

See [docs/spec/language.md §7](../spec/language.md#7-delegation) for the full format specification and [docs/spec/grammar.md](../spec/grammar.md#delegate-annotation) for the grammar.

### Three equivalent forms

**Step-level** — propagates to all H3 substeps; use when every substep is delegated:
```markdown
## 1. Delegated work
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First task
- child-a.runbook.md

### 1.2 Second task
- child-b.runbook.md
```

**Per-substep** — on individual H3 substeps; use when a step mixes delegated and non-delegated substeps:
```markdown
### 1.1 First task
- DELEGATE
- child-a.runbook.md
```

**Runbook-list shorthand** — nested under runbook-list entries (no H3 headers); use when the step body is already a flat runbook list:
```markdown
## 1. Delegated work
- child-a.runbook.md
  - DELEGATE
- child-b.runbook.md
  - DELEGATE
```

Executable scenarios for all three forms live at [runbooks/delegation/delegate-keyword-*.runbook.md](../../runbooks/delegation/).

### Auto-issuance lifecycle

1. **Step entry** — the engine fires `STEP_ENTERED` with a `delegateFrontier` field: an array of `{id, runbook, token}` records, one per DELEGATE substep.
2. **Dispatch** — the orchestrating agent dispatches a subagent per record, passing the token in the subagent's prompt. The plugin detects the token and injects claim instructions.
3. **Claim** — each subagent runs `rd claim <token>`, which launches the child runbook with the inherited `ContextId` and any forwarded variables. The command returns a `claim_id`; keep that handle and pass it to every child-targeting command (`rd status`, `rd pass`, `rd fail`, `rd collect`, `rd goto`, `rd stash`, `rd pop`, `rd stop`, and `rd complete`) with `--claim-id <claim_id>`.
4. **Resolve** — the subagent completes the child runbook and calls `rd pass --claim-id <claim_id>` / `rd fail --claim-id <claim_id>`.
5. **Aggregation** — when the final substep resolves, auto-aggregation fires on the parent step's transition (e.g., `PASS ALL CONTINUE`, `FAIL ANY STOP`).

### `rd collect`

```bash
rd collect                  # Aggregate the active DELEGATE step and fire its transition
rd collect --step <id>      # Target a specific substep scope
```

Auto-aggregation fires automatically when the final DELEGATE substep resolves, so `rd collect` is usually unnecessary. It remains available for cases where explicit aggregation is needed — most commonly, a step mixing DELEGATE substeps with non-delegated substeps resolved manually.

### RETRY on DELEGATE

`RETRY` on a DELEGATE step fires uniform re-delegation. When aggregation resolves to a failure and the retry budget is non-zero, the engine cancels every delegated substep's active delegation in the frame and mints a fresh token per substep — every substep is re-delegated, not just the failures. Stale tokens from the previous attempt return `TOKEN_CANCELLED` on `rd claim`. The subsequent `STEP_ENTERED` event carries the new `delegateFrontier`; orchestrators dispatch a subagent per fresh token exactly as they do on first entry. For DELEGATE steps inside a FOR loop, retry budgets apply per iteration.

---

## Context File Discovery

When a subagent is dispatched, the plugin injects context files based on agent type and lifecycle stage.

**Discovery locations** — for each directory (project first, then plugin), the following paths are checked in order:

| Priority | Pattern |
|----------|---------|
| 1 | `{dir}/{name}-{stage}.md` |
| 2 | `{dir}/slash-command/{name}-{stage}.md` |
| 3 | `{dir}/slash-command/{name}/{stage}.md` |
| 4 | `{dir}/skill/{name}-{stage}.md` |
| 5 | `{dir}/skill/{name}/{stage}.md` |

Where `{dir}` is `.claude/context/` (project-level, highest priority) then `${CLAUDE_PLUGIN_ROOT}/context/` (plugin-level fallback).

> **Note:** The plugin-level context directory is an extension point; no plugin-level context files are shipped by default. All agent context customization is project-level.

**Lifecycle stages:**

| Stage | Event | Example file |
|-------|-------|-------------|
| `start` | Agent dispatched | `code-review-agent-start.md` |
| `end` | Agent completed | `code-review-agent-end.md` |

**Agent-command scoped context** (for SubagentStop events):
- `{agent-type}-{command}-end.md` — most specific, e.g. `code-review-agent-verify-end.md`
- `{agent-type}-end.md` — agent-specific fallback

Place a `code-review-agent-start.md` file in `.claude/context/` and it is automatically injected when that agent type is dispatched.

### Namespaces

Agent types support namespace prefixes using `namespace:name` syntax (e.g., `cipherpowers:code-review-agent`). The namespace is stripped for context file discovery — `cipherpowers:code-review-agent` maps to `code-review-agent-start.md`. The remaining name is sanitized by the plugin context discovery path builder before lookup, so path segments such as `/` and `..` cannot escape `.claude/context/`.

---

## Threat Model and Claim IDs

Claim ids are an **isolation-against-accident** mechanism, not an adversarial security boundary.

`rd claim <token>` returns a generated `rdclm_...` handle stored in `.rundown/session.json`. CLI commands that accept `--claim-id` (`rd status`, `rd pass`, `rd fail`, `rd collect`, `rd goto`, `rd stash`, `rd pop`, `rd stop`, and `rd complete`) route to the exact delegated child runbook for that handle. Plain commands continue to target only the default stack.

What this provides:

- **Sibling fan-out isolation.** Two subagents claiming different delegation tokens against the same parent each operate on their own child runbook. `rd pass --claim-id <id-a>` cannot accidentally complete the child for `<id-b>`.
- **Stash protection.** A claimed child stashed with `rd stash --claim-id <id>` can be restored only with `rd pop --claim-id <id>`; plain `rd pop` refuses it.
- **Fail-closed targeting.** A stale, terminal, missing, or unlinked claim id fails instead of falling back to the shared default stack.

What this does **not** provide:

- **No cryptographic capability.** Claim ids are persisted in workspace state and printed to local command output. Any process that can read the workspace state or command transcript can use the handle.
- **No authentication of the dispatching session.** The plugin trusts the local workspace state and the CLI trusts any syntactically valid claim id supplied by the caller.
- **No protection against a malicious local process.** All workspace state (`.rundown/`) is filesystem-readable by the user; an actor with shell access can edit `session.json` directly.

The threat model assumes cooperating agents in a trusted local workspace. If you need adversarial isolation between agents, run them in separate workspaces or as separate operating-system users — not as cooperating processes against the same `.rundown/` directory.

---

## Delegation Completion

Subagents complete delegated work using `rd pass --claim-id <claim_id>` or `rd fail --claim-id <claim_id>`, which updates the child runbook state directly. The parent agent observes results via `rd status`.

Parallel delegated siblings are isolated by claim id. A subagent that claims token A receives the handle for token A's child, even if another subagent later claims token B in the same workspace. Plain `rd pass` and `rd fail` do not target claimed children.

The plugin tracks active delegation tokens per `agent_id` for `SubagentStop` diagnostics. When one subagent stops, the hook consumes only that agent's token metadata and preserves sibling token metadata.

When a subagent stops without explicitly closing the delegated work, the plugin reports a diagnostic to the parent:

- **Child completed** (`rd pass --claim-id`/`rd fail --claim-id` was called): The child runbook has already propagated the result to the parent. No action needed.
- **Child not explicitly closed**: The plugin tells the parent that delegated Rundown work must be closed explicitly with `rd pass --claim-id <claim_id>` or `rd fail --claim-id <claim_id>`.

The plugin never destroys child runbook state. Incomplete delegations preserve their context for inspection.

**Routing behavior:**
- Canonical target identity is `step + substep + iteration` (`frame = step|iteration`, `entry = re-entry counter`).
- Completion keys are scoped to `frame + entry + substep`; stale completions from previous entries are rejected.
- Resolved completions drain in deterministic substep order. Aggregation waits for all DEFER'd results before evaluating the step-level transition.
- When a completion arrives for a frontier substep that is not at the active cursor, it is **deferred** — stored and applied when the cursor reaches that substep.

**Data flow between parent and child:** Delegated runbooks exchange values through context passing — a parent step's `- OUTPUTS` directive writes values into the live machine variable space when that step transition completes, and frontmatter `outputs:` writes terminal values into `state.finalVars`. Children inherit the parent's `ContextId` via `--input`, and parent/child hand-off happens through forwarded live vars and `finalVars`, not through a shared `outputs.json` file.

See [Section 6: Transitions and Actions](../spec/language.md#6-transitions-and-actions) for transition semantics.

---

## Aggregate Transitions

When substeps involve agents, transition rules use aggregate conditions:

```markdown
## 2. Review
- PASS ALL CONTINUE
- FAIL ANY GOTO 4

### 2.1 First reviewer
### 2.2 Second reviewer
```

| Condition | Meaning |
|-----------|---------|
| `PASS ALL` | All substep agents passed (pair with `FAIL ANY`) |
| `FAIL ANY` | At least one substep agent failed (pair with `PASS ALL`) |
| `PASS ANY` | At least one substep agent passed (pair with `FAIL ALL`) |
| `FAIL ALL` | All substep agents failed (pair with `PASS ANY`) |
| `PASS` / `FAIL` | Standard single-result transitions |

See [docs/spec/language.md](../spec/language.md) for the full transition grammar.
