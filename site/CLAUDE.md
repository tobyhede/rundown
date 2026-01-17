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
- `public/discover-rundown.runbook.md` - 5-step sales pitch runbook with 3 scenarios (tour, retry-demo, quick)
- `src/components/HomepageRunner.astro` - Split view: source markdown (left) + interactive CLI runner (right)
- `src/components/Hero.astro` - Minimal hero with logo and GitHub link
- `src/components/interactive/RunbookRunner.tsx` - React component with Xterm.js terminal

**How it works:**
- HomepageRunner loads the discover runbook at build time
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

Cyberpunk color palette defined in `tailwind.config.mjs`:
- `cyber-cyan` (#00E5FF)
- `cyber-magenta` (#FF00E5)
- `cyber-purple` (#9B4DFF)
