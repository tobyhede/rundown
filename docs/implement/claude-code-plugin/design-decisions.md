# Design Decisions

Why Claude Code plugin path handling works this way.

---

## Why Two Variables Instead of One?

**Decision:** Separate `${CLAUDE_PLUGIN_ROOT}` (read-only, ephemeral) from `${CLAUDE_PLUGIN_DATA}` (read-write, persistent).

**Why:** Plugin updates replace the entire installation directory. If plugins stored state alongside their code, updates would destroy it. Separating concerns means:
- Plugin code is always clean (no stale state from previous versions)
- Plugin data survives updates (caches, installed dependencies, user config)
- The update path is simple: copy new files, point `CLAUDE_PLUGIN_ROOT` to them

**How to apply:** Never write files to `${CLAUDE_PLUGIN_ROOT}`. Use `${CLAUDE_PLUGIN_DATA}` for anything that should persist.

---

## Why Cache Marketplace Plugins?

**Decision:** Copy marketplace plugins to `~/.claude/plugins/cache/` instead of running them in-place.

**Why:**
1. **Security:** Plugins are verified before installation. Caching ensures the verified version runs, not a later-modified version.
2. **Isolation:** Plugins can't interfere with each other's files.
3. **Reproducibility:** Every user runs the exact same files for a given version.

**Consequence:** Path traversal (`../`) breaks after installation. Files outside the plugin root are not copied. This is intentional — it prevents accidental or malicious access to files beyond the plugin boundary.

**How to apply:** Test with `--plugin-dir` during development, but always verify that paths work after marketplace installation too. If you need external files, use symlinks (they're honored during copy).

---

## Why Inline Variable Substitution?

**Decision:** `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are replaced as literal text in all contexts (skill content, hook commands, MCP configs, etc.), not just as environment variables.

**Why:**
- Skills and agents are markdown content injected into Claude's context. Environment variables aren't accessible there.
- Hook commands need the path before shell execution.
- MCP/LSP configs are JSON — no shell expansion available.
- A single substitution mechanism works uniformly across all contexts.

**How to apply:** Use `${CLAUDE_PLUGIN_ROOT}` directly in any content string. `$CLAUDE_PLUGIN_ROOT` (without braces) also works in shell command contexts as an environment variable, but the `${}` form is preferred for consistency across all contexts (markdown content, JSON configs, shell commands).

---

## Why Project Overrides Plugin?

**Decision:** For context files, config, and runbook discovery, project-level files take precedence over plugin-level files.

**Why:**
- Projects have specific needs that differ from plugin defaults
- Teams should be able to customize plugin behavior per-project
- Plugin defaults serve as sensible starting points

**Configuration merge example:**

> **Rundown Plugin:** This example uses `rundown-plugin.json`, which is specific to the rundown plugin.

```
rundown-plugin.json priority:
1. .claude/rundown-plugin.json (project overrides)
2. rundown-plugin.json (project root)
3. ${CLAUDE_PLUGIN_ROOT}/rundown-plugin.json (plugin defaults)
```

**How to apply:** Ship sensible defaults in the plugin. Document which files can be overridden at the project level.

---

## Why Safe Path Utilities?

**Decision:** All path operations use `safeJoin()`, `sanitizePathSegment()`, `isPathInside()`, and `isValidRunbookPath()`.

**Why:** Plugins accept dynamic inputs (skill names, command names, agent types) that are used to construct file paths. Without validation:
- A skill named `../../etc/passwd` could escape the plugin directory
- A hook command could access arbitrary files
- A namespace prefix could be crafted for path traversal

**Implementation details:**
- `safeJoin()` throws if the resulting path escapes the base directory
- `sanitizePathSegment()` replaces `/`, `\` with `_` and `..` with `__`
- `isValidRunbookPath()` only allows `[a-zA-Z0-9_./\-]` and rejects `..`
- `resolvePluginPath()` rejects plugin names containing separators

**How to apply:** Never construct paths from user input without sanitization. Use the utilities in `shared/utils.ts`.

---

## Why `execFileSync` for CLI Execution?

**Decision:** Use `execFileSync` (array form) instead of `execSync` (string form) for running the rundown CLI.

**Why:** `execSync` passes commands through a shell, enabling injection. `execFileSync` takes the command and arguments as separate values, preventing interpretation.

```typescript
// Safe: no shell interpretation
execFileSyncImpl('node', [cliPath, ...args], options);

// Unsafe: would allow injection via args
execSync(`node ${cliPath} ${args.join(' ')}`, options);
```

**Source:** `packages/claude-code-plugin/src/workflow/hooks/rundown.ts`

**How to apply:** Always use `execFileSync` (or equivalent) with array arguments when executing commands from plugin code.

---

## Why `import.meta.url` Fallback?

**Decision:** When `CLAUDE_PLUGIN_ROOT` is not set, compute the plugin root from `import.meta.url`.

**Why:** During development, tests, and some edge cases, Claude Code may not set the environment variable. The fallback ensures the plugin can still find its own files by navigating up from the script's location.

```typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Traverse up from dist/gates/ to plugin root
```

**How to apply:** Always check `process.env.CLAUDE_PLUGIN_ROOT` first. Only fall back to `import.meta.url` computation when it's not set.
