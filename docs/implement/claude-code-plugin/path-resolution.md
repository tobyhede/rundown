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

In development or testing, `CLAUDE_PLUGIN_ROOT` might not be set. The rundown plugin computes it from the script's own location:

```typescript
// gates/plugin-path.ts
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function computePluginRoot(): string {
  // File is at: dist/gates/plugin-path.js
  // Go up 2 directories: gates/ -> dist/ -> plugin root
  let pluginRoot = path.dirname(__dirname);
  pluginRoot = path.dirname(pluginRoot);
  return pluginRoot;
}
```

**Source:** `packages/claude-code-plugin/src/gates/plugin-path.ts`

This pattern (`import.meta.url` + directory traversal) is the standard fallback.

Note: `context.ts` has its own independent `getPluginRoot()` fallback (separate from `plugin-path.ts`), using a similar directory traversal approach. Both produce correct results.

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

## Rundown Plugin: Context File Discovery

> **Rundown Plugin:** This section documents the rundown plugin's context injection system. This is NOT a standard Claude Code feature.

Context files inject content based on hook events. Discovery follows a priority chain:

### Standard Context (skills, commands, tools)

| Priority | Location |
|----------|----------|
| 1 | `.claude/context/{name}-{stage}.md` (project) |
| 2 | `.claude/context/slash-command/{name}-{stage}.md` |
| 3 | `.claude/context/slash-command/{name}/{stage}.md` |
| 4 | `.claude/context/skill/{name}-{stage}.md` |
| 5 | `.claude/context/skill/{name}/{stage}.md` |
| 6 | `${CLAUDE_PLUGIN_ROOT}/context/{name}-{stage}.md` (plugin, same variations) |

### Agent-Command Context (SubagentStop)

| Priority | Location |
|----------|----------|
| 1 | `.claude/context/{agent}-{command}-{stage}.md` (project, most specific) |
| 2 | `.claude/context/{agent}-{stage}.md` (project, agent-specific) |
| 3 | `${CLAUDE_PLUGIN_ROOT}/context/{agent}-{command}-{stage}.md` (plugin) |
| 4 | `${CLAUDE_PLUGIN_ROOT}/context/{agent}-{stage}.md` (plugin) |
| 5 | Standard discovery (backward compat) |

### Supported Events

The `extractNameAndStage` function maps the following hook events to context file lookups:

| Event | Name | Stage |
|-------|------|-------|
| `SlashCommandStart` | command name | `start` |
| `SlashCommandEnd` | command name | `end` |
| `SkillStart` | skill name | `start` |
| `SkillEnd` | skill name | `end` |
| `PreToolUse` | tool name | `pre` |
| `PostToolUse` | tool name | `post` |
| `PostToolUseFailure` | tool name | `post` |
| `SubagentStart` | agent type | `start` |
| `SubagentStop` | (special handling) | — |
| `UserPromptSubmit` | `prompt` | `submit` |
| `Stop` | `agent` | `stop` |
| `SessionStart` | `session` | `start` |
| `SessionEnd` | `session` | `end` |
| `Notification` | `notification` | `receive` |

`SubagentStop` uses special agent-command context discovery rather than the standard name-stage pattern.

**Source:** `packages/claude-code-plugin/src/context.ts`

---

## Rundown Plugin: Skill Runbook Resolution

> **Rundown Plugin:** This section documents how the rundown plugin resolves runbook references from skill frontmatter. This is NOT a standard Claude Code feature.

When a skill starts, the plugin:

1. Receives skill name from hook event
2. Strips namespace prefix (e.g., `rundown:writing-plans` becomes `writing-plans`)
3. Sanitizes the name (path separators replaced with `_`)
4. Searches for `SKILL.md` at:
   - `${CLAUDE_PLUGIN_ROOT}/skills/{name}/SKILL.md` (plugin first)
   - `.claude/skills/{name}/SKILL.md` (project second)
5. Parses YAML frontmatter for `runbook:` field
6. Validates the runbook path against `/^[\w./-]+$/` (rejects `..`)
7. Executes via `rundown run <runbook>`

Note: Skill SKILL.md resolution searches the plugin root first, then the project directory. This is the opposite of context and config resolution, which search the project first.

**Source:** `packages/claude-code-plugin/src/gates/on-skill-start.ts`, `packages/claude-code-plugin/src/shared/find-runbook.ts`

---

## Rundown Plugin: Config File Resolution

> **Rundown Plugin:** The `rundown-plugin.json` config is specific to the rundown plugin, not a standard Claude Code feature.

Plugin configuration (`rundown-plugin.json`) is discovered from multiple locations:

| Priority | Location |
|----------|----------|
| 1 (highest) | `.claude/rundown-plugin.json` (project) |
| 2 | `rundown-plugin.json` (project root) |
| 3 (lowest) | `${CLAUDE_PLUGIN_ROOT}/rundown-plugin.json` (plugin defaults) |

Paths 1 and 2 are alternatives — the first project-level config found wins (the search breaks on first match). The winning project config is then merged with the plugin config (path 3), with project values overriding plugin defaults for the same keys.

**Source:** `packages/claude-code-plugin/src/shared/config.ts`

---

## Security Constraints

All path operations enforce boundaries:

| Utility | Purpose | Location |
|---------|---------|----------|
| `isPathInside(base, target)` | Ensures target stays within base | `shared/utils.ts` |
| `safeJoin(base, ...segments)` | Joins paths with boundary check, throws on escape | `shared/utils.ts` |
| `sanitizePathSegment(segment)` | Replaces `/`, `\` with `_`, `..` with `__` | `shared/utils.ts` |
| `isValidRunbookPath(path)` | Pattern `/^[\w./-]+$/`, rejects `..` | `shared/validate-runbook-path.ts` |
| `shellEscape(str)` | Escapes `"`, `` ` ``, `\`, `$` | `shared/utils.ts` |

### Plugin Name Validation

`resolvePluginPath()` rejects names containing `/`, `\`, or `..`, and the exact names `.` and `..`. Single dots within compound names (e.g., `my.plugin`) are allowed.

### CLI Execution Safety

`rundown()` uses `execFileSync` (array form) to prevent shell injection. No shell interpretation occurs.

**Source:** `packages/claude-code-plugin/src/shared/utils.ts`, `packages/claude-code-plugin/src/shared/validate-runbook-path.ts`, `packages/claude-code-plugin/src/shared/config.ts`, `packages/claude-code-plugin/src/workflow/hooks/rundown.ts`
