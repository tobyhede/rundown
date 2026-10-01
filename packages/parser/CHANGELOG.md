# @rundown-org/parser

## 2.0.0

### Major Changes

- 2e0b7d7: # BREAKING: Move runbook state storage from `.claude/rundown/` to
  `.rundown/`

  State files, session tracking, and delegation locks are now stored under
  `.rundown/` instead of `.claude/rundown/`. No automatic migration is
  performed.

  **Upgrade instructions:**

  1. Complete or abort any in-flight runbooks _before_ upgrading.
  2. Update `.gitignore` — replace `.claude/rundown/` entries with:

     ```text
     .rundown/work/
     .rundown/runs/
     .rundown/session.json
     .rundown/locks/
     ```

  3. Move any project-local runbooks from `.claude/rundown/runbooks/` to
     `.rundown/runbooks/`.
  4. After confirming no in-flight runs, remove the old `.claude/rundown/`
     directory.

  The CLI will print a warning on startup if state is detected in the legacy
  location.

- 2d03652: BREAKING: Raise minimum Node.js version to >=24.0.0. This enables use
  of `Error.isError()` (TC39) and other Node 24 features across the codebase.
