// Shared by the admin upload panel (in the browser) and the server (src/storeFiles.js), so both apply the SAME naming rules.
// No page or server code in here: just plain functions.

export const AUDIO = /\.(mp3|wav|flac|m4a|aac|ogg|aiff?)$/i;
export const IMAGE = /\.(jpe?g|png|webp)$/i;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** One file or folder name, made safe: no slashes or other path characters, no control characters, no leading dots. */
export function cleanName(name, max = 150) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .trim()
    .replace(/^[.\s]+/, '') // leading dots (and any spaces among them), so "  .hidden.mp3" and ". . x.mp3" lose them too
    .trim()
    .slice(0, max);
}

/**
 * Turn the files someone picked or dropped into upload jobs.
 *   items:    [{ file, path }] where path is "Song.mp3" (a loose file) or "Album Name/01 - Track.mp3" (from a folder).
 *   existing: { "songs/Alpha.mp3": 4123456, ... } what is already in the store (name -> size), so a re-run skips what is there.
 *   maxBytes: the biggest single file the server accepts.
 * A file inside a folder belongs to the album named after its folder (the folder directly above the file); a loose file is a song.
 */
export function planUploads(items, existing = {}, maxBytes = Infinity) {
  const jobs = [];
  const ignored = [];
  for (const it of items) {
    const parts = String(it.path).split('/').filter(Boolean);
    const name = cleanName(parts.at(-1));
    if (!name || !(AUDIO.test(name) || IMAGE.test(name))) { ignored.push({ path: it.path }); continue; }
    const album = parts.length >= 2 ? cleanName(parts.at(-2)) : '';
    const kind = album ? 'album' : 'song';
    const rel = album ? `albums/${album}/${name}` : `songs/${name}`;
    const size = it.file.size;
    const status = size > maxBytes ? 'too-big' : size === 0 ? 'empty' : existing[rel] === size ? 'exists' : 'todo';
    jobs.push({ file: it.file, kind, album, name, rel, size, status });
  }
  jobs.sort((a, b) => natural.compare(a.rel, b.rel));
  return { jobs, ignored };
}
