# GET /items/:id Endpoint Task

Feature: Add `GET /items/:id` endpoint

Add a route to fetch a single item by id from the items table.

Scope (must do):
- New query function `getItemById(db, id): Item | undefined` in `src/db.ts` using a prepared `SELECT ... WHERE id = ?` statement.
- New route `GET /items/:id` in `src/app.ts`. Parse `:id` as integer; return `400` on non-integer ids, `404` when not found, `200 { item }` when found.
- Tests in `test/app.test.ts` covering: found (`200` with item shape), not found (`404`), and invalid id (`400`).

Out of scope:
- No update/delete endpoints.
- No schema changes to the items table.
- No pagination, filtering, or query-param work on GET /items.
- No new dependencies.

Acceptance:
- npm test passes.
- npm run build passes.
- All three new tests are present and passing.
