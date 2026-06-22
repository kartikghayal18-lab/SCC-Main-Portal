const fs = require('fs');
const path = require('path');
require('../config/env');

const { getPool, closePool } = require('../config/database');

function getMigrationErrorLocation(sql, position) {
  const offset = Number(position || 0) - 1;
  if (!Number.isInteger(offset) || offset < 0) return null;

  const beforeError = sql.slice(0, offset);
  const line = beforeError.split('\n').length;
  const statementStart = Math.max(
    beforeError.lastIndexOf(';'),
    beforeError.lastIndexOf('$$;')
  ) + 1;
  const statement = sql
    .slice(statementStart, offset + 240)
    .trim()
    .replace(/\s+/g, ' ');

  return { line, statement };
}

async function migrateBranches() {
  const migrationPath = path.join(__dirname, '..', 'migrations', '007_multi_branch_tenancy.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  const validateOnly = process.argv.includes('--validate');
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_super_admin', 'true', true)`);
    await client.query(migrationSql);
    await client.query(validateOnly ? 'ROLLBACK' : 'COMMIT');
    console.log(
      validateOnly
        ? 'Validated migration 007_multi_branch_tenancy.sql (rolled back)'
        : 'Applied migration 007_multi_branch_tenancy.sql'
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    const location = getMigrationErrorLocation(migrationSql, error.position);
    if (location) {
      console.error(`Migration failed near line ${location.line}: ${location.statement}`);
    }
    throw error;
  } finally {
    client.release();
  }
}

migrateBranches()
  .catch((error) => {
    console.error({
      code: error.code || null,
      message: error.message,
      detail: error.detail || null,
      table: error.table || null,
      constraint: error.constraint || null,
    });
    process.exitCode = 1;
  })
  .finally(() => closePool());
