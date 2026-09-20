import { cfg, priceLabel } from './config.js';
import { earlyAccessLive } from './songs.js';
import { videoUrl } from './youtube.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The unsubscribe page for a known subscriber. Receipts include it too, so a buyer who is on the list can leave it. */
export const unsubscribeUrlFor = (sub) => (sub?.token ? `${cfg.baseUrl}/unsubscribe?t=${sub.token}` : null);

const linksFor = (sub) => ({
  confirm: `${cfg.baseUrl}/confirm?t=${sub.token}`,
  unlock: `${cfg.baseUrl}/unlock?t=${sub.token}`,
  vote: `${cfg.baseUrl}/vote?t=${sub.token}`,
  join: `${cfg.baseUrl}/join?t=${sub.token}`,
  share: `${cfg.baseUrl}/?ref=${sub.ref_code}`,
  billing: `${cfg.baseUrl}/billing?t=${sub.token}`,
  unsubscribe: `${cfg.baseUrl}/unsubscribe?t=${sub.token}`,
  oneClick: `${cfg.baseUrl}/api/unsubscribe?t=${sub.token}`,
});

// Colors follow the Jenny Ashby header: near-black wood, cream paper, and the red of her shirt for buttons.
const button = (href, label, primary = true) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:13px 26px;border-radius:999px;font-weight:700;text-decoration:none;font-size:15px;` +
  (primary
    ? 'background:#c4321e;color:#ffffff;'
    : 'background:#fffaf0;color:#241a10;border:1px solid #d9c9a8;') +
  `">${esc(label)}</a>`;

function layout(sub, preheader, inner) {
  const l = sub.transactional ? null : linksFor(sub); // receipts have no unsubscribe/billing footer
  const banner = `${cfg.baseUrl}/img/jenny-ashby-email.jpg`;
  const html = `<!doctype html><html><body style="margin:0;background:#120d09;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#241a10;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</span>
<div style="max-width:560px;margin:0 auto;padding:20px 16px;">
  <a href="${esc(cfg.baseUrl)}"><img src="${esc(banner)}" alt="${esc(cfg.brand)} — Dark Country • Real Stories" width="528" style="display:block;width:100%;max-width:528px;height:auto;border-radius:14px;margin:0 auto 14px;border:0;"></a>
  <div style="background:#fffaf0;border-radius:16px;padding:28px 24px;line-height:1.55;font-size:16px;">${inner}</div>
  <p style="font-size:12px;color:#a8977a;text-align:center;line-height:1.6;margin:20px 8px;">
    ${sub.transactional
      ? `${esc(sub.footer || `This receipt was sent to ${sub.email} because of a purchase from ${cfg.brand}.`)}${sub.unsubscribeUrl ? `<br><a href="${esc(sub.unsubscribeUrl)}" style="color:#a8977a;">Unsubscribe from ${esc(cfg.brand)} emails</a>` : ''}`
      : `You're receiving this because ${esc(sub.email)} joined ${esc(cfg.brand)}'s list.<br>
    ${sub.status === 'member' || sub.status === 'past_due' ? `<a href="${esc(l.billing)}" style="color:#a8977a;">Manage subscription</a> · ` : ''}<a href="${esc(l.unsubscribe)}" style="color:#a8977a;">Unsubscribe</a>`}
    ${cfg.postalAddress ? `<br>${esc(cfg.postalAddress)}` : ''}
  </p>
</div></body></html>`;
  return html;
}

const finish = (sub, subject, preheader, inner, text) => ({
  subject,
  html: layout(sub, preheader, inner),
  text: `${text}\n\n--\nUnsubscribe: ${linksFor(sub).unsubscribe}`,
  unsubscribeUrl: linksFor(sub).oneClick,
});

function songBlock(v) {
  const url = videoUrl(v.id);
  const thumb = v.thumb
    ? `<a href="${esc(url)}"><img src="${esc(v.thumb)}" alt="" width="512" style="width:100%;max-width:512px;border-radius:12px;display:block;"></a>`
    : '';
  return `<div style="margin:0 0 26px;">${thumb}
    <div style="font-size:18px;font-weight:700;margin:12px 0 8px;">${esc(v.title)}</div>
    ${button(url, '▶  Watch now')}</div>`;
}

/** The membership pitch line. It only promises early songs once there are enough exclusive songs for that to be true. */
const memberPitch = () =>
  `${priceLabel}/mo for all ${cfg.songsPerDrop} songs instantly${earlyAccessLive() ? ', plus new songs before they go public' : ''}`;

/**
 * Sent when someone joins the free list. `song` is this week's FIRST song of the drop: signing up unlocks it straight away.
 * The email also carries the confirmation link when confirmation is required (friends only count once confirmed).
 */
export function welcomeEmail(sub, song = null) {
  const l = linksFor(sub);
  const needsConfirm = cfg.requireEmailConfirmation && !sub.confirmed_at;
  return finish(
    sub,
    `Welcome to ${cfg.brand}: your free song is inside 🎵`,
    song ? `This week's free song: ${song.title}` : 'Your personal link is inside.',
    `<h1 style="margin:0 0 12px;font-size:24px;">You're in 🎶</h1>
     ${song
       ? `<p>Here's this week's free Jenny song, on us:</p>${songBlock(song)}`
       : `<p>You're on the list. Your free song for the week is waiting on your personal page.</p>`}
     ${needsConfirm ? `<p style="margin:0 0 18px;">One quick thing: <strong>please confirm your email</strong>. If a friend invited you, this is what unlocks their next song.<br>${button(l.confirm, 'Confirm my email', false)}</p>` : ''}
     <p><strong>Want more?</strong> Each friend who joins through your link unlocks another song, up to ${cfg.songsPerDrop} a week.</p>
     <p style="margin:18px 0 8px;">${button(l.unlock, 'Invite friends, unlock more')}</p>
     <p style="margin:8px 0 0;">Or become a member: ${esc(memberPitch())}.<br>${button(l.join, `Become a member · ${priceLabel}/mo`, false)}</p>
     <p style="font-size:14px;color:#55556a;margin-top:24px;">Every month you also get a vote on which songs go on Spotify: <a href="${esc(l.vote)}" style="color:#b3341f;">cast your vote</a>.</p>
     <p style="font-size:14px;color:#55556a;">Your personal invite link:<br><a href="${esc(l.share)}" style="color:#b3341f;">${esc(l.share)}</a></p>`,
    `Welcome to ${cfg.brand}!\n\n${song ? `This week's free song: ${song.title}\n${videoUrl(song.id)}\n\n` : ''}${needsConfirm ? `Please confirm your email (if a friend invited you, this unlocks their next song): ${l.confirm}\n\n` : ''}Each friend who joins through your link unlocks another song, up to ${cfg.songsPerDrop} a week: ${l.unlock}\nOr become a member (${memberPitch()}): ${l.join}\nYour invite link: ${l.share}`,
  );
}

/**
 * Full drop for paying members. `intro` overrides the headline (used for the "you're a member" email).
 * `early` lists new members-only/early-access songs added since the last drop.
 */
export function dropEmail(sub, drop, intro, { early = [] } = {}) {
  const l = linksFor(sub);
  const heading = intro || `This week's ${drop.videos.length} songs`;
  const earlyHtml = early.length
    ? `<div style="background:#f7efdc;border-radius:12px;padding:14px 16px;margin:0 0 24px;">
         <p style="margin:0 0 6px;font-weight:700;">Early access, just for members</p>
         ${early.map((s) => `<div style="margin:2px 0;">${esc(s.title)}${s.access === 'members_early' && s.publicReleaseAt ? ` <span style="color:#7a6a4f;font-size:13px;">(public ${esc(new Date(s.publicReleaseAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }))})</span>` : ''}</div>`).join('')}
         <p style="margin:10px 0 0;">${button(l.unlock, 'Listen now', false)}</p>
       </div>`
    : '';
  return finish(
    sub,
    intro ? `${cfg.brand} — your first drop` : `${cfg.brand}: ${drop.videos.length} new songs`,
    drop.videos.map((v) => v.title).join(' · '),
    `<h1 style="margin:0 0 20px;font-size:24px;">${esc(heading)}</h1>
     ${drop.videos.map(songBlock).join('')}
     ${earlyHtml}
     <p style="font-size:14px;color:#55556a;"><a href="${esc(l.vote)}" style="color:#b3341f;font-weight:700;">Vote on which songs go on Spotify this month →</a></p>
     <p style="font-size:14px;color:#55556a;">Past drops live in your <a href="${esc(l.unlock)}" style="color:#b3341f;">member library</a>. Know someone who'd love this? Share <a href="${esc(l.share)}" style="color:#b3341f;">${esc(l.share)}</a>.</p>`,
    `${heading}\n\n${drop.videos.map((v) => `${v.title}\n${videoUrl(v.id)}`).join('\n\n')}${early.length ? `\n\nEarly access for members: ${early.map((s) => s.title).join(', ')}\nListen: ${l.unlock}` : ''}\n\nVote for Spotify: ${l.vote}\nMember library: ${l.unlock}`,
  );
}

/** Receipt for a music-store purchase, with the private link to the download page. `unsubscribeUrl` is set when the buyer is on the list. */
export function orderEmail(order, { unsubscribeUrl = null } = {}) {
  const page = `${cfg.baseUrl}/purchase?o=${order.token}`;
  const money = (cents) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: order.currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  const cell = 'padding:9px 0;border-bottom:1px solid #eadfca;';
  const rows = order.items
    .map((i) => `<tr><td style="${cell}">${esc(i.title)}${i.kind === 'album' ? ' <span style="color:#7a6a4f;font-size:13px;">(album)</span>' : ''}</td><td style="${cell}text-align:right;white-space:nowrap;">${money(i.priceCents)}</td></tr>`)
    .join('');
  const inner = `<h1 style="margin:0 0 12px;font-size:24px;">Thank you! 🎶</h1>
     <p>Your music is ready to download.</p>
     <table style="width:100%;border-collapse:collapse;margin:8px 0 6px;font-size:15px;">${rows}
       <tr><td style="padding:10px 0;font-weight:700;">Total</td><td style="padding:10px 0;text-align:right;font-weight:700;">${money(order.amount_cents)}</td></tr></table>
     <p style="margin:22px 0 8px;">${button(page, 'Download your music')}</p>
     <p style="font-size:14px;color:#55556a;">Keep this email: it has your private download link. Each file can be downloaded up to ${cfg.downloadLimit} times.</p>`;
  const sender = { email: order.email, transactional: true, unsubscribeUrl };
  return {
    unsubscribeUrl,
    subject: `Your ${cfg.brand} download`,
    html: layout(sender, 'Your music is ready to download.', inner),
    text: `Thank you! Your music is ready to download:\n${page}\n\n${order.items.map((i) => `${i.title} (${money(i.priceCents)})`).join('\n')}\nTotal: ${money(order.amount_cents)}`,
  };
}

const chorusDetails = (r) =>
  [['For', r.for_name], ['Occasion', r.occasion], ['Style', r.style], ['From', r.buyer_name], ['Buyer email', r.email]]
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><td style="padding:5px 14px 5px 0;color:#7a6a4f;vertical-align:top;white-space:nowrap;">${label}</td><td style="padding:5px 0;">${esc(value)}</td></tr>`)
    .join('');
const chorusStory = (r) =>
  `<div style="background:#f7efdc;border-radius:10px;padding:14px 16px;white-space:pre-wrap;font-size:15px;line-height:1.5;">${esc(r.story)}</div>`;
const paidLine = (r) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency || cfg.currency, minimumFractionDigits: r.amount_cents % 100 ? 2 : 0 }).format((r.amount_cents ?? cfg.chorusPriceCents) / 100);

/** Confirmation to the buyer that their custom chorus request was received. `unsubscribeUrl` is set when the buyer is on the list. */
export function chorusReceiptEmail(r, { unsubscribeUrl = null } = {}) {
  const inner = `<h1 style="margin:0 0 12px;font-size:24px;">We got your request 🎤</h1>
     <p>Thank you! Your custom chorus request is in. Jenny will create it and email it to <b>${esc(r.email)}</b>.</p>
     ${cfg.chorusTurnaround ? `<p>You can expect it ${esc(cfg.chorusTurnaround)}.</p>` : ''}
     ${cfg.chorusDelivery ? `<p><b>What you'll get:</b> ${esc(cfg.chorusDelivery)}</p>` : ''}
     <p style="font-weight:700;margin:22px 0 6px;">Here's what you told Jenny</p>
     <table style="border-collapse:collapse;margin:0 0 12px;font-size:15px;">${chorusDetails({ ...r, email: '', buyer_name: '' })}</table>
     ${chorusStory(r)}
     <p style="font-size:14px;color:#55556a;margin-top:20px;">You paid ${paidLine(r)}. Want to add or change something? Just reply to this email.</p>
     ${cfg.chorusRefund ? `<p style="font-size:14px;color:#55556a;">${esc(cfg.chorusRefund)}</p>` : ''}`;
  return {
    unsubscribeUrl,
    subject: 'We got your custom chorus request',
    html: layout({ email: r.email, transactional: true, unsubscribeUrl }, 'Your custom chorus request is in.', inner),
    text: `Thank you! Your custom chorus request is in. Jenny will create it and email it to ${r.email}.${cfg.chorusTurnaround ? ` You can expect it ${cfg.chorusTurnaround}.` : ''}\n\nFor: ${r.for_name}\n${r.occasion ? `Occasion: ${r.occasion}\n` : ''}${r.style ? `Style: ${r.style}\n` : ''}\n${r.story}\n\nYou paid ${paidLine(r)}.${cfg.chorusRefund ? `\n\n${cfg.chorusRefund}` : ''}`,
  };
}

/** Heads-up to the site owner (NOTIFY_EMAIL) that someone paid for a custom chorus. */
export function chorusOwnerEmail(r) {
  const admin = `${cfg.baseUrl}/admin`;
  const inner = `<h1 style="margin:0 0 12px;font-size:24px;">New custom chorus request 🎤</h1>
     <p>Paid ${paidLine(r)}. Send the finished chorus to the buyer's email below, then tick "Delivered" in your admin page.</p>
     <table style="border-collapse:collapse;margin:0 0 12px;font-size:15px;">${chorusDetails(r)}</table>
     ${chorusStory(r)}
     <p style="margin:22px 0 0;">${button(admin, 'Open the admin page')}</p>`;
  return {
    subject: `New custom chorus request: ${r.for_name}`,
    html: layout({ email: cfg.notifyEmail, transactional: true, footer: 'Notification from your Jenny Ashby site.' }, `New custom chorus for ${r.for_name}`, inner),
    text: `New custom chorus request (paid ${paidLine(r)})\n\nFor: ${r.for_name}\nBuyer: ${r.buyer_name || '-'} <${r.email}>\nOccasion: ${r.occasion || '-'}\nStyle: ${r.style || '-'}\n\n${r.story}\n\nAdmin: ${admin}`,
  };
}

/** Thank-you to someone who left a tip. `unsubscribeUrl` is set when the tipper is on the list. */
export function tipReceiptEmail(t, { unsubscribeUrl = null } = {}) {
  const inner = `<h1 style="margin:0 0 12px;font-size:24px;">Thank you${t.name ? `, ${esc(t.name)}` : ''} 💛</h1>
     <p>Your <b>${paidLine(t)}</b> tip is in, and it means a lot to Jenny. Thank you for helping keep the music going.</p>
     ${t.message ? `<p style="font-weight:700;margin:22px 0 6px;">Your note to Jenny</p>${chorusStory({ story: t.message })}` : ''}
     <p style="font-size:14px;color:#55556a;margin-top:20px;">A tip is a gift to support Jenny's music. It isn't a purchase, so nothing else is on its way, and it isn't tax-deductible.</p>`;
  return {
    unsubscribeUrl,
    subject: `Thank you for your tip`,
    html: layout({ email: t.email, transactional: true, unsubscribeUrl, footer: `This note was sent to ${t.email} because you left a tip for ${cfg.brand}.` }, 'Thank you for the tip.', inner),
    text: `Thank you${t.name ? `, ${t.name}` : ''}! Your ${paidLine(t)} tip means a lot to Jenny.${t.message ? `\n\nYour note to Jenny:\n${t.message}` : ''}\n\nA tip is a gift to support Jenny's music. It isn't a purchase, so nothing else is on its way, and it isn't tax-deductible.`,
  };
}

/** Heads-up to the site owner (NOTIFY_EMAIL) that someone left a tip. */
export function tipOwnerEmail(t) {
  const admin = `${cfg.baseUrl}/admin`;
  const inner = `<h1 style="margin:0 0 12px;font-size:24px;">New tip 💛</h1>
     <p><b>${paidLine(t)}</b>${t.name ? ` from <b>${esc(t.name)}</b>` : ''}${t.email ? ` (${esc(t.email)})` : ''}.</p>
     ${t.message ? chorusStory({ story: t.message }) : ''}
     <p style="margin:22px 0 0;">${button(admin, 'Open the admin page')}</p>`;
  return {
    subject: `New tip: ${paidLine(t)}${t.name ? ` from ${t.name}` : ''}`,
    html: layout({ email: cfg.notifyEmail, transactional: true, footer: 'Notification from your Jenny Ashby site.' }, `New tip: ${paidLine(t)}`, inner),
    text: `New tip: ${paidLine(t)}${t.name ? ` from ${t.name}` : ''}${t.email ? ` <${t.email}>` : ''}${t.message ? `\n\n${t.message}` : ''}\n\nAdmin: ${admin}`,
  };
}

/**
 * Weekly email for free subscribers. The first song is theirs; each friend who joins through their link unlocks
 * the next one (1 friend for song 2, 2 friends for song 3). Members get the full drop instead (dropEmail).
 */
export function teaserEmail(sub, drop) {
  const l = linksFor(sub);
  const [first, ...rest] = drop.videos;
  const locked = rest.length
    ? `<p><strong>${rest.length} more ${rest.length === 1 ? 'song is' : 'songs are'} waiting:</strong> ${rest.map((_, i) => `${i + 1} friend${i ? 's' : ''} for song ${i + 2}`).join(', ')}. Each friend who joins through your link unlocks another.</p>`
    : '';
  return finish(
    sub,
    `Your free Jenny song this week: ${first.title}`,
    `This week's free song: ${first.title}`,
    `<h1 style="margin:0 0 16px;font-size:24px;">Your free song this week 🎵</h1>
     ${songBlock(first)}
     ${locked}
     <p style="margin:18px 0 8px;">${button(l.unlock, 'Invite friends, unlock more')}</p>
     <p style="margin:8px 0 0;">Or become a member: ${esc(memberPitch())}.<br>${button(l.join, `Become a member · ${priceLabel}/mo`, false)}</p>`,
    `Your free Jenny song this week: ${first.title}\n${videoUrl(first.id)}\n\n${rest.length ? `${rest.length} more waiting: ${rest.map((_, i) => `${i + 1} friend${i ? 's' : ''} for song ${i + 2}`).join(', ')}.\n` : ''}Invite friends, unlock more: ${l.unlock}\nOr become a member (${memberPitch()}): ${l.join}`,
  );
}
