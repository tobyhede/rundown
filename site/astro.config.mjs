import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://rundown.cool',
  integrations: [tailwind()],
  build: {
    assets: '_assets',
  },
});