// Neon migrations need a direct connection; keep the pooled DATABASE_URL for app traffic.
if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
const { db, migrateDatabase } = await import('./db.js');
await migrateDatabase();
await db.close();
console.log('PostgreSQL schema is up to date.');
