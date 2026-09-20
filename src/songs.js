// Songs the club serves itself, and who may see them. Songs that already live on the YouTube channel are read from the
// channel as before; this table is for exclusive ones (uploaded audio, or a video that isn't public yet).
//
//   access 'public'         everyone
//   access 'members_early'  members now; everyone else only once public_release_at has passed
//   access 'members_only'   members only, always
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { db } from './db.js';

export const ACCESS = ['public', 'members_early', 'members_only'];
export const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg)$/i;

export class SongError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The single rule for who can see a song. Everything that shows or plays a song goes through this. */
export function visibleTo(song, isMember, nowMs = Date.now()) {
  if (song.access === 'public') return true;
  if (isMember) return true;
  if (song.access === 'members_early') return Boolean(song.public_release_at) && Date.parse(song.public_release_at) <= nowMs;
  return false; // members_only
}

const slugify = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80).replace(/^-+|-+$/g, '');
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** Validate what a client (the admin page or your uploader script) sends for one song. */
export function parseSong(body = {}) {
  const title = String(body.title ?? '').trim().slice(0, 150);
  if (!title) throw new SongError('A song needs a title.');
  const slug = String(body.slug || slugify(title)).toLowerCase();
  if (!SLUG_RE.test(slug)) throw new SongError('slug must be lowercase letters, numbers and dashes (for example "paper-saints").');

  const access = body.access ?? 'public';
  if (!ACCESS.includes(access)) throw new SongError(`access must be one of: ${ACCESS.join(', ')}.`);

  let publicReleaseAt = null;
  if (body.public_release_at) {
    const when = Date.parse(body.public_release_at);
    if (Number.isNaN(when)) throw new SongError('public_release_at must be a date/time such as 2026-10-15T09:00:00Z.');
    publicReleaseAt = new Date(when).toISOString();
  }
  if (access === 'members_early' && !publicReleaseAt) {
    throw new SongError('members_early songs need a public_release_at date: it is when everyone else gets to see the song.');
  }
  if (access !== 'members_early') publicReleaseAt = null; // only early-access songs have a release date

  const youtubeVideoId = body.youtube_video_id ? String(body.youtube_video_id).trim() : null;
  if (youtubeVideoId && !/^[\w-]{11}$/.test(youtubeVideoId)) throw new SongError('youtube_video_id must be the 11-character video ID.');
  const thumb = body.thumb ? String(body.thumb).trim().slice(0, 500) : null;
  if (thumb && !/^https?:\/\//i.test(thumb)) throw new SongError('thumb must be an http(s) image URL.');

  return { slug, title, access, publicReleaseAt, youtubeVideoId, thumb };
}

export const getSong = (slug) => db.prepare('SELECT * FROM songs WHERE slug = ?').get(String(slug));

/** Create or update by slug. Uploaded audio is kept when only the details change. */
export function upsertSong(body) {
  const s = parseSong(body);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO songs (slug, title, access, public_release_at, youtube_video_id, thumb, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title = excluded.title, access = excluded.access, public_release_at = excluded.public_release_at,
       youtube_video_id = excluded.youtube_video_id, thumb = excluded.thumb, updated_at = excluded.updated_at`,
  ).run(s.slug, s.title, s.access, s.publicReleaseAt, s.youtubeVideoId, s.thumb, now, now);
  return getSong(s.slug);
}

export function deleteSong(slug) {
  const song = getSong(slug);
  if (!song) throw new SongError('Song not found.', 404);
  if (song.audio_file) fs.rmSync(path.join(cfg.membersAudioDir, song.audio_file), { force: true });
  db.prepare('DELETE FROM songs WHERE slug = ?').run(song.slug);
}

/** Store an uploaded audio file for a song (replacing any earlier one). `buffer` is the raw file. */
export function saveAudio(slug, filename, buffer) {
  const song = getSong(slug);
  if (!song) throw new SongError('Create the song first (POST /admin/api/songs), then upload its audio.', 404);
  const ext = (String(filename || '').match(AUDIO_EXT) || [])[0]?.toLowerCase();
  if (!ext) throw new SongError('Upload an audio file: .mp3, .m4a, .aac, .wav, .flac or .ogg (pass ?filename=song.mp3).');
  if (!buffer?.length) throw new SongError('The upload was empty.');
  fs.mkdirSync(cfg.membersAudioDir, { recursive: true });
  const file = `${song.slug}${ext}`;
  if (song.audio_file && song.audio_file !== file) fs.rmSync(path.join(cfg.membersAudioDir, song.audio_file), { force: true });
  fs.writeFileSync(path.join(cfg.membersAudioDir, file), buffer);
  db.prepare('UPDATE songs SET audio_file = ?, updated_at = ? WHERE slug = ?').run(file, new Date().toISOString(), song.slug);
  return getSong(song.slug);
}

/** Absolute path of a song's audio inside the private folder, or null. */
export function audioPath(song) {
  if (!song?.audio_file) return null;
  const root = path.resolve(cfg.membersAudioDir);
  const full = path.resolve(root, song.audio_file);
  return full.startsWith(root + path.sep) && fs.existsSync(full) ? full : null;
}

/** How a song is described to the browser. Never includes file paths. */
export function publicShape(song, nowMs = Date.now()) {
  return {
    slug: song.slug,
    title: song.title,
    access: song.access,
    publicReleaseAt: song.public_release_at,
    isPublicNow: visibleTo(song, false, nowMs), // true once everyone can see it
    thumb: song.thumb,
    youtubeUrl: song.youtube_video_id ? `https://www.youtube.com/watch?v=${song.youtube_video_id}` : null,
    youtubeId: song.youtube_video_id,
    hasAudio: Boolean(song.audio_file),
    createdAt: song.created_at,
  };
}

/** The songs this viewer is allowed to see, newest first. */
export function listVisible(isMember, nowMs = Date.now()) {
  return db.prepare('SELECT * FROM songs ORDER BY id DESC').all().filter((s) => visibleTo(s, isMember, nowMs)).map((s) => publicShape(s, nowMs));
}

export const listAll = () => db.prepare('SELECT * FROM songs ORDER BY id DESC').all();

export const exclusiveCount = () => db.prepare("SELECT COUNT(*) AS n FROM songs WHERE access != 'public'").get().n;

/** True once there are enough exclusive songs to honestly advertise "new songs before they go public". */
export const earlyAccessLive = () => exclusiveCount() >= cfg.earlyAccessMinSongs;

/** Exclusive songs added since `sinceIso` (used to mention new early-access songs in the members' weekly email). */
export function newExclusiveSince(sinceIso = '') {
  return db
    .prepare("SELECT * FROM songs WHERE access != 'public' AND created_at > ? ORDER BY id DESC LIMIT 5")
    .all(sinceIso)
    .map((s) => publicShape(s));
}
