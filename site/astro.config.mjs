import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
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

export default defineConfig({
  site: 'https://rundown.cool',
  integrations: [tailwind(), react()],
  build: {
    assets: '_assets',
  },
  vite: {
    plugins: [crossOriginIsolationPlugin()],
  },
});