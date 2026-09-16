const bcrypt = require('bcryptjs');
require('../config/env');

const { get, run, closePool } = require('../config/database');
const { runWithBranchContext } = require('../src/branch-context');

async function seedBranches() {
  await runWithBranchContext({ isSuperAdmin: true }, async () => {
    const coaching = await get(
      `SELECT id FROM coaching_classes WHERE slug = ? LIMIT 1`,
      ['scc']
    );

    if (!coaching) {
      throw new Error('The SCC coaching tenant was not found. Create it before seeding branches.');
    }

    await run(
      `INSERT INTO branches (coaching_id, code, name)
       VALUES (?, 'satpur', 'SCC - Satpur Branch')
       ON CONFLICT (coaching_id, code)
       DO UPDATE SET name = EXCLUDED.name, is_active = TRUE`,
      [coaching.id]
    );
    await run(
      `INSERT INTO branches (coaching_id, code, name)
       VALUES (?, 'meri', 'SCC - Meri Branch')
       ON CONFLICT (coaching_id, code)
       DO UPDATE SET name = EXCLUDED.name, is_active = TRUE`,
      [coaching.id]
    );

    const satpur = await get(
      `SELECT id FROM branches WHERE coaching_id = ? AND code = 'satpur'`,
      [coaching.id]
    );
    const meri = await get(
      `SELECT id FROM branches WHERE coaching_id = ? AND code = 'meri'`,
      [coaching.id]
    );

    await run(
      `UPDATE users
       SET branch_id = ?
       WHERE coaching_id = ? AND role = 'admin' AND is_owner = 0 AND branch_id IS NULL`,
      [satpur.id, coaching.id]
    );

    const existingMeriAdmin = await get(
      `SELECT id FROM users
       WHERE coaching_id = ? AND branch_id = ? AND role = 'admin' AND is_owner = 0
       LIMIT 1`,
      [coaching.id, meri.id]
    );

    if (!existingMeriAdmin) {
      const satpurAdmin = await get(
        `SELECT password_hash, email, contact_phone
         FROM users
         WHERE coaching_id = ? AND branch_id = ? AND role = 'admin' AND is_owner = 0
         ORDER BY id ASC
         LIMIT 1`,
        [coaching.id, satpur.id]
      );

      if (!satpurAdmin) {
        throw new Error('A Satpur admin must exist before the Meri admin can be seeded.');
      }

      const configuredPassword = String(process.env.MERI_ADMIN_PASSWORD || '').trim();
      const passwordHash = configuredPassword
        ? await bcrypt.hash(configuredPassword, 10)
        : satpurAdmin.password_hash;

      await run(
        `INSERT INTO users (
          coaching_id, branch_id, role, is_owner, username, name, email,
          contact_phone, password_hash, must_change_password
        ) VALUES (?, ?, 'admin', 0, ?, ?, ?, ?, ?, 1)`,
        [
          coaching.id,
          meri.id,
          String(process.env.MERI_ADMIN_USERNAME || 'scc-meri-admin').trim(),
          String(process.env.MERI_ADMIN_NAME || 'Meri Branch Admin').trim(),
          String(process.env.MERI_ADMIN_EMAIL || satpurAdmin.email || '').trim() || null,
          String(process.env.MERI_ADMIN_PHONE || satpurAdmin.contact_phone || '').trim() || null,
          passwordHash,
        ]
      );
    }

    console.log('Seeded SCC - Satpur Branch and SCC - Meri Branch.');
    console.log('Meri admin username:', process.env.MERI_ADMIN_USERNAME || 'scc-meri-admin');
    if (!process.env.MERI_ADMIN_PASSWORD) {
      console.log('Meri admin temporarily uses the Satpur admin password and must change it at first login.');
    }
  });
}

seedBranches()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
