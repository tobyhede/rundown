import { DatabaseSync } from 'node:sqlite';

export interface Item {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
}

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

export function seedDatabase(db: DatabaseSync) {
  const insert = db.prepare('INSERT INTO items (name, description) VALUES (?, ?)');
  insert.run('Widget', 'A standard widget');
  insert.run('Gadget', 'A useful gadget');
  insert.run('Doohickey', 'An indispensable doohickey');
}

export function getAllItems(db: DatabaseSync): Item[] {
  const stmt = db.prepare('SELECT id, name, description, created_at FROM items');
  return stmt.all() as Item[];
}

export function insertItem(db: DatabaseSync, name: string, description: string | null): Item {
  const stmt = db.prepare(
    'INSERT INTO items (name, description) VALUES (?, ?) RETURNING id, name, description, created_at',
  );
  return stmt.get(name, description) as Item;
}
