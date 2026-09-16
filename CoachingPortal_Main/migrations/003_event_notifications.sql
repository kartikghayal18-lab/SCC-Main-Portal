ALTER TABLE users
ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(20);

ALTER TABLE users
ADD COLUMN IF NOT EXISTS parent_whatsapp_number VARCHAR(20);

ALTER TABLE whatsapp_settings
ADD COLUMN IF NOT EXISTS attendance_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE whatsapp_settings
ADD COLUMN IF NOT EXISTS fee_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE whatsapp_settings
ADD COLUMN IF NOT EXISTS result_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE whatsapp_settings
ADD COLUMN IF NOT EXISTS test_paper_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE whatsapp_settings
ADD COLUMN IF NOT EXISTS notice_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS notification_logs (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER,
  student_id INTEGER NOT NULL,
  type VARCHAR(80) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  phone_number VARCHAR(20),
  event_key VARCHAR(220) UNIQUE,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS notification_logs_student_type_idx
ON notification_logs (student_id, type, created_at DESC);
