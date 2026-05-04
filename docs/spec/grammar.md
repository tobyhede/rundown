# Rundown Grammar

W3C EBNF grammar for Rundown runbook syntax.
See [docs/spec/language.md](language.md) for execution semantics.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Notation

| Symbol | Meaning |
|--------|---------|
| `::=` | Production rule |
| `\|` | Alternative |
| `?` | Optional (zero or one) |
| `*` | Zero or more |
| `+` | One or more |
| `( )` | Grouping |
| `" "` | Literal string |
| `[ ]` | Character class |

`ws` is formally defined as space or tab (see the `ws` production). In practice the parser is more lenient: most positions — including the `separator` production — accept any Unicode whitespace (`\s`). FOR clause keyword and variable positions are an exception and strictly accept only space and tab, matching the formal `ws` definition (ReDoS guard). `newline` denotes a line break. Keywords are case-sensitive unless noted.

---

## Document Structure

```ebnf
runbook  ::= frontmatter? title? preamble? step+
title    ::= "# " text newline
preamble ::= text+
```

Heading levels 4 and deeper are not allowed in runbooks.

## Frontmatter

```ebnf
frontmatter ::= "---" newline yaml_block "---" newline
```

Known fields:

```ebnf
name_field     ::= "name:" ws name_string
desc_field     ::= "description:" ws text
version_field  ::= "version:" ws text
author_field   ::= "author:" ws text
tags_field     ::= "tags:" newline tag_list
inputs_fm_field ::= "inputs:" newline input_list
                  | "inputs:" ws inline_sequence
required_field  ::= "required:" newline required_list
                  | "required:" ws inline_sequence
outputs_fm_field ::= "outputs:" newline output_fm_list

name_string    ::= [a-zA-Z0-9_-] ( [a-zA-Z0-9_ -]* [a-zA-Z0-9_-] )?
tag_list       ::= ( ws "- " tag newline )+
tag            ::= text
input_list     ::= ( ws "- " variable_name newline )+
required_list  ::= ( ws "- " variable_name newline )+
inline_sequence ::= "[" variable_name ( "," variable_name )* "]"
output_fm_list ::= ( ws "- " quoted_output_entry newline
                   | ws "- " output_entry newline )+
```

Public frontmatter keys are case-insensitive (`inputs:`, `INPUTS:`, and `Inputs:` are equivalent); unknown keys are preserved with their original casing. All fields are optional.

`inputs:` declares variable names only. Runtime values come from CLI flags, config, environment bridge variables, or delegation inheritance. Each name must match `variable_name` and must not be [reserved](#reserved-variable-names). `required:` entries must also be declared in `inputs:`. Both block YAML sequences and inline YAML sequences such as `inputs: [PlanPath]` are valid.

`outputs:` uses the same entry grammar as [OUTPUTS directives](#context-directives). Quote entries that contain template expressions in YAML:

```yaml
outputs:
  - Result
  - 'PlanPath {{ path "plan.json" }}'
```

## Steps

```ebnf
step ::= "## " step_id separator? text? newline
         outputs_directive?
         for_clause?
         delegate_annotation?
         transition*
         prompt?
         body?
```

Content must appear in the order shown: OUTPUTS, FOR, DELEGATE, transitions, prompt, body.

## Substeps

```ebnf
substep ::= "### " substep_id separator? text? newline
            outputs_directive?
            delegate_annotation?
            transition*
            prompt?
            ( code_block | runbook_list )?
```

Substeps cannot contain nested substeps. See [docs/spec/language.md §1.1](language.md) for the heading hierarchy rules.

## Context Directives

```ebnf
outputs_directive ::= "- OUTPUTS" newline output_list
output_list       ::= ( ws "- " output_entry newline )+
output_entry      ::= variable_name ( ws output_value )?
quoted_output_entry ::= quoted_string
output_value      ::= helper_call | template_variable | quoted_string | variable_name
helper_call       ::= "{{" ws? variable_name ( ws helper_argument )+ ws? "}}"
helper_argument   ::= quoted_string | variable_path | keyed_argument
keyed_argument    ::= variable_name "=" ( quoted_string | variable_path | ctx_ref )
```

A step or substep may declare at most one OUTPUTS directive. Duplicate directives on the same target are rejected. The `- INPUTS` directive has been removed — use the frontmatter `inputs:` field to declare variable names.

OUTPUTS declares values to inject into the runbook's live variable space
after step completion. An entry may be a **naked declaration** (name only)
or carry a value expression. Naked entries at step / substep level activate
a file-backed channel: Rundown creates an empty file whose path is composed
from the active scope tiers (step id, optional substep id, optional FOR
iteration index) followed by `<VarName>` and exports its absolute path as
`RD_OUTPUTS_<VarName>` to the spawned command. The three possible paths are:

| Scope | Path |
|---|---|
| Step | `.rundown/runs/<runId>/outputs/<stepId>/<VarName>` |
| Substep | `.rundown/runs/<runId>/outputs/<stepId>/<substepId>/<VarName>` |
| FOR iteration (in substep) | `.rundown/runs/<runId>/outputs/<stepId>/<substepId>/<iteration>/<VarName>` |

See [docs/spec/language.md §7.1](language.md#71-outputs). Expression-form output values
may be Handlebars helper calls (`{{ path "file.json" }}`), template variable
references (`{{ VarName }}`), quoted literals (`"value"`), or bare variable
references (`VarName`).

Variable names in OUTPUTS must match `variable_name` and must not be [reserved variable names](#reserved-variable-names).

The `path` helper call `{{ path "file.json" }}` is syntactic sugar for the CLI form `rdpath --dir WorkPath --ctx ContextId --file file.json`. The optional `ctx=` argument (`{{ path "file.json" ctx=alt-ctx }}`) overrides the default `ContextId`. Filenames must match the [`filename`](#lexical-rules) production; context identifiers must match [`ctx_ref`](#lexical-rules). See [docs/reference/rdpath.md](../reference/rdpath.md) for the full path-assembly contract.

## Identifiers

```ebnf
step_id      ::= positive_integer | named_id
substep_id   ::= positive_integer | named_id | qualified_id
named_id     ::= [A-Za-z_] [A-Za-z0-9_]*
qualified_id ::= step_ref "." ( positive_integer | named_id )
step_ref     ::= positive_integer | named_id
```

`named_id` must not be a [reserved word](#reserved-words). Reserved word matching is case-sensitive.

## Separators

```ebnf
separator ::= ( "." | ":" | "\u2014" | "\u2192" | "-" | ")" | ws )+
```

Unicode escapes: `\u2014` is em dash (—), `\u2192` is right arrow (→).

Separators are matched greedily — the longest sequence of separator characters between identifier and description text is consumed. The parser accepts any Unicode whitespace in separator positions (space, tab, etc.).

**Note:** The full separator set (`.` `:` `—` `→` `-` `)` plus whitespace) is applied in two places during header parsing: trailing separator characters are stripped from the extracted step-identifier token, and leading separators are stripped from the remainder before it becomes the description. This makes headers like `## 1.`, `## 1. Foo`, `## Rollback)`, and `## Rollback — clean up` all valid with the same set of punctuation.

## FOR Clauses

```ebnf
for_clause  ::= "- FOR" ws for_variant newline
                nested_transition*

for_variant ::= variable_name ws "IN" ws range_value ws "TO" ws range_value ws "OF" ws source_ref
              | variable_name ws "IN" ws source_ref
              | variable_name ws "IN" ws range
              | range

range_value ::= positive_integer | bound_ref
range       ::= range_value ( ws "TO" ws range_value )?
source_ref  ::= "{{" ws? variable_name ws? "}}"

nested_transition ::= ws "- " result_keyword ( ws aggregation )? ws action newline
                    | ws "- " result_keyword ( ws aggregation )? ws "RETRY" ws positive_integer ws action newline
                    | ws "- DEFER" newline
```

Template variables (`{{var}}`) may appear in range bound positions via `bound_ref`. Source references (`{{ source }}`) in `FOR var IN {{ source }}` and `... OF {{ source }}` are data source identifiers.

A step may contain at most one FOR clause. The FOR clause must appear before transitions and content. A single-count range (`FOR batch IN 5`) is shorthand for `1 TO 5`.

**Examples:**

```markdown
- FOR batch IN 1 TO 10
- FOR 5
- FOR item IN {{ tasks }}
- FOR item IN 3 TO 7 OF {{ items }}
```

## DELEGATE Annotation

```ebnf
delegate_annotation ::= "- DELEGATE" newline
```

`DELEGATE` is bare — it takes no arguments. On an H2 step it propagates to every H3 substep; on an H3 substep or runbook-list entry it applies only to that target. DELEGATE precedes transitions within the step's or substep's bullet block; when a FOR clause is present, FOR precedes DELEGATE. A DELEGATE substep must resolve to a runbook reference. See [docs/spec/language.md §4.3](language.md#43-delegate) for execution semantics.

## Transitions

```ebnf
transition     ::= "- " result_keyword ( ws aggregation )? ws action newline
                 | "- " result_keyword ( ws aggregation )? ws "RETRY" ws positive_integer ws action newline
                 | "- DEFER" newline

result_keyword ::= "PASS" | "FAIL" | "YES" | "NO"
aggregation    ::= "ALL" | "ANY"
```

`YES` is a syntactic alias for `PASS`. `NO` is a syntactic alias for `FAIL`. Transitions must use `-` bullet prefix. Transition keywords are matched as whole words — the keyword must be followed by whitespace.

Standalone `DEFER` expands to two transitions: `PASS DEFER` + `FAIL DEFER`.

Aggregation modifiers must pair complementarily: `PASS ALL` + `FAIL ANY` (pessimistic) or `PASS ANY` + `FAIL ALL` (optimistic). One-sided or same-side combinations are rejected.

**Default transitions:** When no transitions are authored, the parser supplies `PASS CONTINUE`, `FAIL STOP`. Substeps under aggregation or with runbook delegation default to `PASS DEFER`, `FAIL DEFER`.

**Disambiguation:** A `-`-prefixed bullet inside a step is resolved by priority: (1) context directive (`- OUTPUTS` as exact, case-sensitive list-item text with no trailing content), (2) FOR clause (`FOR` keyword), (3) DELEGATE annotation (`- DELEGATE` as exact, case-sensitive list-item text with no trailing content), (4) transition (`PASS`, `FAIL`, `YES`, `NO`, or standalone `DEFER`), (5) runbook reference (`.runbook.md` suffix), (6) prompt text. A bullet whose text merely contains `OUTPUTS` or `DELEGATE` inside prose, or uses a different case (e.g., `Outputs`, `delegate`), falls through to normal list semantics.

## Actions

```ebnf
action ::= "CONTINUE"
         | "DEFER"
         | "NEXT"
         | "BREAK"
         | "COMPLETE" ( ws message )?
         | "STOP" ( ws message )?
         | "GOTO" ws target
```

Reserved words cannot appear as bare messages. Use quoted form for reserved-word messages (e.g., `RETRY 3 STOP "COMPLETE"`). When RETRY is used, both count and fallback action are required. RETRY fallback action cannot be RETRY.

Context constraints:

| Action | Valid in |
|--------|---------|
| `DEFER` | Substeps, FOR nested transitions |
| `NEXT` | FOR substeps, FOR nested transitions |
| `BREAK` | FOR substeps, FOR nested transitions |

Note: `- DEFER` on its own line is a shorthand transition equivalent to `PASS DEFER` + `FAIL DEFER` (see [Transitions](#transitions)). The `DEFER` action listed here is the target of that shorthand and of explicit `PASS DEFER` / `FAIL DEFER` transitions.

FOR nested transitions allow: `CONTINUE`, `DEFER`, `NEXT`, `BREAK`, `GOTO`, `STOP`, `COMPLETE` (with optional `RETRY` wrapper).

## Targets

```ebnf
target ::= ( step_id | substep_id ) ( ws "AT" ws index )?
index  ::= positive_integer | bound_ref
```

`NEXT` is not a valid GOTO target.

## Messages

```ebnf
message       ::= bare_message | quoted_string
bare_message  ::= named_id    /* must not be a reserved word */
quoted_string ::= '"' text '"'
```

`bare_message` must not be a [reserved word](#reserved-words). To use a reserved word as a message, use the quoted form: `PASS STOP "COMPLETE"`, not `PASS STOP COMPLETE`.

## Code Blocks

```ebnf
code_block ::= backtick_fence info_string newline content backtick_fence newline

info_string ::= executable_lang ( ws "prompt" )?
              | display_lang ( ws "prompt" )?
              | "prompt"

executable_lang ::= "bash" | "sh" | "shell"
display_lang    ::= language_tag | non_ws_text
```

Opening fence is 3 or more backticks. Closing fence must use at least as many backticks as the opening fence (CommonMark §4.5). Language tag is required — bare code fences are invalid. Tags are matched case-insensitively. Non-executable tags (e.g., `json`, `yaml`) are display-only. When `prompt` follows an executable language tag (e.g., `bash prompt`), the block is demoted to display-only — it is not executed. The `prompt` suffix on non-executable tags is accepted but redundant — all non-executable code blocks are prompt blocks. The parser does not validate the format of non-executable language tags against the `language_tag` production — any tag that is not an executable tag is treated as display-only.

## Template Variables

```ebnf
template_variable ::= "{{" ws? variable_path ws? "}}"
bound_ref         ::= "{{" ws? variable_name ws? "}}"
variable_path     ::= variable_name ( "." ( variable_name | digit+ ) )*
variable_name     ::= [a-zA-Z_] [a-zA-Z0-9_]*
```

Template variables with dotted paths (`{{item.name}}`) are resolved at runtime. Parse-time positions (FOR bounds, GOTO AT index) accept only simple variable names via `bound_ref`. The parser accepts any Unicode whitespace (not just space/tab) inside `{{ }}` markers.

## Runbook Lists

```ebnf
runbook_list  ::= ( "- " runbook_entry newline nested_delegate? )+
runbook_entry ::= runbook_path | runbook_ref
runbook_path  ::= non_ws_char+ ".runbook.md"
runbook_ref   ::= "{{" ws? variable_path ws? "}}"

nested_delegate ::= ws "- DELEGATE" newline
```

Step-level runbook lists are shorthand for implicit sequential substeps. Entries may be literal paths or template variable references (`runbook_ref`), which are resolved to concrete paths during the variable resolution phase. Entries may carry a nested `- DELEGATE` bullet to mark that entry for delegation — see [DELEGATE Annotation](#delegate-annotation). See [Transitions](#transitions) for bullet disambiguation priority.

## Body

```ebnf
body ::= code_block | substep+ | runbook_list
```

A step contains at most one body type.

## Prompt

```ebnf
prompt ::= text+
```

Free-form text between transitions and body.

## Reserved Words

`ALL`, `ANY`, `AT`, `BREAK`, `COMPLETE`, `CONTINUE`, `DEFER`, `DELEGATE`, `FAIL`, `FOR`, `GOTO`, `IN`, `NEXT`, `NO`, `PASS`, `RETRY`, `STOP`, `TO`, `YES`

Case-sensitive: `NEXT` is reserved; `Next` and `NextStep` are valid. `OF` is a contextual keyword in `FOR...OF...` syntax but not a reserved word.

These reserved words apply to step identifiers, action keywords, and transition keywords. The [reserved variable names](#reserved-variable-names) list is distinct and governs variable identifiers.

## Reserved Variable Names

The following names are reserved for runtime context resolution and cannot be used as variable identifiers in `OUTPUTS`, frontmatter `inputs:` / `required:`, `--input` CLI flags, `--input-file` contents, `.rundown/config.yaml`, or `RD_INPUT_*` environment variables:

- `step`
- `index`
- `context`

Matching is **case-insensitive**: `step`, `Step`, `STEP`, `CONTEXT`, `INDEX` are all reserved. These names are owned by runtime context resolution (`{{step}}`, `{{index}}`, `{{context.*}}`) and cannot be shadowed by user values.

## Lexical Rules

```ebnf
positive_integer ::= [1-9] [0-9]*
digit            ::= [0-9]
text             ::= [^\n]+
non_ws_char      ::= [^ \t\n]
non_ws_text      ::= [^ \t\n\r]+
language_tag     ::= [a-zA-Z] [a-zA-Z0-9]*
filename         ::= [A-Za-z0-9._-]+   /* rejected at runtime: "." and ".." */
ctx_ref          ::= [A-Za-z0-9_-]+    /* must not be "." or ".." */
ws               ::= ( " " | "\t" )+
newline          ::= "\n"
yaml_block       ::= (* opaque YAML content *)
backtick_fence   ::= "```" "`"*    /* 3 or more; closing fence >= opening count */
content          ::= (* opaque code block content *)
```

Upper bounds: step identifiers are capped at 999,999; FOR loop bounds at 10,000.

`filename` and `ctx_ref` source from `VALID_FILE` and `VALID_CTX` in `packages/core/src/runbook/artifact-paths.ts`. They constrain the arguments of the [`path`](#context-directives) helper used in OUTPUTS and the underlying `rdpath` CLI.
