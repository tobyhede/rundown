# Referencing Files from Skills, Hooks, and Configs

Patterns for referencing bundled files from each plugin component.

---

## Skills

### Standard Skill Frontmatter Fields

All standard Claude Code skill frontmatter fields:

| Field                      | Type     | Description                          |
| -------------------------- | -------- | ------------------------------------ |
| `name`                     | string   | Skill name                           |
| `description`              | string   | When to use this skill               |
| `argument-hint`            | string   | Placeholder text for arguments       |
| `disable-model-invocation` | boolean  | Prevent model auto-invocation        |
| `user-invocable`           | boolean  | Whether users can invoke directly    |
| `allowed-tools`            | string[] | Restrict available tools             |
| `model`                    | string   | Override model for this skill        |
| `context`                  | string   | Set to `fork` for subagent execution |
| `agent`                    | string   | Subagent type (when `context: fork`) |
| `hooks`                    | object   | Lifecycle hooks scoped to this skill |

> **Rundown Plugin:** The `runbook:` and `template:` frontmatter fields are
> specific to the rundown plugin, not standard Claude Code features. See
> [Rundown-Specific: Runbook References in Frontmatter](#rundown-specific-runbook-references-in-frontmatter)
> below.

### Frontmatter References

Skills use `${CLAUDE_PLUGIN_ROOT}` in YAML frontmatter to declare associated
files:

```yaml
---
name: writing-plans
description: Write implementation plans
runbook: ${CLAUDE_PLUGIN_ROOT}/runbooks/planning/write-plan.runbook.md
template: ${CLAUDE_PLUGIN_ROOT}/templates/planning/plan.template.md
---
```

The `runbook:` field names the runbook a skill is built around. The skill body
instructs the agent to run `rd run <name>` — the plugin does not auto-start
runbooks from a hook. The field documents the association and supplies a
substituted path the agent can read.

Other frontmatter fields (like `template:`) are passed through as part of the
skill content. Claude sees the substituted path and can read the file.

**Source:** `packages/claude-code-plugin/skills/writing-plans/SKILL.md`

### Body References

Reference files anywhere in the skill body text:

```markdown
## Templates

Review template: `${CLAUDE_PLUGIN_ROOT}/templates/verify-review.md`
Collation template: `${CLAUDE_PLUGIN_ROOT}/templates/verify-collation.md`
```

Claude Code substitutes the variable before the content reaches the model.

**Source:** `packages/claude-code-plugin/skills/verifying-by-consensus/SKILL.md`

### Supporting Files

Skills can include supporting files alongside `SKILL.md`:

```text
skills/
  pdf-processor/
    SKILL.md
    reference.md        # Supporting documentation
    scripts/
      process.sh        # Supporting scripts
```

Reference them via `${CLAUDE_PLUGIN_ROOT}/skills/pdf-processor/reference.md`.

---

## Hooks

### Hook Handler Types

Claude Code supports four hook handler types:

| Type      | Description                                  |
| --------- | -------------------------------------------- |
| `command` | Execute shell command/script                 |
| `http`    | POST event JSON to a URL                     |
| `prompt`  | Evaluate prompt with LLM (uses `$ARGUMENTS`) |
| `agent`   | Run agentic verifier with tools              |

Claude Code supports 22+ hook events. See the
[official plugins reference](https://code.claude.com/docs/en/plugins-reference)
for the full event list.

> **Rundown Plugin:** The rundown plugin registers only two native hook events —
> `PreToolUse` (matcher `Agent|Task`) and `SubagentStop` — both routed to a
> single CLI dispatcher (`dist/cli.js`) over stdin. It does not subscribe to the
> broader event set. See [hook-behavior.md](hook-behavior.md). The examples
> below show the general Claude Code pattern.

### Command Hooks

Hook commands use `${CLAUDE_PLUGIN_ROOT}` to reference scripts:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format-code.sh"
          }
        ]
      }
    ]
  }
}
```

The variable is substituted before the command is executed. Scripts must be
executable (`chmod +x`).

### Persistent Dependencies in Hooks

Use `${CLAUDE_PLUGIN_DATA}` for dependencies that should survive plugin updates:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

This pattern:

1. Compares bundled `package.json` against stored copy
2. Reinstalls on first run or when dependencies change
3. Cleans up on failure so next session retries

---

## MCP Servers

MCP server configs use both variables for commands, args, env, and cwd:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/my-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${CLAUDE_PLUGIN_DATA}/data"
      },
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

For servers using persisted `node_modules`:

```json
{
  "mcpServers": {
    "routines": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
      "env": {
        "NODE_PATH": "${CLAUDE_PLUGIN_DATA}/node_modules"
      }
    }
  }
}
```

---

## LSP Servers

LSP configs support the same variable substitution:

```json
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    },
    "env": {
      "GOPATH": "${CLAUDE_PLUGIN_DATA}/gopath"
    }
  }
}
```

Note: LSP servers require the language server binary to be installed on the
user's machine. The plugin configures the connection, not the server itself.

Additional optional LSP fields include `transport`, `initializationOptions`,
`settings`, `workspaceFolder`, `startupTimeout`, `shutdownTimeout`,
`restartOnCrash`, and `maxRestarts`. See the
[official plugins reference](https://code.claude.com/docs/en/plugins-reference)
for details.

---

## Agents

Agent content supports the same variable substitution:

```markdown
---
name: security-reviewer
description: Reviews code for security issues
---

Use the security rules at `${CLAUDE_PLUGIN_ROOT}/rules/security-rules.md` for reference.
```

See also:
[official subagents documentation](https://code.claude.com/docs/en/plugins-reference#agents).

---

## Rundown-Specific: Runbook References in Frontmatter

The rundown plugin's skills name an associated runbook via the `runbook:` field
in SKILL.md frontmatter:

```yaml
runbook: ${CLAUDE_PLUGIN_ROOT}/runbooks/planning/write-plan.runbook.md
```

The field documents the association and provides a substituted path. The skill
body instructs the agent to run `rd run <name>`; the plugin does **not**
auto-start runbooks from a hook. Runbook execution is owned by the CLI and core.

Note: The `runbook:` frontmatter field is specific to the rundown plugin, not a
standard Claude Code feature. Standard skills use `${CLAUDE_PLUGIN_ROOT}` in the
body text for file references.
