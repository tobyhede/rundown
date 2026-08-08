# site/CLAUDE.md

Rundown marketing website - Astro site with interactive runbook demo.

## Commands

```bash
pnpm run check:types:site               # astro check — typechecks .astro, .ts and the React islands
pnpm run verify:site                    # Build the snapshot and run Playwright
pnpm --filter site run build:snapshot  # Build the WebContainer snapshot
pnpm --filter site build               # Build the site to dist/
```

## Verifying a site change

Two tiers, and they catch different things.

**Static — `pnpm run check:types:site` (`astro check`), ~5s.** Part of the root `check:types`, so `pnpm run verify` runs it. It understands `.astro` files and the React islands, and the site tsconfig turns on `exactOptionalPropertyTypes` on top of `astro/tsconfigs/strict` — that option is not decoration: without it `{ recursive: someOptionalBoolean }` is assignable to `{ recursive?: boolean }`, which is exactly how an explicit `undefined` reached WebContainer's `fs.rm` (it type-checks the option at runtime and rejects) and shipped. Run it on every edit; it needs no snapshot, no server, and no browser.

**Behavioural — `pnpm run verify:site`, minutes.** Builds the snapshot and runs Playwright. This is the only thing that exercises the demo end to end, and it is not part of `verify` because the cost lands on every contributor for a directory most changes never touch. Run it whenever you touch `site/src`.

```bash
pnpm run check:types:site   # fast; also runs inside `pnpm run verify`
pnpm run verify:site        # builds the snapshot, then runs Playwright
```

**What still has no gate here:** Biome and cspell both exclude `site` (`biome.json`'s `"!site"`, `cspell.json`'s `ignorePaths`), and `.prettierignore` lists `site/**`. Formatting and spelling in this directory are unchecked — match the surrounding file by hand rather than running a formatter, which would reformat the whole tree.

**Use `pnpm run verify:site` rather than calling Playwright directly.** The command builds the snapshot and manages the Astro server for the suite. If it reports that it is reusing a server already listening on port 4321, confirm that server belongs to this worktree or stop it before rerunning; otherwise you may test a different checkout's code.

`public/rundown-snapshot.bin` is not committed — it must exist on disk before `astro dev` or Playwright will work. CI builds it automatically.

## Homepage Architecture

The homepage IS the demo - an interactive runbook runner that lets visitors experience Rundown firsthand.

**Key files:**
- `public/this-is-rundown.runbook.md` - 6-step runbook with 3 scenarios (rundown, retry, start)
- `src/components/HomepageRunner.astro` - Split view: source markdown (left) + interactive CLI runner (right)
- `src/components/Hero.astro` - Minimal hero with logo and GitHub link
- `src/components/interactive/RunbookRunner.tsx` - React component with Xterm.js terminal

**How it works:**
- HomepageRunner loads the runbook at build time
- RunbookRunner uses WebContainer API for in-browser CLI execution
- Visitors can run scenarios or type commands directly

## Tech Stack

- Astro 7 (static output)
- Tailwind CSS 4.x (@tailwindcss/vite)
- WebContainer API (in-browser Node.js)
- React + Xterm.js (terminal component)
- Deployed to Cloudflare Pages

## Structure

- `src/components/` - Astro components (Hero, HomepageRunner)
- `src/components/interactive/` - React components (RunbookRunner, terminal)
- `src/layouts/` - Page layouts
- `src/pages/` - Routes (index.astro)
- `public/` - Static assets and runbooks

## Theme

CSS variable-based color system in `tailwind.config.mjs`:
- `background` / `foreground` - Base colors via `hsl(var(--background))`
- `muted` / `muted-foreground` - Secondary colors
- `border` - Border color
- Font: JetBrains Mono / Fira Code monospace

Colors are defined as CSS variables in the base styles, enabling dark mode support via the `darkMode: 'class'` configuration.

## WebContainer Architecture

The site runs Rundown in the browser using WebContainer API. Key architecture decisions:

**Snapshot-based mounting:**
- `public/rundown-snapshot.bin` contains pre-built CLI for fast boot
- Avoids npm install in browser - mounts snapshot directly
- Built via `pnpm --filter site run build:snapshot` (or `pnpm --filter site build`)
- **Not committed to git** — must be built locally before running dev server or tests

**Size budget and pruning (issue #639):** the snapshot is a single static file under Cloudflare Pages' 25 MiB per-file cap, kept small by `scripts/prune-sqljs.mjs` + `scripts/prune-non-runtime.mjs` and guarded by a 12 MiB build assertion in `scripts/snapshot-budget.mjs`. See [docs/internal/architecture.md § Site snapshot](../docs/internal/architecture.md#site-snapshot-size-budget-and-pruning) for the design.

**Spawn limitation workaround:**
- WebContainer's nested `child_process.spawn()` doesn't propagate stdio properly
- Solution: Internal command dispatcher in `packages/cli/src/services/internal-commands.ts`
- When runbook executes `rd echo ...`, the CLI intercepts it and calls the echo logic directly
- Bypasses spawn entirely for supported commands (currently: `echo`)
- Unsupported commands fall back to spawn (works for top-level execution)

**`.rundown/` paths are a checked mirror, not free-hand strings:**
- `src/lib/rundown-paths.ts` holds every `.rundown/` path the site touches. The site cannot import `packages/core/src/paths.ts` — it is a Node module that imports `node:fs`, and this code runs in a browser — so the constants are copied.
- `src/lib/rundown-paths.parity.ts` makes that copy load-bearing: `import type` only (erased at build, nothing from core reaches the bundle) plus a type-level equality assertion per constant, so a rename in core fails `astro check` naming the constant that drifted.
- The `-wal`/`-shm` sidecars are covered too: core exports them as `DB_SIDECAR_SUFFIXES` (`packages/core/src/paths.ts`), and the site's mirror is compared against it element by element like any other constant. `DB_FILES` still derives its entries from that tuple, so `cleanRundownState` has no per-sidecar line to delete — deleting one by hand would leave the demo booting on the previous run's WAL.
- The parity check compares **literal** types, and its `IsLiteral` conjunct is what keeps that true: `Same<string, string>` holds for any two values, so annotating a constant `: string` (or the suffix tuple `: readonly string[]`) on both sides would otherwise disarm the check while leaving it green. Widening either side is now itself the type error. Keep every constant in `rundown-paths.ts` on its inferred literal type.

**Key files:**
- `src/lib/webcontainer.ts` - WebContainer setup and snapshot mounting
- `packages/cli/src/services/internal-commands.ts` - Command interception
- `packages/cli/src/helpers/echo-command.ts` - Shared echo logic for CLI and internal execution
