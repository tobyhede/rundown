# Rundown Runtime Reference

This document covers Rundown's execution model, state management, template variables, FOR loop semantics, security policy, and runtime identity. For the CLI command reference and user guide, see [docs/reference/cli.md](cli.md). For internal architecture, see [docs/internal/architecture.md](../internal/architecture.md).

---

## Table of Contents

- [Execution Model](#execution-model)
- [Command Execution](#command-execution)
- [FOR Loops](#for-loops)
  - [FOR Clause Variants](#for-clause-variants)
  - [Loop Variable Expansion](#loop-variable-expansion)
  - [Iteration Semantics](#iteration-semantics)
  - [GOTO AT Interaction](#goto-at-interaction)
  - [Data Sources](#data-sources)
- [State Persistence](#state-persistence)
  - [File Locations](#file-locations)
  - [Session Structure](#session-structure)
  - [Runbook State Structure](#runbook-state-structure)
- [Template Variables](#template-variables)
  - [Variable Sources](#variable-sources)
  - [Auto-Discovery](#auto-discovery)
  - [Variable Name Requirements](#variable-name-requirements)
  - [Runtime Context Model](#runtime-context-model)
  - [Undefined Variables](#undefined-variables)
  - [Template Variable Persistence](#template-variable-persistence)
- [Security Policy](#security-policy)
- [Runtime Identity Glossary](#runtime-identity-glossary)

---

## Execution Model

Rundown separates **runbook definition** from **state tracking**:

| Component | Role |
|-----------|------|
| **Runbook file** | Markdown document defining steps, transitions, and conditions |
| **CLI (`rundown`)** | Tracks runbook state: current step, retry count, variables |
| **Agent (Claude)** | Executes work, uses CLI to report outcomes |

**Key concept:** The CLI tracks which step you are on and what happens when you report PASS or FAIL. For code blocks, it can execute commands automatically. Otherwise, the agent (or user) does the actual work.

---

## Command Execution

| Behavior | Triggered By | What Happens |
|----------|-------------|--------------|
| **Automatic** | Step has `bash` or `prompt` code block | CLI runs command, exit code determines PASS/FAIL |
| **Manual** | `--prompted` flag, or step has neither a bash nor prompt code block | CLI waits for manual `rd pass` or `rd fail` |

**Note:** A `prompt` code block becomes an `rd prompt '...'` command that outputs the content wrapped in markdown fences. It executes automatically like `bash` blocks.

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

---

## FOR Loops

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

See [docs/spec/language.md Iteration (FOR)](../spec/language.md#5-iteration-for) for the full grammar and all clause variants.

### FOR Clause Variants

| Syntax | Description |
|--------|-------------|
| `FOR var IN 1 TO N` | Explicit range, named variable |
| `FOR 1 TO N` | Explicit range, no variable |
| `FOR var IN N` | Implicit start (1), named variable |
| `FOR N` | Implicit start (1), no variable |
| `FOR var IN {{ source }}` | All items from data source |
| `FOR var IN 1 TO N OF {{ source }}` | Windowed data source |

### Loop Variable Expansion

The named loop variable plus runtime step/index aliases are expanded per-iteration:
- `{{Index}}` / `{{index}}` - Current iteration number (1-based), available inside all FOR substeps
- `{{Step}}` / `{{step}}` - Qualified current runbook-context execution location (for shorthand runbook-list steps this is `N.1`, `N.2`, ...)
- `{{var}}` - Named loop variable. For numeric ranges, equals the iteration index. For data sources (array/file), holds the current data element.

These are expanded per-iteration, unlike template variables which are expanded once at `rd run` time.

### Iteration Semantics

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

### GOTO AT Interaction

The `AT` qualifier on GOTO targets specific iterations of a FOR step:

```bash
rundown goto 3        # Jump to FOR step 3
```

In runbook transitions, `GOTO N AT I` enters step N at iteration I. When `AT` is omitted for a FOR step, the default is defined in [docs/spec/language.md §4.2](../spec/language.md#42-actions). See [docs/reference/cli.md GOTO formats](cli.md#rundown-goto-step---jump-to-step) for the full valid-format table.

**Status display during loops:**

When a FOR loop is active, output includes explicit loop scope and expanded location:
- `For: index/end` (or `index/?` for open-ended data sources)
- `At: STEP.INDEX.SUBSTEP` (display path)

The display path is not an authoring identifier. Canonical runtime identity is `step + substep + iteration`.

### Data Sources

FOR loops can iterate over arrays or files instead of numeric ranges.

**Defining sources:**

Sources are defined via `--input-json`, `.rundown/config.yaml`, `--input-file`, or `--input` flags. Values are routed based on type:

| Value Pattern | Routing |
|---------------|---------|
| `--input-json items='["a","b"]'` | Comma-joined in vars, JsonArray for iteration |
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

The session tracks top-level runbooks with a default stack and delegated children with explicit claim ids:

```json
{
  "defaultStack": ["wf-2026-04-28-parent"],
  "stashedRunbookId": null,
  "claims": {
    "rdclm_F3J3n3d_f8fo0a0b1B2c3Q": {
      "kind": "claim-record",
      "claimId": "rdclm_F3J3n3d_f8fo0a0b1B2c3Q",
      "childRunId": "wf-2026-04-28-child",
      "tokenHash": "sha256:...",
      "parentRunId": "wf-2026-04-28-parent",
      "parentStepId": "1.1",
      "parentFrameKey": "1|",
      "parentEntry": 1,
      "claimedAt": "2026-04-28T00:00:00.000Z",
      "updatedAt": "2026-04-28T00:00:00.000Z"
    }
  }
}
```

- **defaultStack**: Legacy/default active runbook stack for top-level, inline, and unidentified/manual flows.
- **stashedRunbookId**: Temporarily paused runbook (for `rundown stash`/`rundown pop`).
- **claims**: Map of `rdclm_...` handles returned by `rd claim`, each pointing at exactly one delegated child runbook and its parent linkage.

Claimed delegated children are not pushed onto `defaultStack`. Commands that accept `--claim-id` (`status`, `pass`, `fail`, `collect`, `goto`, `stash`, `pop`, `stop`, and `complete`) resolve the exact child runbook for that claim and fail closed if the claim is missing, stale, terminal, or no longer linked to a live parent.

`stash` and `pop` target either the default stack or a claim id:
- Plain `stash` moves the default-stack active runbook into the single stash slot.
- `stash --claim-id <id>` stashes the claimed child while preserving the claim record.
- Plain `pop` restores only default-stack stashes.
- `pop --claim-id <id>` restores the child for that claim id after verifying the delegated parent is still active.

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
      "id": "1",
      "frameKey": "2|",
      "status": "done",
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
- `substepStates[].id`: Substep identifier matching `Substep.id` (e.g., "1", "2")
- `substepStates[].frameKey`: Scopes identity in FOR loops (e.g., "2|" or "2|3")
- `substepStates[].status`: Substep lifecycle state (`pending`, `running`, `done`)
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
| CLI flags (`--input-file`, `--input`, `--input-json`) | Repeatable, highest priority |
| `RD_INPUT_*` environment variables | Prefix stripped (e.g., `RD_INPUT_environment` sets `environment`) |
| Inherited delegation variables | Parent context in delegation tree |
| `.rundown/config.yaml` | Auto-discovered from cwd upward, stops at git root |
| Built-in defaults | System-provided variables — see [Built-in Variables](#built-in-variables) for the full table |
| INPUTS (context passing) | Fill-gaps-only injection from the inherited live variable space / delegated `finalVars` — see [docs/spec/language.md §7](../spec/language.md#7-context-passing-outputs) |

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

Arrays become data sources for `FOR item IN {{ items }}` — pass inline via `--input-json items='["a","b"]'` or define in YAML config. The `file:` prefix creates file-backed sources. Scalar values remain regular template variables. See [Data Sources](#data-sources) for details.

### Usage Examples

```bash
# Set variables via CLI flags
rundown run deploy.runbook.md --input environment=prod --input version=2.0.0

# Load variables from a file
rundown run deploy.runbook.md --input-file production.yaml

# Combine sources (CLI flags override file values)
rundown run deploy.runbook.md --input-file base.yaml --input environment=prod
```

### Built-in Variables

Rundown sets the following built-in variables once per execution (unless marked dynamic per-step). PascalCase is canonical; lowercase aliases `step` and `index` are also accepted.

| Variable | Example Value | Description |
|----------|---------------|-------------|
| `Date` | `2026-02-04` | Current date (YYYY-MM-DD) |
| `DateTime` | `2026-02-04T10:30:00.000Z` | Full ISO 8601 timestamp |
| `Year` | `2026` | Current year |
| `Month` | `02` | Current month (01-12) |
| `Day` | `04` | Current day (01-31) |
| `Branch` | `feature/my-work` | Current git branch name (empty when not in git) |
| `WorkPath` | `.rundown/work/feature-my-work` | Branch-isolated artifact directory (falls back to `.rundown/work` outside git). Default base directory for the `{{ path "..." }}` helper used in OUTPUTS expressions. |
| `RunId` | `4a7f0c3e` | Unique-per-execution identifier (fresh 8-char hex per execution; each child in a delegation tree gets its own) |
| `ContextId` | `a3b8c1d2` | Shared identity across a delegation tree. Scopes `{{ path "..." }}` helper output into `.rd-<ContextId>/` for context passing. Children inherit the parent's `ContextId` via `--input`. Overridable via `--input ContextId=<name>` for a meaningful identifier (e.g., `sprint-42`). |
| `Step` | `3.1` | Current qualified step identifier (dynamic per step) |
| `Index` | `3` | Current loop iteration number inside FOR (dynamic per iteration) |
| `context.current.step` | `3.1` | Canonical current step identifier (dynamic) |
| `context.current.substep` | `1` | Current substep number when in a substep (dynamic) |
| `context.current.index` | `3` | Current loop iteration inside FOR (dynamic) |
| `context.current.at` | `3.3.1` | Full execution position (`STEP.INDEX.SUBSTEP` inside a FOR loop, `STEP.SUBSTEP` otherwise) (dynamic) |

Static variables (`Date`, `DateTime`, `Year`, `Month`, `Day`, `Branch`, `WorkPath`, `RunId`, `ContextId`) can be overridden via `--input`. Dynamic variables (`Step`, `Index`, `context.current.*` and their lowercase aliases) reflect the current execution position and cannot be overridden. The variable name `context` is reserved.

**Plugin Variables:** When a runbook is resolved from a plugin source (e.g., `rundown:write-plan`), Rundown auto-injects additional variables using UPPER_SNAKE_CASE:

| Variable | Description |
|----------|-------------|
| `CLAUDE_PLUGIN_ROOT` | Plugin installation directory |

Plugin variables sit in the precedence chain just below CLI flags and can be overridden via `--input`.

### Shell Environment

The built-in variables `WorkPath`, `ContextId`, and `RunId` are injected into each shell block's subprocess environment as `RD_WORK_PATH`, `RD_CONTEXT_ID`, and `RD_RUN_ID` respectively. These are injected after policy environment filtering using rundown-wins semantics (they are always present and cannot be blocked by user-supplied environment variables). The `RD_` prefix is reserved for rundown-injected environment variables; see also `RD_OUTPUTS_*` for file-backed output channels in [docs/spec/language.md §7](../spec/language.md#7-context-passing-outputs).

### Variable Name Requirements

Variable names must match the pattern `/^[a-zA-Z_][a-zA-Z0-9_]*$/`:
- Must start with a letter or underscore
- Can contain letters, digits, and underscores
- Runtime-reserved names (`step`, `index`, `context`) are matched case-insensitively — any casing variant is reserved and cannot be overridden by user variables

### Runtime Context Model

Runtime templating uses a canonical namespaced context model for nested runbooks:
- `{{context.current.step}}`, `{{context.current.substep}}`, `{{context.current.index}}`, `{{context.current.at}}`
- `{{context.parent.*}}` for nearest parent runbook context
- `{{context.ancestors.0.*}}`, `{{context.ancestors.1.*}}`, ... for deeper ancestry (0 = nearest parent)
- `{{context.vars.NAME}}` for user/config/frontmatter variables

Top-level aliases are retained for ergonomics:
- `{{Step}}` / `{{step}}` always refer to the current runbook context
- `{{Index}}` / `{{index}}` always refer to the current runbook context loop index

### Undefined Variables

Undefined variables and missing dotted paths are preserved as literal placeholders (`{{variable}}`, `{{context.parent.missing}}`) rather than causing an error. A deduplicated warning is emitted to stderr for each undefined variable.

### Template Variable Persistence

`state.runbookSrc` stores raw runbook source, while `state.templateVars` stores the resolved variable map. On resume, FOR bounds and template placeholders are re-applied deterministically from this frozen variable state.

Template variables are expanded before parsing and should not be confused with step identifiers:
- `{{variable}}` - Template variable, expanded before parsing (e.g., `{{environment}}` becomes `production`)
- Dotted paths are resolved consistently across startup substitution, runtime loop expansion, and runbook path expansion (for example `runbooks/focus-{{context.parent.index}}.runbook.md`). Runbook file paths use the same template variable expansion rules as step content.

---

## Security Policy

Rundown enforces a security policy layer to control what commands runbooks can execute. See [docs/reference/security.md](security.md) for the full policy specification including default command allow/block/prompt behavior, sandbox enforcement, and the default write allowlist.

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
| `--trust-js-policy` | Trust an explicitly selected JS policy file and helper modules declared by policy config |
| `--sandbox` | Enable OS-level filesystem sandbox |
| `--no-sandbox` | Disable sandbox enforcement |
| `--sandbox-strict` | Fail if sandbox is unavailable |

Policy discovery is data-only by default: `.rundownrc`, `.rundownrc.json`, `.rundownrc.yaml`, `.rundownrc.yml`, or the `rundown` field in `package.json`. Executable `rundown.config.js/.cjs/.mjs` files are only loaded when passed via `--policy` together with `--trust-js-policy`. Helper modules declared by policy config are also executable code and are skipped unless `--trust-js-policy` is set; `--helpers` remains an explicit CLI opt-in.

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

---

## Runtime Identity Glossary

- **Frame (internal):** Execution scope key `step|iteration` (for example `2|` or `2|3`).
- **Entry (internal):** Monotonic re-entry counter for a frame (`1`, `2`, `3`, ...).
- **Completion key (internal):** `frame + entry + substep`.
- **Why both frame and entry:** Re-entering the same frame (for example via `GOTO` or `RETRY`) increments `entry`, so completions from older entries are rejected as stale.
