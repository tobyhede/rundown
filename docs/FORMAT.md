---
version: 1.0.0
---

# Rundown Format

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

---

## Expansion Rules

Syntactic sugar is expanded before execution:

```
-- Transition aliases
YES X  =>  PASS X
NO X   =>  FAIL X

-- Modifier defaults
PASS: X  =>  PASS ALL: X
FAIL: X  =>  FAIL ANY: X

-- RETRY defaults
RETRY          =>  RETRY 1 STOP
RETRY n        =>  RETRY n STOP
RETRY n action =>  RETRY n action

-- Implicit transitions (when none defined)
<none>  =>  - PASS ALL: CONTINUE
            - FAIL ANY: STOP

-- Partial transition defaults
When only PASS defined  =>  FAIL defaults to FAIL ANY: STOP
When only FAIL defined  =>  PASS defaults to PASS ALL: CONTINUE

-- Code block semantics
```bash | sh | shell            =>  Command (Executable)
```{language} prompt            =>  Command (rd prompt '...' - outputs content in fences)
```{other language or no lang}  =>  Command (rd prompt '...' - outputs content in fences)
