# site/CLAUDE.md

Rundown marketing website - Astro site with interactive runbook demo.

## Commands

```bash
pnpm run verify:site                    # Build the snapshot and run Playwright
pnpm --filter site run build:snapshot  # Build the WebContainer snapshot
pnpm --filter site build               # Build the site to dist/
```

## Verifying a site change

**`pnpm run verify` does not cover this directory.** It runs no Playwright, and both Biome and cspell exclude `site` (`biome.json`'s `"!site"`), so a change here can break the shipped demo with the repo-wide gate fully green. Run this from the repo root as well, whenever you touch `site/src`:

```bash
pnpm run verify:site   # builds the snapshot, then runs Playwright
```

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

**Key files:**
- `src/lib/webcontainer.ts` - WebContainer setup and snapshot mounting
- `packages/cli/src/services/internal-commands.ts` - Command interception
- `packages/cli/src/helpers/echo-command.ts` - Shared echo logic for CLI and internal execution
