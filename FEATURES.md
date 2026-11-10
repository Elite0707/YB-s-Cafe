# Product implementation notes

## Delivered

- **Customer flow:** QR-token cafe/table resolution, mobile-first menu, category navigation, search, item options, quantities, special instructions, cart persistence, cash or online checkout choice, opaque order tracking, live status refresh, and recent orders scoped to the scanned table on the current device.
- **Cafe admin:** first-owner setup, sign-in/sign-out, cafe-scoped dashboard analytics, order queue and status actions, category/item management, table management with unique QR tokens and printable codes, image uploads for menu items and cafe branding, payment reconciliation, and CSV reporting.
- **Service safeguards:** server-side price and availability checks, server-managed order totals, idempotent order creation, secure cookie sessions, password hashing, request validation, rate limits, tenant filtering, Stripe webhook signature and amount/currency checks, and SSE order events.
- **Payments and reporting:** verified Stripe checkout and full-refund flow, offline collection and refunds with references, idempotent payment handling, cafe-scoped transaction exports, and formula-safe CSV cells.
- **Persistence:** indexed SQLite relations, immutable item/price snapshots on placed order lines, durable raster image storage, and an application-level error boundary.

## Decisions

- Prices are stored as integer cents to avoid floating-point currency errors. Cafe tax is stored in basis points.
- Each table has an opaque random QR token. The QR URL does not accept a user-selected cafe/table ID.
- Guest order access is via a high-entropy tracking token and requires no account.
- Cash selection places an order as unpaid; only an authenticated cafe admin can record collection.
- Stripe is optional at startup. Online payments and online refunds require server secrets; the browser never confirms a payment on its own.
- SQLite keeps local setup simple for one cafe per service deployment while all operational records remain tenant-keyed for isolation. Higher concurrency requires a PostgreSQL migration and shared event/session infrastructure.

## Follow-up improvements

- PostgreSQL adapter and multi-instance session/event storage for larger deployments.
- Managed object storage and image transformations for multi-instance hosting (the current uploader stores images on the service's durable volume).
- Email/SMS/push delivery for customer status notifications.
- Partial refunds and refund reason/accounting workflows.
- Cafe-specific promotions, configurable opening hours, inventory depletion, scheduled availability, and account recovery email delivery.
- Automated backup retention, restore drills, metrics, tracing, and hosted error reporting.
- Automated end-to-end browser tests across the customer UI, admin UI, and Stripe test mode (the current integration suite exercises API workflows and signed webhook cases).

