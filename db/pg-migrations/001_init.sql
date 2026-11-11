CREATE TABLE IF NOT EXISTS cafes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'INR',
  tax_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_bps BETWEEN 0 AND 3000),
  logo_url TEXT,
  accepting_orders SMALLINT NOT NULL DEFAULT 1 CHECK (accepting_orders IN (0, 1)),
  default_prep_minutes INTEGER NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (cafe_id, email)
);
CREATE INDEX IF NOT EXISTS admins_email_idx ON admins(email);
CREATE UNIQUE INDEX IF NOT EXISTS admins_email_unique_idx ON admins(LOWER(email));

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (cafe_id, name)
);
CREATE INDEX IF NOT EXISTS categories_cafe_idx ON categories(cafe_id, active, sort_order);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  prep_minutes INTEGER NOT NULL DEFAULT 10,
  vegetarian SMALLINT NOT NULL DEFAULT 0 CHECK (vegetarian IN (0, 1)),
  vegan SMALLINT NOT NULL DEFAULT 0 CHECK (vegan IN (0, 1)),
  allergens_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '[]',
  available SMALLINT NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_cafe_category_idx ON items(cafe_id, category_id, available);

CREATE TABLE IF NOT EXISTS cafe_tables (
  id TEXT PRIMARY KEY,
  cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qr_token TEXT NOT NULL UNIQUE,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (cafe_id, name)
);
CREATE INDEX IF NOT EXISTS cafe_tables_cafe_idx ON cafe_tables(cafe_id, active);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES cafe_tables(id),
  order_number INTEGER NOT NULL,
  tracking_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','PREPARING','READY','SERVED','COMPLETED','CANCELLED')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH_COUNTER','CASH_TABLE','ONLINE')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('UNPAID','PENDING','PAID','FAILED','REFUNDED')),
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  customer_note TEXT NOT NULL DEFAULT '',
  cancellation_reason TEXT,
  estimated_minutes INTEGER NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (cafe_id, order_number)
);
CREATE INDEX IF NOT EXISTS orders_cafe_created_idx ON orders(cafe_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_cafe_status_idx ON orders(cafe_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 30),
  unit_price_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  selected_options_json TEXT NOT NULL DEFAULT '[]',
  special_instructions TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UNPAID','PENDING','PAID','FAILED','REFUNDED')),
  amount_cents INTEGER NOT NULL,
  provider_reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id)
);
CREATE INDEX IF NOT EXISTS payments_cafe_status_idx ON payments(cafe_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (cafe_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expired BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions(expired);
