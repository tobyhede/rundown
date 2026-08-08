# 608 PR 13 addendum — ignore unreleased JSON state

**Decided:** 2026-08-02

**Tracks:** [#648](https://github.com/tobyhede/rundown/issues/648)
**Supersedes:** All legacy-state detection, warning, refusal, and `RD-305`
requirements for PR 13 in
[2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md),
[2026-07-23-608-pr13-single-store-cutover.md](2026-07-23-608-pr13-single-store-cutover.md),
[2026-07-27-608-pr09-pr14-correction-ledger.md](2026-07-27-608-pr09-pr14-correction-ledger.md),
and
[2026-08-02-608-pr13-planning-audit-current-status.md](2026-08-02-608-pr13-planning-audit-current-status.md)

## Decision

Rundown has not been released. PR 13 will not recognize pre-cutover JSON run or
session files as a supported persisted-state generation.

`.rundown/rundown.db` is the sole run/session authority. Existing files at the
old JSON locations are inert filesystem data:

```text
.rundown/session.json
.rundown/runs/<run-id>.json
.claude/rundown/session.json
```

Production code must not read, parse, migrate, hydrate, validate, warn about,
refuse because of, delete, rewrite, or otherwise touch those files.

Their presence does not prevent opening or creating `.rundown/rundown.db`.

## Removed PR 13 scope

Do not implement any of the following:

- `detectLegacyRunbookState`;
- `openAuthoritativeRunbookStore`;
- `Errors.legacyRunbookState`;
- an `RD-305` legacy-path refusal distinct from the existing incompatible
  schema-version error;
- `legacyPaths` in an error envelope;
- registry scans of `.rundown/session.json` or `.rundown/runs/*.json`;
- `LEGACY_SESSION_FILE`, `RunbookStateManager.warnIfLegacyStateExists`, its
  process-wide warning flag and call, and tests expecting the
  `.claude/rundown/session.json` warning;
- CLI messaging that asks users to finish, prune, remove, or migrate old JSON
  state;
- process tests whose purpose is proving refusal before database creation.

The existing `Errors.incompatibleStateSchema(foundVersion, expectedVersion)`
continues to cover an incompatible schema encountered through an authority the
current application actually opens. This addendum does not change that error.

## Required cutover behavior

`StoreRegistry` remains the sole production driver/store opener and opens the
SQLite store without consulting old JSON paths.

The cutover must still remove every production JSON authority reader and writer.
Ignoring old files is safe only because no current decision can observe them.

The behavioral contract is:

```text
old JSON exists
       +
SQLite absent or present
       ↓
open the SQLite authority normally
       ↓
leave old JSON byte-identical
```

No mixed mode exists: ignored files do not participate in reads, writes,
discovery, active-run selection, claim lookup, status, pruning, or recovery.

## RED and regression coverage

Add focused coverage at the registry/store boundary proving:

1. arbitrary bytes at all three inert paths do not affect a clean SQLite open;
2. concurrent in-process registry callers still converge on the normal shared
   SQLite store;
3. the old files remain present and byte-identical after open, a representative
   run/session write, store close, and reopen;
4. `.rundown/runs/<run-id>/outputs/**` remains supported artifact storage and is
   not confused with run-state authority;
5. prune leaves direct legacy JSON files untouched if its existing cleanup path
   could otherwise target them.

Tests should use deliberately invalid JSON or arbitrary bytes. Valid-looking
fixtures could pass because a hidden reader happens to accept them; invalid bytes
prove the files are not parsed at all.

Do not add a general recursive scan or a matrix across every CLI command to prove
absence. Pin the focused behavior above, add one representative CLI smoke test
only if needed, and use precise source inventories to prove no production
reader/writer remains.

## Policy and path cleanup

The sandbox policy does not determine whether a path is execution authority.
Authority comes only from production readers and writers.

- Remove the obsolete exact `.rundown/session.json` write grant.
- Retain the current `.rundown/runs/**` allowance while captured outputs require
  it. The current OS policy mapper cannot precisely express
  `runs/<id>/outputs/**` without granting the broader concrete prefix.
- Do not add a deny glob for legacy run JSON. Linux drops deny rules, while the
  macOS mapper may recursively enumerate matching paths; that would create the
  forbidden legacy-state scan without producing a portable guarantee.
- Retain the existing database, WAL, SHM, artifact-manifest, and lock-directory
  permissions. Do not broaden `.rundown/**` or claim coverage for sql.js
  database-adjacent lock/temp files without a separate path and policy audit.

Remove `SESSION_FILE`, `sessionPath`, and JSON `statePath` helpers once precise
caller searches reach zero. Retain `RUNS_DIR` and `runsDir` for artifact outputs.

The retained broad output allowance does not make direct JSON files authoritative
and does not authorize production code to touch them. A more precise sandbox
representation, if desired, is a separate policy-design change.

## Output-contract cleanup

The absence of refusal does not make fictional JSON metadata acceptable.

- Remove `runbook_started.statePath` and update its event type, schemas,
  renderers, snapshots, tests, and documentation together.
- Keep the existing general metadata `state` field but report the actual
  authority path, `.rundown/rundown.db`, rather than
  `.rundown/runs/<run-id>.json`.

## Domain-lock scope is unchanged

This addendum changes only the treatment of unreleased JSON state. It does not
relax the PR 12 prerequisite or the PR 13 lock-deletion proof.

PR 13 must still wait until PR 12 has made delegate, collect, and abort
transactional and removed every production `CompletionLock` / `DelegationLock`
dependency. PR 13 then deletes the four obsolete core domain locks while
retaining sql.js, artifact-manifest, execution-liveness, and plugin-local file
locking.

## Validation

Use the repository-current validation sequence:

1. focused registry/store ignored-file regressions;
2. policy, path, event, renderer, schema, and CLI contract tests;
3. concurrent process initialization against the same database with inert JSON
   present, asserting a valid schema/integrity result and byte-identical inert
   files;
4. `pnpm run build` before CLI suites that resolve core through `dist`;
5. `git diff --check` and targeted formatting/lint checks;
6. `pnpm run test:mutate:changed`, with non-zero instrumentation and explicit
   disposition of every in-scope survivor or `NoCoverage` mutant;
7. `pnpm run verify` before push.
