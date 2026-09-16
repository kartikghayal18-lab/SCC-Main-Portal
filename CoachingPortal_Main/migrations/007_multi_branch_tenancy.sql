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

UPDATE branches branch
SET name = 'SCC - Satpur Branch',
    is_active = TRUE,
    updated_at = CURRENT_TIMESTAMP
FROM coaching_classes coaching
WHERE branch.coaching_id = coaching.id
  AND coaching.slug = 'scc'
  AND branch.code = 'satpur';

INSERT INTO branches (coaching_id, code, name)
SELECT coaching.id, 'satpur', 'SCC - Satpur Branch'
FROM coaching_classes coaching
WHERE coaching.slug = 'scc'
  AND NOT EXISTS (
    SELECT 1
    FROM branches branch
    WHERE branch.coaching_id = coaching.id
      AND branch.code = 'satpur'
  );

UPDATE branches branch
SET name = 'SCC - Meri Branch',
    is_active = TRUE,
    updated_at = CURRENT_TIMESTAMP
FROM coaching_classes coaching
WHERE branch.coaching_id = coaching.id
  AND coaching.slug = 'scc'
  AND branch.code = 'meri';

INSERT INTO branches (coaching_id, code, name)
SELECT coaching.id, 'meri', 'SCC - Meri Branch'
FROM coaching_classes coaching
WHERE coaching.slug = 'scc'
  AND NOT EXISTS (
    SELECT 1
    FROM branches branch
    WHERE branch.coaching_id = coaching.id
      AND branch.code = 'meri'
  );

UPDATE branches branch
SET name = COALESCE(NULLIF(coaching.name, ''), 'Main') || ' - Main Branch',
    is_active = TRUE,
    updated_at = CURRENT_TIMESTAMP
FROM coaching_classes coaching
WHERE branch.coaching_id = coaching.id
  AND coaching.slug <> 'scc'
  AND branch.code = 'main';

INSERT INTO branches (coaching_id, code, name)
SELECT
  coaching.id,
  'main',
  COALESCE(NULLIF(coaching.name, ''), 'Main') || ' - Main Branch'
FROM coaching_classes coaching
WHERE coaching.slug <> 'scc'
  AND NOT EXISTS (
    SELECT 1
    FROM branches branch
    WHERE branch.coaching_id = coaching.id
      AND branch.code = 'main'
  );

DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'users',
    'batches',
    'attendance',
    'fees',
    'test_papers',
    'batch_notes',
    'answer_upload_requests',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_settings',
    'whatsapp_parent_sessions',
    'student_fee_structure',
    'audit_logs'
  ]
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), target_table)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS branch_id INTEGER',
        target_table
      );
    END IF;
  END LOOP;
END $$;

UPDATE users record
SET branch_id = branch.id
FROM coaching_classes coaching
JOIN branches branch
  ON branch.coaching_id = coaching.id
 AND branch.code = CASE WHEN coaching.slug = 'scc' THEN 'satpur' ELSE 'main' END
WHERE record.branch_id IS NULL
  AND record.coaching_id = coaching.id
  AND COALESCE(record.is_owner::TEXT, 'false') NOT IN ('true', '1');

DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'attendance',
    'fees',
    'test_papers',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_parent_sessions',
    'student_fee_structure'
  ]
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), target_table)) IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM information_schema.columns column_info
         WHERE column_info.table_schema = current_schema()
           AND column_info.table_name = target_table
           AND column_info.column_name = 'student_id'
       )
    THEN
      EXECUTE format(
        'UPDATE %I record
         SET coaching_id = student.coaching_id
         FROM users student
         WHERE record.coaching_id IS NULL
           AND record.student_id = student.id
           AND student.coaching_id IS NOT NULL',
        target_table
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  table_name TEXT;
  default_coaching_id INTEGER;
  default_branch_id INTEGER;
  remaining_rows BIGINT;
BEGIN
  SELECT coaching.id, branch.id
  INTO default_coaching_id, default_branch_id
  FROM coaching_classes coaching
  JOIN branches branch
    ON branch.coaching_id = coaching.id
   AND branch.code = CASE WHEN coaching.slug = 'scc' THEN 'satpur' ELSE 'main' END
  ORDER BY CASE WHEN coaching.slug = 'scc' THEN 0 ELSE 1 END, coaching.id
  LIMIT 1;

  FOREACH table_name IN ARRAY ARRAY[
    'batches',
    'attendance',
    'fees',
    'test_papers',
    'batch_notes',
    'answer_upload_requests',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_settings',
    'whatsapp_parent_sessions',
    'student_fee_structure'
  ]
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE %I record
       SET branch_id = branch.id
       FROM coaching_classes coaching
       JOIN branches branch
         ON branch.coaching_id = coaching.id
        AND branch.code = CASE WHEN coaching.slug = ''scc'' THEN ''satpur'' ELSE ''main'' END
       WHERE record.branch_id IS NULL
         AND record.coaching_id = coaching.id',
      table_name
    );

    IF default_branch_id IS NOT NULL THEN
      EXECUTE format(
        'UPDATE %I
         SET coaching_id = COALESCE(coaching_id, $1),
             branch_id = COALESCE(branch_id, $2)
         WHERE coaching_id IS NULL OR branch_id IS NULL',
        table_name
      )
      USING default_coaching_id, default_branch_id;
    END IF;

    EXECUTE format(
      'SELECT COUNT(*) FROM %I WHERE branch_id IS NULL',
      table_name
    )
    INTO remaining_rows;

    IF remaining_rows > 0 THEN
      RAISE EXCEPTION
        'Cannot backfill %.branch_id for % existing row(s): no coaching branch is available',
        table_name,
        remaining_rows;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN branch_id SET NOT NULL',
      table_name
    );
  END LOOP;
END $$;

UPDATE audit_logs record
SET branch_id = branch.id
FROM coaching_classes coaching
JOIN branches branch
  ON branch.coaching_id = coaching.id
 AND branch.code = CASE WHEN coaching.slug = 'scc' THEN 'satpur' ELSE 'main' END
WHERE record.branch_id IS NULL
  AND record.coaching_id = coaching.id;

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

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'batches',
    'attendance',
    'fees',
    'test_papers',
    'batch_notes',
    'answer_upload_requests',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_settings',
    'whatsapp_parent_sessions',
    'student_fee_structure',
    'audit_logs'
  ]
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), table_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN branch_id SET DEFAULT app_current_branch_id()',
        table_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS table_name,
      constraint_row.conname AS constraint_name,
      ARRAY_AGG(attribute.attname::TEXT ORDER BY key_column.ordinality) AS columns
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY
      AS key_column(attnum, ordinality) ON TRUE
    JOIN pg_attribute attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum = key_column.attnum
    WHERE constraint_row.contype = 'u'
      AND namespace.nspname = current_schema()
      AND relation.relname IN (
        'users',
        'batches',
        'whatsapp_settings',
        'student_fee_structure',
        'whatsapp_parent_sessions'
      )
    GROUP BY
      namespace.nspname,
      relation.relname,
      constraint_row.conname
  LOOP
    IF (constraint_record.table_name = 'users'
        AND constraint_record.columns = ARRAY['coaching_id', 'roll_no']::TEXT[])
       OR (constraint_record.table_name = 'users'
           AND constraint_record.columns = ARRAY['coaching_id', 'username']::TEXT[])
       OR (constraint_record.table_name = 'batches'
           AND constraint_record.columns = ARRAY['coaching_id', 'normalized_name']::TEXT[])
       OR (constraint_record.table_name = 'whatsapp_settings'
           AND constraint_record.columns = ARRAY['coaching_id']::TEXT[])
       OR (constraint_record.table_name = 'student_fee_structure'
           AND constraint_record.columns = ARRAY['coaching_id', 'student_id']::TEXT[])
       OR (constraint_record.table_name = 'whatsapp_parent_sessions'
           AND constraint_record.columns = ARRAY['coaching_id', 'phone_number']::TEXT[])
    THEN
      EXECUTE format(
        'ALTER TABLE %I.%I DROP CONSTRAINT %I',
        constraint_record.schema_name,
        constraint_record.table_name,
        constraint_record.constraint_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  index_record RECORD;
BEGIN
  FOR index_record IN
    SELECT
      namespace.nspname AS schema_name,
      index_relation.relname AS index_name,
      ARRAY_AGG(attribute.attname::TEXT ORDER BY key_column.ordinality) AS columns
    FROM pg_index index_row
    JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
    JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
    JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY
      AS key_column(attnum, ordinality) ON key_column.attnum > 0
    JOIN pg_attribute attribute
      ON attribute.attrelid = table_relation.oid
     AND attribute.attnum = key_column.attnum
    WHERE index_row.indisunique
      AND namespace.nspname = current_schema()
      AND table_relation.relname = 'users'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conindid = index_row.indexrelid
      )
    GROUP BY namespace.nspname, index_relation.relname
  LOOP
    IF index_record.columns = ARRAY['coaching_id', 'roll_no']::TEXT[]
       OR index_record.columns = ARRAY['branch_id', 'roll_no']::TEXT[]
    THEN
      EXECUTE format(
        'DROP INDEX %I.%I',
        index_record.schema_name,
        index_record.index_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass(format('%I.users', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS users_branch_role_idx ON users (branch_id, role);
    CREATE UNIQUE INDEX IF NOT EXISTS users_coaching_branch_roll_unique_idx
      ON users (coaching_id, branch_id, roll_no)
      WHERE role = 'student' AND roll_no IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_branch_admin_username_unique_idx
      ON users (branch_id, username)
      WHERE role = 'admin' AND username IS NOT NULL;
  END IF;

  IF to_regclass(format('%I.batches', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS batches_branch_status_idx ON batches (branch_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS batches_branch_name_unique_idx
      ON batches (branch_id, normalized_name);
  END IF;

  IF to_regclass(format('%I.attendance', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS attendance_branch_date_idx
      ON attendance (branch_id, attendance_date DESC);
  END IF;

  IF to_regclass(format('%I.fees', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS fees_branch_status_idx
      ON fees (branch_id, status, due_date);
  END IF;

  IF to_regclass(format('%I.test_papers', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS test_papers_branch_upload_idx
      ON test_papers (branch_id, upload_date DESC);
  END IF;

  IF to_regclass(format('%I.batch_notes', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS batch_notes_branch_created_idx
      ON batch_notes (branch_id, created_at DESC);
  END IF;

  IF to_regclass(format('%I.answer_upload_requests', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS answer_requests_branch_created_idx
      ON answer_upload_requests (branch_id, created_at DESC);
  END IF;

  IF to_regclass(format('%I.notification_logs', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS notification_logs_branch_created_idx
      ON notification_logs (branch_id, created_at DESC);
  END IF;

  IF to_regclass(format('%I.whatsapp_logs', current_schema())) IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS whatsapp_logs_branch_created_idx
      ON whatsapp_logs (branch_id, created_at DESC);
  END IF;

  IF to_regclass(format('%I.whatsapp_settings', current_schema())) IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_settings_branch_unique_idx
      ON whatsapp_settings (branch_id);
  END IF;

  IF to_regclass(format('%I.whatsapp_parent_sessions', current_schema())) IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_parent_sessions_branch_phone_unique_idx
      ON whatsapp_parent_sessions (branch_id, phone_number);
  END IF;

  IF to_regclass(format('%I.student_fee_structure', current_schema())) IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS student_fee_structure_branch_student_unique_idx
      ON student_fee_structure (branch_id, student_id);
  END IF;
END $$;

DO $$
DECLARE
  table_name TEXT;
  constraint_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'batches',
    'attendance',
    'fees',
    'test_papers',
    'batch_notes',
    'answer_upload_requests',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_settings',
    'whatsapp_parent_sessions',
    'student_fee_structure',
    'audit_logs'
  ]
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    constraint_name := table_name || '_branch_coaching_fk';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_row
      WHERE constraint_row.conname = constraint_name
        AND constraint_row.conrelid = to_regclass(
          format('%I.%I', current_schema(), table_name)
        )
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I
         ADD CONSTRAINT %I
         FOREIGN KEY (branch_id, coaching_id)
         REFERENCES branches (id, coaching_id)
         NOT VALID',
        table_name,
        constraint_name
      );
      EXECUTE format(
        'ALTER TABLE %I VALIDATE CONSTRAINT %I',
        table_name,
        constraint_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'branches',
    'users',
    'batches',
    'attendance',
    'fees',
    'test_papers',
    'batch_notes',
    'answer_upload_requests',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_settings',
    'whatsapp_parent_sessions',
    'student_fee_structure',
    'audit_logs'
  ]
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    policy_name := table_name || '_branch_isolation';
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, table_name);

    IF table_name = 'branches' THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I
         USING (app_is_super_admin() OR id = app_current_branch_id())
         WITH CHECK (app_is_super_admin() OR id = app_current_branch_id())',
        policy_name,
        table_name
      );
    ELSIF table_name = 'users' THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I
         USING (app_is_super_admin() OR branch_id = app_current_branch_id())
         WITH CHECK (
           app_is_super_admin()
           OR (
             branch_id = app_current_branch_id()
             AND COALESCE(is_owner::TEXT, ''false'') NOT IN (''true'', ''1'')
           )
         )',
        policy_name,
        table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON %I
         USING (app_is_super_admin() OR branch_id = app_current_branch_id())
         WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id())',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;
