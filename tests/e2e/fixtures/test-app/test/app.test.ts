import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, seedDatabase } from '../src/db.js';
import type { Hono } from 'hono';

describe('Test App API', () => {
  let app: Hono;

  beforeEach(() => {
    const db = createDatabase();
    seedDatabase(db);
    ({ app } = createApp(db));
  });

  it('GET / returns API info', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ message: 'Test App API', version: '1.0.0' });
  });

  it('GET /items returns seeded items', async () => {
    const res = await app.request('/items');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items[0].name).toBe('Widget');
    expect(body.items[1].name).toBe('Gadget');
    expect(body.items[2].name).toBe('Doohickey');
  });

  it('POST /items creates a new item', async () => {
    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Item', description: 'Created in test' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.item.name).toBe('Test Item');
    expect(body.item.description).toBe('Created in test');
    expect(body.item.id).toBeDefined();
  });

  it('POST /items validates name is required', async () => {
    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('name is required');
  });
});
