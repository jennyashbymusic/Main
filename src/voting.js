// Monthly vote: subscribers pick which songs get added to Jenny's Spotify. One round per calendar month
// (in TIMEZONE). When a month ends the top songs win, and the next round opens straight away.
import cron from 'node-cron';
import { cfg } from './config.js';
import { db, isPaid } from './db.js';
import { getUploads } from './youtube.js';

export class VoteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- calendar months in the configured timezone ----------

/** How far the timezone is ahead of UTC at this instant, in ms (handles daylight saving). */
function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const n = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - utcMs;
}

/** The UTC instant at which the 1st of `month` (1-12) begins in `tz`. */
function monthStartUtc(year, month, tz) {
  const guess = Date.UTC(year, month - 1, 1);
  const first = tzOffsetMs(guess, tz);
  let utc = guess - first;
  const second = tzOffsetMs(utc, tz); // the offset can differ if a clock change falls in between
  if (second !== first) utc = guess - second;
  return utc;
}

export function periodFor(nowMs = Date.now(), tz = cfg.timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' }).formatToParts(new Date(nowMs));
  const year = Number(parts.find((p) => p.type === 'year').value);
  const month = Number(parts.find((p) => p.type === 'month').value);
  return {
    period: `${year}-${String(month).padStart(2, '0')}`,
    label: new Date(Date.UTC(year, month - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    startsAt: monthStartUtc(year, month, tz),
    endsAt: month === 12 ? monthStartUtc(year + 1, 1, tz) : monthStartUtc(year, month + 1, tz),
  };
}

const labelOf = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** "You Killed Our Love 💔 | Jenny Ashby" -> "You Killed Our Love": the name people see on the ballot. */
export function songName(title) {
  const artist = cfg.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = title
    .split('|')[0]
    .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
    .replace(new RegExp(`\\s*[-–—]\\s*${artist}\\b.*$`, 'i'), '') // "Song — Jenny Ashby" and "Song — Jenny Ashby (Official Duet)"
    .replace(new RegExp(`^\\s*${artist}\\s*[-–—:]\\s*`, 'i'), '') // "Jenny Ashby - Song"
    .replace(/\s+/g, ' ')
    .replace(/^["“”]+|["“”]+$/g, '') // a title wrapped in quotes
    .trim();
  return name || title;
}

/** Two uploads of the same song (an older version, a re-post) share this key, so a ballot only ever lists the song once. */
const songKey = (title) => songName(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ---------- rounds ----------

// Ballot names are derived from the saved video title each time, so improvements to songName() also fix rounds already created.
const parseRound = (row) =>
  row && {
    ...row,
    candidates: JSON.parse(row.candidates).map((c) => ({ ...c, name: songName(c.title) })),
    winners: row.winners ? JSON.parse(row.winners) : null,
  };

const roundByPeriod = (period) => parseRound(db.prepare('SELECT * FROM vote_rounds WHERE period = ?').get(period));
export const roundById = (id) => parseRound(db.prepare('SELECT * FROM vote_rounds WHERE id = ?').get(id));

function tallies(roundId) {
  const counts = new Map();
  for (const r of db.prepare('SELECT video_id, COUNT(*) AS n FROM votes WHERE round_id = ? GROUP BY video_id').all(roundId)) {
    counts.set(r.video_id, r.n);
  }
  return counts;
}

/**
 * Rank the ballot: most votes first. Songs tied on one or more votes: the newer song wins. Songs with no votes are not
 * really ranked at all (there is no order to show yet), so they are simply listed A to Z.
 */
function ranked(round) {
  const counts = tallies(round.id);
  return round.candidates
    .map((c) => ({ ...c, votes: counts.get(c.id) || 0 }))
    .sort((a, b) => b.votes - a.votes
      || (a.votes > 0 ? b.publishedAt.localeCompare(a.publishedAt) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
}

/**
 * The songs that win if the round closed right now: the top WINNERS_PER_MONTH, and only songs with at least one vote.
 * This is the ONE definition of "top N". The month-end result, the leaderboard's cut line and gold rows, and the vote
 * page's "Top N" badges all read it (through `winning` on each song and `winnersPerMonth` in the state below).
 */
function winning(round) {
  return ranked(round).filter((c) => c.votes > 0).slice(0, cfg.winnersPerMonth);
}

/** Close every round whose month has ended: the top songs (with at least one vote) win. */
export function finalizeDue(nowMs = Date.now()) {
  const due = db.prepare('SELECT * FROM vote_rounds WHERE finalized_at IS NULL AND ends_at <= ?').all(new Date(nowMs).toISOString());
  for (const row of due) {
    const round = parseRound(row);
    const winners = winning(round)
      .map((c, i) => ({ id: c.id, name: c.name, title: c.title, votes: c.votes, rank: i + 1 }));
    db.prepare('UPDATE vote_rounds SET winners = ?, finalized_at = ? WHERE id = ?').run(
      JSON.stringify(winners), new Date(nowMs).toISOString(), round.id,
    );
    console.log(`[vote] ${round.period} closed. Winners: ${winners.map((w) => `${w.name} (${w.votes})`).join(', ') || 'none (no votes)'}`);
  }
}

/** Uploads that may go on a ballot, newest first. Songs that already won a previous month are already on Spotify, so they stay off. */
function eligibleUploads(uploads) {
  const won = new Set();
  for (const row of db.prepare('SELECT winners FROM vote_rounds WHERE winners IS NOT NULL').all()) {
    for (const w of JSON.parse(row.winners)) won.add(w.id);
  }
  let pool = uploads.filter((v) => !won.has(v.id));
  if (pool.length < 2) pool = uploads; // everything has won once: start over
  const seen = new Set();
  return pool
    .slice()
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter((v) => { const k = songKey(v.title); if (seen.has(k)) return false; seen.add(k); return true; }); // newest upload of each song
}
const toCandidate = (v) => ({ id: v.id, name: songName(v.title), title: v.title, thumb: v.thumb, publishedAt: v.publishedAt });

async function createRound({ period, startsAt, endsAt }) {
  const uploads = await getUploads();
  const candidates = eligibleUploads(uploads).slice(0, cfg.voteCandidates).map(toCandidate);
  if (candidates.length < 2) throw new Error('Not enough videos on the channel to build a ballot.');
  db.prepare('INSERT OR IGNORE INTO vote_rounds (period, starts_at, ends_at, candidates) VALUES (?, ?, ?, ?)').run(
    period, new Date(startsAt).toISOString(), new Date(endsAt).toISOString(), JSON.stringify(candidates),
  );
  return roundByPeriod(period);
}

// If VOTE_CANDIDATES was raised after this month's round was built (10 -> 12), the open round gets the next-newest songs added
// to the end of its ballot. Songs already on it, their order and everybody's votes are left exactly as they were.
const topUps = new Map(); // round id -> the attempt in progress (so two visitors at once share one)
const lastTopUp = new Map(); // round id -> when we last tried, so a channel with nothing new to add isn't re-fetched on every page view
function topUpRound(round, nowMs) {
  if (round.finalized_at || Date.parse(round.ends_at) <= nowMs || round.candidates.length >= cfg.voteCandidates) return round;
  if (topUps.has(round.id)) return topUps.get(round.id);
  if (nowMs - (lastTopUp.get(round.id) || 0) < 10 * 60_000) return round;
  lastTopUp.set(round.id, nowMs);
  const attempt = (async () => {
    try {
      const uploads = await getUploads();
      const row = db.prepare('SELECT candidates FROM vote_rounds WHERE id = ? AND finalized_at IS NULL').get(round.id);
      if (!row) return round;
      const list = JSON.parse(row.candidates);
      const have = new Set(list.map((c) => c.id));
      const haveSongs = new Set(list.map((c) => songKey(c.title)));
      const extra = eligibleUploads(uploads).filter((v) => !have.has(v.id) && !haveSongs.has(songKey(v.title))).slice(0, cfg.voteCandidates - list.length).map(toCandidate);
      if (!extra.length) return round;
      db.prepare('UPDATE vote_rounds SET candidates = ? WHERE id = ? AND finalized_at IS NULL').run(JSON.stringify([...list, ...extra]), round.id);
      console.log(`[vote] ${round.period}: added ${extra.length} song(s) to this month's ballot: ${extra.map((c) => songName(c.title)).join(', ')}`);
      return roundById(round.id);
    } catch (err) {
      console.error('[vote] could not add songs to this month\'s ballot:', err.message);
      return round;
    } finally {
      topUps.delete(round.id);
    }
  })();
  topUps.set(round.id, attempt);
  return attempt;
}

let creating = null;
/** This month's round, created on first use. Also closes any earlier rounds that have ended. */
export async function ensureRound(nowMs = Date.now()) {
  finalizeDue(nowMs);
  const info = periodFor(nowMs);
  const existing = roundByPeriod(info.period);
  if (existing) return topUpRound(existing, nowMs);
  creating ??= createRound(info).finally(() => {
    creating = null;
  });
  return creating;
}

export const allowedVotes = (sub) => (isPaid(sub) ? cfg.votesMember : cfg.votesFree);

const votesUsed = (roundId, subId) =>
  db.prepare('SELECT COUNT(*) AS n FROM votes WHERE round_id = ? AND subscriber_id = ?').get(roundId, subId).n;

/** Cast or withdraw one vote. Everything from the checks to the write is synchronous, so two clicks can't overspend. */
export function toggleVote(round, sub, videoId, nowMs = Date.now()) {
  if (Date.parse(round.ends_at) <= nowMs) throw new VoteError('Voting for this round has closed.', 409);
  if (!round.candidates.some((c) => c.id === videoId)) throw new VoteError('That song is not on the ballot.');
  const mine = db.prepare('SELECT 1 FROM votes WHERE round_id = ? AND subscriber_id = ? AND video_id = ?').get(round.id, sub.id, videoId);
  if (mine) {
    db.prepare('DELETE FROM votes WHERE round_id = ? AND subscriber_id = ? AND video_id = ?').run(round.id, sub.id, videoId);
    return;
  }
  if (votesUsed(round.id, sub.id) >= allowedVotes(sub)) {
    throw new VoteError('You have used all your votes. Tap a song you voted for to take that vote back.', 409);
  }
  db.prepare('INSERT INTO votes (round_id, subscriber_id, video_id, created_at) VALUES (?, ?, ?, ?)').run(
    round.id, sub.id, videoId, new Date(nowMs).toISOString(),
  );
}

/** Everything the vote page needs. Nothing here identifies other voters. */
export function stateFor(round, sub, nowMs = Date.now()) {
  const mineIds = new Set(
    sub ? db.prepare('SELECT video_id FROM votes WHERE round_id = ? AND subscriber_id = ?').all(round.id, sub.id).map((r) => r.video_id) : [],
  );
  const previous = parseRound(db.prepare('SELECT * FROM vote_rounds WHERE finalized_at IS NOT NULL AND id != ? ORDER BY id DESC LIMIT 1').get(round.id));
  const allowed = sub ? allowedVotes(sub) : 0;
  const counts = tallies(round.id);
  const winIds = new Set(winning(round).map((c) => c.id));
  const totalVotes = [...counts.values()].reduce((a, b) => a + b, 0);
  const voters = db.prepare('SELECT COUNT(DISTINCT subscriber_id) AS n FROM votes WHERE round_id = ?').get(round.id).n;
  return {
    ready: true,
    now: new Date(nowMs).toISOString(),
    round: { period: round.period, label: labelOf(round.period), endsAt: round.ends_at, open: Date.parse(round.ends_at) > nowMs },
    winnersPerMonth: cfg.winnersPerMonth,
    ballot: round.candidates.map((c) => ({
      id: c.id, name: c.name, thumb: c.thumb, url: `https://www.youtube.com/watch?v=${c.id}`,
      votes: counts.get(c.id) || 0, mine: mineIds.has(c.id), winning: winIds.has(c.id),
    })),
    // Public standings: same ranking the month-end winners use. Counts only, never who voted. Songs with no votes have
    // no position (null): they are listed A to Z rather than numbered, because there is no order between them yet.
    leaderboard: ranked(round).map((c, i) => ({
      position: c.votes > 0 ? i + 1 : null, id: c.id, name: c.name, thumb: c.thumb, url: `https://www.youtube.com/watch?v=${c.id}`,
      votes: c.votes, mine: mineIds.has(c.id), winning: winIds.has(c.id),
    })),
    totals: { votes: totalVotes, voters },
    you: sub && { paid: isPaid(sub), allowed, used: mineIds.size, left: Math.max(0, allowed - mineIds.size) },
    memberVotes: cfg.votesMember,
    price: `$${(cfg.priceCents / 100).toFixed(cfg.priceCents % 100 ? 2 : 0)}`,
    spotifyUrl: cfg.spotifyPlaylistUrl || null,
    previous: previous && {
      label: labelOf(previous.period),
      winners: previous.winners || [],
      onSpotify: Boolean(previous.spotify_added_at),
    },
  };
}

// ---------- admin ----------

export function adminSummary() {
  const rows = db.prepare('SELECT * FROM vote_rounds ORDER BY id DESC LIMIT 6').all().map(parseRound);
  return rows.map((r) => ({
    id: r.id,
    label: labelOf(r.period),
    endsAt: r.ends_at,
    closed: Boolean(r.finalized_at),
    onSpotify: Boolean(r.spotify_added_at),
    voters: db.prepare('SELECT COUNT(DISTINCT subscriber_id) AS n FROM votes WHERE round_id = ?').get(r.id).n,
    // Closed rounds show their final winners; the open round shows the live top of the ballot.
    top: (r.winners || winning(r)).map((c) => ({
      name: c.name, votes: c.votes,
      spotifySearch: `https://open.spotify.com/search/${encodeURIComponent(`${c.name} Jenny Ashby`)}`,
    })),
  }));
}

export function setSpotifyAdded(roundId, added) {
  const round = roundById(roundId);
  if (!round) throw new Error('Round not found.');
  if (!round.finalized_at) throw new Error('This round is still open. Winners are set when the month ends.');
  db.prepare('UPDATE vote_rounds SET spotify_added_at = ? WHERE id = ?').run(added ? new Date().toISOString() : null, roundId);
}

/** On the 1st just after midnight: close last month, announce winners on the page, and open the new ballot. */
export function startVotingScheduler() {
  cron.schedule('5 0 1 * *', () => ensureRound().catch((err) => console.error('[vote] new round failed:', err.message)), {
    timezone: cfg.timezone,
  });
}
