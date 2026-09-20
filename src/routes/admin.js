import express, { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from '../config.js';
import { db, getDrop, latestDrop, recentDrops } from '../db.js';
import { createDrop, isSending, runway, sendDrop } from '../drops.js';
import { checkPortal } from './billing.js';
import { deleteSong, exclusiveCount, listAll, publicShape, saveAudio, upsertSong } from '../songs.js';
import { dropEmail } from '../emails.js';
import { mailerMode, sendMail } from '../mailer.js';
import { syncSubscriber, systemeEnabled, tagsForStatus } from '../systeme.js';
import { youtubeMode } from '../youtube.js';
import { adminSummary, setSpotifyAdded } from '../voting.js';
import { refreshStore, storeSummary } from '../store.js';
import { chorusSummary, setDelivered } from '../chorus.js';
import { tipsSummary } from '../tips.js';
import { UploadError, deleteFiles, listFiles, saveUpload, targetFor } from '../storeFiles.js';
import { safeEqual } from '../util.js';

export const router = Router();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Browser Basic auth: any username, ADMIN_TOKEN as the password. Disabled entirely if ADMIN_TOKEN is unset.
router.use((req, res, next) => {
  if (!cfg.adminToken) return res.status(404).end();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  const password = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':') : '';
  if (safeEqual(password, cfg.adminToken)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"').status(401).send('Authentication required');
});

// State-changing calls must be JSON: a cross-site form post can't send that content type, which blocks CSRF.
router.use((req, res, next) => {
  const type = req.headers['content-type'] || '';
  if (req.method === 'POST' && !type.startsWith('application/json')) return res.status(415).json({ error: 'JSON only' });
  // Audio uploads (PUT) must say they are audio: a cross-site page can't send that without a CORS preflight, so it is blocked too.
  if (req.method === 'PUT' && !/^(audio\/|application\/octet-stream)/.test(type)) return res.status(415).json({ error: 'Send the audio file as the request body with an audio/* Content-Type.' });
  next();
});

router.get('/', (_req, res) => res.sendFile(path.join(root, 'views', 'admin.html')));

router.get('/api/stats', async (_req, res) => {
  await refreshStore();
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status').all().map((r) => [r.status, r.n]),
  );
  const members = (counts.member || 0) + (counts.past_due || 0);
  const scalar = (sql) => db.prepare(sql).get().n;
  res.json({
    leads: counts.lead || 0,
    members,
    pastDue: counts.past_due || 0,
    cancelled: counts.cancelled || 0,
    unsubscribed: scalar('SELECT COUNT(*) AS n FROM subscribers WHERE unsubscribed = 1'),
    referred: scalar('SELECT COUNT(*) AS n FROM subscribers WHERE referred_by IS NOT NULL'),
    mrr: (members * cfg.priceCents) / 100,
    currency: cfg.currency.toUpperCase(),
    drop: latestDrop(),
    history: recentDrops(8).map((d) => ({
      id: d.id,
      createdAt: d.created_at,
      sentAt: d.sent_at,
      titles: d.videos.map((v) => v.title),
      recipients: db.prepare('SELECT COUNT(*) AS n FROM drop_sends WHERE drop_id = ?').get(d.id).n,
    })),
    votes: adminSummary(),
    store: storeSummary(),
    chorus: chorusSummary(),
    tips: tipsSummary(),
    songs: {
      exclusive: exclusiveCount(),
      needed: cfg.earlyAccessMinSongs,
      list: listAll().map((s) => ({ ...publicShape(s), audioFile: s.audio_file })),
    },
    sending: isSending(),
    integrations: {
      stripe: Boolean(cfg.stripeKey && cfg.stripeWebhookSecret),
      systeme: systemeEnabled(),
      youtube: youtubeMode(),
      mail: mailerMode(),
      cron: `${cfg.sendCron} (${cfg.timezone})`,
    },
  });
});

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error('[admin]', err.message);
    res.status(err.status || 400).json({ error: err.message });
  }
};

// ---------- songs (exclusive / early-access): used by the admin page AND by your uploader script ----------

/** Create or update a song: { slug?, title, access, public_release_at?, youtube_video_id?, thumb? }. Safe to call repeatedly. */
router.post('/api/songs', wrap(async (req) => ({ song: publicShape(upsertSong(req.body)) })));

router.post('/api/songs/delete', wrap(async (req) => {
  deleteSong(String(req.body?.slug || ''));
  return { ok: true };
}));

// ---- the music store: add, list and remove songs and albums (music on disk; with a Supabase bucket you upload there instead) ----
router.get('/api/store/files', wrap(async () => listFiles()));

/** PUT the raw file, Content-Type application/octet-stream, with ?kind=song|album&album=Name&name=file.mp3 */
router.put('/api/store/upload', async (req, res) => {
  try {
    const target = targetFor({ kind: String(req.query.kind || ''), album: String(req.query.album || ''), name: String(req.query.name || '') });
    res.json({ ok: true, ...(await saveUpload(req, target)) });
  } catch (err) {
    if (!(err instanceof UploadError)) console.error('[admin upload]', err.message);
    res.status(err.status || 500).set('Connection', 'close').json({ error: err instanceof UploadError ? err.message : 'The upload failed. Please try again.' });
  }
});

router.post('/api/store/delete', wrap(async (req) => deleteFiles(req.body || {})));

/** Upload a song's audio: PUT the raw file with an audio/* Content-Type and ?filename=name.mp3. */
router.put(
  '/api/songs/:slug/audio',
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: `${cfg.maxAudioMb}mb` }),
  wrap(async (req) => ({ song: publicShape(saveAudio(req.params.slug, req.query.filename || req.headers['x-filename'], req.body)) })),
);

// ---------- checks ----------

/** Weeks of unsent songs left in the weekly rotation (also: npm run runway). */
router.get('/api/runway', wrap(async () => runway()));

/** Is the Stripe customer portal switched on and allowed to cancel? Verifies the "cancel anytime" promise. */
router.post('/api/portal-check', wrap(async () => checkPortal()));

router.post('/api/drop/new', wrap(async () => ({ drop: await createDrop() })));

router.post('/api/drop/send', wrap(async (req) => sendDrop(Number(req.body?.dropId))));

router.post('/api/test', wrap(async (req) => {
  const to = String(req.body?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Enter a valid email.');
  const drop = latestDrop() || (await createDrop());
  // Preview-only subscriber: the links in a test email intentionally don't resolve to a real account.
  const preview = { email: to, token: 'preview-only-token-000000', ref_code: 'preview', status: 'member' };
  await sendMail({ to, ...dropEmail(preview, getDrop(drop.id)) });
  return { ok: true };
}));

/** Tick a custom chorus once it has been emailed to the buyer. */
router.post('/api/chorus/delivered', wrap(async (req) => {
  setDelivered(Number(req.body?.id), Boolean(req.body?.delivered));
  return { ok: true };
}));

/** Tick once the closed round's winners have been added to the Spotify playlist. */
router.post('/api/vote/spotify', wrap(async (req) => {
  setSpotifyAdded(Number(req.body?.roundId), Boolean(req.body?.added));
  return { ok: true };
}));

/** Re-push every subscriber (and their status tag) to Systeme.io, e.g. after an outage or when first connecting it. */
router.post('/api/resync', wrap(async () => {
  if (!systemeEnabled()) throw new Error('SYSTEME_API_KEY is not set.');
  const rows = db.prepare('SELECT id, status FROM subscribers WHERE unsubscribed = 0').all();
  for (const r of rows) syncSubscriber(r.id, tagsForStatus(r.status));
  return { queued: rows.length };
}));
