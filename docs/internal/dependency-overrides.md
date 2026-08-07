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
  the override forces `^2.8.3`. The `gray-matter` / `read-yaml-file` /
  `@istanbuljs/load-nyc-config` `js-yaml ^4.3.1` pins are Category A and
  additionally need `patchedDependencies` (their consumers call the removed 3.x
  `safeLoad`/ `safeDump`).
- **Category B — the fix is in-range but pnpm resolves a vulnerable version
  without the pin.** The parent's range already allows the fix, but resolution
  picks an older in-range copy and `pnpm update` won't budge a deep transitive.
  The override nudges it to the patched version. Example: `hono ^4.12.34` (the
  MCP SDK declares `^4.11.4`). Remove a Category B pin once the parent ships a
  release that resolves the fixed version on its own.

## Raise the floor; don't duplicate a selector

When a **new** advisory lands on a package that already has a pin, the failure
mode is a **silent no-op**: the locked version still satisfies the existing
floor, so pnpm has no reason to move it and the scanner keeps failing even
though an override is nominally "in place". The fix is to raise that entry's
floor to the new fixed version (in both `pnpm-workspace.yaml` and
`override-policy.json`, which the gate cross-checks), append the new GHSA to the
entry's `ghsa` list, and refresh `reviewBy`.

Raise the **existing** key rather than adding a second key with the **same
selector** — pnpm takes one pin per selector, so a duplicate is either ignored
or shadows the other. This is not a rule against several keys for one package:
different selector forms (`parent>child`, `pkg@selector`, bare `pkg`) are
distinct keys with defined specificity, and `js-yaml` deliberately carries six
`parent>child` keys (see the next section). Adding a key for a **new parent** is
correct and required; adding a second key with a selector you already have is
the mistake.

The 2026-08-07 sweep is the worked example: seven entries across five packages —
`fast-uri`, `hono`, `postcss`, and the three Category A `js-yaml` pins — had
floors that had fallen below a newly-published fixed version, and three new
`parent>js-yaml` keys were added for parents no existing key covered.

**A raise is also a re-test.** Before raising, re-check whether the pin is still
needed at all: upstream may have backported the fix to the major the parent
declares, which retires the pin outright. The same sweep **removed**
`brace-expansion` for exactly that reason — see the next-but-one section.

## Scope a `js-yaml`-style pin per parent, not by version selector

`parent>child` is a **subtree scope**; `child@<selector>` is a **version
selector** that still applies tree-wide. They are not interchangeable, and the
distinction is load-bearing for `js-yaml`.

Six parents pull `js-yaml` here. Three (`gray-matter`, `read-yaml-file`,
`@istanbuljs/load-nyc-config`) declare `^3.x` and are forced up (Category A);
three (`astro`, `@astrojs/internal-helpers`, `@changesets/parse`) declare
`^4.1.1` and are merely nudged (Category B). A single blanket
`"js-yaml@4": "^4.3.1"` looks like a tidy shortcut and is a trap: the `@4`
selector does not intersect a `^3.x` declaration, so the Category A trio falls
back to `3.15.1`. That silently un-patches them — `patches/gray-matter@4.0.3`
and `patches/read-yaml-file@1.1.0` rewrite `safeLoad`/`safeDump` to
`load`/`dump`, which is the **safe** schema only on 4.x; on 3.x `load` is the
full/unsafe loader. It also leaves a bogus `js-yaml@4` entry in the lockfile.
Always key these per parent.

## A backport can retire a pin — re-check the advisory, not just the pin

A Category A justification ("no fixed release exists on the line the parent
declares") is a claim about the **advisory at a moment in time**, and advisories
are edited. When a maintainer backports a fix to an older major, OSV is updated
in place and a pin that was genuinely load-bearing silently becomes redundant —
and stays redundant, because nothing re-reads the justification.

`brace-expansion` is the worked example, removed on 2026-08-07. It was added as
a blanket `^5.0.8` Category A pin when the only fixed release really was on the
5.x line, forcing minimatch@3's `^1.1.7` and minimatch@9's `^2.0.2` subtrees
cross-major to v5. Upstream then backported every advisory (GHSA-mh99-v99m-4gvg
was re-modified **after** the pin was added and now lists 1.1.17 / 2.1.3 / 3.0.3
/ 5.0.8; GHSA-rgw5-rvv9-x895 lists 1.1.18 / 2.1.4 / 3.0.6 / 5.0.9), so every
parent could reach a patched version inside its own declared range and no parent
forbade anything.

Leaving it was not merely untidy. A blanket cross-major force drags the new
major's constraints into subtrees that never asked for them: v5 declares
`engines: node 20 || >=22` where v1 and v2 declare none, and applies a
`maxLength` bound, so a large legitimate brace expansion in an eslint/jest/
stryker glob could throw or truncate where no advisory required it.

The lesson generalises: **when an advisory is re-flagged or a pin is raised,
re-read the advisory's fixed-version list before touching the floor.** If a
backport has landed, remove the pin (run the removal test) rather than raising
it. If a pin is still needed but only for some parents, prefer a scoped
`parent>child` key over a blanket cross-major force.

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
