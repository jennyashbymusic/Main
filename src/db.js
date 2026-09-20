import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';

fs.mkdirSync(cfg.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(cfg.dataDir, 'club.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS subscribers (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    email                   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    token                   TEXT NOT NULL UNIQUE,   -- private magic-link token (unlock page, billing, unsubscribe)
    ref_code                TEXT NOT NULL UNIQUE,   -- public referral code used in share links
    referred_by             INTEGER REFERENCES subscribers(id),
    status                  TEXT NOT NULL DEFAULT 'lead', -- lead | member | past_due | cancelled
    unsubscribed            INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT,
    systeme_contact_id      INTEGER,
    welcome_sent_at         TEXT,
    member_since            TEXT,
    created_at              TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sub_referred ON subscribers(referred_by, created_at);
  CREATE INDEX IF NOT EXISTS idx_sub_customer ON subscribers(stripe_customer_id);
  CREATE INDEX IF NOT EXISTS idx_sub_subscription ON subscribers(stripe_subscription_id);

  CREATE TABLE IF NOT EXISTS drops (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    videos      TEXT NOT NULL,   -- JSON snapshot: [{id,title,thumb,publishedAt}]
    created_at  TEXT NOT NULL,
    sent_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS drop_sends (
    drop_id        INTEGER NOT NULL REFERENCES drops(id),
    subscriber_id  INTEGER NOT NULL REFERENCES subscribers(id),
    sent_at        TEXT NOT NULL,
    PRIMARY KEY (drop_id, subscriber_id)
  );

  -- Music store purchases. Each order is a snapshot of what was bought, so later catalog changes never break a receipt.
  CREATE TABLE IF NOT EXISTS orders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id  TEXT NOT NULL UNIQUE,
    token              TEXT NOT NULL UNIQUE,   -- private link to the buyer's download page
    email              TEXT NOT NULL,
    subscriber_id      INTEGER REFERENCES subscribers(id),
    amount_cents       INTEGER NOT NULL,
    currency           TEXT NOT NULL,
    items              TEXT NOT NULL,          -- JSON: [{id,kind,title,rel,priceCents}]
    created_at         TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS downloads (
    order_id  INTEGER NOT NULL REFERENCES orders(id),
    file_key  TEXT NOT NULL,
    n         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (order_id, file_key)
  );

  -- Custom chorus orders: a fan describes what they want, pays, and Jenny delivers by email.
  CREATE TABLE IF NOT EXISTS chorus_requests (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id  TEXT UNIQUE,
    status             TEXT NOT NULL DEFAULT 'pending',  -- pending (not paid yet) | paid | delivered
    for_name           TEXT NOT NULL,
    occasion           TEXT NOT NULL DEFAULT '',
    style              TEXT NOT NULL DEFAULT '',
    story              TEXT NOT NULL,
    buyer_name         TEXT NOT NULL DEFAULT '',
    email              TEXT NOT NULL DEFAULT '',
    amount_cents       INTEGER,
    currency           TEXT,
    created_at         TEXT NOT NULL,
    paid_at            TEXT,
    delivered_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chorus_status ON chorus_requests(status, id);

  -- Monthly "which songs go on Spotify" vote. One round per calendar month.
  CREATE TABLE IF NOT EXISTS vote_rounds (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    period            TEXT NOT NULL UNIQUE,  -- '2026-09'
    starts_at         TEXT NOT NULL,
    ends_at           TEXT NOT NULL,
    candidates        TEXT NOT NULL,         -- JSON snapshot of the ballot: [{id,name,title,thumb,publishedAt}]
    winners           TEXT,                  -- JSON once the round closes: [{id,name,title,votes,rank}]
    finalized_at      TEXT,
    spotify_added_at  TEXT                   -- set from /admin once the winners are on Spotify
  );

  CREATE TABLE IF NOT EXISTS votes (
    round_id       INTEGER NOT NULL REFERENCES vote_rounds(id),
    subscriber_id  INTEGER NOT NULL REFERENCES subscribers(id),
    video_id       TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (round_id, subscriber_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_votes_tally ON votes(round_id, video_id);
`);

// ---------- migrations ----------
// Numbered .sql files in ./migrations run once each, in order, and are recorded in schema_migrations.
// Use them for changes to tables that already exist on people's machines (new columns, backfills, new tables with constraints).
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir).filter((f) => /^\d+.*\.sql$/.test(f)).sort() : [];
for (const file of migrationFiles) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(file)) continue;
  db.exec('BEGIN');
  try {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    db.exec('COMMIT');
    console.log(`[db] applied migration ${file}`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`Database migration ${file} failed and was rolled back: ${err.message}`);
  }
}

const now = () => new Date().toISOString();
const newToken = () => crypto.randomBytes(24).toString('base64url');
const newRefCode = () => crypto.randomBytes(4).toString('hex');

export const isPaid = (sub) => sub && (sub.status === 'member' || sub.status === 'past_due');

// ---------- subscribers ----------
export const getById = (id) => db.prepare('SELECT * FROM subscribers WHERE id = ?').get(id);
export const getByEmail = (email) => db.prepare('SELECT * FROM subscribers WHERE email = ?').get(email);
export const getByToken = (token) =>
  typeof token === 'string' && token.length >= 20 && token.length <= 64
    ? db.prepare('SELECT * FROM subscribers WHERE token = ?').get(token)
    : undefined;
export const getByRef = (code) => db.prepare('SELECT * FROM subscribers WHERE ref_code = ?').get(code);
export const getByStripeCustomer = (id) =>
  id ? db.prepare('SELECT * FROM subscribers WHERE stripe_customer_id = ?').get(id) : undefined;
export const getByStripeSubscription = (id) =>
  id ? db.prepare('SELECT * FROM subscribers WHERE stripe_subscription_id = ?').get(id) : undefined;

/**
 * `consentSource` records where they agreed to get emails (and stamps consent_at). `confirmed` marks the email as
 * confirmed right away (used when confirmation isn't required); otherwise they confirm via the link in the welcome email.
 */
export function createSubscriber(email, referredBy = null, { consentSource = null, confirmed = false } = {}) {
  const stamp = now();
  const info = db
    .prepare('INSERT INTO subscribers (email, token, ref_code, referred_by, consent_at, consent_source, confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(email, newToken(), newRefCode(), referredBy, consentSource ? stamp : null, consentSource, confirmed ? stamp : null, stamp);
  return getById(info.lastInsertRowid);
}

export function updateSubscriber(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getById(id);
  db.prepare(`UPDATE subscribers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    id,
  );
  return getById(id);
}

/**
 * Friends who joined through this subscriber's link on/after `sinceIso` AND confirmed their email. Each friend is one row
 * (emails are unique), so a friend can never be credited twice, and a self-referral is refused when the row is created.
 */
export function referralCount(subscriberId, sinceIso = '') {
  return db
    .prepare('SELECT COUNT(*) AS n FROM subscribers WHERE referred_by = ? AND created_at >= ? AND confirmed_at IS NOT NULL')
    .get(subscriberId, sinceIso).n;
}

/** Friends who used the link but haven't confirmed their email yet (they don't count until they do). */
export function referralPending(subscriberId, sinceIso = '') {
  return db
    .prepare('SELECT COUNT(*) AS n FROM subscribers WHERE referred_by = ? AND created_at >= ? AND confirmed_at IS NULL')
    .get(subscriberId, sinceIso).n;
}

// ---------- drops ----------
const parseDrop = (row) => (row ? { ...row, videos: JSON.parse(row.videos) } : null);

export const latestDrop = () => parseDrop(db.prepare('SELECT * FROM drops ORDER BY id DESC LIMIT 1').get());
export const getDrop = (id) => parseDrop(db.prepare('SELECT * FROM drops WHERE id = ?').get(id));
export const recentDrops = (limit = 12) =>
  db.prepare('SELECT * FROM drops ORDER BY id DESC LIMIT ?').all(limit).map(parseDrop);

export function insertDrop(videos) {
  const info = db.prepare('INSERT INTO drops (videos, created_at) VALUES (?, ?)').run(JSON.stringify(videos), now());
  return getDrop(info.lastInsertRowid);
}

export function sentVideoIds() {
  const ids = new Set();
  for (const row of db.prepare('SELECT videos FROM drops').all()) {
    for (const v of JSON.parse(row.videos)) ids.add(v.id);
  }
  return ids;
}
