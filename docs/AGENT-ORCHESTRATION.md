# Subagent Delegation

How Rundown delegates substep execution to subagents via the plugin's hook system.

**Related docs:**
- [RUNDOWN.md](./RUNDOWN.md) — CLI architecture, execution model, and command reference
- [SPEC.md](./SPEC.md) — Rundown format specification (steps, substeps, transitions)
- [runbooks/](../runbooks/) — Runbook pattern examples

---

## Delegation Workflow

A runbook defines substeps, each delegated to a subagent. The parent agent orchestrates; subagents execute. The plugin's hook system handles token detection, context injection, and result routing.

Two flows are available:

- **DELEGATE annotation** (recommended for multi-substep delegation) — the step declares its substeps are delegated, and the engine auto-issues tokens on step entry. See [DELEGATE Annotation](#delegate-annotation).
- **Manual `rd delegate --step`** — for single-delegation or ad-hoc dispatch from an orchestrating agent.

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
rd pass   # or: rd fail
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

See [SPEC.md §4.3](./SPEC.md#43-delegate) for the full format specification and [FORMAT.md](./FORMAT.md#delegate-annotation) for the grammar.

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

Executable scenarios for all three forms live at [runbooks/delegation/delegate-keyword-*.runbook.md](../runbooks/delegation/).

### Auto-issuance lifecycle

1. **Step entry** — the engine fires `STEP_ENTERED` with a `delegateFrontier` field: an array of `{id, runbook, token}` records, one per DELEGATE substep.
2. **Dispatch** — the orchestrating agent dispatches a subagent per record, passing the token in the subagent's prompt. The plugin detects the token and injects claim instructions.
3. **Claim** — each subagent runs `rd claim <token>`, which launches the child runbook with the inherited `ContextId` and any forwarded variables.
4. **Resolve** — the subagent completes the child runbook and calls `rd pass` / `rd fail`.
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

Agent types support namespace prefixes using `namespace:name` syntax (e.g., `cipherpowers:code-review-agent`). The namespace is stripped for context file discovery — `cipherpowers:code-review-agent` maps to `code-review-agent-start.md`.

---

## Delegation Completion

Subagents complete delegated work using `rd pass` or `rd fail`, which updates the child runbook state directly. The parent agent observes results via `rd status`.

When a subagent stops, the plugin checks the child runbook state via `rd status`:

- **Child completed** (`rd pass`/`rd fail` was called): The child runbook has already been popped from the session stack and the result propagated to the parent. No action needed.
- **Child still active** (subagent stopped without completing): The plugin surfaces context to the parent agent with the child's current position and step, so the parent can decide how to proceed (retry, complete manually, or fail the step).

The plugin never destroys child runbook state. Incomplete delegations preserve their context for inspection.

**Routing behavior:**
- Canonical target identity is `step + substep + iteration` (`frame = step|iteration`, `entry = re-entry counter`).
- Completion keys are scoped to `frame + entry + substep`; stale completions from previous entries are rejected.
- Resolved completions drain in deterministic substep order. Aggregation waits for all DEFER'd results before evaluating the step-level transition.
- When a completion arrives for a frontier substep that is not at the active cursor, it is **deferred** — stored and applied when the cursor reaches that substep.

**Data flow between parent and child:** Delegated runbooks exchange values through context passing — a parent step's `- OUTPUTS` directive writes values into the live machine variable space when that step transition completes, and frontmatter `outputs:` writes terminal values into `state.finalVars`. Children inherit the parent's `ContextId` via `--input`, and parent/child hand-off happens through forwarded live vars and `finalVars`, not through a shared `outputs.json` file.

See [Section 4: Control Flow](SPEC.md#4-control-flow) for transition semantics.

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

See [SPEC.md](./SPEC.md) for the full transition grammar.
