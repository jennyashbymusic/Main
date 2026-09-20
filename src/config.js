import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ quiet: true });

const env = (key, fallback = '') => (process.env[key] ?? fallback).toString().trim();
const flag = (key, fallback) => {
  const v = env(key);
  return v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const port = Number(env('PORT', '3000'));

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(projectRoot, env('DATA_DIR', 'data'));

// The public address of the site. Every link we build (referral links, links in emails, Stripe return pages) starts from it.
// Locally it can default to http://localhost, but a production server must be told its real address: a referral link that
// points at localhost is useless to the friend who receives it. (Render sets RENDER=true on its servers.)
// Hosting platforms announce themselves with their own variables, so the checks below switch on for them too.
const HOST_SIGNALS = ['RENDER', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'FLY_APP_NAME', 'DYNO', 'VERCEL', 'K_SERVICE'];
const production = env('NODE_ENV') === 'production' || HOST_SIGNALS.some((k) => Boolean(process.env[k]));
export const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(String(url));
// NEXT_PUBLIC_SITE_URL is accepted as an alias. RENDER_EXTERNAL_URL is the address Render gives the service (https://name.onrender.com),
// so a first deploy on Render works before a custom domain is set. Set BASE_URL to your real domain when you have one.
const siteUrl = env('BASE_URL') || env('NEXT_PUBLIC_SITE_URL') || env('RENDER_EXTERNAL_URL');
if (production) {
  if (!siteUrl) {
    throw new Error('BASE_URL is not set. In production the site must know its public address (for example https://yourdomain.com) so referral and email links work. Set BASE_URL (or NEXT_PUBLIC_SITE_URL) and restart.');
  }
  if (isLocalUrl(siteUrl)) {
    throw new Error(`BASE_URL is "${siteUrl}", which is a local address. In production it must be your public https address.`);
  }
  if (!/^https:\/\//i.test(siteUrl)) console.warn(`[config] BASE_URL "${siteUrl}" is not https. Stripe and most browsers expect https in production.`);
}

// The tip jar (/tip-jar). Quick-pick amounts are dollars (TIP_AMOUNTS="3,5,10,25"); the smallest and biggest tip are in cents.
const tipMinCents = Number(env('TIP_MIN_CENTS', '100'));
const tipMaxCents = Number(env('TIP_MAX_CENTS', '100000'));
const tipPresetsCents = env('TIP_AMOUNTS', '3,5,10,25')
  .split(',')
  .map((v) => Math.round(Number(v) * 100))
  .filter((c) => Number.isInteger(c) && c >= tipMinCents && c <= tipMaxCents);

export const cfg = {
  port,
  production,
  // Where the database and the email previews (outbox/) live. Point this at a persistent disk when hosting.
  dataDir,
  baseUrl: (siteUrl || `http://localhost:${port}`).replace(/\/+$/, ''),
  trustProxy: flag('TRUST_PROXY', false),

  // Members-only and early-access songs (files uploaded by your watcher script). Keep on a persistent disk when hosting.
  membersAudioDir: path.resolve(projectRoot, env('MEMBERS_AUDIO_DIR', path.join(dataDir, 'members-audio'))),
  maxAudioMb: Number(env('MAX_AUDIO_MB', '100')),
  // "New songs before they go public" is only advertised once at least this many songs have access other than 'public'.
  earlyAccessMinSongs: Number(env('EARLY_ACCESS_MIN_SONGS', '5')),
  // The weekly rotation warns when fewer than this many weeks of unsent songs remain.
  runwayWarnWeeks: Number(env('RUNWAY_WARN_WEEKS', '8')),
  // Friends only count toward a referral once they confirm their email. Defaults to on when real email is set up,
  // and off locally (where no email is actually delivered, so nobody could click the confirmation link).
  requireEmailConfirmation: flag('REQUIRE_EMAIL_CONFIRMATION', Boolean(env('SMTP_HOST'))),

  brand: env('BRAND_NAME', 'Jenny Ashby'),
  channelUrl: env('YOUTUBE_CHANNEL_URL'),
  // Video shown next to the signup form (the ID after "v=" in a YouTube link). Set it blank to use the channel's newest upload instead.
  featuredVideoId: process.env.FEATURED_VIDEO_ID === undefined ? 'm6McIfkZy40' : env('FEATURED_VIDEO_ID'),

  // Membership
  priceCents: Number(env('PRICE_CENTS', '500')),
  currency: env('CURRENCY', 'usd').toLowerCase(),
  stripeKey: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  stripePriceId: env('STRIPE_PRICE_ID'), // optional: otherwise a $5/mo price is created inline at checkout

  // Systeme.io (contact list + tags)
  systemeKey: env('SYSTEME_API_KEY'),
  tagLead: env('SYSTEME_TAG_LEAD', 'Lead'),
  tagMember: env('SYSTEME_TAG_MEMBER', 'Member'),
  tagCancelled: env('SYSTEME_TAG_CANCELLED', 'Cancelled'),
  tagUnsubscribed: env('SYSTEME_TAG_UNSUBSCRIBED', 'Unsubscribed'),

  // YouTube Data API
  youtubeKey: env('YOUTUBE_API_KEY'), // optional: without it the channel's public feed (newest 15 videos) is used
  youtubeChannelId: env('YOUTUBE_CHANNEL_ID', 'UCyEjtqfosikE2LI4SClZBog'), // Jenny Ashby (@JennyAshbyMusic)
  includeShorts: flag('INCLUDE_SHORTS', false),
  youtubeMaxVideos: Number(env('YOUTUBE_MAX_VIDEOS', '1000')), // the channel has 300+ uploads; each 50 costs 1 API quota unit
  pickMode: env('PICK_MODE', 'newest'), // newest | oldest | random
  songsPerDrop: Number(env('SONGS_PER_DROP', '3')),

  // Music store: songs and albums sold as downloads. Put the audio files in STORE_DIR (see store/README.txt).
  // Music store in a Supabase Storage bucket instead of a folder. Set both of the first two to switch it on (see DEPLOY.md).
  supabaseUrl: env('SUPABASE_URL').replace(/\/+$/, ''),
  supabaseKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  storeBucket: env('SUPABASE_STORE_BUCKET', 'store'),
  storeCacheSeconds: Number(env('STORE_CACHE_SECONDS', '60')), // how long the site remembers what is in the bucket
  storeDir: path.resolve(projectRoot, env('STORE_DIR', 'store')),
  songPriceCents: Number(env('SONG_PRICE_CENTS', '200')),
  albumPriceCents: Number(env('ALBUM_PRICE_CENTS', '1200')),
  downloadLimit: Number(env('DOWNLOAD_LIMIT', '10')), // how many times each purchased file can be downloaded

  // Link-in-bio page (/links). Set any of these blank in .env to hide that button.
  spotifyUrl: env('SPOTIFY_URL', 'https://open.spotify.com/artist/1edxigeKoEWQJxJA7tVM3l'),
  youtubeMusicUrl: env('YOUTUBE_MUSIC_URL', 'https://music.youtube.com/channel/UC2803FvZwlTfxKGXOxKvSMw'),
  amazonMusicUrl: env('AMAZON_MUSIC_URL', 'https://music.amazon.com/artists/B0HG3NTJW2/jenny-ashby'),
  chorusPriceCents: Number(env('CHORUS_PRICE_CENTS', '1000')),
  // What buyers are told before they pay (chorus page, home page, receipt email). Set any of these blank to leave that line out.
  chorusTurnaround: env('CHORUS_TURNAROUND', 'within 48 hours'),
  chorusDelivery: env('CHORUS_DELIVERY', 'A finished audio recording of your chorus (MP3) with the lyrics written out, emailed to you.'),
  chorusRefund: env(
    'CHORUS_REFUND',
    'Every chorus is written just for you, so all sales are final once your request is in. If yours is late or something is wrong, reply to your confirmation email and we will make it right or refund you.',
  ),
  notifyEmail: env('NOTIFY_EMAIL'), // gets an email for each paid custom chorus request
  tipMinCents,
  tipMaxCents,
  tipPresetsCents,
  contactEmail: env('CONTACT_EMAIL'), // shown publicly (footer, privacy page) as the way to reach you. Leave blank to show no contact link.

  // Monthly vote on which songs get added to Spotify
  spotifyPlaylistUrl: env('SPOTIFY_PLAYLIST_URL'),
  winnersPerMonth: Number(env('WINNERS_PER_MONTH', '3')),
  voteCandidates: Number(env('VOTE_CANDIDATES', '12')), // how many songs are on each month's ballot
  votesFree: Number(env('VOTES_FREE', '1')), // votes per round for free subscribers
  votesMember: Number(env('VOTES_MEMBER', '3')), // votes per round for paying members

  // Email (SMTP). Without SMTP_HOST, emails are written to <dataDir>/outbox instead of sent.
  smtpHost: env('SMTP_HOST'),
  smtpPort: Number(env('SMTP_PORT', '587')),
  smtpUser: env('SMTP_USER'),
  smtpPass: env('SMTP_PASS'),
  fromEmail: env('FROM_EMAIL', 'songs@example.com'),
  fromName: env('FROM_NAME', env('BRAND_NAME', 'Jenny Ashby')),
  postalAddress: env('POSTAL_ADDRESS'), // shown in email footers (CAN-SPAM)

  // Weekly send
  sendCron: env('SEND_CRON', '0 9 * * 1'), // Mondays 09:00
  timezone: env('TIMEZONE', 'America/New_York'),
  sendToLeads: flag('SEND_TO_LEADS', true), // free subscribers get a locked teaser

  adminToken: env('ADMIN_TOKEN'),
  devMock: flag('DEV_MOCK', false), // fake YouTube videos so you can preview the site with no API keys
};

export const priceLabel = `$${(cfg.priceCents / 100).toFixed(cfg.priceCents % 100 ? 2 : 0)}`;
export const songPriceLabel = `$${(cfg.songPriceCents / 100).toFixed(cfg.songPriceCents % 100 ? 2 : 0)}`;
export const albumPriceLabel = `$${(cfg.albumPriceCents / 100).toFixed(cfg.albumPriceCents % 100 ? 2 : 0)}`;
export const chorusPriceLabel = `$${(cfg.chorusPriceCents / 100).toFixed(cfg.chorusPriceCents % 100 ? 2 : 0)}`;
