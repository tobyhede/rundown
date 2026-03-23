import { Hono } from 'hono';
import { createDatabase, seedDatabase, getAllItems, insertItem } from './db.js';

const db = createDatabase();
seedDatabase(db);

const app = new Hono();

app.get('/', (c) => {
  return c.json({ message: 'Test App API', version: '1.0.0' });
});

app.get('/items', (c) => {
  const rows = getAllItems(db);
  return c.json({ items: rows });
});

app.post('/items', async (c) => {
  const body = await c.req.json();
  if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'name is required' }, 400);
  }
  const item = insertItem(db, body.name, body.description ?? null);
  return c.json({ item }, 201);
});

export { app, db };
