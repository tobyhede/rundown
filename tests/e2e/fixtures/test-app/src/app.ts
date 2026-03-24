import { Hono } from 'hono';
import { type DatabaseSync } from 'node:sqlite';
import { createDatabase, seedDatabase, getAllItems, insertItem } from './db.js';

interface CreateItemBody {
  name: string;
  description?: string | null;
}

/**
 * Creates a Hono application instance with database integration.
 *
 * @param db - Optional SQLite database instance. If omitted, creates and seeds a new in-memory database.
 * @returns Object containing the Hono app and the database instance used.
 */
export function createApp(db?: DatabaseSync) {
  const database = db ?? createDatabase();
  if (!db) seedDatabase(database);

  const app = new Hono();

  app.get('/', (c) => {
    return c.json({ message: 'Test App API', version: '1.0.0' });
  });

  app.get('/items', (c) => {
    const rows = getAllItems(database);
    return c.json({ items: rows });
  });

  app.post('/items', async (c) => {
    const body = await c.req.json<CreateItemBody>();
    if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
      return c.json({ error: 'name is required' }, 400);
    }
    const item = insertItem(database, body.name, body.description ?? null);
    return c.json({ item }, 201);
  });

  return { app, db: database };
}
