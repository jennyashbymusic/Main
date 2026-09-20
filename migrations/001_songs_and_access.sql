-- Songs the club serves itself (uploaded audio, or a video that is not public yet), with who is allowed to see each one.
--
--   access = 'public'         everyone
--   access = 'members_early'  members now; everyone else only once public_release_at has passed
--   access = 'members_only'   members only, always
--
-- Songs that already live on YouTube are still read from the channel; this table is for the exclusive ones.
CREATE TABLE songs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  slug               TEXT NOT NULL UNIQUE,            -- short URL-safe name, e.g. 'paper-saints'
  title              TEXT NOT NULL,
  access             TEXT NOT NULL DEFAULT 'public'
                     CHECK (access IN ('public', 'members_early', 'members_only')),
  public_release_at  TEXT,                            -- ISO timestamp (UTC); REQUIRED for members_early, ignored otherwise
  youtube_video_id   TEXT,                            -- an unlisted/public video to play, if there is one
  audio_file         TEXT,                            -- file name inside MEMBERS_AUDIO_DIR, if the audio was uploaded
  thumb              TEXT,                            -- optional cover image URL
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (access != 'members_early' OR public_release_at IS NOT NULL)
);
CREATE INDEX idx_songs_access ON songs (access, public_release_at);
