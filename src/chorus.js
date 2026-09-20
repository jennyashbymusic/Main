// Custom chorus: a fan tells Jenny what they want, pays, and she delivers it by email.
// The order is saved BEFORE payment (status "pending") so the brief travels with the Stripe session by id;
// it only becomes a real order (status "paid") when Stripe confirms the payment.
import { cfg } from './config.js';
import { db, getByEmail } from './db.js';
import { chorusOwnerEmail, chorusReceiptEmail, unsubscribeUrlFor } from './emails.js';
import { sendMail } from './mailer.js';

export class ChorusError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const OCCASIONS = ['Birthday', 'Anniversary', 'Wedding', 'In memory of someone', 'Just because', 'Something else'];
export const STYLES = ['Dark and moody', 'Heartbreak', 'Love song', 'Defiant', 'Hopeful'];

const clean = (value, max) =>
  String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // control characters
    .trim()
    .slice(0, max);

/** Validate what the buyer typed. Everything is length-limited, and only known options are accepted for the pickers. */
export function parseBrief(body = {}) {
  const forName = clean(body.forName, 80);
  const story = clean(body.story, 1200);
  if (!forName) throw new ChorusError('Who is the chorus for? Please add a name.');
  if (story.length < 20) throw new ChorusError('Tell Jenny a little more (a couple of sentences) so she can write something real.');
  return {
    forName,
    story,
    buyerName: clean(body.buyerName, 80),
    occasion: OCCASIONS.includes(body.occasion) ? body.occasion : '',
    style: STYLES.includes(body.style) ? body.style : '',
  };
}

export function createRequest(brief) {
  const info = db
    .prepare('INSERT INTO chorus_requests (for_name, occasion, style, story, buyer_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(brief.forName, brief.occasion, brief.style, brief.story, brief.buyerName, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export const requestById = (id) => db.prepare('SELECT * FROM chorus_requests WHERE id = ?').get(id);

export function attachSession(requestId, sessionId) {
  db.prepare('UPDATE chorus_requests SET stripe_session_id = ? WHERE id = ? AND status = ?').run(sessionId, requestId, 'pending');
}

/** The Stripe Checkout Session for one custom chorus. The price always comes from here, never from the browser. */
export function checkoutParams(requestId, brief) {
  return {
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: cfg.currency,
          unit_amount: cfg.chorusPriceCents,
          product_data: { name: 'Custom chorus', description: `A custom chorus for ${brief.forName}`.slice(0, 300) },
        },
      },
    ],
    metadata: { chorus: '1', request: String(requestId) },
    payment_intent_data: { description: `Custom chorus for ${brief.forName}`.slice(0, 300) },
    allow_promotion_codes: true,
    success_url: `${cfg.baseUrl}/chorus?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.baseUrl}/chorus`,
  };
}

/**
 * Mark a request as paid (once) and send the emails. Called from the Stripe webhook and from the page Stripe returns the
 * buyer to, whichever arrives first. Returns the request, or null if the session isn't a paid custom chorus.
 */
export function fulfillChorus(session) {
  if (session.mode !== 'payment' || session.metadata?.chorus !== '1') return null;
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) return null;
  const id = Number(session.metadata.request);
  if (!Number.isInteger(id) || !requestById(id)) return null;

  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  const info = db
    .prepare(`UPDATE chorus_requests SET status = 'paid', email = ?, stripe_session_id = ?, amount_cents = ?, currency = ?, paid_at = ?
              WHERE id = ? AND status = 'pending'`)
    .run(email, session.id, session.amount_total ?? cfg.chorusPriceCents, (session.currency || cfg.currency).toLowerCase(), new Date().toISOString(), id);
  const request = requestById(id);
  if (info.changes === 1) {
    // first time only: a replayed webhook or a page refresh must not send the emails again
    if (request.email) {
      // A buyer who is also on the mailing list gets a working unsubscribe link in the receipt.
      sendMail({ to: request.email, ...chorusReceiptEmail(request, { unsubscribeUrl: unsubscribeUrlFor(getByEmail(request.email)) }) })
        .catch((err) => console.error('[chorus] receipt email failed:', err.message));
    }
    if (cfg.notifyEmail) sendMail({ to: cfg.notifyEmail, ...chorusOwnerEmail(request) }).catch((err) => console.error('[chorus] owner email failed:', err.message));
    console.log(`[chorus] new paid request #${request.id} for "${request.for_name}"`);
  }
  return request;
}

// ---------- admin ----------

export function chorusSummary() {
  const totals = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM chorus_requests WHERE status != 'pending'").get();
  const open = db.prepare("SELECT COUNT(*) AS n FROM chorus_requests WHERE status = 'paid'").get().n;
  const rows = db.prepare("SELECT * FROM chorus_requests WHERE status != 'pending' ORDER BY (status = 'paid') DESC, id DESC LIMIT 25").all();
  return {
    orders: totals.n,
    toDeliver: open,
    revenueCents: totals.cents,
    currency: cfg.currency.toUpperCase(),
    requests: rows.map((r) => ({
      id: r.id, status: r.status, paidAt: r.paid_at, deliveredAt: r.delivered_at, email: r.email, buyerName: r.buyer_name,
      forName: r.for_name, occasion: r.occasion, style: r.style, story: r.story, amountCents: r.amount_cents,
    })),
  };
}

export function setDelivered(id, delivered) {
  const request = requestById(id);
  if (!request || request.status === 'pending') throw new Error('Request not found.');
  db.prepare('UPDATE chorus_requests SET status = ?, delivered_at = ? WHERE id = ?').run(
    delivered ? 'delivered' : 'paid', delivered ? new Date().toISOString() : null, id,
  );
}
