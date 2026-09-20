import express, { Router } from 'express';
import Stripe from 'stripe';
import { cfg } from '../config.js';
import {
  createSubscriber,
  getById,
  getByEmail,
  getByStripeCustomer,
  getByStripeSubscription,
  getByToken,
  isPaid,
  updateSubscriber,
} from '../db.js';
import { ensureDrop } from '../drops.js';
import { dropEmail } from '../emails.js';
import { sendMail } from '../mailer.js';
import { fulfillChorus } from '../chorus.js';
import { fulfillTip } from '../tips.js';
import { fulfillOrder, refreshStore } from '../store.js';
import { syncSubscriber, tagsForStatus } from '../systeme.js';
import { rateLimit } from '../util.js';

export const router = Router();
export const stripe = cfg.stripeKey ? new Stripe(cfg.stripeKey) : null;
const notConfigured = (res) => res.status(503).json({ error: 'Payments are not set up yet.' });

// ---------- membership state ----------

/** Stripe subscription status -> our status. past_due keeps access while Stripe retries the card. */
function statusFromStripe(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'member';
  if (stripeStatus === 'past_due') return 'past_due';
  return 'cancelled'; // canceled | unpaid | incomplete_expired
}

function setStatus(sub, status, extra = {}) {
  const wasPaid = isPaid(sub);
  const updated = updateSubscriber(sub.id, {
    status,
    ...(status === 'member' && !sub.member_since && { member_since: new Date().toISOString() }),
    ...extra,
  });
  if (status !== sub.status) syncSubscriber(sub.id, tagsForStatus(status));
  return { sub: updated, becameMember: isPaid(updated) && !wasPaid };
}

async function welcomeNewMember(sub) {
  try {
    const drop = await ensureDrop();
    await sendMail({ to: sub.email, ...dropEmail(sub, drop, "You're in — here are this week's songs") });
  } catch (err) {
    console.error('[member-welcome]', err.message); // e.g. YouTube not configured yet; they still get the next drop
  }
}

/** Find (or create) the subscriber a Checkout Session belongs to. */
function subscriberFromSession(session) {
  const refId = Number(session.client_reference_id);
  let sub = Number.isInteger(refId) && refId > 0 ? getById(refId) : undefined;
  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  if (!sub && email) sub = getByEmail(email);
  if (!sub && email) {
    // Bought without going through the email form. Buying the membership is asking for its emails, so record that as the
    // source; Stripe collected this address at checkout, so it counts as confirmed.
    sub = createSubscriber(email, null, { consentSource: 'membership_purchase', confirmed: true });
    syncSubscriber(sub.id, tagsForStatus('lead'));
  }
  return sub;
}

/** Idempotent: called from both the webhook and the post-payment redirect, whichever lands first. */
async function activateFromSession(session) {
  if (session.mode !== 'subscription') return null;
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) return null;
  const sub = subscriberFromSession(session);
  if (!sub) return null;
  const { sub: updated, becameMember } = setStatus(sub, 'member', {
    stripe_customer_id: session.customer || sub.stripe_customer_id,
    stripe_subscription_id: session.subscription || sub.stripe_subscription_id,
    // (an earlier unsubscribe is kept: buying a membership doesn't quietly turn emails back on)
  });
  if (becameMember && !updated.unsubscribed) welcomeNewMember(updated);
  return updated;
}

function applySubscription(subscription) {
  const sub =
    getByStripeSubscription(subscription.id) ||
    getById(Number(subscription.metadata?.subscriber_id)) ||
    getByStripeCustomer(subscription.customer);
  if (!sub) return;
  const status = statusFromStripe(subscription.status);
  if (status !== sub.status) setStatus(sub, status, { stripe_subscription_id: subscription.id });
}

// ---------- routes ----------

/** Stripe webhook. Needs the raw body for signature verification, so server.js mounts this before express.json(). */
export const webhook = [express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !cfg.stripeWebhookSecret) return notConfigured(res);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], cfg.stripeWebhookSecret);
  } catch (err) {
    console.error('[webhook] bad signature:', err.message);
    return res.status(400).send('Invalid signature');
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.metadata?.store === '1') { await refreshStore(); fulfillOrder(session); } // a music-store purchase
        else if (session.metadata?.chorus === '1') fulfillChorus(session); // a custom chorus order
        else if (session.metadata?.tip === '1') fulfillTip(session); // a tip-jar tip
        else await activateFromSession(session); // a membership subscription
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        applySubscription(event.data.object);
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error(`[webhook] ${event.type} failed:`, err);
    res.status(500).send('Handler error'); // Stripe will retry
  }
}];

/** "Buy" button: create a Stripe Checkout Session for the $5/month membership. */
router.post('/api/checkout', rateLimit({ windowMs: 10 * 60_000, max: 20 }), async (req, res) => {
  if (!stripe) return notConfigured(res);
  const sub = getByToken(String((req.body || {}).token || ''));
  if (isPaid(sub)) return res.json({ url: `${cfg.baseUrl}/unlock?t=${sub.token}` }); // already a member

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        cfg.stripePriceId
          ? { price: cfg.stripePriceId, quantity: 1 }
          : {
              quantity: 1,
              price_data: {
                currency: cfg.currency,
                unit_amount: cfg.priceCents,
                recurring: { interval: 'month' },
                product_data: { name: `${cfg.brand} membership`, description: `${cfg.songsPerDrop} songs every week` },
              },
            },
      ],
      ...(sub?.stripe_customer_id ? { customer: sub.stripe_customer_id } : sub ? { customer_email: sub.email } : {}),
      ...(sub && { client_reference_id: String(sub.id), subscription_data: { metadata: { subscriber_id: String(sub.id) } } }),
      allow_promotion_codes: true,
      success_url: `${cfg.baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: sub ? `${cfg.baseUrl}/join?t=${sub.token}` : `${cfg.baseUrl}/join`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

/** Where Stripe sends people after paying. Activates the membership right away instead of waiting for the webhook. */
router.get('/api/welcome', async (req, res) => {
  const id = String(req.query.session_id || '');
  if (!stripe || !/^cs_[\w]+$/.test(id)) return res.status(400).json({ error: 'Invalid session.' });
  try {
    const session = await stripe.checkout.sessions.retrieve(id);
    const sub = await activateFromSession(session);
    if (!sub) return res.status(402).json({ error: 'Payment not completed.' });
    res.json({ email: sub.email, unlockUrl: `/unlock?t=${sub.token}` });
  } catch (err) {
    console.error('[welcome]', err.message);
    res.status(502).json({ error: 'Could not confirm your payment yet — check your email in a minute.' });
  }
});

export const PORTAL_STEPS = [
  'Open the Stripe Dashboard > Settings > Billing > Customer portal (https://dashboard.stripe.com/settings/billing/portal).',
  'Turn ON "Customers can cancel subscriptions" and choose whether cancellation happens at the end of the billing period or immediately.',
  'Recommended: also turn on "Update payment methods" and "Invoice history".',
  'Click Save (that creates the default portal configuration).',
  'Stripe keeps test mode and live mode separate: do this once with test keys and again in live mode before you go live.',
];

/**
 * "Manage subscription" link (member area and member emails): opens Stripe's hosted customer portal, where a member
 * can update their card, see invoices and cancel. The portal must be switched on in the Stripe Dashboard first.
 */
router.get('/billing', async (req, res) => {
  const sub = getByToken(String(req.query.t || ''));
  if (!stripe || !sub?.stripe_customer_id) return res.redirect(sub ? `/join?t=${sub.token}` : '/');
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${cfg.baseUrl}/unlock?t=${sub.token}`,
    });
    res.redirect(portal.url);
  } catch (err) {
    // Usually: the customer portal has never been switched on in the Stripe Dashboard. Spell out what to do in the log.
    console.error(`[billing] could not open the customer portal: ${err.message}\n  To fix it:\n  - ${PORTAL_STEPS.join('\n  - ')}`);
    res.status(503).type('text').send("We couldn't open subscription management just now. Please email us and we'll take care of your subscription.");
  }
});

/**
 * Is the Stripe customer portal ready to honor "cancel anytime"? Reads the portal configuration from Stripe.
 * `client` is injectable so this can be tested without a network.
 */
export async function checkPortal(client = stripe) {
  if (!client) return { ok: false, problem: 'Stripe is not configured (set STRIPE_SECRET_KEY).', steps: PORTAL_STEPS };
  const list = await client.billingPortal.configurations.list({ limit: 10 });
  const active = list.data.filter((c) => c.active);
  const chosen = active.find((c) => c.is_default) || active[0];
  if (!chosen) return { ok: false, problem: 'No customer portal has been set up in this Stripe mode yet, so "Manage subscription" will not work.', steps: PORTAL_STEPS };
  const f = chosen.features || {};
  const cancel = f.subscription_cancel?.enabled === true;
  return {
    ok: cancel,
    cancelEnabled: cancel,
    cancelMode: f.subscription_cancel?.mode || null, // "at_period_end" or "immediately"
    updatePaymentMethod: f.payment_method_update?.enabled === true,
    invoiceHistory: f.invoice_history?.enabled === true,
    problem: cancel ? null : 'The portal is set up but customers are NOT allowed to cancel in it, so "cancel anytime" would not be true.',
    steps: cancel ? [] : PORTAL_STEPS,
  };
}
