// The tip jar: a fan leaves Jenny a one-time tip through Stripe Checkout.
// The tip is saved BEFORE payment (status "pending") so it can travel with the Stripe session by id; it only becomes "paid" when
// Stripe confirms the payment. It is a one-time payment on purpose: a recurring tip would be a Stripe subscription, and this
// site's webhook treats subscriptions as memberships.
import { cfg } from './config.js';
import { db, getByEmail } from './db.js';
import { tipOwnerEmail, tipReceiptEmail, unsubscribeUrlFor } from './emails.js';
import { sendMail } from './mailer.js';

export class TipError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const money = (cents) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cfg.currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

const clean = (value, max) =>
  String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // control characters
    .trim()
    .slice(0, max);

/** What the tip jar page offers: the quick-pick amounts and the smallest/biggest tip. Set in .env (TIP_AMOUNTS, TIP_MIN_CENTS, TIP_MAX_CENTS). */
export const tipOptions = () => ({
  currency: cfg.currency,
  presetsCents: cfg.tipPresetsCents,
  minCents: cfg.tipMinCents,
  maxCents: cfg.tipMaxCents,
});

/** Validate what the tipper chose. The amount is checked here on the server; the browser is never trusted with the price. */
export function parseTip(body = {}) {
  // whole cents only: a number, or a string of plain digits (so things like "0x1F4" or "5e2" are not accepted)
  const raw = body.amountCents;
  const amountCents = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(amountCents)) throw new TipError('Please choose an amount.');
  if (amountCents < cfg.tipMinCents) throw new TipError(`The smallest tip is ${money(cfg.tipMinCents)}.`);
  if (amountCents > cfg.tipMaxCents) throw new TipError(`The biggest tip we can take here is ${money(cfg.tipMaxCents)}. Thank you!`);
  return { amountCents, name: clean(body.name, 80), message: clean(body.message, 300) };
}

export function createTip(tip) {
  const info = db
    .prepare('INSERT INTO tips (amount_cents, currency, name, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(tip.amountCents, cfg.currency, tip.name, tip.message, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export const tipById = (id) => db.prepare('SELECT * FROM tips WHERE id = ?').get(id);

export function attachSession(tipId, sessionId) {
  db.prepare('UPDATE tips SET stripe_session_id = ? WHERE id = ? AND status = ?').run(sessionId, tipId, 'pending');
}

/** The Stripe Checkout Session for one tip: a single one-time payment for exactly the amount chosen (already validated). */
export function checkoutParams(tipId, tip) {
  return {
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: cfg.currency,
          unit_amount: tip.amountCents,
          product_data: { name: `Tip for ${cfg.brand}`, description: 'A one-time thank-you to support the music' },
        },
      },
    ],
    metadata: { tip: '1', tip_id: String(tipId) },
    payment_intent_data: { description: `Tip for ${cfg.brand}` },
    success_url: `${cfg.baseUrl}/tip-jar?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.baseUrl}/tip-jar`,
  };
}

/**
 * Mark a tip as paid (once) and send the emails. Called from the Stripe webhook and from the page Stripe returns the tipper to,
 * whichever arrives first. Returns the tip, or null if the session isn't a paid tip.
 */
export function fulfillTip(session) {
  if (session.mode !== 'payment' || session.metadata?.tip !== '1') return null;
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) return null;
  const id = Number(session.metadata.tip_id);
  const existing = Number.isInteger(id) ? tipById(id) : null;
  if (!existing) return null;

  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  const info = db
    .prepare(`UPDATE tips SET status = 'paid', email = ?, stripe_session_id = ?, amount_cents = ?, currency = ?, paid_at = ?
              WHERE id = ? AND status = 'pending'`)
    .run(email, session.id, session.amount_total ?? existing.amount_cents, (session.currency || cfg.currency).toLowerCase(), new Date().toISOString(), id);
  const tip = tipById(id);
  if (info.changes === 1) {
    // first time only: a replayed webhook or a page refresh must not send the emails again
    if (tip.email) {
      sendMail({ to: tip.email, ...tipReceiptEmail(tip, { unsubscribeUrl: unsubscribeUrlFor(getByEmail(tip.email)) }) })
        .catch((err) => console.error('[tips] receipt email failed:', err.message));
    }
    if (cfg.notifyEmail) sendMail({ to: cfg.notifyEmail, ...tipOwnerEmail(tip) }).catch((err) => console.error('[tips] owner email failed:', err.message));
    console.log(`[tips] new tip #${tip.id}: ${money(tip.amount_cents)}${tip.name ? ` from ${tip.name}` : ''}`);
  }
  return tip;
}

// ---------- admin ----------

export function tipsSummary() {
  const totals = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM tips WHERE status = 'paid'").get();
  const rows = db.prepare("SELECT * FROM tips WHERE status = 'paid' ORDER BY id DESC LIMIT 25").all();
  return {
    count: totals.n,
    totalCents: totals.cents,
    currency: cfg.currency.toUpperCase(),
    recent: rows.map((t) => ({ id: t.id, paidAt: t.paid_at, amountCents: t.amount_cents, name: t.name, message: t.message, email: t.email })),
  };
}
