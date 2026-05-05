---
version: 1.0.0
---

# Rundown Language Specification

## 1. Scope

Rundown is a Markdown-based DSL for executable runbooks. This specification
defines valid Rundown document structure and core DSL semantics. CLI usage,
output formats, policy configuration, and implementation architecture are out of
scope except where required to define document validity.

## 2. Terminology

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

| Term | Meaning |
| --- | --- |
| Document | One Markdown runbook file. |
| Frontmatter | Optional YAML metadata before Markdown content. |
| Step | Top-level executable unit, introduced by H2. |
| Substep | Nested executable unit, introduced by H3. |
| Body | Prompt, command, substeps, runbook-list shorthand, or FOR body. |
| Result | Execution outcome: `PASS` or `FAIL`. |
| Handler | A transition mapping a result to an action. |
| Action | Control-flow effect such as `CONTINUE`, `STOP`, or `GOTO`. |
| Directive | Structural bullet: `OUTPUTS`, `FOR`, or `DELEGATE`. |

## 3. Document Model

A Rundown document is CommonMark-compatible Markdown with optional YAML
frontmatter.

| Element | Form | Cardinality | Rule |
| --- | --- | --- | --- |
| Frontmatter | YAML between `---` fences | 0..1 | MUST precede Markdown. |
| Title | H1 | 0..1 | Metadata only. |
| Description | Text between H1 and first H2 | 0..1 | Metadata only. |
| Step | H2 | 1..N | Executable top-level unit. |
| Substep | H3 | 0..N | Nested unit under a step. |

H4 and deeper headings are invalid.

### 3.1 Frontmatter

Frontmatter is an open YAML object; unknown fields MUST be preserved.

| Field | Type | Rule |
| --- | --- | --- |
| `name` | string | Optional runbook identifier. |
| `description` | string | Discovery/listing summary; independent from Markdown preamble. |
| `version` | string | Optional document version. |
| `author` | string | Optional author metadata. |
| `tags` | string array | Optional discovery metadata. |
| `inputs` | string array | Declares accepted variable names; does not provide values. |
| `required` | string array | Names required at resolution; each MUST also appear in `inputs`. |
| `outputs` | output declaration array | Terminal outputs captured at run completion. |

Input and required names MUST match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. `step`,
`index`, and `context` are reserved case-insensitively and MUST NOT appear in
`inputs` or `required`. Missing required variables are resolution errors.

### 3.2 Heading Hierarchy

Valid hierarchy is H1 metadata, H2 steps, then H3 substeps. H3 headings belong to
the nearest preceding H2 unless they use a qualified identifier. H4+ is invalid.

## 4. Identifiers

| Form | Example | Rule |
| --- | --- | --- |
| Numeric step | `## 1. Build` | MUST start at `1` and increase by `1` without gaps. |
| Named step | `## Recover` | Valid `GOTO` target; skipped by default sequential flow. |
| Qualified numeric substep | `### 1.1 Build DB` | Explicit parent step and substep. |
| Bare numeric substep | `### 1 Build DB` | Parent is containing H2. |
| Bare named substep | `### Repair` | Parent is containing H2. |
| Qualified named substep | `### 1.Repair` | Parent is explicit. |

Named identifiers MUST match `/^[A-Za-z_][A-Za-z0-9_]*$/`.

Reserved identifiers, matched exactly and case-sensitively: `NEXT`, `CONTINUE`,
`DEFER`, `DELEGATE`, `COMPLETE`, `STOP`, `GOTO`, `RETRY`, `PASS`, `FAIL`,
`YES`, `NO`, `ALL`, `ANY`, `BREAK`, `FOR`, `IN`, `TO`, `AT`.

`NEXT` is reserved; `Next` and `NextStep` are valid.

## 5. Step Content

Step and substep content MUST appear in this order:

1. `OUTPUTS` directive.
2. `FOR` directive.
3. `DELEGATE` directive.
4. Transitions.
5. Prompt text.
6. Body.

Each item is optional except the step heading itself. Misordered content is
invalid.

### 5.1 Body Kinds

A step or substep MUST contain exactly one body kind. A prompt-only step is a
`base` body.

| Kind | Form | Rule |
| --- | --- | --- |
| `base` | Prompt only | No executable body. |
| `command` | One fenced code block | Executes or displays by info string. |
| `substeps` | H3 children | Parent result is aggregated from children. |
| `for` | `FOR` plus substeps | Repeats substeps per iteration. |
| `prompted-for` | Unresolved template bound in `FOR` | Original `FOR` text is preserved as prompt text. |

Code blocks and substeps are mutually exclusive. Step-level runbook-list
shorthand is canonicalized to implicit substeps and counts as `substeps`.

### 5.2 Code Blocks

A step or substep MUST NOT contain more than one fenced code block. Bare fences
without an info string are invalid.

| Info string | Rule |
| --- | --- |
| `bash`, `sh`, `shell` | Execute in a shell; exit `0` => `PASS`, non-zero => `FAIL`. |
| `bash prompt`, `prompt` | Display only. |
| Other non-empty string | Display only. |

Info string matching is case-insensitive. Executable blocks inherit the parent
environment, run from the project root, and inherit stdio.

### 5.3 Substeps

If a step contains any valid substep, every H3 in that step MUST be a valid
substep identifier. Parent results are derived from substep results through
transitions and aggregation.

### 5.4 Runbook List Shorthand

A step-level list of runbook references is shorthand for implicit sequential
substeps `.1`, `.2`, and so on. Example:

```markdown
  ## 2. Review
  - review-a.runbook.md
  - review-b.runbook.md
```

This is equivalent to explicit substeps `2.1` and `2.2` with one runbook
reference each. Prompt text above the shorthand attaches to the first generated
substep only.

Runbook references MAY be literal targets or template references such as
`{{ RunbookName }}`. Undefined template references are preserved as literal
text. A runbook-list entry without nested `DELEGATE` is inline linkage: the
child runbook executes in-session and its terminal result propagates to the
parent substep.

### 5.5 Runtime Target Identity

Canonical runtime identity is `step + substep + iteration`. Display notation
such as `1.2.1` (`STEP.INDEX.SUBSTEP` inside `FOR`) is not authoring syntax and
is not canonical.

<a id="4-control-flow"></a>

## 6. Transitions and Actions

Transition syntax:

```text
- PASS CONTINUE
- FAIL STOP
- PASS ALL CONTINUE
- FAIL ANY STOP
```

`YES` aliases `PASS`; `NO` aliases `FAIL`. Transition keywords MUST match whole
words in list items; prefixes such as `PASSING` are not transitions.

### 6.1 Aggregation

Aggregation modifiers apply to substep and `FOR` parents.

| Pair | Meaning |
| --- | --- |
| `PASS ALL` with `FAIL ANY` | Pessimistic aggregation. |
| `PASS ANY` with `FAIL ALL` | Optimistic aggregation. |

Only complementary pairs are valid. `ALL`/`ALL`, `ANY`/`ANY`, and one-sided
aggregation modifiers are invalid. Aggregation waits for all deferred results
and evaluates only the deferred result set.

Defaults:

| Authored | Implied |
| --- | --- |
| Only `PASS` | `FAIL STOP` |
| Only `FAIL` | `PASS CONTINUE` |
| Neither | `PASS CONTINUE`, `FAIL STOP` |
| Substeps under aggregation or delegation | `PASS DEFER`, `FAIL DEFER` |

<a id="42-actions"></a>

### 6.2 Actions

| Action | Valid context | Rule |
| --- | --- | --- |
| `CONTINUE` | Step | Proceed to next step. |
| `CONTINUE` | `FOR` iteration | Exit loop without accumulating current result. |
| `DEFER` | Substep, `FOR` iteration | Propagate result to parent aggregation. |
| `STOP [message]` | Any | Terminate as failure. |
| `COMPLETE [message]` | Any | Terminate as success. |
| `GOTO target` | Any | Jump to step or substep target. |
| `GOTO target AT value` | `FOR` target | Jump to a specific iteration of a `FOR` target. |
| `RETRY N action` | Any | Retry `N` times, then perform fallback action. |
| `NEXT` | `FOR` substep or iteration | Advance without accumulating current result. |
| `BREAK` | `FOR` substep or iteration | Exit loop without accumulating current result. |

`NEXT` and `BREAK` are invalid outside `FOR`. `DEFER` is invalid at top-level
step scope. Standalone `- DEFER` expands to `- PASS DEFER` and `- FAIL DEFER`.
`RETRY` requires both count and fallback; nested `RETRY` fallback is invalid.
`NEXT` is invalid as a `GOTO` target. `GOTO` to the containing step without `AT`
can loop indefinitely; use `RETRY` for bounded re-execution.

When `GOTO target` targets a `FOR` step and omits `AT`, execution enters the
target at the loop's start value: `1` for `FOR 1 TO 10`, `5` for `FOR 5 TO 1`,
and so on. `GOTO target AT {{Index}}` re-enters the target at the current
iteration value.

<a id="43-delegate"></a>

## 7. Delegation

`DELEGATE` marks nested runbook work for out-of-process execution. It MUST be a
bare structural bullet; `DELEGATE value` is invalid.

Valid forms:

| Form | Rule |
| --- | --- |
| Step-level `- DELEGATE` | Applies to all substeps. |
| Per-substep `- DELEGATE` | Applies only to the annotated substep. |
| Nested under runbook-list entry | Applies only to that list entry. |

Ordering: `FOR` MUST precede `DELEGATE`; `DELEGATE` MUST precede transitions,
prompt, and body. A delegated substep MUST resolve to at least one runbook
target, either a `.runbook.md` target or a template target.

When a delegated step is entered, each delegated substep is exposed as a
delegation frontier item containing an id, runbook target, and token. A child
claims the token and resolves the claimed work as `PASS` or `FAIL`; the final
substep resolution auto-aggregates the parent transition. An explicit collection
operation MAY force aggregation for mixed delegated/non-delegated substeps;
repeat collection of an already aggregated frame reports `already-aggregated`.

`RETRY N action` on a delegated step cancels and reissues every delegated
substep in the active frame with fresh tokens, regardless of prior substep
result. Stale tokens return `TOKEN_CANCELLED`. The retry boundary preserves the
canonical `FOR` iteration location in the runtime context snapshot and the next
step entry exposes the new delegation frontier.

When a delegated child reaches a terminal lifecycle but the parent absorbs the
outcome non-terminally, such as `FAIL RETRY`, the child resolution is not itself
an orchestrated workflow failure. Terminal failure is reserved for cases where
there is no parent linkage or the parent's propagation also resolves to a
terminal stopped state.

<a id="5-iteration-for"></a>

## 8. Iteration

A `FOR` directive repeats a step's substeps.

| Syntax | Meaning |
| --- | --- |
| `FOR var IN 1 TO N` | Named numeric range. |
| `FOR 1 TO N` | Unnamed numeric range. |
| `FOR var IN N TO 1` | Named descending range. |
| `FOR N TO 1` | Unnamed descending range. |
| `FOR var IN N` | Named `1 TO N`. |
| `FOR N` | Unnamed `1 TO N`. |
| `FOR var IN 1 TO {{Max}}` | Template-expanded numeric bound. |
| `FOR var IN {{source}}` | Named data-source iteration. |
| `FOR var IN 1 TO N OF {{source}}` | Named data-source window. |

Rules:

| Rule | Requirement |
| --- | --- |
| Direction | `start > end` descends by `1`; otherwise ascends by `1`. |
| Single-number shorthand | Always ascends from `1`. |
| Limits | Numeric bounds and open-ended data sources are capped at 10,000 iterations. |
| Data-source variable | Data-source iteration MUST use a named variable; `FOR {{source}}` is invalid. |
| Data-source reference | `{{source}}` names a defined runtime data source and is not template-expanded. |
| Template bounds | Bounds such as `{{Max}}` are expanded before parsing. |
| Unresolved bounds | Step becomes `prompted-for`; original `FOR` text is preserved as prompt. |
| Body | `FOR` MUST have substeps; runbook-list shorthand qualifies. |
| Scope | Named loop variable is available in substeps as `{{var}}`. |

Data sources are runtime arrays or file-backed JSON/JSONL sources. `file:` paths
MUST remain inside the project root after symlink resolution. `.jsonl` sources
are JSON Lines; `.json` sources are JSON arrays or objects, with arrays usable
for iteration.

### 8.1 Iteration-Level Transitions

Nested bullets under `FOR` MUST be transitions. Allowed actions are `CONTINUE`,
`DEFER`, `NEXT`, `BREAK`, `GOTO`, `STOP`, `COMPLETE`, and `RETRY` wrappers.

| Action | Records iteration result | Step-level handler fires |
| --- | --- | --- |
| `DEFER` | Yes | After final recorded iteration. |
| `NEXT` | No | After final iteration. |
| `BREAK` | No | Yes. |
| `CONTINUE` | No | Yes. |
| `GOTO` | No | No. |
| `STOP` | No | No. |
| `COMPLETE` | No | No. |

Default iteration-level action is `DEFER`. Iteration-level `RETRY` is evaluated
before the exhausted fallback action and applies to the iteration result, not
the substep action.

<a id="6-templating"></a>

## 9. Templating

Variables use Handlebars syntax: `{{variable}}`. Dotted paths are supported,
including `{{context.parent.vars.Name}}`.

Undefined variables are preserved as literal text; a warning is emitted for each
undefined variable.
Global variables expand once. Dynamic step, substep, and iteration variables
expand against the current runtime frame.

### 9.1 Variable Names and Precedence

`step`, `index`, and `context` are reserved case-insensitively and MUST NOT be
overridden by user variables. Reserved names are rejected in frontmatter
`inputs`, frontmatter `required`, explicit invocation inputs, input files, and
configuration files. Reserved `RD_INPUT_*` environment variables are skipped
with a warning.

Precedence, highest first:

1. Explicit invocation inputs: files, scalar inputs, JSON inputs.
2. Plugin variables, when resolving a plugin runbook.
3. `RD_INPUT_*` environment variables, prefix stripped.
4. Inherited delegation variables.
5. `.rundown/config.yaml`, discovered from cwd upward.
6. Built-in defaults.
7. Context-output inputs, which fill gaps only.

Frontmatter `inputs` declares accepted names; it is not a value layer. Missing
frontmatter `required` variables produce a hard resolution error
(`MISSING_REQUIRED_VARS`).

<a id="61-built-in-variables"></a>

### 9.2 Built-In Variables

PascalCase is canonical. Lowercase `step` and `index` aliases are accepted for
dynamic current-frame values but remain reserved for user input.

| Variable | Rule |
| --- | --- |
| `Date`, `DateTime`, `Year`, `Month`, `Day` | Current date/time components. |
| `Branch` | Current git branch, or empty outside git. |
| `WorkPath` | Workspace artifact directory; fallback `.rundown/work`; base for `{{ path "..." }}`. |
| `RunbookRef` | Canonical `{ source, path }` identity for the resolved runbook. Injected before template substitution. |
| `RunId` | Fresh execution identifier for this runbook execution. Injected only when the runbook is started or claimed, not during variable discovery or `rd resolve`. |
| `ContextId` | Shared identity across a delegation tree; scopes `{{ path "..." }}` into `.rd-<ContextId>/`. |
| `Step`, `Index` | Dynamic current step and iteration. |
| `context.current.*` | Dynamic current `step`, `substep`, `index`, and `at`. |
| `context.parent.*` | Parent structural context. |
| `context.parent.vars.NAME` | Parent resolved variable. |
| `context.ancestors.N.*` | Ancestor contexts; `0` is nearest parent. |
| `context.vars.NAME` | Current variable namespace. |

Static built-ins MAY be overridden by higher-precedence sources. Dynamic
variables MUST NOT be overridden. Parent context chain addressing is capped at
32 levels. Plugin runbooks MAY receive upper-snake-case plugin variables;
`CLAUDE_PLUGIN_ROOT` identifies the plugin installation directory.
Delegated children inherit the parent's `ContextId` and user variables, but MUST
NOT inherit the parent's `RunId` or `RunbookRef`.

### 9.3 Shell Environment

Executable shell blocks receive `RD_WORK_PATH`, `RD_CONTEXT_ID`, `RD_RUN_ID`,
`RD_RUNBOOK_REF`, and `RD_RUNBOOK_SOURCE` from `WorkPath`, `ContextId`, `RunId`,
`RunbookRef.path`, and `RunbookRef.source`. These variables are injected after
policy environment filtering and use Rundown-wins semantics. The `RD_` prefix is
reserved for Rundown-injected variables.

<a id="7-context-passing-outputs"></a>
<a id="7-context-passing-inputs--outputs"></a>

## 10. Context Passing

Context passing uses step `OUTPUTS`, frontmatter `outputs`, and delegation
inheritance.

<a id="71-outputs"></a>

### 10.1 Step `OUTPUTS`

`OUTPUTS` declares values to merge into the live variable space after a step or
substep completes.

Rules:

| Rule | Requirement |
| --- | --- |
| Cardinality | At most one `OUTPUTS` directive per step or substep. |
| Ordering | MUST be the first directive after the heading. |
| Names | MUST NOT be reserved runtime names, case-insensitively. |
| Timing | Evaluated on both `PASS` and `FAIL` transitions. |
| Forms | Handlebars expression, quoted literal with templates, bare variable reference, or naked file-backed entry. |
| Merge | Adds new keys and overwrites same-name live variables. |
| Failure | Failed expressions are omitted and logged; transition is not rolled back. |
| Status visibility | The merged variable space is exposed in status output as `vars`. |

A naked entry is only a variable name. It activates a file-backed channel:
Rundown creates a writable UTF-8 file, injects `RD_OUTPUTS_<VarName>` with its
absolute path, then reads, trims, and merges the file content after command exit.
Missing, empty, or non-UTF-8 content is omitted. Naked and expression forms MAY
mix in one `OUTPUTS` block.

File-backed output path scopes:

| Scope | Relative path |
| --- | --- |
| Step | `.rundown/runs/<runId>/outputs/<stepId>/<VarName>` |
| Substep | `.rundown/runs/<runId>/outputs/<stepId>/<substepId>/<VarName>` |
| `FOR` iteration | `.rundown/runs/<runId>/outputs/<stepId>/<substepId>/<iteration>/<VarName>` |

`RD_OUTPUTS_*` is injected after policy filtering and cannot be blocked or
overridden by user environment variables. Expression-form entries do not create
files or environment variables.

The removed `INPUTS` step directive is invalid; use frontmatter `inputs`.

### 10.2 Frontmatter `outputs`

Frontmatter `outputs` is evaluated at terminal `COMPLETE` or `STOPPED`
transition against the merged variable space. Entries use the same declaration
grammar as step `OUTPUTS`, except naked frontmatter entries read variables by
name and do not create file-backed channels. Results are written to final run
state and forwarded from child runbooks to parent live variables on completion.

### 10.3 Delegation Inheritance

Delegated children inherit the parent's `ContextId` and non-context template
variables. Step outputs accumulate during execution; terminal frontmatter
outputs propagate back to the parent.

## 11. Conformance

A conforming parser MUST reject documents that violate any MUST-level rule above.
In particular:

1. At least one H2 step is required.
2. H4+ headings are invalid.
3. Numeric steps must be sequential.
4. Content ordering is strict.
5. Body kinds are mutually exclusive.
6. At most one code block is allowed per step or substep.
7. Bare code fences are invalid.
8. `FOR` requires substeps and named variables for data sources.
9. Nested `FOR` bullets must be transitions.
10. `NEXT`, `BREAK`, and `DEFER` are valid only in their specified contexts.
11. `RETRY` requires count and fallback; fallback cannot be `RETRY`.
12. Aggregation modifiers must be complementary.
13. At most one `OUTPUTS` directive is allowed per step or substep.
14. Reserved runtime names are invalid for inputs and outputs.
15. `INPUTS` step directives are invalid.
16. `DELEGATE` must be bare, ordered correctly, and target a runbook.
17. Step-level `DELEGATE` must satisfy target requirements for every child.
18. `NEXT` is invalid as a `GOTO` target.
19. `GOTO` to a `FOR` target without `AT` enters at the target loop's start value.
20. Delegation retry must cancel and reissue every delegated substep in the active frame.
21. Naked `OUTPUTS` entries alone create `RD_OUTPUTS_<VarName>`.

## 12. Compatibility

Step-level runbook lists are represented as sequential implicit substeps
(`N.1`, `N.2`, ...).

Rundown implementations MUST NOT migrate persisted runbook state between
versions. This applies to all data under `.rundown/runs/`, including structured
state fields and opaque snapshots. When persisted state is stale or structurally
incompatible, implementations SHOULD require the user to complete, stop, or
prune the run and restart from the source document. See
[runtime recovery](../reference/runtime.md#stale-persisted-state--no-migration)
for operational details.
