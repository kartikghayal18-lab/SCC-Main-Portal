CREATE TABLE IF NOT EXISTS app_sessions (
  sid TEXT PRIMARY KEY,
  sess JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS app_sessions_expire_idx
ON app_sessions (expire);
