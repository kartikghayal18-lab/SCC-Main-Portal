ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_name VARCHAR(180);
ALTER TABLE fees ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(80);

CREATE INDEX IF NOT EXISTS fees_branch_due_date_idx
  ON fees (branch_id, due_date)
  WHERE due_date IS NOT NULL;

UPDATE coaching_classes
SET brand_name = 'SCC',
    logo_url = '/public/scc-logo.svg'
WHERE LOWER(COALESCE(slug, '')) = 'scc'
   OR LOWER(COALESCE(name, '')) LIKE 'scc%';
