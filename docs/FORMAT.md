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

{ static_steps | dynamic_step }

where static_steps is:
  static_step [ static_step ... ]

where static_step is:
  "##" integer [ separator ] title
    [ transition ... ]
    [ prompt ]
    {{ code_block | substeps | runbooks }}

where dynamic_step is:
  "##" "{N}" [ separator ] title
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
  parent_ref "." { integer | "{n}" }

where parent_ref is:
  integer    -- for static parent
  | "{N}"    -- for dynamic parent
  | name     -- for named parent

where step-identifier is:
  integer | "{N}" | name

where substep-identifier is:
  step-identifier "." ( integer | "{n}" | name )

where name is:
  [A-Za-z_][A-Za-z0-9_]*
  (case-sensitive; must not be a reserved word: NEXT, CONTINUE, COMPLETE, STOP, GOTO, RETRY, PASS, FAIL, YES, NO, ALL, ANY)

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
  CONTINUE | COMPLETE [ message ] | STOP [ message ] | GOTO target | RETRY ...

where message is:
  name | "\"" text "\""

where target is:
  step-identifier | substep-identifier | "NEXT" | "NEXT" step-identifier | "NEXT" substep-identifier

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

## Template Variables

| Pattern             | Variable  | Expansion                               |
|---------------------|-----------|-----------------------------------------|
| `{{VariableName}}`  | defined   | literal variable value                  |
| `{{VariableName}}`  | undefined | preserved as literal `{{VariableName}}` |


VariableName: `/^[a-zA-Z_][a-zA-Z0-9_]*$/`

Note: `{{VariableName}}` (template) vs `{N}`, `{n}` (dynamic identifiers) use different brace counts.

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

### Implicit Transitions

| Condition         | Expands To |
|-------------------|------------|
| None defined      | `PASS ALL: CONTINUE` + `FAIL ANY: STOP` |
| Only PASS defined | Adds `FAIL ANY: STOP` |
| Only FAIL defined | Adds `PASS ALL: CONTINUE` |

### Code Block Semantics

| Info String | Behavior |
|------------------------|----------|
| `bash`, `sh`, `shell`  | Execute; exit 0=PASS, non-zero=FAIL |
| `{language} prompt`    | Output only  |
| other / none           | Output only  |
