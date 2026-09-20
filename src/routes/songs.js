import { Router } from 'express';
import { getByToken, isPaid } from '../db.js';
import { audioPath, getSong, listVisible, visibleTo } from '../songs.js';

export const router = Router(); // mounted at /api

/** Exclusive songs this viewer may see. Members (a valid token that is a paying member) see everything; others see only what has gone public. */
router.get('/songs', (req, res) => {
  const sub = getByToken(String(req.query.t || ''));
  const member = Boolean(isPaid(sub));
  res.set('Cache-Control', 'no-store').json({ member, songs: listVisible(member) });
});

/**
 * Stream a song's audio (supports seeking). The same rule as the list applies, checked again here, so a guessed
 * URL or a shared link from a member can't play a song the viewer isn't entitled to. Not-allowed looks like not-found.
 */
router.get('/songs/:slug/audio', (req, res) => {
  const sub = getByToken(String(req.query.t || ''));
  const song = getSong(req.params.slug);
  if (!song || !visibleTo(song, Boolean(isPaid(sub)))) return res.status(404).end();
  const file = audioPath(song);
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'private, no-store').sendFile(file); // sendFile handles Range requests for the audio player
});
