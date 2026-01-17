# site/CLAUDE.md

Rundown marketing website - Astro site with interactive runbook demo.

## Commands

```bash
npm run dev      # Start dev server (localhost:4321)
npm run build    # Build to dist/
npm run preview  # Preview production build
```

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

- Astro 5.x (static output)
- Tailwind CSS 3.x (@astrojs/tailwind)
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
- Built via `npm run build:snapshot` in the monorepo root

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
