# Path Resolution

How Claude Code resolves file paths in plugins at every layer.

---

## The Two Environment Variables

Claude Code sets two variables automatically when a plugin is loaded. Both are substituted inline wherever they appear — skill content, agent content, hook commands, and MCP/LSP server configs. Both are also exported as environment variables to hook processes and server subprocesses.

### `${CLAUDE_PLUGIN_ROOT}`

The absolute path to the plugin's installation directory.

| Property | Value |
|----------|-------|
| **Set by** | Claude Code automatically |
| **Points to** | Plugin installation directory |
| **Persists across updates** | No (path changes on update) |
| **Writable** | No (files written here don't survive updates) |
| **Use for** | Scripts, templates, configs, binaries bundled with the plugin |

**Example values:**
- Local dev: `/Users/you/my-plugin` (when using `--plugin-dir`)
- Installed: `~/.claude/plugins/cache/my-plugin@marketplace/1.0.0/my-plugin` (internal cache directory structure is observable but not officially documented and may change)

### `${CLAUDE_PLUGIN_DATA}`

A persistent directory for plugin state.

| Property | Value |
|----------|-------|
| **Set by** | Claude Code automatically |
| **Points to** | `~/.claude/plugins/data/{id}/` |
| **Persists across updates** | Yes |
| **Writable** | Yes |
| **Use for** | `node_modules`, venvs, caches, generated files |
| **Created** | Automatically on first reference |
| **Cleaned up** | On uninstall from last scope (unless `--keep-data`) |

The `{id}` is the plugin identifier with characters outside `a-z`, `A-Z`, `0-9`, `_`, `-` replaced by `-`. For `formatter@my-marketplace`, the directory is `~/.claude/plugins/data/formatter-my-marketplace/`.

---

## Variable Substitution

Both variables are substituted as **literal text replacement** anywhere they appear:

```json
{
  "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh",
  "env": {
    "CACHE_DIR": "${CLAUDE_PLUGIN_DATA}/cache"
  }
}
```

**All substitution variables:**

| Variable | Scope | Description |
|----------|-------|-------------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin-wide | Plugin installation directory |
| `${CLAUDE_PLUGIN_DATA}` | Plugin-wide | Persistent data directory |
| `${CLAUDE_SKILL_DIR}` | Skill-specific | Directory containing SKILL.md |
| `${CLAUDE_SESSION_ID}` | Session-specific | Current session identifier |
| `$ARGUMENTS` | Skill-specific | All arguments passed to skill |
| `$ARGUMENTS[N]` | Skill-specific | Nth argument (0-indexed) |
| `$N` | Skill-specific | Shorthand for `$ARGUMENTS[N]` |

**Substitution contexts:**
- Skill `.md` content (body text)
- Skill frontmatter fields (e.g., `runbook:`, `template:`)
- Agent `.md` content
- Hook `command` strings
- MCP server `command`, `args`, `env`, `cwd` fields
- LSP server `command`, `args`, `env` fields

---

## Fallback When `CLAUDE_PLUGIN_ROOT` Is Not Set

In development or testing, `CLAUDE_PLUGIN_ROOT` might not be set. The real fallback lives in `packages/cli/src/helpers/plugin-root.ts` (`getPluginRoot()`): the env var still takes precedence, but when it is absent the CLI discovers the plugin as a **sibling package** installed alongside it in the same `@rundown-org` scope, then confirms the match by checking for a `runbooks/` directory:

```typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function discoverSiblingPlugin(): string | null {
  // Both @rundown-org/cli and @rundown-org/claude-code-plugin install into the
  // same @rundown-org scope dir. From dist/helpers/plugin-root.js, walk up three
  // levels (dist/helpers → dist → cli → @rundown-org), then resolve the sibling.
  const scopeDir = join(__dirname, '..', '..', '..');
  const pluginDir = join(scopeDir, 'claude-code-plugin');

  // Verify it's actually the plugin (has a runbooks/ directory) before trusting it.
  return existsSync(join(pluginDir, 'runbooks')) ? pluginDir : null;
}
```

The walk-up depth is tied to the compiled location (`dist/helpers/`), and the `runbooks/` check guards against resolving an unrelated directory — this is more than a bare "one level up from `dist/`", because the installed layout nests the script and the discovery target is a sibling, not an ancestor.

---

## Rundown Plugin: Runbook Discovery Chain

> **Rundown Plugin:** Runbook discovery is a Rundown feature, not a standard Claude Code plugin capability.

Runbooks are auto-discovered from multiple sources with priority:

| Priority | Source | Location |
|----------|--------|----------|
| 1 (highest) | Project | `.rundown/runbooks/` |
| 2 | Plugin | `${CLAUDE_PLUGIN_ROOT}/runbooks/` |
| 3 (lowest) | Bundled | CLI package `dist/runbooks/` |

Directories are scanned recursively. Subdirectory structures like `planning/write-plan.runbook.md` are supported.

### Namespace Syntax

| Syntax | Resolution |
|--------|------------|
| `write-plan` | Priority chain: project, plugin, bundled |
| `rundown:write-plan` | Explicit: plugin source only |

The `findRunbookByName` resolver matches against both frontmatter `name` and filename-derived stem (slug-normalized).

**Source:** `packages/cli/src/helpers/resolve-runbook.ts`, `packages/cli/src/services/discovery.ts`

---

> **Removed:** Earlier versions of the plugin discovered and injected context
> files from `.claude/context/**` and `${CLAUDE_PLUGIN_ROOT}/context/`, and read
> project-level `rundown-plugin.json` configuration. Both were removed for #463.
> The plugin no longer reads project config or injects context files. See
> [docs/internal/plugin-trust-model.md](../../internal/plugin-trust-model.md).

---

## Security Constraints

All path operations enforce boundaries:

| Utility | Purpose | Location |
|---------|---------|----------|
| `isPathInside(base, target)` | Ensures target stays within base | `shared/utils.ts` |
| `safeJoin(base, ...segments)` | Joins paths with boundary check, throws on escape | `shared/utils.ts` |
| `sanitizePathSegment(segment)` | Replaces `/`, `\` with `_`, `..` with `__` | `shared/utils.ts` |
| `shellEscape(str)` | Escapes `"`, `` ` ``, `\`, `$` | `shared/utils.ts` |

### CLI Execution Safety

`rundown()` uses `execFileSync` (array form) to prevent shell injection. No shell interpretation occurs.

**Source:** `packages/claude-code-plugin/src/shared/utils.ts`, `packages/claude-code-plugin/src/workflow/hooks/rundown.ts`
