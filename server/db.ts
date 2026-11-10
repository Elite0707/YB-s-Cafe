import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data/cafe.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
export const uploadsDirectory = process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : path.join(path.dirname(databasePath), 'uploads');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const initialMigrationPath = [
  path.resolve(process.cwd(), 'db/migrations/001_init.sql'),
  path.resolve(here, '../db/migrations/001_init.sql'),
  path.resolve(here, '../../db/migrations/001_init.sql'),
].find((candidate) => fs.existsSync(candidate));
if (!initialMigrationPath) throw new Error('Database migration db/migrations/001_init.sql was not found.');
const migrationDirectory = path.dirname(initialMigrationPath);
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
for (const fileName of fs.readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort()) {
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(fileName);
  if (applied) continue;
  const sql = fs.readFileSync(path.join(migrationDirectory, fileName), 'utf8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(fileName, new Date().toISOString());
  })();
}

export function nowIso() { return new Date().toISOString(); }
export function newId(prefix: string) { return `${prefix}_${randomUUID()}`; }
