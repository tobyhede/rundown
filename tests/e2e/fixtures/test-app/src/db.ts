import { DatabaseSync } from 'node:sqlite';

/** Represents an item stored in the SQLite database. */
export interface Item {
  /** Unique auto-incremented identifier. */
  id: number;
  /** Display name of the item. */
  name: string;
  /** Optional description, may be null. */
  description: string | null;
  /** ISO 8601 timestamp when the item was created. */
  created_at: string;
}

/**
 * Creates and initializes a SQLite database with the items schema.
 *
 * @param dbPath - Path to database file or ':memory:' for in-memory. Defaults to ':memory:'.
 * @returns Initialized DatabaseSync instance with items table created.
 */
export function createDatabase(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return db;
}

/**
 * Seeds the database with sample item records.
 *
 * @param db - The SQLite database instance to seed.
 */
export function seedDatabase(db: DatabaseSync) {
  const insert = db.prepare('INSERT INTO items (name, description) VALUES (?, ?)');
  insert.run('Widget', 'A standard widget');
  insert.run('Gadget', 'A useful gadget');
  insert.run('Doohickey', 'An indispensable doohickey');
}

/**
 * Retrieves all items from the database.
 *
 * @param db - The SQLite database instance.
 * @returns Array of all items in the database.
 */
export function getAllItems(db: DatabaseSync): Item[] {
  const stmt = db.prepare('SELECT id, name, description, created_at FROM items');
  return stmt.all() as unknown as Item[];
}

/**
 * Inserts a new item into the database.
 *
 * @param db - The SQLite database instance.
 * @param name - Display name for the item.
 * @param description - Optional description, may be null.
 * @returns The newly created item with generated id and timestamp.
 */
export function insertItem(db: DatabaseSync, name: string, description: string | null): Item {
  const stmt = db.prepare(
    'INSERT INTO items (name, description) VALUES (?, ?) RETURNING id, name, description, created_at',
  );
  return stmt.get(name, description) as unknown as Item;
}
