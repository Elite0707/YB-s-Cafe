# YB'S BREWING · Cafe Ordering

YB'S BREWING is a multi-tenant cafe ordering app. Guests scan a table QR code, browse a live menu, customize items and submit an order without an account. Cafe staff use a separate authenticated dashboard to manage the menu, tables, orders and payment records.

Repository: `YB-s-Cafe`.

## Architecture

- **Web client:** React, TypeScript and Vite. Customer routes are separate from protected cafe-admin routes.
- **API:** Express with server-side validation, rate limits, secure cookie sessions and same-origin JSON endpoints.
- **Persistence:** SQLite through `better-sqlite3`. Schema and indexes live in `db/migrations/001_init.sql`; startup applies the migration. Foreign keys and WAL mode are enabled.
- **Tenant boundaries:** Each admin session resolves to one cafe. Admin queries are scoped to that cafe on the server. Customer routes resolve an unguessable QR token to one active table and cafe. Order tracking uses a separate opaque token.
- **Live updates:** Order changes are published over Server-Sent Events; clients reconnect and can fetch a fresh order snapshot.
- **Payments:** Cash at counter/table is recorded as unpaid until collected by an admin. Stripe Checkout is optional; the server creates the checkout session and only its signed webhook can mark an online payment paid.

All displayed operational figures and menu content come from the database. First-run setup creates the owner, cafe, starter categories and an initial table; it does not insert sample revenue or pretend orders.

## Requirements

- Node.js 20.19 or newer
- npm 10 or newer
- A durable writable directory for the SQLite database
- Stripe account and public HTTPS webhook endpoint only if online card payments are enabled

## Local setup

1. Copy `.env.example` to `.env` and replace `SETUP_KEY` and `SESSION_SECRET` with long random values. Keep `.env` out of source control.
2. Install dependencies and start the API and web client:

```bash
npm install
npm run dev
```

3. Open `http://localhost:5173/admin/setup`, create the first cafe owner, and enter `SETUP_KEY` from `.env`. The first-owner setup endpoint is disabled once an owner exists; the same onboarding page supports additional cafe tenants through rate-limited registration.
4. Sign in at `/admin/login`. Add categories and menu items, then create tables and download/print each QR code. Add a menu item before placing a customer order.
5. Open a generated QR URL (or scan it on a phone on the same network). Guest routes look like `/c/<opaque-table-token>`.

The Vite dev server proxies `/api` to `http://localhost:3000`. To open the development app from another device, run Vite with a reachable host and configure the API proxy/server firewall for that network.

## Production deployment

1. Build with `npm run build` and run `npm start` with `NODE_ENV=production`.
2. Configure `APP_BASE_URL` to the externally reachable HTTPS origin. Serve the built `dist/` client and `/api` from the same origin, or configure the reverse proxy to forward both to the Node service. Keep the Stripe webhook path public to Stripe and route it to the API before any JSON body parser.
3. Set a cryptographically random `SESSION_SECRET` (32+ bytes), a one-time `SETUP_KEY`, and `DATABASE_PATH` on a persistent volume. Never bake secrets into client code or a container image.
4. Configure Stripe `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` for the webhook route documented in [server/API.md](server/API.md). Leave both unset to disable online payments; cash orders remain available.
5. Terminate TLS at a trusted reverse proxy, forward the original protocol, and configure Express proxy trust only for that proxy. Restrict database volume access to the service account.
6. Back up the database on a schedule. Use SQLite's online backup API or stop the service before copying the database together with any WAL files. Test restore procedures. Retain backups according to local payment and privacy requirements.

### Netlify deployment and database

Netlify's static site hosting serves the React/Vite files; it does not run this repository's Express API. The client sends sign-in requests to `/api/auth/login`, so deploying only the `dist/` folder to Netlify makes those requests return 404. The app's SQLite database is also a local file and must live on persistent server storage; a serverless function's temporary filesystem is not a safe database.

The included [Render Blueprint](render.yaml) deploys the built frontend and Express API together and mounts a persistent disk at `/var/data` for the SQLite database and uploaded images. It uses Render's Starter web-service plan because Render's free web services do not support persistent disks.

1. In Render, create a **Blueprint** from this GitHub repository and approve the `ybs-cafe` service. Review the plan and disk cost before creating it.
2. Wait for the deploy to finish, then open the service URL. `/api/health` should return `{"status":"ok", ...}`.
3. In Render's Environment settings, reveal the generated `SETUP_KEY`. Visit `<your-render-url>/admin/setup` and use that key to create the cafe owner. The generated `SESSION_SECRET` is already configured.
4. Use the Render service URL for the app and its QR codes. The Render-hosted service serves both the UI and `/api`, so sign-in stays same-origin. The existing Netlify static deployment can be retired or kept as a separate preview; it will continue to show API 404s until a backend proxy is configured.
5. The database is `/var/data/cafe.sqlite`; uploads are stored at `/var/data/uploads`. Back up the persistent disk regularly. A fresh Render service starts with a new database, so recreate your cafe, categories, menu, and tables unless you arrange a secure migration from an existing database.
6. Online card payments remain disabled until you add Stripe's `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and set `APP_BASE_URL` to the final public HTTPS URL in Render's Environment settings. Cash payments work without Stripe.

Do not set `DATABASE_PATH` to a Netlify build directory or commit the local `data/cafe.sqlite` file. Neither is durable production storage.

This starter uses a single-writer SQLite database, which is appropriate for an individual small cafe and low-to-moderate traffic. For a larger multi-instance deployment, migrate to PostgreSQL and shared session/event infrastructure before scaling horizontally.

## Operations and data

- `DATABASE_PATH` defaults to `./data/cafe.sqlite`; the app creates its parent directory.
- Uploaded raster images and the SQLite database should live on durable storage and be included in the same backup schedule.
- `TRUST_PROXY` defaults to off. Set it to the known trusted proxy hop count or proxy CIDRs only when the app sits behind a reverse proxy. State-changing browser requests default to the request's own origin; set `APP_ORIGIN` to one or more comma-separated origins only when an explicit allowlist is needed. `APP_BASE_URL` is used for QR/payment links and does not control browser-origin validation.
- Keep health and request logs in the hosting platform. API errors do not expose stack traces to clients.
- Payments are reconciled from signed Stripe webhook events or admin-recorded cash collection. Full refunds are supported through the payment dashboard; online refunds require Stripe configuration.
- The admin dashboard export is CSV and should be handled as business-sensitive data.

## Project notes

- [Implemented features, decisions, and follow-up work](FEATURES.md)
- [API routes and payloads](server/API.md)
- [Database migration](db/migrations/001_init.sql)

