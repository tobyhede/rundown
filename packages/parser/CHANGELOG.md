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

### Patch Changes

- 4c8bc40: Clear the 87 OSV-Scanner findings that have failed the scheduled scan
  on `main` since 2026-09-28.

  Dependencies that carry a published fix are upgraded. The packages' declared
  ranges move for `zod` (`^4.6.7`), `shell-quote` (`^1.12.0`) and
  `@modelcontextprotocol/sdk` (`^1.32.0`); the site's `astro` moves to `^7.4.7`.
  The rest are transitive and are fixed by a targeted lockfile refresh inside
  the ranges their parents already declare, plus raised floors on the existing
  `qs`, `fast-uri` and `hono` overrides.

  `@rundown-org/cli` no longer depends on `minimatch`. Nothing in the CLI
  imported it, and it was the only path that put a vulnerable `minimatch` into a
  published package's production dependencies.

  Two advisories remain and are accepted in `.osv-scanner.toml` until
  2027-02-01: `glob` (GHSA-3g3m-2fjr-6pw4) and `minimatch`
  (GHSA-g3hv-75wg-m249). Each is fixed only by a new major that jest and Stryker
  do not yet allow, and the vulnerable copies are development tooling that is
  never shipped.
