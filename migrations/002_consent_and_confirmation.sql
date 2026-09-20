-- Consent record and email confirmation for each subscriber.
--
--   consent_at / consent_source   when and where they agreed to get emails ("landing", "gate:vote", "membership_purchase", ...)
--   confirmed_at                  when they clicked the confirmation link; only confirmed friends count toward a referral
ALTER TABLE subscribers ADD COLUMN consent_at TEXT;
ALTER TABLE subscribers ADD COLUMN consent_source TEXT;
ALTER TABLE subscribers ADD COLUMN confirmed_at TEXT;

-- Everyone who joined before this migration is kept as they were. They joined before the consent line existed, so their
-- source says so ("legacy") instead of pretending they ticked it. They are treated as confirmed so existing referrals still count.
UPDATE subscribers SET consent_at = created_at, consent_source = 'legacy' WHERE consent_at IS NULL;
UPDATE subscribers SET confirmed_at = created_at WHERE confirmed_at IS NULL;
