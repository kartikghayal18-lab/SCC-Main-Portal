CREATE TABLE IF NOT EXISTS whatsapp_onboarding_deliveries (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  recipient_type VARCHAR(20) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  whatsapp_sent BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_sent_at TIMESTAMPTZ,
  whatsapp_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT whatsapp_onboarding_recipient_type_check
    CHECK (recipient_type IN ('student', 'parent')),
  CONSTRAINT whatsapp_onboarding_student_recipient_unique
    UNIQUE (student_id, recipient_type)
);

CREATE INDEX IF NOT EXISTS whatsapp_onboarding_retry_idx
  ON whatsapp_onboarding_deliveries (whatsapp_sent, retry_count, updated_at)
  WHERE whatsapp_sent = FALSE AND retry_count < 5;

CREATE INDEX IF NOT EXISTS whatsapp_onboarding_branch_student_idx
  ON whatsapp_onboarding_deliveries (coaching_id, branch_id, student_id);
