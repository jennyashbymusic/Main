// Music store: songs ($2) and albums ($12) sold as downloads.
//
// The catalog is just folders. Drop audio files into STORE_DIR (default ./store):
//   store/songs/Come Sit With Me.mp3                one song  (optional cover: Come Sit With Me.jpg)
//   store/albums/Dark Roads/01 - First Song.mp3     one album per folder, tracks inside (optional cover.jpg)
// Files are never served directly. Buyers get private, limited download links after paying.
import { ZipArchive } from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { db, getByEmail, getById } from './db.js';
import { getUploads } from './youtube.js';
import { songName } from './voting.js';
import { orderEmail, unsubscribeUrlFor } from './emails.js';
import { sendMail } from './mailer.js';

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// On a brand-new hosting disk these folders do not exist yet. Make them, so music can be copied straight in.
for (const sub of ['songs', 'albums']) {
  try { fs.mkdirSync(path.join(cfg.storeDir, sub), { recursive: true }); } catch { /* read-only or missing disk: the store just shows as empty */ }
}

const AUDIO = /\.(mp3|wav|flac|m4a|aac|ogg|aiff?)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const COVER_NAME = /^(cover|folder|front|artwork)\.(jpe?g|png|webp)$/i;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
const posix = (...parts) => path.posix.join(...parts);

const entries = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // folder doesn't exist yet: the store is simply empty
  }
};

/** "01 - Wildfire.mp3" -> "Wildfire" */
const trackTitle = (file) => file.replace(AUDIO, '').replace(/^\s*\d{1,3}\s*[-._)]\s*/, '').trim();

function albumTracks(albumRel) {
  return entries(path.join(cfg.storeDir, albumRel))
    .filter((e) => e.isFile() && AUDIO.test(e.name))
    .sort((a, b) => natural.compare(a.name, b.name))
    .map((e) => ({ file: e.name, title: trackTitle(e.name) }));
}

/** Everything for sale, read straight from the folders each time, so adding a file needs no restart. */
export function scanCatalog() {
  const songFiles = entries(path.join(cfg.storeDir, 'songs')).filter((e) => e.isFile());
  const songs = songFiles
    .filter((e) => AUDIO.test(e.name))
    .sort((a, b) => natural.compare(a.name, b.name))
    .map((e) => {
      const base = e.name.replace(AUDIO, '');
      const cover = songFiles.find((f) => IMAGE.test(f.name) && f.name.replace(IMAGE, '').toLowerCase() === base.toLowerCase());
      const rel = posix('songs', e.name);
      return { id: `s_${hash(rel)}`, kind: 'song', title: base.trim(), rel, coverRel: cover ? posix('songs', cover.name) : null, priceCents: cfg.songPriceCents };
    });

  const albums = entries(path.join(cfg.storeDir, 'albums'))
    .filter((e) => e.isDirectory())
    .sort((a, b) => natural.compare(a.name, b.name))
    .map((d) => {
      const rel = posix('albums', d.name);
      const files = entries(path.join(cfg.storeDir, rel)).filter((e) => e.isFile());
      const cover = files.find((f) => COVER_NAME.test(f.name)) || files.find((f) => IMAGE.test(f.name));
      return { id: `a_${hash(rel)}`, kind: 'album', title: d.name.trim(), rel, coverRel: cover ? posix(rel, cover.name) : null, tracks: albumTracks(rel), priceCents: cfg.albumPriceCents };
    })
    .filter((a) => a.tracks.length);

  return { songs, albums };
}

const norm = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The catalog as the store page sees it (no file paths). Songs that match a YouTube upload get its thumbnail and a listen link. */
export async function publicCatalog() {
  const { songs, albums } = scanCatalog();
  let uploads = [];
  try {
    uploads = await getUploads();
  } catch { /* no YouTube: songs just don't get a listen link */ }
  const byName = new Map();
  for (const v of uploads) if (!byName.has(norm(songName(v.title)))) byName.set(norm(songName(v.title)), v);

  return {
    ready: songs.length + albums.length > 0,
    currency: cfg.currency,
    songPriceCents: cfg.songPriceCents,
    albumPriceCents: cfg.albumPriceCents,
    songs: songs.map((s) => {
      const v = byName.get(norm(s.title));
      return { id: s.id, title: s.title, priceCents: s.priceCents, cover: s.coverRel ? `/api/store/cover/${s.id}` : v?.thumb || null, listenUrl: v ? `https://www.youtube.com/watch?v=${v.id}` : null };
    }),
    albums: albums.map((a) => ({ id: a.id, title: a.title, priceCents: a.priceCents, tracks: a.tracks.map((t) => t.title), cover: a.coverRel ? `/api/store/cover/${a.id}` : null })),
  };
}

/**
 * A sample store so the owner can see the finished layout before any audio files exist (/store?preview=1).
 * Uses the channel's real song titles and thumbnails. Nothing in it can be bought: checkout refuses `demo_` ids.
 */
export async function demoCatalog() {
  let uploads = [];
  try {
    uploads = (await getUploads()).filter((v) => v.thumb).slice(0, 8);
  } catch { /* no YouTube: fall back to made-up names below */ }
  const fallback = ['Midnight Drive', 'Golden Hour', 'Static Hearts', 'Paper Planes', 'Low Light', 'Wildfire'];
  const names = uploads.length >= 5 ? uploads.map((v) => ({ title: songName(v.title), cover: v.thumb, id: v.id })) : fallback.map((title) => ({ title, cover: null, id: null }));
  return {
    ready: true,
    demo: true,
    currency: cfg.currency,
    songPriceCents: cfg.songPriceCents,
    albumPriceCents: cfg.albumPriceCents,
    songs: names.slice(0, 6).map((n, i) => ({ id: `demo_s${i}`, title: n.title, priceCents: cfg.songPriceCents, cover: n.cover, listenUrl: n.id ? `https://www.youtube.com/watch?v=${n.id}` : null })),
    albums: [{ id: 'demo_a0', title: 'Sample Album', priceCents: cfg.albumPriceCents, cover: names[0].cover, tracks: names.slice(0, 5).map((n) => n.title) }],
  };
}

/** Resolve cart ids to catalog items. Prices always come from here (the server), never from the browser. */
export function itemsForCart(ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!wanted.length) throw new StoreError('Your cart is empty.');
  if (wanted.some((id) => id.startsWith('demo_'))) {
    throw new StoreError('This is a preview with sample items, so checkout is switched off. Add your audio files to the store folder to open the real store.');
  }
  if (wanted.length > 25) throw new StoreError('That is a lot of music! Please check out in smaller batches (25 items max).');
  const { songs, albums } = scanCatalog();
  const byId = new Map([...songs, ...albums].map((i) => [i.id, i]));
  return wanted.map((id) => {
    const item = byId.get(id);
    if (!item) throw new StoreError('One of those items is no longer available. Please refresh the store.');
    return item;
  });
}

/** The Stripe Checkout Session for a cart. `sub` (a signed-in member) links the order to their account. */
export function checkoutParams(items, sub) {
  return {
    mode: 'payment',
    line_items: items.map((item) => ({
      quantity: 1,
      price_data: {
        currency: cfg.currency,
        unit_amount: item.priceCents,
        product_data: {
          name: item.kind === 'album' ? `${item.title} (album)` : item.title,
          description: item.kind === 'album' ? `Digital album · ${item.tracks.length} tracks` : 'Digital song download',
        },
      },
    })),
    metadata: { store: '1', cart: items.map((i) => i.id).join(',') }, // Stripe allows 500 characters per value: 25 ids fit
    ...(sub ? { client_reference_id: String(sub.id), customer_email: sub.email } : {}),
    allow_promotion_codes: true,
    success_url: `${cfg.baseUrl}/purchase?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.baseUrl}/store`,
  };
}

// ---------- orders ----------

const parseOrder = (row) => row && { ...row, items: JSON.parse(row.items) };
export const orderByToken = (token) =>
  typeof token === 'string' && token.length >= 20 && token.length <= 64
    ? parseOrder(db.prepare('SELECT * FROM orders WHERE token = ?').get(token))
    : undefined;
const orderBySession = (sessionId) => parseOrder(db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(sessionId));

/**
 * Turn a paid Checkout Session into an order (once) and email the receipt with the download link.
 * Called from the Stripe webhook and from the page Stripe returns the buyer to, whichever arrives first.
 */
export function fulfillOrder(session) {
  if (session.mode !== 'payment' || session.metadata?.store !== '1') return null;
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) return null;
  const existing = orderBySession(session.id);
  if (existing) return existing;

  const { songs, albums } = scanCatalog();
  const byId = new Map([...songs, ...albums].map((i) => [i.id, i]));
  const ids = String(session.metadata.cart || '').split(',').filter(Boolean);
  const items = ids.filter((id) => byId.has(id)).map((id) => {
    const i = byId.get(id);
    return { id: i.id, kind: i.kind, title: i.title, rel: i.rel, priceCents: i.priceCents };
  });
  if (items.length !== ids.length) console.error(`[store] order ${session.id}: ${ids.length - items.length} purchased item(s) are missing from the store folder`);

  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  const refId = Number(session.client_reference_id);
  const info = db
    .prepare('INSERT OR IGNORE INTO orders (stripe_session_id, token, email, subscriber_id, amount_cents, currency, items, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(session.id, crypto.randomBytes(24).toString('base64url'), email, Number.isInteger(refId) && getById(refId) ? refId : null,
      session.amount_total ?? items.reduce((sum, i) => sum + i.priceCents, 0), (session.currency || cfg.currency).toLowerCase(),
      JSON.stringify(items), new Date().toISOString());
  const order = orderBySession(session.id);
  if (info.changes === 1 && email) {
    // A buyer who is also on the mailing list gets a working unsubscribe link in the receipt.
    const subscriber = (order.subscriber_id && getById(order.subscriber_id)) || getByEmail(email);
    sendMail({ to: email, ...orderEmail(order, { unsubscribeUrl: unsubscribeUrlFor(subscriber) }) }).catch((err) => console.error('[store] receipt email failed:', err.message));
  }
  return order;
}

// ---------- downloads ----------

/** Absolute path to a file inside the store folder, or null. Symlinks and ../ tricks that leave the folder are refused. */
export function resolveFile(rel) {
  try {
    const root = fs.realpathSync(cfg.storeDir);
    const real = fs.realpathSync(path.resolve(root, rel));
    return real.startsWith(root + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Count a download against the per-file limit. False means the limit is used up. */
export function takeDownload(orderId, fileKey) {
  const used = db.prepare('SELECT n FROM downloads WHERE order_id = ? AND file_key = ?').get(orderId, fileKey)?.n || 0;
  if (used >= cfg.downloadLimit) return false;
  db.prepare('INSERT INTO downloads (order_id, file_key, n) VALUES (?, ?, 1) ON CONFLICT(order_id, file_key) DO UPDATE SET n = n + 1').run(orderId, fileKey);
  return true;
}

export const tracksOf = (item) => (item.kind === 'album' ? albumTracks(item.rel) : []);

/** What the buyer's download page shows. */
export function orderView(order) {
  return {
    email: order.email,
    createdAt: order.created_at,
    totalCents: order.amount_cents,
    currency: order.currency,
    limit: cfg.downloadLimit,
    items: order.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      priceCents: item.priceCents,
      available: item.kind === 'song' ? Boolean(resolveFile(item.rel)) : albumTracks(item.rel).length > 0,
      tracks: tracksOf(item).map((t, index) => ({ index, title: t.title })),
    })),
  };
}

/** Stream an album as a zip. Audio is already compressed, so files are stored as-is. */
export function streamAlbumZip(res, item, tracks) {
  const zip = new ZipArchive({ store: true });
  zip.on('error', (err) => {
    console.error('[store] zip failed:', err.message);
    res.destroy(err);
  });
  zip.pipe(res);
  tracks.forEach((t, i) => {
    const file = resolveFile(posix(item.rel, t.file));
    if (file) zip.file(file, { name: `${String(i + 1).padStart(2, '0')} - ${t.title}${path.extname(t.file)}` });
  });
  return zip.finalize();
}

// ---------- admin ----------

export function storeSummary() {
  const { songs, albums } = scanCatalog();
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 8').all().map(parseOrder);
  const totals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM orders').get();
  return {
    dir: cfg.storeDir,
    songs: songs.length,
    albums: albums.length,
    orders: totals.n,
    revenueCents: totals.cents,
    currency: cfg.currency.toUpperCase(),
    recent: rows.map((o) => ({ email: o.email, createdAt: o.created_at, amountCents: o.amount_cents, items: o.items.map((i) => i.title) })),
  };
}
