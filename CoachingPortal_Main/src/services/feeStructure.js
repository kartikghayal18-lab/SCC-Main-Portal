const { get, run } = require('../db');
const { getBranchContext } = require('../branch-context');

function normalizeAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

async function ensureFeeStructureSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS student_fee_structure (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      branch_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      total_fee NUMERIC(12,2) DEFAULT 0,
      paid_fee NUMERIC(12,2) DEFAULT 0,
      pending_fee NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (branch_id, student_id)
    )
  `);
}

async function getStudentFeeSummary(coachingId, branchId, studentId) {
  if (studentId === undefined) {
    studentId = branchId;
    branchId = getBranchContext().branchId;
  }
  const structure = await get(
    `SELECT total_fee, paid_fee, pending_fee, updated_at
     FROM student_fee_structure
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
     LIMIT 1`,
    [coachingId, branchId, studentId]
  );

  if (structure) {
    return {
      totalFee: Number(structure.total_fee || 0),
      paidFee: Number(structure.paid_fee || 0),
      pendingFee: Number(structure.pending_fee || 0),
      updatedAt: structure.updated_at || null,
    };
  }

  const legacy = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_fee,
       COALESCE(SUM(CASE WHEN status IN ('pending', 'overdue') THEN amount ELSE 0 END), 0) AS pending_fee
     FROM fees
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`,
    [coachingId, branchId, studentId]
  );
  const paidFee = Number(legacy?.paid_fee || 0);
  const pendingFee = Number(legacy?.pending_fee || 0);
  return {
    totalFee: paidFee + pendingFee,
    paidFee,
    pendingFee,
    updatedAt: null,
  };
}

async function setStudentTotalFee({ coachingId, branchId, studentId, totalFee }) {
  branchId = branchId || getBranchContext().branchId;
  const total = normalizeAmount(totalFee);
  if (!total) {
    throw new Error('Total fee must be greater than zero');
  }
  const existing = await get(
    `SELECT id, paid_fee
     FROM student_fee_structure
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
     LIMIT 1`,
    [coachingId, branchId, studentId]
  );
  const legacy = existing ? null : await getStudentFeeSummary(coachingId, branchId, studentId);
  const paidFee = existing ? Number(existing.paid_fee || 0) : Math.min(Number(legacy.paidFee || 0), total);
  const pendingFee = Math.max(total - paidFee, 0);

  await run(
    `INSERT INTO student_fee_structure (coaching_id, branch_id, student_id, total_fee, paid_fee, pending_fee, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (branch_id, student_id)
     DO UPDATE SET
       total_fee = EXCLUDED.total_fee,
       pending_fee = GREATEST(EXCLUDED.total_fee - student_fee_structure.paid_fee, 0),
       updated_at = CURRENT_TIMESTAMP`,
    [coachingId, branchId, studentId, total, paidFee, pendingFee]
  );

  return getStudentFeeSummary(coachingId, branchId, studentId);
}

async function applyStudentPayment({ coachingId, branchId, studentId, amount }) {
  branchId = branchId || getBranchContext().branchId;
  const paymentAmount = normalizeAmount(amount);
  if (!paymentAmount) {
    throw new Error('Payment amount must be greater than zero');
  }
  const existing = await get(
    `SELECT id
     FROM student_fee_structure
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
     LIMIT 1`,
    [coachingId, branchId, studentId]
  );

  if (!existing) {
    const legacy = await getStudentFeeSummary(coachingId, branchId, studentId);
    const paidFee = Number(legacy.paidFee || paymentAmount);
    const pendingFee = Math.max(Number(legacy.pendingFee || 0) - paymentAmount, 0);
    await run(
      `INSERT INTO student_fee_structure (coaching_id, branch_id, student_id, total_fee, paid_fee, pending_fee, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (branch_id, student_id) DO NOTHING`,
      [
        coachingId,
        branchId,
        studentId,
        paidFee + pendingFee,
        paidFee,
        pendingFee,
      ]
    );
    return getStudentFeeSummary(coachingId, branchId, studentId);
  }

  await run(
    `INSERT INTO student_fee_structure (coaching_id, branch_id, student_id, total_fee, paid_fee, pending_fee, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
     ON CONFLICT (branch_id, student_id)
     DO UPDATE SET
       paid_fee = student_fee_structure.paid_fee + EXCLUDED.paid_fee,
       pending_fee = GREATEST(student_fee_structure.pending_fee - EXCLUDED.paid_fee, 0),
       updated_at = CURRENT_TIMESTAMP`,
    [coachingId, branchId, studentId, paymentAmount, paymentAmount]
  );

  return getStudentFeeSummary(coachingId, branchId, studentId);
}

async function getNextDueDate(coachingId, branchId, studentId) {
  if (studentId === undefined) {
    studentId = branchId;
    branchId = getBranchContext().branchId;
  }
  const row = await get(
    `SELECT MIN(due_date) AS next_due_date
     FROM fees
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
       AND status IN ('pending', 'overdue')
       AND due_date IS NOT NULL`,
    [coachingId, branchId, studentId]
  );
  return row?.next_due_date || null;
}

module.exports = {
  applyStudentPayment,
  ensureFeeStructureSchema,
  getNextDueDate,
  getStudentFeeSummary,
  setStudentTotalFee,
};
