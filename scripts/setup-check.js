// What is still missing in your .env?
//   npm run setup-check
// Prints a tick or a cross for each thing you need to fill in, and where to get it. Exits with code 1 if something required
// is still missing, so it can also be used before a deploy. It never prints your secrets, only whether they are set.
import { cfg, isLocalUrl } from '../src/config.js';

const set = (v) => Boolean(String(v ?? '').trim());
const rows = [];
const add = (group, label, ok, todo, { required = true, note = '' } = {}) => rows.push({ group, label, ok, todo, required, note });

// ---- A. Stripe ----
const key = cfg.stripeKey || '';
add('A. Stripe (payments)', 'STRIPE_SECRET_KEY', /^(sk|rk)_(test|live)_\w{8,}$/.test(key), 'Stripe dashboard > Developers > API keys > Secret key (starts with sk_test_ or sk_live_)',
  { note: key.startsWith('sk_test_') ? 'test mode: fine for trying things. Switch to sk_live_ to take real money.' : key.startsWith('sk_live_') ? 'live mode' : '' });
add('A. Stripe (payments)', 'STRIPE_WEBHOOK_SECRET', /^whsec_\w{8,}$/.test(cfg.stripeWebhookSecret || ''), 'Stripe dashboard > Developers > Webhooks > your endpoint > Signing secret (starts with whsec_)');

// ---- B. Email ----
add('B. Email (sending)', 'SMTP_HOST', set(cfg.smtpHost), 'Your email service (Resend, Brevo, Postmark, SES, Gmail app password): its SMTP server name');
add('B. Email (sending)', 'SMTP_USER', set(cfg.smtpUser), 'The same service: the SMTP username');
add('B. Email (sending)', 'SMTP_PASS', set(cfg.smtpPass), 'The same service: the SMTP password or API key');
add('B. Email (sending)', 'FROM_EMAIL', set(cfg.fromEmail) && !/@example\.com$/i.test(cfg.fromEmail), 'The address emails come from, on the domain you verified (still songs@example.com)');
add('B. Email (sending)', 'POSTAL_ADDRESS', set(cfg.postalAddress), 'A real mailing address (a P.O. box is fine). The law requires it in the footer of marketing emails');

// ---- C, D. Admin and contact ----
add('C. Admin', 'ADMIN_TOKEN', set(cfg.adminToken) && cfg.adminToken.length >= 12, 'Make up a long password (16+ characters). Blank switches /admin off',
  { note: set(cfg.adminToken) && cfg.adminToken.length < 12 ? 'too short: use 16 or more characters' : '' });
add('D. Contact', 'CONTACT_EMAIL', set(cfg.contactEmail), 'The address fans can write to. Shown as "Contact" in the footer and on Privacy/Terms');
add('D. Contact', 'NOTIFY_EMAIL', set(cfg.notifyEmail), 'Where you want an alert for each custom chorus order and tip', { required: false });

// ---- E. Going live ----
const url = cfg.baseUrl; // BASE_URL, or Render's own address, or the local default
add('E. Going live (only when the site is on the internet)', 'BASE_URL', !isLocalUrl(url) && /^https:\/\//i.test(url), 'Your real address, for example https://jennyashby.com (https, no slash at the end)', { required: false, note: process.env.RENDER_EXTERNAL_URL && !process.env.BASE_URL ? 'using Render\'s own address for now; set BASE_URL once you have your own domain' : '' });
add('E. Going live (only when the site is on the internet)', 'NODE_ENV', process.env.NODE_ENV === 'production', 'Type production when the site is live on a host', { required: false });
add('E. Going live (only when the site is on the internet)', 'TRUST_PROXY', cfg.trustProxy, 'Set to true when the site runs on a host', { required: false });
add('E. Going live (only when the site is on the internet)', 'DATA_DIR + MEMBERS_AUDIO_DIR', set(process.env.DATA_DIR) && set(process.env.MEMBERS_AUDIO_DIR),
  'Point both at a persistent disk on your host, or a deploy will wipe your subscribers and songs', { required: false });

// ---- F. Optional ----
add('F. Optional', 'YOUTUBE_API_KEY', set(cfg.youtubeKey), 'Google Cloud Console > YouTube Data API v3 > Credentials. Without it only the newest 15 videos are used', { required: false });
add('F. Optional', 'SYSTEME_API_KEY', set(cfg.systemeKey), 'Systeme.io > Profile > Settings > Public API keys (only if you use Systeme.io)', { required: false });
add('F. Optional', 'SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY', set(cfg.supabaseUrl) && set(cfg.supabaseKey), 'Only if the store music lives in a Supabase bucket instead of the disk (DEPLOY.md, step 9). Then run: npm run store-check', { required: false });
add('F. Optional', 'SPOTIFY_PLAYLIST_URL', set(cfg.spotifyPlaylistUrl), 'Your Spotify playlist for the monthly vote winners', { required: false });

// ---- print ----
const isLive = process.env.NODE_ENV === 'production' || !isLocalUrl(url);
let last = '', missingRequired = 0, missingOptional = 0;
console.log('\nSetup check for your .env\n');
for (const r of rows) {
  if (r.group !== last) { console.log(`\n${r.group}`); last = r.group; }
  const mark = r.ok ? '  ✓' : r.required ? '  ✗' : '  –';
  console.log(`${mark} ${r.label}${r.ok && r.note ? `   (${r.note})` : ''}`);
  if (!r.ok) {
    console.log(`      ${r.required ? 'FILL IN' : 'optional'}: ${r.todo}${r.note ? `  [${r.note}]` : ''}`);
    if (r.required) missingRequired++; else missingOptional++;
  }
}
console.log(`\n${missingRequired === 0 ? '✓ Everything required is filled in.' : `✗ ${missingRequired} required setting${missingRequired === 1 ? '' : 's'} still to fill in.`}${missingOptional ? ` (${missingOptional} optional or go-live item${missingOptional === 1 ? '' : 's'} left.)` : ''}`);
if (!isLive) console.log('You are set up for testing on this computer. The "going live" items only matter once the site is on the internet.');
console.log('Remember: save .env, then restart the site for changes to take effect.\n');
process.exit(missingRequired ? 1 : 0);
