CREATE TABLE IF NOT EXISTS student_fee_structure (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER,
  student_id INTEGER NOT NULL,
  total_fee NUMERIC(12,2) DEFAULT 0,
  paid_fee NUMERIC(12,2) DEFAULT 0,
  pending_fee NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (coaching_id, student_id)
);
