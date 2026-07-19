const { run, get, all } = require('../db');

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
const GRAPH_API_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function cleanPhoneNumber(value) {
  let digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^\d{10}$/.test(digits)) return `91${digits}`;
  if (/^0\d{10}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^910\d{10}$/.test(digits)) return `91${digits.slice(3)}`;
  return digits;
}

function normalizeStatus(value) {
  return String(value || 'pending').trim().toLowerCase().slice(0, 40);
}

function truncateMessage(value) {
  return String(value || '').slice(0, 4000);
}

function getMetaErrorCode(error) {
  return error?.response?.error?.code || error?.response?.error?.error_subcode || null;
}

function getEnvSettings() {
  return {
    accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    businessAccountId: String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim(),
    verifyToken: String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim(),
  };
}

function normalizeSettings(row = null) {
  const env = getEnvSettings();
  return {
    accessToken: String(row?.access_token || env.accessToken || '').trim(),
    phoneNumberId: String(row?.phone_number_id || env.phoneNumberId || '').trim(),
    businessAccountId: String(row?.business_account_id || env.businessAccountId || '').trim(),
    verifyToken: String(row?.verify_token || env.verifyToken || '').trim(),
    attendanceAlertsEnabled: row?.attendance_alerts_enabled !== false,
    feeAlertsEnabled: row?.fee_alerts_enabled !== false,
    resultAlertsEnabled: row?.result_alerts_enabled !== false,
    testPaperAlertsEnabled: row?.test_paper_alerts_enabled !== false,
    noticeAlertsEnabled: row?.notice_alerts_enabled !== false,
  };
}

async function ensureWhatsAppSchema() {
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(20)`);

  await run(`
    CREATE TABLE IF NOT EXISTS whatsapp_settings (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      access_token TEXT,
      phone_number_id VARCHAR(80),
      business_account_id VARCHAR(80),
      verify_token VARCHAR(160),
      attendance_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      fee_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      result_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      test_paper_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      notice_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS attendance_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS fee_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS result_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS test_paper_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS notice_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);

  await run(`
    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      branch_id INTEGER NOT NULL,
      student_id INTEGER,
      phone_number VARCHAR(20) NOT NULL,
      message_type VARCHAR(40) NOT NULL,
      message_content TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      meta_message_id VARCHAR(160),
      document_url TEXT,
      document_filename VARCHAR(255),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      resent_at TIMESTAMPTZ,
      resent_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS document_url TEXT`);
  await run(`ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS document_filename VARCHAR(255)`);
  await run(`ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS last_error TEXT`);
  await run(`ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS resent_at TIMESTAMPTZ`);
  await run(`ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS resent_by INTEGER`);

  await run(`
    CREATE INDEX IF NOT EXISTS whatsapp_logs_coaching_created_idx
    ON whatsapp_logs (coaching_id, created_at DESC)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS whatsapp_logs_meta_message_id_idx
    ON whatsapp_logs (meta_message_id)
  `);
}

async function getWhatsAppSettings(coachingId, branchId) {
  const row = coachingId && branchId
    ? await get(`SELECT * FROM whatsapp_settings WHERE coaching_id = ? AND branch_id = ? LIMIT 1`, [coachingId, branchId])
    : null;
  return normalizeSettings(row);
}

async function saveWhatsAppSettings(coachingId, branchId, settings, updatedBy = null) {
  await run(
    `INSERT INTO whatsapp_settings (
      coaching_id, branch_id, access_token, phone_number_id, business_account_id, verify_token,
      attendance_alerts_enabled, fee_alerts_enabled, result_alerts_enabled, test_paper_alerts_enabled, notice_alerts_enabled,
      updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (branch_id)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      phone_number_id = EXCLUDED.phone_number_id,
      business_account_id = EXCLUDED.business_account_id,
      verify_token = EXCLUDED.verify_token,
      attendance_alerts_enabled = EXCLUDED.attendance_alerts_enabled,
      fee_alerts_enabled = EXCLUDED.fee_alerts_enabled,
      result_alerts_enabled = EXCLUDED.result_alerts_enabled,
      test_paper_alerts_enabled = EXCLUDED.test_paper_alerts_enabled,
      notice_alerts_enabled = EXCLUDED.notice_alerts_enabled,
      updated_by = EXCLUDED.updated_by,
      updated_at = CURRENT_TIMESTAMP`,
    [
      coachingId,
      branchId,
      String(settings.accessToken || '').trim(),
      String(settings.phoneNumberId || '').trim(),
      String(settings.businessAccountId || '').trim(),
      String(settings.verifyToken || '').trim(),
      settings.attendanceAlertsEnabled !== false,
      settings.feeAlertsEnabled !== false,
      settings.resultAlertsEnabled !== false,
      settings.testPaperAlertsEnabled !== false,
      settings.noticeAlertsEnabled !== false,
      updatedBy,
    ]
  );
}

async function logWhatsAppMessage({
  coachingId = null,
  branchId = null,
  studentId = null,
  phoneNumber,
  messageType,
  messageContent = '',
  status = 'pending',
  metaMessageId = null,
  documentUrl = null,
  documentFilename = null,
}) {
  let resolvedBranchId = branchId;
  if (!resolvedBranchId && studentId) {
    const student = await get(
      `SELECT branch_id FROM users WHERE id = ? AND role = 'student' LIMIT 1`,
      [studentId]
    );
    resolvedBranchId = student?.branch_id || null;
  }

  const result = await run(
    `INSERT INTO whatsapp_logs (
      coaching_id, branch_id, student_id, phone_number, message_type, message_content, status, meta_message_id, document_url, document_filename
    ) VALUES (?, COALESCE(?, app_current_branch_id()), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      resolvedBranchId,
      studentId,
      cleanPhoneNumber(phoneNumber),
      String(messageType || 'text').slice(0, 40),
      truncateMessage(messageContent),
      normalizeStatus(status),
      metaMessageId || null,
      documentUrl || null,
      documentFilename || null,
    ]
  );
  return result.lastID;
}

async function updateWhatsAppLogStatus(metaMessageId, status, errors = []) {
  if (!metaMessageId || !status) return;
  const errorText = Array.isArray(errors) && errors.length
    ? `\n\nDelivery error: ${errors.map((error) => (
      error?.message || error?.title || error?.code || JSON.stringify(error)
    )).join('; ')}`
    : '';
  await run(
    `UPDATE whatsapp_logs
     SET status = ?,
         message_content = CASE
           WHEN ? = '' THEN message_content
           ELSE LEFT(COALESCE(message_content, '') || ?, 4000)
         END
     WHERE meta_message_id = ?`,
    [normalizeStatus(status), errorText, errorText, metaMessageId]
  );
}

async function sendMetaMessage({ settings, payload }) {
  try {
    if (!settings.accessToken || !settings.phoneNumberId) {
      throw new Error('WhatsApp access token and phone number ID are required');
    }

    const apiUrl = `${GRAPH_API_BASE_URL}/${settings.phoneNumberId}/messages`;
    console.log('[WHATSAPP] API request:', {
      url: apiUrl,
      type: payload?.type || null,
      to: payload?.to || null,
      payload,
    });

    const timeoutMs = Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS || 15000);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...payload,
      }),
    });

    const body = await response.json().catch(() => ({}));
    console.log('[WHATSAPP] API response:', {
      url: apiUrl,
      status: response.status,
      ok: response.ok,
      body,
    });
    if (!response.ok) {
      const message = body?.error?.message || `WhatsApp API request failed with status ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.response = body;
      throw error;
    }

    return body;
  } catch (error) {
    console.error('[WHATSAPP] API error:', {
      status: error.status || null,
      response: error.response || null,
      message: error.message,
      stack: error.stack,
    });
    console.error('WhatsApp API send failed', error);
    throw error;
  }
}

async function sendTextMessage({ coachingId, branchId = null, studentId = null, to, message, settings = null }) {
  const phoneNumber = cleanPhoneNumber(to);
  const messageContent = String(message || '').trim();
  const logId = await logWhatsAppMessage({
    coachingId,
    branchId,
    studentId,
    phoneNumber,
    messageType: 'text',
    messageContent,
    status: 'pending',
  });

  try {
    const activeSettings = settings || await getWhatsAppSettings(coachingId, branchId);
    console.log('[WHATSAPP] Text payload:', {
      coachingId,
      studentId,
      phone: phoneNumber,
      phoneNumberId: activeSettings.phoneNumberId || null,
      hasAccessToken: Boolean(activeSettings.accessToken),
      messagePreview: messageContent.slice(0, 160),
    });
    const response = await sendMetaMessage({
      settings: activeSettings,
      payload: {
        to: phoneNumber,
        type: 'text',
        text: {
          preview_url: false,
          body: messageContent,
        },
      },
    });
    const metaMessageId = response?.messages?.[0]?.id || null;
    await run(
      `UPDATE whatsapp_logs SET status = ?, meta_message_id = ? WHERE id = ?`,
      ['sent', metaMessageId, logId]
    );
    return { ok: true, metaMessageId, response };
  } catch (error) {
    console.error('[WHATSAPP] Text error:', {
      coachingId,
      studentId,
      phone: phoneNumber,
      message: error.message,
      stack: error.stack,
    });
    console.error('sendTextMessage failed', error);
    await run(
      `UPDATE whatsapp_logs SET status = ?, message_content = ? WHERE id = ?`,
      ['failed', truncateMessage(`${messageContent}\n\nError: ${error.message}`), logId]
    );
    return { ok: false, failed: true, error: error.message, errorCode: getMetaErrorCode(error), response: error.response || null, logId };
  }
}

async function sendDocumentMessage({
  coachingId,
  branchId = null,
  studentId = null,
  to,
  documentUrl,
  filename,
  caption = '',
  settings = null,
}) {
  const phoneNumber = cleanPhoneNumber(to);
  const messageContent = caption || documentUrl;
  const logId = await logWhatsAppMessage({
    coachingId,
    branchId,
    studentId,
    phoneNumber,
    messageType: 'document',
    messageContent,
    status: 'pending',
    documentUrl,
    documentFilename: filename || 'result.pdf',
  });

  try {
    const activeSettings = settings || await getWhatsAppSettings(coachingId, branchId);
    console.log('WHATSAPP DOCUMENT SEND', {
      phone: phoneNumber,
      filename,
      documentUrl,
      caption,
    });
    const response = await sendMetaMessage({
      settings: activeSettings,
      payload: {
        to: phoneNumber,
        type: 'document',
        document: {
          link: documentUrl,
          filename: filename || 'result.pdf',
          caption,
        },
      },
    });
    console.log('WHATSAPP DOCUMENT RESPONSE', response);
    const metaMessageId = response?.messages?.[0]?.id || null;
    await run(
      `UPDATE whatsapp_logs SET status = ?, meta_message_id = ? WHERE id = ?`,
      ['sent', metaMessageId, logId]
    );
    return { ok: true, metaMessageId, response };
  } catch (error) {
    console.error('WHATSAPP DOCUMENT ERROR', {
      phone: phoneNumber,
      filename,
      documentUrl,
      status: error.status || null,
      response: error.response || null,
      message: error.message,
    });
    console.error('sendDocumentMessage failed', error);
    await run(
      `UPDATE whatsapp_logs SET status = ?, message_content = ? WHERE id = ?`,
      ['failed', truncateMessage(`${messageContent}\n\nError: ${error.message}`), logId]
    );
    return { ok: false, failed: true, error: error.message, errorCode: getMetaErrorCode(error), response: error.response || null, logId };
  }
}

async function sendImageMessage({
  coachingId,
  branchId = null,
  studentId = null,
  to,
  imageUrl,
  caption = '',
  settings = null,
}) {
  const phoneNumber = cleanPhoneNumber(to);
  const messageContent = caption || imageUrl;
  const logId = await logWhatsAppMessage({
    coachingId,
    branchId,
    studentId,
    phoneNumber,
    messageType: 'image',
    messageContent,
    status: 'pending',
  });

  try {
    const activeSettings = settings || await getWhatsAppSettings(coachingId, branchId);
    const response = await sendMetaMessage({
      settings: activeSettings,
      payload: {
        to: phoneNumber,
        type: 'image',
        image: {
          link: imageUrl,
          caption,
        },
      },
    });
    const metaMessageId = response?.messages?.[0]?.id || null;
    await run(
      `UPDATE whatsapp_logs SET status = ?, meta_message_id = ? WHERE id = ?`,
      ['sent', metaMessageId, logId]
    );
    return { ok: true, metaMessageId, response };
  } catch (error) {
    console.error('sendImageMessage failed', error);
    await run(
      `UPDATE whatsapp_logs SET status = ?, message_content = ? WHERE id = ?`,
      ['failed', truncateMessage(`${messageContent}\n\nError: ${error.message}`), logId]
    );
    return { ok: false, failed: true, error: error.message, errorCode: getMetaErrorCode(error), response: error.response || null, logId };
  }
}

async function sendTemplateMessage({
  coachingId,
  branchId = null,
  studentId = null,
  to,
  templateName,
  languageCode = 'en',
  components = [],
  settings = null,
}) {
  const phoneNumber = cleanPhoneNumber(to);
  const messageContent = `template:${templateName};language:${languageCode}`;
  const logId = await logWhatsAppMessage({
    coachingId,
    branchId,
    studentId,
    phoneNumber,
    messageType: 'template',
    messageContent,
    status: 'pending',
  });

  try {
    const activeSettings = settings || await getWhatsAppSettings(coachingId, branchId);
    console.log('[WHATSAPP] Template payload:', {
      coachingId,
      branchId,
      studentId,
      phone: phoneNumber,
      templateName,
      languageCode,
      componentCount: components.length,
    });
    const response = await sendMetaMessage({
      settings: activeSettings,
      payload: {
        to: phoneNumber,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      },
    });
    const metaMessageId = response?.messages?.[0]?.id || null;
    await run(
      `UPDATE whatsapp_logs SET status = ?, meta_message_id = ? WHERE id = ?`,
      ['sent', metaMessageId, logId]
    );
    return { ok: true, metaMessageId, response };
  } catch (error) {
    console.error('[WHATSAPP] Template send failed:', {
      coachingId,
      branchId,
      studentId,
      phone: phoneNumber,
      templateName,
      languageCode,
      status: error.status || null,
      response: error.response || null,
      message: error.message,
    });
    await run(
      `UPDATE whatsapp_logs SET status = ?, message_content = ? WHERE id = ?`,
      ['failed', truncateMessage(`${messageContent}\n\nError: ${error.message}`), logId]
    );
    return { ok: false, failed: true, error: error.message, errorCode: getMetaErrorCode(error), response: error.response || null, logId };
  }
}

async function sendBulkMessages({ coachingId, branchId, recipients, message, settings = null }) {
  const activeSettings = settings || await getWhatsAppSettings(coachingId, branchId);
  const summary = { sent: 0, failed: 0, results: [] };

  for (const recipient of recipients) {
    try {
      const result = await sendTextMessage({
        coachingId,
        branchId,
        studentId: recipient.studentId || recipient.id || null,
        to: recipient.phoneNumber || recipient.guardian_phone || recipient.contact_phone,
        message,
        settings: activeSettings,
      });
      if (result?.failed) {
        summary.failed += 1;
        summary.results.push({ ok: false, recipient, error: result.error });
        continue;
      }
      summary.sent += 1;
      summary.results.push({ ok: true, recipient, metaMessageId: result.metaMessageId });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({ ok: false, recipient, error: error.message });
    }
  }

  return summary;
}

function extractFirstUrl(value) {
  const match = String(value || '').match(/https?:\/\/\S+/);
  return match ? match[0].replace(/[)\].,;]+$/, '') : '';
}

function getSafeErrorMessage(resultOrError) {
  const code = getMetaErrorCode(resultOrError) || resultOrError?.errorCode || '';
  const message = resultOrError?.error || resultOrError?.message || resultOrError?.response?.error?.message || 'WhatsApp resend failed';
  return [code, message].filter(Boolean).join(': ').slice(0, 600);
}

function isMetaReEngagementError(resultOrError) {
  const code = String(getMetaErrorCode(resultOrError) || resultOrError?.errorCode || '');
  const message = String(resultOrError?.error || resultOrError?.message || resultOrError?.response?.error?.message || '').toLowerCase();
  return code === '131047' || message.includes('131047') || message.includes('re-engagement');
}

function buildManualResendTemplateComponents({ log, studentName, documentUrl }) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: studentName || 'Parent' },
      { type: 'text', text: studentName || 'Student' },
      { type: 'text', text: 'WhatsApp update' },
      { type: 'text', text: '-' },
      { type: 'text', text: '-' },
      { type: 'text', text: documentUrl || extractFirstUrl(log.message_content) || '-' },
    ],
  }];
}

async function markManualResendSuccess(logId, metaMessageId, resentBy) {
  await run(
    `UPDATE whatsapp_logs
     SET status = 'sent', meta_message_id = ?, resent_at = CURRENT_TIMESTAMP, resent_by = ?,
         retry_count = COALESCE(retry_count, 0) + 1, last_error = NULL
     WHERE id = ?`,
    [metaMessageId || null, resentBy || null, logId]
  );
}

async function markManualResendFailure(logId, errorText) {
  await run(
    `UPDATE whatsapp_logs
     SET status = 'failed', retry_count = COALESCE(retry_count, 0) + 1, last_error = ?
     WHERE id = ?`,
    [truncateMessage(errorText || 'WhatsApp resend failed'), logId]
  );
}

async function resendWhatsAppLog({ logId, coachingId, branchId, resentBy }) {
  const log = await get(
    `SELECT wl.*, u.name AS student_name, u.roll_no
     FROM whatsapp_logs wl
     LEFT JOIN users u ON u.id = wl.student_id AND u.branch_id = wl.branch_id
     WHERE wl.id = ? LIMIT 1`,
    [logId]
  );

  if (!log || Number(log.coaching_id) !== Number(coachingId) || Number(log.branch_id) !== Number(branchId) || normalizeStatus(log.status) !== 'failed') {
    console.warn(`[WHATSAPP MANUAL RESEND DENIED] logId=${logId}`);
    return { ok: false, denied: true, statusCode: 403, message: 'Resend denied for this WhatsApp log.' };
  }

  const settings = await getWhatsAppSettings(coachingId, branchId);
  const phoneNumber = cleanPhoneNumber(log.phone_number);
  const messageType = String(log.message_type || 'text').toLowerCase();
  const messageContent = String(log.message_content || '').replace(/\n\nError:.*$/s, '').trim();
  const documentUrl = log.document_url || extractFirstUrl(messageContent);
  const documentFilename = log.document_filename || 'result.pdf';

  console.log(`[WHATSAPP MANUAL RESEND START] logId=${logId} branchId=${branchId} coachingId=${coachingId}`);

  let normalResult = null;
  try {
    if (messageType === 'document') {
      if (!documentUrl) throw new Error('Original document URL is missing from this failed log.');
      normalResult = await sendMetaMessage({
        settings,
        payload: {
          to: phoneNumber,
          type: 'document',
          document: { link: documentUrl, filename: documentFilename, caption: messageContent || 'Document attached.' },
        },
      });
    } else {
      normalResult = await sendMetaMessage({
        settings,
        payload: {
          to: phoneNumber,
          type: 'text',
          text: { preview_url: false, body: messageContent || 'Message from coaching portal.' },
        },
      });
    }
    const metaMessageId = normalResult?.messages?.[0]?.id || null;
    await markManualResendSuccess(logId, metaMessageId, resentBy);
    console.log(`[WHATSAPP MANUAL RESEND NORMAL SENT] logId=${logId}`);
    return { ok: true, metaMessageId };
  } catch (error) {
    if (!isMetaReEngagementError(error)) {
      const safeError = getSafeErrorMessage(error);
      await markManualResendFailure(logId, safeError);
      console.error(`[WHATSAPP MANUAL RESEND FAILED] logId=${logId} code=${getMetaErrorCode(error) || ''}`);
      return { ok: false, failed: true, message: `Resend failed: ${safeError}` };
    }
  }

  console.warn(`[WHATSAPP MANUAL RESEND 131047] logId=${logId}`);
  const templateName = String(process.env.WHATSAPP_PAPER_TEMPLATE_NAME || 'paper_result_notification').trim();
  const languageCode = String(process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en').trim();
  if (!templateName) {
    const message = 'Resend failed: approved WhatsApp template is required outside the 24-hour window.';
    await markManualResendFailure(logId, message);
    console.error(`[WHATSAPP MANUAL RESEND FAILED] logId=${logId} code=131047`);
    return { ok: false, failed: true, message };
  }

  try {
    console.log(`[WHATSAPP MANUAL RESEND TEMPLATE START] logId=${logId}`);
    const templateResult = await sendMetaMessage({
      settings,
      payload: {
        to: phoneNumber,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: buildManualResendTemplateComponents({
            log,
            studentName: log.student_name || log.roll_no || 'Student',
            documentUrl,
          }),
        },
      },
    });
    const metaMessageId = templateResult?.messages?.[0]?.id || null;
    await markManualResendSuccess(logId, metaMessageId, resentBy);
    console.log(`[WHATSAPP MANUAL RESEND TEMPLATE SENT] logId=${logId}`);
    return { ok: true, metaMessageId, template: true };
  } catch (error) {
    const message = 'Resend failed: approved WhatsApp template is required outside the 24-hour window.';
    await markManualResendFailure(logId, `${message} ${getSafeErrorMessage(error)}`);
    console.error(`[WHATSAPP MANUAL RESEND FAILED] logId=${logId} code=${getMetaErrorCode(error) || 'template'}`);
    return { ok: false, failed: true, message };
  }
}

async function getRecentWhatsAppLogs(coachingId, branchId, limit = 25) {
  return all(
    `SELECT wl.*, u.roll_no, u.name
     FROM whatsapp_logs wl
     LEFT JOIN users u ON u.id = wl.student_id AND u.branch_id = wl.branch_id
     WHERE wl.coaching_id = ? AND wl.branch_id = ?
     ORDER BY wl.created_at DESC
     LIMIT ?`,
    [coachingId, branchId, limit]
  );
}

module.exports = {
  ensureWhatsAppSchema,
  getWhatsAppSettings,
  saveWhatsAppSettings,
  getRecentWhatsAppLogs,
  resendWhatsAppLog,
  updateWhatsAppLogStatus,
  sendTextMessage,
  sendDocumentMessage,
  sendImageMessage,
  sendTemplateMessage,
  sendBulkMessages,
};
