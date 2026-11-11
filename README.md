# YB'S BREWING · Cafe Ordering

YB'S BREWING is a multi-tenant cafe ordering app. Guests scan a table QR code, browse a live menu, customize items and submit an order without an account. Cafe staff use a separate authenticated dashboard to manage the menu, tables, orders and payment records.

Repository: `YB-s-Cafe`.

## Architecture

- **Web client:** React, TypeScript and Vite. Customer routes are separate from protected cafe-admin routes.
- **API:** Express with server-side validation, rate limits, secure cookie sessions and same-origin JSON endpoints.
- **Persistence:** PostgreSQL through `pg`. Versioned schemas live in `db/pg-migrations/`; local API startup applies pending migrations and uses PostgreSQL transactions for order/payment writes and persisted sessions.
- **Tenant boundaries:** Each admin session resolves to one cafe. Admin queries are scoped to that cafe on the server. Customer routes resolve an unguessable QR token to one active table and cafe. Order tracking uses a separate opaque token.
- **Live updates:** Order changes are published over Server-Sent Events; clients reconnect and can fetch a fresh order snapshot.
- **Payments:** Cash at counter/table is recorded as unpaid until collected by an admin. Stripe Checkout is optional; the server creates the checkout session and only its signed webhook can mark an online payment paid.

All displayed operational figures and menu content come from the database. First-run setup creates the owner, cafe, starter categories and an initial table; it does not insert sample revenue or pretend orders.

## Requirements

- Node.js 20.19 or newer
- npm 10 or newer
- PostgreSQL 16 or newer and a `DATABASE_URL`
- Stripe account and public HTTPS webhook endpoint only if online card payments are enabled

## Local setup

1. Create a local PostgreSQL database named `cafe_dev` (for example, in pgAdmin). Copy `.env.example` to `.env`, set `DATABASE_URL` to your local connection, and replace `SETUP_KEY` and `SESSION_SECRET` with long random values. For a local server, set `DATABASE_SSL=disable`. Keep `.env` out of source control.
2. Install dependencies and start the API and web client:

```bash
npm install
npm run dev
```

3. Open `http://localhost:5173/admin/setup`, create the first cafe owner, and enter `SETUP_KEY` from `.env`. The first-owner setup endpoint is disabled once an owner exists; the same onboarding page supports additional cafe tenants through rate-limited registration.
4. Sign in at `/admin/login`. Add categories and menu items, then create tables and download/print each QR code. Add a menu item before placing a customer order.
5. Open a generated QR URL (or scan it on a phone on the same network). Guest routes look like `/c/<opaque-table-token>`.

The Vite dev server proxies `/api` to `http://localhost:3000`. To open the development app from another device, run Vite with a reachable host and configure the API proxy/server firewall for that network.

## Netlify deployment

The frontend is published from `dist/`, and the Express API is adapted to a Netlify Function at `netlify/functions/api.ts`. `netlify.toml` routes `/api/*` and `/uploads/*` through that function and keeps React Router routes working. Customer tracking and the admin order queue poll their existing JSON endpoints instead of holding open SSE connections.

1. In Netlify, set `DATABASE_URL` to Neon's pooled URL, `APP_BASE_URL` to the deployed HTTPS site origin, `SESSION_SECRET` to a random secret of at least 32 characters, and `SETUP_KEY` to a one-time setup key. Add `NEON_S3_ACCESS_KEY_ID`, `NEON_S3_SECRET_ACCESS_KEY`, `NEON_S3_ENDPOINT`, and `NEON_S3_REGION` with the corresponding Neon bucket values. The app maps these aliases to the AWS names required by the Neon storage adapter. Without these values, image uploads are disabled in the function deployment.
2. For online payments, also set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Optionally set `APP_ORIGIN` to the exact deployed HTTPS origin.
3. Keep `DATABASE_URL_UNPOOLED` available only where schema migrations are run; it is not needed for normal function requests. Apply schema changes with `npm run db:migrate` before deploying. Do not run schema migrations in each serverless function invocation.
4. Deploy from the project root. Netlify uses `npm run build`, publishes `dist/`, and bundles the Express adapter function. Configure the Stripe webhook URL as `<site-origin>/api/payments/stripe-webhook` when online payments are enabled.

Netlify Functions are request scoped, so browser views refresh order data by polling. Uploads are limited to 4 MiB to stay below the function request payload cap; menu photos are stored in Neon Object Storage, never on the function filesystem.

## Node host deployment

1. Build with `npm run build` and run `npm start` with `NODE_ENV=production`.
2. Configure `APP_BASE_URL` to the externally reachable HTTPS origin. Serve the built `dist/` client and `/api` from the same origin, or configure the reverse proxy to forward both to the Node service. Keep the Stripe webhook path public to Stripe and route it to the API before any JSON body parser.
3. For Neon, run `neon deploy` from the project to provision the declared Postgres and `cafe-menu-images` bucket. Copy `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and the `AWS_*` values from the generated local env file into the Node API host's secret environment settings. Keep the pooled URL as `DATABASE_URL`; the app uses `DATABASE_URL_UNPOOLED` for schema migrations. Also set a cryptographically random `SESSION_SECRET` (32+ bytes), a one-time `SETUP_KEY`, and do not set `DATABASE_SSL=disable` for the hosted database. Never bake secrets into client code or a container image.
4. Configure Stripe `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` for the webhook route documented in [server/API.md](server/API.md). Leave both unset to disable online payments; cash orders remain available.
5. Terminate TLS at a trusted reverse proxy, forward the original protocol, and configure Express proxy trust only for that proxy. Restrict database volume access to the service account.
6. Configure and periodically verify PostgreSQL backups on your database host. Retain backups according to local payment and privacy requirements.

PostgreSQL supports concurrent order writes and shared sessions across API instances. Customer order tracking and the admin queue poll the API for updates.

## Operations and data

- `DATABASE_URL` is required by the API. The local development connection should point to `localhost:5432/cafe_dev`.
- With Neon `AWS_*` credentials configured, admin image uploads go to the public-read `cafe-menu-images` object-storage bucket and return public HTTPS URLs for guest menus. Without those credentials, uploads use `UPLOADS_PATH` (or `data/uploads`), which must be persistent on the API host.
- `TRUST_PROXY` defaults to off. Set it to the known trusted proxy hop count or proxy CIDRs only when the app sits behind a reverse proxy. State-changing browser requests default to the request's own origin; set `APP_ORIGIN` to one or more comma-separated origins only when an explicit allowlist is needed. `APP_BASE_URL` is used for QR/payment links and does not control browser-origin validation.
- Keep health and request logs in the hosting platform. API errors do not expose stack traces to clients.
- Payments are reconciled from signed Stripe webhook events or admin-recorded cash collection. Full refunds are supported through the payment dashboard; online refunds require Stripe configuration.
- The admin dashboard export is CSV and should be handled as business-sensitive data.

## Project notes

- [Implemented features, decisions, and follow-up work](FEATURES.md)
- [API routes and payloads](server/API.md)
- [PostgreSQL migrations](db/pg-migrations/)

