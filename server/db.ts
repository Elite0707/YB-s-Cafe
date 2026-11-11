import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required. Set it in the Node API host environment or local .env file.');

const pool = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DATABASE_POOL_MAX || (process.env.NETLIFY ? 3 : 10)),
  idleTimeoutMillis: process.env.NETLIFY ? 10_000 : 30_000,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : undefined,
});
const migrationConnectionString = process.env.DATABASE_URL_UNPOOLED || databaseUrl;
const migrationPool = migrationConnectionString === databaseUrl ? pool : new Pool({
  connectionString: migrationConnectionString,
  max: 2,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : undefined,
});
const transactionClient = new AsyncLocalStorage<pg.PoolClient>();

function toPostgres(sql: string) {
  let index = 0;
  return sql
    .replace(/\?/g, () => `$${++index}`)
    .replace(/\bAS\s+([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g, 'AS "$1"');
}

class Statement {
  constructor(private readonly sql: string) {}
  async get(...values: unknown[]) {
    const result = await (transactionClient.getStore() || pool).query(toPostgres(this.sql), values);
    return result.rows[0];
  }
  async all(...values: unknown[]) {
    const result = await (transactionClient.getStore() || pool).query(toPostgres(this.sql), values);
    return result.rows;
  }
  async run(...values: unknown[]) {
    const result = await (transactionClient.getStore() || pool).query(toPostgres(this.sql), values);
    return { changes: result.rowCount || 0 };
  }
}

export const db = {
  prepare(sql: string) { return new Statement(sql); },
  transaction<T>(operation: () => Promise<T>) {
    return async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await transactionClient.run(client, operation);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    };
  },
  async close() { await pool.end(); },
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const uploadsDirectory = process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : path.resolve(process.cwd(), 'data/uploads');

async function migrate() {
  const candidates = [
    path.resolve(process.cwd(), 'db/pg-migrations'),
    path.resolve(here, '../db/pg-migrations'),
    path.resolve(here, '../../db/pg-migrations'),
  ];
  const migrationDirectory = candidates.find((candidate) => fs.existsSync(candidate));
  if (!migrationDirectory) throw new Error('PostgreSQL migrations db/pg-migrations were not found.');
  await migrationPool.query('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  for (const fileName of fs.readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort()) {
    const exists = await migrationPool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [fileName]);
    if (exists.rowCount) continue;
    const client = await migrationPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(migrationDirectory, fileName), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [fileName]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

export async function migrateDatabase() {
  await migrate();
  if (migrationPool !== pool) await migrationPool.end();
}

export function nowIso() { return new Date().toISOString(); }
export function newId(prefix: string) { return `${prefix}_${randomUUID()}`; }
export function isUniqueViolation(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'); }
