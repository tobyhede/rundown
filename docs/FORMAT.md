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
  integer                              -- short form (parent prefix omitted)
  | parent_ref "." { integer | name }  -- qualified form

where parent_ref is:
  integer    -- for static parent
  | name     -- for named parent

where step-identifier is:
  integer | name

where substep-identifier is:
  step-identifier "." ( integer | name )

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
  integer | "{{" variable_name "}}"

where for_clause is:
  "- FOR" [ variable_name "IN" ] range

where range is:
  integer                              -- implicit start (1), end is integer
  | integer "TO" integer               -- explicit start and end
  | integer "TO" "{{" variable_name "}}"  -- variable end bound
  | "{{" variable_name "}}" "TO" integer  -- variable start bound
  | "{{" variable_name "}}" "TO" "{{" variable_name "}}"  -- variable both bounds
  | "{{" variable_name "}}"            -- count-only with template variable

where variable_name is:
  [a-zA-Z_][a-zA-Z0-9_]*

where frontmatter is:
  "---"
    "name:" slug
    [ "description:" text ]
    [ "version:" text ]
    [ "author:" text ]
    [ "tags:" tag_list ]
    [ scenarios ]
  "---"

where slug is:
  [a-z0-9-]+
  (lowercase alphanumeric with hyphens)

where tag_list is:
  "- " tag { "- " tag }

where tag is:
  text
  (any string - convention is lowercase alphanumeric with hyphens)

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
| Named variable, explicit range | `- FOR batch IN 1 TO 10` | Iterates 1..10, `{{batch}}` available |
| No variable, explicit range | `- FOR 1 TO 10` | Iterates 1..10, no named variable |
| Named variable, implicit start | `- FOR batch IN 10` | Iterates 1..10, `{{batch}}` available |
| No variable, implicit start | `- FOR 10` | Iterates 1..10, no named variable |
| Variable bounds | `- FOR batch IN 1 TO {{Max}}` | End bound from template variable |

**Rules:**
- FOR must appear before transitions in the step's bullet list
- `NEXT` and `BREAK` actions are only valid within substeps of a FOR step
- `AT` is only valid when the GOTO target is a FOR step (cross-step allowed, but the target must be FOR and have substeps)
- Parent FOR step transitions aggregate across iterations using ALL/ANY modifiers

---

## Built-In Variables

| Variable | Value | Available |
|----------|-------|-----------|
| `{{Step}}` | Full step identifier (`3`, `3.1`, `ErrorHandler`) | Always |
| `{{Index}}` | Current loop iteration number (1-based) | Inside FOR steps |

These use PascalCase, consistent with other built-in variables (Date, WorkPath). The loop variable (if named) and `{{Index}}` are expanded per-iteration.

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
