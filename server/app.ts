import express, { type NextFunction, type Request, type Response } from 'express';
import session, { Store, type SessionData } from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db, isUniqueViolation, newId, nowIso, uploadsDirectory } from './db.js';
import { isObjectStorageConfigured, storePublicImage } from './object-storage.js';

declare module 'express-session' {
  interface SessionData { adminId?: string; cafeId?: string }
}

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const trustProxySetting = process.env.TRUST_PROXY?.trim();
if (trustProxySetting) app.set('trust proxy', /^\d+$/.test(trustProxySetting) ? Number(trustProxySetting) : trustProxySetting.split(',').map((entry) => entry.trim()).filter(Boolean));
else if (process.env.NETLIFY) app.set('trust proxy', 1);
else if (!isProduction) app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

class SqliteSessionStore extends Store {
  async get(sid: string, callback: (err: unknown, session?: SessionData | null) => void) {
    try {
      const row = await db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid) as { sess: string; expired: number } | undefined;
      if (!row || row.expired <= Date.now()) {
        if (row) await db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.sess) as SessionData);
    } catch (error) { callback(error); }
  }
  async set(sid: string, sess: SessionData, callback?: (err?: unknown) => void) {
    try {
      const expiry = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 1000 * 60 * 60 * 24 * 7;
      await db.prepare('INSERT INTO sessions(sid,sess,expired) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expired=excluded.expired').run(sid, JSON.stringify(sess), expiry);
      callback?.();
    } catch (error) { callback?.(error); }
  }
  async destroy(sid: string, callback?: (err?: unknown) => void) {
    try { await db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback?.(); } catch (error) { callback?.(error); }
  }
  async touch(sid: string, sess: SessionData, callback?: (err?: unknown) => void) {
    try {
      const expiry = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 1000 * 60 * 60 * 24 * 7;
      await db.prepare('UPDATE sessions SET expired=? WHERE sid=?').run(expiry, sid);
      callback?.();
    } catch (error) { callback?.(error); }
  }
}

const sessionSecret = process.env.SESSION_SECRET || (!isProduction ? 'local-development-session-secret-change-before-deploy' : '');
if (!sessionSecret || (isProduction && sessionSecret.length < 32)) throw new Error('SESSION_SECRET must be configured with at least 32 characters in production.');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
if (!process.env.NETLIFY) {
  const sessionPruner = setInterval(async () => {
    try { await db.prepare('DELETE FROM sessions WHERE expired <= ?').run(Date.now()); }
    catch (error) { console.error(JSON.stringify({ level: 'error', message: 'Session cleanup failed', detail: String(error), timestamp: nowIso() })); }
  }, 60 * 60 * 1000);
  sessionPruner.unref();
}
app.use(session({
  name: 'cafe.sid', secret: sessionSecret, store: new SqliteSessionStore(), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12, path: '/' },
}));

const originGuard: express.RequestHandler = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/api/payments/stripe-webhook') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  const normalizeOrigin = (value: string) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
    } catch { return null; }
  };
  const explicitOrigins = (process.env.APP_ORIGIN || '').split(',').map((value) => normalizeOrigin(value.trim())).filter((value): value is string => Boolean(value));
  const trustProxy = req.app.get('trust proxy fn') as (address: string) => boolean;
  const proxyIsTrusted = Boolean(req.socket.remoteAddress && trustProxy(req.socket.remoteAddress));
  const forwardedHost = proxyIsTrusted ? req.get('x-forwarded-host')?.split(',')[0].trim() : undefined;
  const requestHost = forwardedHost || req.get('host');
  const expectedOrigins = explicitOrigins.length ? explicitOrigins : [requestHost ? normalizeOrigin(`${req.protocol}://${requestHost}`) : null].filter((value): value is string => Boolean(value));
  const requestOrigin = normalizeOrigin(origin);
  if (!requestOrigin || !expectedOrigins.includes(requestOrigin)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  next();
};
app.use(originGuard);

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
app.use('/api', apiLimiter);

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey) : null;
const publicBaseUrl = process.env.APP_BASE_URL;
async function getPublicOrder(token: string) {
  const row = await db.prepare(`SELECT o.*, t.name AS table_name, t.qr_token AS table_qr_token, c.name AS cafe_name, c.currency
    FROM orders o JOIN cafe_tables t ON t.id=o.table_id JOIN cafes c ON c.id=o.cafe_id WHERE o.tracking_token=?`).get(token) as any;
  return row ? presentOrder(row, false) : null;
}
async function presentOrder(row: any, includeTracking = true) {
  const items = await db.prepare('SELECT id,item_id AS itemId,item_name AS name,quantity,unit_price_cents AS unitPriceCents,line_total_cents AS lineTotalCents,selected_options_json AS selectedOptionsJson,special_instructions AS specialInstructions FROM order_items WHERE order_id=?').all(row.id) as any[];
  return {
    id: row.id, orderNumber: row.order_number, status: row.status, paymentMethod: row.payment_method, paymentStatus: row.payment_status,
    tableName: row.table_name, cafeName: row.cafe_name, currency: row.currency, subtotalCents: row.subtotal_cents, taxCents: row.tax_cents,
    menuPath: row.table_qr_token ? `/c/${encodeURIComponent(row.table_qr_token)}` : undefined,
    discountCents: row.discount_cents, totalCents: row.total_cents, customerNote: row.customer_note,
    estimatedMinutes: row.estimated_minutes, createdAt: row.created_at, updatedAt: row.updated_at,
    cancellationReason: row.cancellation_reason,
    ...(includeTracking ? { trackingToken: row.tracking_token } : {}),
    items: items.map((item) => ({ ...item, selectedOptions: safeJson(item.selectedOptionsJson, []) })).map(({ selectedOptionsJson, ...item }) => item),
  };
}
function safeJson(value: string, fallback: unknown) { try { return JSON.parse(value); } catch { return fallback; } }
async function publicMenu(cafeId: string) {
  const categories = await db.prepare('SELECT id,name,sort_order AS sortOrder FROM categories WHERE cafe_id=? AND active=1 ORDER BY sort_order,name').all(cafeId);
  const items = await db.prepare(`SELECT id,category_id AS categoryId,name,description,image_url AS imageUrl,price_cents AS priceCents,prep_minutes AS prepMinutes,
    vegetarian AS isVegetarian,vegan AS isVegan,allergens_json,options_json,available FROM items WHERE cafe_id=? ORDER BY name`).all(cafeId) as any[];
  return { categories, items: items.map((item) => ({ ...item, isVegetarian: Boolean(item.isVegetarian), isVegan: Boolean(item.isVegan), available: Boolean(item.available), allergens: safeJson(item.allergens_json, []), options: safeJson(item.options_json, []) })).map(({ allergens_json, options_json, ...item }) => item) };
}
function adminCafe(req: Request) { return req.session.cafeId!; }
const requireAdmin: express.RequestHandler = (req, res, next) => {
  if (!req.session.adminId || !req.session.cafeId) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
};
const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Stripe needs the unparsed body for signature verification.
app.post('/api/payments/stripe-webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Online payments are not configured.');
  let event: Stripe.Event;
  try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') || '', process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send('Invalid webhook signature.'); }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const checkout = event.data.object as Stripe.Checkout.Session;
    if (checkout.payment_status === 'paid' && checkout.metadata?.orderId && checkout.metadata?.cafeId) {
      const tx = db.transaction(async () => {
        const order = await db.prepare(`SELECT o.id,o.tracking_token,o.payment_status,o.status,o.total_cents,p.provider_reference,p.method,c.currency
          FROM orders o JOIN payments p ON p.order_id=o.id AND p.cafe_id=o.cafe_id JOIN cafes c ON c.id=o.cafe_id
          WHERE o.id=? AND o.cafe_id=?`).get(checkout.metadata!.orderId, checkout.metadata!.cafeId) as any;
        if (!order) return { result: 'missing' as const };
        if (order.method !== 'ONLINE' || order.provider_reference !== checkout.id) return { result: 'reference_mismatch' as const, orderId: order.id, trackingToken: order.tracking_token };
        if (checkout.amount_total !== order.total_cents || checkout.currency?.toLowerCase() !== String(order.currency).toLowerCase()) {
          const at = nowIso();
          await db.prepare("UPDATE orders SET status=CASE WHEN status='PENDING' THEN 'CANCELLED' ELSE status END,cancellation_reason=CASE WHEN status='PENDING' THEN 'Payment amount or currency mismatch; reconciliation required.' ELSE cancellation_reason END,updated_at=? WHERE id=? AND cafe_id=?").run(at, order.id, checkout.metadata!.cafeId);
          return { result: 'amount_currency_mismatch' as const, orderId: order.id, trackingToken: order.tracking_token, expectedAmount: order.total_cents, receivedAmount: checkout.amount_total, expectedCurrency: order.currency, receivedCurrency: checkout.currency };
        }
        if (order.payment_status === 'REFUNDED') return { result: 'already_refunded' as const, trackingToken: order.tracking_token };
        if (order.payment_status === 'PAID') return { result: 'already_paid' as const, trackingToken: order.tracking_token };
        const at = nowIso();
        await db.prepare("UPDATE payments SET status='PAID',updated_at=? WHERE order_id=? AND cafe_id=? AND provider_reference=? AND method='ONLINE'").run(at, checkout.metadata!.orderId, checkout.metadata!.cafeId, checkout.id);
        await db.prepare("UPDATE orders SET payment_status='PAID',status=CASE WHEN status='PENDING' THEN 'CONFIRMED' ELSE status END,updated_at=? WHERE id=? AND cafe_id=?").run(at, checkout.metadata!.orderId, checkout.metadata!.cafeId);
        return { result: order.status === 'CANCELLED' ? 'late_cancelled_success' as const : 'paid' as const, trackingToken: order.tracking_token, orderId: order.id };
      });
      const outcome = await tx();
      if (outcome.result === 'reference_mismatch' || outcome.result === 'amount_currency_mismatch') {
        console.error(JSON.stringify({ level: 'critical', action: 'payment_reconciliation_required', reason: outcome.result, orderId: outcome.orderId, checkoutSessionId: checkout.id, expectedAmount: (outcome as any).expectedAmount, receivedAmount: (outcome as any).receivedAmount, expectedCurrency: (outcome as any).expectedCurrency, receivedCurrency: (outcome as any).receivedCurrency, timestamp: nowIso() }));
        if (outcome.result === 'reference_mismatch') return res.status(409).json({ error: 'Payment session is not ready for verification. Retry webhook delivery.' });
        return res.json({ received: true, reconciliationRequired: true });
      }
      if (outcome.result === 'late_cancelled_success') console.error(JSON.stringify({ level: 'critical', action: 'refund_or_reconcile_late_payment', orderId: outcome.orderId, checkoutSessionId: checkout.id, timestamp: nowIso() }));
    }
  }
  if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    const checkout = event.data.object as Stripe.Checkout.Session;
    if (checkout.metadata?.orderId && checkout.metadata?.cafeId) {
      const row = await db.prepare(`SELECT o.tracking_token FROM orders o JOIN payments p ON p.order_id=o.id AND p.cafe_id=o.cafe_id WHERE o.id=? AND o.cafe_id=? AND p.provider_reference=? AND p.method='ONLINE'`).get(checkout.metadata.orderId, checkout.metadata.cafeId, checkout.id) as any;
      if (row) {
        const at = nowIso();
        const fail = db.transaction(async () => {
          await db.prepare("UPDATE payments SET status='FAILED',updated_at=? WHERE order_id=? AND cafe_id=? AND provider_reference=? AND status='PENDING'").run(at, checkout.metadata!.orderId, checkout.metadata!.cafeId, checkout.id);
          await db.prepare("UPDATE orders SET payment_status='FAILED',status=CASE WHEN status='PENDING' THEN 'CANCELLED' ELSE status END,cancellation_reason=CASE WHEN status='PENDING' THEN 'Online checkout expired or could not be completed.' ELSE cancellation_reason END,updated_at=? WHERE id=? AND cafe_id=? AND payment_status='PENDING'").run(at, checkout.metadata!.orderId, checkout.metadata!.cafeId);
        });
        await fail();
      }
    }
  }
  res.json({ received: true });
}));

app.use(express.json({ limit: '128kb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: nowIso() }));

const uploadTypes = {
  'image/png': { extension: 'png', contentType: 'image/png' },
  'image/jpeg': { extension: 'jpg', contentType: 'image/jpeg' },
  'image/webp': { extension: 'webp', contentType: 'image/webp' },
} as const;
type UploadMime = keyof typeof uploadTypes;
function inspectRaster(bytes: Buffer): UploadMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const rasterContentTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'];
app.get('/uploads/:filename', asyncRoute(async (req, res) => {
  const filename = typeof req.params.filename === 'string' ? req.params.filename : '';
  const match = /^([a-f0-9]{32})\.(png|jpg|webp)$/.exec(filename);
  if (!match) return res.status(404).end();
  const filePath = `${match[1]}.${match[2]}`;
  const type = match[2] === 'jpg' ? 'image/jpeg' : `image/${match[2]}`;
  res.set({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.sendFile(filePath, { root: uploadsDirectory }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
}));
app.post('/api/admin/uploads', requireAdmin, express.raw({ type: rasterContentTypes, limit: 4 * 1024 * 1024 }), asyncRoute(async (req, res) => {
  const declaredType = (req.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!rasterContentTypes.includes(declaredType)) return res.status(415).json({ error: 'Upload a PNG, JPEG, or WebP image.' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'The image file is empty.' });
  const actualType = inspectRaster(req.body);
  if (!actualType) return res.status(415).json({ error: 'The file is not a supported PNG, JPEG, or WebP image.' });
  if (declaredType !== 'application/octet-stream' && declaredType !== actualType) return res.status(400).json({ error: 'The file contents do not match the declared image type.' });
  const extension = uploadTypes[actualType].extension;
  if (isObjectStorageConfigured()) {
    const fileName = `${randomBytes(16).toString('hex')}.${extension}`;
    const key = `cafes/${adminCafe(req)}/uploads/${fileName}`;
    const url = await storePublicImage(key, req.body, actualType);
    return res.status(201).json({ url });
  }
  if (process.env.NETLIFY) return res.status(503).json({ error: 'Image storage is not configured for this deployment.' });
  await fs.mkdir(uploadsDirectory, { recursive: true });
  let fileName = '';
  for (let attempts = 0; attempts < 3; attempts++) {
    fileName = `${randomBytes(16).toString('hex')}.${extension}`;
    try { await fs.writeFile(path.join(uploadsDirectory, fileName), req.body, { flag: 'wx', mode: 0o640 }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempts === 2) throw error; }
  }
  res.status(201).json({ url: `/uploads/${fileName}` });
}));

const setupSchema = z.object({ setupKey: z.string().min(1).max(256), cafeName: z.string().trim().min(2).max(100), description: z.string().max(500).optional().default(''), address: z.string().max(250).optional().default(''), phone: z.string().max(40).optional().default(''), tableName: z.string().trim().min(1).max(60).optional().default('Table 1'), adminName: z.string().trim().min(2).max(80), email: z.string().email().max(254), password: z.string().min(12).max(128), currency: z.string().regex(/^[A-Z]{3}$/).optional().default('INR'), taxBps: z.number().int().min(0).max(3000).optional().default(0) });
const starterCategories = ['Coffee', 'Tea', 'Beverages', 'Snacks', 'Desserts', 'Meals'];
const cafeRegistrationSchema = setupSchema.omit({ setupKey: true }).strict();
const cafeRegistrationLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 4, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many cafe registrations from this network. Try again later.' } });
app.get('/api/setup/status', async (_req, res) => res.json({ complete: Boolean(await db.prepare('SELECT 1 FROM admins LIMIT 1').get()) }));
app.post('/api/setup', authLimiter, asyncRoute(async (req, res) => {
  if (await db.prepare('SELECT 1 FROM admins LIMIT 1').get()) return res.status(409).json({ error: 'Initial setup has already been completed.' });
  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the setup details.', details: parsed.error.flatten() });
  const expected = process.env.SETUP_KEY;
  if (!expected) return res.status(503).json({ error: 'Initial setup is disabled because SETUP_KEY is not configured.' });
  const suppliedBytes = Buffer.from(parsed.data.setupKey); const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return res.status(403).json({ error: 'Invalid setup key.' });
  const cafeId = newId('cafe'); const adminId = newId('admin'); const at = nowIso();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const tx = db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended('cafe-owner-setup', 0))").get();
    if (await db.prepare('SELECT 1 FROM admins LIMIT 1').get()) throw new Error('SETUP_ALREADY_DONE');
    await db.prepare('INSERT INTO cafes(id,name,description,address,phone,currency,tax_bps,created_at) VALUES(?,?,?,?,?,?,?,?)').run(cafeId, parsed.data.cafeName, parsed.data.description, parsed.data.address, parsed.data.phone, parsed.data.currency, parsed.data.taxBps, at);
    await db.prepare('INSERT INTO admins(id,cafe_id,email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(adminId, cafeId, parsed.data.email, parsed.data.adminName, passwordHash, at);
    for (const [sort, name] of starterCategories.entries()) await db.prepare('INSERT INTO categories(id,cafe_id,name,sort_order) VALUES(?,?,?,?)').run(newId('cat'), cafeId, name, sort);
    await db.prepare('INSERT INTO cafe_tables(id,cafe_id,name,qr_token,created_at) VALUES(?,?,?,?,?)').run(newId('table'), cafeId, parsed.data.tableName, randomBytes(24).toString('base64url'), at);
  });
  try { await tx(); } catch (error) { if ((error as Error).message === 'SETUP_ALREADY_DONE') return res.status(409).json({ error: 'Initial setup has already been completed.' }); throw error; }
  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: 'Account created; sign in to continue.' });
    req.session.adminId = adminId; req.session.cafeId = cafeId;
    req.session.save((saveError) => saveError ? res.status(500).json({ error: 'Account created; sign in to continue.' }) : res.status(201).json({ admin: { id: adminId, name: parsed.data.adminName, email: parsed.data.email }, cafe: { id: cafeId, name: parsed.data.cafeName } }));
  });
}));
app.post('/api/cafes/register', cafeRegistrationLimiter, asyncRoute(async (req, res) => {
  const parsed = cafeRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the cafe and owner details.', details: parsed.error.flatten() });
  const cafeId = newId('cafe'); const adminId = newId('admin'); const at = nowIso();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const tx = db.transaction(async () => {
    await db.prepare('INSERT INTO cafes(id,name,description,address,phone,currency,tax_bps,created_at) VALUES(?,?,?,?,?,?,?,?)').run(cafeId, parsed.data.cafeName, parsed.data.description, parsed.data.address, parsed.data.phone, parsed.data.currency, parsed.data.taxBps, at);
    await db.prepare('INSERT INTO admins(id,cafe_id,email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(adminId, cafeId, parsed.data.email, parsed.data.adminName, passwordHash, at);
    for (const [sort, name] of starterCategories.entries()) await db.prepare('INSERT INTO categories(id,cafe_id,name,sort_order) VALUES(?,?,?,?)').run(newId('cat'), cafeId, name, sort);
    await db.prepare('INSERT INTO cafe_tables(id,cafe_id,name,qr_token,created_at) VALUES(?,?,?,?,?)').run(newId('table'), cafeId, parsed.data.tableName, randomBytes(24).toString('base64url'), at);
  });
  try { await tx(); }
  catch (error) {
    if (isUniqueViolation(error) && (error as any).constraint === 'admins_email_unique_idx') return res.status(409).json({ error: 'An account with this email already exists.' });
    if (isUniqueViolation(error) && (error as any).constraint === 'cafe_tables_cafe_id_name_key') return res.status(409).json({ error: 'A table with that name already exists.' });
    throw error;
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: 'Cafe created; sign in to continue.' });
    req.session.adminId = adminId; req.session.cafeId = cafeId;
    req.session.save((saveError) => saveError ? res.status(500).json({ error: 'Cafe created; sign in to continue.' }) : res.status(201).json({ admin: { id: adminId, name: parsed.data.adminName, email: parsed.data.email }, cafe: { id: cafeId, name: parsed.data.cafeName } }));
  });
}));

app.get('/api/public/tables/:qrToken', async (req, res) => {
  const row = await db.prepare(`SELECT t.id AS table_id,t.name AS table_name,t.active,c.* FROM cafe_tables t JOIN cafes c ON c.id=t.cafe_id WHERE t.qr_token=?`).get(req.params.qrToken) as any;
  if (!row || !row.active) return res.status(404).json({ error: 'This table QR code is no longer active.' });
  const menu = await publicMenu(row.id);
  res.json({ cafe: { id: row.id, name: row.name, description: row.description, address: row.address, phone: row.phone, currency: row.currency, taxBps: row.tax_bps, logoUrl: row.logo_url, acceptingOrders: Boolean(row.accepting_orders), defaultPrepMinutes: row.default_prep_minutes, onlinePaymentsEnabled: Boolean(stripe && process.env.STRIPE_WEBHOOK_SECRET && publicBaseUrl) }, table: { id: row.table_id, name: row.table_name }, ...menu });
});

const createOrderSchema = z.object({ items: z.array(z.object({ itemId: z.string().min(1).max(100), quantity: z.number().int().min(1).max(30), options: z.array(z.object({ optionId: z.string().max(100), choiceId: z.string().max(100) })).max(20).default([]), specialInstructions: z.string().max(300).optional().default('') })).min(1).max(50), customerNote: z.string().max(500).optional().default(''), paymentMethod: z.enum(['CASH_COUNTER', 'CASH_TABLE', 'ONLINE']) });
app.post('/api/public/orders', rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false }), asyncRoute(async (req, res) => {
  const token = z.string().min(24).max(128).safeParse(req.body?.qrToken);
  const idempotencyKey = req.get('idempotency-key');
  if (!token.success) return res.status(400).json({ error: 'Scan a valid table QR code to start an order.' });
  if (!idempotencyKey || idempotencyKey.length > 128 || idempotencyKey.length < 12) return res.status(400).json({ error: 'A valid idempotency key is required.' });
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check your order details.', details: parsed.error.flatten() });
  const table = await db.prepare(`SELECT t.id,t.cafe_id,t.active,c.tax_bps,c.default_prep_minutes,c.accepting_orders,c.currency FROM cafe_tables t JOIN cafes c ON c.id=t.cafe_id WHERE t.qr_token=?`).get(token.data) as any;
  if (!table || !table.active) return res.status(404).json({ error: 'This table QR code is no longer active.' });
  if (!table.accepting_orders) return res.status(409).json({ error: 'This cafe is not accepting orders right now.' });
  const existing = await db.prepare(`SELECT o.*,t.name AS table_name,t.qr_token AS table_qr_token,c.name AS cafe_name,c.currency FROM idempotency_keys k JOIN orders o ON o.id=k.order_id JOIN cafe_tables t ON t.id=o.table_id JOIN cafes c ON c.id=o.cafe_id WHERE k.cafe_id=? AND k.idempotency_key=?`).get(table.cafe_id, idempotencyKey) as any;
  if (existing) {
    const payment = await db.prepare('SELECT provider_reference FROM payments WHERE order_id=?').get(existing.id) as any;
    let checkoutUrl: string | undefined;
    if (stripe && payment?.provider_reference) { try { checkoutUrl = (await stripe.checkout.sessions.retrieve(payment.provider_reference)).url || undefined; } catch { /* expired or unavailable session */ } }
    return res.status(200).json({ order: await presentOrder(existing), trackingToken: existing.tracking_token, ...(checkoutUrl ? { checkoutUrl } : {}) });
  }
  if (parsed.data.paymentMethod === 'ONLINE' && (!stripe || !process.env.STRIPE_WEBHOOK_SECRET || !publicBaseUrl)) return res.status(503).json({ error: 'Online payments are unavailable. Choose cash or ask the cafe to configure Stripe.' });
  const sourceItems = await db.prepare('SELECT * FROM items WHERE cafe_id=? AND id IN (' + parsed.data.items.map(() => '?').join(',') + ')').all(table.cafe_id, ...parsed.data.items.map((item) => item.itemId)) as any[];
  const byId = new Map(sourceItems.map((item) => [item.id, item]));
  if (byId.size !== new Set(parsed.data.items.map((item) => item.itemId)).size) return res.status(409).json({ error: 'One or more menu items changed. Refresh the menu and try again.' });
  let subtotal = 0; let maxPrep = Number(table.default_prep_minutes) || 15;
  const lineItems = [] as any[];
  for (const requested of parsed.data.items) {
    const item = byId.get(requested.itemId)!;
    if (!item.available) return res.status(409).json({ error: `${item.name} is currently unavailable.` });
    const options = safeJson(item.options_json, []) as any[];
    let optionDelta = 0; const selected = [] as any[];
    const chosenIds = new Set<string>();
    for (const selection of requested.options) {
      if (chosenIds.has(selection.optionId)) return res.status(400).json({ error: 'Each customization can only be selected once.' });
      chosenIds.add(selection.optionId);
      const option = options.find((entry) => entry.id === selection.optionId);
      const choice = option?.choices?.find((entry: any) => entry.id === selection.choiceId);
      if (!option || !choice) return res.status(400).json({ error: 'A selected customization is no longer available.' });
      optionDelta += Number(choice.priceDeltaCents) || 0; selected.push({ optionId: option.id, label: option.label, choiceId: choice.id, choiceLabel: choice.label, priceDeltaCents: Number(choice.priceDeltaCents) || 0 });
    }
    if (options.some((option) => option.required && !chosenIds.has(option.id))) return res.status(400).json({ error: `Choose the required options for ${item.name}.` });
    const unit = item.price_cents + optionDelta;
    if (unit < 0) return res.status(400).json({ error: `The selected options for ${item.name} cannot produce a negative price.` });
    const total = unit * requested.quantity;
    subtotal += total; maxPrep = Math.max(maxPrep, Number(item.prep_minutes) || 0);
    lineItems.push({ id: newId('line'), itemId: item.id, name: item.name, quantity: requested.quantity, unitPriceCents: unit, lineTotalCents: total, options: selected, specialInstructions: requested.specialInstructions });
  }
  const tax = Math.round(subtotal * Number(table.tax_bps) / 10_000); const total = subtotal + tax;
  const orderId = newId('order'); const trackingToken = randomBytes(32).toString('base64url'); const paymentId = newId('pay'); const at = nowIso();
  const paymentStatus = parsed.data.paymentMethod === 'ONLINE' ? 'PENDING' : 'UNPAID';
  let orderNumber = 0;
  try {
    const tx = db.transaction(async () => {
      await db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))').get(table.cafe_id);
      const prior = await db.prepare('SELECT order_id FROM idempotency_keys WHERE cafe_id=? AND idempotency_key=?').get(table.cafe_id, idempotencyKey);
      if (prior) throw new Error('IDEMPOTENCY_CONFLICT');
      orderNumber = Number((await db.prepare('SELECT COALESCE(MAX(order_number),0)+1 AS next FROM orders WHERE cafe_id=?').get(table.cafe_id) as any).next);
      await db.prepare(`INSERT INTO orders(id,cafe_id,table_id,order_number,tracking_token,status,payment_method,payment_status,subtotal_cents,tax_cents,total_cents,customer_note,estimated_minutes,created_at,updated_at)
        VALUES(?,?,?,?,?,'PENDING',?,?,?,?,?,?,?,?,?)`).run(orderId, table.cafe_id, table.id, orderNumber, trackingToken, parsed.data.paymentMethod, paymentStatus, subtotal, tax, total, parsed.data.customerNote, maxPrep, at, at);
      const addLine = db.prepare(`INSERT INTO order_items(id,order_id,item_id,item_name,quantity,unit_price_cents,line_total_cents,selected_options_json,special_instructions) VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const line of lineItems) await addLine.run(line.id, orderId, line.itemId, line.name, line.quantity, line.unitPriceCents, line.lineTotalCents, JSON.stringify(line.options), line.specialInstructions);
      await db.prepare('INSERT INTO payments(id,cafe_id,order_id,method,status,amount_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(paymentId, table.cafe_id, orderId, parsed.data.paymentMethod, paymentStatus, total, at, at);
      await db.prepare('INSERT INTO idempotency_keys(cafe_id,idempotency_key,order_id,created_at) VALUES(?,?,?,?)').run(table.cafe_id, idempotencyKey, orderId, at);
    });
    await tx();
  } catch (error) {
    if ((error as Error).message === 'IDEMPOTENCY_CONFLICT') return res.status(409).json({ error: 'This order is already being processed. Refresh your orders.' });
    throw error;
  }
  let checkoutUrl: string | undefined;
  if (parsed.data.paymentMethod === 'ONLINE' && stripe) {
    try {
      const checkout = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          ...lineItems.map((item) => ({ quantity: item.quantity, price_data: { currency: String(table.currency).toLowerCase(), unit_amount: item.unitPriceCents, product_data: { name: item.name, ...(item.options.length ? { description: item.options.map((o: any) => o.choiceLabel).join(', ') } : {}) } } })),
          ...(tax > 0 ? [{ quantity: 1, price_data: { currency: String(table.currency).toLowerCase(), unit_amount: tax, product_data: { name: `Tax · order #${orderNumber}` } } }] : []),
        ],
        success_url: `${publicBaseUrl}/order/${trackingToken}?payment=success`, cancel_url: `${publicBaseUrl}/order/${trackingToken}?payment=cancelled`,
        metadata: { orderId, cafeId: table.cafe_id },
      }, { idempotencyKey: `cafe-checkout-${orderId}` });
      checkoutUrl = checkout.url || undefined;
      await db.prepare('UPDATE payments SET provider_reference=?,updated_at=? WHERE id=?').run(checkout.id, nowIso(), paymentId);
    } catch (error) {
      const failedAt = nowIso();
      await db.prepare("UPDATE payments SET status='FAILED',updated_at=? WHERE id=?").run(failedAt, paymentId);
      await db.prepare("UPDATE orders SET payment_status='FAILED',status='CANCELLED',cancellation_reason='Online checkout could not be started.',updated_at=? WHERE id=?").run(failedAt, orderId);
      return res.status(502).json({ error: 'The payment provider could not start checkout. No payment was taken; try again or choose cash.' });
    }
  }
  const order = await getPublicOrder(trackingToken);
  res.status(201).json({ order, trackingToken, ...(checkoutUrl ? { checkoutUrl } : {}) });
}));

app.get('/api/public/orders/:trackingToken', async (req, res) => {
  const order = await getPublicOrder(req.params.trackingToken);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order });
});
app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const admin = await db.prepare('SELECT id,cafe_id,email,name,password_hash FROM admins WHERE LOWER(email)=LOWER(?) ORDER BY created_at LIMIT 1').get(input.data.email) as any;
  if (!admin || !(await bcrypt.compare(input.data.password, admin.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: 'Unable to start a secure session.' });
    req.session.adminId = admin.id; req.session.cafeId = admin.cafe_id;
    req.session.save((saveError) => saveError ? res.status(500).json({ error: 'Unable to save the session.' }) : res.json({ admin: { id: admin.id, name: admin.name, email: admin.email } }));
  });
}));
app.post('/api/auth/logout', (req, res) => req.session.destroy((error) => { res.clearCookie('cafe.sid', { path: '/' }); error ? res.status(500).json({ error: 'Could not end the session.' }) : res.json({ ok: true }); }));
app.get('/api/auth/me', requireAdmin, async (req, res) => {
  const admin = await db.prepare('SELECT id,email,name FROM admins WHERE id=? AND cafe_id=?').get(req.session.adminId, req.session.cafeId) as any;
  const cafe = await db.prepare('SELECT id,name,currency,tax_bps AS taxBps,accepting_orders AS acceptingOrders FROM cafes WHERE id=?').get(req.session.cafeId) as any;
  if (!admin || !cafe) return res.status(401).json({ error: 'Session expired.' });
  res.json({ admin, cafe: { ...cafe, acceptingOrders: Boolean(cafe.acceptingOrders) } });
});

async function settingsPayload(cafeId: string) {
  const row = await db.prepare('SELECT id,name,description,address,phone,currency,tax_bps AS taxBps,accepting_orders AS acceptingOrders,default_prep_minutes AS defaultPrepMinutes,logo_url AS logoUrl FROM cafes WHERE id=?').get(cafeId) as any;
  return row ? { ...row, acceptingOrders: Boolean(row.acceptingOrders) } : null;
}
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await settingsPayload(adminCafe(req));
  settings ? res.json({ settings }) : res.status(404).json({ error: 'Cafe settings not found.' });
});
app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(2).max(100).optional(), description: z.string().max(500).optional(),
    address: z.string().max(250).optional(), phone: z.string().max(40).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(), taxBps: z.number().int().min(0).max(3000).optional(),
    acceptingOrders: z.boolean().optional(), defaultPrepMinutes: z.number().int().min(1).max(240).optional(), logoUrl: imageUrlSchema.nullable().optional(),
  }).strict().safeParse(req.body);
  if (!schema.success || !Object.keys(req.body || {}).length) return res.status(400).json({ error: 'Check cafe settings.', details: schema.success ? undefined : schema.error.flatten() });
  const update = schema.data; const cafeId = adminCafe(req);
  const result = await db.prepare(`UPDATE cafes SET
    name=COALESCE(@name,name), description=COALESCE(@description,description), address=COALESCE(@address,address), phone=COALESCE(@phone,phone),
    currency=COALESCE(@currency,currency), tax_bps=COALESCE(@taxBps,tax_bps), accepting_orders=COALESCE(@acceptingOrders,accepting_orders),
    default_prep_minutes=COALESCE(@defaultPrepMinutes,default_prep_minutes), logo_url=CASE WHEN @logoUrlSpecified=1 THEN @logoUrl ELSE logo_url END
    WHERE id=@cafeId`).run({
      name: update.name ?? null, description: update.description ?? null, address: update.address ?? null, phone: update.phone ?? null,
      currency: update.currency ?? null, taxBps: update.taxBps ?? null,
      acceptingOrders: update.acceptingOrders === undefined ? null : Number(update.acceptingOrders),
      defaultPrepMinutes: update.defaultPrepMinutes ?? null,
      logoUrlSpecified: Object.hasOwn(update, 'logoUrl') ? 1 : 0, logoUrl: update.logoUrl ?? null, cafeId,
    });
  if (!result.changes) return res.status(404).json({ error: 'Cafe settings not found.' });
  res.json({ settings: settingsPayload(cafeId) });
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const cafeId = adminCafe(req); const range = String(req.query.range || 'today'); const now = new Date();
  let start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  if (range === 'yesterday') { start.setUTCDate(start.getUTCDate() - 1); }
  else if (range === '7d') start.setUTCDate(start.getUTCDate() - 6);
  else if (range === '30d') start.setUTCDate(start.getUTCDate() - 29);
  else if (range === 'custom' && typeof req.query.from === 'string' && typeof req.query.to === 'string') {
    const from = new Date(req.query.from); const to = new Date(req.query.to);
    if (!Number.isNaN(+from) && !Number.isNaN(+to) && from <= to) { start = from; now.setTime(to.getTime()); }
  }
  if (range === 'yesterday') now.setTime(start.getTime() + 86_400_000 - 1);
  const fromIso = start.toISOString(); const toIso = now.toISOString();
  const summary = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN payment_status='PAID' THEN total_cents ELSE 0 END),0) AS revenue,
    COUNT(*) AS orders,COALESCE(AVG(total_cents),0) AS averageOrderValue,
    SUM(CASE WHEN status IN ('PENDING','CONFIRMED','PREPARING','READY') THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS completed FROM orders WHERE cafe_id=? AND created_at BETWEEN ? AND ?`).get(cafeId, fromIso, toIso) as any;
  const trend = await db.prepare(`SELECT substr(created_at,1,10) AS date, SUM(CASE WHEN payment_status='PAID' THEN total_cents ELSE 0 END) AS revenue, COUNT(*) AS orders FROM orders WHERE cafe_id=? AND created_at BETWEEN ? AND ? GROUP BY substr(created_at,1,10) ORDER BY date`).all(cafeId, fromIso, toIso);
  const bestSellers = await db.prepare(`SELECT oi.item_name AS name,SUM(oi.quantity) AS quantity,SUM(oi.line_total_cents) AS revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.cafe_id=? AND o.created_at BETWEEN ? AND ? AND o.status!='CANCELLED' GROUP BY oi.item_name ORDER BY quantity DESC LIMIT 5`).all(cafeId, fromIso, toIso);
  const paymentDistribution = await db.prepare(`SELECT payment_method AS method,COUNT(*) AS count,SUM(total_cents) AS amountCents FROM orders WHERE cafe_id=? AND created_at BETWEEN ? AND ? GROUP BY payment_method`).all(cafeId, fromIso, toIso);
  const recentOrderRows = await db.prepare(`SELECT o.*,t.name AS table_name,t.qr_token AS table_qr_token,c.name AS cafe_name,c.currency FROM orders o JOIN cafe_tables t ON t.id=o.table_id JOIN cafes c ON c.id=o.cafe_id WHERE o.cafe_id=? ORDER BY o.created_at DESC LIMIT 8`).all(cafeId);
  const recentOrders = await Promise.all(recentOrderRows.map((row) => presentOrder(row, false)));
  res.json({ range, from: fromIso, to: toIso, summary: { revenueCents: summary.revenue, orders: summary.orders, averageOrderValueCents: Math.round(summary.averageOrderValue), pendingOrders: summary.pending, completedOrders: summary.completed }, salesTrend: trend, bestSellers, paymentDistribution, recentOrders });
});

const categorySchema = z.object({ name: z.string().trim().min(2).max(60), sortOrder: z.number().int().min(0).max(1000).optional().default(0), active: z.boolean().optional().default(true) });
app.get('/api/admin/categories', requireAdmin, async (req, res) => res.json({ categories: (await db.prepare('SELECT id,name,sort_order AS sortOrder,active FROM categories WHERE cafe_id=? ORDER BY sort_order,name').all(adminCafe(req))).map((row: any) => ({ ...row, active: Boolean(row.active) })) }));
app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  const data = categorySchema.safeParse(req.body); if (!data.success) return res.status(400).json({ error: 'Check category details.', details: data.error.flatten() });
  const id = newId('cat'); try { await db.prepare('INSERT INTO categories(id,cafe_id,name,sort_order,active) VALUES(?,?,?,?,?)').run(id, adminCafe(req), data.data.name, data.data.sortOrder, data.data.active ? 1 : 0); } catch (error) { if (isUniqueViolation(error)) return res.status(409).json({ error: 'A category with that name already exists.' }); throw error; }
  res.status(201).json({ category: { id, ...data.data } });
});
app.patch('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  const data = categorySchema.partial().safeParse(req.body); if (!data.success || !Object.keys(req.body || {}).length) return res.status(400).json({ error: 'Check category details.' });
  const old = await db.prepare('SELECT * FROM categories WHERE id=? AND cafe_id=?').get(req.params.id, adminCafe(req)) as any; if (!old) return res.status(404).json({ error: 'Category not found.' });
  const next = { name: data.data.name ?? old.name, sort: data.data.sortOrder ?? old.sort_order, active: data.data.active === undefined ? old.active : Number(data.data.active) };
  try { await db.prepare('UPDATE categories SET name=?,sort_order=?,active=? WHERE id=? AND cafe_id=?').run(next.name, next.sort, next.active, req.params.id, adminCafe(req)); } catch (error) { if (isUniqueViolation(error)) return res.status(409).json({ error: 'A category with that name already exists.' }); throw error; }
  res.json({ category: { id: req.params.id, name: next.name, sortOrder: next.sort, active: Boolean(next.active) } });
});
app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  const used = await db.prepare('SELECT 1 FROM items WHERE category_id=? AND cafe_id=? LIMIT 1').get(req.params.id, adminCafe(req)); if (used) return res.status(409).json({ error: 'Move or remove this category’s menu items first.' });
  const result = await db.prepare('DELETE FROM categories WHERE id=? AND cafe_id=?').run(req.params.id, adminCafe(req)); result.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Category not found.' });
});

const optionsSchema = z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(80), required: z.boolean().optional().default(false), choices: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(80), priceDeltaCents: z.number().int().min(-100000).max(100000).default(0) })).min(1).max(30) })).max(20).default([]);
function isSafeImageUrl(value: string) {
  if (/^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
const imageUrlSchema = z.string().max(1000).refine(isSafeImageUrl, 'Use HTTPS or an image uploaded to this cafe.');
const itemSchema = z.object({ categoryId: z.string().min(1), name: z.string().trim().min(2).max(100), description: z.string().max(500).optional().default(''), imageUrl: imageUrlSchema.optional().nullable(), priceCents: z.number().int().min(0).max(10000000), prepMinutes: z.number().int().min(0).max(240).optional().default(10), isVegetarian: z.boolean().optional().default(false), isVegan: z.boolean().optional().default(false), allergens: z.array(z.string().max(40)).max(20).optional().default([]), options: optionsSchema.optional().default([]), available: z.boolean().optional().default(true) });
function itemForAdmin(row: any) { return { id: row.id, categoryId: row.category_id, name: row.name, description: row.description, imageUrl: row.image_url, priceCents: row.price_cents, prepMinutes: row.prep_minutes, isVegetarian: Boolean(row.vegetarian), isVegan: Boolean(row.vegan), allergens: safeJson(row.allergens_json, []), options: safeJson(row.options_json, []), available: Boolean(row.available) }; }
app.get('/api/admin/items', requireAdmin, async (req, res) => res.json({ items: (await db.prepare('SELECT * FROM items WHERE cafe_id=? ORDER BY updated_at DESC').all(adminCafe(req)) as any[]).map(itemForAdmin) }));
app.post('/api/admin/items', requireAdmin, async (req, res) => {
  const data = itemSchema.safeParse(req.body); if (!data.success) return res.status(400).json({ error: 'Check menu item details.', details: data.error.flatten() });
  const category = await db.prepare('SELECT 1 FROM categories WHERE id=? AND cafe_id=?').get(data.data.categoryId, adminCafe(req)); if (!category) return res.status(400).json({ error: 'Choose a category from this cafe.' });
  const id = newId('item'); const at = nowIso(); const d = data.data;
  await db.prepare(`INSERT INTO items(id,cafe_id,category_id,name,description,image_url,price_cents,prep_minutes,vegetarian,vegan,allergens_json,options_json,available,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, adminCafe(req), d.categoryId, d.name, d.description, d.imageUrl || null, d.priceCents, d.prepMinutes, +d.isVegetarian, +d.isVegan, JSON.stringify(d.allergens), JSON.stringify(d.options), +d.available, at, at);
  res.status(201).json({ item: { id, ...d } });
});
app.patch('/api/admin/items/:id', requireAdmin, async (req, res) => {
  const data = itemSchema.partial().safeParse(req.body); if (!data.success || !Object.keys(req.body || {}).length) return res.status(400).json({ error: 'Check menu item details.', details: data.success ? undefined : data.error.flatten() });
  const old = await db.prepare('SELECT * FROM items WHERE id=? AND cafe_id=?').get(req.params.id, adminCafe(req)) as any; if (!old) return res.status(404).json({ error: 'Menu item not found.' });
  const d = { ...itemForAdmin(old), ...data.data }; if (!await db.prepare('SELECT 1 FROM categories WHERE id=? AND cafe_id=?').get(d.categoryId, adminCafe(req))) return res.status(400).json({ error: 'Choose a category from this cafe.' });
  await db.prepare(`UPDATE items SET category_id=?,name=?,description=?,image_url=?,price_cents=?,prep_minutes=?,vegetarian=?,vegan=?,allergens_json=?,options_json=?,available=?,updated_at=? WHERE id=? AND cafe_id=?`).run(d.categoryId,d.name,d.description,d.imageUrl || null,d.priceCents,d.prepMinutes,+d.isVegetarian,+d.isVegan,JSON.stringify(d.allergens),JSON.stringify(d.options),+d.available,nowIso(),req.params.id,adminCafe(req));
  res.json({ item: { ...d, id: req.params.id } });
});
app.delete('/api/admin/items/:id', requireAdmin, async (req, res) => { const result = await db.prepare('DELETE FROM items WHERE id=? AND cafe_id=?').run(req.params.id, adminCafe(req)); result.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Menu item not found.' }); });

function tablePayload(row: any) { return { id: row.id, name: row.name, active: Boolean(row.active), qrToken: row.qr_token, qrUrl: `${process.env.APP_BASE_URL || ''}/c/${row.qr_token}`, createdAt: row.created_at }; }
app.get('/api/admin/tables', requireAdmin, async (req, res) => res.json({ tables: (await db.prepare('SELECT * FROM cafe_tables WHERE cafe_id=? ORDER BY created_at').all(adminCafe(req)) as any[]).map(tablePayload) }));
app.post('/api/admin/tables', requireAdmin, async (req, res) => {
  const data = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(req.body); if (!data.success) return res.status(400).json({ error: 'Enter a table name.' });
  const row = { id: newId('table'), cafe_id: adminCafe(req), name: data.data.name, qr_token: randomBytes(24).toString('base64url'), active: 1, created_at: nowIso() };
  try { await db.prepare('INSERT INTO cafe_tables(id,cafe_id,name,qr_token,created_at) VALUES(?,?,?,?,?)').run(row.id,row.cafe_id,row.name,row.qr_token,row.created_at); } catch (error) { if (isUniqueViolation(error)) return res.status(409).json({ error: 'A table with that name already exists.' }); throw error; }
  res.status(201).json({ table: tablePayload(row) });
});
app.patch('/api/admin/tables/:id', requireAdmin, async (req, res) => {
  const data = z.object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional(), regenerateQr: z.boolean().optional() }).strict().safeParse(req.body); if (!data.success || !Object.keys(req.body || {}).length) return res.status(400).json({ error: 'Check table details.' });
  const row = await db.prepare('SELECT * FROM cafe_tables WHERE id=? AND cafe_id=?').get(req.params.id,adminCafe(req)) as any; if (!row) return res.status(404).json({ error: 'Table not found.' });
  const name = data.data.name ?? row.name; const active = data.data.active === undefined ? row.active : +data.data.active; const qr = data.data.regenerateQr ? randomBytes(24).toString('base64url') : row.qr_token;
  try { await db.prepare('UPDATE cafe_tables SET name=?,active=?,qr_token=? WHERE id=? AND cafe_id=?').run(name,active,qr,req.params.id,adminCafe(req)); } catch (error) { if (isUniqueViolation(error)) return res.status(409).json({ error: 'A table with that name already exists.' }); throw error; }
  res.json({ table: tablePayload({ ...row, name, active, qr_token: qr }) });
});
app.delete('/api/admin/tables/:id', requireAdmin, async (req, res) => { const result = await db.prepare('UPDATE cafe_tables SET active=0 WHERE id=? AND cafe_id=?').run(req.params.id,adminCafe(req)); result.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Table not found.' }); });

const statuses = ['PENDING','CONFIRMED','PREPARING','READY','SERVED','COMPLETED','CANCELLED'] as const;
const transitions: Record<string, string[]> = { PENDING: ['CONFIRMED','CANCELLED'], CONFIRMED: ['PREPARING','CANCELLED'], PREPARING: ['READY','CANCELLED'], READY: ['SERVED','CANCELLED'], SERVED: ['COMPLETED'], COMPLETED: [], CANCELLED: [] };
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const cafe = adminCafe(req); const status = String(req.query.status || ''); const q = String(req.query.q || '').trim().slice(0, 80);
  if (status && !statuses.includes(status as any)) return res.status(400).json({ error: 'Invalid order status.' });
  const rows = await db.prepare(`SELECT o.*,t.name AS table_name,t.qr_token AS table_qr_token,c.name AS cafe_name,c.currency FROM orders o JOIN cafe_tables t ON t.id=o.table_id JOIN cafes c ON c.id=o.cafe_id WHERE o.cafe_id=? AND (?='' OR o.status=?) AND (?='' OR CAST(o.order_number AS TEXT) LIKE ? OR t.name LIKE ? OR EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.item_name LIKE ?)) ORDER BY CASE o.status WHEN 'PENDING' THEN 0 WHEN 'CONFIRMED' THEN 1 WHEN 'PREPARING' THEN 2 WHEN 'READY' THEN 3 ELSE 4 END,o.created_at LIMIT 250`).all(cafe,status,status,q,`%${q}%`,`%${q}%`,`%${q}%`) as any[];
  res.json({ orders: await Promise.all(rows.map((row) => presentOrder(row, false))) });
});
app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const data = z.object({ status: z.enum(statuses), cancellationReason: z.string().max(300).optional() }).safeParse(req.body); if (!data.success) return res.status(400).json({ error: 'Choose a valid next order status.' });
  const row = await db.prepare('SELECT o.*,t.name AS table_name,t.qr_token AS table_qr_token,c.name AS cafe_name,c.currency FROM orders o JOIN cafe_tables t ON t.id=o.table_id JOIN cafes c ON c.id=o.cafe_id WHERE o.id=? AND o.cafe_id=?').get(req.params.id,adminCafe(req)) as any;
  if (!row) return res.status(404).json({ error: 'Order not found.' });
  if (data.data.status === 'CANCELLED' && row.payment_status === 'PAID') return res.status(409).json({ error: 'Paid orders cannot be cancelled until the payment is refunded.' });
  if (!transitions[row.status]?.includes(data.data.status)) return res.status(409).json({ error: `Cannot move an order from ${row.status} to ${data.data.status}.` });
  if (data.data.status === 'CANCELLED' && !data.data.cancellationReason?.trim()) return res.status(400).json({ error: 'Add a cancellation reason.' });
  if (data.data.status === 'COMPLETED' && row.payment_status !== 'PAID') return res.status(409).json({ error: 'Collect payment before completing this order.' });
  const at = nowIso(); await db.prepare('UPDATE orders SET status=?,cancellation_reason=?,updated_at=? WHERE id=? AND cafe_id=?').run(data.data.status,data.data.status === 'CANCELLED' ? data.data.cancellationReason : row.cancellation_reason,at,req.params.id,adminCafe(req));
  const updated = { ...row, status: data.data.status, cancellation_reason: data.data.status === 'CANCELLED' ? data.data.cancellationReason : row.cancellation_reason, updated_at: at };
  res.json({ order: await presentOrder(updated, false) });
});

app.get('/api/admin/payments', requireAdmin, async (req, res) => {
  const method = String(req.query.method || ''); const status = String(req.query.status || '');
  const rows = await db.prepare(`SELECT p.id,p.order_id AS orderId,p.method,p.status,p.amount_cents AS amountCents,p.provider_reference AS reference,p.refund_reference AS refundReference,p.created_at AS createdAt,p.updated_at AS updatedAt,o.order_number AS orderNumber,o.payment_status AS orderPaymentStatus,o.status AS orderStatus,t.name AS tableName FROM payments p JOIN orders o ON o.id=p.order_id JOIN cafe_tables t ON t.id=o.table_id WHERE p.cafe_id=? AND (?='' OR p.method=?) AND (?='' OR p.status=?) ORDER BY p.created_at DESC LIMIT 500`).all(adminCafe(req),method,method,status,status);
  res.json({ payments: rows });
});
app.patch('/api/admin/payments/:id/collect', requireAdmin, async (req, res) => {
  const row = await db.prepare('SELECT p.*,o.status AS order_status,o.tracking_token FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=? AND p.cafe_id=?').get(req.params.id,adminCafe(req)) as any;
  if (!row) return res.status(404).json({ error: 'Payment not found.' }); if (!['CASH_COUNTER','CASH_TABLE'].includes(row.method)) return res.status(409).json({ error: 'This payment must be completed by its online provider.' });
  if (row.order_status === 'CANCELLED') return res.status(409).json({ error: 'Payment cannot be collected for a cancelled order.' });
  if (row.status === 'PAID') return res.json({ ok: true, status: 'PAID' }); if (row.status === 'REFUNDED') return res.status(409).json({ error: 'This payment has been refunded.' });
  const at = nowIso(); const reference = z.string().max(120).optional().safeParse(req.body?.reference); if (!reference.success) return res.status(400).json({ error: 'Payment reference is too long.' });
  const transaction = db.transaction(async () => {
    const current = await db.prepare('SELECT p.status,o.status AS order_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=? AND p.cafe_id=?').get(req.params.id,adminCafe(req)) as any;
    if (!current) return 'MISSING';
    if (current.status === 'PAID') return 'PAID';
    if (current.status === 'REFUNDED') return 'REFUNDED';
    if (current.order_status === 'CANCELLED') return 'CANCELLED';
    await db.prepare("UPDATE payments SET status='PAID',provider_reference=?,updated_at=? WHERE id=? AND cafe_id=? AND status!='REFUNDED'").run(reference.data || null,at,req.params.id,adminCafe(req));
    await db.prepare("UPDATE orders SET payment_status='PAID',updated_at=? WHERE id=? AND cafe_id=?").run(at,row.order_id,adminCafe(req));
    return 'PAID';
  });
  const result = await transaction();
  if (result === 'MISSING') return res.status(404).json({ error: 'Payment not found.' });
  if (result === 'REFUNDED') return res.status(409).json({ error: 'This payment has been refunded.' });
  if (result === 'CANCELLED') return res.status(409).json({ error: 'Payment cannot be collected for a cancelled order.' });
  res.json({ ok: true, status: 'PAID' });
});

app.post('/api/admin/payments/:id/refund', requireAdmin, asyncRoute(async (req, res) => {
  const reference = z.string().trim().max(120).optional().safeParse(req.body?.reference);
  if (!reference.success) return res.status(400).json({ error: 'Refund reference is too long.' });
  const cafeId = adminCafe(req);
  const row = await db.prepare(`SELECT p.*,o.tracking_token,o.payment_status AS order_payment_status,o.status AS order_status
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=? AND p.cafe_id=?`).get(req.params.id,cafeId) as any;
  if (!row) return res.status(404).json({ error: 'Payment not found.' });
  if (row.status === 'REFUNDED') return res.json({ ok: true, status: 'REFUNDED', refundReference: row.refund_reference });
  if (row.status !== 'PAID' || row.order_payment_status !== 'PAID') return res.status(409).json({ error: 'Only paid orders can be refunded.' });

  let refundReference = reference.data || null;
  if (row.method === 'ONLINE') {
    if (!stripe || !row.provider_reference) return res.status(503).json({ error: 'Stripe refunds are not configured for this payment.' });
    try {
      const checkout = await stripe.checkout.sessions.retrieve(row.provider_reference);
      if (checkout.metadata?.orderId !== row.order_id || checkout.metadata?.cafeId !== cafeId || checkout.amount_total !== row.amount_cents || checkout.currency?.toLowerCase() !== String((await db.prepare('SELECT currency FROM cafes WHERE id=?').get(cafeId) as any)?.currency || '').toLowerCase()) {
        console.error(JSON.stringify({ level: 'critical', action: 'payment_refund_reconciliation_required', paymentId: row.id, sessionId: row.provider_reference, timestamp: nowIso() }));
        return res.status(409).json({ error: 'Payment details do not match the provider record; reconcile before refunding.' });
      }
      const paymentIntent = typeof checkout.payment_intent === 'string' ? checkout.payment_intent : checkout.payment_intent?.id;
      if (!paymentIntent) return res.status(409).json({ error: 'Stripe has no captured payment to refund.' });
      const refund = await stripe.refunds.create({ payment_intent: paymentIntent, reason: 'requested_by_customer', metadata: { cafeId, orderId: row.order_id } }, { idempotencyKey: `cafe-refund-${row.id}` });
      refundReference = refund.id;
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', action: 'stripe_refund_failed', paymentId: row.id, detail: String(error), timestamp: nowIso() }));
      return res.status(502).json({ error: 'The payment provider could not refund this transaction. The payment remains paid.' });
    }
  } else if (!reference.data) {
    return res.status(400).json({ error: 'Record the cash refund receipt or register reference.' });
  }

  const at = nowIso();
  const refundTx = db.transaction(async () => {
    const current = await db.prepare('SELECT p.status,o.payment_status AS order_payment_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=? AND p.cafe_id=?').get(row.id,cafeId) as any;
    if (current?.status === 'REFUNDED' && current.order_payment_status === 'REFUNDED') return;
    if (current?.status !== 'PAID' || current.order_payment_status !== 'PAID') throw new Error('PAYMENT_STATE_CHANGED');
    await db.prepare("UPDATE payments SET status='REFUNDED',refund_reference=?,updated_at=? WHERE id=? AND cafe_id=?").run(refundReference,at,row.id,cafeId);
    await db.prepare("UPDATE orders SET payment_status='REFUNDED',updated_at=? WHERE id=? AND cafe_id=?").run(at,row.order_id,cafeId);
  });
  try { await refundTx(); } catch (error) { if ((error as Error).message === 'PAYMENT_STATE_CHANGED') return res.status(409).json({ error: 'Payment state changed; reload before refunding.' }); throw error; }
  res.json({ ok: true, status: 'REFUNDED', refundReference });
}));

app.get('/api/admin/payments.csv', requireAdmin, async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const status = String(req.query.status || ''); const method = String(req.query.method || '');
  const validStatuses = ['UNPAID','PENDING','PAID','FAILED','REFUNDED']; const validMethods = ['CASH_COUNTER','CASH_TABLE','ONLINE'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || (status && !validStatuses.includes(status)) || (method && !validMethods.includes(method))) return res.status(400).json({ error: 'Use valid dates, payment status, and method filters.' });
  const rows = await db.prepare(`SELECT p.id AS payment_id,o.order_number,t.name AS table_name,p.created_at,p.method,p.status,p.amount_cents,p.provider_reference,p.refund_reference
    FROM payments p JOIN orders o ON o.id=p.order_id JOIN cafe_tables t ON t.id=o.table_id
    WHERE p.cafe_id=? AND p.created_at>=? AND p.created_at<=? AND (?='' OR p.status=?) AND (?='' OR p.method=?) ORDER BY p.created_at`).all(adminCafe(req),`${from}T00:00:00.000Z`,`${to}T23:59:59.999Z`,status,status,method,method) as any[];
  const csvCell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  const lines = [['payment_id','order_number','table','created_at','method','status','amount_cents','provider_reference','refund_reference'].map(csvCell).join(',')];
  for (const row of rows) lines.push([row.payment_id,row.order_number,row.table_name,row.created_at,row.method,row.status,row.amount_cents,row.provider_reference,row.refund_reference].map(csvCell).join(','));
  res.type('text/csv').attachment(`cafe-payments-${from}-to-${to}.csv`).send(lines.join('\r\n'));
});

app.get('/api/admin/reports.csv', requireAdmin, async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return res.status(400).json({ error: 'Use valid from/to dates.' });
  const rows = await db.prepare(`SELECT o.order_number,t.name AS table_name,o.created_at,o.status,o.payment_method,o.payment_status,o.subtotal_cents,o.tax_cents,o.total_cents,STRING_AGG(oi.quantity::text || 'x ' || oi.item_name, '; ') AS items FROM orders o JOIN cafe_tables t ON t.id=o.table_id LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.cafe_id=? AND o.created_at>=? AND o.created_at<=? GROUP BY o.id,t.name ORDER BY o.created_at`).all(adminCafe(req),`${from}T00:00:00.000Z`,`${to}T23:59:59.999Z`) as any[];
  const csvCell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  const lines = [['order_number','table','created_at','status','payment_method','payment_status','subtotal_cents','tax_cents','total_cents','items'].map(csvCell).join(',')];
  for (const row of rows) lines.push([row.order_number,row.table_name,row.created_at,row.status,row.payment_method,row.payment_status,row.subtotal_cents,row.tax_cents,row.total_cents,row.items].map(csvCell).join(','));
  res.type('text/csv').attachment(`cafe-orders-${from}-to-${to}.csv`).send(lines.join('\r\n'));
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const requestId = randomBytes(6).toString('hex');
  console.error(JSON.stringify({ level: 'error', requestId, message: error?.message || 'Unknown error', timestamp: nowIso() }));
  if (res.headersSent) return;
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  res.status(500).json({ error: 'Something went wrong. Please try again.', requestId });
});

export { app };
