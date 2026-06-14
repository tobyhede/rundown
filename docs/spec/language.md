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
| Directive | Structural bullet: `ARTIFACTS`, `OUTPUTS`, `FOR`, or `DELEGATE`. |
| Artifact manifest | Context-scoped JSONL file at `<WorkPath>/.rd-<ContextId>/manifest.jsonl`. |
| ArtifactRecord | The only structured artifact variable value; one manifest row with artifact URI, run identity, runbook identity, key, and timestamp. |
| Artifact working set | The current step/substep's resolved `ARTIFACTS` aliases for the active execution unit. |

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
`index`, `context`, `runid`, and `runbookref` are reserved case-insensitively
and MUST NOT appear in `inputs` or `required`. Missing required variables are
resolution errors.

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

1. `ARTIFACTS` directive.
2. `OUTPUTS` directive.
3. `FOR` directive.
4. `DELEGATE` directive.
5. Transitions.
6. Prompt text.
7. Body.

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
| Limits | Numeric bounds exceeding `MAX_FOR_BOUND` (10,000) are rejected at parse time by Zod validation — not silently capped. Open-ended data-source iteration is capped at runtime by `MAX_FILE_ITERATIONS` (10,000); iteration stops once the cap is reached. See [runtime.md §5.1](../reference/runtime.md#51-loop-state). |
| Data-source variable | Data-source iteration MUST use a named variable; `FOR {{source}}` is invalid. |
| Data-source reference | `{{source}}` names a defined runtime data source and is not template-expanded. |
| Source resolution | A data source is resolved at step **entry**, not at launch. A source produced by an earlier step in the same run (via `OUTPUTS` or a name-binding `ARTIFACTS` alias) is valid. See §8.2. |
| Template bounds | Bounds such as `{{Max}}` are expanded before parsing. |
| Unresolved bounds | Step becomes `prompted-for`; original `FOR` text is preserved as prompt. |
| Body | `FOR` MUST have substeps; runbook-list shorthand qualifies. |
| Scope | Named loop variable is available in substeps as `{{var}}`. |
| Delegation scope | Within an iteration, the loop variable and `Index` are inheritable by delegated children, per §10.4. |

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

### 8.2 Data-Source Resolution Timing

A data source is resolved against the effective variable space when its `FOR`
step is entered, using the rendering merge order (`templateVars < variables <
extraVars`, §10.4). A source MAY therefore be produced by an earlier step in the
same run; iterating a value the runbook itself produces is valid.

The *produced set* is the union of every step and substep `OUTPUTS` name and
every **name-binding** `ARTIFACTS` alias. A naked `ARTIFACTS` assertion (`- Name`
with no token, §10.1.2) asserts an existing binding and publishes no new name, so
it is **not** in the produced set. Launch validation and static analysis MUST
derive this set identically.

| Phase | Requirement |
| --- | --- |
| Launch (`rd run`, `rd resolve`) | A data source that is neither available at launch (input, config, `--input`, `RD_INPUT_*`, or delegation inheritance) nor in the produced set MUST be rejected (`VALIDATION_ERROR`). A source in the produced set MUST be deferred to step entry and MUST NOT be rejected at launch. |
| Step entry | The source MUST resolve to an iterable value (runtime array, `.json` array, or `.jsonl` stream). A missing or non-iterable source fails the step with a typed resolution error; it is not silently skipped. |
| Static (`rd check`) | Parser-tier validation does not resolve variables. An implementation SHOULD warn when a data source is neither a declared `inputs` name nor in the produced set, and MUST NOT raise it as an error — the source may be supplied at runtime. |

## 9. Templating

Variables use Handlebars syntax: `{{variable}}`. Dotted paths are supported,
including `{{context.parent.vars.Name}}`.

Undefined variables are preserved as literal text; a warning is emitted for each
undefined variable.
Global variables expand once. Dynamic step, substep, and iteration variables
expand against the current runtime frame.

Beyond the `path` and `artifact` artifact helpers documented in §9.3, the
renderer also provides the built-in `validateSchema` helper and a
user-extensible helper registry. §9.3 is not an exhaustive list of available
helpers.

### 9.1 Variable Names and Precedence

`step`, `index`, `context`, `runid`, and `runbookref` are reserved
case-insensitively and MUST NOT be overridden by user variables. Reserved names
are rejected in frontmatter `inputs`, frontmatter `required`, explicit
invocation inputs, input files, and configuration files. Reserved `RD_INPUT_*`
environment variables are skipped with a warning.

Resolution builds five variable layers. Precedence, highest first:

1. CLI inputs: `--input-json` > `--input` > `--input-file` (within-layer tie-break; see [runtime.md §8.1](../reference/runtime.md#81-variable-sources)).
2. `RD_INPUT_*` environment variables, prefix stripped.
3. Inherited delegation variables, including inherited step `OUTPUTS`.
4. `.rundown/config.yaml`, discovered from cwd upward.
5. Built-in defaults.

Inherited step `OUTPUTS` ride the inherited-delegation layer and override
configuration and built-in defaults; they are not a separate gap-fill layer.
`CLAUDE_PLUGIN_ROOT` is not a precedence layer: it is a plugin-only default
injected after resolution only when the variable is absent, and any explicit
input takes precedence over it.

Frontmatter `inputs` declares accepted names; it is not a value layer. Missing
frontmatter `required` variables produce a hard resolution error
(`MISSING_REQUIRED_VARS`).

### 9.2 Built-In Variables

PascalCase is canonical. Lowercase `step` and `index` aliases are accepted for
dynamic current-frame values but remain reserved for user input.

| Variable | Rule |
| --- | --- |
| `Date`, `DateTime`, `Year`, `Month`, `Day` | Current date/time components. |
| `Branch` | Current git branch, or empty outside git. |
| `WorkPath` | Fixed default artifact base `.rundown/work`; base for `{{ path "..." }}`. |
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

The default `WorkPath` is project-shared and MUST NOT be derived from the git
branch, checkout path, or run id. Isolation for `{{ path "..." }}` is provided by
`ContextId` (`.rd-<ContextId>/`), with run-scoped artifact locations adding the
current `RunId` below that context when needed.

### 9.3 Artifact Rendering Helpers

Helpers are render-only. The `path` and `artifact` helpers MUST NOT append manifest rows, create artifact records, or mutate runbook state. Only `ARTIFACTS` resolution writes manifest rows.

Rendering an `ArtifactRecord` directly yields its local filesystem path. Rendering an `ArtifactRecord[]` directly yields a JSON array of local filesystem paths. An empty artifact array renders as `[]`.

The `path` helper accepts two forms. The **variable-reference form** `{{ path ArtifactName }}` renders the same local filesystem path projection as direct alias rendering. Managed `rd://artifacts/...` records render under `WorkPath`; file-backed `file:///...` records render to the referenced local path. For an `ArtifactRecord[]`, it renders a JSON array of contained local filesystem paths. The **literal-key form** `{{ path "key" }}` renders a single local filesystem path for the quoted key under the current `WorkPath`, `ContextId`, and `RunId` — it does not require an artifact binding.

`{{ artifact ArtifactName }}` renders artifact URI values with the same scalar or array cardinality as direct alias rendering: a single URI for `ArtifactRecord`, or a JSON array of URIs for `ArtifactRecord[]`. The `artifact` helper accepts only the variable-reference form and rejects the literal-key form `{{ artifact "key" }}`.

Runtime command rendering MUST render command text once per execution and reuse that exact rendered string for both `STEP_ENTERED.commandCode` and actual execution.

### 9.4 Shell Environment

Executable shell blocks receive `RD_WORK_PATH`, `RD_CONTEXT_ID`, `RD_RUN_ID`,
`RD_RUNBOOK_REF`, and `RD_RUNBOOK_SOURCE` from `WorkPath`, `ContextId`, `RunId`,
`RunbookRef.path`, and `RunbookRef.source`. These variables are injected after
policy environment filtering and use Rundown-wins semantics. The `RD_` prefix is
reserved for Rundown-injected variables.

## 10. Context Passing

Context passing uses step `ARTIFACTS`, step `OUTPUTS`, frontmatter `outputs`,
and delegation inheritance.

### 10.1 Step `ARTIFACTS`

`ARTIFACTS` declares artifact aliases for the step or substep being entered. It is an execution-unit directive only; it is valid on steps and substeps and is not valid in frontmatter.

Rules:

| Rule | Requirement |
| --- | --- |
| Cardinality | At most one `ARTIFACTS` directive per step or substep. |
| Ordering | MUST be the first directive after the heading. |
| Names | MUST match variable-name rules and MUST NOT be reserved runtime names, case-insensitively. |
| Keys | A quoted artifact key literal, file path, or quoted `rd://` URI. Templates are expanded before parsing (see §10.1.1). The key MAY be omitted to use the assertion form (§10.1.2). |
| Scope | Applies only to the declaring step or substep's current execution-unit working set. |
| Persistence | Writes resolved values into persisted `state.variables`, which carries mixed string `OUTPUTS` and structured `ArtifactRecord` values via `VariableValueSchema`. |
| Resolution order | Declarations resolve in source order. |

Each declaration binds the named alias according to its form (see §10.1.1). Managed bare-key, file-reference, and exact-URI declarations CREATE a manifest entry for the current context and current run. Selector-URI declarations query the same-context manifest read-only and may yield `ArtifactRecord` (one match), `ArtifactRecord[]` (many), or an empty array. Selectors have no opinion on arity — the runbook's structure (step/substep scope, FOR loops, delegation) determines the expected number of records.

The directive writes manifest rows; it does NOT write managed artifact files or modify referenced files. For managed artifacts, the agent writes the file at the path mapped from the `rd://` URI. For file references, the resolver records the existing file's canonical `file:///` URI.

Resolved artifact references are emitted on `STEP_ENTERED.artifacts` when the directive evaluates. Authors typically consume the structured payload rather than interpolating URIs into shell.

Selector matching includes current-run records and cross-run records in the same `ContextId` when the artifact file exists. The same-context guard and the per-row file-existence check are the active safety mechanisms; selector resolution does not filter on sibling-run lifecycle. Matching is across runbooks in the same `ContextId`; the current runbook identity is metadata and is not an implicit selector filter. Manifest coalescing follows the identity and tie-break rules in [uri.md §10](./uri.md#10-coalescing).

#### 10.1.1 Expansion rules

The quoted token in a declaration is template-expanded before parsing. Any in-scope variable, including the built-ins `{{ContextId}}` and `{{RunId}}`, may appear inside the quoted string. Expansion follows the same rules as `FOR` clauses (§8).

After expansion, the parser classifies the token:

| Form | Example | Desugars to | Resolved kind | Manifest write |
|------|---------|-------------|---------------|----------------|
| Shorthand, bare exact key | `"plan.json"` | `rd://artifacts/{{ContextId}}/{{RunId}}/plan.json` | exact | YES — produces (current run) |
| Shorthand, bare wildcard key | `"plan-*.json"` | `rd://artifacts/{{ContextId}}/{{RunId}}/plan-*.json` | selector | NO — query, current run |
| Shorthand, cross-run exact key | `"*/plan.json"` | `rd://artifacts/{{ContextId}}/*/plan.json` | selector | NO — query, all runs in context |
| Shorthand, cross-run wildcard key | `"*/plan-*.json"` | `rd://artifacts/{{ContextId}}/*/plan-*.json` | selector | NO — query, all runs in context |
| Relative file reference | `"schemas/review.schema.json"` | canonical `file:///.../schemas/review.schema.json` found via project, plugin, then bundled search roots | file | YES — appends row for the file URI |
| Absolute file reference | `"/abs/path/review.schema.json"` | canonical `file:///abs/path/review.schema.json` when read policy allows it | file | YES — appends row for the file URI |
| URI literal (exact, current ctx + current run) | `"rd://artifacts/<currentCtx>/<currentRun>/<key>"` | itself | exact | YES — produces |
| URI literal (selector) | `"rd://artifacts/<ctx>/*/<key>"` | itself | selector | NO — read-only query |
| URI literal (exact, current ctx + other run) | `"rd://artifacts/<currentCtx>/<otherRun>/<key>"` | itself | exact | NO — read-only reference |
| URI literal (cross-context) | `"rd://artifacts/<otherCtx>/<run>/<key>"` | rejected | — | NO |

A quoted shorthand token is syntactic sugar for an `rd://artifacts/` URI. The
token is the tail of the URI path; omitted leading segments default — the
context segment to the current `ContextId`, the run segment to the current
`RunId`. The token forms collapse into one concept; every shorthand desugars
to a URI and routes through the single URI resolver path.

- **Bare exact key** (`"plan.json"`) — produces. Desugars to an exact URI for
  the current context and current run. The resolver appends a manifest entry;
  the agent writes the artifact file. This shorthand is one of the operations
  that writes a manifest row, alongside file references and exact URI literals
  for the current context and run.
- **Bare wildcard key** (`"plan-*.json"`) — queries the current run. Desugars
  to a selector URI whose run segment is the current run and whose key carries
  the glob. Read-only discovery within the current run's artifacts.
- **Cross-run prefix** (`"*/plan.json"`, `"*/plan-*.json"`) — queries all runs
  in the current context. A leading `*/` overrides the run segment to the
  selector wildcard `*`. The key may be exact (collect a known filename across
  sibling runs) or carry globs. Read-only discovery. Discovering and finding
  artifacts across sibling runs in the same context is a first-class capability
  of the cross-run shorthand.
- **Path-like file reference** (`"schemas/review.schema.json"`) — a token
  containing a path separator that is NOT the `*/` cross-run prefix is a file
  reference. Existing files are resolved before any managed-artifact
  interpretation. Relative paths search project, plugin, then bundled roots;
  explicit absolute paths require read-policy approval. A path-like token that
  also carries glob characters is rejected — it is neither a valid shorthand
  key nor a file reference. Missing path-like references fail.

**Produce vs query.** A shorthand token *produces* (writes a manifest row)
exactly when it is a bare exact key — no `*/` prefix and no `*`/`?` in the key.
Every other shorthand form *queries* (read-only). The `*` is the universal
"search" signal: a `*/` prefix searches across runs, and a glob in the key
searches across names. Producing is the terse default because it is the common
operation and the only one that structurally cannot be a query.

Manifest writes use the identity tuple defined in [uri.md §8](./uri.md#8-manifest-record); appending a row for an identity that already exists is idempotent under the coalescing rule ([uri.md §10](./uri.md#10-coalescing)).

#### 10.1.2 Naked declaration (assertion form)

A declaration with no key — `Plan` instead of `Plan "..."` — asserts that `Plan` is already bound in scope as an artifact reference. The directive does not bind a new selector; it validates that an existing variable is artifact-shaped and surfaces it on `STEP_ENTERED.artifacts`.

The bound value MUST be one of:

- `ArtifactRecord` — emitted as-is.
- `ArtifactRecord[]` — emitted as-is.
- A URI string matching the `rd://` form ([uri.md §6](./uri.md#6-forms)) — resolved against the same-context manifest, coerced to `ArtifactRecord` or `ArtifactRecord[]` per the manifest's yield.
- A `URI[]` of URI strings — each URI resolved against the manifest, emitted as `ArtifactRecord[]`.
- A JSON string containing a `URI[]` of `rd://` URI strings — decoded only in this naked `ARTIFACTS` boundary, then resolved like `URI[]`.

Structured records are accepted as already provenance-checked artifact values and MAY carry a different `ContextId` from the current run. This is the cross-context handoff path for delegated or externally supplied artifact variables: public inputs pass artifact URIs, the variable resolver rehydrates those URIs from the source context manifest, and only the manifest-backed records enter `state.variables`. Public artifact-shaped records that did not come from this trusted resolver path are rejected before preparation.

URI string forms in naked `ARTIFACTS` still resolve against the same-context manifest. The `URI[]` and JSON string `URI[]` forms mirror `ArtifactRecord[]`, allowing string-form references to cross process or delegation boundaries and rehydrate at the consumer when they are same-context. Implementations MUST NOT parse arbitrary JSON strings as variables; JSON decoding is limited to this artifact boundary and only succeeds when the decoded value is an array whose entries are all `rd://` URI strings.

Resolution MUST be all-or-nothing. The directive MUST error at evaluation when:

| Failure | When |
|---------|------|
| `unbound` | The variable is not present in scope. |
| `not-an-artifact` | The bound value is not one of the supported shapes above. |
| `unresolvable-uri` | A URI string does not parse, or parses but matches no manifest row. |
| `partial-resolve` | A `URI[]` or JSON string `URI[]` contains at least one URI that fails resolution. No partial emission. |

The naked form is intended for consumer runbooks (e.g. a reviewer asserting that `Plan` was inherited from the parent's delegation chain) where the variable is expected to exist before the step runs.

`ArtifactRecord` is the only structured artifact value:

```json
{
  "kind": "artifact-record",
  "uri": "rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/plan.json",
  "path": "/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json",
  "runId": "rd_0123456789abcdef0123456789abcdef",
  "contextId": "ctx1",
  "runbook": {
    "source": "project",
    "path": "planning/write-plan.runbook.md"
  },
  "key": "plan.json",
  "timestamp": "2026-05-07T00:00:00.000Z"
}
```

Public events, status, and artifact commands include `kind`, `uri`, and `path`. Persisted managed manifest rows remain the six-field URI-backed shape without `kind` or `path`. The manifest field set, canonical write order, cross-field validation rule, and per-record semantics are defined in [uri.md §8](./uri.md#8-manifest-record).

URI grammar, storage layout, manifest scoping, and coalescing are normatively defined in [docs/spec/uri.md](./uri.md). This section refers to URIs and manifests using terms defined there.

Persisted runbook state stores artifact and output values together in a single bucket:

```text
templateVars < variables < extraVars
```

`state.variables` carries mixed values (typed via `VariableValueSchema`): string command `OUTPUTS` and structured `ArtifactRecord` / `ArtifactRecord[]` from `ARTIFACTS`. Effective rendering and delegation contexts merge `templateVars`, `variables`, and `extraVars` in the order shown.

Same-name `ARTIFACTS` and `OUTPUTS` declarations are allowed. `ARTIFACTS` writes a structured value at step/substep entry. `OUTPUTS` writes a string value after command completion and overwrites the entry under the same name in `state.variables`. The legacy `artifactVars` field is rejected by `RunbookStateSchema` via `superRefine`.

### 10.2 Step OUTPUTS

`OUTPUTS` declares name-only command output channels to merge into the live variable space after a step or substep completes.

Rules:

| Rule | Requirement |
| --- | --- |
| Cardinality | At most one `OUTPUTS` directive per step or substep. |
| Ordering | MUST follow `ARTIFACTS` when present and MUST precede `FOR`, `DELEGATE`, transitions, prompt, and body. |
| Names | MUST NOT be reserved runtime names, case-insensitively. |
| Forms | Step/substep entries are name-only. Expression-form step/substep `OUTPUTS` entries are parse errors. |
| Timing | File-backed values are read and merged after command completion. |
| Merge | Adds new keys to typed `state.variables` and overwrites same-name runtime variables. |
| Retry interaction | When a step has a `RETRY` handler, OUTPUTS are captured on every attempt. Each attempt's values overwrite any previously captured values. The final (succeeding or retry-exhausting) attempt's values are what persist in `state.variables`. |
| Status visibility | The merged variable space is exposed in status output as `vars`. |

A name-only entry activates a file-backed channel: Rundown creates a writable UTF-8 file, injects `RD_OUTPUTS_<VarName>` with its absolute path, then reads, trims, and merges the file content after command exit. Missing, empty, or non-UTF-8 content is omitted.

Captured `RD_OUTPUTS_<Name>` values are UTF-8 text. If the trimmed content is
valid JSON whose top-level value is a string, finite number, object, or array,
Rundown stores the typed value in the runtime variable map. Concretely,
`printf '42' > "$RD_OUTPUTS_X"` persists `X` as the JSON number `42`; downstream
`{{ X }}` template expansion stringifies it back to `"42"` for command
substitution. Top-level JSON booleans and null are stored as their original
string text -- this matches the parser's behaviour for frontmatter `outputs:`
values, so the two surfaces stay consistent. Arrays and objects therefore
become valid sources for later `FOR x IN {{ Name }}` clauses.

File-backed output path scopes:

| Scope | Relative path |
| --- | --- |
| Step | `.rundown/runs/<runId>/outputs/<stepId>/<VarName>` |
| Substep | `.rundown/runs/<runId>/outputs/<stepId>/<substepId>/<VarName>` |
| `FOR` iteration | `.rundown/runs/<runId>/outputs/<stepId>/<substepId>/<iteration>/<VarName>` |

`RD_OUTPUTS_*` is injected after policy filtering and cannot be blocked or overridden by user environment variables. Step/substep `OUTPUTS` does not create artifact records and does not write `artifactVars`.

### 10.3 Frontmatter outputs

Frontmatter `outputs` is evaluated at terminal `COMPLETE` or `STOPPED` transition against the merged effective variable context. Entries may be name-only or may include expression values. Name-only frontmatter entries read variables by name and do not create file-backed channels.

Frontmatter `outputs:` expression behavior is separate from step/substep `OUTPUTS`. Final run state is a string-only transport boundary: exporting an `ArtifactRecord` writes its URI string, and exporting an `ArtifactRecord[]` writes a JSON string containing the record URIs. Consumers that need structured artifact values declare naked `ARTIFACTS` aliases to rehydrate those URI strings through the same-context manifest.

Results are written to final run state and forwarded from child runbooks to parent live variables on completion.

### 10.4 Delegation Inheritance

Delegated children inherit the parent's `ContextId`, the parent's non-context
template variables, and — within a `FOR` step — the iteration bindings defined
below. They do not inherit the parent's `RunId` or `RunbookRef`.

Effective delegation variables use the same merge order as rendering:

```text
templateVars < variables < extraVars
```

**Iteration bindings.** When a delegation is issued from within a `FOR` step,
the parent's active iteration contributes two inherited values:

- **`Index`** — the 1-based iteration number — is inherited unconditionally.
- **The loop variable** — the iteration's current value (the data-source item,
  or the iteration number for a numeric range) — is inherited **only when the
  delegated child declares that name in its frontmatter `inputs`**. A child that
  does not declare the loop variable does not receive it; a child that lists it
  in `required` fails to launch when the binding is absent (for example, when
  delegated outside a `FOR`). Both values enter the child through the inherited
  variable layer, which ranks **below** explicit `--input`, so an override
  (`--input` on `delegate` or `claim`) for the same name still wins.

**Per-iteration scope.** An iteration binding is keyed to the parent step's
active iteration, not to the individual delegated reference. When a `FOR` step
delegates more than one reference per iteration, every reference delegated in
iteration *N* inherits the **same** loop value and `Index`. References are never
paired to data-source positions. A data-source `FOR` (`FOR var IN {{source}}`)
with more than one delegated reference SHOULD be reported by `rd check` as a
shared-binding warning; numeric-range `FOR` (a pass counter) is unaffected.
Authors requiring one worker per item MUST use a single delegated reference per
`FOR` step.

Step `OUTPUTS` and step `ARTIFACTS` both accumulate during execution in the unified `state.variables` map (typed via `VariableValueSchema`). Terminal frontmatter `outputs` propagate selected values through string-only `finalVars`; artifact records cross this boundary as URI strings or JSON URI-array strings and can be rehydrated by naked `ARTIFACTS` declarations in the receiver.

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
22. At most one `ARTIFACTS` directive is allowed per step or substep.
23. `ARTIFACTS` must be ordered before `OUTPUTS` and all other step content.
24. `ARTIFACTS` is invalid in frontmatter.
25. Duplicate aliases in one `ARTIFACTS` block are invalid.
26. Quoted artifact tokens must parse as safe managed keys, file references, or `rd://` URIs after template expansion.
27. Step/substep `OUTPUTS` entries must be name-only; expression-form entries are invalid.
28. Empty wildcard artifact results are valid values and must not be collapsed to absence.
29. Parser conformance fixtures for `ARTIFACTS` should cover valid exact declarations, valid wildcard declarations, duplicate aliases, invalid keys, misplaced directives, frontmatter misuse, and expression-form step/substep `OUTPUTS`.

## 12. Compatibility

Step-level runbook lists are represented as sequential implicit substeps
(`N.1`, `N.2`, ...).

Rundown implementations MUST NOT migrate persisted runbook state between
versions. This applies to all data under `.rundown/runs/`, including structured
state fields and opaque snapshots. When persisted state is stale or structurally
incompatible, implementations SHOULD require the user to complete, stop, or
prune the run and restart from the source document. See
[runtime recovery](../reference/runtime.md#invalid-persisted-state--no-migration)
for operational details.

There is no compatibility promise for persisted active run state. Implementations
SHOULD break invalid `.rundown/` state explicitly instead of preserving old
behavior with runtime migrations, legacy fallback parsers, or compatibility
shims.

Persisted `artifactVars` is a rejected field; encountering it triggers a `RunbookState` schema/version error. Invalid active state without compatible artifact state MUST be rejected and surfaced to the user for completion, stopping, or pruning. Implementations MUST NOT migrate or shim incompatible persisted state into the unified `state.variables` shape.
