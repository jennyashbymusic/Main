// Systeme.io public API: keeps your contact list + tags in sync with the funnel.
// Docs: https://developer.systeme.io  (auth header: X-API-Key)
import { cfg } from './config.js';
import { getById, updateSubscriber } from './db.js';

const BASE = 'https://api.systeme.io/api';
export const systemeEnabled = () => Boolean(cfg.systemeKey);

async function api(method, path, body, attempt = 0) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'X-API-Key': cfg.systemeKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 2) {
    const wait = Math.min(Number(res.headers.get('Retry-After')) || 2, 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(method, path, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Systeme.io ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const tagIds = new Map(); // lower-cased name -> id

/** Tag ID by name. Creates the tag when `create` is true; otherwise returns null if it doesn't exist. */
async function findTagId(name, { create }) {
  const key = name.toLowerCase();
  if (tagIds.has(key)) return tagIds.get(key);
  const list = await api('GET', `/tags?query=${encodeURIComponent(name)}&limit=100`);
  let tag = list.items?.find((t) => t.name.toLowerCase() === key);
  if (!tag && !create) return null;
  if (!tag) tag = await api('POST', '/tags', { name });
  tagIds.set(key, tag.id);
  return tag.id;
}

async function findContactByEmail(email) {
  const list = await api('GET', `/contacts?email=${encodeURIComponent(email)}&limit=10`);
  return list.items?.find((c) => c.email.toLowerCase() === email.toLowerCase());
}

async function ensureContact(sub) {
  if (sub.systeme_contact_id) return sub.systeme_contact_id;
  let contact = await findContactByEmail(sub.email);
  if (!contact) {
    try {
      contact = await api('POST', '/contacts', { email: sub.email, locale: 'en' });
    } catch (err) {
      if (err.status !== 422) throw err;
      contact = await findContactByEmail(sub.email); // created by a parallel request
      if (!contact) throw err;
    }
  }
  updateSubscriber(sub.id, { systeme_contact_id: contact.id });
  return contact.id;
}

// One request at a time keeps us well under Systeme.io's rate limit and avoids create-contact races.
let chain = Promise.resolve();

/**
 * Make sure the subscriber exists as a Systeme.io contact, then add/remove tags.
 * Fire-and-forget: a Systeme.io outage must never break signup or checkout.
 * Anything missed can be re-pushed from the admin page ("Resync").
 */
export function syncSubscriber(subscriberId, { add = [], remove = [] } = {}) {
  if (!systemeEnabled()) return Promise.resolve();
  const job = chain.then(async () => {
    const sub = getById(subscriberId);
    if (!sub) return;
    const contactId = await ensureContact(sub);
    for (const name of add) {
      await api('POST', `/contacts/${contactId}/tags`, { tagId: await findTagId(name, { create: true }) });
    }
    for (const name of remove) {
      const tagId = await findTagId(name, { create: false });
      if (!tagId) continue; // tag was never created, so no contact can have it
      try {
        await api('DELETE', `/contacts/${contactId}/tags/${tagId}`);
      } catch (err) {
        if (err.status !== 404) throw err; // tag wasn't on the contact
      }
    }
  });
  chain = job.catch((err) => console.error('[systeme]', err.message));
  return chain;
}

/** Tag changes that mirror a subscriber's current status. */
export function tagsForStatus(status) {
  if (status === 'member' || status === 'past_due') {
    return { add: [cfg.tagMember], remove: [cfg.tagLead, cfg.tagCancelled] };
  }
  if (status === 'cancelled') return { add: [cfg.tagCancelled], remove: [cfg.tagMember] };
  return { add: [cfg.tagLead], remove: [] };
}
