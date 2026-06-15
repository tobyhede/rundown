# Plugin Directory Structure

How to organize a Claude Code plugin so file references work correctly.

---

## Standard Layout

```text
my-plugin/
  .claude-plugin/
    plugin.json              # Manifest (name, version, description)
  commands/                  # Slash commands (legacy; use skills/ for new skills)
    status.md
  agents/                    # Subagent definitions
    reviewer.md
  skills/                    # Skills (each subdirectory has SKILL.md)
    code-review/
      SKILL.md
      scripts/               # Supporting files alongside SKILL.md
  hooks/
    hooks.json               # Hook configuration
  .mcp.json                  # MCP server definitions
  .lsp.json                  # LSP server configurations
  settings.json              # Default settings (only "agent" key supported)
  scripts/                   # Hook and utility scripts
    format-code.sh
  templates/                 # Templates referenced by skills
    review.md
  README.md
  LICENSE
```

### Rundown Plugin: Additional Directories

> **Rundown Plugin:** The following directories are specific to the rundown plugin, not standard Claude Code components.

```text
my-plugin/
  runbooks/                  # Auto-discovered runbooks
    planning/
      write-plan.runbook.md
  context/                   # Auto-discovered context injection files
    prompt-submit.md
  rundown-plugin.json        # Rundown plugin configuration
```

Note: The `context/` directory is aspirational — no files currently ship with the rundown plugin, and it is not listed in the `package.json` `files` array.

### Critical Rules

1. **Only `plugin.json` goes inside `.claude-plugin/`**. All component directories (`commands/`, `agents/`, `skills/`, `hooks/`) must be at the plugin root.

2. **Auto-discovered directories** are found by convention:
   - `commands/` - Slash commands (legacy; use `skills/` for new skills)
   - `agents/` - Subagent definitions
   - `skills/` - Agent Skills
   - `hooks/hooks.json` - Hook config
   - `.mcp.json` - MCP servers
   - `.lsp.json` - LSP servers

3. **Custom paths supplement, not replace**. If you specify `"commands": "./custom/cmd.md"` in `plugin.json`, the default `commands/` directory is still scanned.

---

## What Gets Published

For npm-based plugins, only files listed in `package.json` `files` array are included:

```json
{
  "files": [
    "dist",
    ".claude-plugin",
    "commands",
    "hooks",
    "runbooks",
    "rundown-plugin.json",
    "scripts",
    "skills",
    "templates",
    "README.md"
  ]
}
```

**Source:** `packages/claude-code-plugin/package.json`

For marketplace plugins, the entire plugin directory is copied to `~/.claude/plugins/cache/`. Only files physically inside the directory are included.

---

## Plugin Caching

Marketplace-installed plugins are copied to `~/.claude/plugins/cache/` rather than used in-place:

```text
~/.claude/plugins/cache/
  my-plugin@my-marketplace/
    1.0.0/
      my-plugin/
        .claude-plugin/
        skills/
        ...
```

### Implications

| Behavior | Implication |
|----------|-------------|
| Files are copied | External references (`../shared/`) break |
| `${CLAUDE_PLUGIN_ROOT}` changes on update | Don't write files there |
| Symlinks are honored during copy | Use symlinks for shared dependencies |
| Cache is local to the user | Different users have different absolute paths |

### `--plugin-dir` Bypasses Caching

During development, `--plugin-dir ./my-plugin` uses the directory in-place. No copying occurs. This means:
- `../` references may work locally but break after installation
- Changes are picked up immediately (use `/reload-plugins`)
- This is the recommended development workflow
- When a local plugin has the same name as a marketplace plugin, the local takes precedence. Exception: marketplace plugins force-enabled by managed settings cannot be overridden.

---

## Manifest (`plugin.json`)

Minimal:
```json
{
  "name": "my-plugin"
}
```

Full:
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": { "name": "You", "email": "you@example.com" },
  "homepage": "https://docs.example.com",
  "repository": "https://github.com/you/plugin",
  "license": "MIT",
  "keywords": ["deployment", "ci-cd"],
  "commands": ["./custom/commands/deploy.md"],
  "agents": "./custom/agents/",
  "skills": "./custom/skills/",
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "lspServers": "./.lsp.json",
  "outputStyles": "./styles/"
}
```

### Path Rules in `plugin.json`

- All paths must be relative to plugin root
- All paths must start with `./`
- Path traversal outside plugin root is rejected
- Paths supplement default locations (don't replace them)

---

## Rundown Plugin: Concrete Example

The `@rundown-org/claude-code-plugin` uses this layout:

```text
packages/claude-code-plugin/
  .claude-plugin/
    plugin.json                    # name: "rundown"
  dist/                            # Compiled TypeScript
  skills/
    rundown/SKILL.md               # generic launcher: /rundown <runbook>
    planning/SKILL.md              # runbook: rundown:planning (bootstrap skill)
    running-runbooks/SKILL.md
    writing-runbooks/SKILL.md
    writing-plans/SKILL.md
    executing-plans/SKILL.md
    delegating-runbooks/SKILL.md
    converting-skills-to-runbooks/SKILL.md
    end-to-end-testing/SKILL.md
  runbooks/
    planning/planning.runbook.md
    planning/write-plan.runbook.md
    end-to-end-test/...
    patterns/...
  templates/
    planning/...
  hooks/
    hooks.json                     # SessionStart, SkillStart, and other gates
  schemas/
  scripts/
  src/                             # Gate and hook implementation
  rundown-plugin.json              # Gate and hook configuration
```

Key patterns:
- Skills reference runbooks and templates via `${CLAUDE_PLUGIN_ROOT}`
- Runbooks are auto-discovered from the `runbooks/` directory
- A **bootstrap skill** declares a `runbook:` frontmatter field; the `SkillStart`
  gate auto-runs that runbook and hands off to `running-runbooks` (e.g.
  `planning` → `runbook: rundown:planning`). The generic `rundown` launcher
  starts any runbook by name without a dedicated skill.
- Config merges plugin defaults with project overrides
