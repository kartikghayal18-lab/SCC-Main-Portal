ALTER TABLE users ADD COLUMN IF NOT EXISTS omr_barcode VARCHAR(120);

ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS percentage NUMERIC(6,2);
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS correct_count INTEGER;
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS wrong_count INTEGER;
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS unattempted_count INTEGER;
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS physics_marks NUMERIC(10,2);
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS chemistry_marks NUMERIC(10,2);
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS biology_marks NUMERIC(10,2);
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS botany_marks NUMERIC(10,2);
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS zoology_marks NUMERIC(10,2);
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_barcode VARCHAR(120);
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_rank INTEGER;
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_import_id INTEGER;
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_scan_path TEXT;
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_scan_original_name TEXT;
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_scan_uploaded_at TIMESTAMPTZ;

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
  imported_by INTEGER,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS omr_imports_branch_imported_idx
  ON omr_imports (coaching_id, branch_id, imported_at DESC);

CREATE TABLE IF NOT EXISTS omr_import_rows (
  id SERIAL PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES omr_imports(id) ON DELETE CASCADE,
  coaching_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  student_id INTEGER,
  roll_no VARCHAR(80),
  barcode VARCHAR(120),
  test_paper_id INTEGER,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS omr_import_rows_import_idx
  ON omr_import_rows (import_id);

ALTER TABLE omr_import_rows ADD COLUMN IF NOT EXISTS biology_marks NUMERIC(10,2);
ALTER TABLE omr_import_rows ADD COLUMN IF NOT EXISTS rank INTEGER;

CREATE INDEX IF NOT EXISTS test_papers_omr_scan_branch_idx
  ON test_papers (coaching_id, branch_id, student_id, test_label)
  WHERE omr_scan_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_omr_barcode_branch_idx
  ON users (coaching_id, branch_id, omr_barcode);
