# Rundown Grammar

W3C EBNF grammar for Rundown runbook syntax.
See [SPEC.md](./SPEC.md) for execution semantics.

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

`ws` denotes required whitespace (space or tab). `newline` denotes a line break. Keywords are case-sensitive unless noted.

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
vars_field     ::= "vars:" newline vars_map
required_field ::= "required:" newline required_list

name_string    ::= [a-zA-Z0-9_-] ( [a-zA-Z0-9_ -]* [a-zA-Z0-9_-] )?
tag_list       ::= ( ws "- " tag newline )+
tag            ::= text
vars_map       ::= ( ws variable_name ":" ws value newline )+
value          ::= text
required_list  ::= ( ws "- " variable_name newline )+
```

Additional fields beyond those listed are preserved (open schema). All fields are optional.

## Steps

```ebnf
step ::= "## " step_id separator? text? newline
         for_clause?
         transition*
         prompt?
         body?
```

Content must appear in the order shown: FOR, transitions, prompt, body.

## Substeps

```ebnf
substep ::= "### " substep_id separator? text? newline
            transition*
            prompt?
            ( code_block | runbook_list )?
```

Substeps cannot contain nested substeps. See [SPEC.md §1.1](./SPEC.md) for the heading hierarchy rules.

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
separator ::= ( "." | ":" | "\u2014" | "\u2192" | "-" | ")" | " " )+
```

Unicode escapes: `\u2014` is em dash (—), `\u2192` is right arrow (→).

Separators are matched greedily — the longest sequence of separator characters between identifier and description text is consumed.

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

**Disambiguation:** A `-`-prefixed bullet inside a step is resolved by priority: (1) FOR clause (`FOR` keyword), (2) transition (`PASS`, `FAIL`, `YES`, `NO`, or standalone `DEFER`), (3) runbook reference (`.runbook.md` suffix), (4) prompt text.

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
display_lang    ::= language_tag
```

Opening fence is 3 or more backticks. Closing fence must use at least as many backticks as the opening fence (CommonMark §4.5). Language tag is required — bare code fences are invalid. Tags are matched case-insensitively. Non-executable tags (e.g., `json`, `yaml`) are display-only. When `prompt` follows an executable language tag (e.g., `bash prompt`), the block is demoted to display-only — it is not executed. The `prompt` suffix on non-executable tags is accepted but redundant — all non-executable code blocks are prompt blocks.

## Template Variables

```ebnf
template_variable ::= "{{" ws? variable_path ws? "}}"
bound_ref         ::= "{{" ws? variable_name ws? "}}"
variable_path     ::= variable_name ( "." ( variable_name | digit+ ) )*
variable_name     ::= [a-zA-Z_] [a-zA-Z0-9_]*
```

Template variables with dotted paths (`{{item.name}}`) are resolved at runtime. Parse-time positions (FOR bounds, GOTO AT index) accept only simple variable names via `bound_ref`.

## Runbook Lists

```ebnf
runbook_list  ::= ( "- " runbook_entry newline )+
runbook_entry ::= runbook_path | runbook_ref
runbook_path  ::= non_ws_char+ ".runbook.md"
runbook_ref   ::= "{{" ws? variable_path ws? "}}"
```

Step-level runbook lists are shorthand for implicit sequential substeps. Entries may be literal paths or template variable references (`runbook_ref`), which are resolved to concrete paths during the variable resolution phase. See [Transitions](#transitions) for bullet disambiguation priority.

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

`ALL`, `ANY`, `AT`, `BREAK`, `COMPLETE`, `CONTINUE`, `DEFER`, `FAIL`, `FOR`, `GOTO`, `IN`, `NEXT`, `NO`, `PASS`, `RETRY`, `STOP`, `TO`, `YES`

Case-sensitive: `NEXT` is reserved; `Next` and `NextStep` are valid. `OF` is a contextual keyword in `FOR...OF...` syntax but not a reserved word.

## Lexical Rules

```ebnf
positive_integer ::= [1-9] [0-9]*
digit            ::= [0-9]
text             ::= [^\n]+
non_ws_char      ::= [^ \t\n]
language_tag     ::= [a-zA-Z] [a-zA-Z0-9]*
ws               ::= ( " " | "\t" )+
newline          ::= "\n"
yaml_block       ::= (* opaque YAML content *)
backtick_fence   ::= "```" "`"*    /* 3 or more; closing fence >= opening count */
content          ::= (* opaque code block content *)
```

Upper bounds: step identifiers are capped at 999,999; FOR loop bounds at 10,000.
