# Agent Orchestration Models

How Rundown orchestrates work through agents. This document covers the five orchestration models, when to use each, agent type conventions, and the status protocol.

**Related docs:**
- [RUNDOWN.md](./RUNDOWN.md) - CLI reference including subagent commands
- [SPEC.md](./SPEC.md) - Rundown format specification (steps, substeps, transitions)
- [PATTERNS.md](./PATTERNS.md) - Concrete runbook pattern examples

---

## Table of Contents

- [The Five Models](#the-five-models)
  - [1. Sequential Runbook Steps](#1-sequential-runbook-steps)
  - [2. Skill-Guided Single Agent](#2-skill-guided-single-agent)
  - [3. Runbook + Skill Composition](#3-runbook--skill-composition)
  - [4. Substeps with Agent Types](#4-substeps-with-agent-types)
  - [5. Parallel Fan-Out / Fan-In](#5-parallel-fan-out--fan-in)
- [Choosing a Model](#choosing-a-model)
- [Agent Type Conventions](#agent-type-conventions)
  - [Naming](#naming)
  - [Namespaces](#namespaces)
  - [Context File Discovery](#context-file-discovery)
- [Status Protocol](#status-protocol)
- [Runbook Transitions for Agents](#runbook-transitions-for-agents)

---

## The Five Models

### 1. Sequential Runbook Steps

The simplest model. A runbook defines steps executed in order. Each step is either a **command step** (auto-executes, exit code determines pass/fail) or a **prompt step** (instructions for the agent, requires `rd pass` or `rd fail`).

No subagents are involved — the main agent works through steps sequentially.

**When to use:** Linear runbook flows, checklists, CI-style pipelines, anything where one agent handles all steps in order.

**Example:**
````markdown
## 1. Run tests
- PASS: CONTINUE
- FAIL: STOP "Tests failed"

```bash
npm test
```

## 2. Check coverage
- PASS: CONTINUE
- FAIL: GOTO 1

```bash
npm run coverage -- --threshold 80
```

## 3. Deploy
- PASS: COMPLETE "Deployed"
- FAIL: STOP "Deploy failed"

```bash
npm run deploy
```
````

**Transition rules:** CONTINUE, STOP, GOTO, RETRY, COMPLETE. See [SPEC.md](./SPEC.md) for full syntax.

---

### 2. Skill-Guided Single Agent

A skill provides domain-specific instructions that guide the main agent's behaviour. The skill is loaded via Claude's `Skill` tool and shapes *how* the agent works, but the agent does all the work itself.

No runbook flow control is involved — the skill is pure instruction.

**When to use:** Tasks that need specialised knowledge or methodology but not flow control. The agent should be free to adapt its approach.

**Example:** The `writing-plans` skill teaches an agent how to write implementation plans — what structure to follow, what sections to include, how to decompose tasks. The agent reads the skill and follows the methodology.

```
User: /write-plan
  → Skill(skill: "rundown:writing-plans")
  → Skill instructions loaded into agent context
  → Agent writes plan following skill guidance
```

---

### 3. Runbook + Skill Composition

Combines a runbook (for flow control) with a skill (for domain knowledge). The runbook orchestrates *when* things happen; the skill provides *how* to do them.

**When to use:** Workflows that need enforced ordering AND specialised methodology. The runbook ensures steps happen in sequence; the skill ensures quality at each step.

**Example:** `write-plan.runbook.md` orchestrates the plan-writing flow, invoking the `writing-plans` skill for the actual authoring step:

```markdown
## 1. Check prerequisites
- PASS: CONTINUE
- FAIL: GOTO InvokeSkill

Verify the Writing Plans skill has been invoked.

## InvokeSkill Load skill
- PASS: GOTO 2
- FAIL: STOP

Tool: Skill(skill: "rundown:writing-plans")

## 2. Write the plan
- PASS: COMPLETE
- FAIL: RETRY 2

Write and save the implementation plan.
```

The runbook handles flow (check → invoke skill → write); the skill handles content (plan structure, task decomposition, verification criteria).

---

### 4. Substeps with Agent Types

A runbook defines substeps, each delegated to a typed subagent. The parent agent orchestrates; subagents execute. Agent types are declared in H3 substep headers.

**When to use:** Tasks with distinct subtasks that benefit from specialised agents. Each subagent gets its own context and instructions via context injection.

**Example:**
```markdown
## 2. Review changes
- PASS ALL: CONTINUE
- FAIL ANY: GOTO 4

### 2.1 Code review (code-review-agent)
Review the implementation for correctness and style.

### 2.2 Test review (test-agent)
Verify test coverage and assertions.
```

**Command sequence:**
```bash
# Parent queues substep with agent type
rd run --step 2.1

# Subagent binds to pending step
rd run --agent subagent-abc

# Subagent works, then reports result
rd pass --agent subagent-abc
```

The agent type (`code-review-agent`, `test-agent`) drives context injection — see [Context File Discovery](#context-file-discovery).

**Dispatch frontier and identity:**
- `run --step` requires a parseable step identifier; when the active step has substeps, step-only dispatch (`N`) is rejected and `N.M` is required.
- `run --step` accepts an optional runbook argument. When omitted, child runbook path is inferred only if the targeted substep has exactly one runbook reference.
- Plugin Step/Task dispatch must include a parseable identifier prefix (for example `1.2 - Review` or `ErrorHandler: Recover`).
- `run --step` is constrained to the active step frontier.
- If the active step is in a FOR loop, queueing is constrained to the active iteration frontier.
- Canonical target identity is `step + substep + iteration`.
- Display path (`STEP.INDEX.SUBSTEP`, e.g. `2.3.1`) is output-only.
- Completion acceptance is scoped by frame + entry identity so stale completions from prior re-entry are rejected.
- `frame` and `entry` are internal runtime identity terms, not runbook authoring syntax.
- `frame = step|iteration`
- `entry = re-entry counter for that frame`
- Completion routing uses `frame + entry + substep` to reject stale completions after re-entry.

---

### 5. Parallel Fan-Out / Fan-In

Multiple independent agents are dispatched in parallel, their results collected and collated into a unified assessment. This is the most complex model, used when you want consensus or multi-perspective analysis.

**When to use:** Reviews, verification, audits — any task that benefits from independent perspectives. Multiple agents prevent single-point-of-failure in judgement.

**Phases:**

| Phase | Description |
|-------|-------------|
| **Dispatch** | Launch N agents with `Step(subagent_type="...")` (`Task` is accepted as an alias for `Step` for backward compatibility) |
| **Execute** | Each agent works independently, writes findings to `.work/` |
| **Collate** | Main agent reads all findings, categorises as Common (N/N agreement) vs Exclusive |
| **Cross-check** | Optional: dispatch agent to validate exclusive findings |
| **Complete** | Unified report with confidence levels |

**Agent count heuristics:**

| Scope | Agents |
|-------|--------|
| Single file change | 2 |
| Multi-file feature | 2–3 |
| Architecture change | 3 |
| Security-sensitive | 3+ |

**Example** (from `verifying-by-consensus`):
```text
Step(description="1.1 - Review auth changes", subagent_type="code-review-agent")
Step(description="1.2 - Review auth changes", subagent_type="code-review-agent")
```

Each agent writes its findings to `.work/{date}-verify-{agentId}.md`, ending with a `STATUS: PASS` or `STATUS: FAIL` line. The main agent then collates results.

---

## Choosing a Model

| Need | Model | Complexity |
|------|-------|------------|
| Linear checklist, CI pipeline | [Sequential Steps](#1-sequential-runbook-steps) | Low |
| Methodology guidance, flexible execution | [Skill-Guided](#2-skill-guided-single-agent) | Low |
| Enforced ordering + methodology | [Runbook + Skill](#3-runbook--skill-composition) | Medium |
| Distinct subtasks, specialised agents | [Substeps with Agent Types](#4-substeps-with-agent-types) | Medium |
| Independent review, consensus | [Parallel Fan-Out](#5-parallel-fan-out--fan-in) | High |

**Decision flow:**

1. Does the task need enforced step ordering? → Yes: use a runbook (models 1, 3, 4, 5)
2. Does it need specialised domain knowledge? → Yes: use a skill (models 2, 3)
3. Does it need multiple agents? → Yes: use substeps or fan-out (models 4, 5)
4. Do agents need to work independently with collation? → Yes: fan-out (model 5)

Models compose — a fan-out (model 5) might use skill-guided agents (model 2) that each follow a runbook (model 1).

---

## Agent Type Conventions

### Naming

Agent types are free-form strings. No central registry exists — any string works as an agent type. Convention:

- Use kebab-case: `code-review-agent`, `test-agent`, `lint-agent`
- Suffix with `-agent` for clarity
- Name describes the role: what the agent *does*, not how it's configured

### Namespaces

Agent types support namespace prefixes using `namespace:name` syntax:

| Format | Example | Meaning |
|--------|---------|---------|
| Plain | `code-review-agent` | Resolved via discovery chain |
| Namespaced | `cipherpowers:code-review-agent` | Explicit: from `cipherpowers` plugin |
| Namespaced | `rundown:verify-agent` | Explicit: from rundown plugin |

The namespace is stripped for context file discovery — `cipherpowers:code-review-agent` maps to `code-review-agent-start.md`.

### Context File Discovery

When a subagent is dispatched, the plugin injects context files based on agent type and lifecycle stage:

**Discovery locations** (priority order):
1. `.claude/context/{agent-type}-{stage}.md` — project-level (highest priority)
2. `${CLAUDE_PLUGIN_ROOT}/context/{agent-type}-{stage}.md` — plugin-level (fallback)

**Lifecycle stages:**

| Stage | Event | Example file |
|-------|-------|-------------|
| `start` | Agent dispatched | `code-review-agent-start.md` |
| `end` | Agent completed | `code-review-agent-end.md` |

**Agent-command scoped context** (for SubagentStop events):
- `{agent-type}-{command}-end.md` — most specific, e.g. `code-review-agent-verify-end.md`
- `{agent-type}-end.md` — agent-specific fallback

This is how agent types get their instructions without a central registry — place a `code-review-agent-start.md` file and it's automatically injected when that agent type is dispatched.

---

## Status Protocol

Subagents signal completion via a `STATUS` line in their output:

```
STATUS: PASS
```

or

```
STATUS: FAIL
```

**Supported values:**

| Status | Meaning |
|--------|---------|
| `PASS` | Agent completed successfully |
| `FAIL` | Agent encountered issues or rejected the work |
| `BLOCKED` | Agent could not proceed (used in plan execution) |

The plugin parses this from agent output and translates it to `rd pass --agent <id>` or `rd fail --agent <id>`. See [Section 4: Control Flow](SPEC.md#4-control-flow) for transition semantics.

Routing behavior:
- Agent completion and plain `pass/fail` share one record-and-drain transition path.
- Completion keys are scoped to `frame + entry + substep`; stale completions from previous entries are rejected.
- Resolved completions drain in deterministic substep order, and step-level transition does not execute until the current scope has no unresolved substeps.
- When a completion arrives for a frontier substep that is not at the active cursor, it is **deferred** — stored and applied when the cursor reaches that substep. See [Section 4: Control Flow](SPEC.md#4-control-flow) for transition semantics.

**Important:** The STATUS line should appear at the end of the agent's response. If no STATUS line is found, the plugin treats the result based on the agent's exit behaviour.

---

## Runbook Transitions for Agents

When substeps involve agents, transition rules use aggregate conditions:

```markdown
## 2. Review
- PASS ALL: CONTINUE
- FAIL ANY: GOTO 4

### 2.1 First reviewer (code-review-agent)
### 2.2 Second reviewer (code-agent)
```

| Condition | Meaning |
|-----------|---------|
| `PASS ALL` | All substep agents passed |
| `FAIL ANY` | At least one substep agent failed |
| `PASS` / `FAIL` | Standard single-result transitions |

See [SPEC.md](./SPEC.md) for the full transition grammar.
