// Adding and removing the store's music from the /admin page (music kept in the store folder on disk).
// When the music lives in a Supabase bucket instead, upload it there: these functions say so and do nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cfg } from './config.js';
import { bucketMode } from './storage.js';
import { AUDIO, IMAGE, cleanName } from '../public/upload-plan.js';

export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const TMP = /\.uploading-[0-9a-f]{8}$/;
const maxBytes = () => cfg.maxStoreFileMb * 1024 * 1024;
const root = () => path.resolve(cfg.storeDir);
const inside = (abs) => abs.startsWith(root() + path.sep);
const needDisk = () => {
  if (bucketMode) throw new UploadError('Your music is kept in a Supabase bucket, so upload it there (see DEPLOY.md, step 9).', 409);
};

/** Where an upload goes: songs/<file>  or  albums/<album>/<file>. Names are cleaned, and the result must stay inside the store folder. */
export function targetFor({ kind, album, name }) {
  const file = cleanName(name);
  if (!file || !(AUDIO.test(file) || IMAGE.test(file))) {
    throw new UploadError('Only audio files (mp3, wav, flac, m4a, aac, ogg, aiff) and cover pictures (jpg, png, webp) can be uploaded.');
  }
  let rel;
  if (kind === 'song') rel = `songs/${file}`;
  else if (kind === 'album') {
    const folder = cleanName(album);
    if (!folder) throw new UploadError('Which album is this file for?');
    rel = `albums/${folder}/${file}`;
  } else throw new UploadError('An upload is either a "song" or part of an "album".');
  const abs = path.resolve(cfg.storeDir, rel);
  if (!inside(abs)) throw new UploadError('That file name is not allowed.');
  return { rel, abs };
}

/**
 * Stream the request body to disk. It goes to a temporary name first and is renamed into place only when the whole file has
 * arrived, so a dropped connection never leaves half a song in the store (and re-uploading replaces a song in one step).
 */
export async function saveUpload(req, target) {
  needDisk();
  const limit = maxBytes();
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new UploadError(`That file is bigger than ${cfg.maxStoreFileMb} MB. Copy it onto the disk another way, or lower its size (an MP3 is usually 3 to 10 MB).`, 413);
  fs.mkdirSync(path.dirname(target.abs), { recursive: true });
  const tmp = `${target.abs}.uploading-${crypto.randomBytes(4).toString('hex')}`;
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > limit) cb(new UploadError(`That file is bigger than ${cfg.maxStoreFileMb} MB.`, 413));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(tmp));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err instanceof UploadError ? err : new UploadError('The upload was interrupted. Please try again.');
  }
  if (size === 0) {
    fs.rmSync(tmp, { force: true });
    throw new UploadError('That file is empty.');
  }
  fs.renameSync(tmp, target.abs); // replaces an existing file of the same name in one step
  return { rel: target.rel, size };
}

// ---------- what is in the store ----------

const readdir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const sizeOf = (p) => fs.statSync(p).size;

/** Everything in the store folder with sizes, plus how much of the disk is used and free. */
export function listFiles() {
  if (bucketMode) return { bucket: cfg.storeBucket };
  const files = {}; // "songs/Alpha.mp3" -> bytes (used by the upload panel to skip what is already there)
  let totalBytes = 0;
  const add = (rel, abs) => { const s = sizeOf(abs); files[rel] = s; totalBytes += s; return s; };

  const songDir = path.join(cfg.storeDir, 'songs');
  const songEntries = readdir(songDir).filter((e) => e.isFile() && !TMP.test(e.name));
  const songs = songEntries
    .filter((e) => AUDIO.test(e.name))
    .sort((a, b) => natural.compare(a.name, b.name))
    .map((e) => {
      const base = e.name.replace(AUDIO, '').toLowerCase();
      const cover = songEntries.find((f) => IMAGE.test(f.name) && f.name.replace(IMAGE, '').toLowerCase() === base);
      const size = add(`songs/${e.name}`, path.join(songDir, e.name));
      if (cover) add(`songs/${cover.name}`, path.join(songDir, cover.name));
      return { name: e.name, size, cover: cover ? cover.name : null };
    });
  for (const e of songEntries) if (IMAGE.test(e.name) && !files[`songs/${e.name}`]) add(`songs/${e.name}`, path.join(songDir, e.name)); // covers with no song yet

  const albums = readdir(path.join(cfg.storeDir, 'albums'))
    .filter((d) => d.isDirectory())
    .sort((a, b) => natural.compare(a.name, b.name))
    .map((d) => {
      const dir = path.join(cfg.storeDir, 'albums', d.name);
      const inner = readdir(dir).filter((e) => e.isFile() && !TMP.test(e.name));
      const tracks = inner.filter((e) => AUDIO.test(e.name)).sort((a, b) => natural.compare(a.name, b.name)).map((e) => ({ name: e.name, size: add(`albums/${d.name}/${e.name}`, path.join(dir, e.name)) }));
      const cover = inner.find((e) => IMAGE.test(e.name));
      if (cover) add(`albums/${d.name}/${cover.name}`, path.join(dir, cover.name));
      return { name: d.name, tracks, cover: cover ? cover.name : null };
    });

  let freeBytes = null;
  try {
    const fsStat = fs.statfsSync(fs.existsSync(cfg.storeDir) ? cfg.storeDir : path.dirname(cfg.storeDir));
    freeBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
  } catch { /* not available on this system */ }

  return { bucket: null, dir: cfg.storeDir, files, songs, albums, totalBytes, freeBytes, maxFileMb: cfg.maxStoreFileMb };
}

/**
 * Remove a song (its audio and cover picture) or a whole album. Only files that are directly inside songs/, or an album folder
 * directly inside albums/, can be removed: nothing outside the store can be touched.
 */
export function deleteFiles({ files, album } = {}) {
  needDisk();
  let removed = 0;
  if (album !== undefined) {
    const folder = cleanName(album);
    if (!folder) throw new UploadError('Which album?');
    const abs = path.resolve(cfg.storeDir, 'albums', folder);
    if (!inside(abs) || path.dirname(abs) !== path.resolve(cfg.storeDir, 'albums')) throw new UploadError('That album name is not allowed.');
    if (fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true, force: true }); removed = 1; }
    return { removed };
  }
  if (!Array.isArray(files) || !files.length || files.length > 20) throw new UploadError('Nothing to remove.');
  for (const rel of files) {
    const m = /^songs\/([^/]+)$/.exec(String(rel));
    if (!m) throw new UploadError('Only files in the songs folder can be removed this way.');
    const { abs } = targetFor({ kind: 'song', name: m[1] });
    if (fs.existsSync(abs)) { fs.rmSync(abs, { force: true }); removed++; }
  }
  return { removed };
}

/** Delete half-finished uploads left behind if the site was restarted in the middle of one. */
export function sweepTemp() {
  if (bucketMode) return;
  const walk = (dir, depth) => {
    for (const e of readdir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && TMP.test(e.name)) fs.rmSync(p, { force: true });
    }
  };
  walk(cfg.storeDir, 0);
}
sweepTemp();

