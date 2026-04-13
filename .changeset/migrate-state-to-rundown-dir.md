---
'@rundown-org/parser': major
'@rundown-org/core': major
'@rundown-org/cli': major
'@rundown-org/mcp': major
'@rundown-org/claude-code-plugin': major
---

# BREAKING: Move runbook state storage from `.claude/rundown/` to `.rundown/`

State files, session tracking, and delegation locks are now stored under `.rundown/` instead of `.claude/rundown/`. No automatic migration is performed.

**Upgrade instructions:**

1. Complete or abort any in-flight runbooks *before* upgrading.
2. Update `.gitignore` — replace `.claude/rundown/` entries with:

   ```text
   .rundown/work/
   .rundown/runs/
   .rundown/session.json
   .rundown/locks/
   ```

3. Move any project-local runbooks from `.claude/rundown/runbooks/` to `.rundown/runbooks/`.
4. After confirming no in-flight runs, remove the old `.claude/rundown/` directory.

The CLI will print a warning on startup if state is detected in the legacy location.
