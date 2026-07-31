# 608 Controlled Rebuild — PR 10 implementation deviations

**Supplements:**
[2026-07-30-608-pr10-addendum-current-main-adaptations.md](2026-07-30-608-pr10-addendum-current-main-adaptations.md).

The implementation review required the following paths outside that addendum's
inventory. The architectural reason for each path was recorded before final
verification:

- `packages/core/src/runbook/state.ts` and
  `packages/core/src/runbook/storage/runbook-store.ts` expose one atomic,
  read-only capture of the parent state plus its authority row. Preparing a
  machine mutation from separately loaded values would recreate the TOCTOU gap
  that PR 10 closes.
- `packages/core/src/output/zod-schemas.ts`, `packages/cli/src/commands/claim.ts`,
  `docs/reference/cli.md`, and `docs/spec/cli-output.md` register and document
  the existing canonical `CONCURRENT_MODIFICATION` refusal now emitted by the
  public claim path. Without these changes, a correct core refusal would fail
  schema validation or become an undocumented CLI output variant.

No database schema or persisted `RunbookState` schema changed. The SQLite schema
version and persisted state schema version therefore remain unchanged.
