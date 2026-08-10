import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';

// Plugin to add COOP/COEP headers required for WebContainers (SharedArrayBuffer)
function crossOriginIsolationPlugin() {
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
  };
}

// Dev/test-only routes. These pages live OUTSIDE `src/pages/` on purpose: this
// project builds with static output and declares no route exclusions, so
// anything under `src/pages/` is emitted into `dist/` and deployed. The SQLite
// substrate probe boots a WebContainer and runs `npm install sql.js` on load —
// shipping that to rundown.cool means any visitor who finds the URL runs it.
// Injecting only when `command === 'dev'` makes the omission structural: the
// production build never sees the route, so it cannot emit it, and no comment
// or convention is load-bearing.
//
// The Playwright suite runs against `astro dev` (see playwright.config.ts
// `webServer`), so the routes below are live for the guard in
// `tests/sqlite-substrate.spec.ts`. If this injection ever stops firing, that
// spec's explicit 200-status assertion fails immediately rather than timing out
// against a 404 body — keep that assertion when editing either file.
const DEV_ONLY_ROUTES = [
  {
    pattern: '/dev/sqlite-substrate-probe',
    entrypoint: './src/dev/sqlite-substrate-probe.astro',
  },
];

function devOnlyRoutes() {
  return {
    name: 'dev-only-routes',
    hooks: {
      'astro:config:setup': ({ command, injectRoute }) => {
        if (command !== 'dev') return;
        for (const route of DEV_ONLY_ROUTES) injectRoute(route);
      },
    },
  };
}

export default defineConfig({
  site: 'https://rundown.cool',
  integrations: [react(), devOnlyRoutes()],
  build: {
    assets: '_assets',
  },
  vite: {
    plugins: [tailwindcss(), crossOriginIsolationPlugin()],
  },
});
