import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, isLocalUrl, priceLabel } from './src/config.js';
import { publicOrigin } from './src/origin.js';
import { startScheduler } from './src/drops.js';
import { mailerMode } from './src/mailer.js';
import { systemeEnabled } from './src/systeme.js';
import { youtubeMode } from './src/youtube.js';
import { router as publicRouter } from './src/routes/public.js';
import { router as billingRouter, stripe, webhook } from './src/routes/billing.js';
import { router as adminRouter } from './src/routes/admin.js';
import { router as voteRouter } from './src/routes/vote.js';
import { router as storeRouter, downloads } from './src/routes/store.js';
import { router as linksRouter } from './src/routes/links.js';
import { router as songsRouter } from './src/routes/songs.js';
import { router as tipsRouter } from './src/routes/tips.js';
import { storeStatusLine } from './src/store.js';
import { startVotingScheduler } from './src/voting.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
if (cfg.trustProxy) app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Personal links carry a token in the URL; never leak the full URL to other sites (YouTube embeds, etc.).
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});

// Stripe signs the raw request body, so the webhook must be registered before express.json().
app.post('/webhook', ...webhook);

app.use(express.json({ limit: '10kb' }));
app.use('/api/vote', voteRouter);
app.use('/api/store', storeRouter);
app.use('/api/tips', tipsRouter); // the tip jar
app.use('/download', downloads);
app.use('/api', linksRouter); // public: the link-in-bio page and custom chorus orders
app.use('/api', songsRouter); // exclusive / early-access songs, gated by the access rules in src/songs.js
app.use('/api', publicRouter);
app.use(billingRouter);
app.use('/admin', adminRouter);

// Social-share tags (og:image) need an absolute URL, so fill in BASE_URL when serving the pages people share.
const withBaseUrl = (file) => (req, res) => {
  const html = fs.readFileSync(path.join(root, 'public', file), 'utf8').replaceAll('%BASE_URL%', publicOrigin(req));
  res.type('html').send(html);
};
app.get('/', withBaseUrl('index.html'));
app.get('/vote', withBaseUrl('vote.html'));
app.get('/leaderboard', withBaseUrl('leaderboard.html'));
app.get('/next-release', withBaseUrl('next-release.html'));
app.get('/tip-jar', withBaseUrl('tip-jar.html'));
app.get(['/donate', '/tips'], (_req, res) => res.redirect('/tip-jar')); // easy-to-remember aliases
app.get('/countdown', (_req, res) => res.redirect('/next-release')); // an easy-to-remember alias
app.get('/links', withBaseUrl('links.html'));
app.get('/bio', (_req, res) => res.redirect('/links')); // an easy-to-remember alias for social bios
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((_req, res) => res.status(404).sendFile(path.join(root, 'public', '404.html')));

app.listen(cfg.port, () => {
  const on = (ok) => (ok ? 'ready' : 'NOT configured');
  console.log(`\n${cfg.brand} running at ${cfg.baseUrl}  (membership ${priceLabel}/mo)`);
  console.log(`  Stripe     ${on(stripe && cfg.stripeWebhookSecret)}`);
  console.log(`  Systeme.io ${on(systemeEnabled())}`);
  const youtube = {
    demo: 'DEMO MODE (fake videos)',
    api: 'ready (Data API, full catalog)',
    feed: 'public feed (newest 15 videos). Add YOUTUBE_API_KEY for the full catalog',
    off: 'NOT configured (set YOUTUBE_CHANNEL_ID)',
  }[youtubeMode()];
  console.log(`  YouTube    ${youtube}`);
  console.log(`  Email      ${mailerMode() === 'smtp' ? 'SMTP' : `no SMTP: emails are saved to ${cfg.dataDir}\\outbox`}`);
  console.log(`  Admin      ${cfg.adminToken ? `${cfg.baseUrl}/admin` : 'disabled (set ADMIN_TOKEN)'}`);
  if (isLocalUrl(cfg.baseUrl)) {
    console.warn(`  Site URL   BASE_URL is not set, so emails and Stripe return pages use ${cfg.baseUrl}. Invite links shown on the site follow the address visitors use. Set BASE_URL to your public https address before launch.`);
  }
  console.log('');
  storeStatusLine().then((line) => console.log(`  Store music: ${line}`)).catch((err) => console.error('[store]', err.message));
  startScheduler();
  startVotingScheduler();
});
