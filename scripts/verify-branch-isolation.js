require('../config/env');

const { all, get, closePool } = require('../config/database');
const { getCurrentBranchId, runWithBranchContext } = require('../src/branch-context');

const ISOLATED_TABLES = [
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
];

function verifySessionHelper(branch) {
  const resolved = getCurrentBranchId({
    session: {
      user: {
        branchId: branch.id,
      },
    },
  });
  if (resolved !== Number(branch.id)) {
    throw new Error(`Session branch helper failed for ${branch.name}`);
  }
}

async function verifyBranch(branch, otherBranch) {
  verifySessionHelper(branch);

  return runWithBranchContext({ branchId: branch.id, isSuperAdmin: false }, async () => {
    const visibleBranch = await get(
      `SELECT id, name FROM branches WHERE id = ? AND coaching_id = ?`,
      [branch.id, branch.coaching_id]
    );
    const hiddenBranch = await get(
      `SELECT id FROM branches WHERE id = ? AND id = ?`,
      [otherBranch.id, branch.id]
    );
    if (!visibleBranch || hiddenBranch) {
      throw new Error(`Branch identity check failed for ${branch.name}`);
    }

    const counts = {};
    for (const tableName of ISOLATED_TABLES) {
      const rows = await all(
        `SELECT id, branch_id FROM ${tableName} WHERE branch_id = ?`,
        [branch.id]
      );
      const leaked = rows.find((row) => Number(row.branch_id) !== Number(branch.id));
      if (leaked) {
        throw new Error(`${tableName} returned a cross-branch row for ${branch.name}`);
      }

      const otherRecord = await get(
        `SELECT id FROM ${tableName} WHERE branch_id = ? ORDER BY id LIMIT 1`,
        [otherBranch.id]
      );
      if (otherRecord) {
        const manipulatedLookup = await get(
          `SELECT id FROM ${tableName} WHERE id = ? AND branch_id = ?`,
          [otherRecord.id, branch.id]
        );
        if (manipulatedLookup) {
          throw new Error(`${tableName} allowed a cross-branch ID lookup for ${branch.name}`);
        }
      }

      counts[tableName] = rows.length;
    }
    return counts;
  });
}

async function main() {
  let rejectedMissingBranch = false;
  try {
    getCurrentBranchId({ session: { user: {} } });
  } catch (error) {
    rejectedMissingBranch = error.status === 403;
  }
  if (!rejectedMissingBranch) {
    throw new Error('getCurrentBranchId must reject a missing branch session');
  }

  const branches = await runWithBranchContext({ isSuperAdmin: true }, () => all(
    `SELECT b.id, b.coaching_id, b.code, b.name
     FROM branches b
     JOIN coaching_classes cc ON cc.id = b.coaching_id
     WHERE cc.slug = 'scc' AND b.code IN ('satpur', 'meri')
     ORDER BY b.code`
  ));

  if (branches.length !== 2) {
    throw new Error('Expected both SCC branches. Run npm run migrate:branches and npm run seed:branches first.');
  }

  const rollIndex = await runWithBranchContext({ isSuperAdmin: true }, () => get(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = 'users'
       AND indexname = 'users_coaching_branch_roll_unique_idx'
     LIMIT 1`
  ));
  if (!rollIndex || !rollIndex.indexdef.includes('(coaching_id, branch_id, roll_no)')) {
    throw new Error('Missing unique student roll index on (coaching_id, branch_id, roll_no)');
  }

  const duplicateRoll = await runWithBranchContext({ isSuperAdmin: true }, () => get(
    `SELECT coaching_id, branch_id, roll_no, COUNT(*) AS total
     FROM users
     WHERE role = 'student' AND roll_no IS NOT NULL
     GROUP BY coaching_id, branch_id, roll_no
     HAVING COUNT(*) > 1
     LIMIT 1`
  ));
  if (duplicateRoll) {
    throw new Error(`Duplicate roll number exists inside branch ${duplicateRoll.branch_id}: ${duplicateRoll.roll_no}`);
  }

  for (const branch of branches) {
    const otherBranch = branches.find((candidate) => candidate.id !== branch.id);
    const counts = await verifyBranch(branch, otherBranch);
    console.log(`${branch.name}: explicit branch isolation passed`, counts);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
