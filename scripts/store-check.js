// Is the music store's storage set up right?
//   npm run store-check
// Connects to your Supabase bucket (or looks at the store folder), lists what is in it, and tests a real download link.
// It says in plain words what is wrong and how to fix it. It never prints your keys.
import { cfg } from '../src/config.js';
import { bucketMode, fetchObject, listBucketRoot, refreshStore, signedUrl, snapshotInfo } from '../src/storage.js';
import { scanCatalog } from '../src/store.js';

const ok = (text) => console.log(`  ✓ ${text}`);
const bad = (text, fix) => { console.log(`  ✗ ${text}`); if (fix) console.log(`      FIX: ${fix}`); problems++; };
const warn = (text, fix) => { console.log(`  – ${text}`); if (fix) console.log(`      TIP: ${fix}`); };
let problems = 0;

console.log('\nMusic store check\n');

if (!bucketMode) {
  console.log(`Storage: a folder on disk (${cfg.storeDir})`);
  const { songs, albums } = scanCatalog();
  ok(`${songs.length} song${songs.length === 1 ? '' : 's'} and ${albums.length} album${albums.length === 1 ? '' : 's'} found`);
  if (cfg.supabaseUrl && !cfg.supabaseKey) bad('SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is empty', 'Fill in SUPABASE_SERVICE_ROLE_KEY (Supabase > Project Settings > API), or clear SUPABASE_URL.');
  else if (!cfg.supabaseUrl && cfg.supabaseKey) bad('SUPABASE_SERVICE_ROLE_KEY is set but SUPABASE_URL is empty', 'Fill in SUPABASE_URL (Supabase > Project Settings > API > Project URL).');
  else console.log('\nTo keep the music in a Supabase bucket instead, fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see DEPLOY.md).');
  console.log('');
  process.exit(problems ? 1 : 0);
}

console.log(`Storage: Supabase bucket "${cfg.storeBucket}" at ${cfg.supabaseUrl}\n`);
await refreshStore(true);
const info = snapshotInfo();

if (info.lastError) {
  const e = info.lastError;
  if (/HTTP 401|HTTP 403|Invalid|JWT|apikey/i.test(e)) bad('Supabase refused the key.', 'Copy the "service_role" key (or the new "secret" key) again from Supabase > Project Settings > API. Make sure SUPABASE_URL is from the SAME project.');
  else if (/HTTP 404|not found|Bucket/i.test(e)) bad(`The bucket "${cfg.storeBucket}" was not found.`, `In Supabase > Storage, create a bucket with exactly that name (or set SUPABASE_STORE_BUCKET to the name you used). Keep it PRIVATE.`);
  else if (/fetch failed|ENOTFOUND|ECONN|timeout|aborted/i.test(e)) bad('Could not reach Supabase.', 'Check SUPABASE_URL (it looks like https://abcdefgh.supabase.co) and your internet connection. A free project that was paused needs to be restored in the Supabase dashboard.');
  else bad(`Supabase said: ${e}`);
  console.log('');
  process.exit(1);
}
ok('Connected, the key works, and the bucket exists');

const { songs, albums } = scanCatalog();
ok(`${songs.length} song${songs.length === 1 ? '' : 's'} found in songs/`);
ok(`${albums.length} album${albums.length === 1 ? '' : 's'} found in albums/ (${albums.reduce((n, a) => n + a.tracks.length, 0)} tracks)`);
if (!songs.length && !albums.length) warn('The store is empty.', 'Upload audio into a folder named "songs" (one file per song) or "albums/Album Name/" (the tracks inside). File names become the titles.');

// common mistakes
try {
  const loose = (await listBucketRoot()).filter((i) => i.id != null);
  if (loose.length) warn(`${loose.length} file${loose.length === 1 ? '' : 's'} sit loose at the top of the bucket and will be ignored (${loose.slice(0, 3).map((i) => i.name).join(', ')}${loose.length > 3 ? ', ...' : ''})`, 'Move them into the "songs" folder, or into "albums/Album Name/".');
  const otherFolders = (await listBucketRoot()).filter((i) => i.id == null && !['songs', 'albums'].includes(i.name));
  if (otherFolders.length) warn(`Folders the store does not read: ${otherFolders.map((i) => i.name).join(', ')}`, 'Only "songs" and "albums" are used.');
} catch { /* the checks above already passed; this one is only advice */ }
for (const a of albums) if (!a.coverRel) warn(`Album "${a.title}" has no cover image`, 'Add cover.jpg inside that album folder (optional).');

// a real download link, end to end
const sample = songs[0]?.rel || (albums[0] && `${albums[0].rel}/${albums[0].tracks[0].file}`);
if (sample) {
  try {
    const url = await signedUrl(sample, 'test.mp3');
    const res = await fetch(url, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(20_000) });
    if (res.ok || res.status === 206) ok(`A download link for "${sample.split('/').pop()}" works`);
    else bad(`A signed download link was refused (HTTP ${res.status})`, 'Check the bucket is not blocked by a policy, and that the file really exists.');
    await res.body?.cancel();
    const direct = await fetchObject(sample);
    ok('The site can read files directly (used for covers and album zips)');
    await direct.body?.cancel();
  } catch (err) {
    bad(`Could not fetch a file: ${err.message}`);
  }
} else {
  console.log('  (skipping the download test: there is no music in the bucket yet)');
}

console.log(problems ? `\n✗ ${problems} problem${problems === 1 ? '' : 's'} to fix.\n` : '\n✓ The store storage is set up correctly.\n');
process.exit(problems ? 1 : 0);
