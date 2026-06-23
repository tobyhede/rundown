# rdpath Path Assembly Specification

This document specifies the `rdpath` path-assembly CLI tool: its subcommand
surface, argument contracts, path composition rules, validation, glob and
symlink semantics, output format, and exit codes. For the runtime variables and
environment that feed `rdpath` (`WorkPath`, `ContextId`, `RD_WORK_PATH`,
`RD_CONTEXT_ID`), see [docs/reference/runtime.md](runtime.md). For policy and
sandbox semantics that govern any process consuming the assembled paths, see
[docs/reference/security.md](security.md). For general CLI conventions, see
[docs/reference/cli.md](cli.md).

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in normative sections of this document are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).
Sections explicitly marked "non-normative" provide examples or guidance.

## 1. Scope

This specification defines the externally observable behavior of the `rdpath`
binary: the subcommand surface, scope resolution, path composition, input
validation, glob discovery, symlink containment, output format, and exit codes.

This specification does not define how runbooks author path-helper expressions
such as `{{ path "..." }}`, runbook execution semantics, the security policy
evaluator, or the file formats consumed by tools that read paths emitted by
`rdpath`. Those topics are defined in
[docs/spec/grammar.md](../spec/grammar.md),
[docs/reference/runtime.md](runtime.md), and
[docs/reference/security.md](security.md).

## 2. Terminology

| Term           | Meaning                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Tool           | The `rdpath` binary shipped with `@rundown-org/claude-code-plugin`.                                                             |
| Scope          | The resolved pair of base directory and optional context identifier used to assemble paths.                                     |
| Base directory | The unscoped artifact root, supplied by `--dir`, `$RD_WORK_PATH`, or active runbook `WorkPath`.                                 |
| Context        | A scope identifier that adds a `.rd-<id>/` subdirectory under the base directory.                                               |
| Active state   | Persisted runbook state read through the core session reader to derive `WorkPath` and `ContextId` when not explicitly supplied. |
| Pattern        | The glob pattern argument accepted by `find`.                                                                                   |
| Date prefix    | The `YYYY-MM-DD-` filename prefix used by `--file`.                                                                             |

## 3. Tool Identity

| Aspect             | Requirement                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Package            | The tool MUST be packaged as `@rundown-org/claude-code-plugin`.                                                                    |
| Binary             | The tool MUST be exposed as `rdpath`.                                                                                              |
| Subcommand surface | The tool MUST expose exactly the subcommands defined in [§4](#4-subcommand-surface).                                               |
| Output streams     | Successful output MUST be written to stdout. Errors MUST be written to stderr with the prefix `error:` followed by a single space. |

<a id="4-subcommand-surface"></a>

## 4. Subcommand Surface

`rdpath` exposes two subcommands: `path` (default) and `find`. The `path`
subcommand MUST be the default subcommand and MUST be selected when no
subcommand is named on the command line.

| Subcommand       | Required arguments                                              | Optional arguments | Purpose                                           |
| ---------------- | --------------------------------------------------------------- | ------------------ | ------------------------------------------------- |
| `path` (default) | None directly; scope MUST resolve per [§5](#5-scope-resolution) | `--file <name>`    | Assemble an artifact path.                        |
| `find`           | `<pattern>`; scope MUST resolve per [§5](#5-scope-resolution)   | `--allow-empty`    | List files matching `<pattern>` within the scope. |

`--dir` and `--ctx` are program-level options and MAY appear before either
subcommand. Tool arguments MUST be parsed without shell interpolation by the
tool itself.

The tool MUST NOT register additional subcommands or accept positional arguments
other than the `find` pattern.

## 5. Scope Resolution

The scope is the pair `{ dir, ctx? }` used by both subcommands. The tool MUST
resolve scope before performing any path assembly or filesystem access.

### 5.1 Sources

| Field | Resolution order                                                    |
| ----- | ------------------------------------------------------------------- |
| `dir` | `--dir` flag, then `$RD_WORK_PATH`, then active-state `WorkPath`.   |
| `ctx` | `--ctx` flag, then `$RD_CONTEXT_ID`, then active-state `ContextId`. |

If no source yields a value for `dir`, the tool MUST write
`error: --dir is required (or set $RD_WORK_PATH)` to stderr and exit with status
`1`.

If no source yields a value for `ctx`, scope assembly MUST proceed without a
context segment.

### 5.2 Active-State Lookup

Active-state lookup reads persisted runbook state through the core session
reader. It runs in two distinct modes:

| Mode        | Trigger                                                        | Failure behavior                                                                                                                       |
| ----------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Mandatory   | `dir` cannot be resolved from flag or environment.             | Errors from active-state reading MUST propagate so the user sees the real cause.                                                       |
| Best-effort | `dir` is known from flag or environment, but `ctx` is missing. | Recoverable active-state errors MUST be silently treated as "no active context". The path MUST resolve without a `.rd-<ctx>/` segment. |

A recoverable active-state error in best-effort mode is one of:

| Class              | Condition                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid schema     | Error class `InvalidRunbookStateError`, or messages indicating schema-validation failure, invalid schema versions, legacy per-agent session formats, or invalid session entries. |
| Invalid identifier | Error class `InvalidActiveStateError`, or a message containing `invalid id`.                                                                                                     |
| Parse failure      | `SyntaxError` raised while reading session or run state.                                                                                                                         |
| Filesystem access  | <!-- cspell:ignore Errno EISDIR ENOTDIR --> A `NodeJS.ErrnoException` with code `EACCES`, `EPERM`, `EISDIR`, or `ENOTDIR` whose `path` includes `.rundown`.                      |

Any other error from active-state reading MUST propagate. The tool MUST NOT
migrate, rewrite, resume, shim, or otherwise adapt persisted runbook state when
performing best-effort context inference. Best-effort skipping is equivalent to
running with no available `--ctx`, `$RD_CONTEXT_ID`, or active `ContextId`.

This rule mirrors the runtime's no-migration contract; see
[docs/reference/runtime.md §Invalid Persisted State / No Migration](runtime.md#invalid-persisted-state--no-migration).

## 6. Argument Contracts

### 6.1 `--dir <path>`

| Property    | Requirement                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Required    | Optional at the CLI; `dir` MUST resolve via [§5.1](#51-sources).                                                                              |
| Form        | Any path string. The tool MUST NOT additionally validate `--dir` shape; the calling environment is the trust boundary for the base directory. |
| Composition | The supplied value MUST be used as the base directory; context and file segments MUST be appended to it via platform-native path joining.     |

### 6.2 `--ctx <id>`

| Property    | Requirement                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required    | Optional.                                                                                                                                                               |
| Pattern     | The value MUST match `^[a-zA-Z0-9_-]+$`.                                                                                                                                |
| Rejection   | Values containing path separators (`/`, `\`), `.` segments, or any character outside the pattern MUST be rejected with `error: Invalid ctx: must match [a-zA-Z0-9_-]+`. |
| Composition | Validated `ctx` MUST be joined as the literal subdirectory `.rd-<ctx>` under the base directory.                                                                        |

### 6.3 `--file <name>`

| Property    | Requirement                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required    | Optional. Accepted only by `path`.                                                                                                                                                              |
| Pattern     | The value MUST match `^[a-zA-Z0-9._-]+$`.                                                                                                                                                       |
| Rejection   | The values `.` and `..` MUST be rejected even though they match the character class. Values containing path separators MUST be rejected with `error: Invalid file: must match [a-zA-Z0-9._-]+`. |
| Composition | The validated filename MUST be prefixed with the date prefix (see [§8](#8-date-prefix)) and joined as a single path segment under the resolved base directory or context directory.             |

### 6.4 `<pattern>`

| Property       | Requirement                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required       | Yes, for `find`.                                                                                                                                         |
| Form           | A glob pattern relative to the resolved scope directory.                                                                                                 |
| Absolute paths | Patterns satisfying `path.isAbsolute` MUST be rejected with `error: Invalid pattern: must be relative to the target directory`.                          |
| Traversal      | Patterns matching <code>(?:^&#124;[/\\])\.\.(?:$&#124;[/\\])</code> MUST be rejected with `error: Invalid pattern: must not contain ".." path segments`. |

### 6.5 `--allow-empty`

`--allow-empty` is a boolean flag accepted only by `find`. When set, an empty
match set MUST exit `0`. When unset, an empty match set MUST exit `1` per
[§11](#11-exit-codes).

## 7. Path Assembly

The `path` subcommand MUST compose the output path from the resolved scope and
optional `--file`:

```text
<dir> [/ .rd-<ctx>] [/ YYYY-MM-DD-<file>]
```

| Inputs               | Output                              |
| -------------------- | ----------------------------------- |
| `dir` only           | `<dir>`                             |
| `dir`, `ctx`         | `<dir>/.rd-<ctx>`                   |
| `dir`, `file`        | `<dir>/YYYY-MM-DD-<file>`           |
| `dir`, `ctx`, `file` | `<dir>/.rd-<ctx>/YYYY-MM-DD-<file>` |

The tool MUST use platform-native path joining. The tool MUST NOT touch the
filesystem during `path` execution; `path` is a pure assembly operation.

The tool MUST NOT create the base, context, or parent directories implied by the
assembled path. Callers are responsible for creating directories before writing
files.

<a id="8-date-prefix"></a>

## 8. Date Prefix

| Property    | Requirement                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format      | The prefix MUST be `YYYY-MM-DD-`, where `YYYY-MM-DD` is the calendar date portion of the current instant in UTC (`new Date().toISOString().slice(0, 10)`). |
| Time zone   | The date MUST be evaluated in UTC, regardless of process or host time zone.                                                                                |
| Stability   | The prefix MUST be derived at the moment the `path` action runs; repeated invocations across day boundaries MAY produce different prefixes.                |
| Application | The prefix MUST be applied only when `--file` is supplied, and MUST be inserted between the resolved directory and the validated filename.                 |

## 9. File Discovery (`find`)

The `find` subcommand MUST list regular files within the resolved scope
directory that match `<pattern>`.

### 9.1 Glob Semantics

| Property    | Requirement                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine      | The tool MUST use the Node.js built-in `fs.glob` for matching.                                                                                                           |
| Search root | `fs.glob` MUST be invoked with `cwd` set to the absolute resolved scope directory (base directory plus `.rd-<ctx>` when `ctx` is set).                                   |
| Filtering   | Only entries that resolve to regular files MUST be reported. Entries whose `lstat` reports a directory MUST be excluded, even if the pattern matches the directory name. |
| Sorting     | Results MUST be sorted lexicographically by the assembled output path.                                                                                                   |
| Output      | Each match MUST be emitted as `<resolvedDir>/<match>` (the output path retains the original `--dir` form, not its absolute realpath).                                    |

The tool MUST NOT pass additional `fs.glob` options beyond `cwd`. Pattern
support is therefore exactly what `fs.glob` supports on the host Node runtime.

### 9.2 Directory Existence

Before globbing, the tool MUST `stat` the resolved scope directory and:

| Condition                                        | Behavior                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `ENOENT` from `stat`                             | Fail visibly with `error: Directory not found: <resolvedDir>` and exit `1`. |
| `stat` succeeds but the entry is not a directory | Fail visibly with `error: Not a directory: <resolvedDir>` and exit `1`.     |

### 9.3 Symlink Containment

The tool MUST resolve the search directory to its realpath before iterating
matches. For every glob match, the tool MUST resolve the match's realpath and
verify containment.

| Condition                                                        | Behavior                                            |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| Match realpath inside the search realpath                        | Include the match (subject to file-only filtering). |
| Match realpath outside the search realpath                       | Silently exclude the match.                         |
| Match cannot be resolved (`ENOENT`, including dangling symlinks) | Silently skip.                                      |
| Match access denied (`EACCES`, `EPERM`)                          | Silently skip.                                      |
| Match resolution loops (`ELOOP`)                                 | Silently skip.                                      |
| Any other filesystem error during match resolution               | Propagate as a visible failure.                     |

Containment uses path-relative comparison: the resolved match MUST be a strict
descendant of the resolved search directory. Equality with the search root MUST
NOT count as containment for match emission, since `find` emits files only.

This containment rule mirrors the runtime's data-source containment rule in
[docs/reference/runtime.md §6.2 File Source Rules](runtime.md#62-file-source-rules)
and the data-source resolution rule in
[docs/reference/security.md §11 Data Source File Security](security.md#11-data-source-file-security).

### 9.4 Empty Match Sets

| Flag state              | Behavior                                                                      |
| ----------------------- | ----------------------------------------------------------------------------- |
| `--allow-empty` not set | Zero matches MUST result in exit code `1` with empty stdout and empty stderr. |
| `--allow-empty` set     | Zero matches MUST result in exit code `0` with empty stdout and empty stderr. |

The "exit `1` on empty" behavior is intentional and supports runbook flow
control: a step's `PASS CONTINUE` / `FAIL` handler can branch on whether any
matching files exist. An empty stderr distinguishes "zero matches" from a real
error, which always writes to stderr with the `error:` prefix.

## 10. Output Format

| Subcommand              | Stream | Format                                                                                |
| ----------------------- | ------ | ------------------------------------------------------------------------------------- |
| `path`                  | stdout | The assembled path followed by a single trailing newline (`\n`).                      |
| `find`                  | stdout | One assembled match path per line, each followed by a single trailing newline (`\n`). |
| `path`, `find` (errors) | stderr | A single line of the form `error: <message>\n`.                                       |

The tool MUST NOT emit JSON, color codes, progress indicators, or interleaved
diagnostics on either stream. The tool MUST NOT write a trailing summary line
after the result.

<a id="11-exit-codes"></a>

## 11. Exit Codes

| Code | Subcommand | Meaning                                                                                                                               |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `path`     | Path successfully assembled and written to stdout.                                                                                    |
| `0`  | `find`     | One or more matches written to stdout, or zero matches when `--allow-empty` is set.                                                   |
| `1`  | `path`     | Any failure: invalid argument, unresolved `--dir`, propagated active-state error. stderr MUST contain a line beginning with `error:`. |
| `1`  | `find`     | Either zero matches without `--allow-empty` (stderr empty) or any failure (stderr begins with `error:`).                              |

Callers distinguish "zero matches" from "real error" on `find` by inspecting
stderr, not exit code.

## 12. Failure Semantics

The following failure modes MUST be visible — that is, the tool MUST exit with
status `1` and write a single `error: ...` line to stderr — and MUST NOT
silently degrade.

| Case                                                             | Behavior                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `--dir` unresolved                                               | Fail visibly with the canonical message `--dir is required (or set $RD_WORK_PATH)`. |
| Mandatory active-state lookup raises any error                   | Propagate the underlying error message verbatim under the `error:` prefix.          |
| Best-effort active-state lookup raises a non-recoverable error   | Propagate the underlying error message verbatim under the `error:` prefix.          |
| `--ctx` fails validation                                         | Fail visibly with `Invalid ctx: ...`.                                               |
| `--file` fails validation                                        | Fail visibly with `Invalid file: ...`.                                              |
| Pattern is absolute or contains `..`                             | Fail visibly with `Invalid pattern: ...`.                                           |
| `find` scope directory is missing                                | Fail visibly with `Directory not found: <path>`.                                    |
| `find` scope directory is not a directory                        | Fail visibly with `Not a directory: <path>`.                                        |
| Best-effort active-state lookup raises a recoverable error       | Treat as no active context; assemble path without `.rd-<ctx>/`.                     |
| Match symlink escapes the scope directory                        | Silently skip the match.                                                            |
| Match resolution returns `ENOENT`, `EACCES`, `EPERM`, or `ELOOP` | Silently skip the match.                                                            |

Silent skipping is permitted only for individual `find` matches and only for the
conditions listed above. Scope resolution, scope validation, pattern validation,
and directory existence MUST always fail visibly when they fail.

## 13. Conformance

A conforming `rdpath` implementation MUST satisfy these requirements:

1. Expose exactly the `path` (default) and `find` subcommands defined in
   [§4](#4-subcommand-surface) and no others.
2. Resolve scope using the precedence in [§5.1](#51-sources) — flag, then
   `RD_WORK_PATH` / `RD_CONTEXT_ID`, then active runbook state.
3. Fail visibly with the canonical `--dir is required` message and exit `1` when
   no source yields a base directory.
4. Treat active-state lookup as mandatory when `dir` is unresolved and as
   best-effort when only `ctx` is unresolved, applying the recoverable-error
   classification in [§5.2](#52-active-state-lookup).
5. Never migrate, rewrite, shim, or adapt persisted runbook state when reading
   active state.
6. Validate `--ctx` against `^[a-zA-Z0-9_-]+$` and reject any other input.
7. Validate `--file` against `^[a-zA-Z0-9._-]+$`, additionally rejecting `.` and
   `..`.
8. Reject absolute glob patterns and glob patterns containing `..` segments.
9. Compose paths as `<dir>[/.rd-<ctx>][/YYYY-MM-DD-<file>]` using platform path
   joining and never touch the filesystem during `path` assembly.
10. Use the calendar date in UTC, formatted as `YYYY-MM-DD`, for the `--file`
    date prefix.
11. Use Node.js `fs.glob` with `cwd` set to the resolved scope directory and no
    other options for `find`.
12. Emit only regular files from `find`, sorted lexicographically.
13. Resolve every glob match to its realpath and exclude matches that escape the
    resolved scope directory.
14. Silently skip matches that fail resolution with `ENOENT`, `EACCES`, `EPERM`,
    or `ELOOP`, and propagate any other resolution error.
15. Exit `0` for successful `path` assembly and for `find` with at least one
    match, or with zero matches when `--allow-empty` is set.
16. Exit `1` with empty stderr when `find` produces zero matches without
    `--allow-empty`.
17. Exit `1` with a single `error: ...` line on stderr for every failure mode in
    [§12](#12-failure-semantics).
18. Write only the assembled path or one match per line to stdout, each
    terminated by `\n`, and never interleave diagnostics on stdout.

## 14. Examples (non-normative)

### 14.1 Path Assembly

```bash
# Base directory only
rdpath --dir .rundown/work
# stdout: .rundown/work

# Context-scoped directory
rdpath --dir .rundown/work --ctx sprint-42
# stdout: .rundown/work/.rd-sprint-42

# Date-prefixed filename
rdpath --dir .rundown/work --file plan.md
# stdout: .rundown/work/2026-05-04-plan.md

# Combined: context + date-prefixed file
rdpath --dir .rundown/work --ctx sprint-42 --file review.md
# stdout: .rundown/work/.rd-sprint-42/2026-05-04-review.md
```

### 14.2 File Discovery

```bash
# Find files matching a glob
rdpath --dir .rundown/work find '*.md'

# Find within a context scope
rdpath --dir .rundown/work --ctx sprint-42 find '*-plan*.md'

# Recursive search
rdpath --dir .rundown/work find '**/*.json'

# Treat empty match as success (e.g. piping into a tolerant consumer)
rdpath --dir .rundown/work find '*.md' --allow-empty
```

### 14.3 Falling Back to Active Runbook State

When invoked inside a project with an active runbook, `--dir` and `--ctx` may be
omitted:

```bash
# Assembles using active-runbook WorkPath and ContextId
rdpath --file plan.md
```

If no `dir` is resolvable from flag, environment, or active state, the tool
exits `1` with `error: --dir is required (or set $RD_WORK_PATH)` on stderr.

### 14.4 Workflow

```bash
# 1. Assemble a directory and create it
ARTIFACT_DIR=$(rdpath --dir .rundown/work --ctx sprint-42)
mkdir -p "$ARTIFACT_DIR"

# 2. Create a date-prefixed file
PLAN_PATH=$(rdpath --dir .rundown/work --ctx sprint-42 --file plan.json)
echo '{"name": "my plan"}' > "$PLAN_PATH"

# 3. Find artifacts later
rdpath --dir .rundown/work --ctx sprint-42 find '*-plan*.json'

# 4. Pipe into rdx for rendering
PLAN=$(rdpath --dir .rundown/work --ctx sprint-42 find '*-plan.json')
rdx "$PLAN" --output \
  "$(rdpath --dir .rundown/work --ctx sprint-42 --file plan.md)"
```

### 14.5 Empty-Match Flow Control

```bash
# Branch a runbook step on whether any prior plans exist
if rdpath --dir .rundown/work --ctx sprint-42 find '*-plan.json' >/dev/null; then
  echo "found prior plan"
else
  echo "no prior plan"
fi
```

The default exit-on-empty behavior diverges from POSIX `find`(1) and `fd`, which
always exit `0`. It is intentional and parallels the precedent set by
`grep`/`rg`. Reach for `find`, `fd`, or shell glob expansion when an empty
result is a valid listing rather than a flow-control signal.
