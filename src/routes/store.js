import { Router } from 'express';
import path from 'node:path';
import { cfg } from '../config.js';
import { getByToken } from '../db.js';
import {
  StoreError, checkoutParams, demoCatalog, fulfillOrder, itemsForCart, orderByToken, orderView,
  publicCatalog, resolveFile, scanCatalog, streamAlbumZip, takeDownload, tracksOf,
} from '../store.js';
import { stripe } from './billing.js';
import { rateLimit } from '../util.js';

export const router = Router(); // mounted at /api/store
export const downloads = Router(); // mounted at /download

// The store is part of the members area: everything except a buyer's own order page needs a subscriber's personal link.
const member = (req) => getByToken(String(req.query.t || req.body?.token || ''));
const needMember = (res) => res.status(401).json({ error: 'Join free with your email to open the store.' });

router.get('/catalog', async (req, res) => {
  if (!member(req)) return needMember(res);
  // ?preview=1 shows sample items (see demoCatalog) so an empty store can still be looked at
  res.set('Cache-Control', 'no-store').json(req.query.preview === '1' ? await demoCatalog() : await publicCatalog());
});

/** Cover art (album cover.jpg, or a song's matching image). Public, like any product photo; only serves an image that belongs to a catalog item. */
router.get('/cover/:id', (req, res) => {
  const { songs, albums } = scanCatalog();
  const item = [...songs, ...albums].find((i) => i.id === req.params.id);
  const file = item?.coverRel && resolveFile(item.coverRel);
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=3600').sendFile(file);
});

/** "Checkout": build a Stripe Checkout Session for the cart. Amounts are computed here, never taken from the browser. */
router.post('/checkout', rateLimit({ windowMs: 10 * 60_000, max: 20 }), async (req, res) => {
  const sub = member(req);
  if (!sub) return needMember(res);
  try {
    const items = itemsForCart(req.body?.items); // validates the cart first, so a preview cart gets the preview message
    if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet.' });
    const session = await stripe.checkout.sessions.create(checkoutParams(items, sub));
    res.json({ url: session.url });
  } catch (err) {
    if (err instanceof StoreError) return res.status(err.status).json({ error: err.message });
    console.error('[store checkout]', err.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

/** Where Stripe sends the buyer after paying: create the order right away instead of waiting for the webhook. */
router.get('/thanks', async (req, res) => {
  const id = String(req.query.session_id || '');
  if (!stripe || !/^cs_\w+$/.test(id)) return res.status(400).json({ error: 'Invalid session.' });
  try {
    const order = fulfillOrder(await stripe.checkout.sessions.retrieve(id));
    if (!order) return res.status(402).json({ error: 'Payment not completed.' });
    res.json({ token: order.token });
  } catch (err) {
    console.error('[store thanks]', err.message);
    res.status(502).json({ error: 'Could not confirm your payment yet. Your receipt email has your download link.' });
  }
});

/** A buyer's download page data. The private order token in the link is the only credential needed. */
router.get('/order', (req, res) => {
  const order = orderByToken(String(req.query.o || ''));
  if (!order) return res.status(404).json({ error: 'This download link is not valid.' });
  res.set('Cache-Control', 'no-store').json(orderView(order));
});

// ---------- file downloads ----------
const safeName = (text) => text.replace(/[\\/:*?"<>|]+/g, '').trim() || 'download';

/**
 * /download/:orderToken/:itemId            a song, or a whole album as a .zip
 * /download/:orderToken/:itemId/:track     one track of an album
 * Only items in that order can be fetched, and each file has a download limit.
 */
downloads.get('/:token/:itemId{/:track}', rateLimit({ windowMs: 10 * 60_000, max: 60 }), (req, res) => {
  const order = orderByToken(req.params.token);
  const item = order?.items.find((i) => i.id === req.params.itemId);
  if (!item) return res.status(404).type('text').send('This download link is not valid.');

  let file;
  let key = item.id;
  let name;
  let tracks;
  if (item.kind === 'song') {
    file = resolveFile(item.rel);
    name = `${safeName(item.title)}${path.extname(item.rel)}`;
  } else if (req.params.track === undefined) {
    tracks = tracksOf(item);
    file = tracks.length ? true : null;
    key = `${item.id}:zip`;
    name = `${safeName(item.title)}.zip`;
  } else {
    tracks = tracksOf(item);
    const index = Number(req.params.track);
    const track = Number.isInteger(index) ? tracks[index] : undefined;
    if (!track) return res.status(404).type('text').send('That track does not exist.');
    file = resolveFile(`${item.rel}/${track.file}`);
    key = `${item.id}:${index}`;
    name = `${String(index + 1).padStart(2, '0')} - ${safeName(track.title)}${path.extname(track.file)}`;
  }
  if (!file) return res.status(404).type('text').send('This file is not available right now. Please contact us and we will sort it out.');
  if (!takeDownload(order.id, key)) {
    return res.status(429).type('text').send(`This file has reached its limit of ${cfg.downloadLimit} downloads. Reply to your receipt email and we will help.`);
  }

  if (name.endsWith('.zip')) {
    res.attachment(name);
    return streamAlbumZip(res, item, tracks);
  }
  res.download(file, name);
});
