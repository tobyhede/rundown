---
version: 1.0.0
---

# Rundown Format

Formal BNF-style grammar for Rundown runbook syntax. See [SPEC.md](./SPEC.md) for prose explanations and examples.

## Grammar Notation

| Symbol | Meaning |
|--------|---------|
| `[ x ]` | Optional element |
| `{ x }` | Zero or more repetitions |
| `x \| y` | Choice (x or y) |
| `"text"` | Literal text |
| `x ...` | One or more of x |
| `positive_integer` | Integer > 0 (1, 2, 3, ...) |
| `ws` | One or more horizontal whitespace characters (space or tab) |

---

[ frontmatter ]
# title
[ description ]

steps

where steps is:
  step [ step ... ]

where step is:
  "##" step-identifier [ separator ] title
    [ for_clause ]
    [ transition ... ]
    [ prompt ]
    [{ code_block | substeps | runbooks }]

where separator is:
  [ "." | ":" | "—" | "→" | "-" | ")" | " " ]+

where prompt is:
  [ text ]

where substeps is:
  substep [ substep ... ]

where substep is:
  "###" substep_id [ separator ] [ title ]
    [ transition ... ]
    [ prompt ]
    [{ code_block | runbooks }]

where substep_id is:
  positive_integer                              -- bare numeric (parent positionally assigned)
  | name                                        -- bare named (parent positionally assigned)
  | parent_ref "." ( positive_integer | name )  -- qualified form

where parent_ref is:
  positive_integer    -- for static parent
  | name              -- for named parent

where step-identifier is:
  positive_integer | name

where substep-identifier is:
  step-identifier "." ( positive_integer | name )

where name is:
  [A-Za-z_][A-Za-z0-9_]*
  (case-sensitive; must not be a reserved word: NEXT, CONTINUE, DEFER, COMPLETE, STOP, GOTO, RETRY, PASS, FAIL, YES, NO, ALL, ANY, BREAK, FOR, IN, TO, AT)

where code_block is:
  "```" [ info_string ]
    content
  "```"

where info_string is:
  language [ ws "prompt" ]

Note: A language tag is required — bare code fences (no info string) are invalid. `prompt` alone (without a language prefix) is valid for text-only prompts, e.g., ` ```prompt `. Non-executable language tags (e.g., `json`, `yaml`) are treated as prompt blocks.

where runbooks is:
  - runbook_path [ ... ]

Step-level `runbooks` syntax is shorthand for implicit sequential substeps (`### N.1`, `### N.2`, ...), one workflow path per generated substep.
If prompt text appears before a step-level `runbooks` shorthand body, it is attached to the first generated implicit substep only.

where transition is:
  - { PASS | FAIL | YES | NO } [ { ALL | ANY } ]: result
  | - DEFER                         -- shorthand for PASS: DEFER + FAIL: DEFER

Transitions must appear as list items with the `-` bullet prefix (a dash followed by a space). Paragraph-style transitions (without prefix) are not valid.

Aggregation always waits for all DEFER'd results before evaluating. `ALL`/`ANY` evaluates over the count of DEFER'd results.

where result is:
  action | RETRY [ count ] [ action ]

where action is:
  CONTINUE | DEFER | COMPLETE [ message ] | STOP [ message ] | GOTO target | NEXT | BREAK

Context constraints:
- `DEFER` is only valid inside substeps or FOR iteration-level nested transitions
- `NEXT` is only valid inside substeps of a FOR step and FOR iteration-level transitions
- `BREAK` is valid inside substeps of a FOR step and FOR-level nested transitions
- FOR-level nested transitions (nested bullets under `- FOR ...`) only allow terminal actions: `CONTINUE` (exit loop), `DEFER`, `NEXT` (loop back without accumulation), `BREAK`, `GOTO`, `STOP`, `COMPLETE` (optionally wrapped in `RETRY`)

where message is:
  name | "\"" text "\""

where target is:
  step-identifier [ "AT" index ]
  | substep-identifier [ "AT" index ]

where index is:
  positive_integer | "{{" [ ws ] variable_name [ ws ] "}}"

where for_clause is:
  "- FOR" [ variable_name "IN" ] range
  | "- FOR" variable_name "IN" source_ref
  | "- FOR" variable_name "IN" positive_integer "TO" positive_integer "OF" source_ref

where source_ref is:
  "{{" [ ws ] variable_name [ ws ] "}}"    -- references a named data source

where range is:
  positive_integer                              -- implicit start (1), end is positive_integer
  | positive_integer "TO" positive_integer      -- explicit start and end
  | positive_integer "TO" "{{" [ ws ] variable_name [ ws ] "}}"  -- variable end bound
  | "{{" [ ws ] variable_name [ ws ] "}}" "TO" positive_integer  -- variable start bound
  | "{{" [ ws ] variable_name [ ws ] "}}" "TO" "{{" [ ws ] variable_name [ ws ] "}}"  -- variable both bounds
  | "{{" [ ws ] variable_name [ ws ] "}}"            -- count-only with template variable

Whitespace inside `{{ }}` delimiters is optional.

Note: Template variable bounds (e.g., `{{count}}`) are expanded to literal positive integers before the FOR clause is parsed (two-phase model: Handlebars expansion first, then parser processes the result). Source references in `FOR var IN {{ source }}` and `... OF {{ source }}` are NOT expanded — they are parsed as data source identifiers resolved at runtime.

When a template-variable bound cannot be resolved (undefined variable), the FOR clause line is preserved as literal prompt text rather than producing a parse error. This enables orchestrating agents to handle unresolved bounds.

where variable_name is:
  `[a-zA-Z_][a-zA-Z0-9_]*`

where frontmatter is:
  "---"
    [ "name:" slug ]
    [ "description:" text ]
    [ "version:" text ]
    [ "author:" text ]
    [ "tags:" tag_list ]
    [ "vars:" vars_map ]
  "---"

Additional fields beyond those listed are preserved in the parsed frontmatter (open schema). This allows forward-compatible extensions and user-defined metadata.

Note: The frontmatter `description` field is used for runbook discovery and listing (e.g., `rd ls --all`). The Runbook's structural `description` in the parsed AST is derived from preamble text between the H1 title and first H2 step. These are independent values.

where slug is:
  [a-zA-Z0-9_-]+
  (alphanumeric with underscores and hyphens)

where tag_list is:
  "- " tag { "- " tag }

where tag is:
  text
  (any string - convention is lowercase alphanumeric with hyphens)

where vars_map is:
  variable_name ":" value { variable_name ":" value }
  (YAML mapping of variable names to string, number, or boolean values)

Note: Frontmatter `vars` are not included in the parsed Runbook AST. They are consumed by the CLI template rendering pipeline.

---

## FOR Clause

The FOR clause is a step-level annotation that makes a step iterate its substeps. It appears as a bullet point before transitions.

**Syntax variants:**

| Form | Example | Description |
|------|---------|-------------|
| Named variable, ascending range | `- FOR batch IN 1 TO 10` | Iterates 1..10, `{{batch}}` available |
| No variable, ascending range | `- FOR 1 TO 10` | Iterates 1..10, no named variable |
| Named variable, descending range | `- FOR batch IN 10 TO 1` | Iterates 10..1, `{{batch}}` available |
| No variable, descending range | `- FOR 10 TO 1` | Iterates 10..1, no named variable |
| Named variable, implicit start | `- FOR batch IN 10` | Iterates 1..10, `{{batch}}` available |
| No variable, implicit start | `- FOR 10` | Iterates 1..10, no named variable |
| Variable bounds | `- FOR batch IN 1 TO {{Max}}` | End bound from template variable |
| Named variable, source (all items) | `- FOR item IN {{ items }}` | Iterates all items from data source, `{{item}}` available |
| Named variable, windowed source | `- FOR item IN 3 TO 7 OF {{ items }}` | Items 3–7 from data source, `{{item}}` available |

**Direction inference:** When `start > end`, the loop iterates downward (step size −1). When `start <= end`, it iterates upward (step size +1). Single-number shorthand (`FOR N`) always ascends from 1.

**Data source binding:** When a FOR clause references a data source, the named variable receives the data element at each iteration — not the iteration index. `{{Index}}` always holds the 1-based iteration number. A named variable is required for data source FOR clauses. Data sources are defined via `.rundown/config.yaml` or `--var-file`. See [RUNDOWN.md](./RUNDOWN.md#data-sources) for configuration details.

**Rules:**
- FOR must appear before transitions in the step's bullet list
- `NEXT` is only valid inside substeps of a FOR step and FOR iteration-level transitions
- `BREAK` is valid within substeps and FOR-level nested transitions
- `AT` is only valid when the GOTO target is a FOR step (cross-step allowed, but the target must be FOR and have substeps)
- Step-level runbook lists satisfy the FOR-substep requirement via implicit sequential substeps
- Parent FOR step transitions aggregate across iterations using ALL/ANY modifiers
- FOR-level nested transitions execute at iteration scope; RETRY evaluates before the exhausted action
- Iteration-level `BREAK` includes the current iteration result in parent aggregation; iteration-level `GOTO`/`STOP`/`COMPLETE` bypass parent aggregation
- Nested bullets under `FOR` must be transition bullets; non-transition nested bullets are invalid

### Execution Path Notation

Runtime execution paths are often displayed as `STEP.INDEX.SUBSTEP` (for example `1.2.1`). This is display-only notation and not authoring syntax.

Canonical runtime targeting is `step + substep + iteration`.

---

## Built-In Variables

| Variable | Value | Available |
|----------|-------|-----------|
| `{{Step}}` | Qualified step identifier (e.g., `3`, `3.1`, `ErrorHandler`; shorthand runbook-list steps execute as `N.1`, `N.2`, ...) | Always |
| `{{Index}}` | Current loop iteration number (1-based) | Inside FOR steps |
| `{{step}}` | Lowercase alias for current step identifier | Always |
| `{{index}}` | Lowercase alias for current loop iteration number | Inside FOR steps |
| `{{context.current.*}}` | Canonical current runbook context (`step`, `substep`, `index`, `at`) | Always |
| `{{context.parent.*}}` | Parent runbook context (`step`, `substep`, `index`, `at`, `vars.*`) | Nested runbooks |
| `{{context.ancestors.N.*}}` | Ancestor runbook contexts (`0` = nearest parent; includes `vars.*`) | Nested runbooks |
| `{{context.vars.NAME}}` | User/config/frontmatter variables under canonical namespace | Always |

`{{Step}}`/`{{Index}}` and lowercase aliases are expanded per-step/per-iteration. For data source loops, the named variable holds the data element while `{{Index}}`/`{{index}}` holds the iteration number. Runtime keys `step`, `index`, and `context` are reserved (matching is case-insensitive) and cannot be overridden by user variables.

---

## Template Variables

| Pattern             | Variable  | Expansion                               |
|---------------------|-----------|-----------------------------------------|
| `{{VariableName}}`  | defined   | literal variable value                  |
| `{{VariableName}}`  | undefined | preserved as literal `{{VariableName}}` (warning emitted to stderr) |
| `{{path.to.value}}` | missing path | preserved as literal `{{path.to.value}}` (warning emitted to stderr) |


 VariableName: `/^[a-zA-Z_][a-zA-Z0-9_]*$/`

---

## Expansion Rules

### Transition Aliases

| Input | Expands To |
|-------|------------|
| `YES X` | `PASS X` |
| `NO X` | `FAIL X` |

### Modifier Defaults

| Input | Expands To |
|-------|------------|
| `PASS: X` | `PASS ALL: X` |
| `FAIL: X` | `FAIL ANY: X` |

### RETRY Defaults

| Input | Expands To |
|-------|------------|
| `RETRY`          | `RETRY 1 STOP` |
| `RETRY n`        | `RETRY n STOP` |
| `RETRY n action` | `RETRY n action` |

The fallback action cannot be RETRY (nested RETRY is invalid).

### GOTO AT Defaults

| Input | Expands To |
|-------|------------|
| `GOTO N` (FOR step) | `GOTO N AT <start>` (loop's start value) |
| `GOTO N AT I` (FOR step) | `GOTO N AT I` |

### Implicit Transitions

| Condition         | Expands To |
|-------------------|------------|
| None defined      | `PASS ALL: CONTINUE` + `FAIL ANY: STOP` |
| Only PASS defined | Adds `FAIL ANY: STOP` |
| Only FAIL defined | Adds `PASS ALL: CONTINUE` |

**Convention:** Always write both transitions explicitly. The parser supports implicit defaults, but runbooks should be readable without memorizing the default table.

### Message Convention

STOP and COMPLETE accept optional messages. Include a message only when it provides context beyond what the step title already communicates — such as actionable guidance or diagnostic hints. Omit when the step title makes the outcome self-evident.

### Code Block Semantics

| Info String | Behavior |
|------------------------|----------|
| `bash`, `sh`, `shell`  | Execute; exit 0=PASS, non-zero=FAIL |
| `{language} prompt`    | Output only  |
| other (e.g., `json`, `yaml`) | Output only (treated as prompt) |
| *(none)*               | Invalid — bare code fences are rejected |

Code block info string tags are matched case-insensitively. `BASH`, `Bash`, and `bash` are all treated as executable.

---

## Formatting Notes

Runbook files follow standard markdown formatting conventions:

- **Blank lines around headings** (MD022) — headings should be surrounded by blank lines
- **Blank lines around lists** (MD032) — transition bullet lists should be surrounded by blank lines
- **Blank lines around fenced code blocks** (MD031) — code blocks should be surrounded by blank lines
- **No multiple consecutive blank lines** (MD012)

These rules are enforced by markdownlint. See `.markdownlint-cli2.yaml` for configuration.

Note: All frontmatter fields (`name`, `description`, `version`, `author`, `tags`, `vars`) are optional per the schema. Preamble text between the H1 title and first H2 step is also optional.
