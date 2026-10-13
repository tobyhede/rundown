# Rundown Runtime Specification

This document defines Rundown runtime behavior: execution state, iteration,
data-source handling, variable resolution, persisted state, and runtime
identity. For authoring syntax, see
[docs/spec/language.md](../spec/language.md). For CLI usage, see
[docs/reference/cli.md](cli.md). For the full security policy contract, see
[docs/reference/security.md](security.md).

## 1. Scope

This specification covers behavior after a runbook has been selected for
execution. It defines how the runtime evaluates commands, advances steps,
resolves variables, stores state, and handles data sources.

This specification does not define Rundown document syntax, CLI command-line
parsing, JSON output shape, policy file format, or implementation architecture
except where those topics affect runtime correctness.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 2. Terminology

| Term             | Meaning                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Runtime          | The CLI-managed execution process for one or more runbooks.                               |
| Run              | One active or persisted execution of a runbook, identified by its run id (`rd_<32 hex>`). |
| Run state        | One run's state persisted in `.rundown/rundown.db`.                                       |
| Owner Token      | `rdo_…` secret printed once by `rundown run`; the sole authority to mutate that run.      |
| Frame            | Internal execution scope key: `step\|iteration`.                                          |
| Entry            | Monotonic re-entry counter for a frame.                                                   |
| Data source      | Runtime value used by `FOR ... IN {{ source }}` iteration.                                |
| Static variable  | Variable resolved once at run startup.                                                    |
| Dynamic variable | Variable derived from the current step, substep, or iteration frame.                      |

<a id="execution-model"></a>

## 3. Runtime Model

Rundown separates runbook definition from runtime state.

| Component      | Runtime role                                                                                |
| -------------- | ------------------------------------------------------------------------------------------- |
| Runbook source | Defines steps, transitions, commands, inputs, outputs, and control flow.                    |
| Runtime state  | Tracks current position, variables, retries, loop state, and persisted snapshot.            |
| Agent or user  | Performs prompted work and reports `PASS` or `FAIL`.                                        |
| CLI            | Evaluates transitions, persists state, runs executable command blocks, and enforces policy. |

The runtime MUST preserve the conceptual separation between result, handler, and
action:

| Layer   | Runtime meaning                                                             |
| ------- | --------------------------------------------------------------------------- |
| Result  | Outcome signal: `PASS` or `FAIL`.                                           |
| Handler | Authored mapping from result to action.                                     |
| Action  | Runtime control-flow effect such as `CONTINUE`, `GOTO`, `STOP`, or `DEFER`. |

Actions MUST propagate with their own semantics. The runtime MUST NOT silently
map one action into another to simplify execution.

<a id="command-execution"></a>

## 4. Command Execution

The runtime supports automatic and prompted execution.

| Mode              | Trigger                                                                                | Runtime behavior                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Automatic command | Step or substep has `bash`, `sh`, or `shell` code block and execution is not prompted. | CLI executes the command from the project root; exit `0` signals `PASS`, non-zero signals `FAIL`. |
| Prompted/manual   | `--prompted`, display-only code block, or no executable code block.                    | CLI surfaces the prompt and waits for `rundown pass` or `rundown fail`.                           |

Executable command blocks inherit the parent process environment after policy
filtering and Rundown environment injection. A `prompt` code block is
display-only: it MUST NOT be shell-executed and MUST NOT derive a result from an
exit code.

The CLI MAY render display-only code blocks through `rundown prompt` so the
content appears as fenced Markdown.

<a id="for-loops"></a>

## 5. Iteration Runtime

`FOR` syntax is defined in
[docs/spec/language.md §8](../spec/language.md#8-iteration). At runtime, a `FOR`
step repeats its substeps over a numeric range or data source.

### 5.1 Loop State

For an active loop, runtime state MUST track:

| Field             | Requirement                                                  |
| ----------------- | ------------------------------------------------------------ |
| Current step      | The parent `FOR` step id.                                    |
| Iteration         | Current numeric iteration index.                             |
| Direction         | Ascending or descending range traversal.                     |
| Loop variable     | Optional named variable exposed to substeps.                 |
| Current value     | Current data element for array/file-backed sources.          |
| Iteration results | Recorded `PASS`/`FAIL` outcomes used for parent aggregation. |

Two distinct 10,000-iteration limits apply, enforced by different mechanisms:

- **Numeric `FOR` bounds** are rejected at **parse time**. A `FOR` range whose
  bound exceeds `MAX_FOR_BOUND` (10,000) fails Zod validation as a parse error —
  it is not a silently capped loop.
- **Open-ended data-source iteration** (file- or variable-backed sources) is
  capped at **runtime** by `MAX_FILE_ITERATIONS` (10,000); iteration stops once
  the cap is reached.

### 5.2 Dynamic Loop Variables

The runtime MUST expand loop and location variables against the active frame.

| Variable                 | Runtime value                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `{{Index}}`, `{{index}}` | Current iteration number for this runbook context.                                        |
| `{{Step}}`, `{{step}}`   | Current qualified step/substep position for this runbook context.                         |
| `{{var}}`                | Named loop variable; for ranges, the iteration index; for data sources, the current item. |
| `{{context.current.*}}`  | Canonical current structural context.                                                     |

Dynamic variables MUST NOT be overridden by user input, config, or environment.

`Index` is the 1-based iteration number of the active `FOR` step. It is
available in the step's substeps.

### 5.3 Iteration Actions

Substep actions inside a `FOR` step affect the current iteration. Nested
iteration-level transitions under `FOR` affect the loop after iteration
aggregation.

| Action     | Records current result | Parent step handler fires      | Runtime effect                                     |
| ---------- | ---------------------- | ------------------------------ | -------------------------------------------------- |
| `DEFER`    | Yes                    | After final recorded iteration | Record result and advance.                         |
| `NEXT`     | No                     | After final iteration          | Skip remaining work and advance.                   |
| `BREAK`    | No                     | Yes                            | Exit loop immediately.                             |
| `CONTINUE` | No                     | Yes                            | Exit loop and continue through step-level handler. |
| `GOTO`     | No                     | No                             | Jump immediately.                                  |
| `STOP`     | No                     | No                             | Stop immediately.                                  |
| `COMPLETE` | No                     | No                             | Complete immediately.                              |

Iteration-level `RETRY N action` MUST retry the current iteration before
applying the exhausted fallback action. It applies to the iteration result, not
to the specific substep action that produced that result.

### 5.4 GOTO AT

When a `GOTO` targets a `FOR` step:

| Form                  | Runtime target                                     |
| --------------------- | -------------------------------------------------- |
| `GOTO N`              | Enters the target loop at that loop's start value. |
| `GOTO N AT I`         | Enters the target loop at iteration `I`.           |
| `GOTO N AT {{Index}}` | Re-enters at the current iteration value.          |

Status output MAY show display paths such as `STEP.INDEX.SUBSTEP`. Display paths
are not authoring identifiers and are not canonical runtime identity.

<a id="data-sources"></a>

## 6. Data Sources

Data sources are runtime values used by named `FOR` clauses. Data-source
iteration MUST use a named loop variable.

### 6.1 Source Routing

Input values are routed into template variables and data sources based on their
runtime type.

| Value pattern                     | Template rendering  | Data-source routing                     |
| --------------------------------- | ------------------- | --------------------------------------- |
| JSON array from `--input-json`    | Comma-joined string | Array source.                           |
| YAML array from config/input file | Comma-joined string | Array source.                           |
| `file:*.jsonl`                    | Source reference    | Lazy JSON Lines stream.                 |
| `file:*.json`                     | Source reference    | JSON array/object; arrays are iterable. |
| Scalar string/number/boolean      | Scalar string value | Not a data source.                      |

Only `.json` and `.jsonl` file source extensions are supported.

### 6.2 File Source Rules

File-backed data sources MUST satisfy the following rules:

| Rule            | Requirement                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| Containment     | Resolved path MUST remain inside the project root after symlink resolution.      |
| Policy          | Resolved path MUST be allowed by the active read policy before execution starts. |
| Format          | `.jsonl` is parsed as one JSON value per line; `.json` is parsed as JSON.        |
| Drift detection | Runtime MUST snapshot source metadata and detect modification on resume.         |
| Failure mode    | Missing, denied, invalid, escaped, or drifted sources MUST fail visibly.         |

Blocked or invalid file sources MUST NOT silently become empty iteration
sources.

For `.jsonl`, each line MAY contain any JSON value. When the current item is a
JSON object, dotted field access is supported in templates. Rendering the whole
item serializes it as JSON.

### 6.3 Windowed Sources

Windowed iteration reads only the requested inclusive item positions from the
source. Open-ended data-source iteration reads until source exhaustion or the
10,000-iteration cap.

<a id="state-persistence"></a>

## 7. State Persistence

Runtime state persists across process exits and context clears.

### 7.1 Storage Locations

| Path                              | Purpose                                 |
| --------------------------------- | --------------------------------------- |
| `.rundown/rundown.db`             | Run records.                            |
| `.rundown/runs/<run-id>/outputs/` | Captured filesystem outputs.            |
| `.rundown/runbooks/`              | Project-local runbook discovery source. |

### 7.2 Run Records

Each run is one row of the `runs` table, keyed by run id. A row holds:

| Column                     | Requirement                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle`                | Run lifecycle state: `running` during execution; `completed`, `stopped`, or `abandoned` once terminal. No current command writes `abandoned`.            |
| `owner_token_hash`         | SHA-256 hash of the run's Owner Token. The token itself is never stored. Absent (NULL) exactly for an Inline Child, which its parent's token authorizes. |
| `state_json`               | The run's `RunbookState` (§7.4), minus `lifecycle`.                                                                                                      |
| `state_version`            | Counter bumped on every `state_json` or execution-lease write; the basis of the single conditional save.                                                 |
| `created_at`, `updated_at` | Row timestamps.                                                                                                                                          |

The table also has execution-lease columns, set while a step's command runs (see
[Execution lease](#execution-lease) below), and child-linkage columns
(`parent_run_id`, `parent_step`, `parent_frame_key`, `parent_entry`,
`parent_kind`), all-or-none, written once when a child's row is created — an
Inline Child's at launch, a Delegation's at `rundown claim` (§7.5). A
Delegation's row also records `claim_agent_id`, the agent id its claim named.
Deleting a run deletes its inline children with it — nothing else can reach them
— and unlinks its delegated children, which keep their own tokens.

Every run has exactly one owner. A mutating command presents the Owner Token,
which the runtime hashes to find the run; there is no other mutation authority,
and the run id is a read-only selector. A mutation commits with one conditional
write against `state_version`; if another write landed first, the command is
refused `CONCURRENT_MODIFICATION` and nothing is written. See
[docs/reference/cli.md Run Ownership](cli.md#run-ownership).

<a id="execution-lease"></a>

**Execution lease.** Immediately before a step's command runs, the runtime sets
the run's execution lease — the attempt, the pid and start identity of the
process running the command, and the start time — by one conditional write, and
the write that records the command's result clears it. While the lease is held
and its process is alive the step is **In Progress**: every mutating command and
any second attempt at the step is refused `EXECUTION_IN_PROGRESS`, so the
command never runs twice. If that process dies first, the step is
**Interrupted**: the runtime MUST NOT repeat the command; `pass` and `complete`
are refused `EXECUTION_INTERRUPTED`, and the owner decides with `fail` (the
step's FAIL handler, including an authored `RETRY`), `goto`, or `stop`, whose
write clears the lease. A result whose attempt no longer holds the lease is not
recorded. `rundown status` reports either condition.

<a id="invalid-persisted-state--no-migration"></a>

### 7.3 Invalid Persisted State / No Migration

Persisted state MUST NOT be migrated between runtime versions. This applies to:

| State              | Covered data                                                |
| ------------------ | ----------------------------------------------------------- |
| Runbook state rows | Structured fields and opaque `snapshot` blob.               |
| Run rows           | `lifecycle`, `owner_token_hash`, and the remaining columns. |

Two independent version checks guard this state. They are separate mechanisms
and MUST NOT be conflated:

| Check                        | Governs                                                                                     | Requirement                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `RunbookState.schemaVersion` | Runbook state **only** — the structured fields and the opaque `snapshot` blob of a run row. | MUST equal `CURRENT_SCHEMA_VERSION` (currently `4`). Any other value makes that run's state invalid (`RD-309`).           |
| SQLite schema version        | The whole state database, including every column of the `runs` table.                       | Stored in `PRAGMA user_version` and MUST equal the version this build installs. Any other version is rejected (`RD-305`). |

Run-row columns carry no `schemaVersion` of their own; they are governed solely
by the database schema version. Do not apply `RunbookState.schemaVersion` to
them.

If persisted state is structurally incompatible, corrupt, unreadable, or fails
either version check, Rundown MUST fail closed and refuse to continue that run.
`RD-305` affects the whole database; `RD-309` affects only the one run. See
[docs/reference/cli.md Common Errors](cli.md#common-errors-and-resolutions).

The recovery path is to finish or close the affected run if possible, or prune
the incompatible state and restart from the source runbook. The runtime MUST NOT
silently migrate, shim, adapt, rewrite, or resume incompatible persisted state.
Persisted runbook state has no released compatibility contract: preserving older
active runs is not a product requirement. Implementations MUST prefer a breaking
schema/runtime change plus an explicit invalid-state error over runtime
migration code, fallback parsing, legacy field hydration, warning-only adapters,
or compatibility branches for older persisted state.

### 7.4 Runbook State Fields

Each SQLite run state row stores enough information to resume deterministically.

```json
{
  "id": "rd_4b7f0c2d9e1a4b7f0c2d9e1a4b7f0c2d",
  "runbook": {
    "source": "project",
    "path": ".rundown/runbooks/my-runbook.runbook.md"
  },
  "runbookPath": ".rundown/runbooks/my-runbook.runbook.md",
  "title": "My Runbook",
  "description": "Runbook description",
  "step": "2",
  "substep": "1",
  "stepName": "Deploy",
  "retryCount": 0,
  "variables": { "environment": "staging" },
  "steps": [],
  "prompted": false,
  "templateVars": { "environment": "staging" },
  "substepStates": [],
  "frameEntryCounts": { "2|2": 1 },
  "activeFrameKey": "2|2",
  "activeEntry": 1,
  "forStack": [],
  "iterationResults": ["pass"],
  "lastResult": "pass",
  "lastAction": { "type": "CONTINUE" },
  "startedAt": "2026-04-28T00:00:00.000Z",
  "updatedAt": "2026-04-28T00:01:00.000Z",
  "frontmatterOutputs": [],
  "finalVars": {},
  "lifecycle": "running",
  "runbookSrc": "---\nname: my-runbook\n---\n# My Runbook\n...",
  "snapshot": {},
  "schemaVersion": 3
}
```

| Field                                               | Runtime requirement                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                | Persisted run identifier generated at execution start.                                                                                                                                                                                                                                                                                                                                       |
| `runbook`                                           | Canonical runbook identity object: `{ source, path }`, where `source` is `project`, `plugin`, `bundled`, or `external`. For `project`, `plugin`, and `bundled` sources, `path` is a source-root-relative Markdown path. For `external` sources, `path` is a normalized absolute filesystem path.                                                                                             |
| `runbookPath`                                       | Display/execution file path relative to the current project when possible.                                                                                                                                                                                                                                                                                                                   |
| `step`, `substep`                                   | Current structural position.                                                                                                                                                                                                                                                                                                                                                                 |
| `stepName`                                          | Human-readable description of the current step.                                                                                                                                                                                                                                                                                                                                              |
| `steps`                                             | Per-step status records.                                                                                                                                                                                                                                                                                                                                                                     |
| `prompted`                                          | Whether the run announces its commands rather than executing them. Required; written once at creation.                                                                                                                                                                                                                                                                                       |
| `retryCount`                                        | User-visible retry count across retry sites.                                                                                                                                                                                                                                                                                                                                                 |
| `variables`                                         | Live variable space, including accumulated outputs.                                                                                                                                                                                                                                                                                                                                          |
| `templateVars`                                      | Frozen variable map used for deterministic resume rendering.                                                                                                                                                                                                                                                                                                                                 |
| `forStack`                                          | Active loop frame and current source value.                                                                                                                                                                                                                                                                                                                                                  |
| `iterationResults`                                  | Results recorded for current loop aggregation.                                                                                                                                                                                                                                                                                                                                               |
| `substepStates`                                     | Substep lifecycle and result, and the Current Child a composing substep reserved for its latest entry (`child`, §7.5): `{ kind: "inline", runId, entry, runbook, collected? }`, or `{ kind: "delegation", runId, entry, runbook, contextSnapshot, ticketHash, collected? }`. `ticketHash` is the Claim Ticket's SHA-256 (null until issued); `collected` is the Child Result once Collected. |
| `frameEntryCounts`, `activeFrameKey`, `activeEntry` | Re-entry-safe frame identity. Monotonic entry counts for GOTO/RETRY scope isolation — frame presence means _ever entered_, never _currently open_.                                                                                                                                                                                                                                           |
| `lastResult`, `lastAction`                          | Last result signal and resolved action.                                                                                                                                                                                                                                                                                                                                                      |
| `startedAt`, `updatedAt`                            | ISO timestamps for run creation and last state write.                                                                                                                                                                                                                                                                                                                                        |
| `frontmatterOutputs`                                | Frontmatter `outputs:` declarations parsed at startup, seeded into the machine on every actor creation.                                                                                                                                                                                                                                                                                      |
| `finalVars`                                         | Evaluated frontmatter output values at runbook termination.                                                                                                                                                                                                                                                                                                                                  |
| `lifecycle`                                         | Run lifecycle state: `running` during execution; `completed`, `stopped`, or `abandoned` once terminal. No current command writes `abandoned`.                                                                                                                                                                                                                                                |
| `runbookSrc`                                        | Raw source content with template placeholders preserved.                                                                                                                                                                                                                                                                                                                                     |
| `snapshot`                                          | Opaque XState persisted snapshot.                                                                                                                                                                                                                                                                                                                                                            |
| `schemaVersion`                                     | Persisted state schema version. MUST equal `CURRENT_SCHEMA_VERSION` (currently `4`).                                                                                                                                                                                                                                                                                                         |

The runtime MUST treat `snapshot` as persisted state subject to the no-migration
rule.

### 7.5 Composition

A runbook-list substep without `DELEGATE` composes an **Inline Child**: a child
run owned by the same agent as its parent. Its lifecycle, all inside the parent
owner's commands:

1. **Reservation.** Each entry into the substep — the first, each FOR iteration,
   each re-entry by `GOTO` or `RETRY` — records a Current Child on the substep's
   `substepStates` entry: a preallocated child run id, the frame entry it was
   made at, and the runbook reference. The context the child inherits — the
   parent's variables and iteration binding — is read from the parent row at
   launch, while the parent still rests on that entry. A reservation from an
   earlier entry is stale: its child, finished or not, is never collected.
2. **Launch.** Run Progression creates the child row under the reserved id, with
   child linkage and no Owner Token hash, initialises it, and drives it. The
   child inherits the parent's variables (below explicit inputs), the
   `context.parent.*` / `context.ancestors.*` paths (§8.5), the iteration
   binding, and the parent's `prompted` mode.
3. **Targeting.** The parent's Owner Token resolves to the root run; a mutating
   command targets the deepest running inline child, found by following each
   run's Current Child. `--step` then names a step of that child.
4. **Implicit Collect.** When the child reaches a terminal, the same command
   reads its result from the child's own row — `completed` as PASS, `stopped` as
   FAIL — and commits it into the parent substep together with the child's
   `finalVars` (its frontmatter `outputs:`), then continues the parent's
   progression. The child never writes its parent. If the process died after the
   child's terminal and before the Collect, the owner's next mutating command
   Collects first.

The execution lease (§7.2) is per run: a child's command holds the child's
lease; the parent holds none while its inline child runs. Inline children nest
up to 32 deep.

A runbook-list substep marked `DELEGATE` composes a **Delegation**: a child run
owned by whichever agent claims it, which never writes its parent:

1. **Reservation.** Each entry into a delegated substep records a Current Child
   for it and for every later delegated substep of the step that has none at
   this entry: a preallocated child run id, the frame entry, the runbook
   reference, and a context snapshot of the parent's variables and iteration
   binding taken at that moment. As for an Inline Child, a reservation from an
   earlier entry is stale.
2. **Claim Ticket.** The Run Progression turn that announces the entry mints a
   full-entropy Claim Ticket for every reservation that has none, commits only
   their SHA-256 hashes (one conditional save), and prints the tickets in the
   `step_entered` event's `children`. Nothing persists a ticket.
3. **Claim.** `rundown claim <ticket>` finds the reservation by the ticket's
   hash, prepares the child runbook exactly as an Inline Child's launch does,
   and — in one transaction that re-reads the parent and verifies the
   reservation still counts and the parent is running — inserts the child row
   under the reserved id with an Owner Token of its own, its linkage and its
   claiming agent. The child's id is the row's primary key, so a second claim is
   refused `ALREADY_CLAIMED`. The child inherits the context snapshot (below
   explicit inputs) and the parent's `prompted` mode.
4. **Standing.** Every command on a Delegation first checks that its parent is
   running and still counts it — reserved at the parent's active entry, not yet
   Collected, for the substep the parent rests on or a later one — else
   `DELEGATION_CANCELLED` or `PARENT_RUN_FINISHED`. The check may race the
   parent's next write; Collect decides what counts.
5. **Collect.** `rundown collect --token` reads the Delegations of the run's
   active entry and commits each terminal child's Child Result — `completed` as
   PASS, `stopped` or `abandoned` as FAIL — with its `finalVars`, one
   conditional save per child. The substep the cursor rests on takes its result
   at once; a later substep's is recorded on its reservation and raised when the
   cursor arrives, so a fan-out Collects in any order. Running and unclaimed
   children are reported, and nothing is applied for them. Collect is the only
   path by which a Delegation's result reaches its parent.

A substep listing more than one runbook is refused at `rundown run` with
`RUNBOOK_COMPOSITION_UNSUPPORTED`, and a child whose runbook has one is refused
when it launches or is claimed.

<a id="template-variables"></a>

## 8. Variable Resolution

Rundown uses Handlebars syntax for template variables. Variable syntax is
defined in [docs/spec/language.md §9](../spec/language.md#9-templating).

<a id="variable-sources"></a>

### 8.1 Variable Sources

Variables are resolved by layering four sources. Each layer overrides every
layer below it; the table lists them from lowest to highest precedence:

| Layer               | Source                             | Rule                                                                              |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `builtins` (lowest) | Built-in defaults                  | Runtime-provided static built-ins (`Date`, `Branch`, `WorkPath`, `ContextId`, …). |
| `config`            | `.rundown/config.yaml`             | Auto-discovered from cwd upward.                                                  |
| `env`               | `RD_INPUT_*` environment variables | Prefix stripped.                                                                  |
| `cli` (highest)     | Explicit invocation inputs         | `--input`, `--input-json`, and `--input-file`.                                    |

Within the `cli` layer, `--input-json` overrides `--input`, which overrides
`--input-file`. Input artifacts (`--artifacts`, `--artifacts-json`) are a
separate boundary channel, not a variable layer; supplying the same name through
both channels is an error. `--input-file` paths must be project-relative and
must remain inside the project directory after symlink resolution; absolute
paths and `..` traversal are rejected.

Plugin variables are not a precedence layer. `CLAUDE_PLUGIN_ROOT` is injected
post-resolution for plugin-sourced runbooks only, and only when the key is
absent — see §8.6.

Frontmatter `inputs` declares accepted names only. It is not a value layer.

### 8.2 Config Auto-Discovery

The runtime searches for `.rundown/config.yaml` from the current working
directory upward. Search stops at the first config file found, the git
repository root, or the filesystem root.

Arrays in config or input files become both comma-joined template values and
array data sources. `file:` values become file-backed data sources. Scalars
remain regular template variables.

### 8.3 Variable Name Requirements

User-provided variable names MUST match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.

The names `step`, `index`, `context`, `runid`, and `runbookref` are reserved
case-insensitively. Reserved names MUST be rejected in frontmatter `inputs`,
frontmatter `required`, explicit invocation inputs, input files, and config
files. Reserved `RD_INPUT_*` variables are skipped with a warning.

### 8.4 Undefined Variables

Undefined variables and missing dotted paths are preserved as literal
placeholders, such as `{{variable}}` or `{{context.vars.missing}}`. The runtime
SHOULD emit one warning for each distinct undefined variable.

### 8.5 Runtime Context Model

The runtime exposes canonical namespaced context paths.

| Path                | Runtime meaning                                                        |
| ------------------- | ---------------------------------------------------------------------- |
| `context.current.*` | Current `step`, `substep`, `index`, and display `at` path.             |
| `context.vars.NAME` | Current variable namespace: every user-visible variable, under `NAME`. |

Parent and ancestor context paths (`context.parent.*`, `context.ancestors.N.*`)
are populated in a child run (§7.5) from its context snapshot — an Inline
Child's read from its parent at launch, a Delegation's captured on its
reservation: `context.parent.vars.NAME`, `context.parent.step`,
`context.parent.substep`, `context.parent.at` and `context.parent.index`.

<a id="built-in-variables"></a>

### 8.6 Built-In Variables

PascalCase is canonical. Lowercase `step` and `index` aliases are accepted for
dynamic current-frame values but remain reserved for user input.

| Variable                                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Date`, `DateTime`, `Year`, `Month`, `Day` | Current date/time components.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Branch`                                   | Current git branch, or empty outside git.                                                                                                                                                                                                                                                                                                                                                                                                |
| `WorkPath`                                 | Fixed default artifact base `.rundown/work`; base for `{{ path "..." }}`.                                                                                                                                                                                                                                                                                                                                                                |
| `RunbookRef`                               | Canonical `{ source, path }` parsed-object identity for the resolved runbook. Injected during runbook preparation. The key is `RunbookRef`, NOT `Runbook` — the trailing `Ref` is deliberate, signalling that the value is the parsed `{ source, path }` projection used by internal callers (e.g. `requireRunbookRef` in the compiler). Available in templates before substitution so runbooks can render their own canonical identity. |
| `RunId`                                    | Fresh execution identifier for this runbook execution. Injected only for runnable execution, not for discovery or `rundown resolve`.                                                                                                                                                                                                                                                                                                     |
| `ContextId`                                | Fresh per run (8 hex characters); scopes artifacts and path helpers into `.rd-<ContextId>/`.                                                                                                                                                                                                                                                                                                                                             |
| `Step`, `Index`                            | Dynamic current step and iteration.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `context.current.*`                        | Dynamic current structural context.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `context.vars.NAME`                        | Current variable namespace.                                                                                                                                                                                                                                                                                                                                                                                                              |

Static built-ins MAY be overridden by higher-precedence sources. Dynamic
built-ins MUST NOT be overridden.

Plugin runbooks MAY receive the upper-snake-case `CLAUDE_PLUGIN_ROOT` variable.
It is not part of the §8.1 precedence layers: it is injected after variable
resolution completes, for plugin-sourced runbooks only, and only when no
resolved layer already provided the key. It is therefore a plugin-only default
that any explicit input (`--input`, `RD_INPUT_*`, config) preempts.

The default `WorkPath` value is shared at the project level and does not include
a branch, run, or checkout suffix. Use `ContextId` with `{{ path "..." }}` or
`rdpath --ctx` for workflow isolation inside `.rundown/work/.rd-<ContextId>/`;
managed artifact paths are rooted at
`.rundown/work/.rd-<ContextId>/<RunId>/<key>`.

Artifact aliases render as local paths when referenced directly, so
`{{ PlanPath }}` and `{{ path PlanPath }}` produce the artifact's filesystem
path. Use `{{ artifact PlanPath }}` when the canonical `rd://` URI is required
for handoff, provenance, or manifest identity.

Selector artifact URIs may filter by producer metadata and file times:

```markdown
- ARTIFACTS
  RecentReviews "rd://artifacts/{{ContextId}}/*/review-*.json?createdAfter=2026-06-01T00:00:00.000Z"
  ChangedReviews "rd://artifacts/{{ContextId}}/*/review-*.json?modifiedAfter=2026-06-01T00:00:00.000Z"
```

`created*` filters use the artifact manifest timestamp, meaning the time Rundown
recorded the artifact. `modified*` filters use the managed artifact file's
filesystem modification time.

`ARTIFACTS` declarations may also bind aliases to existing files. Relative file
references search project files first, then plugin files, then bundled files.
Explicit absolute paths are accepted only when read policy allows them. Missing,
denied, escaped, or out-of-root file candidates MUST fail visibly; they MUST NOT
resolve as an empty artifact result or silently fall back to a managed artifact
key. Containment is enforced after realpath resolution so symlinks and traversal
cannot escape the configured search roots. File references are recorded in the
artifact manifest with `kind: file-artifact-record`, the expanded declaration
token as `key`, and the resolved canonical `file:///...` URI.

`RunbookRef` is available before template substitution so runbooks can render
their own canonical identity. `RunId` is minted later, when a run is actually
started, so commands that only resolve variables MUST NOT emit or persist a
synthetic `RunId`.

<a id="shell-environment"></a>

### 8.7 Shell Environment

Executable shell blocks receive Rundown environment variables after policy
environment filtering.

| Environment variable   | Source variable                                                     |
| ---------------------- | ------------------------------------------------------------------- |
| `RD_WORK_PATH`         | `WorkPath`                                                          |
| `RD_CONTEXT_ID`        | `ContextId`                                                         |
| `RD_RUN_ID`            | `RunId`                                                             |
| `RD_RUNBOOK_REF`       | `RunbookRef.path`                                                   |
| `RD_RUNBOOK_SOURCE`    | `RunbookRef.source` (`project`, `plugin`, `bundled`, or `external`) |
| `RD_OUTPUTS_<VarName>` | Naked step/substep `OUTPUTS` entry.                                 |

Rundown-injected `RD_*` variables use Rundown-wins semantics: user-supplied
environment variables MUST NOT block or override them.

### 8.8 Template Persistence

`state.runbookSrc` stores raw runbook source, and `state.templateVars` stores
the resolved static variable map. On resume, the runtime MUST re-apply FOR
bounds and template placeholders from this frozen variable state so rendering
remains deterministic.

## 9. Security Integration

The runtime delegates full policy semantics to
[docs/reference/security.md](security.md). Runtime integration points are:

| Runtime action               | Security requirement                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| Command execution            | Command must pass run policy before spawning.                      |
| File-backed data source load | Source path must pass containment and read-policy checks.          |
| Shell environment injection  | User environment is filtered before Rundown `RD_*` injection.      |
| Sandbox execution            | Supported OS sandbox applies read/write restrictions when enabled. |

Security failures that affect execution MUST fail visibly. For data sources,
policy denial MUST NOT produce silent zero-iteration success.

<a id="runtime-identity-glossary"></a>

## 10. Runtime Identity

Canonical runtime identity is `step + substep + iteration`.

| Identity component | Meaning                                 |
| ------------------ | --------------------------------------- |
| Step               | Top-level runbook step id.              |
| Substep            | Nested substep id, if active.           |
| Iteration          | Current `FOR` iteration, if active.     |
| Frame              | Internal `step\|iteration` scope key.   |
| Entry              | Monotonic re-entry counter for a frame. |

Re-entering a frame through `GOTO`, `RETRY`, or other control flow increments
the entry counter, so each entry of a frame is distinguishable from earlier
ones.

## 11. Conformance

A conforming Rundown runtime MUST satisfy these requirements:

1. Preserve result, handler, and action as distinct runtime concepts.
2. Execute shell code blocks only for executable info strings and derive results
   from exit codes.
3. Treat display-only prompts as non-executable.
4. Track active loop state, current values, and iteration results explicitly.
5. Enforce the 10,000-iteration cap for numeric and open-ended data-source
   loops.
6. Record iteration results only for actions that specify accumulation.
7. Preserve canonical runtime identity as `step + substep + iteration`.
8. Count frame entries monotonically across re-entry.
9. Accept a mutation only under the run's Owner Token, committed with a single
   conditional write that refuses, never retries, a conflicting write.
10. Refuse runbooks that compose other runbooks before any run is created.
11. Preserve variable source precedence exactly as specified.
12. Reject or skip reserved variable names according to their source.
13. Prevent user input from overriding dynamic variables.
14. Inject Rundown `RD_*` environment variables with Rundown-wins semantics.
15. Confine file-backed data sources to project-root-contained, policy-allowed
    paths.
16. Fail visibly for missing, denied, invalid, escaped, or drifted file-backed
    data sources.
17. Persist enough state to resume deterministically from `runbookSrc` and
    `templateVars`.
18. Never migrate, shim, adapt, rewrite, or resume incompatible persisted state.
