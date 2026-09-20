import { Router } from 'express';
import { TipError, attachSession, checkoutParams, createTip, fulfillTip, parseTip, tipOptions } from '../tips.js';
import { stripe } from './billing.js';
import { rateLimit } from '../util.js';

export const router = Router(); // mounted at /api/tips. Public: anyone can leave a tip.

/** The quick-pick amounts and the smallest/biggest tip, for the page. */
router.get('/options', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ ...tipOptions(), ready: Boolean(stripe) });
});

/** Save the tip, then send the tipper to Stripe to pay. */
router.post('/checkout', rateLimit({ windowMs: 10 * 60_000, max: 10 }), async (req, res) => {
  try {
    const tip = parseTip(req.body);
    if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet. Please check back soon.' });
    const tipId = createTip(tip);
    const session = await stripe.checkout.sessions.create(checkoutParams(tipId, tip));
    attachSession(tipId, session.id);
    res.json({ url: session.url });
  } catch (err) {
    if (err instanceof TipError) return res.status(err.status).json({ error: err.message });
    console.error('[tips checkout]', err.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

/** Where Stripe sends the tipper after paying: confirm the tip right away instead of waiting for the webhook. */
router.get('/thanks', async (req, res) => {
  const id = String(req.query.session_id || '');
  if (!stripe || !/^cs_\w+$/.test(id)) return res.status(400).json({ error: 'Invalid session.' });
  try {
    const tip = fulfillTip(await stripe.checkout.sessions.retrieve(id));
    if (!tip) return res.status(402).json({ error: 'Payment not completed.' });
    res.json({ amountCents: tip.amount_cents, currency: tip.currency, name: tip.name, email: tip.email });
  } catch (err) {
    console.error('[tips thanks]', err.message);
    res.status(502).json({ error: 'Could not confirm your tip yet. A confirmation email is on its way.' });
  }
});
