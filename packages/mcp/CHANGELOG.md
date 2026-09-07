# @rundown-org/mcp

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

### Patch Changes

- Updated dependencies [a350173]
- Updated dependencies [91a2dab]
- Updated dependencies [bc12503]
- Updated dependencies [408eb0b]
- Updated dependencies [fb67bab]
- Updated dependencies [271b92b]
- Updated dependencies [7755171]
- Updated dependencies [07d998d]
- Updated dependencies [13de29a]
- Updated dependencies [a903483]
- Updated dependencies [8695941]
- Updated dependencies [da52ad6]
- Updated dependencies [562bd61]
- Updated dependencies [d6fa167]
- Updated dependencies [f504fe9]
- Updated dependencies [981dd79]
- Updated dependencies [dfdcae8]
- Updated dependencies [1596d86]
- Updated dependencies [1f591ef]
- Updated dependencies [58fc4f1]
- Updated dependencies [a6ee531]
- Updated dependencies [5e58b8b]
- Updated dependencies [526ea44]
- Updated dependencies [2e0b7d7]
- Updated dependencies [e20b2e2]
- Updated dependencies [2d03652]
- Updated dependencies [68c59ec]
- Updated dependencies [2a6073d]
- Updated dependencies [d9f22a0]
- Updated dependencies [6be11e7]
- Updated dependencies [14dcd01]
- Updated dependencies [23f11b9]
- Updated dependencies [4f90417]
- Updated dependencies [529c1f5]
- Updated dependencies [c082109]
- Updated dependencies [25251a6]
- Updated dependencies [39cb1ac]
  - @rundown-org/core@2.0.0
