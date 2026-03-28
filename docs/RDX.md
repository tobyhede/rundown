# rdx — JSON-to-Markdown CLI

`rdx` is a schema-aware JSON-to-Markdown transformation tool shipped with `@rundown-org/claude-code-plugin`. It renders arbitrary JSON to readable Markdown following structural conventions and optionally validates against discoverable schemas.

## Usage

```bash
rdx <file>                        # Render JSON to Markdown (stdout)
rdx <file> -o, --output <path>    # Write Markdown to file
rdx <file> --check                # Validate only, no rendering
rdx <file> --schema <name>        # Explicit schema for validation
```

### Examples

```bash
# Render a plan to Markdown
rdx plan.json --output plan.md

# Validate without rendering
rdx plan.json --check

# Explicit schema override
rdx data.json --schema plan

# Pipe to other tools
rdx plan.json | less
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (invalid JSON, unrecognized schema, validation failure, file not found) |

Errors are written to stderr with an `error:` prefix.

---

## Rendering Rules

The renderer is **schema-unaware** — output is driven entirely by the JSON shape. No schema knowledge is needed to render valid Markdown.

### Root-Level Special Fields

| Field | Rendering |
|-------|-----------|
| `name` | H1 heading |
| `meta` | YAML frontmatter block |
| `$schema` | Stripped (consumed before rendering) |
| All other fields | H2 sections |

### Value Types

| JSON Type | Rendered As |
|-----------|-------------|
| `null` | Omitted |
| `string` | Paragraph |
| `number` / `boolean` | Stringified paragraph |
| Array of primitives | Bullet list (`- item`) |
| Array of named objects | Numbered sections (see below) |
| Array of unnamed objects | Pipe table |
| Object | Subsections with field headings |

Empty arrays and null fields are omitted entirely.

### Named Object Arrays

When every element in an array has a `name` string field, the array renders as numbered sections. The parent field heading is **replaced** by the numbered items — no container heading is emitted.

**Numbering format:**
- Top-level: `1. Name`, `2. Name` (dot + space)
- Nested: `1.1 Name`, `1.2 Name` (space, no trailing dot)

Within each named item:
- `name` → consumed as the section heading
- `code` → fenced code block (no field heading)
- String, number, boolean → inline paragraph (no field heading)
- Named sub-arrays → numbered subsections (replace heading)
- Other arrays/objects → field heading at depth+1

### Pipe Tables

Arrays of objects without a `name` field render as pipe tables:
- Column headers are the union of all keys across elements (first-appearance order)
- Headers use Title Case (`some_field` → `Some Field`)
- Pipe characters in cells are escaped (`|` → `\|`)
- Newlines in cells are normalized to spaces
- Backslashes in cells are escaped (`\` → `\\`)
- Null values render as empty cells
- Complex values are JSON-stringified

### Code Blocks

Two forms are recognized:

**String in a `code` field:**
```json
{ "code": "console.log('hello');" }
```
Renders as a bare fenced code block.

**Object with exactly `{ language, content }`:**
```json
{ "code": { "language": "typescript", "content": "const x = 1;" } }
```
Renders as a language-annotated fenced code block. The object must have **exactly** two keys to be recognized — extra fields cause it to render as a regular object.

### Field Name Conversion

Field names are converted to headings by splitting on `_` and spaces, then capitalizing each word:
- `architecture_and_approach` → `Architecture And Approach`
- `some field` → `Some Field`

### Heading Depth

Headings are capped at H6 (`######`). Deeply nested structures converge at H6 rather than exceeding it.

---

## Schema Validation

Validation is optional and triggered when a schema is discoverable. Two discovery mechanisms exist:

### 1. `$schema` Field in Data

Include a `$schema` URI in the JSON:

```json
{
  "$schema": "https://rundown.org/schemas/plan.schema.json",
  "name": "My Plan",
  ...
}
```

The URI is parsed to extract the schema name. The `$schema` field is always stripped before rendering, regardless of whether validation occurs.

### 2. `--schema` Flag

```bash
rdx data.json --schema plan
```

The `--schema` flag takes priority over the `$schema` field.

### Schema Name Resolution

Schema names are extracted from URIs matching `https://rundown.org/schemas/<name>.schema.json` or accepted as bare names (e.g., `plan`).

**Name constraints:** Must match `^[a-z][a-z0-9-]*$` (lowercase start, alphanumeric and hyphens only). This is a security boundary — it prevents path traversal in dynamic imports.

### Unrecognized Schemas

If a `$schema` URI is present but cannot be parsed to a known schema name, `rdx` **rejects** it with an error rather than silently skipping validation:

```text
error: unrecognized schema: https://example.com/unknown.json
```

### Validation Error Format

**Zod validation errors** (structured):
```text
error: schema validation failed (plan)
  /goal: Required
  /files/0/action: Invalid enum value. Expected 'create' | 'edit' | 'delete'
```

**Other errors:**
```text
error: schema validation failed (plan)
  error message text
```

---

## Available Schemas

### `plan`

The plan schema validates implementation plans. Include `"$schema": "https://rundown.org/schemas/plan.schema.json"` for auto-discovery.

**Source of truth:** `packages/claude-code-plugin/src/plan-schema.ts` (Zod)
**Editor autocomplete:** `packages/claude-code-plugin/schemas/plan.schema.json` (JSON Schema, hand-maintained mirror)

#### Structure

```typescript
{
  $schema?: "https://rundown.org/schemas/plan.schema.json",  // Optional schema URI (literal)
  name: string,                              // Plan name (min 1 char)
  meta: { version: "1.0.0" },               // Must be exactly "1.0.0"
  goal: string,                              // Desired outcome
  architecture_and_approach: string,          // Solution design
  constraints_and_assumptions: string,        // Hard constraints and assumptions
  dependencies?: string,                      // Optional dependencies
  context?: string,                          // Optional context
  files: FileEntry[],                        // Files affected (min 1)
  tasks: Task[],                             // Implementation tasks (min 1)
}
```

**FileEntry:**
```typescript
{
  path: string,                              // Relative from project root
  action: "create" | "edit" | "delete",
  notes?: string
}
```

**Task:**
```typescript
{
  name: string,
  files: FileEntry[],                        // Can be empty (research tasks)
  subtasks: Subtask[],                       // Min 1 item
  commit?: {
    files: string[],                         // Files to stage (min 1)
    message: string                          // Commit message
  }
}
```

**Subtask:**
```typescript
{
  name: string,
  description?: string,
  code?: { language: string, content: string }
}
```

All objects use strict mode — no additional properties are allowed.

#### Example Rendered Output

Given this plan JSON:

```json
{
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

Note: The task-level `### Files` table appears between the task heading and subtasks when the task has a non-empty `files` array.

---

## Adding New Schemas

1. Create `packages/claude-code-plugin/src/<name>-schema.ts` exporting `validate(data: unknown): T`
2. Register in `schemaLoaders` in `packages/claude-code-plugin/src/rdx-validate.ts`
3. Create `packages/claude-code-plugin/schemas/<name>.schema.json` for editor autocomplete
4. Keep Zod and JSON Schema representations in sync (see `docs/implement/claude-code-plugin/schema-design.md`)

### Schema Design Rules

When designing schemas for use with Claude's structured output:
- Use `description` for semantics — custom `format` values are silently stripped
- Use `.optional()` over `.nullable()` — nullable generates unsupported `oneOf`
- Use `enum` for constrained strings — enforced at grammar level
- Use `additionalProperties: false` on all objects
- Use `const` for fixed values
- Inline definitions — `$ref` and `$defs` are not supported

See `docs/implement/claude-code-plugin/schema-design.md` for full guidance.

---

## Execution Flow

```text
Read JSON file
  → Parse JSON
  → Extract $schema → { cleanData, schemaName, rawSchema }
  → Resolve schema (--schema flag > $schema field)
  → If rawSchema present but unresolvable → error, exit 1
  → If schema resolved → validate cleanData → dataToRender (or cleanData if no schema)
  → If --check → output "Valid.", exit 0 (schema validation only if schema resolved; otherwise confirms valid JSON only)
  → renderToMarkdown(dataToRender)
  → Output to --output file or stdout
```

---

## Typical Workflow

```bash
# 1. Write plan as JSON (manually or via Claude structured output)
# 2. Validate
rdx plan.json --check

# 3. Render to Markdown
rdx plan.json --output plan.md

# 4. Review the rendered Markdown
cat plan.md
```

The plan-writing skill and runbook use path conventions:
```bash
rdx .work/feature-name/2026-03-26-plan.json --output .work/feature-name/2026-03-26-plan.md
```
