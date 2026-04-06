# Claude Code Plugin Paths: Quick Reference

**Last Updated:** 2026-03-19

> **Goal:** Find what you need in < 30 seconds

---

## Environment Variables

| Variable | Scope | Use For | Persists? | Writable? |
|----------|-------|---------|-----------|-----------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin-wide | Bundled files (scripts, templates, configs) | No | No |
| `${CLAUDE_PLUGIN_DATA}` | Plugin-wide | Persistent state (deps, caches) | Yes | Yes |
| `${CLAUDE_SKILL_DIR}` | Skill-specific | Directory containing SKILL.md | — | No |
| `${CLAUDE_SESSION_ID}` | Session-specific | Current session identifier | — | No |
| `$ARGUMENTS` | Skill-specific | All arguments passed to skill | — | No |
| `$ARGUMENTS[N]` / `$N` | Skill-specific | Nth argument (0-indexed) | — | No |

---

## How to Reference Files

| Component | Pattern | Example |
|-----------|---------|---------|
| Skill frontmatter (Rundown Plugin) | `runbook: ${CLAUDE_PLUGIN_ROOT}/path` | `runbook: ${CLAUDE_PLUGIN_ROOT}/runbooks/plan.runbook.md` |
| Skill body | Inline in Markdown | `` Template: `${CLAUDE_PLUGIN_ROOT}/templates/review.md` `` |
| Hook command | In `command` string | `"${CLAUDE_PLUGIN_ROOT}/scripts/lint.sh"` |
| MCP server | In `command`, `args`, `env`, `cwd` | `"command": "${CLAUDE_PLUGIN_ROOT}/servers/db"` |
| LSP server | In `command`, `args`, `env` | `"env": { "PATH": "${CLAUDE_PLUGIN_DATA}/bin" }` |
| Agent body | Inline in markdown | `Rules: ${CLAUDE_PLUGIN_ROOT}/rules/security.md` |

---

## Auto-Discovered vs Explicit

**Standard Claude Code:**

| Directory | Auto-discovered? | Override Location |
|-----------|-------------------|-------------------|
| `skills/` | Yes | — |
| `commands/` | Yes (legacy; use `skills/`) | — |
| `agents/` | Yes | — |
| `hooks/hooks.json` | Yes | — |
| `.mcp.json` | Yes | — |
| `.lsp.json` | Yes | — |
| `templates/` | No | Must use `${CLAUDE_PLUGIN_ROOT}/templates/...` |
| `scripts/` | No | Must use `${CLAUDE_PLUGIN_ROOT}/scripts/...` |

> **Rundown Plugin:**

| Directory | Auto-discovered? | Override Location |
|-----------|-------------------|-------------------|
| `runbooks/` | Yes | `.claude/rundown/runbooks/` (project overrides plugin) |
| `context/` | Yes | `.claude/context/` (project overrides plugin) |

---

## Quick Diagnosis

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Path not found after install | External file not in plugin dir | Move file inside plugin root, or symlink it |
| Path works locally, breaks installed | `--plugin-dir` doesn't cache | Ensure file is in `package.json` `files` array |
| `${CLAUDE_PLUGIN_ROOT}` not substituted | Wrong context or wrong syntax | Use `${...}` braces; check it's in a supported context |
| Written files disappear on update | Wrote to `${CLAUDE_PLUGIN_ROOT}` | Use `${CLAUDE_PLUGIN_DATA}` instead |
| Plugin override not working | Project file missing or wrong name | Check `.claude/context/` or `.claude/rundown/runbooks/` (Rundown Plugin) |
| MCP server fails to start | Missing `${CLAUDE_PLUGIN_ROOT}` | Use variable for all plugin paths |
| Hook script not executing | Script not executable | `chmod +x scripts/your-script.sh` |
| `CLAUDE_PLUGIN_ROOT` not set | Running outside Claude Code | Use `import.meta.url` fallback (see [path-resolution.md](path-resolution.md)) |

---

## Path Rules

1. All paths relative to plugin root, starting with `./` in configs
2. No `../` traversal outside plugin root
3. `${CLAUDE_PLUGIN_ROOT}` for read-only bundled files
4. `${CLAUDE_PLUGIN_DATA}` for persistent writable state
5. Symlinks honored during cache copy
6. Project-level overrides plugin-level for context/config/runbooks

---

## Directory Layout

**Standard Claude Code:**

```text
my-plugin/
  .claude-plugin/plugin.json     # Manifest (only this in .claude-plugin/)
  skills/{name}/SKILL.md         # Skills
  commands/{name}.md             # Slash commands (legacy; use skills/)
  agents/{name}.md               # Subagents
  hooks/hooks.json               # Hook configuration
  .mcp.json                      # MCP servers
  .lsp.json                      # LSP servers
  settings.json                  # Default settings
  scripts/                       # Referenced via ${CLAUDE_PLUGIN_ROOT}
  templates/                     # Referenced via ${CLAUDE_PLUGIN_ROOT}
```

> **Rundown Plugin** (additional directories):

```text
  runbooks/                      # Auto-discovered
  context/                       # Auto-discovered
  rundown-plugin.json            # Rundown plugin config
```

---

## See Also

- [path-resolution.md](path-resolution.md) - Complete resolution mechanics
- [skills-and-hooks.md](skills-and-hooks.md) - Detailed examples per component
- [Official: Plugins reference](https://code.claude.com/docs/en/plugins-reference) - Canonical source
