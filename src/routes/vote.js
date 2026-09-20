import { Router } from 'express';
import { getByToken } from '../db.js';
import { VoteError, ensureRound, stateFor, toggleVote } from '../voting.js';
import { rateLimit } from '../util.js';
import { publicOrigin } from '../origin.js';

export const router = Router();

/** Ballot, live counts and countdown target. Anyone can look; a valid ?t= token adds "your votes". */
router.get('/', async (req, res) => {
  const sub = getByToken(String(req.query.t || ''));
  try {
    res.set('Cache-Control', 'no-store').json({ ...stateFor(await ensureRound(), sub), origin: publicOrigin(req), shareUrl: `${publicOrigin(req)}/leaderboard` });
  } catch (err) {
    console.error('[vote]', err.message); // e.g. the channel's videos couldn't be loaded yet
    res.json({ ready: false });
  }
});

/** Cast or withdraw a vote on one song. Only subscribers (people with a personal link) can vote. */
router.post('/', rateLimit({ windowMs: 10 * 60_000, max: 90 }), async (req, res) => {
  const { t, videoId } = req.body || {};
  const sub = getByToken(String(t || ''));
  if (!sub) return res.status(401).json({ error: 'Join the list free to vote. Enter your email on the home page.' });
  try {
    const round = await ensureRound();
    toggleVote(round, sub, String(videoId || ''));
    res.json(stateFor(round, sub));
  } catch (err) {
    if (err instanceof VoteError) return res.status(err.status).json({ error: err.message });
    console.error('[vote]', err.message);
    res.status(500).json({ error: 'Could not record your vote. Please try again.' });
  }
});
