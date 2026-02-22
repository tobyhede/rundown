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
| `ws` | Horizontal whitespace (space or tab) |

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
  "###" substep_id title
    [ transition ... ]
    [ prompt ]
    [{ code_block  | runbooks }]

where substep_id is:
  positive_integer                              -- short form (parent prefix omitted)
  | parent_ref "." { positive_integer | name }  -- qualified form

where parent_ref is:
  positive_integer    -- for static parent
  | name              -- for named parent

where step-identifier is:
  positive_integer | name

where substep-identifier is:
  step-identifier "." ( positive_integer | name )

where name is:
  [A-Za-z_][A-Za-z0-9_]*
  (case-sensitive; must not be a reserved word: NEXT, CONTINUE, COMPLETE, STOP, GOTO, RETRY, PASS, FAIL, YES, NO, ALL, ANY, BREAK, FOR, IN, TO, AT)

where code_block is:
  "```" [ info_string ]
    content
  "```"

where info_string is:
  [ language ] [ " " "prompt" ]

Note: `prompt` alone (without a language) is valid for text-only prompts, e.g., ` ```prompt `.

where runbooks is:
  - runbook_path [ ... ]

where transition is:
  - { PASS | FAIL | YES | NO } [ { ALL | ANY } ]: result

Transitions must appear as list items with the `-` bullet prefix (a dash followed by a space). Paragraph-style transitions (without prefix) are not valid.

where result is:
  action | RETRY [ count ] [ action ]

where action is:
  CONTINUE | COMPLETE [ message ] | STOP [ message ] | GOTO target | NEXT | BREAK | RETRY ...

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
  positive_integer                              -- implicit start (1), end is integer
  | positive_integer "TO" positive_integer      -- explicit start and end
  | positive_integer "TO" "{{" [ ws ] variable_name [ ws ] "}}"  -- variable end bound
  | "{{" [ ws ] variable_name [ ws ] "}}" "TO" positive_integer  -- variable start bound
  | "{{" [ ws ] variable_name [ ws ] "}}" "TO" "{{" [ ws ] variable_name [ ws ] "}}"  -- variable both bounds
  | "{{" [ ws ] variable_name [ ws ] "}}"            -- count-only with template variable

Whitespace inside `{{ }}` delimiters is optional.

Note: Template variable bounds (e.g., `{{count}}`) are expanded to literal positive integers before the FOR clause is parsed (two-phase model: Handlebars expansion first, then parser processes the result). Source references in `FOR var IN {{ source }}` and `... OF {{ source }}` are NOT expanded — they are parsed as data source identifiers resolved at runtime.

where variable_name is:
  [a-zA-Z_][a-zA-Z0-9_]*

where frontmatter is:
  "---"
    [ "name:" slug ]
    [ "description:" text ]
    [ "version:" text ]
    [ "author:" text ]
    [ "tags:" tag_list ]
    [ "vars:" vars_map ]
    [ scenarios ]
  "---"

Additional fields beyond those listed are preserved in the parsed frontmatter (open schema). This allows forward-compatible extensions and user-defined metadata.

where slug is:
  [a-z0-9-]+
  (lowercase alphanumeric with hyphens)

where tag_list is:
  "- " tag { "- " tag }

where tag is:
  text
  (any string - convention is lowercase alphanumeric with hyphens)

where vars_map is:
  variable_name ":" value { variable_name ":" value }
  (YAML mapping of variable names to string, number, or boolean values)

where scenarios is:
  "scenarios:"
    scenario { scenario }

where scenario is:
  slug ":"
    [ "description:" text ]
    "commands:"
      "- " text { "- " text }
    "result:" ( "COMPLETE" | "STOP" )

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
- `NEXT` and `BREAK` actions are only valid within substeps of a FOR step
- `AT` is only valid when the GOTO target is a FOR step (cross-step allowed, but the target must be FOR and have substeps)
- Parent FOR step transitions aggregate across iterations using ALL/ANY modifiers

---

## Built-In Variables

| Variable | Value | Available |
|----------|-------|-----------|
| `{{Step}}` | Qualified step identifier (e.g., `3`, `3.1`, `ErrorHandler`) | Always |
| `{{Index}}` | Current loop iteration number (1-based) | Inside FOR steps |

These use PascalCase, consistent with other built-in variables (Date, WorkPath). `{{Step}}` is expanded per-step. The loop variable (if named) and `{{Index}}` are expanded per-iteration. For data source loops, the named variable holds the data element while `{{Index}}` holds the iteration number.

---

## Template Variables

| Pattern             | Variable  | Expansion                               |
|---------------------|-----------|-----------------------------------------|
| `{{VariableName}}`  | defined   | literal variable value                  |
| `{{VariableName}}`  | undefined | preserved as literal `{{VariableName}}` |


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

### GOTO AT Defaults

| Input | Expands To |
|-------|------------|
| `GOTO N` (FOR step) | `GOTO N AT 1` |
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
| other / none           | Output only  |

Code block info string tags are matched case-insensitively. `BASH`, `Bash`, and `bash` are all treated as executable.
