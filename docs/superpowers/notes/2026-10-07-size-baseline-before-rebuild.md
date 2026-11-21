# Size baseline before the delegation rebuild

> **Status:** Measurement record for the [ADR 0005](../../adr/0005-one-writer-per-run.md) size gates, taken on branch `899-delegation-rebuild` at the commit that adds `scripts/measure-size.mjs`, before any rebuild code lands (#901). The number is the starting point the rebuild is measured against, not a target.

## Command

```bash
node scripts/measure-size.mjs --text    # or: pnpm run check:size
```

The file lists live in `scripts/size-allowlist.json`. Lines are counted with `wc -l` semantics (newline count) over the `src` files listed there.

## Result

| List        | Lines  | Gate  | Files |
| ----------- | ------ | ----- | ----- |
| `authority` | 20,232 | 6,400 | 53    |
| `machinery` | 35,355 | 8,600 | 36    |

Both totals are over their gates: `authority` by about 3.2x and `machinery` by about 4.1x. No listed file was missing.

The largest single contributors are `packages/core/src/runbook/compiler.ts` (6,088), `packages/core/src/runbook/lifecycle-command-service.ts` (4,466), `packages/core/src/runbook/storage/runbook-store.ts` (3,028) and `packages/core/src/runbook/run-progression.ts` (2,638) on the `machinery` list, and `packages/core/src/runbook/session-service.ts` (2,473) on the `authority` list.

## Enforcement

`measure-size.mjs --enforce` exits 1 when a total exceeds its gate. It is not part of `verify` yet; #908 wires it in once the rebuild has brought the totals under the gates. Until then `check:size` is report-only.
