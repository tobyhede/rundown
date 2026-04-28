# rdpath — Path Assembly CLI

`rdpath` is a path assembly and file discovery tool shipped with `@rundown-org/claude-code-plugin`. It builds artifact paths with optional context scoping and date-prefixed filenames, and provides glob-based file discovery within artifact directories.

## Usage

```bash
rdpath [--dir <path>]                         # Assemble base path (default subcommand)
rdpath [--dir <path>] --ctx <id>              # With context scope (.rd-<id>/)
rdpath [--dir <path>] --file <name>           # With date-prefixed filename
rdpath [--dir <path>] --ctx <id> --file <name> # Combined context + filename
rdpath [--dir <path>] find <pattern>          # Find files matching glob pattern
rdpath [--dir <path>] --ctx <id> find <pattern> # Find within context scope
```

**Fallback resolution:** `--dir` is optional when `rdpath` can infer a run work path. It resolves each value independently: explicit flag, then the runbook shell environment (`$RD_WORK_PATH` / `$RD_CONTEXT_ID`), then the active runbook state's `WorkPath` / `ContextId`. The environment variables are injected automatically by `rundown` for each shell block; the active-state fallback lets the same bare `rdpath --file ...` form work from another terminal while a runbook is active. If no base directory can be resolved, `rdpath` writes `error: --dir is required (or set $RD_WORK_PATH)` to stderr and exits with code `1`. `--ctx` remains optional — when no flag, env var, or active `ContextId` is available, the path is assembled without a context segment.

### Examples

```bash
# Base directory only
rdpath --dir .rundown/work
# → .rundown/work

# Context-scoped directory
rdpath --dir .rundown/work --ctx sprint-42
# → .rundown/work/.rd-sprint-42

# Date-prefixed filename
rdpath --dir .rundown/work --file plan.md
# → .rundown/work/2026-03-27-plan.md

# Combined: context + date-prefixed file
rdpath --dir .rundown/work --ctx sprint-42 --file review.md
# → .rundown/work/.rd-sprint-42/2026-03-27-review.md

# Find files matching a glob
rdpath --dir .rundown/work find '*.md'

# Find within a context scope
rdpath --dir .rundown/work --ctx sprint-42 find '*-plan*.md'

# Recursive search
rdpath --dir .rundown/work find '**/*.json'
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — for `find`, one or more matches (or zero matches with `--allow-empty`) |
| `1` | For `find`: zero matches (stderr empty) **or** error (stderr prefixed with `error:`). For `path`: error. |

Errors are written to stderr with an `error:` prefix. For `find`, an empty stderr plus exit 1 means "zero matches" — distinct from a real error like an invalid pattern or missing directory.

---

## Subcommands

### `path` (default)

Assembles an artifact path from `--dir`, optional `--ctx`, and optional `--file`. This is the default subcommand — invoked when no subcommand is specified.

| Option | Required | Description |
|--------|----------|-------------|
| `--dir <path>` | No¹ | Base directory (defaults to `$RD_WORK_PATH`, then active `WorkPath`) |
| `--ctx <id>` | No | Context scope — appends `.rd-<id>/` subdirectory (defaults to `$RD_CONTEXT_ID`, then active `ContextId`) |
| `--file <name>` | No | Filename — prepends today's date (`YYYY-MM-DD-<name>`) |

¹ `--dir` is required unless `$RD_WORK_PATH` or active runbook `WorkPath` is available.

Output is the assembled path, written to stdout with a trailing newline.

### `find`

Discovers files matching a glob pattern within an artifact directory.

| Option/Argument | Required | Description |
|-----------------|----------|-------------|
| `--dir <path>` | No¹ | Base directory to search (defaults to `$RD_WORK_PATH`, then active `WorkPath`) |
| `--ctx <id>` | No | Context scope — searches within `.rd-<id>/` subdirectory (defaults to `$RD_CONTEXT_ID`, then active `ContextId`) |
| `--allow-empty` | No | Exit 0 when zero files match (default: exit 1 on empty) |
| `<pattern>` | Yes | Glob pattern (relative to target directory) |

¹ `--dir` is required unless `$RD_WORK_PATH` or active runbook `WorkPath` is available.

Output is one matching file path per line, sorted lexicographically. Only regular files are returned — directories matching the pattern are excluded.

**Exit code on empty match.** `rdpath find` is purpose-built for runbook flow control: an empty match set is a negative answer, not a listing result. The default exits 1 with empty stdout and empty stderr, so runbook step handlers (`PASS CONTINUE` / `FAIL COMPLETE`) can drive flow from the exit code directly. Pass `--allow-empty` to treat an empty result as success — useful when piping into a consumer that tolerates empty input. This divergence from `find`/`fd` (which always exit 0) follows the same precedent as `grep`/`rg` deliberately diverging from `find`. For vanilla file listing where empty is valid, reach for `find`, `fd`, or shell glob expansion instead.

---

## Path Assembly

The `path` subcommand builds paths by composing three layers:

```text
<dir> / [.rd-<ctx>/] [YYYY-MM-DD-<file>]
```

| Input | Output |
|-------|--------|
| `--dir .rundown/work` | `.rundown/work` |
| `--dir .rundown/work --ctx abc` | `.rundown/work/.rd-abc` |
| `--dir .rundown/work --file plan.md` | `.rundown/work/2026-03-27-plan.md` |
| `--dir .rundown/work --ctx abc --file plan.md` | `.rundown/work/.rd-abc/2026-03-27-plan.md` |

The date prefix uses the current date in `YYYY-MM-DD` format (ISO 8601).

---

## Security

### Input Validation

| Input | Constraint | Regex |
|-------|-----------|-------|
| `--ctx` | Alphanumeric, hyphens, underscores | `^[a-zA-Z0-9_-]+$` |
| `--file` | Alphanumeric, dots, hyphens, underscores | `^[a-zA-Z0-9._-]+$` |
| `<pattern>` | Must be relative, no `..` segments | Rejects absolute paths and `..` traversal |

### Directory Traversal Prevention

- `--ctx` and `--file` values are validated against strict character sets — path separators (`/`, `\`) and `..` are rejected
- Glob patterns must be relative to the target directory — absolute patterns and `..` segments are rejected
- Pattern: `(?:^|[/\\])\.\.(?:$|[/\\])` catches traversal in any position

### Symlink Safety

The `find` subcommand resolves symlinks via `realpath()` and verifies that resolved targets remain within the search directory:

- Symlinks resolving **inside** the search directory are included
- Symlinks resolving **outside** the search directory are silently excluded
- Dangling symlinks (broken targets) are silently skipped
- Permission errors (`EACCES`, `EPERM`) and symlink loops (`ELOOP`) are silently skipped

---

## Execution Flow

### path (default)

```text
Resolve --dir
  → If --ctx → validate, append .rd-<ctx>/
  → If --file → validate, prepend YYYY-MM-DD-
  → Output assembled path
```

### find

```text
Resolve --dir
  → If --ctx → validate, append .rd-<ctx>/
  → Validate pattern (reject absolute paths and .. traversal)
  → Verify directory exists
  → Resolve realpath for symlink safety
  → Glob match pattern within directory
  → Filter: files only, inside search dir
  → Sort lexicographically
  → Output one path per line
```

---

## Typical Workflow

```bash
# 1. Assemble a path for a new artifact
ARTIFACT_DIR=$(rdpath --dir .rundown/work --ctx sprint-42)
mkdir -p "$ARTIFACT_DIR"

# 2. Create a date-prefixed file
PLAN_PATH=$(rdpath --dir .rundown/work --ctx sprint-42 --file plan.json)
echo '{"name": "my plan"}' > "$PLAN_PATH"

# 3. Find artifacts later
rdpath --dir .rundown/work --ctx sprint-42 find '*-plan*.json'

# 4. Combine with rdx for rendering
PLAN=$(rdpath --dir .rundown/work --ctx sprint-42 find '*-plan.json')
rdx "$PLAN" --output "$(rdpath --dir .rundown/work --ctx sprint-42 --file plan.md)"
```
