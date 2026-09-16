-- Complete PostgreSQL schema for the Coaching Portal.
-- Reverse-engineered from src/app.js, src/services/*, config/database.js,
-- src/session-store.js, scripts/*, and migrations/*.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS app_sessions (
  sid TEXT PRIMARY KEY,
  sess JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS app_sessions_expire_idx
  ON app_sessions (expire);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  price_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_students INTEGER,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coaching_classes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(220) NOT NULL,
  brand_name VARCHAR(220),
  slug VARCHAR(100) NOT NULL UNIQUE,
  contact_email VARCHAR(220),
  subscription_plan_id INTEGER REFERENCES subscription_plans(id) ON DELETE SET NULL,
  custom_plan_name VARCHAR(180),
  custom_max_students INTEGER,
  subscription_status VARCHAR(40) NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('trial', 'active', 'suspended', 'cancelled')),
  subscription_started_at TIMESTAMPTZ,
  subscription_ends_at TIMESTAMPTZ,
  logo_url TEXT,
  theme_primary VARCHAR(40),
  theme_background VARCHAR(40),
  theme_surface VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_coaching_slug
  ON coaching_classes (slug);

CREATE INDEX IF NOT EXISTS idx_coaching_subscription_status
  ON coaching_classes (subscription_status, subscription_plan_id);

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL REFERENCES coaching_classes(id) ON DELETE CASCADE,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(180) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS branches_coaching_code_unique_idx
  ON branches (coaching_id, code);

CREATE UNIQUE INDEX IF NOT EXISTS branches_id_coaching_unique_idx
  ON branches (id, coaching_id);

CREATE OR REPLACE FUNCTION app_current_branch_id()
RETURNS INTEGER
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('app.branch_id', TRUE), '')::INTEGER
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_super_admin', TRUE), '')::BOOLEAN, FALSE)
$$;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER REFERENCES coaching_classes(id) ON DELETE CASCADE,
  branch_id INTEGER DEFAULT app_current_branch_id(),
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'student')),
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  username VARCHAR(120),
  roll_no VARCHAR(80),
  name VARCHAR(220),
  batch_id INTEGER,
  standard VARCHAR(20) CHECK (standard IN ('11th', '12th') OR standard IS NULL),
  course VARCHAR(20) CHECK (course IN ('jee', 'neet') OR course IS NULL),
  contact_phone VARCHAR(20),
  guardian_phone VARCHAR(20),
  parent_name VARCHAR(180),
  whatsapp_number VARCHAR(20),
  parent_whatsapp_number VARCHAR(20),
  email VARCHAR(220),
  password_hash TEXT NOT NULL,
  password_display TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  password_changed_at TIMESTAMPTZ,
  is_retained_record INTEGER NOT NULL DEFAULT 0 CHECK (is_retained_record IN (0, 1)),
  retention_source_batch_id INTEGER,
  terms_accepted_at TIMESTAMPTZ,
  privacy_accepted_at TIMESTAMPTZ,
  saas_accepted_at TIMESTAMPTZ,
  legal_accepted_at TIMESTAMPTZ,
  omr_barcode VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_owner_username
  ON users (username)
  WHERE is_owner = 1;

CREATE UNIQUE INDEX IF NOT EXISTS users_branch_admin_username_unique_idx
  ON users (branch_id, username)
  WHERE role = 'admin' AND username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_coaching_branch_roll_unique_idx
  ON users (coaching_id, branch_id, roll_no)
  WHERE role = 'student' AND roll_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_branch_role_idx
  ON users (branch_id, role);

CREATE INDEX IF NOT EXISTS users_coaching_role_idx
  ON users (coaching_id, role);

CREATE INDEX IF NOT EXISTS users_coaching_role_batch_idx
  ON users (coaching_id, role, batch_id);

CREATE INDEX IF NOT EXISTS users_coaching_role_roll_idx
  ON users (coaching_id, role, roll_no);

CREATE INDEX IF NOT EXISTS idx_users_batch
  ON users (coaching_id, role, batch_id, roll_no);

CREATE INDEX IF NOT EXISTS users_omr_barcode_branch_idx
  ON users (coaching_id, branch_id, omr_barcode);

CREATE INDEX IF NOT EXISTS users_branch_retention_source_idx
  ON users (coaching_id, branch_id, retention_source_batch_id)
  WHERE is_retained_record = 1;

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  name VARCHAR(180) NOT NULL,
  normalized_name VARCHAR(180) NOT NULL,
  standard VARCHAR(20),
  course VARCHAR(20),
  status VARCHAR(40) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  completed_at TIMESTAMPTZ,
  is_retention_batch INTEGER NOT NULL DEFAULT 0 CHECK (is_retention_batch IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT batches_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

ALTER TABLE users
  ADD CONSTRAINT users_batch_fk
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL;

ALTER TABLE users
  ADD CONSTRAINT users_retention_source_batch_fk
  FOREIGN KEY (retention_source_batch_id) REFERENCES batches(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS batches_branch_name_unique_idx
  ON batches (branch_id, normalized_name);

CREATE INDEX IF NOT EXISTS batches_branch_status_idx
  ON batches (branch_id, status);

CREATE INDEX IF NOT EXISTS batches_coaching_status_idx
  ON batches (coaching_id, status, name);

CREATE INDEX IF NOT EXISTS idx_batches_coaching_created
  ON batches (coaching_id, created_at DESC);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('present', 'absent', 'late')),
  notes TEXT,
  marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT attendance_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id),
  CONSTRAINT attendance_student_date_unique
    UNIQUE (coaching_id, branch_id, student_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_student_date
  ON attendance (student_id, attendance_date);

CREATE INDEX IF NOT EXISTS attendance_branch_date_idx
  ON attendance (branch_id, attendance_date DESC);

CREATE INDEX IF NOT EXISTS attendance_coaching_date_idx
  ON attendance (coaching_id, attendance_date DESC);

CREATE INDEX IF NOT EXISTS attendance_coaching_student_date_idx
  ON attendance (coaching_id, student_id, attendance_date);

CREATE TABLE IF NOT EXISTS fees (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  due_date DATE,
  payment_date DATE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'paid', 'overdue')),
  notes TEXT,
  payment_mode VARCHAR(80),
  receipt_number VARCHAR(40),
  receipt_file_url TEXT,
  receipt_storage_key TEXT,
  receipt_storage_type VARCHAR(20),
  receipt_generated_at TIMESTAMPTZ,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fees_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS idx_fees_student_created
  ON fees (coaching_id, student_id, created_at);

CREATE INDEX IF NOT EXISTS fees_branch_status_idx
  ON fees (branch_id, status, due_date);

CREATE INDEX IF NOT EXISTS fees_branch_due_date_idx
  ON fees (branch_id, due_date)
  WHERE due_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS fees_coaching_created_idx
  ON fees (coaching_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fees_coaching_payment_date_idx
  ON fees (coaching_id, payment_date DESC);

CREATE INDEX IF NOT EXISTS fees_coaching_due_date_idx
  ON fees (coaching_id, due_date DESC);

CREATE TABLE IF NOT EXISTS answer_upload_requests (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  standard VARCHAR(20),
  course VARCHAR(20),
  title VARCHAR(220) NOT NULL,
  description TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT answer_upload_requests_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS answer_requests_branch_created_idx
  ON answer_upload_requests (branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS answer_upload_requests_coaching_created_idx
  ON answer_upload_requests (coaching_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_answer_requests_batch_dates
  ON answer_upload_requests (coaching_id, batch_id, starts_at DESC, ends_at DESC);

CREATE INDEX IF NOT EXISTS idx_answer_requests_group_dates
  ON answer_upload_requests (coaching_id, standard, course, starts_at DESC, ends_at DESC);

CREATE TABLE IF NOT EXISTS test_papers (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  storage_type VARCHAR(20) NOT NULL DEFAULT 'local',
  storage_key TEXT,
  public_url TEXT,
  content_type TEXT,
  size_bytes BIGINT,
  marks_obtained NUMERIC(10,2),
  max_marks NUMERIC(10,2),
  percentage NUMERIC(6,2),
  test_label VARCHAR(220),
  paper_type VARCHAR(40) NOT NULL DEFAULT 'general',
  answer_request_id INTEGER REFERENCES answer_upload_requests(id) ON DELETE SET NULL,
  correct_count INTEGER,
  wrong_count INTEGER,
  unattempted_count INTEGER,
  physics_marks NUMERIC(10,2),
  chemistry_marks NUMERIC(10,2),
  biology_marks NUMERIC(10,2),
  botany_marks NUMERIC(10,2),
  zoology_marks NUMERIC(10,2),
  omr_barcode VARCHAR(120),
  omr_rank INTEGER,
  omr_import_id INTEGER,
  omr_scan_path TEXT,
  omr_scan_original_name TEXT,
  omr_scan_uploaded_at TIMESTAMPTZ,
  upload_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT test_papers_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS idx_test_papers_storage
  ON test_papers (storage_type, storage_key);

CREATE INDEX IF NOT EXISTS idx_test_papers_coaching_student
  ON test_papers (coaching_id, student_id, upload_date);

CREATE INDEX IF NOT EXISTS idx_test_papers_answer_request
  ON test_papers (coaching_id, answer_request_id, student_id, upload_date DESC);

CREATE INDEX IF NOT EXISTS test_papers_branch_upload_idx
  ON test_papers (branch_id, upload_date DESC);

CREATE INDEX IF NOT EXISTS test_papers_coaching_upload_idx
  ON test_papers (coaching_id, upload_date DESC);

CREATE INDEX IF NOT EXISTS test_papers_coaching_student_upload_idx
  ON test_papers (coaching_id, student_id, upload_date DESC);

CREATE INDEX IF NOT EXISTS test_papers_coaching_answer_request_idx
  ON test_papers (coaching_id, answer_request_id, upload_date DESC);

CREATE INDEX IF NOT EXISTS test_papers_omr_scan_branch_idx
  ON test_papers (coaching_id, branch_id, student_id, test_label)
  WHERE omr_scan_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS batch_notes (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  standard VARCHAR(20),
  course VARCHAR(20),
  title VARCHAR(220) NOT NULL,
  resource_url TEXT,
  description TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT batch_notes_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS batch_notes_branch_created_idx
  ON batch_notes (branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS batch_notes_coaching_created_idx
  ON batch_notes (coaching_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_batch_notes_batch
  ON batch_notes (coaching_id, batch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_batch_notes_group
  ON batch_notes (coaching_id, standard, course, created_at DESC);

CREATE TABLE IF NOT EXISTS student_fee_structure (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_fee NUMERIC(12,2) DEFAULT 0,
  paid_fee NUMERIC(12,2) DEFAULT 0,
  pending_fee NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT student_fee_structure_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS student_fee_structure_branch_student_unique_idx
  ON student_fee_structure (branch_id, student_id);

CREATE TABLE IF NOT EXISTS whatsapp_settings (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  access_token TEXT,
  phone_number_id VARCHAR(80),
  business_account_id VARCHAR(80),
  verify_token VARCHAR(160),
  attendance_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  fee_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  result_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  test_paper_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notice_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT whatsapp_settings_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_settings_branch_unique_idx
  ON whatsapp_settings (branch_id);

CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  student_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone_number VARCHAR(20) NOT NULL,
  message_type VARCHAR(40) NOT NULL,
  message_content TEXT,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  meta_message_id VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT whatsapp_logs_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_logs_coaching_created_idx
  ON whatsapp_logs (coaching_id, created_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_logs_meta_message_id_idx
  ON whatsapp_logs (meta_message_id);

CREATE INDEX IF NOT EXISTS whatsapp_logs_branch_created_idx
  ON whatsapp_logs (branch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_logs (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(80) NOT NULL,
  event_type VARCHAR(80),
  message TEXT NOT NULL,
  attachment_url TEXT,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  phone_number VARCHAR(20),
  error_message TEXT,
  event_key VARCHAR(220) UNIQUE,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notification_logs_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS notification_logs_student_type_idx
  ON notification_logs (student_id, type, created_at DESC);

CREATE INDEX IF NOT EXISTS notification_logs_branch_created_idx
  ON notification_logs (branch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_parent_sessions (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER,
  branch_id INTEGER NOT NULL DEFAULT app_current_branch_id(),
  student_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone_number VARCHAR(20) NOT NULL,
  state VARCHAR(80) NOT NULL DEFAULT 'menu',
  last_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT whatsapp_parent_sessions_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_parent_sessions_branch_phone_unique_idx
  ON whatsapp_parent_sessions (branch_id, phone_number);

CREATE TABLE IF NOT EXISTS whatsapp_onboarding_deliveries (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('student', 'parent')),
  phone_number VARCHAR(20) NOT NULL,
  whatsapp_sent BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_sent_at TIMESTAMPTZ,
  whatsapp_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT whatsapp_onboarding_student_recipient_unique
    UNIQUE (student_id, recipient_type),
  CONSTRAINT whatsapp_onboarding_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_onboarding_retry_idx
  ON whatsapp_onboarding_deliveries (whatsapp_sent, retry_count, updated_at)
  WHERE whatsapp_sent = FALSE AND retry_count < 5;

CREATE INDEX IF NOT EXISTS whatsapp_onboarding_branch_student_idx
  ON whatsapp_onboarding_deliveries (coaching_id, branch_id, student_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER,
  branch_id INTEGER DEFAULT app_current_branch_id(),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role VARCHAR(40),
  action VARCHAR(120) NOT NULL,
  target_type VARCHAR(80),
  target_id INTEGER,
  details_json JSONB,
  ip_address VARCHAR(80),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_logs_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS audit_logs_coaching_created_idx
  ON audit_logs (coaching_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trial_requests (
  id SERIAL PRIMARY KEY,
  class_name VARCHAR(220) NOT NULL,
  applicant_name VARCHAR(220) NOT NULL,
  contact_phone VARCHAR(20) NOT NULL,
  email VARCHAR(220) NOT NULL,
  whatsapp_number VARCHAR(20) NOT NULL,
  logo_url TEXT,
  student_requirement INTEGER,
  status VARCHAR(40) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  owner_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS trial_requests_status_created_idx
  ON trial_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS omr_imports (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  test_label VARCHAR(220) NOT NULL,
  original_file_name TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  overwrite_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(40) NOT NULL DEFAULT 'committed',
  error_report JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT omr_imports_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS omr_imports_branch_imported_idx
  ON omr_imports (coaching_id, branch_id, imported_at DESC);

CREATE TABLE IF NOT EXISTS omr_import_rows (
  id SERIAL PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES omr_imports(id) ON DELETE CASCADE,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  student_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  roll_no VARCHAR(80),
  barcode VARCHAR(120),
  test_paper_id INTEGER REFERENCES test_papers(id) ON DELETE SET NULL,
  obtained_marks NUMERIC(10,2),
  max_marks NUMERIC(10,2),
  percentage NUMERIC(6,2),
  correct_count INTEGER,
  wrong_count INTEGER,
  unattempted_count INTEGER,
  physics_marks NUMERIC(10,2),
  chemistry_marks NUMERIC(10,2),
  biology_marks NUMERIC(10,2),
  botany_marks NUMERIC(10,2),
  zoology_marks NUMERIC(10,2),
  rank INTEGER,
  row_status VARCHAR(40) NOT NULL,
  error_message TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT omr_import_rows_branch_coaching_fk
    FOREIGN KEY (branch_id, coaching_id) REFERENCES branches (id, coaching_id)
);

CREATE INDEX IF NOT EXISTS omr_import_rows_import_idx
  ON omr_import_rows (import_id);

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_upload_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_parent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fee_structure ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE branches FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE batches FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance FORCE ROW LEVEL SECURITY;
ALTER TABLE fees FORCE ROW LEVEL SECURITY;
ALTER TABLE test_papers FORCE ROW LEVEL SECURITY;
ALTER TABLE batch_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE answer_upload_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_parent_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE student_fee_structure FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS branches_branch_isolation ON branches;
CREATE POLICY branches_branch_isolation ON branches
  USING (app_is_super_admin() OR id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR id = app_current_branch_id());

DROP POLICY IF EXISTS users_branch_isolation ON users;
CREATE POLICY users_branch_isolation ON users
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (
    app_is_super_admin()
    OR (
      branch_id = app_current_branch_id()
      AND COALESCE(is_owner::TEXT, 'false') NOT IN ('true', '1')
    )
  );

DROP POLICY IF EXISTS batches_branch_isolation ON batches;
CREATE POLICY batches_branch_isolation ON batches
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS attendance_branch_isolation ON attendance;
CREATE POLICY attendance_branch_isolation ON attendance
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS fees_branch_isolation ON fees;
CREATE POLICY fees_branch_isolation ON fees
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS test_papers_branch_isolation ON test_papers;
CREATE POLICY test_papers_branch_isolation ON test_papers
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS batch_notes_branch_isolation ON batch_notes;
CREATE POLICY batch_notes_branch_isolation ON batch_notes
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS answer_upload_requests_branch_isolation ON answer_upload_requests;
CREATE POLICY answer_upload_requests_branch_isolation ON answer_upload_requests
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS notification_logs_branch_isolation ON notification_logs;
CREATE POLICY notification_logs_branch_isolation ON notification_logs
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS whatsapp_logs_branch_isolation ON whatsapp_logs;
CREATE POLICY whatsapp_logs_branch_isolation ON whatsapp_logs
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS whatsapp_settings_branch_isolation ON whatsapp_settings;
CREATE POLICY whatsapp_settings_branch_isolation ON whatsapp_settings
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS whatsapp_parent_sessions_branch_isolation ON whatsapp_parent_sessions;
CREATE POLICY whatsapp_parent_sessions_branch_isolation ON whatsapp_parent_sessions
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS student_fee_structure_branch_isolation ON student_fee_structure;
CREATE POLICY student_fee_structure_branch_isolation ON student_fee_structure
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

DROP POLICY IF EXISTS audit_logs_branch_isolation ON audit_logs;
CREATE POLICY audit_logs_branch_isolation ON audit_logs
  USING (app_is_super_admin() OR branch_id = app_current_branch_id())
  WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id());

COMMIT;
