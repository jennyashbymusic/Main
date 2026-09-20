import { Router } from 'express';
import { cfg } from '../config.js';
import {
  ChorusError, OCCASIONS, STYLES, attachSession, checkoutParams, createRequest, fulfillChorus, parseBrief,
} from '../chorus.js';
import { stripe } from './billing.js';
import { rateLimit } from '../util.js';

export const router = Router(); // mounted at /api. Everything here is public: this is the page linked from social bios.

/** The link-in-bio page. A blank URL in .env hides that button. */
router.get('/links', (_req, res) => {
  const links = [
    { id: 'spotify', label: 'Spotify', note: 'Stream on Spotify', url: cfg.spotifyUrl },
    { id: 'youtube-music', label: 'YouTube Music', note: 'Listen on YouTube Music', url: cfg.youtubeMusicUrl },
    { id: 'amazon-music', label: 'Amazon Music', note: 'Listen on Amazon Music', url: cfg.amazonMusicUrl },
  ].filter((l) => l.url);
  res.json({
    brand: cfg.brand,
    tagline: 'Dark Country • Real Stories',
    links,
    chorus: {
      priceCents: cfg.chorusPriceCents, currency: cfg.currency, occasions: OCCASIONS, styles: STYLES,
      // the expectations shown next to the order form
      turnaround: cfg.chorusTurnaround || null, delivery: cfg.chorusDelivery || null, refund: cfg.chorusRefund || null,
    },
  });
});

/** Save the brief, then send the buyer to Stripe to pay. */
router.post('/chorus/checkout', rateLimit({ windowMs: 10 * 60_000, max: 10 }), async (req, res) => {
  try {
    const brief = parseBrief(req.body);
    if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet. Please check back soon.' });
    const requestId = createRequest(brief);
    const session = await stripe.checkout.sessions.create(checkoutParams(requestId, brief));
    attachSession(requestId, session.id);
    res.json({ url: session.url });
  } catch (err) {
    if (err instanceof ChorusError) return res.status(err.status).json({ error: err.message });
    console.error('[chorus checkout]', err.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

/** Where Stripe sends the buyer after paying: confirm the order right away instead of waiting for the webhook. */
router.get('/chorus/thanks', async (req, res) => {
  const id = String(req.query.session_id || '');
  if (!stripe || !/^cs_\w+$/.test(id)) return res.status(400).json({ error: 'Invalid session.' });
  try {
    const request = fulfillChorus(await stripe.checkout.sessions.retrieve(id));
    if (!request) return res.status(402).json({ error: 'Payment not completed.' });
    res.json({ forName: request.for_name, email: request.email, turnaround: cfg.chorusTurnaround || null });
  } catch (err) {
    console.error('[chorus thanks]', err.message);
    res.status(502).json({ error: 'Could not confirm your payment yet. A confirmation email is on its way.' });
  }
});
