# Claude Code Plugin: File Path Handling

**Status:** Verified against official docs + source code **Last Verified:**
2026-03-19 **Applies To:** Claude Code 1.0.33+, Plugin API v1

---

## Choose Your Path

| Time   | Goal                 | Start With                                                                                              |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------- |
| 2 min  | Just the rules       | [QUICK-REFERENCE.md](QUICK-REFERENCE.md)                                                                |
| 10 min | Understand the model | [README.md](README.md)                                                                                  |
| 30 min | Build a plugin       | README.md then [path-resolution.md](path-resolution.md) then [plugin-structure.md](plugin-structure.md) |
| 1 hour | Full understanding   | All documents in sequence below                                                                         |

## Reading Order (Full)

1. [README.md](README.md) - TL;DR + conceptual model
2. [path-resolution.md](path-resolution.md) - How paths are resolved at every
   layer
3. [plugin-structure.md](plugin-structure.md) - Directory layout and what gets
   published
4. [skills-and-hooks.md](skills-and-hooks.md) - Referencing files from skills,
   hooks, MCP/LSP configs
5. [design-decisions.md](design-decisions.md) - Why it works this way
6. [QUICK-REFERENCE.md](QUICK-REFERENCE.md) - Lookup table for daily use

## Package Contents

```text
claude-code-plugin/
  00-START-HERE.md           # You are here
  README.md                   # TL;DR + conceptual overview
  path-resolution.md          # Complete path resolution mechanics
  plugin-structure.md         # Directory layout + publishing rules
  skills-and-hooks.md         # File references in plugin components
  design-decisions.md         # Why: caching, security, env vars
  QUICK-REFERENCE.md          # One-page lookup
```
