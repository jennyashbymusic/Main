import cron from 'node-cron';
import { cfg } from './config.js';
import { db, getDrop, insertDrop, isPaid, latestDrop, sentVideoIds } from './db.js';
import { getUploads } from './youtube.js';
import { sendMail } from './mailer.js';
import { dropEmail, teaserEmail } from './emails.js';
import { newExclusiveSince } from './songs.js';

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Choose songs that haven't been sent yet; once the catalog is used up, start a new cycle. */
function pickVideos(all, n) {
  const sent = sentVideoIds();
  let pool = all.filter((v) => !sent.has(v.id));
  if (pool.length < n) {
    const last = new Set((latestDrop()?.videos || []).map((v) => v.id));
    pool = all.filter((v) => !last.has(v.id));
    if (pool.length < n) pool = all;
  }
  if (cfg.pickMode === 'random') pool = shuffle(pool);
  else if (cfg.pickMode === 'oldest') pool = pool.slice().sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  else pool = pool.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return pool.slice(0, n);
}

export async function createDrop() {
  const picked = pickVideos(await getUploads(), cfg.songsPerDrop);
  if (!picked.length) throw new Error('No public videos found on the channel.');
  return insertDrop(picked);
}

let creating = null;
/** The current drop; creates the very first one on demand so the site works before the first Monday. */
export async function ensureDrop() {
  const existing = latestDrop();
  if (existing) return existing;
  creating ??= createDrop().finally(() => {
    creating = null;
  });
  return creating;
}

let sending = false;
export const isSending = () => sending;

/** Email a drop to everyone who hasn't received it yet. Safe to re-run: sends are recorded per subscriber. */
export async function sendDrop(dropId) {
  if (sending) throw new Error('A send is already in progress.');
  sending = true;
  try {
    const drop = getDrop(dropId);
    if (!drop) throw new Error('Drop not found.');
    const recipients = db
      .prepare(
        `SELECT * FROM subscribers
         WHERE unsubscribed = 0
           AND id NOT IN (SELECT subscriber_id FROM drop_sends WHERE drop_id = ?)
           AND (status IN ('member', 'past_due') ${cfg.sendToLeads ? "OR status = 'lead'" : ''})`,
      )
      .all(drop.id);

    // Exclusive songs added since the previous drop are mentioned in the members' email (only members can hear them).
    const previous = db.prepare('SELECT created_at FROM drops WHERE id < ? ORDER BY id DESC LIMIT 1').get(drop.id);
    const early = newExclusiveSince(previous?.created_at || '');

    let sent = 0;
    let failed = 0;
    for (const sub of recipients) {
      try {
        const msg = isPaid(sub) ? dropEmail(sub, drop, undefined, { early }) : teaserEmail(sub, drop);
        await sendMail({ to: sub.email, ...msg });
        db.prepare('INSERT OR IGNORE INTO drop_sends (drop_id, subscriber_id, sent_at) VALUES (?, ?, ?)').run(
          drop.id,
          sub.id,
          new Date().toISOString(),
        );
        sent++;
      } catch (err) {
        failed++;
        console.error(`[send] ${sub.email}: ${err.message}`);
      }
    }
    if (sent > 0) db.prepare('UPDATE drops SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), drop.id);
    console.log(`[send] drop #${drop.id}: ${sent} sent, ${failed} failed, ${recipients.length} eligible`);
    return { dropId: drop.id, sent, failed, eligible: recipients.length };
  } finally {
    sending = false;
  }
}

/**
 * How many weeks of songs are left before the weekly rotation runs out and songs start to repeat.
 * Counts public channel songs (Shorts excluded, as the picker does) that have never been in a drop.
 */
export async function runway() {
  const songs = await getUploads();
  const sent = sentVideoIds();
  const remaining = songs.filter((v) => !sent.has(v.id)).length;
  const perWeek = cfg.songsPerDrop;
  const weeks = Math.floor(remaining / perWeek);
  const warn = weeks < cfg.runwayWarnWeeks;
  return {
    totalSongs: songs.length,
    alreadySent: songs.length - remaining,
    remaining,
    perWeek,
    weeksOfRunway: weeks,
    warnBelowWeeks: cfg.runwayWarnWeeks,
    warn,
    message: warn
      ? `WARNING: only ${remaining} unsent songs left (${weeks} weeks at ${perWeek} a week). Fewer than ${cfg.runwayWarnWeeks} weeks of runway: publish more songs, or the rotation will start repeating.`
      : `OK: ${remaining} unsent songs left (${weeks} weeks at ${perWeek} a week).`,
  };
}

/** Pick fresh songs, then email them. This is what the weekly schedule runs. */
export async function runWeeklyDrop() {
  const drop = await createDrop();
  runway().then((r) => r.warn && console.warn(`[runway] ${r.message}`)).catch(() => {}); // a heads-up in the server log every Monday
  return sendDrop(drop.id);
}

export function startScheduler() {
  if (!cron.validate(cfg.sendCron)) {
    console.error(`[cron] Invalid SEND_CRON "${cfg.sendCron}" — weekly send is NOT scheduled.`);
    return;
  }
  cron.schedule(
    cfg.sendCron,
    () => runWeeklyDrop().catch((err) => console.error('[cron] weekly drop failed:', err.message)),
    { timezone: cfg.timezone },
  );
  console.log(`[cron] weekly drop scheduled: "${cfg.sendCron}" (${cfg.timezone})`);
}
