# Dependency overrides & vulnerability policy

How Rundown handles transitive-dependency vulnerabilities. This is a descriptive
doc: it reflects the mechanism in place today.

## The decision order

When OSV-Scanner (or dependabot, or a manual audit) flags a vulnerable
dependency, resolve it with the **most correct mechanism that works**, in this
order:

1. **Bump the direct dependency.** If the vulnerable package is reachable
   through a direct dep we declare (e.g. `astro`, `eslint`,
   `@modelcontextprotocol/sdk`), updating that dep — usually via dependabot — is
   the root fix. It leaves no pin to maintain. Prefer this whenever a released
   version of the parent carries the fix.

2. **Add a scoped override in `pnpm-workspace.yaml`.** For a **transitive-only**
   vulnerability where no parent bump is available, an override is pnpm's only
   lever: `pnpm update` does not move deep transitives, so a stale-but-in-range
   copy stays put until a pin forces it. This is a legitimate, necessary use of
   overrides — not the anti-pattern. Every override must be justified in
   `override-policy.json` (below) and removed when the parent catches up.

3. **Ignore with a reason and a date in `.osv-scanner.toml`.** When even an
   override can't reach the fix — the only patched version is a **major** the
   parent forbids (e.g. `@hono/node-server` 2.x under
   `@modelcontextprotocol/sdk`'s `^1.19.9`) — and the vulnerable code path is
   unreachable, record a dated `[[IgnoredVulns]]` entry. The `ignoreUntil` date
   forces re-review; do not extend it without re-checking whether the fix has
   become reachable.

**A pin is never justified by "the parent merely allows a newer version."** That
is a lockfile-staleness problem. The test for whether an override is still
needed is empirical: delete it, `pnpm install`, run `osv-scanner` — if nothing
regresses, the parent has caught up and the pin is dead cruft; remove it.

## Two override categories

Every entry in `pnpm-workspace.yaml`'s `overrides:` is one of:

- **Category A — the parent forbids the fixed version** (out-of-range force).
  The declaring package pins a range that excludes the patched version, so the
  override overrules it. Example: `yaml-language-server` hard-pins `yaml 2.7.1`;
  the override forces `^2.8.3`. The three `js-yaml ^4.2.0` pins are Category A
  and additionally need `patchedDependencies` (their consumers call the removed
  3.x `safeLoad`/ `safeDump`).
- **Category B — the fix is in-range but pnpm resolves a vulnerable version
  without the pin.** The parent's range already allows the fix, but resolution
  picks an older in-range copy and `pnpm update` won't budge a deep transitive.
  The override nudges it to the patched version. Example: `hono ^4.12.27` (the
  MCP SDK declares `^4.11.4`). Remove a Category B pin once the parent ships a
  release that resolves the fixed version on its own.

## `override-policy.json` is the source of truth

Every override has a dated, CVE-annotated entry in `override-policy.json`:

```json
"qs": {
  "override": "^6.15.2",
  "category": "B",
  "ghsa": ["GHSA-q8mj-m7cp-5q26"],
  "reason": "…why the pin exists and when it can go…",
  "added": "2026-06-16",
  "reviewBy": "2026-10-01"
}
```

## The gate

`scripts/__tests__/pnpm-workspace-config.test.mjs` (run by `pnpm verify` via
`test:unit:scripts`, and in CI) enforces:

- **1:1 correspondence** — every override in `pnpm-workspace.yaml` has a policy
  entry and vice-versa. Adding a pin without a justification fails CI; so does
  leaving a stale entry after dropping a pin.
- **Version match** — the override value equals the policy's recorded
  `override`, so a silently downgraded pin (which can un-patch a CVE) fails
  against its own record.
- **Well-formed metadata** — each entry has a valid category, a non-empty GHSA
  list, a substantive reason, and ISO `added` / `reviewBy` dates.
- **No dead per-package blocks** — pnpm 11 reads overrides only from
  `pnpm-workspace.yaml`; an `overrides` field in any package's `package.json` is
  ignored and therefore banned as misleading.

This is what "stops a new override being added": not a hard block
(genuinely-needed overrides are allowed) but a **justification gate** — an
override cannot merge without a dated, CVE-annotated entry that a reviewer signs
off on.

## Removal cadence

`reviewBy` dates and OSV `ignoreUntil` dates are the recurring prompt to prune.
When a date comes due, test each Category B pin and each ignore for removal
(delete, install, scan). The goal is a shrinking override set, not a growing
one.
