import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  pickup_address TEXT,
  pickup_zone TEXT,
  payout_bank_code TEXT,
  payout_bank_name TEXT,
  payout_account_number TEXT,
  payout_account_name TEXT,
  payout_verified_at TEXT,
  identity_verified_at TEXT,
  amount_owed INTEGER NOT NULL DEFAULT 0,
  suspended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id),
  is_admin INTEGER NOT NULL DEFAULT 0,
  csrf TEXT NOT NULL,
  flash TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  replaces_deal_id INTEGER REFERENCES deals(id),
  item_title TEXT NOT NULL,
  item_description TEXT NOT NULL,
  item_condition TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  item_price INTEGER NOT NULL,
  pickup_address TEXT NOT NULL,
  pickup_zone TEXT NOT NULL,
  delivery_zone TEXT NOT NULL,
  delivery_fee INTEGER NOT NULL,
  delivery_payer TEXT NOT NULL,
  fee_payer TEXT NOT NULL,
  platform_fee INTEGER NOT NULL,
  buyer_total INTEGER NOT NULL,
  seller_payout INTEGER NOT NULL,
  delivery_days INTEGER NOT NULL,
  inspection_hours INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkouts (
  id TEXT PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  terms_json TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  buyer_token TEXT NOT NULL UNIQUE,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_landmark TEXT,
  refund_bank_code TEXT NOT NULL,
  refund_bank_name TEXT NOT NULL,
  refund_account_enc TEXT NOT NULL,
  refund_account_last4 TEXT NOT NULL,
  refund_account_name TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  terms_accepted_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  tx_ref TEXT NOT NULL UNIQUE,
  provider_tx_id TEXT,
  paid_at TEXT,
  delivery_pin_enc TEXT,
  pin_attempts INTEGER NOT NULL DEFAULT 0,
  delivery_ref TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'not_booked',
  rider_token TEXT UNIQUE,
  packing_note TEXT,
  ship_by TEXT,
  dispatched_at TEXT,
  delivered_at TEXT,
  inspection_ends_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL
);
-- A deal can be paid for only once, however many checkout attempts it had.
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_paid_per_deal
  ON orders(deal_id) WHERE status IN ('paid', 'shipping', 'delivered', 'disputed', 'completed', 'refunded');

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  opened_by TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution_note TEXT,
  buyer_refund INTEGER,
  seller_payout INTEGER,
  seller_charge INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  counterparty TEXT,
  provider_ref TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  order_id INTEGER,
  to_phone TEXT,
  to_email TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_transactions (
  tx_ref TEXT PRIMARY KEY,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// node:sqlite rejects undefined and booleans; normalise them.
function clean(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = v === undefined ? null : typeof v === 'boolean' ? Number(v) : v;
  }
  return out;
}

export const run = (db, sql, params = {}) => db.prepare(sql).run(clean(params));
export const get = (db, sql, params = {}) => db.prepare(sql).get(clean(params));
export const all = (db, sql, params = {}) => db.prepare(sql).all(clean(params));

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function insert(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => ':' + k).join(', ')})`;
  return Number(run(db, sql, row).lastInsertRowid);
}

export function update(db, table, id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :__id`;
  return run(db, sql, { ...fields, __id: id });
}
