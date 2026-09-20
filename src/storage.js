// Where the music store's files live. Two ways, chosen by what is filled in .env:
//
//   Supabase Storage bucket   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (+ SUPABASE_STORE_BUCKET, default "store")
//   a folder on disk          STORE_DIR (the default; on Render it lives on the persistent disk)
//
// The bucket is PRIVATE. Nothing in it is ever public: the site lists it with the service key, and a buyer only gets a
// 60-second signed link AFTER the site has checked their order and counted the download. Everything here talks to Supabase's
// plain HTTP Storage API (no extra packages), and the service key never leaves the server.
//
// The rest of the store code is synchronous, so we keep a short-lived snapshot of what is in the bucket (which folders and
// files exist). It is refreshed at most every STORE_CACHE_SECONDS, whenever someone opens the store, and every few hours.
import { cfg } from './config.js';

export const bucketMode = Boolean(cfg.supabaseUrl && cfg.supabaseKey);

const API = `${cfg.supabaseUrl}/storage/v1`;
const BUCKET = encodeURIComponent(cfg.storeBucket);

// Supabase's newer "secret" keys (sb_secret_...) go in the apikey header alone; the older service_role keys (a long eyJ... token)
// are sent as both apikey and Authorization.
const headers = (extra = {}) =>
  cfg.supabaseKey.startsWith('sb_secret_')
    ? { apikey: cfg.supabaseKey, ...extra }
    : { apikey: cfg.supabaseKey, Authorization: `Bearer ${cfg.supabaseKey}`, ...extra };

/** "albums/Dark Roads/01 - One.mp3" -> each part URL-encoded, slashes kept. */
const enc = (key) => key.split('/').map(encodeURIComponent).join('/');

async function failure(res, what) {
  const body = await res.text().catch(() => '');
  return new Error(`Supabase ${what} failed: HTTP ${res.status} ${body}`.replace(/\s+/g, ' ').slice(0, 220));
}

// ---------- listing ----------

async function listPage(prefix, offset) {
  const res = await fetch(`${API}/object/list/${BUCKET}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await failure(res, `list "${prefix || '/'}"`);
  return res.json();
}

/** Everything directly inside one "folder" of the bucket. Folders come back with id null; files have an id. */
export async function listFolder(prefix) {
  const all = [];
  // Keep asking until Supabase returns an empty page, whatever page size it caps at.
  for (let offset = 0; ;) {
    const page = await listPage(prefix, offset);
    if (!page.length) break;
    all.push(...page);
    offset += page.length;
  }
  return all.filter((i) => i?.name && !i.name.startsWith('.')); // hides the ".emptyFolderPlaceholder" Supabase adds to empty folders
}

const dirent = (name, isFile) => ({ name, isFile: () => isFile, isDirectory: () => !isFile });

async function buildSnapshot() {
  const tree = new Map(); // "songs" -> [entries], "albums" -> [entries], "albums/Dark Roads" -> [entries]
  const files = new Set(); // "songs/Alpha.mp3", "albums/Dark Roads/01 - One.mp3", ...
  for (const top of ['songs', 'albums']) {
    const items = await listFolder(top);
    tree.set(top, items.map((i) => dirent(i.name, i.id != null)));
    for (const i of items) {
      if (i.id != null) { files.add(`${top}/${i.name}`); continue; }
      if (top !== 'albums') continue; // a folder inside songs/ is ignored
      const rel = `albums/${i.name}`; // one folder per album, tracks (and a cover) inside
      const inner = (await listFolder(rel)).filter((f) => f.id != null);
      tree.set(rel, inner.map((f) => dirent(f.name, true)));
      inner.forEach((f) => files.add(`${rel}/${f.name}`));
    }
  }
  return { tree, files };
}

let snap = { tree: new Map(), files: new Set(), at: 0, nextTryAt: 0, lastError: null };
let inflight = null;

/**
 * Bring the snapshot up to date if it is older than STORE_CACHE_SECONDS. Never throws: if Supabase can't be reached the last
 * good snapshot keeps being used (so a hiccup doesn't empty the store) and we try again in a few seconds.
 */
export function refreshStore(force = false) {
  if (!bucketMode) return Promise.resolve();
  if (!force && Date.now() < snap.nextTryAt) return inflight || Promise.resolve();
  inflight ??= buildSnapshot()
    .then(({ tree, files }) => { snap = { tree, files, at: Date.now(), nextTryAt: Date.now() + cfg.storeCacheSeconds * 1000, lastError: null }; })
    .catch((err) => {
      console.error('[store]', err.message);
      snap = { ...snap, nextTryAt: Date.now() + 5000, lastError: err.message };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Folder contents from the snapshot, in the shape fs.readdirSync(..., { withFileTypes: true }) gives. */
export const listDir = (rel) => snap.tree.get(rel) || [];
export const hasFile = (key) => snap.files.has(key);
export const snapshotInfo = () => ({ files: snap.files.size, at: snap.at, lastError: snap.lastError });

// ---------- files ----------

/** A link that works for 60 seconds, for one file. `filename` is what the buyer's browser saves it as. */
export async function signedUrl(key, filename) {
  const res = await fetch(`${API}/object/sign/${BUCKET}/${enc(key)}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: 60 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await failure(res, 'signing a download link');
  const data = await res.json();
  const p = data.signedURL || data.signedUrl;
  if (!p) throw new Error('Supabase gave no signed link.');
  const url = /^https?:\/\//i.test(p) ? p : p.startsWith('/storage/v1') ? cfg.supabaseUrl + p : API + p;
  return filename ? `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(filename)}` : url;
}

/** Fetch one file's bytes (for covers and for building album zips). The caller streams `response.body`. */
export async function fetchObject(key) {
  const res = await fetch(`${API}/object/authenticated/${BUCKET}/${enc(key)}`, { headers: headers(), signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw await failure(res, `download of "${key}"`);
  return res;
}

// ---------- for the setup check ----------
/** Files sitting loose at the top of the bucket (a common mistake: they must be inside songs/ or albums/). */
export const listBucketRoot = () => listFolder('');

// Keep the snapshot warm, and keep the Supabase project active (free projects can be paused after a quiet week).
if (bucketMode) {
  refreshStore(true);
  setInterval(() => refreshStore(true), 6 * 3600_000).unref();
}
