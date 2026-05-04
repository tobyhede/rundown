# rdx JSON-to-Markdown Specification

This document specifies `rdx`, the schema-aware JSON-to-Markdown rendering CLI
shipped with `@rundown-org/claude-code-plugin`. It defines the input contract,
schema discovery and validation behavior, the structural rendering rules used
to convert JSON to Markdown, output destinations, and exit semantics. For the
authoring runbook surface and CLI conventions, see
[docs/reference/cli.md](cli.md). For schema-design guidance for new schema
modules, see
[docs/implement/claude-code-plugin/schema-design.md](../implement/claude-code-plugin/schema-design.md).

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in normative sections of this document are to
be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).
Sections explicitly marked "non-normative" provide examples or workflow
guidance.

## 1. Scope

This specification defines the behavior of the `rdx` binary. It covers:

- Command-line surface and argument shape.
- JSON input parsing and the `$schema` discovery contract.
- Schema name resolution and the registry of recognized schema names.
- Validation behavior, including `--check` mode.
- The structural Markdown rendering algorithm.
- Output destination semantics for stdout and `--output`.
- Failure modes, error message format, and exit codes.

This specification does not define how individual schemas are designed, how
schema modules are added to the registry, or runtime semantics for runbooks
that invoke `rdx`. Those topics are defined in
[docs/implement/claude-code-plugin/schema-design.md](../implement/claude-code-plugin/schema-design.md)
and [docs/reference/runtime.md](runtime.md), respectively.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| Input file | The JSON file passed as the positional argument to `rdx`. |
| Input data | The parsed JSON value of the input file. |
| Schema URI | A `$schema` string of the form `https://rundown.org/schemas/<name>.schema.json`. |
| Schema name | A bare lowercase identifier (for example `plan`) registered in the schema registry. |
| Schema registry | The internal mapping from schema name to validator module. |
| Validator | A module-level `validate(data: unknown)` function exported by a schema module. |
| Renderer | The structural JSON-to-Markdown algorithm defined in [§7](#7-rendering-rules). |
| Render mode | Default invocation: `rdx <file>` produces Markdown output. |
| Check mode | Invocation with `--check`: validates only, no Markdown output. |

## 3. Binary and Invocation

| Aspect | Requirement |
| --- | --- |
| Package | `@rundown-org/claude-code-plugin`. |
| Binary | `rdx`. |
| Positional argument | Exactly one path to a JSON file is REQUIRED. |
| Option `--check` | Validate only; produce no Markdown output. |
| Option `--schema <name>` | Explicit schema name for validation. |
| Option `-o, --output <path>` | Write Markdown to the given path instead of stdout. |

Synopsis:

```text
rdx <file>                        Render JSON to Markdown on stdout.
rdx <file> -o, --output <path>    Render JSON to the given Markdown file.
rdx <file> --check                Validate only; no Markdown output.
rdx <file> --schema <name>        Validate using the named schema.
```

The binary MUST exit with status `0` on success and status `1` on any failure
defined in [§9](#9-failure-modes). The binary MUST NOT define exit codes other
than `0` and `1`.

## 4. Input Contract

| Aspect | Requirement |
| --- | --- |
| Encoding | The input file MUST be UTF-8. |
| Format | The input file MUST contain a single JSON value. |
| Top-level shape | The input MAY be any JSON value: object, array, string, number, boolean, or null. |
| `$schema` field | When the top-level value is an object, the field `$schema` MAY be present and MUST be a string. |

The `$schema` field, when present at the top level of an object, is consumed
by schema discovery (see [§5](#5-schema-resolution)) and MUST be stripped
before rendering. The `$schema` field MUST NOT appear in rendered Markdown
regardless of whether validation occurs.

When the top-level value is not an object, schema discovery via `$schema` does
not apply. The `--schema` flag still applies and selects an explicit schema.

<a id="5-schema-resolution"></a>

## 5. Schema Resolution

Schema discovery has two sources: the `--schema` flag and the `$schema` field
in the input data.

<a id="51-schema-uri-format"></a>

### 5.1 Schema URI Format

A schema URI MUST take the form:

```text
https://rundown.org/schemas/<name>.schema.json
```

`<name>` MUST match the regular expression `^[a-z][a-z0-9-]*$`. URIs whose
extracted `<name>` does not match this pattern MUST NOT be recognized as
Rundown schema URIs.

### 5.2 Bare Schema Names

The `--schema` flag MAY accept either a bare name or a full URI. Bare names
MUST match `^[a-z][a-z0-9-]*$`.

The name pattern is a security boundary: it constrains the set of strings that
may be used to load a validator module. Names that do not match the pattern
MUST be rejected.

<a id="53-resolution-precedence"></a>

### 5.3 Resolution Precedence

The effective schema name MUST be resolved with this precedence, highest
first:

| Priority | Source | Rule |
| --- | --- | --- |
| 1 | `--schema <name>` | Explicit CLI flag. |
| 2 | `$schema` field in input data | Embedded URI parsed per [§5.1](#51-schema-uri-format). |

When both sources are present, the `--schema` flag MUST be used and the
embedded `$schema` value MUST NOT influence schema selection. The `$schema`
field MUST still be stripped from rendered output.

<a id="54-schema-registry"></a>

### 5.4 Schema Registry

The schema registry is the authoritative set of schema names that `rdx` can
validate against.

| Schema name | Source module | Description |
| --- | --- | --- |
| `plan` | `plan-schema.ts` | Implementation plans for the planning workflow. |
| `review` | `review-schema.ts` | Plan and code review documents. |

A name that passes the format check in [§5.1](#51-schema-uri-format) but is
not present in the registry MUST cause `rdx` to fail closed with the message
`Unknown schema: <name>` (see [§9](#9-failure-modes)).

### 5.5 Unrecognized `$schema` Values

If the input data contains a `$schema` field whose value cannot be parsed to
a name accepted by [§5.1](#51-schema-uri-format), `rdx` MUST fail closed with
the message `unrecognized schema: <raw value>`. `rdx` MUST NOT silently fall
back to schema-less rendering when an unrecognized `$schema` value is present.

When the `--schema` flag is supplied, the embedded `$schema` value is not
consulted for selection; an unrecognized embedded value MUST NOT cause failure
in that case.

<a id="56-no-schema-discovered"></a>

### 5.6 No Schema Discovered

When no schema is selected by either source, behavior depends on mode:

| Mode | Behavior |
| --- | --- |
| `--check` | Fail closed with the message `--check requires a schema (use $schema in JSON or --schema flag)`. |
| Render mode | Emit the warning `warning: no schema found, skipping validation` to stderr and render without validation. |

In render mode, the absence of a schema MUST NOT produce a non-zero exit code
on its own.

## 6. Validation

When a schema is selected per [§5](#5-schema-resolution), `rdx` MUST load the
corresponding validator from the registry and apply it to the input data with
`$schema` stripped.

### 6.1 Validator Contract

Each registered schema module MUST export a function `validate(data: unknown)`
that returns the validated, typed value or throws on validation failure.

| Aspect | Requirement |
| --- | --- |
| Validation library | The current `plan` and `review` validators are implemented with Zod. |
| Validation result | When validation succeeds, the value returned by `validate` MUST be used as the value passed to the renderer. |
| Validation failure | When validation throws, `rdx` MUST format and emit the error per [§6.3](#63-validation-error-format) and exit with status `1`. |

### 6.2 Check Mode

When `--check` is supplied:

| Outcome | Behavior |
| --- | --- |
| Validation succeeds | Write `Valid.\n` to stdout and exit with status `0`. |
| Validation fails | Write the formatted validation error to stderr and exit with status `1`. |
| No schema discovered | Fail closed per [§5.6](#56-no-schema-discovered). |

In `--check` mode, `rdx` MUST NOT write Markdown to stdout or to a file. The
`--output` option MUST have no effect when combined with `--check`.

<a id="63-validation-error-format"></a>

### 6.3 Validation Error Format

Validation errors MUST be written to stderr in one of two forms.

Structured Zod errors:

```text
error: schema validation failed (<schema>)
  /<json-path>: <issue message>
  ...
```

Each issue line MUST be indented two spaces. The path segment MUST be a
slash-prefixed JSON pointer joined from the issue's `path` array, or `(root)`
when the issue path is empty.

Other thrown errors:

```text
error: schema validation failed (<schema>)
  <error message>
```

When the schema name is not available at the failure site, the parenthesized
schema label MAY be omitted.

<a id="7-rendering-rules"></a>

## 7. Rendering Rules

The renderer is schema-unaware. Output is determined by the JSON shape after
`$schema` has been stripped and, if applicable, validation has succeeded.
Rendering of any value follows the rules in this section.

### 7.1 Top-Level Structure

For an object input, the renderer MUST handle these top-level fields specially:

| Field | Rendering |
| --- | --- |
| `meta` | Emitted as a YAML frontmatter block at the top of the document. |
| `name` | Emitted as the H1 heading. |
| `$schema` | Stripped before rendering; never appears in output. |
| All other fields | Rendered as H2 sections in input order. |

For non-object inputs:

| Top-level type | Output |
| --- | --- |
| `null` or `undefined` | A single newline. |
| `string` | The string followed by a newline. |
| `number`, `boolean` | The stringified value followed by a newline. |
| Array | Result of array rendering at heading depth 1 with no number prefix. |

### 7.2 Value Type Mapping

When rendering a value at a given heading depth:

| JSON type | Rendered as |
| --- | --- |
| `null` or `undefined` | Omitted entirely. |
| `string` | Paragraph followed by a blank line. |
| `number`, `boolean` | Stringified paragraph followed by a blank line. |
| Array of named objects | Numbered sections (see [§7.3](#73-named-object-arrays)). |
| Array of unnamed objects | Pipe table (see [§7.4](#74-pipe-tables)). |
| Array of primitives | Bullet list using `- <item>`. |
| Object with exactly `{ language, content }` | Language-annotated fenced code block. |
| Other object | Subsections with field headings at increasing depth. |

Empty arrays and `null`-valued fields MUST be omitted entirely. They MUST NOT
produce empty headings or empty list markers.

<a id="73-named-object-arrays"></a>

### 7.3 Named Object Arrays

An array is a *named object array* when every element is an object with a
string `name` field.

When rendering a named object array as the value of a parent field:

- The parent field heading MUST be replaced by the array's numbered items;
  no container heading is emitted.
- Each element renders as a heading at the current depth.
- Numbering MUST follow this format:

| Position | Heading format |
| --- | --- |
| Top-level item (no number prefix) | `<n>. <Title>` (period and space) |
| Nested item (with prefix) | `<prefix><n> <Title>` (space, no trailing period) |

Within each named item:

| Field | Rendering |
| --- | --- |
| `name` | Consumed as the item heading; not emitted again. |
| `code` | Emitted as a fenced code block (see [§7.5](#75-code-fields)) with no field heading. |
| String, number, or boolean | Inline paragraph at item depth, no field heading. |
| Named sub-array | Numbered subsections; replaces the field heading. |
| Other arrays and objects | Field heading at depth+1, then value at depth+2. |

<a id="74-pipe-tables"></a>

### 7.4 Pipe Tables

An array of plain objects in which not every element has a string `name`
field MUST be rendered as a Markdown pipe table.

| Aspect | Requirement |
| --- | --- |
| Columns | The union of all keys across all elements, in first-appearance order. |
| Headers | Each key MUST be converted to Title Case using the rule in [§7.6](#76-field-name-conversion). |
| Cell escaping | Pipe characters MUST be escaped as `\|`. |
| Backslash escaping | Backslashes MUST be escaped as `\\`. |
| Newline normalization | CR and LF inside cells MUST be replaced with a single space. |
| Null cells | `null` values MUST render as empty cells. |
| Complex cells | Arrays and objects in cells MUST be JSON-stringified, then escaped per the rules above. |

The separator row MUST contain six dashes per column (`------`).

<a id="75-code-fields"></a>

### 7.5 Code Fields

Two forms of code blocks are recognized.

A `code` field whose value is a string:

| Input | Output |
| --- | --- |
| `{ "code": "<source>" }` | Bare fenced code block (no language). |

A value that is exactly `{ language, content }` (no other keys):

| Input | Output |
| --- | --- |
| `{ "language": "<lang>", "content": "<source>" }` | Fenced code block with language tag `<lang>`. |

The `{ language, content }` shape MUST be detected only when the object has
exactly two keys. Objects that contain `language` and `content` plus any
additional key MUST be rendered as a regular object.

<a id="76-field-name-conversion"></a>

### 7.6 Field Name Conversion

Field names are converted to heading text by splitting on underscores and
spaces and capitalizing the first character of each resulting word.

| Field name | Heading text |
| --- | --- |
| `architecture_and_approach` | `Architecture And Approach` |
| `some field` | `Some Field` |

An empty field name MUST yield empty heading text and that field MUST be
skipped.

### 7.7 Heading Depth

Heading depth MUST be capped at H6 (`######`). Deeply nested structures
beyond depth 6 MUST converge at H6 rather than producing more than six `#`
characters.

<a id="8-output-destination"></a>

## 8. Output Destination

| Destination | Trigger | Behavior |
| --- | --- | --- |
| stdout | No `--output` flag in render mode. | Markdown is written to standard output. |
| File | `-o, --output <path>` in render mode. | Markdown is written to `<path>`. |
| Stdout (`Valid.`) | `--check` mode after successful validation. | The literal `Valid.\n` is written to standard output. |

The `--output` path MUST be written using standard file I/O. `rdx` MUST NOT
create parent directories for `--output` paths; missing parent directories
cause an I/O error and exit `1`. Existing files MUST be overwritten.

The `--output` flag MUST have no effect in `--check` mode.

<a id="9-failure-modes"></a>

## 9. Failure Modes

`rdx` MUST exit with status `1` and write a single-line error to stderr,
prefixed by `error: `, in each of the following cases.

| Case | Error message form |
| --- | --- |
| Input file missing | `error: file not found: <file>` |
| Input file unreadable | `error: cannot read <file>: <message>` |
| Input file is not valid JSON | `error: invalid JSON in <file>: <message>` |
| Embedded `$schema` URI does not parse to a registered name | `error: unrecognized schema: <raw>` |
| Resolved schema name not in registry | `error: Unknown schema: <name>` |
| Schema name fails the format check | `error: Invalid schema name: <name>` |
| `--check` supplied with no discoverable schema | `error: --check requires a schema (use $schema in JSON or --schema flag)` |
| Validation failure | `error: schema validation failed (<schema>)` followed by indented issue lines |
| Output file write failure | `error: <message>` |

In render mode, the absence of a schema MUST emit the warning
`warning: no schema found, skipping validation` to stderr and continue
without validation. The warning MUST NOT cause a non-zero exit.

## 10. Execution Order

`rdx` MUST process each invocation in this order:

1. Read the input file.
2. Parse the input as JSON.
3. Strip the `$schema` field from object inputs and capture the raw value.
4. Resolve the effective schema name per [§5.3](#53-resolution-precedence).
5. If the input contained a `$schema` value that did not parse to a name
   accepted by [§5.1](#51-schema-uri-format) and `--schema` did not select a
   schema, fail closed.
6. If no schema is selected, behave per [§5.6](#56-no-schema-discovered).
7. If a schema is selected, load the validator from the registry and validate
   the stripped input.
8. If `--check` was supplied, write `Valid.\n` to stdout and exit `0`.
9. Otherwise, render the validated value (or the stripped input if no schema
   was selected) per [§7](#7-rendering-rules).
10. Write the rendered Markdown to the destination per [§8](#8-output-destination).

Steps that fail per [§9](#9-failure-modes) MUST short-circuit the remaining
steps with exit status `1`.

## 11. Conformance

A conforming `rdx` implementation MUST satisfy these requirements:

1. Accept exactly one positional JSON file argument.
2. Strip `$schema` from object inputs before rendering, regardless of
   validation outcome.
3. Resolve schema names with the precedence `--schema` over embedded
   `$schema`.
4. Reject schema URIs and bare names that fail `^[a-z][a-z0-9-]*$`.
5. Treat schema URIs only when they match
   `https://rundown.org/schemas/<name>.schema.json`.
6. Fail closed when an embedded `$schema` is present but unrecognized and no
   `--schema` flag overrides selection.
7. Recognize exactly the schema names listed in the registry table in
   [§5.4](#54-schema-registry).
8. In `--check` mode, fail closed when no schema is discoverable.
9. In render mode without a schema, emit the no-schema warning and render.
10. Format Zod validation errors as schema-labeled, JSON-pointer-prefixed
    indented lines.
11. Apply the structural rendering rules in [§7](#7-rendering-rules) without
    schema knowledge.
12. Cap heading depth at H6.
13. Strip `null` and empty array fields from rendered output.
14. In `--check` success, write `Valid.\n` to stdout and emit no Markdown.
15. Exit with status `0` on success and status `1` on every failure mode in
    [§9](#9-failure-modes).
16. Never define exit codes other than `0` and `1`.

## 12. Examples (non-normative)

### 12.1 Common Invocations

```bash
# Render a plan to stdout
rdx plan.json

# Render a plan to a Markdown file
rdx plan.json --output plan.md

# Validate without rendering
rdx plan.json --check

# Validate with an explicit schema
rdx data.json --schema plan

# Pipe to other tools
rdx plan.json | less
```

### 12.2 Plan Input with Embedded `$schema`

```json
{
  "$schema": "https://rundown.org/schemas/plan.schema.json",
  "name": "Add Widget",
  "meta": { "version": "1.0.0" },
  "goal": "Create a widget component.",
  "architecture_and_approach": "Simple component following existing patterns.",
  "constraints_and_assumptions": "Must support dark mode.",
  "files": [
    { "path": "src/widget.ts", "action": "create", "notes": "Widget class" }
  ],
  "tasks": [
    {
      "name": "Implement Widget",
      "files": [{ "path": "src/widget.ts", "action": "create" }],
      "subtasks": [
        {
          "name": "Write failing test",
          "description": "Test widget construction.",
          "code": { "language": "typescript", "content": "expect(new Widget()).toBeDefined();" }
        },
        {
          "name": "Implement widget",
          "description": "Create the widget class.",
          "code": { "language": "typescript", "content": "export class Widget {}" }
        }
      ]
    }
  ]
}
```

Renders to:

````markdown
---
version: 1.0.0
---

# Add Widget

## Goal

Create a widget component.

## Architecture And Approach

Simple component following existing patterns.

## Constraints And Assumptions

Must support dark mode.

## Files

| Path | Action | Notes |
|------|------|------|
| src/widget.ts | create | Widget class |

## 1. Implement Widget

### Files

| Path | Action |
|------|------|
| src/widget.ts | create |

### 1.1 Write Failing Test

Test widget construction.

```typescript
expect(new Widget()).toBeDefined();
```

### 1.2 Implement Widget

Create the widget class.

```typescript
export class Widget {}
```
````

### 12.3 Typical Workflow

```bash
# 1. Author plan as JSON (manually or via Claude structured output).
# 2. Validate.
rdx plan.json --check

# 3. Render to Markdown.
rdx plan.json --output plan.md

# 4. Review the rendered Markdown.
cat plan.md
```

The plan-writing skill and runbook use a date-prefixed convention:

```bash
rdx .rundown/work/feature-name/2026-03-26-plan.json \
  --output .rundown/work/feature-name/2026-03-26-plan.md
```

## 13. Adding New Schemas (non-normative)

To add a new schema to the registry:

1. Create `packages/claude-code-plugin/src/<name>-schema.ts` exporting
   `validate(data: unknown): T`.
2. Register the loader in `schemaLoaders` in
   `packages/claude-code-plugin/src/rdx-validate.ts`.
3. Create `packages/claude-code-plugin/schemas/<name>.schema.json` for editor
   autocomplete and external consumers.
4. Keep the Zod and JSON Schema representations in sync.

See
[docs/implement/claude-code-plugin/schema-design.md](../implement/claude-code-plugin/schema-design.md)
for design constraints when authoring schemas intended for use with Claude
structured output.
