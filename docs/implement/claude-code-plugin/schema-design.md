# Schema Design for Structured Output

How to design JSON schemas that work with Claude's structured output engine.

---

## Supported JSON Schema Features

Claude's structured output engine enforces schemas at the grammar level. Only a
subset of JSON Schema is supported server-side:

| Feature                                                        | Supported | Notes                                  |
| -------------------------------------------------------------- | --------- | -------------------------------------- |
| `type` (string, number, integer, boolean, object, array, null) | Yes       |                                        |
| `enum`                                                         | Yes       | Fixed list of allowed values           |
| `const`                                                        | Yes       | Single fixed value                     |
| `properties` / `required`                                      | Yes       |                                        |
| `additionalProperties: false`                                  | Yes       | Always recommended                     |
| `items`                                                        | Yes       | Array element types                    |
| `description`                                                  | Yes       | Primary way to communicate constraints |
| `format` (date, time, email, uri)                              | Yes       | Only these four                        |
| `format` (custom values)                                       | **No**    | Silently stripped                      |
| `$ref` / `$defs`                                               | **No**    | Inline definitions instead             |
| `oneOf` / `anyOf` / `allOf`                                    | **No**    | SDK transforms with loss               |
| `minLength` / `maxLength`                                      | **No**    | SDK moves to description               |
| `minItems` / `maxItems`                                        | **No**    | SDK moves to description               |
| `minimum` / `maximum`                                          | **No**    | SDK moves to description               |
| `pattern`                                                      | **No**    | Use description instead                |

**Reference:**
https://platform.claude.com/docs/en/build-with-claude/structured-outputs

---

## Design Rules for rdx Schemas

### 1. Use `description` for semantics, not `format`

Custom `format` values like `"markdown"` or `"filepath"` are silently stripped
by Claude's engine. The model never sees them.

```json
// Bad — stripped silently
"goal": { "type": "string", "format": "markdown" }

// Good — survives transformation
"goal": { "type": "string", "description": "Clear, concise description of the desired outcome" }
```

### 2. Use optional over nullable

Zod's `.nullable()` generates `oneOf` in JSON Schema, which Claude's engine
doesn't support. The SDK transforms it with loss. Use `.optional()` instead —
field absence is simpler and fully supported.

```typescript
// Bad — generates oneOf
dependencies: z.string().nullable(),

// Good — field is simply absent when not provided
dependencies: z.string().optional(),
```

### 3. Use `enum` for constrained string values

`enum` is fully supported and enforced at the grammar level. It's more reliable
than describing allowed values in text.

```json
"action": { "type": "string", "enum": ["create", "edit", "delete"] }
```

### 4. Use `additionalProperties: false` on all objects

Prevents the model from hallucinating extra fields. In Zod, use `.strict()`.

### 5. Use `const` for fixed values

Fully supported. The model will output the exact value.

```typescript
version: z.literal('1.0.0'),
```

### 6. Inline definitions in JSON Schema

`$ref` and `$defs` are not processed by Claude's engine. Inline the definition
at each usage site.

Note: Zod variable reuse (e.g. using a `FileEntry` variable in multiple places)
is fine — the SDK expands definitions inline automatically when converting to
JSON Schema.

### 7. Add meaningful descriptions to every field

When unsupported constraints (`minLength`, `minItems`, etc.) are stripped,
`description` is the model's only source of information about the constraint.
Each description should explain what the field means, not just its format.

```typescript
// Bad — single word, may be misinterpreted
z.string().describe('markdown')

// Good — explains intent
z.string().describe('High-level solution design, critical components, data and integrations')
```

---

## Dual-Schema Maintenance

This project maintains two representations for each schema:

| Representation | File                         | Purpose                                        |
| -------------- | ---------------------------- | ---------------------------------------------- |
| Zod schema     | `src/<name>-schema.ts`       | Runtime validation, type inference             |
| JSON Schema    | `schemas/<name>.schema.json` | Editor autocomplete, `rdx` validation dispatch |

**Zod is the source of truth** for runtime validation behavior. The JSON Schema
file is hand-maintained and must be kept in sync.

When making schema changes:

1. Update the Zod schema first
2. Mirror the change in the JSON Schema file
3. Update tests for both representations
4. Update skill docs and fixtures

---

## What the SDK Does Automatically

The Anthropic TypeScript SDK's `zodOutputFormat` helper:

- Converts Zod schemas to JSON Schema
- Strips unsupported keywords (`minLength`, `minItems`, etc.)
- Appends stripped constraint info to `description`
- Transforms `oneOf` (from `.nullable()`) — but with loss
- Adds `additionalProperties: false` to all objects
- Validates responses against the original Zod schema client-side

This means Zod constraints like `.min(1)` still work for client-side validation
even though they're stripped server-side. But it's better to design schemas that
don't rely on SDK transformation for correctness.
