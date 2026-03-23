# Test App

A simple REST API built with Hono + SQLite (node:sqlite).

## Stack

- **Runtime:** Node.js 24+ with `node:sqlite` (requires `--experimental-sqlite`)
- **Framework:** Hono (TypeScript-first, lightweight HTTP framework)
- **Database:** SQLite via `node:sqlite` DatabaseSync (in-memory for tests)
- **Testing:** Vitest

## Structure

```
src/
  db.ts       — Database setup (schema, seed data, query functions)
  app.ts      — Hono routes (GET /, GET /items, POST /items)
test/
  app.test.ts — API tests using Hono's built-in request helper
```

## Commands

```bash
npm test          # Run tests
npm run build     # TypeScript compilation
npm run dev       # Development server
```

## API Endpoints

- `GET /` — API info
- `GET /items` — List all items
- `POST /items` — Create item (body: `{ name: string, description?: string }`)
