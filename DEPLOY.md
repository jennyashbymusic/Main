# Putting the site live on Render

This is the whole job, in order. Allow an afternoon the first time. Each step says how to check it worked.

**Good to know before you start**

- **Cost:** the site needs Render's **Starter** web service plus a small **persistent disk**. As of writing that is roughly $7 a month for the service plus a few cents a month for a 1 GB disk. Check [render.com/pricing](https://render.com/pricing) for today's prices. The free plan will not work: it has no disk (your subscribers would be deleted on every deploy) and it sleeps (so the Monday-morning song email would be missed).
- **The site is one program with its own database file**, so it runs as **one** service. Don't add extra copies of it.
- **Your `.env` file is not uploaded** (it holds secrets). You type the same values into Render instead (step 3).
- The button names in Render's website change now and then. If something looks slightly different, look for the closest match.

---

## 1. Accounts you need

| For | Where | Notes |
|---|---|---|
| The code | [github.com](https://github.com) | free, a **private** repository is fine |
| Hosting | [render.com](https://render.com) | sign in with GitHub to make step 3 easier |
| Payments | [stripe.com](https://stripe.com) | start in **Test mode** (switch at the top of the dashboard) |
| Sending email | Resend, Brevo, Postmark, Amazon SES, or Gmail | you need SMTP details and a verified sending domain |

Fill in your `.env` file first (search it for `>>> FILL IN`), then run `npm run setup-check` to see what is still missing. You will copy those same values into Render.

## 2. Put the code on GitHub

Easiest way, with no commands:

1. Install **GitHub Desktop** ([desktop.github.com](https://desktop.github.com)) and sign in.
2. **File > Add local repository** and choose this project folder. If it says "this directory does not appear to be a Git repository", click **create a repository**.
3. Look at the list of changed files. **`.env` must NOT be in it** (it is ignored on purpose, so it won't be). If you ever see `.env`, stop and ask for help.
4. Type a message such as "First version", click **Commit to main**, then **Publish repository**. Tick **Keep this code private**.

Check: on github.com your new repository shows folders like `src`, `public`, `views`, and a file `render.yaml`.

## 3. Create the service on Render

1. In Render: **New +** > **Blueprint**. Connect your GitHub account and choose the repository.
2. Render reads `render.yaml` and shows a **jenny-ashby-site** web service with a **club-data** disk.
3. It asks you for the secret values. Copy them from your `.env`:

   | Render asks for | Put in |
   |---|---|
   | `STRIPE_SECRET_KEY` | your Stripe secret key (`sk_test_...` for now) |
   | `STRIPE_WEBHOOK_SECRET` | anything for now (for example `x`). You get the real one in step 5. |
   | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | from your email service |
   | `FROM_EMAIL` | the address emails come from, on your verified domain |
   | `POSTAL_ADDRESS` | your mailing address (required by law in marketing emails) |
   | `ADMIN_TOKEN` | a long password for the `/admin` page |
   | `CONTACT_EMAIL`, `NOTIFY_EMAIL` | your email address(es) |
   | `YOUTUBE_API_KEY` | the key already in your `.env` |
   | `SYSTEME_API_KEY` | only if you use Systeme.io, otherwise leave empty |
   | `BASE_URL` | **leave empty for now** (step 7 sets your own domain). If Render insists on a value, type the address Render shows for your service, such as `https://jenny-ashby-site.onrender.com` (it can differ if that name was taken). |

4. Click **Apply**. Render builds and starts the site. The first build takes a few minutes.

Check: open the service's **Logs** tab. You should see `Jenny Ashby running at https://jenny-ashby-site.onrender.com` and lines for Stripe, Email, YouTube. Then open that address in your browser: the home page loads.

Not a Blueprint person? **New + > Web Service** works too. Use build command `npm install --omit=dev`, start command `npm start`, plan **Starter**, add a **Disk** mounted at `/var/data` (1 GB), and add the fixed values from `render.yaml` (`NODE_VERSION`, `NODE_ENV`, `TRUST_PROXY`, `DATA_DIR`, `MEMBERS_AUDIO_DIR`, `STORE_DIR`) plus the secrets above under **Environment**.

## 4. Look around

- `https://YOUR-SITE.onrender.com/admin` (any username, your `ADMIN_TOKEN` as the password). You should see the stats page.
- In Render, open the service's **Shell** and run `npm run setup-check`. It lists anything still missing.

## 5. Connect Stripe (this is what makes payments work)

1. Stripe dashboard (still in **Test mode**) > **Developers > Webhooks > Add endpoint**.
2. Endpoint URL: `https://YOUR-SITE.onrender.com/webhook`
3. Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
4. Save, then click **Reveal** under **Signing secret** (starts with `whsec_`).
5. In Render: your service > **Environment** > change `STRIPE_WEBHOOK_SECRET` to that value > **Save**. Render redeploys by itself.
6. Stripe: **Settings > Billing > Customer portal**: turn it on and tick **Customers can cancel subscriptions**.
7. Test it: on your site click through to the membership checkout and pay with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC). Also try a tip and a custom chorus. In `/admin` you should see them appear. In Stripe > Webhooks the events should show as delivered.

## 6. Check email

Join the list on your home page with your own address. You should get the welcome email and a confirmation link within a minute. If nothing arrives: check spam, then the Render **Logs** for `[welcome]` or `email failed` lines. Sending from a new domain usually needs the DNS records your email service gives you (SPF, DKIM). If your provider offers more than one SMTP port, try `587`, or `2525` if `587` is blocked.

## 7. Your own domain (for example jennyashby.com)

1. Render: your service > **Settings > Custom Domains > Add**. Enter your domain (and `www.` too if you want it).
2. Render shows DNS records to add. Add them where you bought the domain. It can take from a few minutes to a few hours. Render then makes the https certificate for you.
3. When it works, in Render > **Environment** set **`BASE_URL`** to `https://yourdomain.com` (https, no slash at the end) and save.
4. In Stripe, edit the webhook endpoint to use the new address (`https://yourdomain.com/webhook`).
5. Your Spotify, YouTube and other links to the site should use the new address.

## 8. Take real money (only when everything above works in Test mode)

1. In Stripe, switch to **Live mode** (you will be asked to finish activating your account).
2. Stripe **Live** mode: copy the live **Secret key** (`sk_live_...`), create a **new webhook endpoint** (same URL, same three events) and copy its new signing secret, and turn on the **Customer portal** again (the Test mode setting does not carry over).
3. In Render > **Environment**: replace `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` with the live values. Render redeploys.
4. Do one real $1 tip yourself, check it appears in `/admin`, then refund it in Stripe.

## 9. Add your music

- **Members-only songs:** use `/admin` > Songs (or your upload script). They are saved on the disk automatically.
- **Music for the store:** the store folder on the disk is `/var/data/store` (it has `songs/` and `albums/` inside). To copy files there you need SSH: in Render's **Account Settings** add your SSH key, then in the service's **Connect** menu copy the SSH command, and use `scp` (or a tool like WinSCP) with the same address. See Render's docs, "SSH". No restart is needed after adding files.

## 10. Moving what you already have (optional)

The 3 subscribers in your test copy do not move over on their own. If you want to keep them, copy your local `data/club.db` to `/var/data/club.db` on the disk with `scp`, **before** anyone real signs up, and restart the service. Otherwise start fresh, which is usually simplest.

## 11. Changing the site later

Change the code on your computer, test it, then in GitHub Desktop **Commit** and **Push origin**. Render sees the push and redeploys in a few minutes. Your data on the disk is untouched. Environment values are changed in Render, not in `.env` (that file only affects your own computer).

Each redeploy restarts the site for a minute or so. It is best not to deploy in the middle of the Monday-morning send.

## 12. Backups

The disk holds everything that matters. Render can take snapshots of a disk (see the disk's page in Render), but also keep your own copy. In the service's **Shell**:

```
node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync('/var/data/club.db').exec(\"VACUUM INTO '/var/data/backup.db'\")"
```

then download `/var/data/backup.db` with `scp`. Do this now and then, and before any big change.

---

## If something goes wrong

| What you see | Most likely cause and fix |
|---|---|
| The service will not start and the logs say **BASE_URL** | `BASE_URL` is set to a `localhost` address. Empty it, or set your real https address. |
| Payments say **"not switched on yet"** / **"Tips open soon"** | `STRIPE_SECRET_KEY` is missing or wrong in Render's Environment. |
| Stripe shows webhook deliveries **failing (400)** | `STRIPE_WEBHOOK_SECRET` is wrong, or you mixed Test and Live (each mode has its own secret). |
| Someone paid but nothing shows in `/admin` | The webhook is not reaching the site. Check the endpoint URL and the three events in Stripe. |
| Emails do not arrive | SMTP values wrong, sending domain not verified, or the port is blocked. Check the Render Logs. |
| **Everything was wiped after a deploy** | The disk is not attached, or `DATA_DIR` is not `/var/data`. Check both in Render. |
| A page is slow only the first time | Normal for a cold browser. The Starter plan does not sleep. |
| The weekly song email did not go | The site must be running on Monday at 9:00 AM (Eastern). Check the Render Logs for `[cron]` and `[drop]` lines. |

## Launch checklist

- [ ] `npm run setup-check` says everything required is filled in (run it in the Render Shell)
- [ ] Home page loads at your own https address
- [ ] `/admin` opens with your password
- [ ] Test-mode membership, tip, custom chorus and store purchase all appear in `/admin`
- [ ] Welcome email arrives, and the unsubscribe link works
- [ ] Stripe **Live** keys, live webhook and live Customer portal set up, and one real $1 tip refunded
- [ ] `BASE_URL` is your real domain, and the Stripe webhook points at it
- [ ] Privacy and Terms pages read by a lawyer, About text replaced with Jenny's own words
- [ ] A backup of the database downloaded
