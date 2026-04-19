# Rundown CLI Guide and Reference

This document provides a comprehensive guide and reference for the Rundown CLI (`rundown`), explaining how it executes runbooks defined in the Rundown format, tracks runbook state, manages execution, and dispatches subagents.

**For syntax and format details, see:**
- [SPEC.md](./SPEC.md) - Rundown specification
- [FORMAT.md](./FORMAT.md) - Format grammar and expansion rules
- [AGENT-ORCHESTRATION.md](./AGENT-ORCHESTRATION.md) - Subagent delegation, context discovery, and delegation completion

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
  - [Execution Model](#execution-model)
  - [State Machine](#state-machine)
  - [Command Execution](#command-execution)
  - [FOR Loops](#for-loops)
- [State Persistence](#state-persistence)
  - [File Locations](#file-locations)
  - [Session Structure](#session-structure)
  - [Runbook State Structure](#runbook-state-structure)
- [Security Policy](#security-policy)
  - [Default Behavior](#default-behavior)
  - [Quick Reference](#quick-reference)
- [CLI Commands](#cli-commands)
  - [Runbook Lifecycle](#runbook-lifecycle)
  - [State Transitions](#state-transitions)
  - [Status Commands](#status-commands)
  - [Enforcement Control](#enforcement-control)
  - [Validation](#validation)
  - [Maintenance](#maintenance)
  - [Testing and Utilities](#testing-and-utilities)
  - [Delegation Commands](#delegation-commands)
- [Common Tasks](#common-tasks)
- [Delegation Patterns](#delegation-patterns)
  - [Pattern 1: Orchestrator Control](#pattern-1-orchestrator-control)
  - [Pattern 2: Agent-Controlled Branching](#pattern-2-agent-controlled-branching)
- [Output Format](#output-format)
  - [Standard Output Structure](#standard-output-structure)
  - [Key Elements](#key-elements)
- [Troubleshooting and Error Handling](#troubleshooting-and-error-handling)
  - [Common Errors and Resolutions](#common-errors-and-resolutions)
  - [State Recovery](#state-recovery)
- [Integration with Claude Code](#integration-with-claude-code)
  - [Context Injection](#context-injection)
  - [Session Persistence](#session-persistence)
- [CLI Quick Reference](#cli-quick-reference)

---

## Architecture Overview

The Rundown system separates concerns into three layers:

| Layer | Component | Responsibility |
|-------|-----------|----------------|
| **Format** | `.runbook.md` files | Runbook definition (steps, transitions, commands) |
| **State Machine** | XState-compiled machine | State transitions and guards |
| **Persistence** | JSON files | Runbook state survives context clears |
| **Iteration** | ForIterationService | Per-iteration data source value resolution |

The CLI is an orchestration and control interface. Claude executes the actual work.

```
[Runbook File] --> [Parser] --> [XState Machine] --> [State Manager]
                                       ^                    |
                                       |                    v
                              [CLI Commands] <---- [Persisted JSON]
```

### Design Principles

**Type-driven dispatch:** The state machine uses types and events to drive logic. Steps raise typed events; parent states dispatch on event type via `on:` handlers. Guards express domain conditions (e.g., "has more iterations"), never action-type checks. If a guard inspects `lastAction.type` to decide routing, that is a code smell — the event type system should handle the dispatch instead. `if` statements checking action types indicate missing structure in the state graph. Example: `LastAction` is a discriminated union whose variants encode the full transition context. The `GOTO` variant carries `target`, `substep`, and `at` fields that don't exist on other variants like `CONTINUE` or `DEFER`, so TypeScript prevents accessing them without narrowing first.

---

## Installation

```bash
npm install -g @rundown-org/cli
```

Verify installation:
```bash
rundown --help
```

The `rd` command is an alias for `rundown`.

---

## Quick Start

**Run a runbook:**
```bash
# Using an absolute path
rundown run /path/to/project/.rundown/runbooks/simple.runbook.md

# Or from the project root, with runbook in the standard location
rundown run simple.runbook.md
```

The CLI resolves runbook paths in this order:
1. Absolute path (used as-is)
2. Relative to current working directory
3. Relative to `.rundown/runbooks/` in the project root

### Runbook Discovery

When a runbook is referenced by name (rather than an explicit path), the CLI searches multiple sources in priority order:

| Priority | Source | Location |
|----------|--------|----------|
| 1 (highest) | Project | `.rundown/runbooks/` |
| 2 | Plugin | `$CLAUDE_PLUGIN_ROOT/runbooks/` |
| 3 | Bundled | CLI package `dist/runbooks/` |

Directories are scanned recursively, so nested layouts like `planning/write-plan.runbook.md` are supported.

**Namespace syntax** — Use `namespace:name` to target a specific source explicitly:

- `write-plan` — resolves via the priority chain above
- `rundown:write-plan` — explicit: from the plugin source only

`rd ls --all` lists discoverable runbooks with a `SOURCE` column indicating where each was found (`project`, `plugin`, or `bundled`).

**Check status:**
```bash
rundown status
```

**Progress through steps:**
```bash
rundown pass    # Step succeeded, apply PASS transition
rundown fail    # Step failed, apply FAIL transition
```

**Stop a runbook:**
```bash
rundown stop [message]
```

---

## How It Works

### Execution Model

Rundown separates **runbook definition** from **state tracking**:

| Component | Role |
|-----------|------|
| **Runbook file** | Markdown document defining steps, transitions, and conditions |
| **CLI (`rundown`)** | Tracks runbook state: current step, retry count, variables |
| **Agent (Claude)** | Executes work, uses CLI to report outcomes |

**Key concept:** The CLI tracks which step you are on and what happens when you report PASS or FAIL. For code blocks, it can execute commands automatically. Otherwise, the agent (or user) does the actual work.

### State Machine

The CLI compiles runbooks into an XState state machine. Each step (and substep) becomes a state. Events (`PASS`, `FAIL`, `GOTO`, `RETRY`) trigger transitions.

#### Compilation
Runbooks compile to XState machines at runtime. Steps become states:

| Runbook Element | XState State ID |
|-----------------|-----------------|
| `## 1. Title` | `step::1` |
| `## 2. Title` | `step::2` |
| `### 2.1 Substep` | `step::2::1` |
| `## Cleanup` | `step::Cleanup` |
| `### Cleanup.verify` | `step::Cleanup::verify` |

Terminal states: `COMPLETE`, `STOPPED`

#### Input Events
The state machine responds to these input events:

| Event | Trigger | Effect |
|-------|---------|--------|
| `PASS` | `rundown pass` or command exit 0 | Evaluate PASS transition |
| `FAIL` | `rundown fail` or command exit non-0 | Evaluate FAIL transition |
| `GOTO` | `rundown goto N` or GOTO action | Jump to step N |
| `RETRY` | FAIL + RETRY action | Increment retryCount, stay in state |

These input events are distinct from the action output recorded as `lastAction.type` after a transition resolves. The full `LastAction` union has nine variants: `START`, `CONTINUE`, `DEFER`, `GOTO`, `COMPLETE`, `STOP`, `RETRY`, `NEXT`, `BREAK` (see `packages/core/src/runbook/types.ts`).

#### Transitions
Default transitions when none specified:
```
PASS ALL CONTINUE
FAIL ANY STOP
```

Transition evaluation:
1. Check condition (PASS or FAIL)
2. For RETRY: check if `retryCount < max`
3. Execute action (CONTINUE, COMPLETE, STOP, GOTO)

### Command Execution

| Behavior | Triggered By | What Happens |
|----------|-------------|--------------|
| **Automatic** | Step has `bash` or `prompt` code block | CLI runs command, exit code determines PASS/FAIL |
| **Manual** | `--prompted` flag, or step has neither a bash nor prompt code block | CLI waits for manual `rd pass` or `rd fail` |

**Note:** A `prompt` code block becomes an `rd prompt '...'` command that outputs the content wrapped in markdown fences. It executes automatically like `bash` blocks.

#### WebContainer Environment

In WebContainer environments (e.g., StackBlitz), nested process spawning may not work correctly. The CLI includes an internal command dispatcher (`packages/cli/src/services/internal-commands.ts`) that intercepts `rd`/`rundown` commands and executes them directly without spawning a child process.

- `isInternalRdCommand()` detects rd/rundown commands
- `executeRdCommandInternal()` dispatches to internal handlers
- Currently supported: `echo`, `prompt` commands
- Unsupported commands fall back to standard spawn behavior

Example of a step that auto-executes:
````markdown
## 3. Run tests
- PASS CONTINUE
- FAIL RETRY 2 STOP

```bash
npm test
```
````

Example of a prompted step:
````markdown
## 4. Code review
- PASS CONTINUE
- FAIL STOP

Review the implementation for issues.
`rundown pass` if acceptable, `rundown fail` if blocked.
````

### FOR Loops

Steps can iterate their substeps over a numeric range using a FOR annotation. FOR loops are defined in the runbook syntax and the CLI manages loop state automatically.

**Syntax (brief):**

````markdown
## 3. Process batches
- FOR batch IN 1 TO 5
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1. Process item
- PASS CONTINUE
- FAIL BREAK
````

Step-level runbook lists are shorthand for implicit sequential substeps (`.1`, `.2`, ...), so FOR execution is equivalent across these forms:

````markdown
## 2. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY GOTO Synthesize

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
````

````markdown
## 2. Review the plan
- FOR pass IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY GOTO Synthesize

### 2.1
- review-technical-accuracy.runbook.md
### 2.2
- review-structural-integrity.runbook.md
````

See [SPEC.md Iteration (FOR)](./SPEC.md#5-iteration-for) for the full grammar and all clause variants.

**FOR clause variants:**

| Syntax | Description |
|--------|-------------|
| `FOR var IN 1 TO N` | Explicit range, named variable |
| `FOR 1 TO N` | Explicit range, no variable |
| `FOR var IN N` | Implicit start (1), named variable |
| `FOR N` | Implicit start (1), no variable |
| `FOR var IN {{ source }}` | All items from data source |
| `FOR var IN 1 TO N OF {{ source }}` | Windowed data source |

**Loop variable expansion:**

The named loop variable plus runtime step/index aliases are expanded per-iteration:
- `{{Index}}` / `{{index}}` - Current iteration number (1-based), available inside all FOR substeps
- `{{Step}}` / `{{step}}` - Qualified current runbook-context execution location (for shorthand runbook-list steps this is `N.1`, `N.2`, ...)
- `{{var}}` - Named loop variable. For numeric ranges, equals the iteration index. For data sources (array/file), holds the current data element.

These are expanded per-iteration, unlike template variables which are expanded once at `rd run` time.

**Iteration semantics:**

Substep transitions control within-iteration flow:

| Action | Effect |
|--------|--------|
| `CONTINUE` | Proceed to next substep (or next iteration if last substep) |
| `NEXT` | Skip remaining substeps, advance to next iteration |
| `BREAK` | Exit the FOR loop; parent step transitions evaluate |
| `STOP` | Halt runbook execution immediately |

FOR-level nested transitions (nested bullets directly under `- FOR ...`) run at **iteration scope**:

| Action | Effect |
|--------|--------|
| `CONTINUE` | Exit loop (current result NOT recorded) → step-level handler |
| `BREAK` | Exit loop immediately (non-accumulating — same as NEXT) |
| `GOTO` | Jump immediately; bypass parent FOR aggregation |
| `STOP` | Stop immediately; bypass parent FOR aggregation |
| `COMPLETE` | Complete immediately; bypass parent FOR aggregation |
| `RETRY N X` | Retry current iteration first, then execute exhausted action `X` |

Parent FOR step transitions (`PASS ALL`, `FAIL ANY`, etc.) aggregate results across all iterations after normal loop completion, iteration-level `BREAK`, or iteration-level `CONTINUE`.

**GOTO AT interaction:**

The `AT` qualifier on GOTO targets specific iterations of a FOR step:

```bash
rundown goto 3        # Jump to FOR step 3 at iteration 1 (restart)
```

In runbook transitions, `GOTO N AT I` enters step N at iteration I. See [GOTO formats](#rundown-goto-step---jump-to-step) for the full table.

**Status display during loops:**

When a FOR loop is active, output includes explicit loop scope and expanded location:
- `For: index/end` (or `index/?` for open-ended data sources)
- `At: STEP.INDEX.SUBSTEP` (display path)

The display path is not an authoring identifier. Canonical runtime identity is `step + substep + iteration`.

#### Data Sources

FOR loops can iterate over arrays or files instead of numeric ranges.

**Defining sources:**

Sources are defined via `--var-json`, `.rundown/config.yaml`, `--var-file`, or `--var` flags. Values are routed based on type:

| Value Pattern | Routing |
|---------------|---------|
| `--var-json items='["a","b"]'` | Comma-joined in vars, JsonArray for iteration |
| `file:path/to/data.jsonl` | JsonArrayStream in vars (lazy streaming) |
| `file:path/to/data.json` | JsonArray or JsonObject in vars (eager load) |
| YAML array `[a, b, c]` | Comma-joined in vars, JsonArray for iteration |
| Scalar string/number | Template vars only (no iteration source) |

**Example `.rundown/config.yaml`:**
```yaml
environment: staging
items:
  - alpha
  - bravo
  - charlie
log_file: file:data/results.jsonl
```

**Example runbook:**
````markdown
## 2 Process items
- FOR item IN {{ items }}
- PASS ALL CONTINUE
- FAIL ANY STOP
### 1 Handle item
- PASS CONTINUE
- FAIL BREAK
Handle {{item}} (iteration {{Index}}).
````

**File formats:**

| Extension | Format | Parsing |
|-----------|--------|---------|
| `.jsonl` | JSON Lines | One JSON value per line (string, number, boolean, null, array, or object) |
| `.json` | JSON | Eagerly loaded as JsonArray or JsonObject |

Only `.json` and `.jsonl` extensions are supported for `file:` sources.

`file:` sources are resolved to a canonical path, confined to the project root, and checked against the active security policy before execution starts. A denied source fails the runbook before the first step.

**JSONL semantics:** Each `.jsonl` line is parsed as a JSON value. When the loop variable holds a parsed JSON object, dotted field access is supported in templates (e.g., `{{item.name}}`). Using `{{item}}` alone renders the serialized JSON string.

**Open-ended iteration:** `FOR item IN {{ source }}` iterates until the source is exhausted, capped at 10,000 iterations.

**Windowed iteration:** `FOR item IN 3 TO 7 OF {{ source }}` reads only items at positions 3 through 7.

**Drift detection:** File sources record a snapshot (size, mtime, SHA-256 fingerprint) at first access. On resume, the snapshot is validated — if the file changed, execution fails with a drift error. Fingerprint comparison allows harmless mtime changes (e.g., backup tools) to pass.

**Validation:** The CLI validates that all sourced FOR clauses reference defined data sources. Missing sources produce: `FOR loop references undefined data source "{{name}}"`.

---

## State Persistence

### File Locations

| Path | Purpose |
|------|---------|
| `.rundown/runs/` | Runbook state files (`wf-YYYY-MM-DD-xxxxx.json`) |
| `.rundown/session.json` | Active runbook tracking and stash state |
| `.rundown/runbooks/` | Runbook source files (discovered for `rundown ls --all`) |

### Session Structure

The session tracks which runbooks are active using a **stack-based model**:

```json
{
  "defaultStack": ["wf-2024-01-07-xyz789"],
  "stashedRunbookId": null
}
```

- **defaultStack**: Active runbook stack (delegation creates nested entries)
- **stashedRunbookId**: Temporarily paused runbook (for `rundown stash`/`rundown pop`)

### Runbook State Structure

Each runbook state file contains:

```json
{
  "id": "wf-2024-01-07-abc123",
  "runbook": "my-runbook.runbook.md",
  "runbookPath": ".rundown/runbooks/my-runbook.runbook.md",
  "title": "My Runbook",
  "description": "Runbook description",
  "step": "2",
  "substep": "1",
  "stepName": "Execute batch",
  "retryCount": 0,
  "variables": { "environment": "staging" },
  "templateVars": { "environment": "staging" },
  "steps": [],
  "substepStates": [
    {
      "substep": "1",
      "delegation": {
        "tokenHash": "abc123...",
        "childRunbookPath": ".rundown/runbooks/child.runbook.md",
        "status": "claimed",
        "childRunId": "wf-2024-01-07-child1"
      }
    }
  ],
  "resolvedCompletions": {},
  "frameEntries": { "2|2": 1 },
  "activeFrameKey": "2|2",
  "activeEntry": 1,
  "forStack": [
    {
      "stepId": "2",
      "iteration": 2,
      "start": 1,
      "variable": "item",
      "source": { "kind": "array", "items": ["alpha", "bravo", "charlie"] },
      "currentValue": "bravo"
    }
  ],
  "iterationResults": ["pass", "pass"],
  "startedAt": "2024-01-07T10:00:00.000Z",
  "updatedAt": "2024-01-07T10:05:00.000Z",
  "prompted": false,
  "lastResult": "pass",
  "lastAction": { "type": "CONTINUE" },
  "runbookSrc": "---\nname: my-runbook\n---\n# My Runbook\n...",
  "snapshot": {}
}
```

Key fields:
- `step`: Current step identifier (string: "1", "ErrorHandler")
- `substep`: Current substep ID (e.g., "1", "2")
- `retryCount`: Current retry attempt
- `steps`: Array of step states for all runbook steps
- `lastAction`: Most recent transition as a structured object (e.g., `{"type": "CONTINUE"}`, `{"type": "GOTO", "target": "3", "at": 2}`)
- `lastResult`: Last PASS/FAIL signal (`pass` or `fail`)
- `runbookPath`: Repo-relative resolved file path to the runbook source
- `runbookSrc`: Raw runbook source content (template placeholders preserved)
- `templateVars`: Frozen template variable map used for deterministic resume rendering
- `forStack`: Active FOR loop stack (present during loop execution; see [FOR Loops](#for-loops))
- `forStack[].source`: Resolved source for the active loop (range, array, or file with snapshot)
- `forStack[].currentValue`: Data element at the current iteration (array/file sources)
- `iterationResults`: Array of per-iteration outcomes (`"pass"` or `"fail"`) for the current loop
- `substepStates[].delegation`: Delegation state for substeps (tokenHash, childRunbookPath, status, childRunId)
- `resolvedCompletions`: Completion records keyed by `frame + entry + substep`
- `frameEntries` / `activeFrameKey` / `activeEntry`: Re-entry-safe frame identity used to reject stale completions
- `snapshot`: XState persisted snapshot for state restoration

---

## Template Variables

Rundown supports template variables using Handlebars syntax `{{variableName}}` for parameterizing runbooks.

### Syntax

````markdown
## 1. Deploy to {{environment}}
```bash
npm run deploy --env={{environment}} --version={{version}}
```
````

### Variable Sources

Variables are collected from multiple sources with the following precedence (highest to lowest):

| Source | Description |
|--------|-------------|
| CLI flags (`--var-file`, `--var`, `--var-json`) | Repeatable, highest priority |
| `RD_VAR_*` environment variables | Prefix stripped (e.g., `RD_VAR_environment` sets `environment`) |
| `.rundown/config.yaml` | Auto-discovered from cwd upward, stops at git root |
| Frontmatter `vars:` field | Variables defined in runbook frontmatter |
| Inherited delegation variables | Parent context in delegation tree |
| INPUTS (context passing) | Fill-gaps-only injection from the inherited live variable space / delegated `finalVars` — see [SPEC.md §7](./SPEC.md#7-context-passing-inputs--outputs) |
| Built-in defaults | System-provided variables — see [SPEC.md §6.1 Built-in Variables](./SPEC.md#61-built-in-variables) for the full table |

### Auto-Discovery

The CLI automatically searches for `.rundown/config.yaml` starting from the current working directory and walking upward. The search stops at:
- The first `.rundown/config.yaml` found
- The git repository root (`.git` directory)
- The filesystem root

Example `.rundown/config.yaml`:
```yaml
environment: staging
version: 1.2.3
db_host: localhost
items:
  - alpha
  - bravo
  - charlie
log_file: file:data/results.jsonl
```

Arrays become data sources for `FOR item IN {{ items }}` — pass inline via `--var-json items='["a","b"]'` or define in YAML config. The `file:` prefix creates file-backed sources. Scalar values remain regular template variables. See [Data Sources](#data-sources) for details.

### Usage Examples

```bash
# Set variables via CLI flags
rundown run deploy.runbook.md --var environment=prod --var version=2.0.0

# Load variables from a file
rundown run deploy.runbook.md --var-file production.yaml

# Combine sources (CLI flags override file values)
rundown run deploy.runbook.md --var-file base.yaml --var environment=prod
```

### Variable Name Requirements

Variable names must match the pattern `/^[a-zA-Z_][a-zA-Z0-9_]*$/`:
- Must start with a letter or underscore
- Can contain letters, digits, and underscores
- Runtime-reserved names (`step`, `index`, `context`) are matched case-insensitively — any casing variant is reserved and cannot be overridden by user variables

### Runtime Context Model

Runtime templating now uses a canonical namespaced context model for nested runbooks:
- `{{context.current.step}}`, `{{context.current.substep}}`, `{{context.current.index}}`, `{{context.current.at}}`
- `{{context.parent.*}}` for nearest parent runbook context
- `{{context.ancestors.0.*}}`, `{{context.ancestors.1.*}}`, ... for deeper ancestry (0 = nearest parent)
- `{{context.vars.NAME}}` for user/config/frontmatter variables

Top-level aliases are retained for ergonomics:
- `{{Step}}` / `{{step}}` always refer to the current runbook context
- `{{Index}}` / `{{index}}` always refer to the current runbook context loop index

### Undefined Variables

Undefined variables and missing dotted paths are preserved as literal placeholders (`{{variable}}`, `{{context.parent.missing}}`) rather than causing an error. A deduplicated warning is emitted to stderr for each undefined variable.

### State Persistence

`state.runbookSrc` stores raw runbook source, while `state.templateVars` stores the resolved variable map. On resume, FOR bounds and template placeholders are re-applied deterministically from this frozen variable state.

### Distinction from Template Usage

Template variables are expanded before parsing and should not be confused with step identifiers:
- `{{variable}}` - Template variable, expanded before parsing (e.g., `{{environment}}` becomes `production`)
- Dotted paths are resolved consistently across startup substitution, runtime loop expansion, and runbook path expansion (for example `runbooks/focus-{{context.parent.index}}.runbook.md`). Runbook file paths use the same template variable expansion rules as step content.

---

## Security Policy

Rundown enforces a security policy layer to control what commands runbooks can execute.

### Default Behavior

See [SECURITY.md](./SECURITY.md) for full default policy details, including command allow/block/prompt behavior, sandbox-on-by-default enforcement, and the default write allowlist (Rundown state paths under `.rundown/`, plus `.claude/**`, `node_modules/**`, `dist/**`, `build/**`, `.next/**`, and `{tmp}/**`).

### Quick Reference

| Flag | Effect |
|------|--------|
| `--allow-run <cmds>` | Allow specific commands (comma-separated) |
| `--allow-read <paths>` | Allow reading specific paths |
| `--allow-write <paths>` | Allow writing to specific paths |
| `--allow-env <vars>` | Allow specific environment variables |
| `--allow-all` | Bypass all policy checks |
| `--deny-all` | Block all commands not explicitly allowed |
| `-y, --yes` | Auto-approve prompts |
| `--non-interactive` | CI mode (auto-deny unlisted commands) |
| `--policy <file>` | Use custom policy file |
| `--trust-js-policy` | Trust an explicitly selected JS policy file |
| `--sandbox` | Enable OS-level filesystem sandbox |
| `--no-sandbox` | Disable sandbox enforcement |
| `--sandbox-strict` | Fail if sandbox is unavailable |

Policy discovery is data-only by default: `.rundownrc`, `.rundownrc.json`, `.rundownrc.yaml`, `.rundownrc.yml`, or the `rundown` field in `package.json`. Executable `rundown.config.js/.cjs/.mjs` files are only loaded when passed via `--policy` together with `--trust-js-policy`.

### Examples

```bash
# Allow specific commands for this run
rundown run deploy.runbook.md --allow-run docker,kubectl

# Allow file operations
rundown run backup.runbook.md --allow-read /var/log --allow-write /backup

# CI/CD: auto-approve with pre-approved commands
rundown run test.runbook.md --yes --allow-run npm,jest

# CI/CD: strict mode with no prompts
rundown run test.runbook.md --non-interactive
```

See [Security Documentation](SECURITY.md) for full details.

---

## CLI Commands

### Runbook Lifecycle

#### `rundown run <file>` - Start Runbook

Start a new runbook from a runbook file.

```bash
rundown run my-runbook.runbook.md
rundown run my-runbook.runbook.md --prompted  # Disable automatic execution
rundown run my-runbook.runbook.md --var key=value  # Set template variable (repeatable)
rundown run my-runbook.runbook.md --var-file vars.yaml  # Load variables from YAML file
```

**Behavior:**
1. Parse runbook file
2. Create runbook state with unique ID
3. Push runbook to session stack
4. Enter execution loop

**Execution Loop:**
- Auto-execute bash code blocks (unless `--prompted`)
- Exit code 0 = PASS, non-zero = FAIL
- Stop at prompt-only steps (no code block)
- Continue until COMPLETE or STOP

**With `--prompted`:**
- Commands displayed but not executed
- Agent must run command manually
- Use `rundown pass` or `rundown fail` after command

#### `rundown stop` - Abort Runbook

Immediately terminate the active runbook.

```bash
rundown stop [message]
```

Deletes runbook state and clears from session.

#### `rundown complete [message]` - Force Early Completion

Manually complete a runbook before reaching the final step.

**Note:** Runbooks auto-complete when the final step's PASS transition executes and there are no more steps. This command is only needed for early exit scenarios.

```bash
rundown complete                            # Force completion from current step
rundown complete "Skipping remaining steps" # Complete with message
```

**When to use:**
- Early exit when remaining steps are unnecessary
- Agent-driven workflows requiring explicit completion
- Graceful exit from steps without explicit completion transitions

**Comparison with `stop`:**
- `complete` - Marks runbook as **successful**, preserves state
- `stop` - Marks runbook as **aborted/failed**, deletes state

### State Transitions

#### `rundown pass` - Mark Step Passed

Signal successful step completion.

```bash
rundown pass
rundown pass --step 2.1              # Target a specific substep
rundown pass --step 2.1 --index 3    # Target substep at FOR iteration 3
```

**Aliases:** `rundown yes`, `rundown ok`

**Flags:**
- `--step <stepId>` — Target a specific substep (not the currently active one).
- `--index <number>` — FOR loop iteration to target (requires `--step`).

**Behavior:**
1. Send PASS event to XState
2. Evaluate PASS transition
3. Execute resulting action
4. Print action taken and new step

#### `rundown fail` - Mark Step Failed

Signal step failure.

```bash
rundown fail
rundown fail --step 2.1              # Target a specific substep
rundown fail --step 2.1 --index 3    # Target substep at FOR iteration 3
```

**Alias:** `rundown no`

**Flags:**
- `--step <stepId>` — Target a specific substep (not the currently active one).
- `--index <number>` — FOR loop iteration to target (requires `--step`).

**Behavior:**
1. Send FAIL event to XState
2. Evaluate FAIL transition (may trigger RETRY)
3. Execute resulting action
4. Print action taken

For RETRY transitions:
- If `retryCount < max`: increment count, stay in step
- If exhausted: execute fallback action (default: STOP)

#### `rundown goto <step>` - Jump to Step

Navigate directly to a step.

```bash
rundown goto 3                # Jump to step 3
rundown goto 3.1              # Jump to substep 3.1
rundown goto 3 --index 2      # Jump to step 3 and enter FOR iteration 2
```

**Flags:**
- `--index <number>` — For FOR-annotated targets, enter the loop at the specified iteration.

**Restrictions:**
- Target must exist
- Resets retryCount to 0
- Clears lastResult (prevents stale state)

**Valid GOTO Formats (in runbook transitions):**

| Target | Valid From | Description |
|--------|------------|-------------|
| `GOTO N` | Any step | Jump to step N (if FOR step, implies AT 1) |
| `GOTO N.M` | Any step | Jump to substep M of step N |
| `GOTO Name` | Any step | Jump to named step |
| `GOTO Name.M` | Any step | Jump to substep M of named step |
| `GOTO N AT I` | Any step | Enter FOR step N at iteration I (only if N is a FOR step) |
| `GOTO N.M AT I` | Any step | Jump to substep M of FOR step N at iteration I |
| `GOTO Name AT I` | Any step | Enter named FOR step at iteration I |

The `AT` qualifier is only valid when the target is a step with a FOR annotation. If `AT` is omitted for a FOR step, it defaults to iteration 1 (restart from beginning). See [SPEC.md Actions](./SPEC.md#42-actions) for full details.

### Status Commands

#### `rundown status` - Show Current State

Display active runbook information.

```bash
rundown status
```

**Output:**
```
File:     my-runbook.runbook.md
State:    .rundown/runs/wf-2024-01-07-abc123.json
Action:   CONTINUE
Result:   PASS

For:      2/5
At:       3.2.1

Execute batch...
```

#### `rundown ls` - List Runbooks

List active or available runbooks.

```bash
rundown ls           # List active runbooks (JSON output by default)
rundown ls --all     # List available runbook files
rundown ls --all --tags review  # Filter by tag
```

**Active runbook status values:**
- `active` - Currently executing
- `stashed` - Paused via `rundown stash`
- `complete` - Successfully finished
- `stopped` - Terminated with failure
- `inactive` - In session but not active

**Columns (for `--all`):** `NAME`, `SOURCE`, `DESCRIPTION`, `TAGS`. The `SOURCE` column indicates where each runbook was discovered (`project`, `plugin`, or `bundled`) — see [Runbook Discovery](#runbook-discovery) and [Table Output](#table-output) for the column layout.

### Enforcement Control

#### `rundown stash` - Pause Enforcement

Temporarily pause runbook tracking.

```bash
rundown stash
```

Removes active runbook from stack, preserves state.

#### `rundown pop` - Resume Enforcement

Resume from stashed runbook.

```bash
rundown pop
```

Restores stashed runbook to active stack.

### Validation

#### `rundown check <file>` - Validate Runbook

Check a runbook file for syntax errors.

```bash
rundown check my-runbook.runbook.md
```

**Output:**
```
PASS: 5 steps, 3 substeps
```
or
```
FAIL: 2 errors

Line 15: Step 3 missing (expected sequential numbering)
Line 22: Invalid transition: GOTO 10 (step does not exist)
```

### Maintenance

#### `rundown prune` - Remove Runbook State

Clean up runbook state files (not runbook source files).

```bash
rundown prune               # Remove completed runbooks (default)
rundown prune --all         # Remove all runbook state
rundown prune --dry-run     # Preview what would be removed
rundown prune --completed   # Only completed
rundown prune --inactive    # Only inactive
rundown prune --active      # Only active (careful!)
```

### Testing and Utilities

#### `rundown echo` - Test Helper

Echo command for runbook testing. Supports configurable pass/fail result sequences (useful for exercising retry logic).

```bash
rundown echo [command...]
rundown echo -r pass                # Configure result (repeatable)
rundown echo -r fail -r pass        # Sequence: fail first, then pass
rundown echo --json                 # JSON output
```

#### `rundown resolve <file>` - Resolve Variables

Resolve and validate template variables and data sources for a runbook without executing it.

```bash
rundown resolve my-runbook.runbook.md
rundown resolve my-runbook.runbook.md --var environment=staging
rundown resolve my-runbook.runbook.md --json
```

Useful for verifying that required variables are satisfied and data sources resolve before running.

#### `rundown prompt <content>` - Emit Prompt Content

Output content wrapped in markdown fences. Used by the runtime to render `prompt` code blocks; can also be invoked directly.

```bash
rundown prompt 'Review the implementation'
rundown prompt 'Review the implementation' --json
```

#### `rundown scenario` - Runbook Scenarios

List, show, or execute scenarios declared in a runbook's frontmatter (see [SCENARIOS.md](./SCENARIOS.md)).

```bash
rundown scenario ls <file>                  # List scenarios
rundown scenario show <file> <name>         # Show scenario details
rundown scenario run <file> <name>          # Execute and verify
rundown scenario run <file> <name> --quiet  # Suppress command output
rundown scenario ls <file> --json           # JSON output (also on show/run)
```

#### `rundown scenario-suite` - Scenario Suites

List, show, or execute cases from a scenario suite file.

```bash
rundown scenario-suite ls <suite-file>
rundown scenario-suite show <suite-file> <case>
rundown scenario-suite run <suite-file> <case>
rundown scenario-suite run <suite-file> --all      # Run all cases
rundown scenario-suite run <suite-file> --quiet    # Suppress output
```

#### Sibling CLIs: `rdpath` and `rdx`

Two companion CLIs ship alongside `rundown`:

- **`rdpath`** — Path assembly tool for date-prefixed filenames and context-scoped paths. See [RDPATH.md](./RDPATH.md).
- **`rdx`** — JSON-to-Markdown renderer with optional schema validation. See [RDX.md](./RDX.md).

### Delegation Commands

| Command | Description |
|---------|-------------|
| `rd delegate <runbook> --step <id>` | Delegate substep to child runbook |
| `rd delegate <runbook> --step <id> --var key=value` | Delegate with variables |
| `rd claim <token>` | Claim a delegation token and launch child |
| `rd claim <token> --var key=value` | Claim with variables |
| `rd abort <token>` | Cancel a delegation token |
| `rd abort <token> --force` | Cancel a claimed delegation |

Delegation semantics:
- `delegate` requires a child runbook as a positional argument and `--step` to identify the target substep.
- `claim` uses the delegation token (printed by `delegate`) to launch the child runbook.
- Child runbook uses plain `rd pass` / `rd fail` to report its outcome.
- Completion routing is frame + entry aware (`frame + entry + substep`) to prevent stale re-entry completions from being applied.

### Runtime Identity Glossary

- **Frame (internal):** Execution scope key `step|iteration` (for example `2|` or `2|3`).
- **Entry (internal):** Monotonic re-entry counter for a frame (`1`, `2`, `3`, ...).
- **Completion key (internal):** `frame + entry + substep`.
- **Why both frame and entry:** Re-entering the same frame (for example via `GOTO` or `RETRY`) increments `entry`, so completions from older entries are rejected as stale.

---

## Common Tasks

### Task: Run a Simple Sequential Runbook

```bash
# Start the runbook
rundown run myrunbook.runbook.md

# After completing each step, signal the outcome
rundown pass    # or rundown yes, rundown ok
rundown fail    # Step failed, apply FAIL transition
```

### Task: Check Runbook Status

```bash
rundown status
```

Output shows:
- Current runbook file
- State file location
- Current action location (`At`) and optional loop scope (`For`)
- Last action taken

### Task: Jump to a Specific Step

```bash
rundown goto 3       # Jump to step 3
rundown goto 2.1     # Jump to substep 1 of step 2
```

### Task: Pause and Resume a Runbook

```bash
# Pause (state preserved, enforcement paused)
rundown stash

# Do untracked work...

# Resume
rundown pop
```

### Task: List Runbooks

```bash
# List active/running runbooks
rundown ls

# List all available runbook files
rundown ls --all

# Filter by tags
rundown ls --all --tags tdd,review
```

### Task: Validate a Runbook Before Running

```bash
rundown check myrunbook.runbook.md
```

Output: `PASS: N steps` or `FAIL: error details`

### Task: Clean Up Old Runbook State

```bash
# Preview what would be removed
rundown prune --dry-run

# Remove completed runbook state
rundown prune --completed

# Remove all state
rundown prune --all
```

---

## Delegation Patterns

> **See also:** [AGENT-ORCHESTRATION.md](./AGENT-ORCHESTRATION.md) for subagent delegation workflow, context file discovery, and delegation completion.

### Pattern 1: Orchestrator Control

Main agent runs runbook, dispatches subagents for substeps.

**Runbook structure:**
```markdown
## 2. Execute batch
- PASS ALL CONTINUE
- FAIL ANY GOTO 4

### 2.1 Process item
  - task.runbook.md
```

**Command sequence:**
```bash
# 1. Main agent starts parent runbook
rd run runbook.runbook.md

# 2. At substep, main agent delegates to child runbook
rd delegate task.runbook.md --step 2.1

# 3. Subagent claims the delegation token
rd claim <token>

# 4. Subagent works through child runbook...

# 5. Subagent reports result (plain pass/fail, no --agent needed)
rd pass    # or: rd fail
```

**Key points:**
- `delegate` requires the child runbook as a positional argument and `--step` to identify the target substep
- The delegation token printed by `delegate` is passed to `claim` by the subagent
- Child uses plain `rd pass` / `rd fail` — no `--agent` flag needed
- Completions are validated against frame + entry identity; stale completions from prior re-entry are rejected
- Valid completions are recorded and drained in deterministic substep order before step-level transition

### Pattern 2: Agent-Controlled Branching

Agent decides next action based on context.

```markdown
## 5. Check remaining
- PASS CONTINUE
- FAIL STOP

Check TodoWrite for remaining items.

If more remain: `rundown goto 3`
If complete: `rundown pass`
```

Agent reads step, evaluates condition, runs appropriate CLI command.

---

## Output Format

Output formatting is implemented in `packages/cli/src/services/output-emitter.ts` and `packages/cli/src/helpers/table-formatter.ts`.

### Standard Output Structure

```
File:     runbook.runbook.md
State:    .rundown/runs/wf-xxx.json
Action:   START
At:       1/5

Step description here...

$ npm test

-----
Action:   CONTINUE
From:     1.1.1
Result:   PASS
For:      2/5
At:       1.2.1

Next step description...

Runbook:  COMPLETE
```

### Table Output

List commands (`rd ls`, `rd scenario ls`) use aligned tables following Linux CLI conventions:

| Convention | Standard |
|------------|----------|
| **Headers** | UPPERCASE, first row, no decorative lines |
| **Alignment** | Left for text, right for numbers |
| **Separator** | 2 spaces between columns |
| **Last column** | Extends to end (no padding) |
| **Empty values** | Empty string |
| **Machine output** | JSON output by default |

Example (`rd ls --all`):
```
NAME           SOURCE   DESCRIPTION                    TAGS
retry-success  bundled  Tests RETRY before exhaustion  retry, auto-exec
simple         project  Basic two-step runbook
```

Example (`rd scenario ls`):
```
NAME              EXPECTED  DESCRIPTION                   TAGS
completed         COMPLETE  Step passes on first attempt
retry-exhaustion  STOP      Retries exhausted, stops
```

### Detail Views

Single-item display commands (`rd scenario show`) use aligned key-value format:

| Convention | Standard |
|------------|----------|
| **Key alignment** | Pad to longest key + `:` |
| **Format** | `Key:` followed by spaces to align values |
| **Nested items** | Indent 2 spaces under label |

Example (`rd scenario show`):
```
Name:        completed
Description: Step passes on first attempt
Expected:    COMPLETE
Commands:
  $ rd run --prompted retry-success.runbook.md
  $ rd pass
```

### Command Execution Output

Commands that execute operations (`rd scenario run`) use a Scenario/Execution/Result structure:

```
Scenario: scenario-name

---
$ rd run --prompted file.runbook.md
$ rd pass

Scenario: COMPLETE
```

### Key Elements

| Element | Description |
|---------|-------------|
| `File:` | Runbook file path |
| `State:` | State JSON file path |
| `Action:` | Last action (START, CONTINUE, GOTO, RETRY, COMPLETE, STOP) |
| `From:` | Previous step position |
| `Result:` | PASS or FAIL |
| `For:` | Loop scope (`index/end` or `index/?`) when in FOR execution |
| `At:` | Current execution path (display path, e.g. `1.2.1`) |
| `$` | Command being executed |
| `---` | Separator between scenario commands |
| `Runbook:` | Runbook terminal state (COMPLETE, STOPPED, STASHED) |

JSON output compatibility:
- Existing position fields (`current`, `substep`, `total`) are preserved.
- Loop/location-aware fields are additive and optional: `position.at`, `position.for.index`, `position.for.end`.
- `targetAt` is derived at output boundaries from canonical target identity fields.

---

## Troubleshooting and Error Handling

### Common Errors and Resolutions

| Error | Cause | Resolution |
|-------|-------|------------|
| "No active runbook" | No runbook in stack | Run `rundown run <file>` |
| "Runbook file not found" | Missing runbook | Check file path |
| "Step N does not exist" | Invalid GOTO target | Check step numbers |
| "Invalid step target" | Bad goto format | Use "N" or "N.M" |
| "FOR loop references undefined data source" | Sourced FOR clause without matching source | Define source via --var-json, config.yaml, or --var-file |
| "File drift detected" | Data file changed during iteration | Ensure file stability or restart runbook |

### State Recovery

If state becomes corrupted:
1. `rundown ls` - Check active runbooks
2. `rundown stop [message]` - Clear active runbook
3. `rundown prune --all` - Remove all state
4. `rundown run <file>` - Restart fresh

---

## Integration with Claude Code

See [AGENT-ORCHESTRATION.md](./AGENT-ORCHESTRATION.md) for context file discovery and subagent delegation.

### Context Injection

Active runbook prompt auto-injects into Claude conversations via hooks.

### Session Persistence

Both runbook state and session tracking survive:
- Context clears
- Session restarts
- Agent handoffs

---

## CLI Quick Reference

```bash
# Lifecycle
rundown run <file>           # Start runbook
rundown stop [message]       # Abort runbook with optional message
rundown complete [message]   # Force early completion (auto-complete on final step)

# Transitions
rundown pass                 # Step succeeded (aliases: yes, ok)
rundown fail                 # Step failed (alias: no)
rundown goto <N>             # Jump to step N
rundown goto <N.M>           # Jump to substep N.M

# Status
rundown status               # Show current state
rundown ls                   # List active runbooks
rundown ls --all             # List available runbooks

# Enforcement
rundown stash                # Pause enforcement
rundown pop                  # Resume enforcement

# Maintenance
rundown check <file>         # Validate runbook
rundown resolve <file>       # Resolve and validate variables/data sources
rundown prune                # Clean up state

# Testing and utilities
rundown echo [command...]              # Test helper (configurable pass/fail)
rundown prompt <content>               # Output content in markdown fences
rundown scenario ls <file>             # List runbook scenarios
rundown scenario show <file> <name>    # Show scenario details
rundown scenario run <file> <name>     # Execute a scenario
rundown scenario-suite ls <suite>      # List scenario-suite cases
rundown scenario-suite run <suite>     # Execute suite case(s)

# Sibling CLIs
rdpath --dir <path>          # Path assembly tool (see RDPATH.md)
rdx <file>                   # Render JSON to Markdown (see RDX.md)

# Delegation
rd delegate <runbook> --step <id>  # Delegate substep to child runbook
rd claim <token>                   # Claim delegation token
rd abort <token>                   # Cancel delegation token
```
