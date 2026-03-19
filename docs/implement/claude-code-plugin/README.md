# Claude Code Plugin: File Path Handling

**Status:** Verified against official docs + source code
**Last Verified:** 2026-03-19

---

## TL;DR

Claude Code plugins use two environment variables for all file references: `${CLAUDE_PLUGIN_ROOT}` (read-only, points to plugin installation, changes on update) and `${CLAUDE_PLUGIN_DATA}` (read-write, persists across updates). Both are substituted inline in skill content, agent content, hook commands, and MCP/LSP configs. Marketplace plugins are cached to `~/.claude/plugins/cache/`, so path traversal outside the plugin root breaks after installation.

---

## Reading Paths

### Option A: "Just the rules" (2 minutes)
1. Read [QUICK-REFERENCE.md](QUICK-REFERENCE.md)
2. Done

### Option B: "I need to build a plugin" (30 minutes)
1. Read this README
2. Read [path-resolution.md](path-resolution.md)
3. Read [plugin-structure.md](plugin-structure.md)
4. Reference [QUICK-REFERENCE.md](QUICK-REFERENCE.md) during implementation

### Option C: "I'm debugging path issues" (15 minutes)
1. Read [QUICK-REFERENCE.md](QUICK-REFERENCE.md) diagnosis table
2. Read [path-resolution.md](path-resolution.md) for the resolution chain
3. Check [design-decisions.md](design-decisions.md) for caching gotchas

### Option D: "I need the full picture" (1 hour)
1. Read all documents in sequence (see [00-START-HERE.md](00-START-HERE.md))

---

## Role-Based Paths

### If You're Writing a New Plugin
**Goal:** Structure files correctly so paths work after marketplace installation
**Reading order:** [plugin-structure.md](plugin-structure.md) then [skills-and-hooks.md](skills-and-hooks.md) then [QUICK-REFERENCE.md](QUICK-REFERENCE.md)
**Time:** ~20 minutes
**Takeaway:** Every file reference must use `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}`. No `../`, no hardcoded paths.

### If You're Extending an Existing Plugin
**Goal:** Add skills/hooks that reference bundled files
**Reading order:** [skills-and-hooks.md](skills-and-hooks.md) then [QUICK-REFERENCE.md](QUICK-REFERENCE.md)
**Time:** ~10 minutes
**Takeaway:** Use `${CLAUDE_PLUGIN_ROOT}` in frontmatter and content for bundled files. Use `${CLAUDE_PLUGIN_DATA}` for persistent state.

### If You're Debugging Path Failures
**Goal:** Understand why a path reference isn't working
**Reading order:** [path-resolution.md](path-resolution.md) then [design-decisions.md](design-decisions.md)
**Time:** ~15 minutes
**Takeaway:** The plugin cache copies files but not external references. Check if your file is in the `files` array and inside the plugin root.

---

## Key Concepts

### Two Environment Variables

| Variable | Purpose | Persists? | Writable? |
|----------|---------|-----------|-----------|
| `${CLAUDE_PLUGIN_ROOT}` | Bundled files (scripts, templates, configs) | No (changes on update) | No |
| `${CLAUDE_PLUGIN_DATA}` | Plugin state (deps, caches, generated files) | Yes (survives updates) | Yes |

**See:** [path-resolution.md](path-resolution.md)

### Plugin Caching

Marketplace plugins are copied to `~/.claude/plugins/cache/`. This means:
- Files outside the plugin directory are unreachable
- `${CLAUDE_PLUGIN_ROOT}` changes on every update
- Only files listed in `package.json` `files` array ship

**See:** [design-decisions.md](design-decisions.md)

### Discovery vs Explicit Reference

Some file types are auto-discovered by convention. Others require explicit `${CLAUDE_PLUGIN_ROOT}` references.

**Standard Claude Code:**

| Type | Auto-discovered? | Reference Pattern |
|------|-------------------|-------------------|
| Skills | Yes (`skills/`) | By directory convention |
| Commands | Yes (`commands/`) | By directory convention (legacy; use `skills/`) |
| Agents | Yes (`agents/`) | By directory convention |
| Hooks config | Yes (`hooks/`) | Also via path in `plugin.json` |
| Templates | No | `${CLAUDE_PLUGIN_ROOT}templates/...` |
| Scripts | No | `${CLAUDE_PLUGIN_ROOT}scripts/...` |

> **Rundown Plugin:**

| Type | Auto-discovered? | Reference Pattern |
|------|-------------------|-------------------|
| Runbooks | Yes (`runbooks/`) | Also via `${CLAUDE_PLUGIN_ROOT}runbooks/...` |
| Context files | Yes (`context/`) | By naming convention only |
| Config | No | `rundown-plugin.json` in plugin root or project |

**See:** [plugin-structure.md](plugin-structure.md)

---

## Verification Status

| Document | Status | Notes |
|----------|--------|-------|
| [path-resolution.md](path-resolution.md) | Verified | Cross-checked with source code + official docs |
| [plugin-structure.md](plugin-structure.md) | Verified | Matches `package.json` `files` array and official layout |
| [skills-and-hooks.md](skills-and-hooks.md) | Verified | Patterns confirmed in rundown plugin source |
| [design-decisions.md](design-decisions.md) | Verified | Rationale from official docs |
| [QUICK-REFERENCE.md](QUICK-REFERENCE.md) | Verified | Derived from above documents |

---

## Related Resources

- **Official:** [Create plugins](https://code.claude.com/docs/en/plugins) - Plugin creation guide
- **Official:** [Plugins reference](https://code.claude.com/docs/en/plugins-reference) - Complete technical spec
- **Internal:** `packages/claude-code-plugin/` - This project's plugin implementation
- **Internal:** `packages/cli/src/services/discovery.ts` - Runbook discovery chain
