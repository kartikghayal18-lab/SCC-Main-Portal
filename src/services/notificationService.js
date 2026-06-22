const crypto = require('crypto');
const { run, get, all } = require('../db');
const {
  getWhatsAppSettings,
  sendTextMessage,
  sendDocumentMessage,
  sendTemplateMessage,
} = require('./whatsapp');

function cleanPhoneNumber(value) {
  let digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^\d{10}$/.test(digits)) return `91${digits}`;
  if (/^0\d{10}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^910\d{10}$/.test(digits)) return `91${digits.slice(3)}`;
  return digits;
}

function buildEventKey({ studentId, type, message, eventKey }) {
  if (eventKey) return String(eventKey).trim();
  const hash = crypto.createHash('sha256').update(`${studentId}:${type}:${message}`).digest('hex').slice(0, 24);
  return `${studentId}:${type}:${hash}`;
}

async function ensureNotificationSchema() {
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(20)`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_whatsapp_number VARCHAR(20)`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_name VARCHAR(180)`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS attendance_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS fee_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS result_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS test_paper_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS notice_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(40)`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_file_url TEXT`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_storage_key TEXT`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_storage_type VARCHAR(20)`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_generated_at TIMESTAMPTZ`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(80)`);
  await run(`
    CREATE INDEX IF NOT EXISTS fees_branch_due_date_idx
    ON fees (branch_id, due_date)
    WHERE due_date IS NOT NULL
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      branch_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      type VARCHAR(80) NOT NULL,
      event_type VARCHAR(80),
      message TEXT NOT NULL,
      attachment_url TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      phone_number VARCHAR(20),
      error_message TEXT,
      event_key VARCHAR(220) UNIQUE,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS event_type VARCHAR(80)`);
  await run(`ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS attachment_url TEXT`);
  await run(`ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS error_message TEXT`);
  await run(`UPDATE notification_logs SET event_type = type WHERE event_type IS NULL`);

  await run(`
    CREATE TABLE IF NOT EXISTS whatsapp_parent_sessions (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      branch_id INTEGER NOT NULL,
      student_id INTEGER,
      phone_number VARCHAR(20) NOT NULL,
      state VARCHAR(80) NOT NULL DEFAULT 'menu',
      last_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (branch_id, phone_number)
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS notification_logs_student_type_idx
    ON notification_logs (student_id, type, created_at DESC)
  `);
}

function getToggleKeyForType(type) {
  const notificationType = String(type || '').trim();
  if (notificationType.startsWith('attendance_')) return 'attendanceAlertsEnabled';
  if (notificationType.startsWith('fee_')) return 'feeAlertsEnabled';
  if (notificationType.startsWith('test_result_')) return 'resultAlertsEnabled';
  if (notificationType.startsWith('test_paper_')) return 'testPaperAlertsEnabled';
  if (notificationType.startsWith('notice_') || notificationType === 'announcement') return 'noticeAlertsEnabled';
  return null;
}

async function getRecentNotificationLogs(coachingId, branchId, limit = 50) {
  return all(
    `SELECT nl.*, u.roll_no, u.name
     FROM notification_logs nl
     LEFT JOIN users u ON u.id = nl.student_id AND u.branch_id = nl.branch_id
     WHERE nl.coaching_id = ? AND nl.branch_id = ?
     ORDER BY COALESCE(nl.sent_at, nl.created_at) DESC
     LIMIT ?`,
    [coachingId, branchId, limit]
  );
}

async function sendWhatsAppNotification({
  studentId,
  phone,
  type,
  message,
  eventKey = null,
  templateName = null,
  templateLanguage = 'en_US',
  templateComponents = [],
}) {
  console.log('[WHATSAPP] sendWhatsAppNotification input:', {
    studentId,
    phone: cleanPhoneNumber(phone),
    type,
    hasMessage: Boolean(String(message || '').trim()),
    eventKey,
  });
  const student = await get(
    `SELECT id, coaching_id, branch_id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
     FROM users
     WHERE id = ? AND role = 'student'
     LIMIT 1`,
    [studentId]
  );

  if (!student) {
    console.error('[WHATSAPP] Notification skipped: student not found', { studentId, type });
    return { ok: false, skipped: true, reason: 'Student not found' };
  }

  const resolvedPhone = cleanPhoneNumber(
    phone
    || student.parent_whatsapp_number
    || student.guardian_phone
    || student.whatsapp_number
    || student.contact_phone
  );
  const notificationType = String(type || 'whatsapp').trim();
  const notificationMessage = String(message || '').trim();
  const notificationEventKey = buildEventKey({
    studentId: student.id,
    type: notificationType,
    message: notificationMessage,
    eventKey,
  });
  const settings = await getWhatsAppSettings(student.coaching_id, student.branch_id);
  console.log('[WHATSAPP] Notification payload:', {
    coachingId: student.coaching_id,
    studentId: student.id,
    type: notificationType,
    phone: resolvedPhone,
    eventKey: notificationEventKey,
    hasAccessToken: Boolean(settings.accessToken),
    phoneNumberId: settings.phoneNumberId || null,
    messagePreview: notificationMessage.slice(0, 160),
  });
  const toggleKey = getToggleKeyForType(notificationType);
  if (toggleKey && settings[toggleKey] === false) {
    console.error('[WHATSAPP] Notification skipped: disabled by settings', {
      studentId: student.id,
      type: notificationType,
      toggleKey,
    });
    return { ok: false, skipped: true, reason: 'Notification type disabled' };
  }

  const existing = await get(
    `SELECT id, status
     FROM notification_logs
     WHERE event_key = ? AND branch_id = ?
     LIMIT 1`,
    [notificationEventKey, student.branch_id]
  );
  if (existing) {
    console.log('[WHATSAPP] Notification skipped: duplicate event key', {
      logId: existing.id,
      status: existing.status,
      eventKey: notificationEventKey,
    });
    return { ok: true, skipped: true, duplicate: true, logId: existing.id, status: existing.status };
  }

  const logResult = await run(
    `INSERT INTO notification_logs (
      coaching_id, branch_id, student_id, type, event_type, message, status, phone_number, event_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_key) DO NOTHING`,
    [
      student.coaching_id,
      student.branch_id,
      student.id,
      notificationType,
      notificationType,
      notificationMessage,
      'pending',
      resolvedPhone || null,
      notificationEventKey,
    ]
  );
  const logId = logResult.lastID;
  if (!logId) {
    const duplicate = await get(
      `SELECT id, status
       FROM notification_logs
       WHERE event_key = ? AND branch_id = ?
       LIMIT 1`,
      [notificationEventKey, student.branch_id]
    );
    return {
      ok: true,
      skipped: true,
      duplicate: true,
      logId: duplicate?.id || null,
      status: duplicate?.status || null,
    };
  }

  if (!resolvedPhone) {
    await run(
      `UPDATE notification_logs SET status = ?, error_message = ? WHERE id = ? AND branch_id = ?`,
      ['skipped', 'WhatsApp number missing', logId, student.branch_id]
    );
    console.error('[WHATSAPP] Notification skipped: phone missing', { logId, studentId: student.id });
    return { ok: false, skipped: true, reason: 'WhatsApp number missing', logId };
  }

  try {
    console.log(`[WHATSAPP] Sending ${templateName ? 'template' : 'text'} notification`, {
      logId,
      studentId: student.id,
      phone: resolvedPhone,
      type: notificationType,
      templateName,
      templateLanguage,
    });
    const result = templateName
      ? await sendTemplateMessage({
        coachingId: student.coaching_id,
        branchId: student.branch_id,
        studentId: student.id,
        to: resolvedPhone,
        templateName,
        languageCode: templateLanguage,
        components: templateComponents,
        settings,
      })
      : await sendTextMessage({
        coachingId: student.coaching_id,
        branchId: student.branch_id,
        studentId: student.id,
        to: resolvedPhone,
        message: notificationMessage,
        settings,
      });
    console.log('[WHATSAPP] Notification response:', result);
    if (result?.failed) {
      console.error('[WHATSAPP] Notification API failure:', {
        studentId: student.id,
        type: notificationType,
        phone: resolvedPhone,
        templateName,
        templateLanguage: templateName ? templateLanguage : null,
        error: result.error || 'WhatsApp send failed',
      });
      await run(
        `UPDATE notification_logs
         SET status = ?, error_message = ?
         WHERE id = ? AND branch_id = ?`,
        ['failed', result.error || 'WhatsApp send failed', logId, student.branch_id]
      );
      return { ok: false, failed: true, error: result.error || 'WhatsApp send failed', logId };
    }
    await run(
      `UPDATE notification_logs
       SET status = ?, sent_at = CURRENT_TIMESTAMP
       WHERE id = ? AND branch_id = ?`,
      ['sent', logId, student.branch_id]
    );
    return { ok: true, logId, metaMessageId: result.metaMessageId };
  } catch (error) {
    console.error('[WHATSAPP] Notification failed', {
      studentId: student.id,
      type: notificationType,
      phone: resolvedPhone,
      templateName,
      templateLanguage: templateName ? templateLanguage : null,
      error: error.message,
    });
    await run(
      `UPDATE notification_logs
       SET status = ?, error_message = ?
       WHERE id = ? AND branch_id = ?`,
      ['failed', error.message, logId, student.branch_id]
    );
    return { ok: false, failed: true, error: error.message, logId };
  }
}

async function sendDocumentNotification(
  studentId,
  phone,
  fileUrl,
  fileName,
  caption,
  options = {}
) {
  const student = await get(
    `SELECT id, coaching_id, branch_id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
     FROM users
     WHERE id = ? AND role = 'student'
     LIMIT 1`,
    [studentId]
  );

  if (!student) {
    return { ok: false, skipped: true, reason: 'Student not found' };
  }

  const resolvedPhone = cleanPhoneNumber(phone);
  const notificationType = String(options.type || 'document').trim();
  const notificationMessage = String(caption || '').trim();
  const notificationEventKey = buildEventKey({
    studentId: student.id,
    type: notificationType,
    message: `${notificationMessage}:${fileUrl}:${fileName}`,
    eventKey: options.eventKey || null,
  });
  const settings = await getWhatsAppSettings(student.coaching_id, student.branch_id);
  const toggleKey = getToggleKeyForType(notificationType);
  if (toggleKey && settings[toggleKey] === false) {
    return { ok: false, skipped: true, reason: 'Notification type disabled' };
  }

  const existing = await get(
    `SELECT id, status
     FROM notification_logs
     WHERE event_key = ? AND branch_id = ?
     LIMIT 1`,
    [notificationEventKey, student.branch_id]
  );
  let logId = null;
  if (existing) {
    if (!options.retryFailed || existing.status === 'sent') {
      return { ok: true, skipped: true, duplicate: true, logId: existing.id, status: existing.status };
    }

    await run(
      `UPDATE notification_logs
       SET message = ?, attachment_url = ?, status = ?, phone_number = ?, error_message = NULL
       WHERE id = ? AND branch_id = ?`,
      [
        notificationMessage || fileName || fileUrl,
        fileUrl || null,
        'pending',
        resolvedPhone || null,
        existing.id,
        student.branch_id,
      ]
    );
    logId = existing.id;
  } else {
    const logResult = await run(
      `INSERT INTO notification_logs (
        coaching_id, branch_id, student_id, type, event_type, message, attachment_url, status, phone_number, event_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        student.coaching_id,
        student.branch_id,
        student.id,
        notificationType,
        notificationType,
        notificationMessage || fileName || fileUrl,
        fileUrl || null,
        'pending',
        resolvedPhone || null,
        notificationEventKey,
      ]
    );
    logId = logResult.lastID;
  }

  if (!resolvedPhone) {
    await run(`UPDATE notification_logs SET status = ?, error_message = ? WHERE id = ? AND branch_id = ?`, ['skipped', 'WhatsApp number missing', logId, student.branch_id]);
    return { ok: false, skipped: true, reason: 'WhatsApp number missing', logId };
  }

  if (!fileUrl) {
    await run(`UPDATE notification_logs SET status = ?, error_message = ? WHERE id = ? AND branch_id = ?`, ['failed', 'Document URL missing', logId, student.branch_id]);
    return { ok: false, skipped: true, reason: 'Document URL missing', logId };
  }

  try {
    const result = await sendDocumentMessage({
      coachingId: student.coaching_id,
      studentId: student.id,
      to: resolvedPhone,
      documentUrl: fileUrl,
      filename: fileName || 'paper.pdf',
      caption: notificationMessage,
      settings,
    });
    if (result?.failed) {
      await run(
        `UPDATE notification_logs
         SET status = ?, error_message = ?
         WHERE id = ? AND branch_id = ?`,
        ['failed', result.error || 'WhatsApp document send failed', logId, student.branch_id]
      );
      return { ok: false, failed: true, error: result.error || 'WhatsApp document send failed', logId };
    }
    await run(
      `UPDATE notification_logs
       SET status = ?, sent_at = CURRENT_TIMESTAMP
       WHERE id = ? AND branch_id = ?`,
      ['sent', logId, student.branch_id]
    );
    return { ok: true, logId, metaMessageId: result.metaMessageId };
  } catch (error) {
    console.error('WhatsApp document notification failed', {
      studentId: student.id,
      type: notificationType,
      phone: resolvedPhone,
      fileUrl,
      error: error.message,
    });
    await run(
      `UPDATE notification_logs
       SET status = ?, error_message = ?
       WHERE id = ? AND branch_id = ?`,
      ['failed', error.message, logId, student.branch_id]
    );
    return { ok: false, failed: true, error: error.message, logId };
  }
}

module.exports = {
  ensureNotificationSchema,
  getRecentNotificationLogs,
  sendDocumentNotification,
  sendWhatsAppNotification,
};
