# Jenny Ashby: song club, vote and music store

A members-only fan site. Email form → sales page → Stripe checkout ($5/mo) → 3 songs from the YouTube channel emailed every week. On top of that: a monthly vote on which songs go on Spotify, and a store that sells songs ($2) and albums ($12).

## What is public and what needs an email

| Page | Who can open it |
|---|---|
| **Home** `/`, **Leaderboard** `/leaderboard`, **Next Release** `/next-release`, **Privacy** `/privacy`, **Terms** `/terms` | Everyone |
| **Vote** `/vote`, **Store** `/store`, **Invite** `/unlock` | Members: anyone who has given their email (free) |

The top navigation (Home · Vote · Leaderboard · Store · Invite · Custom Chorus, active tab in gold) **only appears once someone has given their email**. Visitors without one see no navigation on Home, and a slim bar with a "Join free" button on the other pages. Members-only pages show an email box instead of their content.

```
 /  (email form) ──► /join (sales page, $5/mo) ──► Stripe ──► member
       │                    │
       │                    └─► /unlock: share gate, each friend who joins unlocks 1 of 3 songs
       └─ Systeme.io contact + "Lead" tag
 Members area:  Vote (monthly, top songs go to Spotify) · Leaderboard (public) · Store (songs $2, albums $12) · Invite (your songs + your link)
```

## The home page

The video and signup form stay at the top. Below them: **How it works**, **Latest songs** (the six newest, playable in the "Now playing" box), **Help pick the next song on Spotify** (live countdown and who is leading), **About me**, **More from Jenny** (store + Custom Chorus), a **FAQ**, a second signup form and a full footer (Privacy, Terms, Contact, Spotify / YouTube Music / Amazon Music / YouTube links).

- **Edit the About me text** in `public/index.html` (the three paragraphs inside `.about-text`). It ships as draft wording: replace it with Jenny's own story.
- **The FAQ quotes the real settings** (prices, votes per month, how many songs win, download limit, Custom Chorus price and turnaround), so it changes when you change `.env`. Edit questions and answers in `public/index.html`. Search engines get the same Q&A as FAQ data.
- **Contact:** set `CONTACT_EMAIL` to show a "Contact" link in the footer and on the Privacy/Terms pages. Left blank, no Contact link is shown.
- **Privacy and Terms** describe what the site does today in plain language. They are a starting point, not legal advice: have a lawyer check them before launch (especially for fans in the EU, UK or California) and add where disputes are handled.

## Tip Jar

`/tip-jar` (aliases `/donate`, `/tips`) lets anyone leave a one-time tip through Stripe Checkout. It is in the members' navigation between Shop and Invite, in the home page footer and FAQ, and open to everyone. Quick-pick amounts come from `TIP_AMOUNTS` (dollars, default `3,5,10,25`); people can also type their own amount between `TIP_MIN_CENTS` (default $1) and `TIP_MAX_CENTS` (default $1,000). The amount is checked on the server, never trusted from the browser.

- Each tip is saved as pending when checkout starts and becomes paid when Stripe confirms it (the webhook, or the page Stripe returns the tipper to). The tipper gets a thank-you email, and you get one too if `NOTIFY_EMAIL` is set. **/admin → Tip jar** lists the total and recent tips with their notes.
- **One-time only, on purpose.** A monthly tip would be a Stripe subscription, and this site's webhook treats subscriptions as memberships.
- **Stripe:** nothing new to switch on. The existing webhook already receives `checkout.session.completed`, which is what tips use.
- The Terms describe tips as voluntary, non-refundable gifts that are not tax-deductible. Have that wording checked for where you live.

## Run it

**Windows: double-click `Launch Jenny Ashby Site.bat`.** It installs what it needs on first run, starts the site and opens your browser (or just opens it if it's already running). From a terminal: `npm install` then `npm run dev` (in PowerShell use `npm.cmd run dev` if scripts are blocked). Open http://localhost:3000.

It works with no setup: the site reads Jenny's public YouTube feed. Private settings live in `.env` (copy `.env.example`; it is gitignored). Emails are saved to `data/outbox/*.html` until you add SMTP. `/admin` (password = `ADMIN_TOKEN`) shows stats, votes, the store and lets you send a drop.

## Putting it online (Render)

**[DEPLOY.md](DEPLOY.md)** is the step-by-step guide for Render.com (GitHub, the `render.yaml` blueprint, Stripe webhook, email, your own domain, backups). `npm run setup-check` lists what is still missing in your settings.

## Going live: what to fill in `.env`

| Service | What to do |
|---|---|
| **Stripe** (needed for memberships **and** the store) | `STRIPE_SECRET_KEY`. Add a webhook endpoint `https://YOURSITE/webhook` for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` and put its signing secret in `STRIPE_WEBHOOK_SECRET`. Turn on the **Customer portal** (Settings → Billing) so "Manage billing" works. Locally: `stripe listen --forward-to localhost:3000/webhook`. Test card: `4242 4242 4242 4242`. |
| **YouTube** | `YOUTUBE_CHANNEL_ID` is preset to Jenny's channel. `YOUTUBE_API_KEY` (optional) reads the full catalog; without it the site uses the public feed (newest 15 videos). `#Shorts` are skipped unless `INCLUDE_SHORTS=true`. |
| **Landing video** | `FEATURED_VIDEO_ID`, the ID after `v=` in a YouTube link (currently `m6McIfkZy40`). Blank = newest upload. |
| **Systeme.io** | `SYSTEME_API_KEY` (Profile → Settings → Public API keys). Tags `Lead`, `Member`, `Cancelled`, `Unsubscribed` are created automatically. |
| **Email (SMTP)** | Any provider (Resend, Postmark, Brevo, SES…): `SMTP_*`, `FROM_EMAIL`, verify your sending domain (SPF/DKIM). Set `POSTAL_ADDRESS` for the footer. Until this is set, **nobody receives emails, including purchase receipts**. |
| **Site** | `BASE_URL` = your public https URL, `BRAND_NAME`, `TIMEZONE`, `SEND_CRON`, `DATA_DIR` (put the database on a persistent disk). |

## Link in bio: `/links` (alias `/bio`) and custom chorus

Put `https://YOURSITE/links` in your social bios. It is **public** (no email needed): Custom Chorus ($10) first, then Spotify, YouTube Music and Amazon Music, plus a link to join the list. The streaming URLs are set in `.env` (`SPOTIFY_URL`, `YOUTUBE_MUSIC_URL`, `AMAZON_MUSIC_URL`; blank hides a button).

**Custom chorus** (`/chorus`, also public): the buyer describes who it is for, the occasion, style and story, then pays $10 (`CHORUS_PRICE_CENTS`) through Stripe Checkout. You get the full brief in **/admin → Custom chorus orders** (and by email if `NOTIFY_EMAIL` is set), send the finished chorus to the buyer's email, then tick "Delivered". The buyer gets a confirmation email. Set `CHORUS_TURNAROUND` (e.g. "within 7 days") if you want to promise a delivery time. Like the store, it needs Stripe set up. Usage rights for the finished chorus are yours to decide; the site does not state any.

## The monthly Spotify vote

- One round per calendar month (in `TIMEZONE`). The ballot is the channel's newest songs that haven't already won (`VOTE_CANDIDATES`, default 12). Raising it mid-month adds the next-newest songs to the open ballot without touching existing votes.
- **Next Release** (`/next-release`, alias `/countdown`) is a public countdown to the moment the ballot closes, when the winners are added to Spotify. It also shows who is in the lead right now, a "heading to Spotify soon" notice once a ballot has closed and its songs aren't on Spotify yet (until you tick "Added to Spotify" in /admin, then it becomes "On Spotify ✓"), and a share box. It is in the members' navigation and linked from the Vote page.
- **Songs play on the site.** Tapping a song's picture or "▶ Play" opens a "Now playing" box (a YouTube player, `public/player.js`) in the corner, so nobody has to leave to listen. It keeps playing while people vote and while the ballot refreshes; Esc or ✕ closes it. A song is listed once even if the channel has two uploads of it (the newest is used).
- Everyone with an email gets `VOTES_FREE` vote(s), paying members `VOTES_MEMBER`. Votes can be moved until the round closes.
- The **Vote** page has a live countdown to the next round. The **Leaderboard** page is public. Songs with votes are ranked (ties go to the newer song) with a cut line after the winning places; songs with no votes yet are grouped underneath, listed A to Z and not numbered. Bars are a share of the leader's votes but never scaled below 10 votes, so a single vote looks like a single vote (`BAR_FLOOR` in `public/board.js`). A share box (link, Copy, WhatsApp / X / Facebook / Email) sits under the standings.
- **"Top N" is one setting**, `WINNERS_PER_MONTH`. The server decides which songs are inside it, and the month-end result, the cut line, the gold rows and the Vote page's "Top N" badges and wording all follow it, so changing it to 5 changes every one of them together.
- When the month ends the top `WINNERS_PER_MONTH` songs (with at least one vote) win and a new ballot opens. **Adding the winners to Spotify is manual**: open `/admin`, use the "find on Spotify" links, add them to your playlist, then tick "Added to Spotify" (the vote pages then show "On Spotify ✓"). Set `SPOTIFY_PLAYLIST_URL` to link your playlist.

## The music store

Drop audio files into the `store/` folder, no restart needed (details in `store/README.txt`):

```
store/songs/Come Sit With Me.mp3                 $2 each   (optional cover: Come Sit With Me.jpg)
store/albums/Dark Roads/01 - First Song.mp3      $12 per album folder (optional cover.jpg)
```

- **See it before you have any files:** open `/store?preview=1` (as a member) for a sample store built from Jenny's real song titles and thumbnails. Nothing in the preview can be bought. The link is also in `/admin`.
- **Where the music lives:** in a folder (`STORE_DIR`, the default) **or in a private Supabase Storage bucket** (fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`). Same names either way: `songs/Song.mp3` (+ `Song.jpg` cover), `albums/Album Name/01 - Track.mp3` (+ `cover.jpg`). Buyers never get a public link: the site checks the order, counts the download, then hands over a 60-second signed link (albums are zipped on the fly). `npm run store-check` tests the connection and explains any problem. Steps are in DEPLOY.md.
- Members add items to a cart and pay through Stripe Checkout. Prices are set by the server (`SONG_PRICE_CENTS`, `ALBUM_PRICE_CENTS`), never by the browser.
- After paying, the buyer gets a receipt email and a private download page: songs download directly, albums as a `.zip` or track by track. Each file can be downloaded `DOWNLOAD_LIMIT` times.
- The files are never publicly reachable, only through those private links. A song whose title matches a YouTube video gets its thumbnail and a "Listen first" link.
- Buyers keep working links as long as the files stay in the folder. Sales and recent orders show in `/admin`.
- Digital sales may carry sales tax/VAT depending on where you and your buyers are. Check with an accountant and Stripe Tax.

## Free tier, exclusives, consent, cancelling

- **Free tier**: signing up unlocks song 1 of the week, 1 confirmed friend unlocks song 2, 2 friends unlock song 3. Members get all 3. The invite page and emails say this in the same words.
- **Referral link** is built from `BASE_URL`. Only while `BASE_URL` is still a localhost address (not set) does the Invite page use the address the visitor is on, so a shared link never says localhost on a live site. In production the server refuses to start without a public `BASE_URL`. The `?ref=` code is remembered in the browser until the friend signs up. A friend counts once, only after confirming their email (when SMTP is set), and never for their own address or for someone already on the list.
- **Member exclusives**: each song has `access` = `public`, `members_early` (members now, public at `public_release_at`) or `members_only`. Files are private (`MEMBERS_AUDIO_DIR`) and streamed only to people allowed to hear them. The line "new songs before they go public" appears only once `EARLY_ACCESS_MIN_SONGS` songs are non-public.
- **Adding exclusive songs (for a watcher script)**, both calls use HTTP Basic auth, any username and `ADMIN_TOKEN` as the password:
  1. `POST /admin/api/songs` with JSON `{"slug":"my-song","title":"My Song","access":"members_early","public_release_at":"2026-10-01T09:00:00Z","youtube_video_id":"optional"}`
  2. `PUT /admin/api/songs/my-song/audio?filename=my-song.mp3` with `Content-Type: audio/mpeg` and the file as the body.
  The same thing is in **/admin → Songs**.
- **Consent**: every email box carries "By joining, you agree to get occasional emails about new songs and offers. Unsubscribe anytime." The time and place of agreement is stored (`consent_at`, `consent_source`). Every list email has an unsubscribe link and it is honoured immediately; typing an unsubscribed address again does not re-subscribe it.
- **Cancel anytime**: "Manage subscription" opens Stripe's billing portal. In Stripe: **Settings → Billing → Customer portal**, switch it on and tick **Customers can cancel subscriptions** (do this in test mode and again in live mode). **/admin → Cancel anytime check** tells you if it is right.
- **Runway**: `npm run runway` (and a card in /admin, and the Monday job) counts the YouTube videos not yet sent and warns under `RUNWAY_WARN_WEEKS` weeks.
- **Hosting on Render**: set `BASE_URL` to your https address and `NODE_ENV=production`, add a persistent disk and point `DATA_DIR` and `MEMBERS_AUDIO_DIR` at it (otherwise the database and audio are wiped on each deploy), and add the SMTP variables. There is no Supabase in this project.

## Custom Chorus

`/chorus` sells a one-off custom chorus (`CHORUS_PRICE_CENTS`, default $10) through Stripe. It is linked from the members' navigation (last tab), from a call-to-action on the home page and from `/links`. Before paying, buyers see **What to expect**: turnaround, what they get, and the refund policy, plus a short example chorus. Change the wording with `CHORUS_TURNAROUND`, `CHORUS_DELIVERY` and `CHORUS_REFUND` (the same text goes in the receipt email). The example chorus is written in `public/chorus.html` (`SAMPLE`); swap in a real one of Jenny's. "Who is it for?" and the story are required and marked with a *.

## How the rest behaves

- **Signup** tags them `Lead` in Systeme.io, emails a welcome with their personal links and goes to `/join`. The browser remembers them. Typing an already-registered *free* email returns that person to their page; a *member's* email never reveals their link on screen (it is emailed only, since it also opens their billing portal).
- **Weekly drop**: `SONGS_PER_DROP` unsent public videos (`PICK_MODE`), full for members and a locked teaser for free subscribers (`SEND_TO_LEADS=false` to disable). Sends are recorded per person, so re-running never double-sends.
- **Share gate**: see "Free tier" above. Friends are counted per week's drop.
- **Cancel / failed card**: `Cancelled` tag and no more member emails; `past_due` keeps access while Stripe retries.
- Systeme.io failures never block signup or checkout. **/admin → Resync** replays them.

## Things to know

- **Why SMTP sends the emails, not Systeme.io:** its API can send a newsletter but can't choose the audience or personalise each email, so it holds the list and this app sends.
- **Songs in the weekly drops and the vote are public YouTube videos**, so the share gate is a nudge, not protection. The store is different: those files are private and only released to buyers.
- **Voting and referrals are not fraud-proofed** beyond one vote per song per email and no self-referral. Someone determined could sign up fake emails.
- **Run one server process** with the database on a persistent disk (`DATA_DIR`), and back it up. The weekly schedule runs inside the process; if it is down on Monday it does not catch up (use **/admin → Send** or `npm run send`).
- Needs **Node 22.13+** (built-in `node:sqlite`).
- Before launch consider double opt-in and a privacy policy/terms page, especially for EU/UK visitors.
