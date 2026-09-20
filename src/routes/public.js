import { Router } from 'express';
import { albumPriceLabel, cfg, chorusPriceLabel, priceLabel, songPriceLabel } from '../config.js';
import {
  createSubscriber,
  getByEmail,
  getByRef,
  getByToken,
  isPaid,
  recentDrops,
  referralCount,
  referralPending,
  updateSubscriber,
} from '../db.js';
import { ensureDrop } from '../drops.js';
import { sendMail } from '../mailer.js';
import { welcomeEmail } from '../emails.js';
import { earlyAccessLive } from '../songs.js';
import { syncSubscriber, tagsForStatus } from '../systeme.js';
import { getUploads, videoUrl, youtubeReady } from '../youtube.js';
import { rateLimit } from '../util.js';
import { publicOrigin } from '../origin.js';
import { songName } from '../voting.js';

export const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normalizeEmail = (v) => {
  const email = String(v ?? '').trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
};

router.get('/config', (_req, res) => {
  res.json({
    brand: cfg.brand,
    price: priceLabel,
    chorusPrice: chorusPriceLabel, // for the Custom Chorus call-to-action on the home page
    chorusTurnaround: cfg.chorusTurnaround || null,
    // the home page's FAQ and sections quote these, so the wording can never drift from what the site really does
    songPrice: songPriceLabel,
    albumPrice: albumPriceLabel,
    winnersPerMonth: cfg.winnersPerMonth,
    votesFree: cfg.votesFree,
    votesMember: cfg.votesMember,
    downloadLimit: cfg.downloadLimit,
    contactEmail: cfg.contactEmail || null,
    youtubeUrl: cfg.channelUrl || (cfg.youtubeChannelId ? `https://www.youtube.com/channel/${cfg.youtubeChannelId}` : null),
    songsPerDrop: cfg.songsPerDrop,
    channelUrl: cfg.channelUrl || null,
    // Pages only say "songs before they go public" once there are enough exclusive songs for that to be true.
    earlyAccessLive: earlyAccessLive(),
  });
});

// A hand-picked video needs no API key: YouTube's public oEmbed endpoint gives its title (and confirms it can be embedded).
let featuredCache = null;
async function featuredFromId(id) {
  if (featuredCache?.id === id && Date.now() - featuredCache.at < 3_600_000) return featuredCache.data;
  let title = null;
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (r.ok) title = (await r.json()).title || null;
    else console.error(`[featured] oEmbed says video ${id} is unavailable (${r.status}); check FEATURED_VIDEO_ID.`);
  } catch (err) {
    console.error('[featured] title lookup failed:', err.message); // the video still plays; only the caption is missing
  }
  const data = { id, title, thumb: null };
  featuredCache = { id, at: Date.now(), data };
  return data;
}

/** Video for the landing page: FEATURED_VIDEO_ID if set, otherwise the channel's newest upload. `id: null` = show a placeholder. */
/** The newest songs on the channel, for the home page's "Latest songs" (one card per song title, newest first). */
router.get('/latest', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (!youtubeReady()) return res.json({ songs: [] });
  try {
    const seen = new Set();
    const songs = (await getUploads())
      .slice()
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((v) => ({ id: v.id, name: songName(v.title), thumb: v.thumb, publishedAt: v.publishedAt }))
      .filter((s) => { const k = s.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 6);
    res.json({ songs });
  } catch (err) {
    console.error('[latest]', err.message);
    res.json({ songs: [] });
  }
});

router.get('/featured', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (cfg.featuredVideoId) return res.json(await featuredFromId(cfg.featuredVideoId));
  if (cfg.devMock || !youtubeReady()) return res.json({ id: null });
  try {
    const newest = (await getUploads()).reduce((a, b) => (b.publishedAt > a.publishedAt ? b : a));
    res.json({ id: newest.id, title: newest.title, thumb: newest.thumb });
  } catch (err) {
    console.error('[featured]', err.message);
    res.json({ id: null });
  }
});

/** The welcome email includes this week's first song: signing up unlocks it. If the drop can't be built, it goes without. */
async function sendWelcome(sub) {
  let song = null;
  try {
    song = (await ensureDrop()).videos[0] ?? null;
  } catch (err) {
    console.error('[welcome] no song for this week:', err.message);
  }
  await sendMail({ to: sub.email, ...welcomeEmail(sub, song) });
}

const SOURCE_RE = /^[a-z0-9:_-]{1,40}$/; // where the signup form was ("landing", "gate:vote", ...)

/** Top of the funnel: capture the email, add it to Systeme.io, then send them to the sales page. */
router.post('/subscribe', rateLimit({ windowMs: 10 * 60_000, max: 10 }), (req, res) => {
  const { email: rawEmail, ref, website, source } = req.body || {};
  if (website) return res.json({ redirect: '/join' }); // honeypot field: bots fill it, people can't see it

  const email = normalizeEmail(rawEmail);
  if (!email) return res.status(400).json({ error: 'Please enter a valid email address.' });

  let sub = getByEmail(email);
  const isNew = !sub;
  if (isNew) {
    // The referral lives on the NEW friend's own row: one row per unique email means one credit per friend, ever, and it
    // only counts once they confirm (see referralCount). A person can't refer their own address.
    const referrer = ref ? getByRef(String(ref).slice(0, 32)) : null;
    sub = createSubscriber(email, referrer && referrer.email !== email ? referrer.id : null, {
      consentSource: SOURCE_RE.test(String(source ?? '')) ? String(source) : 'unknown', // records consent_at + where they agreed
      confirmed: !cfg.requireEmailConfirmation,
    });
    syncSubscriber(sub.id, tagsForStatus('lead'));
  }

  // Re-send the personal-link email at most once an hour (covers people who sign up again from another device).
  // Never to someone who unsubscribed: typing their address again is not consent to be emailed again.
  const stale = !sub.welcome_sent_at || Date.now() - Date.parse(sub.welcome_sent_at) > 3_600_000;
  if (stale && !sub.unsubscribed) {
    updateSubscriber(sub.id, { welcome_sent_at: new Date().toISOString() });
    sendWelcome(sub).catch((err) => console.error('[welcome]', err.message));
  }

  // The personal token opens that person's invite page (and, for paying members, their Stripe billing portal).
  // Free subscribers have no billing attached, so anyone typing a free subscriber's email is sent straight back to
  // their invite page ("welcome back"). Members and past members only ever get their token by email.
  const canResume = isNew || (!isPaid(sub) && !sub.stripe_customer_id);
  res.json({ redirect: canResume ? `/join?t=${sub.token}${isNew ? '' : '&back=1'}` : '/join?returning=1' });
});

/** Lets the browser check a remembered token before showing "welcome back". */
router.get('/me', (req, res) => {
  const sub = getByToken(String(req.query.t || ''));
  if (!sub) return res.status(404).json({ error: 'Unknown link.' });
  res.json({ status: sub.status, paid: isPaid(sub), confirmed: Boolean(sub.confirmed_at) });
});

/**
 * Confirm an email address (the link in the welcome email). Until they do, friends who joined through their link don't
 * count toward unlocks when confirmation is required. A page with a button calls this, so link scanners can't confirm for them.
 */
router.post('/confirm', rateLimit({ windowMs: 10 * 60_000, max: 30 }), (req, res) => {
  const sub = getByToken(String(req.query.t || ''));
  if (!sub) return res.status(404).json({ error: 'This link is not valid.' });
  if (!sub.confirmed_at) updateSubscriber(sub.id, { confirmed_at: new Date().toISOString() });
  res.json({ ok: true, unlockUrl: `/unlock?t=${sub.token}` });
});

/**
 * Share-gate state for the unlock page. Locked songs are returned as placeholders only —
 * their IDs/titles never reach the browser until the subscriber has earned them.
 */
router.get('/drop', async (req, res) => {
  const sub = getByToken(String(req.query.t || ''));
  if (!sub) return res.status(404).json({ error: 'This link is not valid. Check your email for your personal link.' });

  let drop;
  try {
    drop = await ensureDrop();
  } catch (err) {
    console.error('[drop]', err.message);
    return res.json({ ready: false, status: sub.status });
  }

  const paid = isPaid(sub);
  const total = drop.videos.length;
  const invited = referralCount(sub.id, drop.created_at); // confirmed friends who joined since this drop went live
  const pending = referralPending(sub.id, drop.created_at); // joined through the link but haven't confirmed their email yet
  // The free tier: signing up unlocks song 1 straight away, 1 friend unlocks song 2, 2 friends unlock song 3.
  // Members get every song instantly.
  const unlocked = paid ? total : Math.min(total, 1 + invited);

  res.json({
    ready: true,
    status: sub.status,
    paid,
    invited,
    pending,
    confirmed: Boolean(sub.confirmed_at),
    total,
    unlocked,
    refUrl: `${publicOrigin(req)}/?ref=${sub.ref_code}`, // BASE_URL; only while that is still a local address, the address the visitor is on
    price: priceLabel,
    earlyAccessLive: earlyAccessLive(),
    songs: drop.videos.map((v, i) =>
      i < unlocked
        ? { index: i, locked: false, id: v.id, title: v.title, thumb: v.thumb, url: videoUrl(v.id) }
        : { index: i, locked: true, needs: i }, // `needs` = friends required (song 2 needs 1, song 3 needs 2)
    ),
    archive: paid
      ? recentDrops(13)
          .filter((d) => d.id !== drop.id)
          .map((d) => ({
            date: d.created_at,
            songs: d.videos.map((v) => ({ id: v.id, title: v.title, url: videoUrl(v.id) })),
          }))
      : [],
  });
});

/** One-click unsubscribe. Called by the unsubscribe page and by mail clients (List-Unsubscribe-Post). */
router.post('/unsubscribe', rateLimit({ windowMs: 10 * 60_000, max: 30 }), (req, res) => {
  const sub = getByToken(String(req.query.t || ''));
  if (!sub) return res.status(404).json({ error: 'Invalid link.' });
  updateSubscriber(sub.id, { unsubscribed: 1 });
  syncSubscriber(sub.id, { add: [cfg.tagUnsubscribed] });
  res.json({ ok: true, paid: isPaid(sub) });
});
