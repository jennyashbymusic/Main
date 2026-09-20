// Shared helpers for every page.

export const $ = (sel, root = document) => root.querySelector(sel);

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined, // `signal` (e.g. a timeout) passes through via ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

/** Build DOM nodes without innerHTML, so video titles from YouTube can never inject markup. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

let configPromise;
export function loadConfig() {
  configPromise ??= api('/api/config').catch(() => ({ brand: 'Jenny Ashby', price: '$5', chorusPrice: '$10', chorusTurnaround: null, songPrice: '$2', albumPrice: '$12', winnersPerMonth: 3, votesFree: 1, votesMember: 3, downloadLimit: 10, contactEmail: null, youtubeUrl: null, songsPerDrop: 3, earlyAccessLive: false }));
  return configPromise;
}

/** Shown under every email field. One sentence, kept in one place. */
export const CONSENT_TEXT = 'By joining, you agree to get occasional emails about new songs and offers. Unsubscribe anytime.';

/**
 * Fill placeholders: data-brand / data-price / data-songs, data-consent (the sentence above), and the parts of the copy that
 * mention songs "before they go public": elements marked data-early are only shown once enough exclusive songs exist.
 */
export async function applyBranding() {
  const cfg = await loadConfig();
  document.querySelectorAll('[data-brand]').forEach((n) => (n.textContent = cfg.brand));
  document.querySelectorAll('[data-price]').forEach((n) => (n.textContent = cfg.price));
  document.querySelectorAll('[data-songs]').forEach((n) => (n.textContent = cfg.songsPerDrop));
  document.querySelectorAll('[data-chorus-price]').forEach((n) => (n.textContent = cfg.chorusPrice));
  // The FAQ and home sections quote the real settings, so the words can't drift from what the site does.
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  document.querySelectorAll('[data-song-price]').forEach((n) => (n.textContent = cfg.songPrice));
  document.querySelectorAll('[data-album-price]').forEach((n) => (n.textContent = cfg.albumPrice));
  document.querySelectorAll('[data-winners]').forEach((n) => (n.textContent = count(cfg.winnersPerMonth, 'song', 'songs')));
  document.querySelectorAll('[data-votes-free]').forEach((n) => (n.textContent = count(cfg.votesFree, 'vote', 'votes')));
  document.querySelectorAll('[data-votes-member]').forEach((n) => (n.textContent = count(cfg.votesMember, 'vote', 'votes')));
  document.querySelectorAll('[data-download-limit]').forEach((n) => (n.textContent = cfg.downloadLimit));
  // "Contact" only appears if CONTACT_EMAIL is set; otherwise the fallback wording shows
  document.querySelectorAll('[data-contact-link]').forEach((a) => { if (cfg.contactEmail) { a.href = `mailto:${cfg.contactEmail}`; a.textContent = a.dataset.contactLink || cfg.contactEmail; a.hidden = false; } });
  document.querySelectorAll('[data-no-contact]').forEach((n) => (n.hidden = Boolean(cfg.contactEmail)));
  document.querySelectorAll('[data-chorus-when]').forEach((n) => (n.textContent = cfg.chorusTurnaround ? `, delivered ${cfg.chorusTurnaround}` : ''));
  document.querySelectorAll('[data-consent]').forEach((n) => (n.textContent = CONSENT_TEXT));
  document.querySelectorAll('[data-early]').forEach((n) => (n.hidden = !cfg.earlyAccessLive));
  if (document.title.includes('{brand}')) document.title = document.title.replace('{brand}', cfg.brand);
  return cfg;
}

export const param = (name) => new URLSearchParams(location.search).get(name);

// ---- Top navigation: the members area. It only appears for people who have given their email. ----
// Home and the Leaderboard are public pages, but the tabs are only drawn for members. The active tab is gold.
// Four things at the top instead of seven: a group's button opens a dropdown, and the group that holds the page you are on lights up.
const NAV = [
  { id: 'home', label: 'Home', href: () => '/' },
  { label: 'Vote', items: [
    { id: 'vote', label: 'Cast your vote', href: () => '/vote' },
    { id: 'leaderboard', label: 'Leaderboard', href: () => '/leaderboard' },
    { id: 'release', label: 'Next Release', href: () => '/next-release' }, // countdown to the next songs on Spotify
  ] },
  { label: 'Shop', items: [
    { id: 'store', label: 'Store', href: () => '/store' },
    { id: 'chorus', label: 'Custom Chorus', href: () => '/chorus' }, // the $10 one-off product
  ] },
  { id: 'tipjar', label: 'Tip Jar', href: () => '/tip-jar' }, // a one-time tip through Stripe
  { id: 'invite', label: 'Invite', href: (token) => `/unlock?t=${encodeURIComponent(token)}` }, // your songs + your invite link
];

const brandLink = () =>
  el('a', { class: 'brand', href: '/', 'aria-label': 'Home' }, el('img', { class: 'avatar', src: '/img/jenny-avatar.jpg', alt: '' }),
    el('span', { class: 'brand-text' }, el('span', { 'data-brand': true }, 'Jenny Ashby'), el('small', {}, 'Dark Country • Real Stories')));

/**
 * Fill <div id="topbar">. Members (a valid personal token) get the tabs; everyone else gets nothing, or, on pages that
 * pass { publicBar: true }, a slim brand bar with a "Join free" button. Returns true when the visitor is a member.
 */
export async function mountNav(active, { publicBar = false } = {}) {
  const host = document.getElementById('topbar');
  if (!host) return false;
  const guest = () => {
    if (!publicBar) { host.replaceChildren(); host.hidden = true; return; }
    host.hidden = false;
    host.replaceChildren(el('div', { class: 'wrap wide topbar-in' }, brandLink(), el('a', { class: 'btn sm', href: '/' }, 'Join free')));
  };

  const token = getToken();
  if (!token) { guest(); return false; }

  // Show the tabs straight away for a remembered member, then confirm the token is real.
  const link = (t) => el('a', { href: t.href(token), 'aria-current': t.id === active ? 'page' : null }, t.label);
  const hasCurrent = (g) => g.items.some((t) => t.id === active);
  const caret = () => el('span', { class: 'caret', 'aria-hidden': 'true' });

  // Wide windows: Home | Vote ▾ | Shop ▾ | Invite. A group's button opens a dropdown right under it (one open at a time).
  const groups = [];
  const closeDrops = (except = null) => {
    for (const g of groups) if (g !== except) { g.drop.hidden = true; g.btn.setAttribute('aria-expanded', 'false'); }
  };
  const tabs = el('nav', { class: 'tabs', 'aria-label': 'Members area' }, NAV.map((n, i) => {
    if (!n.items) return link(n);
    const btn = el('button', { class: 'tab-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': `navGroup${i}`, 'data-current': hasCurrent(n) ? 'true' : null }, n.label, caret());
    const drop = el('div', { class: 'tab-drop', id: `navGroup${i}`, hidden: true }, n.items.map(link));
    const g = { btn, drop };
    groups.push(g);
    btn.addEventListener('click', () => {
      const open = drop.hidden;
      closeDrops(g);
      drop.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      // Line the list up under its button; if that would run off the right edge of a narrow window, line it up with the button's right side instead.
      drop.style.left = ''; drop.style.right = '';
      if (open && drop.getBoundingClientRect().right > document.documentElement.clientWidth - 8) { drop.style.left = 'auto'; drop.style.right = '0'; }
    });
    btn.addEventListener('keydown', (e) => { // arrow keys: Down opens the list and moves into it
      if (e.key !== 'ArrowDown') return;
      e.preventDefault();
      if (drop.hidden) btn.click();
      drop.querySelector('a').focus();
    });
    drop.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...drop.querySelectorAll('a')];
      const next = items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) btn.focus(); else items[Math.min(next, items.length - 1)].focus();
    });
    return el('div', { class: 'tab-group' }, btn, drop);
  }));

  // Narrow windows: a hamburger button on the far right drops a menu down under the bar. The groups become sections that expand
  // in place, and the section holding the current page starts open. (The switch is pure CSS, see .burger / .nav-menu in styles.css.)
  const menu = el('nav', { class: 'nav-menu', id: 'navMenu', 'aria-label': 'Members area menu', hidden: true }, NAV.map((n, i) => {
    if (!n.items) return link(n);
    const open = hasCurrent(n);
    const sub = el('div', { class: 'mm-sub', id: `menuGroup${i}`, hidden: !open }, n.items.map(link));
    const head = el('button', { class: 'mm-group', type: 'button', 'aria-expanded': String(open), 'aria-controls': `menuGroup${i}`, 'data-current': open ? 'true' : null }, n.label, caret());
    head.addEventListener('click', () => {
      const show = sub.hidden;
      sub.hidden = !show;
      head.setAttribute('aria-expanded', String(show));
    });
    return el('div', { class: 'mm-section' }, head, sub);
  }));
  const burger = el('button', { class: 'burger', type: 'button', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'navMenu' },
    el('span'), el('span'), el('span'));
  const setMenu = (open, refocus = false) => {
    menu.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
    if (!open && refocus) burger.focus();
  };
  burger.addEventListener('click', () => setMenu(menu.hidden));
  document.addEventListener('click', (e) => { // tap anywhere else to close
    if (host.contains(e.target)) return;
    closeDrops();
    if (!menu.hidden) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = groups.find((g) => !g.drop.hidden);
    if (open) { closeDrops(); open.btn.focus(); } else if (!menu.hidden) setMenu(false, true);
  });
  window.addEventListener('resize', () => closeDrops()); // a resize would leave an open list in the wrong place
  matchMedia('(min-width: 781px)').addEventListener('change', () => { setMenu(false); closeDrops(); }); // crossing the breakpoint: put both away
  host.hidden = false;
  host.replaceChildren(el('div', { class: 'wrap wide topbar-in' }, brandLink(), tabs, burger), menu);

  try {
    const res = await fetch(`/api/me?t=${encodeURIComponent(token)}`);
    if (res.status === 404) { forgetToken(); guest(); return false; } // stale or made-up token
  } catch { /* offline: leave the nav as it is */ }
  return true;
}

// Remember this visitor's personal token in their browser so returning visitors land back on their own invite page.
const TOKEN_KEY = 'lm_token';
export function saveToken(token) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); } catch { /* storage blocked: the feature just doesn't persist */ }
}
export function forgetToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}
/** The token from the URL (?t=) if present, otherwise the remembered one. */
export function getToken() {
  const fromUrl = param('t');
  if (fromUrl) { saveToken(fromUrl); return fromUrl; }
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}

/** 200 -> "$2", 1250 -> "$12.50" */
export function money(cents, currency = 'usd') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}

/** Join the list from the current page, remember them in this browser, and go to the sales page. Throws with a readable message. */
export async function signup(email, website = '', source = 'unknown') {
  let ref = '';
  try { ref = localStorage.getItem('lm_ref') || param('ref') || ''; } catch { ref = param('ref') || ''; }
  try {
    const { redirect } = await api('/api/subscribe', {
      method: 'POST',
      body: { email, website, ref, source }, // `source` is stored with their consent: where they agreed to get emails
      signal: AbortSignal.timeout(15000), // never leave a button stuck on "One sec…"
    });
    saveToken(new URL(redirect, location.origin).searchParams.get('t'));
    location.href = redirect; // the sales page
  } catch (err) {
    throw err.name === 'TimeoutError' ? new Error('That took too long. Please try again.') : err;
  }
}

/** The screen shown on members-only pages to someone who hasn't given their email yet. */
export function memberGate(container, { title = ['Members ', 'area'], text, extra = null, source = 'gate' } = {}) {
  const input = el('input', { type: 'email', name: 'email', placeholder: 'you@email.com', autocomplete: 'email', required: true, 'aria-label': 'Email address' });
  const hp = el('input', { class: 'hp', type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const button = el('button', { class: 'btn', type: 'submit' }, 'Get in →');
  const msg = el('div', { class: 'msg', role: 'status' });
  const form = el('form', { class: 'signup', novalidate: true }, input, hp, button);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = ''; msg.className = 'msg';
    button.disabled = true; button.textContent = 'One sec…';
    try { await signup(input.value, hp.value, source); } catch (err) {
      msg.textContent = err.message; msg.className = 'msg err';
      button.disabled = false; button.textContent = 'Get in →';
    }
  });
  container.replaceChildren(el('div', { class: 'card gate' },
    el('span', { class: 'pill red' }, 'Members area'),
    el('h1', { style: 'margin-top:14px' }, title[0], el('span', { class: 'grad' }, title[1])),
    el('p', { class: 'lead' }, text),
    form, msg,
    el('p', { class: 'muted small', style: 'margin:6px 0 0' }, CONSENT_TEXT),
    extra));
}

// ---- Tappable platform logos on the header banner ----
// The Spotify / YouTube Music / Amazon Music logos are part of the banner PICTURE, so they can't be links themselves.
// We lay invisible links over them. Positions are percentages of the picture (centre point + size), so they follow the
// image at every screen size, and each link has a 44px minimum touch target for phones.
// The URLs come from the server config (SPOTIFY_URL, YOUTUBE_MUSIC_URL, AMAZON_MUSIC_URL); a blank URL means no link.
const LOGO_HITS = [
  { id: 'spotify', label: 'Spotify', x: 51.9, y: 71.6, w: 12.5, h: 10.5 },
  { id: 'youtube-music', label: 'YouTube Music', x: 67.7, y: 72.4, w: 14, h: 10.3 },
  { id: 'amazon-music', label: 'Amazon Music', x: 83, y: 73.4, w: 12.5, h: 9.5 },
];

export async function enhanceBanners() {
  const boxes = document.querySelectorAll('.banner-inner');
  if (!boxes.length) return;
  let links = [];
  try { links = (await api('/api/links')).links; } catch { return; } // no links known: the banner just stays a picture
  for (const box of boxes) {
    for (const hit of LOGO_HITS) {
      const link = links.find((l) => l.id === hit.id);
      if (!link?.url) continue;
      box.append(el('a', {
        class: 'banner-hit', href: link.url, target: '_blank', rel: 'noopener', 'aria-label': `Listen to Jenny Ashby on ${hit.label}`,
        style: `left:${hit.x}%;top:${hit.y}%;width:${hit.w}%;height:${hit.h}%`,
      }));
    }
  }
}
enhanceBanners();

/**
 * The share row used on the Invite page and the leaderboard: the link in a box, a Copy button that says "Copied ✓", and
 * WhatsApp / X / Facebook / Email (plus the phone's own share sheet where there is one). Returns two elements.
 */
export function shareRow(url, { text, subject = 'Have a listen', title = '', inputLabel = 'Link to share' } = {}) {
  const input = el('input', { readonly: true, value: url, 'aria-label': inputLabel });
  input.addEventListener('focus', () => input.select());
  const copyBtn = el('button', { class: 'btn sm', type: 'button', 'aria-live': 'polite' }, 'Copy link');
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); } catch { input.select(); try { document.execCommand('copy'); } catch { /* the link is selected: press Ctrl+C */ } }
    const old = 'Copy link';
    copyBtn.textContent = 'Copied ✓';
    setTimeout(() => (copyBtn.textContent = old), 1600);
  });
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);
  const buttons = [
    ['WhatsApp', `https://wa.me/?text=${t}%20${u}`],
    ['X / Twitter', `https://twitter.com/intent/tweet?text=${t}&url=${u}`],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
    ['Email', `mailto:?subject=${encodeURIComponent(subject)}&body=${t}%20${u}`],
  ].map(([label, href]) => el('a', { class: 'btn ghost sm', href, target: '_blank', rel: 'noopener' }, label));
  if (navigator.share) {
    buttons.unshift(el('button', { class: 'btn sm', type: 'button', onclick: () => navigator.share({ title, text, url }).catch(() => {}) }, 'Share…'));
  }
  return [el('div', { class: 'sharebox' }, input, copyBtn), el('div', { class: 'sharebtns' }, buttons)];
}
