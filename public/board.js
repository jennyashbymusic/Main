// The public leaderboard, shared by anything that shows standings. Counts only: it never shows who voted.
import { el, shareRow } from '/app.js';

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- The "top N" rule. N is WINNERS_PER_MONTH on the server, sent as `winnersPerMonth` in every vote state, and the server
// decides which songs are inside it (`winning`). Every place that says "top N" gets its words from these three lines, so
// changing the rule to top 5 changes the leaderboard, the cut line and the vote page together. ----
export const spotifyRule = (s) => `The top ${s.winnersPerMonth} songs each month get added to Jenny's Spotify.`;
export const cutLineLabel = (s) => `Spotify cut line · top ${s.winnersPerMonth}`;
export const topBadge = (s) => `Top ${s.winnersPerMonth}`;

// ---- Bars. A bar is a share of the leader's votes, but never scaled to fewer than BAR_FLOOR votes. Otherwise one vote
// would be 100% of the leader's bar (and look like a landslide) while the rest are empty. With the floor, 1 vote is a
// small sliver and bars only become fully leader-relative once the leader reaches BAR_FLOOR votes. A song with at least
// one vote always gets a visible sliver; a song with none gets an empty bar. ----
export const BAR_FLOOR = 10;
export function barPercent(votes, leaderVotes) {
  if (!votes) return 0;
  return Math.min(100, Math.max(4, (votes / Math.max(leaderVotes, BAR_FLOOR)) * 100));
}

/** The share block: the page's link in a box you can copy, plus WhatsApp / X / Facebook / Email (same row as the Invite page). */
export function shareBlock(url) {
  return el('div', { class: 'board-share' },
    el('h3', {}, 'Share the leaderboard'),
    el('p', { class: 'small muted', style: 'margin:0' }, 'Send it to anyone who loves Jenny\'s songs. It is public, no sign-up needed to look.'),
    shareRow(url, {
      text: "Help pick which of Jenny Ashby's songs go on Spotify. Check the leaderboard and vote:",
      subject: 'Vote on which Jenny Ashby songs go on Spotify',
      title: 'Spotify leaderboard',
      inputLabel: 'Link to the leaderboard',
    }));
}

/**
 * `s` is the state from GET /api/vote. Returns the leaderboard card.
 * `footer` is the share block. The page re-draws the card every few seconds, so it builds the block once and hands the same
 * element back each time: that way a "Copied ✓" message or a selected link isn't wiped by a refresh.
 */
export function renderBoard(s, { footer } = {}) {
  const voted = s.leaderboard.filter((r) => r.votes > 0);      // already in rank order (most votes, then the newer song)
  const unvoted = s.leaderboard.filter((r) => r.votes === 0);  // no order yet: listed A to Z, not numbered
  const leaderVotes = voted.length ? voted[0].votes : 0;

  const row = (r) => {
    const ranked = r.votes > 0;
    const medal = r.winning && r.position <= 3 ? ` p${r.position}` : ''; // gold / silver / bronze for the first three places
    return el('li', { class: `board-row${r.winning ? ' win' : ''}${r.mine ? ' mine' : ''}${ranked ? '' : ' unranked'}` },
      ranked ? el('span', { class: `pos${medal}` }, String(r.position)) : el('span', { class: 'pos none', title: 'Not ranked yet: no votes' }, '–'),
      el('a', { class: 'bthumb', href: r.url, target: '_blank', rel: 'noopener', tabindex: '-1', 'aria-hidden': 'true' }, r.thumb ? el('img', { src: r.thumb, alt: '', loading: 'lazy' }) : null),
      el('div', {},
        el('div', { class: 'bname' }, el('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.name)),
        el('div', { class: 'bar', role: 'presentation' }, el('i', { style: `width:${barPercent(r.votes, leaderVotes)}%` }))),
      el('div', { class: 'votecount' }, String(r.votes), el('small', {}, r.votes === 1 ? 'vote' : 'votes')));
  };

  const rows = [];
  voted.forEach((r, i) => {
    rows.push(row(r));
    // The cut line sits after place N, so it only exists once N songs have votes and there is something below it.
    if (i === s.winnersPerMonth - 1 && (i < voted.length - 1 || unvoted.length)) {
      rows.push(el('li', { class: 'cutline', role: 'separator' }, cutLineLabel(s)));
    }
  });
  if (unvoted.length) {
    const open = Math.max(0, s.winnersPerMonth - voted.length);
    rows.push(el('li', { class: 'unranked-head', role: 'separator' },
      'No votes yet',
      el('small', {}, ` · listed A to Z, not ranked${open ? ` · ${open} of the top ${s.winnersPerMonth} spots still open` : ''}`)));
    unvoted.forEach((r) => rows.push(row(r)));
  }

  return el('section', { class: 'card board', id: 'leaderboard' },
    el('div', { class: 'board-head' }, el('h2', {}, `${s.round.label} standings`), el('span', { class: 'live' }, 'Live')),
    el('p', { class: 'small muted', style: 'margin:0 0 8px' },
      s.totals.votes ? `${plural(s.totals.votes, 'vote')} from ${plural(s.totals.voters, 'fan')}` : 'No votes yet. Be the first to vote!',
      ' · Ties go to the newer song.'),
    el('ol', { class: 'board-list' }, rows),
    footer || shareBlock(s.shareUrl || `${location.origin}/leaderboard`));
}
