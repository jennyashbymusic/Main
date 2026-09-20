-- The tip jar (/tip-jar): one row per tip. A row is created "pending" when someone starts checkout and becomes "paid"
-- only when Stripe confirms the payment (the webhook, or the page Stripe sends the tipper back to, whichever comes first).
CREATE TABLE IF NOT EXISTS tips (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  currency          TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',   -- optional: how the tipper wants to be thanked
  message           TEXT NOT NULL DEFAULT '',   -- optional note for Jenny (private: emailed to the owner and shown in /admin)
  email             TEXT NOT NULL DEFAULT '',   -- collected by Stripe Checkout
  stripe_session_id TEXT,
  created_at        TEXT NOT NULL,
  paid_at           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tips_session ON tips(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tips_status ON tips(status, id);
