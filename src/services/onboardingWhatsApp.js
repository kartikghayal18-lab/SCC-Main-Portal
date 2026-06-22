const { run, get, all } = require('../db');
const { sendWhatsAppNotification } = require('./notificationService');

const TEMPLATE_NAME = 'admission_confirmed';
const TEMPLATE_LANGUAGE = 'en';
const MAX_RETRY_COUNT = 5;

function cleanPhoneNumber(value) {
  let digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^\d{10}$/.test(digits)) return `91${digits}`;
  if (/^0\d{10}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^910\d{10}$/.test(digits)) return `91${digits.slice(3)}`;
  return digits;
}

async function ensureOnboardingWhatsAppSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS whatsapp_onboarding_deliveries (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('student', 'parent')),
      phone_number VARCHAR(20) NOT NULL,
      whatsapp_sent BOOLEAN NOT NULL DEFAULT FALSE,
      whatsapp_sent_at TIMESTAMPTZ,
      whatsapp_error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (student_id, recipient_type)
    )
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS whatsapp_onboarding_retry_idx
    ON whatsapp_onboarding_deliveries (whatsapp_sent, retry_count, updated_at)
    WHERE whatsapp_sent = FALSE AND retry_count < 5
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS whatsapp_onboarding_branch_student_idx
    ON whatsapp_onboarding_deliveries (coaching_id, branch_id, student_id)
  `);
}

async function getStudentOnboardingData(studentId, coachingId = null, branchId = null) {
  const params = [studentId];
  let scope = '';
  if (coachingId && branchId) {
    params.push(coachingId, branchId);
    scope = ' AND u.coaching_id = ? AND u.branch_id = ?';
  }

  return get(
    `SELECT u.id, u.coaching_id, u.branch_id, u.name, u.roll_no, u.parent_name,
            u.contact_phone, u.whatsapp_number, u.guardian_phone, u.parent_whatsapp_number,
            COALESCE(b.name, 'Assigned batch') AS batch_name,
            COALESCE(br.name, 'SCC') AS branch_name,
            COALESCE(sfs.total_fee, 0) AS total_fee,
            COALESCE(sfs.pending_fee, 0) AS pending_fee
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = u.branch_id
     LEFT JOIN branches br ON br.id = u.branch_id
     LEFT JOIN student_fee_structure sfs
       ON sfs.student_id = u.id AND sfs.branch_id = u.branch_id
     WHERE u.id = ? AND u.role = 'student'${scope}
     LIMIT 1`,
    params
  );
}

function buildAdmissionMessage(student) {
  return [
    'SHIV CHHATRAPATI CLASSES',
    'Admission Confirmed',
    `Student: ${student.name}`,
    `Roll No: ${student.roll_no}`,
    `Batch: ${student.batch_name}`,
    `Total Fees: Rs.${Number(student.total_fee || 0).toFixed(2)}`,
    `Pending Fees: Rs.${Number(student.pending_fee || 0).toFixed(2)}`,
    'Your child is now registered successfully.',
    'Welcome to our coaching family.',
  ].join('\n');
}

function buildTemplateComponents(student, recipientType) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: recipientType === 'parent' ? student.parent_name || 'Parent' : student.name },
      { type: 'text', text: student.name },
      { type: 'text', text: student.roll_no },
      { type: 'text', text: student.branch_name },
    ],
  }];
}

async function ensureRecipientRows(student) {
  const recipients = [
    { type: 'student', phone: student.whatsapp_number || student.contact_phone },
    { type: 'parent', phone: student.parent_whatsapp_number || student.guardian_phone },
  ];

  for (const recipient of recipients) {
    const phone = cleanPhoneNumber(recipient.phone);
    if (!phone) continue;
    await run(
      `INSERT INTO whatsapp_onboarding_deliveries (
         coaching_id, branch_id, student_id, recipient_type, phone_number
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (student_id, recipient_type)
       DO UPDATE SET
         phone_number = EXCLUDED.phone_number,
         updated_at = CASE
           WHEN whatsapp_onboarding_deliveries.phone_number <> EXCLUDED.phone_number
             THEN CURRENT_TIMESTAMP
           ELSE whatsapp_onboarding_deliveries.updated_at
         END,
         whatsapp_sent = CASE
           WHEN whatsapp_onboarding_deliveries.phone_number <> EXCLUDED.phone_number
             THEN FALSE
           ELSE whatsapp_onboarding_deliveries.whatsapp_sent
         END,
         whatsapp_sent_at = CASE
           WHEN whatsapp_onboarding_deliveries.phone_number <> EXCLUDED.phone_number
             THEN NULL
           ELSE whatsapp_onboarding_deliveries.whatsapp_sent_at
         END,
         whatsapp_error = CASE
           WHEN whatsapp_onboarding_deliveries.phone_number <> EXCLUDED.phone_number
             THEN NULL
           ELSE whatsapp_onboarding_deliveries.whatsapp_error
         END,
         retry_count = CASE
           WHEN whatsapp_onboarding_deliveries.phone_number <> EXCLUDED.phone_number
             THEN 0
           ELSE whatsapp_onboarding_deliveries.retry_count
         END`,
      [student.coaching_id, student.branch_id, student.id, recipient.type, phone]
    );
  }
}

async function sendDelivery(delivery, student, { manual = false } = {}) {
  if (delivery.whatsapp_sent && !manual) {
    return { ok: true, skipped: true, reason: 'Already delivered' };
  }

  const attempt = Number(delivery.retry_count || 0) + 1;
  console.log('[WHATSAPP ONBOARDING] Attempt started', {
    deliveryId: delivery.id,
    studentId: student.id,
    branchId: student.branch_id,
    recipientType: delivery.recipient_type,
    attempt,
    manual,
  });

  try {
    const result = await sendWhatsAppNotification({
      studentId: student.id,
      phone: delivery.phone_number,
      type: 'admission_confirmed',
      message: buildAdmissionMessage(student),
      eventKey: `admission_confirmed:${delivery.recipient_type}:${student.id}:attempt:${attempt}:${Date.now()}`,
      templateName: TEMPLATE_NAME,
      templateLanguage: TEMPLATE_LANGUAGE,
      templateComponents: buildTemplateComponents(student, delivery.recipient_type),
    });

    if (!result?.ok || result?.failed || result?.skipped) {
      throw new Error(result?.error || result?.reason || 'WhatsApp onboarding delivery failed');
    }

    await run(
      `UPDATE whatsapp_onboarding_deliveries
       SET whatsapp_sent = TRUE,
           whatsapp_sent_at = CURRENT_TIMESTAMP,
           whatsapp_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
      [delivery.id, student.coaching_id, student.branch_id]
    );
    console.log('[WHATSAPP ONBOARDING] Delivered', {
      deliveryId: delivery.id,
      studentId: student.id,
      recipientType: delivery.recipient_type,
      attempt,
      metaMessageId: result.metaMessageId || null,
    });
    return { ok: true, metaMessageId: result.metaMessageId || null };
  } catch (error) {
    await run(
      `UPDATE whatsapp_onboarding_deliveries
       SET whatsapp_sent = FALSE,
           whatsapp_error = ?,
           retry_count = retry_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
      [error.message, delivery.id, student.coaching_id, student.branch_id]
    );
    console.error('[WHATSAPP ONBOARDING] Attempt failed', {
      deliveryId: delivery.id,
      studentId: student.id,
      recipientType: delivery.recipient_type,
      attempt,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }
}

async function sendStudentOnboarding(studentId, {
  coachingId = null,
  branchId = null,
  manual = false,
} = {}) {
  const student = await getStudentOnboardingData(studentId, coachingId, branchId);
  if (!student) return { ok: false, error: 'Student not found', sent: 0, failed: 0 };

  await ensureRecipientRows(student);
  const deliveries = await all(
    `SELECT *
     FROM whatsapp_onboarding_deliveries
     WHERE student_id = ? AND coaching_id = ? AND branch_id = ?
     ORDER BY recipient_type`,
    [student.id, student.coaching_id, student.branch_id]
  );

  const summary = { ok: true, sent: 0, failed: 0, skipped: 0 };
  for (const delivery of deliveries) {
    const result = await sendDelivery(delivery, student, { manual });
    if (result.ok && result.skipped) summary.skipped += 1;
    else if (result.ok) summary.sent += 1;
    else {
      summary.ok = false;
      summary.failed += 1;
    }
  }
  return summary;
}

async function retryPendingOnboarding(limit = 50) {
  const deliveries = await all(
    `UPDATE whatsapp_onboarding_deliveries
     SET updated_at = CURRENT_TIMESTAMP
     WHERE id IN (
       SELECT id
       FROM whatsapp_onboarding_deliveries
       WHERE whatsapp_sent = FALSE
         AND retry_count < ?
         AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '4 minutes'
       ORDER BY updated_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ?
     )
     RETURNING *`,
    [MAX_RETRY_COUNT, limit]
  );
  const summary = { attempted: 0, sent: 0, failed: 0 };

  for (const delivery of deliveries) {
    const student = await getStudentOnboardingData(
      delivery.student_id,
      delivery.coaching_id,
      delivery.branch_id
    );
    if (!student) continue;
    summary.attempted += 1;
    const result = await sendDelivery(delivery, student);
    if (result.ok) summary.sent += 1;
    else summary.failed += 1;
  }
  console.log('[WHATSAPP ONBOARDING] Retry run completed', summary);
  return summary;
}

async function getStudentOnboardingStatus(coachingId, branchId, studentId) {
  const deliveries = await all(
    `SELECT recipient_type, phone_number, whatsapp_sent, whatsapp_sent_at,
            whatsapp_error, retry_count
     FROM whatsapp_onboarding_deliveries
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
     ORDER BY recipient_type`,
    [coachingId, branchId, studentId]
  );
  return {
    deliveries,
    delivered: deliveries.length > 0 && deliveries.every((delivery) => delivery.whatsapp_sent),
    failed: deliveries.some((delivery) => !delivery.whatsapp_sent && delivery.whatsapp_error),
  };
}

module.exports = {
  ensureOnboardingWhatsAppSchema,
  getStudentOnboardingStatus,
  retryPendingOnboarding,
  sendStudentOnboarding,
};
