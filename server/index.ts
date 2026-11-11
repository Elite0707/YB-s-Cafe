import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const { migrateDatabase } = await import('./db.js');
await migrateDatabase();
const { app } = await import('./app.js');

const port = Number(process.env.PORT || 3000);
const dist = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, immutable: process.env.NODE_ENV === 'production', maxAge: process.env.NODE_ENV === 'production' ? '1y' : 0 }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
const server = app.listen(port, () => console.log(JSON.stringify({ level: 'info', message: 'Cafe ordering server listening', port, timestamp: new Date().toISOString() })));
function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
