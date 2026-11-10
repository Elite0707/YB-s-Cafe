# Cafe Ordering API

All endpoints are same-origin JSON under `/api`; admin routes use an HTTP-only, same-site session cookie. Prices are integer minor units (for example, paise for INR). Cafe ownership comes from the authenticated session. Public customer access is scoped by an unguessable table QR token and order tracking token.

## First run and authentication

- `GET /api/setup/status` → `{ complete }`.
- `POST /api/setup` creates the first cafe/admin only. Body: `{ setupKey, cafeName, description?, address?, phone?, tableName?, adminName, email, password, currency?, taxBps? }`. Requires `SETUP_KEY`; password must be at least 12 characters. Seeds the six standard menu categories and one active table, but no menu items or business metrics. It logs the new admin in.
- `POST /api/cafes/register` creates an additional tenant/owner using the same body except `setupKey`. Rate-limited to four registrations per IP per hour; email is globally unique. It also seeds starter categories and a first table, but no menu items, and establishes an admin session.
- `POST /api/auth/login` body `{ email, password }` → `{ admin }`.
- `POST /api/auth/logout` → `{ ok }`.
- `GET /api/auth/me` → `{ admin, cafe }`; returns 401 when not authenticated.

## Customer ordering

- `GET /api/public/tables/:qrToken` → `{ cafe, table, categories, items }`. Cafe includes `onlinePaymentsEnabled`, true only when Stripe keys and `APP_BASE_URL` are configured. Items include `priceCents`, `available`, `allergens`, `options`, `prepMinutes`, `isVegetarian`, and `isVegan`.
- `POST /api/public/orders` requires header `Idempotency-Key` (12–128 characters) and body `{ qrToken, items: [{ itemId, quantity, options?: [{ optionId, choiceId }], specialInstructions? }], customerNote?, paymentMethod }`. Payment methods: `CASH_COUNTER`, `CASH_TABLE`, `ONLINE`. Server reloads all prices, options, table and availability, and calculates tax from cafe settings. Response: `{ order, trackingToken, checkoutUrl? }`.
- `GET /api/public/orders/:trackingToken` → `{ order }`.
- `GET /api/public/orders/:trackingToken/events` is an SSE stream. It sends `event: order` with the current full order immediately and after each state/payment change.

Order statuses are `PENDING`, `CONFIRMED`, `PREPARING`, `READY`, `SERVED`, `COMPLETED`, `CANCELLED`. Payment statuses are `UNPAID`, `PENDING`, `PAID`, `FAILED`, `REFUNDED`. Online orders require Stripe Checkout secrets and `APP_BASE_URL`. Stripe webhook endpoint: `POST /api/payments/stripe-webhook` with provider signature validation.

## Admin operations

- `GET /api/admin/dashboard?range=today|yesterday|7d|30d` → computed revenue/orders/AOV/order counts, sales trend, best sellers, payment distribution, recent orders. `range=custom&from=<ISO date>&to=<ISO date>` is also accepted.
- `GET /api/admin/settings` → `{ settings }`; `PATCH /api/admin/settings` accepts any subset of `name`, `description`, `address`, `phone`, `currency`, `taxBps`, `acceptingOrders`, `defaultPrepMinutes`, and `logoUrl`, scoped to the signed-in cafe.
- Categories: `GET|POST /api/admin/categories`, `PATCH|DELETE /api/admin/categories/:id`.
- Menu items: `GET|POST /api/admin/items`, `PATCH|DELETE /api/admin/items/:id`. Item writes accept `categoryId`, `name`, `description`, `imageUrl`, `priceCents`, `prepMinutes`, `isVegetarian`, `isVegan`, `allergens`, `options`, and `available`. An option is `{ id, label, required?, choices: [{ id, label, priceDeltaCents }] }`.
- `POST /api/admin/uploads` accepts raw PNG/JPEG/WebP bytes (`image/*` or `application/octet-stream`) and returns `{ url }`. It requires an admin session, verifies the file signature, caps bodies at 5 MiB, stores an opaque generated filename, and serves only generated raster names at `/uploads/:filename`. Item `imageUrl` and cafe `logoUrl` accept HTTPS URLs or those generated paths; SVG, other MIME types, and arbitrary local paths are rejected.
- Tables: `GET|POST /api/admin/tables`, `PATCH|DELETE /api/admin/tables/:id`. Delete deactivates; patch `{ regenerateQr: true }` rotates the secret URL. Responses include `qrUrl` and `qrToken` for printing.
- Orders: `GET /api/admin/orders?status=&q=`, authenticated `GET /api/admin/orders/events` (SSE pushes changed orders in this cafe only), and `PATCH /api/admin/orders/:id` body `{ status, cancellationReason? }`. The server enforces valid state transitions; completion requires paid status.
- Payments: `GET /api/admin/payments?method=&status=` includes the linked order status, `PATCH /api/admin/payments/:id/collect` body `{ reference? }` records cash collection, and `POST /api/admin/payments/:id/refund` records an offline refund with `{ reference }` or issues an idempotent Stripe refund for an online payment. Refunds update the order/payment state together; online refunds require the original Checkout session and Stripe API access.
- Order CSV export: `GET /api/admin/reports.csv?from=YYYY-MM-DD&to=YYYY-MM-DD`.
- Transaction CSV export: `GET /api/admin/payments.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&status=&method=` includes payment/order/table identifiers, provider reference, method, status, and amount. Both exports are tenant-scoped and formula-escape text cells.

## Errors and security

`GET /api/health` returns a lightweight `{ status: "ok", timestamp }` liveness response. It does not expose database or secret details.

Errors return `{ error, details? }`; validation errors are 400, unauthenticated admin access is 401, unavailable/conflicting business states are 409, and unexpected failures include a request ID. Session records are stored in SQLite and expired sessions are pruned hourly. API writes validate input, rate limits apply globally and more strictly to login/setup/registration/order routes, admin SQL always includes the session's cafe ID, and all public table/order handles are cryptographically random. `SETUP_KEY` disables bootstrap after the first admin exists. Do not expose `DATABASE_PATH`, secrets, session data, or customer tracking tokens in logs.

`TRUST_PROXY` is unset by default, so Express does not trust forwarded headers. Set it only behind a known reverse proxy: use a hop count such as `1`, or a comma-separated list of trusted proxy IPs/CIDRs. State-changing browser requests are checked against the request's own origin by default. `APP_ORIGIN` can explicitly set one or more comma-separated allowed origins; `APP_BASE_URL` is reserved for QR/payment links and is not used for origin validation.

Persist and back up both `DATABASE_PATH` and `UPLOADS_PATH` (or the default uploads directory beside the SQLite file). Keep their backup/restore points coordinated so cafe image URLs continue to resolve after database restoration. Use durable mounted storage in production; do not place uploads on an ephemeral container filesystem.
