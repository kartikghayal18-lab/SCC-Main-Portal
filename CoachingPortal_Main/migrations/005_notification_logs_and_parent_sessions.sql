ALTER TABLE notification_logs
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(80),
  ADD COLUMN IF NOT EXISTS attachment_url TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

UPDATE notification_logs
SET event_type = type
WHERE event_type IS NULL;

CREATE TABLE IF NOT EXISTS whatsapp_parent_sessions (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER,
  student_id INTEGER,
  phone_number VARCHAR(20) NOT NULL,
  state VARCHAR(80) NOT NULL DEFAULT 'menu',
  last_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (coaching_id, phone_number)
);
