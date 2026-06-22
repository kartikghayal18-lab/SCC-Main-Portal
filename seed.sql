-- Minimal idempotent seed data for the Coaching Portal.
-- Bootstrap password for seeded users: ChangeMe123!
-- All seeded admins have must_change_password = 1.

BEGIN;

SELECT set_config('app.is_super_admin', 'true', true);
SELECT set_config('app.branch_id', '', true);

INSERT INTO subscription_plans (code, name, price_inr, max_students, description, is_active)
VALUES
  ('starter', 'Starter', 0, 250, 'Default starter plan', 1),
  ('premium', 'Premium', 0, NULL, 'Unlimited premium plan', 1)
ON CONFLICT (code)
DO UPDATE SET
  name = EXCLUDED.name,
  price_inr = EXCLUDED.price_inr,
  max_students = EXCLUDED.max_students,
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active;

INSERT INTO coaching_classes (
  name,
  brand_name,
  slug,
  contact_email,
  subscription_plan_id,
  custom_plan_name,
  custom_max_students,
  subscription_status,
  subscription_started_at,
  logo_url,
  theme_primary,
  theme_background,
  theme_surface
)
SELECT
  'SHIV CHHATRAPATI CLASSES',
  'SCC',
  'scc',
  'admin@scc.local',
  plan.id,
  'Premium',
  1000,
  'active',
  CURRENT_TIMESTAMP,
  '/public/scc-logo.svg',
  '#2563eb',
  '#f8fafc',
  '#ffffff'
FROM subscription_plans plan
WHERE plan.code = 'premium'
ON CONFLICT (slug)
DO UPDATE SET
  name = EXCLUDED.name,
  brand_name = EXCLUDED.brand_name,
  contact_email = COALESCE(coaching_classes.contact_email, EXCLUDED.contact_email),
  subscription_plan_id = COALESCE(coaching_classes.subscription_plan_id, EXCLUDED.subscription_plan_id),
  custom_plan_name = COALESCE(coaching_classes.custom_plan_name, EXCLUDED.custom_plan_name),
  custom_max_students = COALESCE(coaching_classes.custom_max_students, EXCLUDED.custom_max_students),
  subscription_status = COALESCE(coaching_classes.subscription_status, EXCLUDED.subscription_status),
  logo_url = EXCLUDED.logo_url,
  theme_primary = EXCLUDED.theme_primary,
  theme_background = EXCLUDED.theme_background,
  theme_surface = EXCLUDED.theme_surface;

INSERT INTO branches (coaching_id, code, name)
SELECT id, 'satpur', 'SCC - Satpur Branch'
FROM coaching_classes
WHERE slug = 'scc'
ON CONFLICT (coaching_id, code)
DO UPDATE SET
  name = EXCLUDED.name,
  is_active = TRUE,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO branches (coaching_id, code, name)
SELECT id, 'meri', 'SCC - Meri Branch'
FROM coaching_classes
WHERE slug = 'scc'
ON CONFLICT (coaching_id, code)
DO UPDATE SET
  name = EXCLUDED.name,
  is_active = TRUE,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO users (
  coaching_id,
  branch_id,
  role,
  is_owner,
  username,
  roll_no,
  name,
  standard,
  course,
  contact_phone,
  email,
  password_hash,
  must_change_password
)
VALUES (
  NULL,
  NULL,
  'admin',
  1,
  'owner',
  NULL,
  'Owner',
  NULL,
  NULL,
  NULL,
  'owner@example.com',
  '$2a$10$SWU6Er2QnTCyytjmjBpsXOqKZR9RvP9sRFY4Ul.aWQwuooUZjXiHO',
  1
)
ON CONFLICT (username) WHERE is_owner = 1
DO UPDATE SET
  name = EXCLUDED.name,
  email = COALESCE(users.email, EXCLUDED.email),
  password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
  must_change_password = COALESCE(users.must_change_password, EXCLUDED.must_change_password);

INSERT INTO users (
  coaching_id,
  branch_id,
  role,
  is_owner,
  username,
  roll_no,
  name,
  standard,
  course,
  contact_phone,
  email,
  password_hash,
  must_change_password
)
SELECT
  coaching.id,
  branch.id,
  'admin',
  0,
  'Nivedita',
  NULL,
  'Satpur Branch Admin',
  NULL,
  NULL,
  NULL,
  'satpur-admin@example.com',
  '$2a$10$JEQqgnNouRaaOqWi4gl/.eVKGBUaf5oTg6HyK3O2fR//apUt/mz1K',
  0
FROM coaching_classes coaching
JOIN branches branch ON branch.coaching_id = coaching.id AND branch.code = 'satpur'
WHERE coaching.slug = 'scc'
ON CONFLICT (branch_id, username) WHERE role = 'admin' AND username IS NOT NULL
DO UPDATE SET
  name = EXCLUDED.name,
  email = COALESCE(users.email, EXCLUDED.email),
  password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
  must_change_password = COALESCE(users.must_change_password, EXCLUDED.must_change_password);

INSERT INTO users (
  coaching_id,
  branch_id,
  role,
  is_owner,
  username,
  roll_no,
  name,
  standard,
  course,
  contact_phone,
  email,
  password_hash,
  must_change_password
)
SELECT
  coaching.id,
  branch.id,
  'admin',
  0,
  'scc-meri-admin',
  NULL,
  'Meri Branch Admin',
  NULL,
  NULL,
  NULL,
  'meri-admin@example.com',
  '$2a$10$jGpNpq8Dq003cQoidWX34e4ByV2DU4WPp5w9xkL5cKuXAJ3Io5JhC',
  0
FROM coaching_classes coaching
JOIN branches branch ON branch.coaching_id = coaching.id AND branch.code = 'meri'
WHERE coaching.slug = 'scc'
ON CONFLICT (branch_id, username) WHERE role = 'admin' AND username IS NOT NULL
DO UPDATE SET
  name = EXCLUDED.name,
  email = COALESCE(users.email, EXCLUDED.email),
  password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
  must_change_password = COALESCE(users.must_change_password, EXCLUDED.must_change_password);

INSERT INTO whatsapp_settings (coaching_id, branch_id, updated_at)
SELECT coaching.id, branch.id, CURRENT_TIMESTAMP
FROM coaching_classes coaching
JOIN branches branch ON branch.coaching_id = coaching.id
WHERE coaching.slug = 'scc'
ON CONFLICT (branch_id)
DO UPDATE SET updated_at = CURRENT_TIMESTAMP;

COMMIT;
