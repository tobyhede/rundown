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

```
runbook  ::= frontmatter? title? preamble? step+
title    ::= "# " text newline
preamble ::= text+
```

## Frontmatter

```
frontmatter ::= "---" newline yaml_block "---" newline
```

Known fields:

```
name_field    ::= "name:" ws name_string
desc_field    ::= "description:" ws text
version_field ::= "version:" ws text
author_field  ::= "author:" ws text
tags_field    ::= "tags:" newline tag_list
vars_field    ::= "vars:" newline vars_map

name_string   ::= [a-zA-Z0-9_-] ( [a-zA-Z0-9_ -]* [a-zA-Z0-9_-] )?
tag_list      ::= ( ws "- " text newline )+
tag           ::= text
vars_map      ::= ( ws variable_name ":" ws value newline )+
value         ::= text
```

Additional fields beyond those listed are preserved (open schema). All fields are optional.

## Steps

```
step ::= "## " step_id separator? text? newline
         for_clause?
         transition*
         prompt?
         body?
```

Content must appear in the order shown: FOR, transitions, prompt, body.

## Substeps

```
substep ::= "### " substep_id separator? text? newline
            transition*
            prompt?
            ( code_block | runbook_list )?
```

Substeps cannot contain nested substeps.

## Identifiers

```
step_id      ::= positive_integer | named_id
substep_id   ::= positive_integer | named_id | qualified_id
named_id     ::= [A-Za-z_] [A-Za-z0-9_]*
qualified_id ::= step_ref "." ( positive_integer | named_id )
step_ref     ::= positive_integer | named_id
```

`named_id` must not be a [reserved word](#reserved-words). Reserved word matching is case-sensitive.

## Separators

```
separator ::= ( "." | ":" | "\u2014" | "\u2192" | "-" | ")" | " " )+
```

Unicode escapes: `\u2014` is em dash (—), `\u2192` is right arrow (→).

Separators are matched greedily — the longest sequence of separator characters between identifier and description text is consumed.

## FOR Clauses

```
for_clause  ::= "- FOR" ws for_variant newline
                nested_transition*

for_variant ::= variable_name ws "IN" ws positive_integer ws "TO" ws positive_integer ws "OF" ws source_ref
              | variable_name ws "IN" ws source_ref
              | variable_name ws "IN" ws range
              | range

range       ::= positive_integer ( ws "TO" ws positive_integer )?
source_ref  ::= "{{" ws? variable_name ws? "}}"

nested_transition ::= ws "- " result_keyword ( ws aggregation )? ws action newline
                    | ws "- DEFER" newline
```

Template variables (`{{var}}`) may appear in range bound positions. Source references (`{{ source }}`) in `FOR var IN {{ source }}` and `... OF {{ source }}` are data source identifiers.

**Examples:**

```markdown
- FOR batch IN 1 TO 10
- FOR 5
- FOR item IN {{ tasks }}
- FOR item IN 3 TO 7 OF {{ items }}
```

## Transitions

```
transition     ::= "- " result_keyword ( ws aggregation )? ws action newline
                 | "- DEFER" newline

result_keyword ::= "PASS" | "FAIL" | "YES" | "NO"
aggregation    ::= "ALL" | "ANY"
```

`YES` is a syntactic alias for `PASS`. `NO` is a syntactic alias for `FAIL`. Transitions must use `-` bullet prefix. Transition keywords are matched as whole words — the keyword must be followed by whitespace.

**Disambiguation:** A `- ` bullet inside a step is resolved by priority: (1) FOR clause (`FOR` keyword), (2) transition (`PASS`, `FAIL`, `YES`, `NO`, or standalone `DEFER`), (3) runbook reference (`.runbook.md` suffix), (4) prompt text.

## Actions

```
action ::= "CONTINUE"
         | "DEFER"
         | "NEXT"
         | "BREAK"
         | "COMPLETE" ( ws message )?
         | "STOP" ( ws message )?
         | "GOTO" ws target
         | "RETRY" ( ws positive_integer )? ( ws action )? ( ws message )?
```

Reserved words cannot appear as bare messages. Use quoted form for reserved-word messages (e.g., `RETRY 3 STOP "COMPLETE"`). Bare `RETRY` defaults to `RETRY 1 STOP`. `RETRY N` without fallback action defaults to `RETRY N STOP`. A bare message after RETRY count (e.g., `RETRY 3 "error"`) is shorthand for `RETRY 3 STOP "error"`. RETRY fallback action cannot be RETRY.

Context constraints:

| Action | Valid in |
|--------|---------|
| `DEFER` | Substeps, FOR nested transitions |
| `NEXT` | FOR substeps, FOR nested transitions |
| `BREAK` | FOR substeps, FOR nested transitions |

FOR nested transitions allow: `CONTINUE`, `DEFER`, `NEXT`, `BREAK`, `GOTO`, `STOP`, `COMPLETE` (with optional `RETRY` wrapper).

## Targets

```
target ::= ( step_id | substep_id ) ( ws "AT" ws index )?
index  ::= positive_integer | template_variable
```

`NEXT` is not a valid GOTO target.

## Messages

```
message       ::= bare_message | quoted_string
bare_message  ::= named_id    /* must not be a reserved word */
quoted_string ::= '"' text '"'
```

`bare_message` must not be a [reserved word](#reserved-words). To use a reserved word as a message, use the quoted form: `PASS STOP "COMPLETE"`, not `PASS STOP COMPLETE`.

## Code Blocks

```
code_block ::= backtick_fence info_string newline content backtick_fence newline

info_string ::= executable_lang ( ws "prompt" )?
              | display_lang
              | "prompt"

executable_lang ::= "bash" | "sh" | "shell"
display_lang    ::= language_tag
```

Opening fence is 3 or more backticks. Closing fence must use at least as many backticks as the opening fence (CommonMark §4.5). Language tag is required — bare code fences are invalid. Tags are matched case-insensitively. Non-executable tags (e.g., `json`, `yaml`) are display-only.

## Template Variables

```
template_variable ::= "{{" ws? variable_path ws? "}}"
variable_path     ::= variable_name ( "." variable_name )*
variable_name     ::= [a-zA-Z_] [a-zA-Z0-9_]*
```

## Runbook Lists

```
runbook_list ::= ( "- " file_path newline )+
```

Step-level runbook lists are shorthand for implicit sequential substeps.

## Body

```
body ::= code_block | substep+ | runbook_list
```

A step contains at most one body type.

## Prompt

```
prompt ::= text+
```

Free-form text between transitions and body.

## Reserved Words

`ALL`, `ANY`, `AT`, `BREAK`, `COMPLETE`, `CONTINUE`, `DEFER`, `FAIL`, `FOR`, `GOTO`, `IN`, `NEXT`, `NO`, `PASS`, `RETRY`, `STOP`, `TO`, `YES`

Case-sensitive: `NEXT` is reserved; `Next` and `NextStep` are valid.

## Lexical Rules

```
positive_integer ::= [1-9] [0-9]*
digit            ::= [0-9]
text             ::= [^\n]+
file_path        ::= [^\n]+
language_tag     ::= [a-zA-Z] [a-zA-Z0-9]*
ws               ::= ( " " | "\t" )+
newline          ::= "\n"
yaml_block       ::= (* opaque YAML content *)
backtick_fence   ::= "```" "`"*    /* 3 or more; closing fence >= opening count */
content          ::= (* opaque code block content *)
```
