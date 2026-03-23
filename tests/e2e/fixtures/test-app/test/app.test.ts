import { describe, it, expect } from 'vitest';
import { app } from '../src/app.js';

describe('Test App API', () => {
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
    expect(body.items).toBeInstanceOf(Array);
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    expect(body.items[0]).toHaveProperty('name');
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
