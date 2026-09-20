import { cfg, isLocalUrl } from './config.js';

/**
 * The public address to put in links that are shown on a page (the invite link, share tags).
 *
 * BASE_URL is the source of truth. If it is left at the local default (someone forgot to set it on a host that does not
 * announce itself as production), fall back to the address this visitor actually used, so a shared link still points at the
 * real site instead of localhost. The Host header is only trusted for that fallback and only when it looks like a plain
 * hostname; it is never used for emails or Stripe, which have no visitor and always use BASE_URL.
 */
export function publicOrigin(req) {
  if (!isLocalUrl(cfg.baseUrl)) return cfg.baseUrl;
  const host = req?.get?.('host') || '';
  if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(host)) {
    const origin = `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
    if (!isLocalUrl(origin)) return origin;
  }
  return cfg.baseUrl;
}
