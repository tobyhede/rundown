# Rundown Runtime Specification

This document defines Rundown runtime behavior: execution state, iteration,
data-source handling, variable resolution, persisted state, and runtime identity.
For authoring syntax, see [docs/spec/language.md](../spec/language.md). For CLI
usage, see [docs/reference/cli.md](cli.md). For the full security policy
contract, see [docs/reference/security.md](security.md).

## 1. Scope

This specification covers behavior after a runbook has been selected for
execution. It defines how the runtime evaluates commands, advances steps,
resolves variables, stores state, handles data sources, and targets nested or
delegated work.

This specification does not define Rundown document syntax, CLI command-line
parsing, JSON output shape, policy file format, or implementation architecture
except where those topics affect runtime correctness.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 2. Terminology

| Term | Meaning |
| --- | --- |
| Runtime | The CLI-managed execution process for one or more runbooks. |
| Run | One active or persisted execution of a runbook. |
| State file | JSON file under `.rundown/runs/` storing one run's state. |
| Session | `.rundown/session.json`, which tracks active top-level runs, stashes, and claims. |
| Frame | Internal execution scope key: `step\|iteration`. |
| Entry | Monotonic re-entry counter for a frame. |
| Claim | `rdclm_...` handle that targets one delegated child run. |
| Data source | Runtime value used by `FOR ... IN {{ source }}` iteration. |
| Static variable | Variable resolved once at run startup. |
| Dynamic variable | Variable derived from the current step, substep, or iteration frame. |

<a id="execution-model"></a>

## 3. Runtime Model

Rundown separates runbook definition from runtime state.

| Component | Runtime role |
| --- | --- |
| Runbook source | Defines steps, transitions, commands, inputs, outputs, and control flow. |
| Runtime state | Tracks current position, variables, retries, loop state, child links, and persisted snapshot. |
| Agent or user | Performs prompted work and reports `PASS` or `FAIL`. |
| CLI | Evaluates transitions, persists state, runs executable command blocks, and enforces policy. |

The runtime MUST preserve the conceptual separation between result, handler, and
action:

| Layer | Runtime meaning |
| --- | --- |
| Result | Outcome signal: `PASS` or `FAIL`. |
| Handler | Authored mapping from result to action. |
| Action | Runtime control-flow effect such as `CONTINUE`, `GOTO`, `STOP`, or `DEFER`. |

Actions MUST propagate with their own semantics. The runtime MUST NOT silently
map one action into another to simplify execution.

<a id="command-execution"></a>

## 4. Command Execution

The runtime supports automatic and prompted execution.

| Mode | Trigger | Runtime behavior |
| --- | --- | --- |
| Automatic command | Step or substep has `bash`, `sh`, or `shell` code block and execution is not prompted. | CLI executes the command from the project root; exit `0` signals `PASS`, non-zero signals `FAIL`. |
| Prompted/manual | `--prompted`, display-only code block, or no executable code block. | CLI surfaces the prompt and waits for `rd pass` or `rd fail`. |

Executable command blocks inherit the parent process environment after policy
filtering and Rundown environment injection. A `prompt` code block is
display-only: it MUST NOT be shell-executed and MUST NOT derive a result from an
exit code.

The CLI MAY render display-only code blocks through `rd prompt` so the content
appears as fenced Markdown.

<a id="for-loops"></a>

## 5. Iteration Runtime

`FOR` syntax is defined in [docs/spec/language.md §8](../spec/language.md#8-iteration).
At runtime, a `FOR` step repeats its substeps over a numeric range or data
source.

### 5.1 Loop State

For an active loop, runtime state MUST track:

| Field | Requirement |
| --- | --- |
| Current step | The parent `FOR` step id. |
| Iteration | Current numeric iteration index. |
| Direction | Ascending or descending range traversal. |
| Loop variable | Optional named variable exposed to substeps. |
| Current value | Current data element for array/file-backed sources. |
| Iteration results | Recorded `PASS`/`FAIL` outcomes used for parent aggregation. |

Numeric bounds and open-ended data-source iteration are capped at 10,000
iterations.

### 5.2 Dynamic Loop Variables

The runtime MUST expand loop and location variables against the active frame.

| Variable | Runtime value |
| --- | --- |
| `{{Index}}`, `{{index}}` | Current iteration number for this runbook context. |
| `{{Step}}`, `{{step}}` | Current qualified step/substep position for this runbook context. |
| `{{var}}` | Named loop variable; for ranges, the iteration index; for data sources, the current item. |
| `{{context.current.*}}` | Canonical current structural context. |

Dynamic variables MUST NOT be overridden by user input, config, environment, or
delegation inheritance.

### 5.3 Iteration Actions

Substep actions inside a `FOR` step affect the current iteration. Nested
iteration-level transitions under `FOR` affect the loop after iteration
aggregation.

| Action | Records current result | Parent step handler fires | Runtime effect |
| --- | --- | --- | --- |
| `DEFER` | Yes | After final recorded iteration | Record result and advance. |
| `NEXT` | No | After final iteration | Skip remaining work and advance. |
| `BREAK` | No | Yes | Exit loop immediately. |
| `CONTINUE` | No | Yes | Exit loop and continue through step-level handler. |
| `GOTO` | No | No | Jump immediately. |
| `STOP` | No | No | Stop immediately. |
| `COMPLETE` | No | No | Complete immediately. |

Iteration-level `RETRY N action` MUST retry the current iteration before applying
the exhausted fallback action. It applies to the iteration result, not to the
specific substep action that produced that result.

### 5.4 GOTO AT

When a `GOTO` targets a `FOR` step:

| Form | Runtime target |
| --- | --- |
| `GOTO N` | Enters the target loop at that loop's start value. |
| `GOTO N AT I` | Enters the target loop at iteration `I`. |
| `GOTO N AT {{Index}}` | Re-enters at the current iteration value. |

Status output MAY show display paths such as `STEP.INDEX.SUBSTEP`. Display paths
are not authoring identifiers and are not canonical runtime identity.

<a id="data-sources"></a>

## 6. Data Sources

Data sources are runtime values used by named `FOR` clauses. Data-source
iteration MUST use a named loop variable.

### 6.1 Source Routing

Input values are routed into template variables and data sources based on their
runtime type.

| Value pattern | Template rendering | Data-source routing |
| --- | --- | --- |
| JSON array from `--input-json` | Comma-joined string | Array source. |
| YAML array from config/input file | Comma-joined string | Array source. |
| `file:*.jsonl` | Source reference | Lazy JSON Lines stream. |
| `file:*.json` | Source reference | JSON array/object; arrays are iterable. |
| Scalar string/number/boolean | Scalar string value | Not a data source. |

Only `.json` and `.jsonl` file source extensions are supported.

### 6.2 File Source Rules

File-backed data sources MUST satisfy the following rules:

| Rule | Requirement |
| --- | --- |
| Containment | Resolved path MUST remain inside the project root after symlink resolution. |
| Policy | Resolved path MUST be allowed by the active read policy before execution starts. |
| Format | `.jsonl` is parsed as one JSON value per line; `.json` is parsed as JSON. |
| Drift detection | Runtime MUST snapshot source metadata and detect modification on resume. |
| Failure mode | Missing, denied, invalid, escaped, or drifted sources MUST fail visibly. |

Blocked or invalid file sources MUST NOT silently become empty iteration sources.

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

### 7.1 File Locations

| Path | Purpose |
| --- | --- |
| `.rundown/runs/` | Runbook state files. |
| `.rundown/session.json` | Active runbook stack, stash, and claim tracking. |
| `.rundown/runbooks/` | Project-local runbook discovery source. |

### 7.2 Session Structure

The session tracks top-level runs and delegated children separately.

```json
{
  "defaultStack": ["rd_11111111111111111111111111111111"],
  "stashedRunbookId": null,
  "claims": {
    "rdclm_F3J3n3d_f8fo0a0b1B2c3Q": {
      "kind": "claim-record",
      "claimId": "rdclm_F3J3n3d_f8fo0a0b1B2c3Q",
      "childRunId": "rd_22222222222222222222222222222222",
      "tokenHash": "sha256:...",
      "parentRunId": "rd_11111111111111111111111111111111",
      "parentStepId": "1.1",
      "parentFrameKey": "1|",
      "parentEntry": 1,
      "claimedAt": "2026-04-28T00:00:00.000Z",
      "updatedAt": "2026-04-28T00:00:00.000Z"
    }
  }
}
```

| Field | Requirement |
| --- | --- |
| `defaultStack` | Tracks active top-level, inline, and unidentified/manual flows. |
| `stashedRunbookId` | Stores the default-stack run paused by plain `rd stash`. |
| `claims` | Maps claim ids to exact delegated child runbooks and parent linkage. |

Claimed delegated children MUST NOT be pushed onto `defaultStack`.

Commands that accept `--claim-id` MUST resolve the exact child run for that
claim and MUST fail closed if the claim is missing, stale, terminal, or no
longer linked to a live parent.

### 7.3 Stash Targeting

`stash` and `pop` target either the default stack or a specific claim.

| Command | Runtime target |
| --- | --- |
| `rd stash` | Moves the default-stack active run into the single default stash slot. |
| `rd stash --claim-id <id>` | Stashes the claimed child and preserves its claim record. |
| `rd pop` | Restores only default-stack stashes. |
| `rd pop --claim-id <id>` | Restores the child for that claim after parent-link validation. |

Plain `rd pop` MUST NOT restore a claimed child.

<a id="stale-persisted-state--no-migration"></a>

### 7.4 Stale Persisted State / No Migration

Persisted state MUST NOT be migrated between runtime versions. This applies to:

| State | Covered data |
| --- | --- |
| Runbook state files | Structured fields and opaque `snapshot` blob. |
| Session state | `defaultStack`, `stashedRunbookId`, and `claims`. |
| Delegation state | Claim records, parent links, child links, tokens, and completion records. |

If persisted state is stale, structurally incompatible, corrupt, unreadable, or
from a schema/runtime version the current CLI cannot safely resume, Rundown MUST
fail closed and refuse to continue that run.

The recovery path is to finish or close the affected run if possible, or prune
the incompatible state and restart from the source runbook. The runtime MUST NOT
silently migrate, shim, adapt, rewrite, or resume incompatible persisted state.
Persisted runbook state has no released compatibility contract: preserving older
active runs is not a product requirement. Implementations MUST prefer a breaking
schema/runtime change plus an explicit stale-state error over runtime migration
code, fallback parsing, legacy field hydration, warning-only adapters, or
compatibility branches for old `.rundown/` files.

### 7.5 Runbook State Fields

Each run state file stores enough information to resume deterministically.

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
  "retryCount": 0,
  "variables": { "environment": "staging" },
  "templateVars": { "environment": "staging" },
  "substepStates": [],
  "resolvedCompletions": {},
  "frameEntries": { "2|2": 1 },
  "activeFrameKey": "2|2",
  "activeEntry": 1,
  "forStack": [],
  "iterationResults": ["pass"],
  "lastResult": "pass",
  "lastAction": { "type": "CONTINUE" },
  "runbookSrc": "---\nname: my-runbook\n---\n# My Runbook\n...",
  "snapshot": {}
}
```

| Field | Runtime requirement |
| --- | --- |
| `id` | Persisted run identifier generated at execution start. |
| `runbook` | Canonical runbook identity object: `{ source, path }`, where `source` is `project`, `plugin`, `bundled`, or `external`. For `project`, `plugin`, and `bundled` sources, `path` is a source-root-relative Markdown path. For `external` sources, `path` is a normalized absolute filesystem path. |
| `runbookPath` | Display/execution file path relative to the current project when possible. |
| `step`, `substep` | Current structural position. |
| `retryCount` | User-visible retry count across retry sites. |
| `variables` | Live variable space, including accumulated outputs. |
| `templateVars` | Frozen variable map used for deterministic resume rendering. |
| `forStack` | Active loop frame and current source value. |
| `iterationResults` | Results recorded for current loop aggregation. |
| `substepStates` | Substep lifecycle and delegation state. |
| `resolvedCompletions` | Completion records keyed by frame, entry, and substep. |
| `frameEntries`, `activeFrameKey`, `activeEntry` | Re-entry-safe identity for stale-completion rejection. |
| `lastResult`, `lastAction` | Last result signal and resolved action. |
| `runbookSrc` | Raw source content with template placeholders preserved. |
| `snapshot` | Opaque XState persisted snapshot. |

The runtime MUST treat `snapshot` as persisted state subject to the no-migration
rule.

<a id="template-variables"></a>

## 8. Variable Resolution

Rundown uses Handlebars syntax for template variables. Variable syntax is defined
in [docs/spec/language.md §9](../spec/language.md#9-templating).

<a id="variable-sources"></a>

### 8.1 Variable Sources

Variables are collected with this precedence, highest first:

| Priority | Source | Rule |
| --- | --- | --- |
| 1 | Explicit invocation inputs | `--input-file`, `--input`, and `--input-json`; highest priority. |
| 2 | Plugin variables | Injected only when resolving plugin runbooks. |
| 3 | `RD_INPUT_*` environment variables | Prefix stripped. |
| 4 | Inherited delegation variables | Parent runtime variable space passed to child. |
| 5 | `.rundown/config.yaml` | Auto-discovered from cwd upward. |
| 6 | Built-in defaults | Runtime-provided static defaults. |
| 7 | Context-output inputs | Fill gaps only; MUST NOT override existing values. |

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
placeholders, such as `{{variable}}` or `{{context.parent.missing}}`. The runtime
SHOULD emit one warning for each distinct undefined variable.

### 8.5 Runtime Context Model

The runtime exposes canonical namespaced context paths.

| Path | Runtime meaning |
| --- | --- |
| `context.current.*` | Current step, substep, index, and display `at` path. |
| `context.parent.*` | Nearest parent runbook structural context. |
| `context.parent.vars.NAME` | Parent resolved variable. |
| `context.ancestors.N.*` | Ancestor contexts; `0` is nearest parent. |
| `context.vars.NAME` | Current variable namespace. |

Parent context chain addressing is capped at 32 levels.

<a id="built-in-variables"></a>

### 8.6 Built-In Variables

PascalCase is canonical. Lowercase `step` and `index` aliases are accepted for
dynamic current-frame values but remain reserved for user input.

| Variable | Rule |
| --- | --- |
| `Date`, `DateTime`, `Year`, `Month`, `Day` | Current date/time components. |
| `Branch` | Current git branch, or empty outside git. |
| `WorkPath` | Fixed default artifact base `.rundown/work`; base for `{{ path "..." }}`. |
| `RunbookRef` | Canonical `{ source, path }` identity for the resolved runbook. Injected during runbook preparation. |
| `RunId` | Fresh execution identifier for this runbook execution. Injected only for runnable execution, not for discovery or `rd resolve`. |
| `ContextId` | Shared identity across a delegation tree; scopes path helpers into `.rd-<ContextId>/`. |
| `Step`, `Index` | Dynamic current step and iteration. |
| `context.current.*` | Dynamic current structural context. |
| `context.parent.*` | Parent structural context. |
| `context.parent.vars.NAME` | Parent resolved variable. |
| `context.ancestors.N.*` | Ancestor contexts. |
| `context.vars.NAME` | Current variable namespace. |

Static built-ins MAY be overridden by higher-precedence sources. Dynamic
built-ins MUST NOT be overridden. Plugin runbooks MAY receive upper-snake-case
plugin variables such as `CLAUDE_PLUGIN_ROOT`.

The default `WorkPath` value is shared at the project level and does not include
a branch, run, or checkout suffix. Use `ContextId` with `{{ path "..." }}` or
`rdpath --ctx` for workflow isolation inside `.rundown/work/.rd-<ContextId>/`;
run-scoped artifact helpers add `runs/<RunId>/` below that context directory
when a per-run location is required.

`RunbookRef` is available before template substitution so runbooks can render
their own canonical identity. `RunId` is minted later, when a run is actually
started or claimed, so commands that only resolve variables MUST NOT emit or
persist a synthetic `RunId`.

<a id="shell-environment"></a>

### 8.7 Shell Environment

Executable shell blocks receive Rundown environment variables after policy
environment filtering.

| Environment variable | Source variable |
| --- | --- |
| `RD_WORK_PATH` | `WorkPath` |
| `RD_CONTEXT_ID` | `ContextId` |
| `RD_RUN_ID` | `RunId` |
| `RD_RUNBOOK_REF` | `RunbookRef.path` |
| `RD_RUNBOOK_SOURCE` | `RunbookRef.source` (`project`, `plugin`, `bundled`, or `external`) |
| `RD_OUTPUTS_<VarName>` | Naked step/substep `OUTPUTS` entry. |

Rundown-injected `RD_*` variables use Rundown-wins semantics: user-supplied
environment variables MUST NOT block or override them.

### 8.8 Template Persistence

`state.runbookSrc` stores raw runbook source, and `state.templateVars` stores the
resolved static variable map. On resume, the runtime MUST re-apply FOR bounds
and template placeholders from this frozen variable state so rendering remains
deterministic.

Delegated children inherit the parent's `ContextId` and user variables, but
MUST NOT inherit the parent's `RunId` or `RunbookRef`. Each child receives a
fresh `RunId` and the canonical `RunbookRef` for its own resolved runbook.

## 9. Security Integration

The runtime delegates full policy semantics to
[docs/reference/security.md](security.md). Runtime integration points are:

| Runtime action | Security requirement |
| --- | --- |
| Command execution | Command must pass run policy before spawning. |
| File-backed data source load | Source path must pass containment and read-policy checks. |
| Shell environment injection | User environment is filtered before Rundown `RD_*` injection. |
| Sandbox execution | Supported OS sandbox applies read/write restrictions when enabled. |

Security failures that affect execution MUST fail visibly. For data sources,
policy denial MUST NOT produce silent zero-iteration success.

<a id="runtime-identity-glossary"></a>

## 10. Runtime Identity

Canonical runtime identity is `step + substep + iteration`.

| Identity component | Meaning |
| --- | --- |
| Step | Top-level runbook step id. |
| Substep | Nested substep id, if active. |
| Iteration | Current `FOR` iteration, if active. |
| Frame | Internal `step\|iteration` scope key. |
| Entry | Monotonic re-entry counter for a frame. |
| Completion key | `frame + entry + substep`. |

Re-entering a frame through `GOTO`, `RETRY`, or other control flow increments
the entry counter. Completions from older entries MUST be rejected as stale.

Claim ids are isolation-against-accident handles, not adversarial security
capabilities. Any local process that can read workspace state or command output
can observe and reuse them.

## 11. Conformance

A conforming Rundown runtime MUST satisfy these requirements:

1. Preserve result, handler, and action as distinct runtime concepts.
2. Execute shell code blocks only for executable info strings and derive results
   from exit codes.
3. Treat display-only prompts as non-executable.
4. Track active loop state, current values, and iteration results explicitly.
5. Enforce the 10,000-iteration cap for numeric and open-ended data-source loops.
6. Record iteration results only for actions that specify accumulation.
7. Preserve canonical runtime identity as `step + substep + iteration`.
8. Reject stale frame-entry completions.
9. Keep claimed delegated children out of `defaultStack`.
10. Make claim-targeted commands fail closed when the claim cannot safely target
    one live delegated child.
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
