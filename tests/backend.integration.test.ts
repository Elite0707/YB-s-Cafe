import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Buffer } from 'node:buffer';

describe('cafe ordering API', () => {
  let app: (typeof import('../server/app.js'))['app'];
  let db: (typeof import('../server/db.js'))['db'];
  let server: Server;
  let api: string;
  let tempDir: string;
  let cafeId: string;
  let ownerCookie = '';
  let secondCafeCookie = '';

  async function call(route: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.cookie) headers.cookie = options.cookie;
    const response = await fetch(`${api}${route}`, { method: options.method || 'GET', headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
    return { response, data };
  }
  async function upload(bytes: Buffer, contentType: string, cookie = ownerCookie) {
    const response = await fetch(`${api}/admin/uploads`, { method: 'POST', headers: { 'content-type': contentType, ...(cookie ? { cookie } : {}) }, body: bytes });
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
    return { response, data };
  }
  const saveCookie = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] || '';

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'cafe-order-test-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    process.env.UPLOADS_PATH = path.join(tempDir, 'uploads');
    process.env.SETUP_KEY = 'integration-test-bootstrap-key';
    process.env.SESSION_SECRET = 'integration-test-session-secret-which-is-long';
    process.env.APP_BASE_URL = 'http://localhost:4173';
    delete process.env.APP_ORIGIN;
    process.env.STRIPE_SECRET_KEY = 'sk_test_cafe_order_integration';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_cafe_order_integration';
    process.env.NODE_ENV = 'test';
    ({ app } = await import('../server/app.js'));
    ({ db } = await import('../server/db.js'));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
    api = `http://127.0.0.1:${address.port}/api`;
  }, 30_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (db?.open) db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('enforces tenant scope through setup, menu, ordering, payment, reporting, and sessions', async () => {
    const unauthenticated = await call('/admin/categories');
    expect(unauthenticated.response.status).toBe(401);

    const setup = await call('/setup', { method: 'POST', body: {
      setupKey: 'integration-test-bootstrap-key', cafeName: 'Juniper House', description: 'Coffee and small plates', address: '8 Garden Lane',
      phone: '+91 90000 00000', tableName: 'Patio 2', adminName: 'Cafe Owner', email: 'owner@juniper.test',
      password: 'integration-owner-password', currency: 'INR', taxBps: 1000,
    }, headers: { origin: new URL(api).origin } });
    expect(setup.response.status).toBe(201);
    cafeId = setup.data.cafe.id;
    ownerCookie = saveCookie(setup.response);
    expect(ownerCookie).toContain('cafe.sid=');
    expect((await call('/auth/me', { cookie: ownerCookie })).data.admin.email).toBe('owner@juniper.test');
    const blockedOrigin = await call('/auth/login', { method: 'POST', headers: { origin: 'https://untrusted.example' }, body: { email: 'owner@juniper.test', password: 'integration-owner-password' } });
    expect(blockedOrigin.response.status).toBe(403);
    const proxiedOrigin = await call('/proxy-origin-probe', { method: 'POST', headers: { origin: 'http://127.0.0.1:5173', 'x-forwarded-host': '127.0.0.1:5173', 'x-forwarded-proto': 'http' }, body: {} });
    expect(proxiedOrigin.response.status).toBe(404);
    const settingsUpdate = await call('/admin/settings', { method: 'PATCH', cookie: ownerCookie, body: { acceptingOrders: true, defaultPrepMinutes: 12 } });
    expect(settingsUpdate.response.status).toBe(200);
    expect(settingsUpdate.data.settings.defaultPrepMinutes).toBe(12);

    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4cAAAAASUVORK5CYII=', 'base64');
    expect((await upload(pngBytes, 'image/png', '')).response.status).toBe(401);
    const uploaded = await upload(pngBytes, 'image/png');
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.data.url).toMatch(/^\/uploads\/[a-f0-9]{32}\.png$/);
    const publicImage = await fetch(`http://127.0.0.1:${(server.address() as any).port}${uploaded.data.url}`);
    expect(publicImage.status).toBe(200);
    expect(publicImage.headers.get('content-type')).toContain('image/png');
    expect(publicImage.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await upload(Buffer.from('not actually an image'), 'image/png')).response.status).toBe(415);
    expect((await upload(pngBytes, 'image/jpeg')).response.status).toBe(400);
    expect((await upload(Buffer.concat([pngBytes, Buffer.alloc(5 * 1024 * 1024)]), 'image/png')).response.status).toBe(413);
    const logoUpdate = await call('/admin/settings', { method: 'PATCH', cookie: ownerCookie, body: { logoUrl: uploaded.data.url } });
    expect(logoUpdate.response.status).toBe(200);
    expect(logoUpdate.data.settings.logoUrl).toBe(uploaded.data.url);

    const categories = await call('/admin/categories', { cookie: ownerCookie });
    const coffee = categories.data.categories.find((category: any) => category.name === 'Coffee');
    expect(coffee).toBeTruthy();
    const createdItem = await call('/admin/items', { method: 'POST', cookie: ownerCookie, body: {
      categoryId: coffee.id, name: 'Maple latte', description: 'Espresso with maple and steamed milk', priceCents: 500,
      imageUrl: uploaded.data.url, prepMinutes: 7, isVegetarian: true, isVegan: false, allergens: ['milk'], available: true,
      options: [{ id: 'size', label: 'Size', required: true, choices: [{ id: 'regular', label: 'Regular', priceDeltaCents: 0 }, { id: 'large', label: 'Large', priceDeltaCents: 125 }] }],
    } });
    expect(createdItem.response.status).toBe(201);
    const unsafeImageItem = await call('/admin/items', { method: 'POST', cookie: ownerCookie, body: { ...createdItem.data.item, imageUrl: 'javascript:alert(1)' } });
    expect(unsafeImageItem.response.status).toBe(400);
    const tableResponse = await call('/admin/tables', { cookie: ownerCookie });
    const table = tableResponse.data.tables[0];
    expect(table.name).toBe('Patio 2');
    expect(table.qrUrl).toContain(`/c/${table.qrToken}`);
    const publicMenu = await call(`/public/tables/${table.qrToken}`);
    expect(publicMenu.data.cafe.name).toBe('Juniper House');
    expect(publicMenu.data.cafe.onlinePaymentsEnabled).toBe(true);
    expect(publicMenu.data.items).toHaveLength(1);

    const orderBody = { qrToken: table.qrToken, paymentMethod: 'CASH_COUNTER', items: [{ itemId: createdItem.data.item.id, quantity: 2, options: [{ optionId: 'size', choiceId: 'large' }], specialInstructions: 'Oat milk' }] };
    const orderResult = await call('/public/orders', { method: 'POST', headers: { 'Idempotency-Key': 'integration-order-key-0001' }, body: { ...orderBody, totalCents: 1 } });
    expect(orderResult.response.status).toBe(201);
    expect(orderResult.data.order.subtotalCents).toBe(1250);
    expect(orderResult.data.order.taxCents).toBe(125);
    expect(orderResult.data.order.totalCents).toBe(1375);
    expect(orderResult.data.order.items[0].unitPriceCents).toBe(625);
    const idempotentRetry = await call('/public/orders', { method: 'POST', headers: { 'Idempotency-Key': 'integration-order-key-0001' }, body: orderBody });
    expect(idempotentRetry.data.order.id).toBe(orderResult.data.order.id);
    expect(idempotentRetry.data.trackingToken).toBe(orderResult.data.trackingToken);

    const customerEventResponse = await fetch(`${api}/public/orders/${orderResult.data.trackingToken}/events`);
    const customerReader = customerEventResponse.body!.getReader();
    expect(new TextDecoder().decode((await customerReader.read()).value)).toContain('"status":"PENDING"');
    const adminEventResponse = await fetch(`${api}/admin/orders/events`, { headers: { cookie: ownerCookie } });
    const adminReader = adminEventResponse.body!.getReader();
    expect(new TextDecoder().decode((await adminReader.read()).value)).toContain('event: connected');

    const invalidTransition = await call(`/admin/orders/${orderResult.data.order.id}`, { method: 'PATCH', cookie: ownerCookie, body: { status: 'COMPLETED' } });
    expect(invalidTransition.response.status).toBe(409);
    const confirmed = await call(`/admin/orders/${orderResult.data.order.id}`, { method: 'PATCH', cookie: ownerCookie, body: { status: 'CONFIRMED' } });
    expect(confirmed.response.status).toBe(200);
    expect(new TextDecoder().decode((await customerReader.read()).value)).toContain('"status":"CONFIRMED"');
    expect(new TextDecoder().decode((await adminReader.read()).value)).toContain('"status":"CONFIRMED"');
    await customerReader.cancel(); await adminReader.cancel();
    for (const status of ['PREPARING', 'READY']) {
      const update = await call(`/admin/orders/${orderResult.data.order.id}`, { method: 'PATCH', cookie: ownerCookie, body: { status } });
      expect(update.response.status).toBe(200);
    }
    const payments = await call('/admin/payments', { cookie: ownerCookie });
    const cash = payments.data.payments[0];
    const collect = await call(`/admin/payments/${cash.id}/collect`, { method: 'PATCH', cookie: ownerCookie, body: { reference: 'Till receipt 42' } });
    expect(collect.data.status).toBe('PAID');
    const paidCancel = await call(`/admin/orders/${orderResult.data.order.id}`, { method: 'PATCH', cookie: ownerCookie, body: { status: 'CANCELLED', cancellationReason: 'Changed mind' } });
    expect(paidCancel.response.status).toBe(409);
    expect(paidCancel.data.error).toContain('refunded');
    const served = await call(`/admin/orders/${orderResult.data.order.id}`, { method: 'PATCH', cookie: ownerCookie, body: { status: 'SERVED' } });
    expect(served.response.status).toBe(200);
    const completed = await call(`/admin/orders/${orderResult.data.order.id}`, { method: 'PATCH', cookie: ownerCookie, body: { status: 'COMPLETED' } });
    expect(completed.data.order.status).toBe('COMPLETED');

    const dashboard = await call('/admin/dashboard?range=today', { cookie: ownerCookie });
    expect(dashboard.data.summary.revenueCents).toBe(1375);
    expect(dashboard.data.summary.orders).toBe(1);
    const report = await fetch(`${api}/admin/reports.csv`, { headers: { cookie: ownerCookie } });
    const reportCsv = await report.text();
    expect(report.status).toBe(200);
    expect(reportCsv).toContain('Maple latte');
    expect(reportCsv).toContain('1375');
    const paymentReport = await fetch(`${api}/admin/payments.csv`, { headers: { cookie: ownerCookie } });
    const paymentCsv = await paymentReport.text();
    expect(paymentReport.status).toBe(200);
    expect(paymentCsv).toContain('Till receipt 42');
    expect(paymentCsv).toContain('PAID');
    const refundResult = await call(`/admin/payments/${cash.id}/refund`, { method: 'POST', cookie: ownerCookie, body: { reference: 'Cash refund 9' } });
    expect(refundResult.response.status).toBe(200);
    expect(refundResult.data.status).toBe('REFUNDED');
    const refundedOrder = await call(`/public/orders/${orderResult.data.trackingToken}`);
    expect(refundedOrder.data.order.paymentStatus).toBe('REFUNDED');

    const timestamp = new Date().toISOString();
    const lateOrderId = 'order_late_stripe_fixture'; const latePaymentId = 'payment_late_stripe_fixture';
    const lateTrackingToken = 'late-stripe-order-tracking-token-is-long'; const lateSessionId = 'cs_test_late_cancelled_payment';
    db.prepare(`INSERT INTO orders(id,cafe_id,table_id,order_number,tracking_token,status,payment_method,payment_status,subtotal_cents,tax_cents,total_cents,created_at,updated_at)
      VALUES(?,?,?,?,?,'CANCELLED','ONLINE','PENDING',700,70,770,?,?)`).run(lateOrderId,cafeId,table.id,2,lateTrackingToken,timestamp,timestamp);
    db.prepare(`INSERT INTO payments(id,cafe_id,order_id,method,status,amount_cents,provider_reference,created_at,updated_at) VALUES(?,?,?,'ONLINE','PENDING',?,?,?,?)`).run(latePaymentId,cafeId,lateOrderId,770,lateSessionId,timestamp,timestamp);

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    async function sendPaidCheckoutWebhook(sessionId: string, orderId: string, amount: number) {
      const payload = JSON.stringify({ id: `evt_${sessionId}`, object: 'event', api_version: '2025-02-24.acacia', created: Math.floor(Date.now() / 1000), data: { object: { id: sessionId, object: 'checkout.session', amount_total: amount, currency: 'inr', payment_status: 'paid', metadata: { orderId, cafeId } } }, livemode: false, pending_webhooks: 1, request: null, type: 'checkout.session.completed' });
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
      return fetch(`${api}/payments/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload });
    }
    const lateWebhook = await sendPaidCheckoutWebhook(lateSessionId, lateOrderId, 770);
    expect(lateWebhook.status).toBe(200);
    const duplicateLateWebhook = await sendPaidCheckoutWebhook(lateSessionId, lateOrderId, 770);
    expect(duplicateLateWebhook.status).toBe(200);
    expect((db.prepare('SELECT payment_status,status FROM orders WHERE id=?').get(lateOrderId) as any)).toEqual({ payment_status: 'PAID', status: 'CANCELLED' });
    expect((db.prepare('SELECT status FROM payments WHERE id=?').get(latePaymentId) as any).status).toBe('PAID');

    const mismatchOrderId = 'order_amount_mismatch_fixture'; const mismatchPaymentId = 'payment_amount_mismatch_fixture';
    const mismatchSessionId = 'cs_test_amount_mismatch'; const mismatchTrackingToken = 'amount-mismatch-order-tracking-token';
    db.prepare(`INSERT INTO orders(id,cafe_id,table_id,order_number,tracking_token,status,payment_method,payment_status,subtotal_cents,tax_cents,total_cents,created_at,updated_at)
      VALUES(?,?,?,?,?,'PENDING','ONLINE','PENDING',700,70,770,?,?)`).run(mismatchOrderId,cafeId,table.id,3,mismatchTrackingToken,timestamp,timestamp);
    db.prepare(`INSERT INTO payments(id,cafe_id,order_id,method,status,amount_cents,provider_reference,created_at,updated_at) VALUES(?,?,?,'ONLINE','PENDING',?,?,?,?)`).run(mismatchPaymentId,cafeId,mismatchOrderId,770,mismatchSessionId,timestamp,timestamp);
    const mismatchWebhook = await sendPaidCheckoutWebhook(mismatchSessionId, mismatchOrderId, 769);
    const mismatchState = db.prepare('SELECT o.payment_status,o.status,p.status AS payment_status_row FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=?').get(mismatchOrderId) as any;
    expect(mismatchWebhook.status).toBe(200);
    expect((await mismatchWebhook.json() as any).reconciliationRequired).toBe(true);
    expect(mismatchState).toEqual({ payment_status: 'PENDING', status: 'CANCELLED', payment_status_row: 'PENDING' });

    // The public registration flow creates a separate tenant with its own session.
    const secondRegistration = await call('/cafes/register', { method: 'POST', body: {
      cafeName: 'Other Cafe', tableName: 'Window Seat', adminName: 'Other Owner', email: 'owner@other.test', password: 'secondary-owner-password', currency: 'INR',
    } });
    expect(secondRegistration.response.status).toBe(201);
    secondCafeCookie = saveCookie(secondRegistration.response);
    const otherCategories = await call('/admin/categories', { cookie: secondCafeCookie });
    expect(otherCategories.data.categories).toHaveLength(6);
    expect(otherCategories.data.categories.some((category: any) => category.id === coffee.id)).toBe(false);
    const crossTenantItem = await call(`/admin/items/${createdItem.data.item.id}`, { method: 'PATCH', cookie: secondCafeCookie, body: { priceCents: 1 } });
    expect(crossTenantItem.response.status).toBe(404);
    const secondTables = await call('/admin/tables', { cookie: secondCafeCookie });
    expect(secondTables.data.tables[0].name).toBe('Window Seat');
    const secondPublicMenu = await call(`/public/tables/${secondTables.data.tables[0].qrToken}`);
    expect(secondPublicMenu.data.cafe.name).toBe('Other Cafe');
    expect(secondPublicMenu.data.items).toHaveLength(0);

    await call('/auth/logout', { method: 'POST', cookie: ownerCookie });
    expect((await call('/admin/orders', { cookie: ownerCookie })).response.status).toBe(401);
  });
});
