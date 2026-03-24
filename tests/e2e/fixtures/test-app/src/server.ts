import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const { app } = createApp();

serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});
