ALTER TABLE users
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(20);

CREATE TABLE IF NOT EXISTS whatsapp_settings (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL UNIQUE,
  access_token TEXT,
  phone_number_id VARCHAR(80),
  business_account_id VARCHAR(80),
  verify_token VARCHAR(160),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER,
  student_id INTEGER,
  phone_number VARCHAR(20) NOT NULL,
  message_type VARCHAR(40) NOT NULL,
  message_content TEXT,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  meta_message_id VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS whatsapp_logs_coaching_created_idx
ON whatsapp_logs (coaching_id, created_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_logs_meta_message_id_idx
ON whatsapp_logs (meta_message_id);
