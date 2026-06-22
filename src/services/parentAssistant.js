const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { get, all, run } = require('../db');
const { getPaperAccess, getStoredFilePublicUrl, uploadGeneratedFile } = require('../storage');
const { sendDocumentNotification, sendWhatsAppNotification } = require('./notificationService');
const { getNextDueDate, getStudentFeeSummary } = require('./feeStructure');
const { buildProgressSummaryFromPapers } = require('./progress');

function cleanPhoneNumber(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return `${String(date.getDate()).padStart(2, '0')}-${date.toLocaleString('en-US', { month: 'short' })}-${date.getFullYear()}`;
}

function formatAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return '0';
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

function formatPercent(value) {
  const percent = Number(value || 0);
  if (!Number.isFinite(percent)) return '0';
  return percent.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function compactWhatsAppMessage(lines) {
  const output = [];
  for (const line of lines) {
    const value = String(line ?? '').trim();
    if (!value && output[output.length - 1] === '') continue;
    output.push(value);
  }
  while (output[output.length - 1] === '') output.pop();
  return output.join('\n');
}

function resolveAdminPhone(result) {
  return result?.admin_contact_phone
    || result?.contact_phone
    || result?.whatsapp_number
    || result?.phone
    || null;
}

function getAppPublicBaseUrl() {
  return String(
    process.env.APP_BASE_URL
    || process.env.PUBLIC_BASE_URL
    || process.env.RENDER_EXTERNAL_URL
    || process.env.VERCEL_URL
    || ''
  ).trim().replace(/\/$/, '').replace(/^([^h])/, 'https://$1');
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const url = new URL(withProtocol);
    const hostname = url.hostname.toLowerCase();
    const isPrivateHost = hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || hostname.endsWith('.internal');
    if (isPrivateHost) return '';
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    return '';
  }
}

function getReceiptPublicBaseUrl(explicitBaseUrl = '') {
  return [
    explicitBaseUrl,
    process.env.APP_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.VERCEL_URL,
  ].map(normalizePublicBaseUrl).find(Boolean) || '';
}

function getReceiptUrlSecret() {
  return String(process.env.RECEIPT_URL_SECRET || process.env.SESSION_SECRET || 'local-development-receipt-secret');
}

function createReceiptAccessToken({ feeId, receiptNumber, storageKey }) {
  return crypto
    .createHmac('sha256', getReceiptUrlSecret())
    .update(`${feeId}:${receiptNumber || ''}:${storageKey || ''}`)
    .digest('hex');
}

function verifyReceiptAccessToken({ feeId, receiptNumber, storageKey, token }) {
  const expected = createReceiptAccessToken({ feeId, receiptNumber, storageKey });
  const actual = String(token || '');
  if (!actual || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function buildReceiptAccessUrl({
  publicBaseUrl = '',
  feeId,
  receiptNumber,
  storageKey,
  fileName,
}) {
  const baseUrl = getReceiptPublicBaseUrl(publicBaseUrl);
  if (!baseUrl || !feeId || !storageKey) return null;
  const token = createReceiptAccessToken({ feeId, receiptNumber, storageKey });
  return `${baseUrl}/receipts/${encodeURIComponent(feeId)}/${token}/${encodeURIComponent(fileName || `${receiptNumber || 'receipt'}.pdf`)}`;
}

function buildReceiptNumber(feeId, paymentDate = new Date()) {
  return `RCP-${String(feeId).padStart(6, '0')}`;
}

function createPdfKitBuffer(buildDocument) {
  return new Promise((resolve, reject) => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildDocument(doc);
    doc.end();
  });
}

function drawSccPdfHeader(doc, title) {
  const logoPath = path.join(__dirname, '..', '..', 'public', 'scc-icon.png');
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 260, 34, { fit: [75, 75], align: 'center' });
  }
  doc.y = 120;
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#35438f').text(title, { align: 'center' });
  doc.moveDown(0.4);
  doc.strokeColor('#f4c400').lineWidth(2).moveTo(48, doc.y).lineTo(547, doc.y).stroke();
  doc.moveDown(1.1);
}

function drawSccBrandedHeader(doc, title) {
  const logoPath = path.join(__dirname, '..', '..', 'public', 'scc-icon.png');
  const left = 48;
  const right = doc.page.width - 48;
  const headerTop = 38;

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, left, headerTop, { fit: [72, 72] });
  }
  doc.fillColor('#223b82').font('Helvetica-Bold').fontSize(17)
    .text('SHIV CHHATRAPATI', 132, headerTop + 4, { width: 330 });
  doc.text('COACHING CLASSES', 132, headerTop + 25, { width: 330 });
  doc.fillColor('#223b82').font('Helvetica-Bold').fontSize(10)
    .text('Your Success Is Our Aim!', 132, headerTop + 52, { width: 330 });
  doc.strokeColor('#f5b800').lineWidth(3).moveTo(left, 122).lineTo(right, 122).stroke();
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(19)
    .text(title, left, 139, { width: right - left });
  doc.y = 174;
}

function drawSectionTitle(doc, title, y) {
  doc.roundedRect(48, y, 499, 22, 4).fill('#eef2ff');
  doc.fillColor('#223b82').font('Helvetica-Bold').fontSize(9)
    .text(String(title).toUpperCase(), 58, y + 7, { width: 479 });
  return y + 30;
}

function drawDetailGrid(doc, rows, y) {
  const left = 48;
  const columnWidth = 249.5;
  const rowHeight = 28;
  rows.forEach((row, index) => {
    const x = left + (index % 2) * columnWidth;
    const rowY = y + Math.floor(index / 2) * rowHeight;
    doc.roundedRect(x, rowY, columnWidth - 6, rowHeight - 5, 3)
      .fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(7)
      .text(String(row[0]).toUpperCase(), x + 9, rowY + 5, { width: 88 });
    doc.fillColor('#111827').font('Helvetica').fontSize(9)
      .text(String(row[1] ?? '-'), x + 98, rowY + 5, { width: columnWidth - 112 });
  });
  return y + Math.ceil(rows.length / 2) * rowHeight;
}

function createSimplePdfBuffer(title, lines) {
  return createPdfKitBuffer((doc) => {
    drawSccPdfHeader(doc, title);
    doc.font('Helvetica').fontSize(11).fillColor('#1f2937');
    lines.forEach((line) => {
      const text = String(line ?? '');
      if (!text) {
        doc.moveDown(0.5);
        return;
      }
      doc.text(text, { lineGap: 3 });
    });
  });
}

function createPerformancePdfBuffer(student, progressSeries, report = {}) {
  return createPdfKitBuffer((doc) => {
    drawSccBrandedHeader(doc, 'PERFORMANCE REPORT');
    let sectionY = drawSectionTitle(doc, 'Student Details', 180);
    sectionY = drawDetailGrid(doc, [
      ['Student Name', student.name || '-'],
      ['Roll No', student.roll_no || '-'],
      ['Admission No', student.admission_no || student.roll_no || '-'],
      ['Branch', report.branchName || student.branch_name || '-'],
      ['Batch', student.batch_name || '-'],
      ['Academic Year', report.academicYear || '-'],
    ], sectionY);

    sectionY = drawSectionTitle(doc, 'Performance Summary', sectionY + 4);
    const cards = [
      ['Highest Score', report.highestScore],
      ['Average Score', report.averageScore],
      ['Lowest Score', report.lowestScore],
      ['Attendance', report.attendancePercent],
      ['Current Rank', report.currentRank],
    ];
    const cardWidth = 95;
    cards.forEach(([label, value], index) => {
      const x = 48 + index * 100.8;
      doc.roundedRect(x, sectionY, cardWidth, 42, 5).fillAndStroke('#ffffff', '#dbe4ef');
      doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(7)
        .text(label, x + 5, sectionY + 7, { width: cardWidth - 10, align: 'center' });
      doc.fillColor('#223b82').font('Helvetica-Bold').fontSize(12)
        .text(String(value || '-'), x + 5, sectionY + 23, { width: cardWidth - 10, align: 'center' });
    });

    sectionY = drawSectionTitle(doc, 'Performance Graph', sectionY + 50);
    const left = 70;
    const top = sectionY + 4;
    const width = 460;
    const height = 160;

    [0, 25, 50, 75, 100].forEach((value) => {
      const y = top + height - (value / 100) * height;
      doc.strokeColor('#dbe4ef').lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke();
      doc.fillColor('#64748b').fontSize(9).text(`${value}%`, 35, y - 5, { width: 30, align: 'right' });
    });

    const points = progressSeries.map((item, index) => ({
      x: left + (width * index) / Math.max(progressSeries.length - 1, 1),
      y: top + height - (Math.max(0, Math.min(100, Number(item.percent || 0))) / 100) * height,
      label: String(item.label || `Test ${index + 1}`).slice(0, 12),
      percent: Number(item.percent || 0),
    }));

    if (!points.length) {
      doc.fillColor('#64748b').fontSize(16).text('No performance data available', left, top + 70, {
        width,
        align: 'center',
      });
    } else {
      doc.strokeColor('#35438f').lineWidth(3);
      points.forEach((point, index) => {
        if (index === 0) doc.moveTo(point.x, point.y);
        else doc.lineTo(point.x, point.y);
      });
      doc.stroke();

      const labelStep = Math.max(1, Math.ceil(points.length / 6));
      points.forEach((point, index) => {
        doc.circle(point.x, point.y, 4).fill('#f4c400');
        doc.fillColor('#334155').fontSize(8).text(`${point.percent.toFixed(0)}%`, point.x - 18, point.y - 20, {
          width: 36,
          align: 'center',
        });
        if (index % labelStep === 0) {
          doc.text(point.label, point.x - 35, top + height + 12, { width: 70, align: 'center' });
        }
      });
    }

    sectionY = drawSectionTitle(doc, 'Recent Tests', top + height + 40);
    const columns = [
      { label: 'Test Name', x: 48, width: 215 },
      { label: 'Test Date', x: 263, width: 95 },
      { label: 'Percentage', x: 358, width: 95 },
      { label: 'Rank', x: 453, width: 94 },
    ];
    doc.rect(48, sectionY, 499, 20).fill('#223b82');
    columns.forEach((column) => {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
        .text(column.label, column.x + 7, sectionY + 6, { width: column.width - 14 });
    });
    let rowY = sectionY + 20;
    (report.recentTests || []).slice(0, 3).forEach((test, index) => {
      doc.rect(48, rowY, 499, 22).fill(index % 2 ? '#f8fafc' : '#ffffff');
      [test.name, test.date, test.percentage, test.rank].forEach((value, columnIndex) => {
        const column = columns[columnIndex];
        doc.fillColor('#1f2937').font('Helvetica').fontSize(8)
          .text(String(value || '-'), column.x + 7, rowY + 7, { width: column.width - 14, ellipsis: true });
      });
      rowY += 22;
    });
    if (!(report.recentTests || []).length) {
      doc.fillColor('#64748b').font('Helvetica').fontSize(8)
        .text('No recent test results available.', 55, rowY + 7);
      rowY += 22;
    }

    sectionY = drawSectionTitle(doc, 'Teacher Remark', rowY + 8);
    doc.roundedRect(48, sectionY, 499, 42, 4).fillAndStroke('#fffdf5', '#f5d56b');
    doc.fillColor('#374151').font('Helvetica').fontSize(9)
      .text(report.teacherRemark || 'Keep practising consistently and attend classes regularly.', 58, sectionY + 10, {
        width: 479,
      });
    doc.fillColor('#64748b').font('Helvetica-Oblique').fontSize(8)
      .text('Keep up the good work. Regular practice and attendance lead to better results.', 48, 822, {
        width: 499,
        align: 'center',
      });
  });
}

async function validatePublicUrl(url) {
  if (!url) return { ok: false, status: 0, error: 'URL missing' };

  try {
    let response = await fetch(url, { method: 'HEAD' });
    if (!response.ok || response.status === 403 || response.status === 405) {
      response = await fetch(url, { method: 'GET' });
    }

    return {
      ok: response.status === 200,
      status: response.status,
      contentType: response.headers.get('content-type') || null,
    };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

async function getPaperDocument(paper) {
  if (!paper) return null;
  const access = await getPaperAccess(paper, 'attachment');
  const localUrl = access?.type === 'local' && getAppPublicBaseUrl() && paper.stored_name
    ? `${getAppPublicBaseUrl()}/paper-files/${encodeURIComponent(paper.stored_name)}`
    : null;
  return {
    fileUrl: paper.public_url || (access?.type === 'redirect' ? access.url : localUrl),
    fileName: paper.original_name || 'paper.pdf',
  };
}

async function getCoachingByWhatsAppPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;

  const selectCoachingSql = `
    SELECT ws.coaching_id, ws.branch_id, cc.name, cc.contact_email, ws.phone_number_id AS phone,
           admin.contact_phone AS admin_contact_phone,
           admin.contact_phone AS contact_phone,
           admin.whatsapp_number AS whatsapp_number
    FROM whatsapp_settings ws
    JOIN coaching_classes cc ON cc.id = ws.coaching_id
    LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.branch_id = ws.branch_id AND admin.role = 'admin'
  `;

  const exactMatch = await get(
    `${selectCoachingSql}
     WHERE ws.phone_number_id = ?
     LIMIT 1`,
    [phoneNumberId]
  );
  if (exactMatch) return exactMatch;

  console.error('[COACHING] No exact WhatsApp phone_number_id mapping found', { phoneNumberId });

  const settingsRows = await all(
    `${selectCoachingSql}
     ORDER BY ws.updated_at DESC
     LIMIT 2`
  );
  if (settingsRows.length === 1) {
    await run(
      `UPDATE whatsapp_settings
       SET phone_number_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE coaching_id = ? AND branch_id = ?`,
      [phoneNumberId, settingsRows[0].coaching_id, settingsRows[0].branch_id]
    );
    console.log('[COACHING] Repaired WhatsApp phone_number_id mapping', {
      coachingId: settingsRows[0].coaching_id,
      phoneNumberId,
    });
    return {
      ...settingsRows[0],
      phone: phoneNumberId,
    };
  }

  if (settingsRows.length > 1) {
    console.error('[COACHING] Ambiguous WhatsApp settings; cannot choose coaching automatically', {
      phoneNumberId,
      matchingRows: settingsRows.length,
    });
    return null;
  }

  const coachingRows = await all(
    `SELECT cc.id AS coaching_id, branch.id AS branch_id, cc.name, cc.contact_email, ? AS phone,
            admin.contact_phone AS admin_contact_phone,
            admin.contact_phone AS contact_phone,
            admin.whatsapp_number AS whatsapp_number
     FROM branches branch
     JOIN coaching_classes cc ON cc.id = branch.coaching_id
     LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.branch_id = branch.id AND admin.role = 'admin'
     ORDER BY cc.id ASC
     LIMIT 2`,
    [phoneNumberId]
  );

  if (coachingRows.length === 1) {
    await run(
      `INSERT INTO whatsapp_settings (coaching_id, branch_id, phone_number_id, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (branch_id)
       DO UPDATE SET phone_number_id = EXCLUDED.phone_number_id,
                     updated_at = CURRENT_TIMESTAMP`,
      [coachingRows[0].coaching_id, coachingRows[0].branch_id, phoneNumberId]
    );
    console.log('[COACHING] Created WhatsApp phone_number_id mapping from single coaching fallback', {
      coachingId: coachingRows[0].coaching_id,
      phoneNumberId,
    });
    return coachingRows[0];
  }

  console.error('[COACHING] Unable to resolve WhatsApp phone_number_id mapping', {
    phoneNumberId,
    coachingRows: coachingRows.length,
  });
  return null;
}

async function findStudentByParentPhone(coachingId, phone, branchId = null) {
  const cleanPhone = cleanPhoneNumber(phone);
  const phoneSuffix = cleanPhone.slice(-10);
  if (!cleanPhone) return null;
  return get(
    `SELECT u.id, u.coaching_id, u.branch_id, u.roll_no, u.name, u.contact_phone, u.guardian_phone,
            u.whatsapp_number, u.parent_whatsapp_number, b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE u.coaching_id = ? AND u.role = 'student'
       AND (?::int IS NULL OR u.branch_id = ?)
       AND (
         REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.contact_phone, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.whatsapp_number, ''), '[^0-9]', '', 'g') = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ?
       )
     ORDER BY CASE
       WHEN REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g') = ? THEN 1
       WHEN REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g') = ? THEN 2
       WHEN RIGHT(REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ? THEN 3
       WHEN RIGHT(REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g'), 10) = ? THEN 4
       ELSE 3
     END
     LIMIT 1`,
    [
      coachingId,
      branchId,
      branchId,
      cleanPhone,
      cleanPhone,
      cleanPhone,
      cleanPhone,
      phoneSuffix,
      phoneSuffix,
      phoneSuffix,
      phoneSuffix,
      cleanPhone,
      cleanPhone,
      phoneSuffix,
      phoneSuffix,
    ]
  );
}

async function findStudentByParentPhoneAnyCoaching(phone) {
  const cleanPhone = cleanPhoneNumber(phone);
  const phoneSuffix = cleanPhone.slice(-10);
  if (!cleanPhone) return null;

  const matches = await all(
    `SELECT u.id, u.coaching_id, u.branch_id, u.roll_no, u.name, u.contact_phone, u.guardian_phone,
            u.whatsapp_number, u.parent_whatsapp_number, b.name AS batch_name,
            cc.name AS coaching_name, cc.contact_email,
            admin.contact_phone AS admin_contact_phone,
            admin.contact_phone AS contact_phone,
            admin.whatsapp_number AS admin_whatsapp_number
     FROM users u
     JOIN coaching_classes cc ON cc.id = u.coaching_id
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = u.branch_id
     LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.branch_id = u.branch_id AND admin.role = 'admin'
     WHERE u.role = 'student'
       AND (
         REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.contact_phone, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.whatsapp_number, ''), '[^0-9]', '', 'g') = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ?
       )
     ORDER BY CASE
       WHEN REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g') = ? THEN 1
       WHEN REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g') = ? THEN 2
       WHEN RIGHT(REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ? THEN 3
       WHEN RIGHT(REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g'), 10) = ? THEN 4
       ELSE 5
     END
     LIMIT 2`,
    [
      cleanPhone,
      cleanPhone,
      cleanPhone,
      cleanPhone,
      phoneSuffix,
      phoneSuffix,
      phoneSuffix,
      phoneSuffix,
      cleanPhone,
      cleanPhone,
      phoneSuffix,
      phoneSuffix,
    ]
  );

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error('[STUDENT] Ambiguous global parent phone lookup', {
      phoneSuffix,
      matches: matches.map((student) => ({
        id: student.id,
        coachingId: student.coaching_id,
        rollNo: student.roll_no,
      })),
    });
  }
  return null;
}

async function findStudentByParentSession(coachingId, phone, branchId = null) {
  const session = await getParentSession({ coachingId, branchId, phone });
  if (!session?.student_id) return null;

  return get(
    `SELECT u.id, u.coaching_id, u.roll_no, u.name, u.contact_phone, u.guardian_phone,
            u.whatsapp_number, u.parent_whatsapp_number, b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = u.branch_id
     WHERE u.coaching_id = ? AND u.branch_id = ? AND u.role = 'student' AND u.id = ?
     LIMIT 1`,
    [coachingId, session.branch_id, session.student_id]
  );
}

function buildParentMenuMessage(coaching) {
  return [
    `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
    '',
    'Welcome to Parent Portal',
    '',
    'Choose an option:',
    '',
    '1️⃣ FEES',
    '2️⃣ ATTENDANCE',
    '3️⃣ RESULTS',
    '4️⃣ PERFORMANCE',
    '5️⃣ STUDENT INFO',
    '',
    'Reply with the option name.',
    '',
    'Example:',
    'FEES',
    'RESULTS',
    'ATTENDANCE',
  ].join('\n');
}

async function saveParentSession({ coachingId, studentId, phone, state, lastMessage }) {
  const cleanPhone = cleanPhoneNumber(phone);
  if (!cleanPhone || !coachingId) return;
  const student = studentId ? await get(
    `SELECT branch_id FROM users WHERE id = ? AND coaching_id = ? LIMIT 1`,
    [studentId, coachingId]
  ) : null;
  await run(
    `INSERT INTO whatsapp_parent_sessions (coaching_id, branch_id, student_id, phone_number, state, last_message, updated_at)
     VALUES (?, COALESCE(?, app_current_branch_id()), ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (branch_id, phone_number)
     DO UPDATE SET student_id = EXCLUDED.student_id,
                   state = EXCLUDED.state,
                   last_message = EXCLUDED.last_message,
                   updated_at = CURRENT_TIMESTAMP`,
    [coachingId, student?.branch_id || null, studentId || null, cleanPhone, state || 'menu', lastMessage || null]
  );
}

async function getParentSession({ coachingId, branchId = null, phone }) {
  const cleanPhone = cleanPhoneNumber(phone);
  if (!cleanPhone || !coachingId) return null;
  return get(
    `SELECT id, coaching_id, branch_id, student_id, phone_number, state, last_message, updated_at
     FROM whatsapp_parent_sessions
     WHERE coaching_id = ? AND (?::int IS NULL OR branch_id = ?) AND phone_number = ?
     LIMIT 1`,
    [coachingId, branchId, branchId, cleanPhone]
  );
}

function normalizeParentOption(text) {
  const command = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!command) return '';

  if (command.startsWith('1') || command === 'fees' || command === 'fee') return 'FEES';
  if (command.startsWith('2') || command === 'attendance') return 'ATTENDANCE';
  if (command.startsWith('3') || command === 'results' || command === 'result') return 'RESULTS';
  if (command.startsWith('4') || command === 'performance') return 'PERFORMANCE';
  if (command.startsWith('5') || command === 'student info' || command === 'student' || command === 'info') return 'STUDENT_INFO';
  if (command === 'menu' || command === 'start' || command === 'help') return 'MENU';
  if (command === 'hi' || command === 'hello' || command === 'hii' || command === 'hey' || command === 'i') return 'GREETING';

  return command.toUpperCase();
}

async function buildStudentPerformance(coachingId, branchId, studentId) {
  const studentDetails = await get(
    `SELECT u.name, u.roll_no, u.batch_id, b.name AS batch_name, br.name AS branch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = u.branch_id
     LEFT JOIN branches br ON br.id = u.branch_id AND br.coaching_id = u.coaching_id
     WHERE u.id = ? AND u.coaching_id = ? AND u.branch_id = ? AND u.role = 'student'
     LIMIT 1`,
    [studentId, coachingId, branchId]
  );
  const papers = await all(
    `SELECT id, original_name, upload_date, marks_obtained, max_marks, test_label,
            stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
     ORDER BY upload_date DESC`,
    [coachingId, branchId, studentId]
  );
  const { markedPapers, progressSeries, marksSummary } = buildProgressSummaryFromPapers(papers);
  const attendance = await get(
    `SELECT COUNT(*) AS total_classes,
            COUNT(*) FILTER (WHERE status = 'present') AS present_classes
     FROM attendance
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`,
    [coachingId, branchId, studentId]
  );
  const totalClasses = Number(attendance?.total_classes || 0);
  const attendancePercent = totalClasses
    ? Math.round((Number(attendance?.present_classes || 0) / totalClasses) * 100)
    : null;
  let currentRank = null;
  if (markedPapers.length && studentDetails?.batch_id && marksSummary.totalMaxMarks > 0) {
    const overallPercentage = (
      Number(marksSummary.totalMarksObtained || 0)
      / Number(marksSummary.totalMaxMarks)
    ) * 100;
    const rankRow = await get(
      `SELECT COUNT(*) + 1 AS current_rank
       FROM (
         SELECT tp.student_id
         FROM test_papers tp
         JOIN users peer
           ON peer.id = tp.student_id
          AND peer.coaching_id = tp.coaching_id
          AND peer.branch_id = tp.branch_id
         WHERE tp.coaching_id = ?
           AND tp.branch_id = ?
           AND peer.batch_id = ?
           AND tp.marks_obtained IS NOT NULL
           AND tp.max_marks IS NOT NULL
           AND tp.max_marks > 0
         GROUP BY tp.student_id
         HAVING (
           SUM(tp.marks_obtained)::numeric
           / NULLIF(SUM(tp.max_marks), 0)
         ) * 100 > ?
       ) higher_performing_students`,
      [
        coachingId,
        branchId,
        studentDetails.batch_id,
        overallPercentage,
      ]
    );
    currentRank = Number(rankRow?.current_rank || 0) || null;
  }
  return {
    papers,
    marked: markedPapers,
    totalMarks: marksSummary.totalMarksObtained,
    totalMax: marksSummary.totalMaxMarks,
    percentage: marksSummary.marksPercent,
    progressSeries,
    marksSummary,
    attendancePercent,
    studentDetails,
    currentRank,
  };
}

async function sendLatestPaper(student, phone) {
  const paper = await get(
    `SELECT id, original_name, stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
       AND (marks_obtained IS NULL OR max_marks IS NULL)
     ORDER BY upload_date DESC, id DESC
     LIMIT 1`,
    [student.coaching_id, student.branch_id, student.id]
  );
  const document = await getPaperDocument(paper);
  if (!document?.fileUrl) return false;
  await sendDocumentNotification(student.id, phone, document.fileUrl, document.fileName, 'Latest test paper attached.', {
    type: 'parent_menu_latest_paper',
    eventKey: `parent_menu_latest_paper:${student.id}:${paper.id}:${Date.now()}`,
  });
  return true;
}

async function sendLatestResult(student, phone) {
  const paper = await get(
    `SELECT id, original_name, stored_name, storage_type, storage_key, public_url, content_type,
            upload_date, marks_obtained, max_marks, test_label
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
       AND marks_obtained IS NOT NULL AND max_marks IS NOT NULL
     ORDER BY upload_date DESC, id DESC
     LIMIT 1`,
    [student.coaching_id, student.branch_id, student.id]
  );
  if (!paper) return false;
  const percentage = Number(paper.max_marks) > 0
    ? formatPercent((Number(paper.marks_obtained || 0) / Number(paper.max_marks)) * 100)
    : '-';
  const resultMessage = [
    '🏫 SHIV CHHATRAPATI CLASSES',
    '',
    '📚 New Result Available',
    '',
    `Student: ${student.name || '-'}`,
    `Test: ${paper.test_label || paper.original_name || '-'}`,
    `Marks: ${paper.marks_obtained ?? '-'}/${paper.max_marks ?? '-'}`,
    `Percentage: ${percentage}%`,
    '',
    'View full result in Parent Portal.',
  ];
  await sendWhatsAppNotification({
    studentId: student.id,
    phone,
    type: 'parent_menu_latest_result_summary',
    message: compactWhatsAppMessage(resultMessage),
    eventKey: `parent_menu_latest_result_summary:${student.id}:${paper.id}:${Date.now()}`,
  });

  try {
    const document = await getPaperDocument(paper);
    if (!document?.fileUrl) {
      console.error('Latest result PDF missing public URL', { studentId: student.id, paperId: paper.id });
      return true;
    }
    await sendDocumentNotification(student.id, phone, document.fileUrl, document.fileName, 'Result PDF attached.', {
      type: 'parent_menu_latest_result',
      eventKey: `parent_menu_latest_result:${student.id}:${paper.id}:${Date.now()}`,
    });
  } catch (error) {
    console.error('Latest result PDF send failed', { studentId: student.id, paperId: paper.id, error: error.message });
  }
  return true;
}

async function sendPerformanceGraph(student, phone, coaching = null, options = {}) {
  const performance = await buildStudentPerformance(student.coaching_id, student.branch_id, student.id);
  const hasPerformanceRows = Number(performance.marksSummary.papersCount || 0) > 0;
  const message = hasPerformanceRows
    ? [
      `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
      '',
      '📈 Performance Update',
      '',
      `Student: ${student.name || student.roll_no}`,
      `Overall Performance: ${performance.marksSummary.marksPercent}%`,
    ]
    : 'No performance data available';
  if (options.sendMessage !== false) {
    await sendWhatsAppNotification({
      studentId: student.id,
      phone,
      type: 'performance_report',
      message: Array.isArray(message) ? compactWhatsAppMessage(message) : message,
      eventKey: `performance_report_text:${student.id}:${Date.now()}`,
    });
  }

  try {
    if (!hasPerformanceRows) return { graph: null, performance, coaching };
    const reportStudent = { ...student, ...performance.studentDetails };
    const percentages = performance.progressSeries
      .map((item) => Number(item.percent))
      .filter(Number.isFinite);
    const academicYear = new Date().getMonth() >= 5
      ? `${new Date().getFullYear()}-${String(new Date().getFullYear() + 1).slice(-2)}`
      : `${new Date().getFullYear() - 1}-${String(new Date().getFullYear()).slice(-2)}`;
    const graphBuffer = await createPerformancePdfBuffer(reportStudent, performance.progressSeries, {
      branchName: reportStudent.branch_name || coaching?.branch_name || '-',
      academicYear,
      highestScore: percentages.length ? `${formatPercent(Math.max(...percentages))}%` : '-',
      averageScore: percentages.length
        ? `${formatPercent(percentages.reduce((sum, value) => sum + value, 0) / percentages.length)}%`
        : '-',
      lowestScore: percentages.length ? `${formatPercent(Math.min(...percentages))}%` : '-',
      attendancePercent: performance.attendancePercent == null ? '-' : `${performance.attendancePercent}%`,
      currentRank: performance.currentRank ? `#${performance.currentRank}` : '-',
      recentTests: performance.marked.slice(-5).reverse().map((paper) => ({
        name: paper.test_label || paper.original_name || '-',
        date: formatDate(paper.upload_date),
        percentage: Number(paper.max_marks) > 0
          ? `${formatPercent((Number(paper.marks_obtained || 0) / Number(paper.max_marks)) * 100)}%`
          : '-',
        rank: paper.rank ? `#${paper.rank}` : '-',
      })),
      teacherRemark: student.teacher_remark || '',
    });
    const graph = await uploadGeneratedFile({
      buffer: graphBuffer,
      fileName: `performance-${student.roll_no}.pdf`,
      contentType: 'application/pdf',
      folder: 'whatsapp/performance',
    });
    await sendDocumentNotification(student.id, phone, graph.publicUrl, `performance-${student.roll_no}.pdf`, 'Performance graph attached below.', {
      type: 'performance_graph',
      eventKey: `performance_graph:${student.id}:${Date.now()}`,
    });
    return { graph, performance, coaching };
  } catch (error) {
    console.error('Performance graph send failed', { studentId: student.id, error: error.message });
    return { graph: null, performance, coaching, error: error.message };
  }
}

async function sendPerformanceReport(student, phone, coaching = null) {
  const performance = await buildStudentPerformance(student.coaching_id, student.branch_id, student.id);
  const reportStudent = { ...student, ...performance.studentDetails };
  const percentages = performance.progressSeries.map((item) => Number(item.percent)).filter(Number.isFinite);
  const now = new Date();
  const academicYear = now.getMonth() >= 5
    ? `${now.getFullYear()}-${String(now.getFullYear() + 1).slice(-2)}`
    : `${now.getFullYear() - 1}-${String(now.getFullYear()).slice(-2)}`;
  const report = await createPerformancePdfBuffer(reportStudent, performance.progressSeries, {
    branchName: reportStudent.branch_name || coaching?.branch_name || '-',
    academicYear,
    highestScore: percentages.length ? `${formatPercent(Math.max(...percentages))}%` : '-',
    averageScore: percentages.length
      ? `${formatPercent(percentages.reduce((sum, value) => sum + value, 0) / percentages.length)}%`
      : '-',
    lowestScore: percentages.length ? `${formatPercent(Math.min(...percentages))}%` : '-',
    attendancePercent: performance.attendancePercent == null ? '-' : `${performance.attendancePercent}%`,
    currentRank: performance.currentRank ? `#${performance.currentRank}` : '-',
    recentTests: performance.marked.slice(-5).reverse().map((paper) => ({
      name: paper.test_label || paper.original_name || '-',
      date: formatDate(paper.upload_date),
      percentage: Number(paper.max_marks) > 0
        ? `${formatPercent((Number(paper.marks_obtained || 0) / Number(paper.max_marks)) * 100)}%`
        : '-',
      rank: paper.rank ? `#${paper.rank}` : '-',
    })),
    teacherRemark: student.teacher_remark || '',
  });
  const file = await uploadGeneratedFile({
    buffer: report,
    fileName: `performance-report-${student.roll_no}.pdf`,
    contentType: 'application/pdf',
    folder: 'whatsapp/performance-reports',
  });
  return sendDocumentNotification(student.id, phone, file.publicUrl, `performance-report-${student.roll_no}.pdf`, 'Performance report attached.', {
    type: 'performance_report_pdf',
    eventKey: `performance_report_pdf:${student.id}:${Date.now()}`,
  });
}

async function generateFeeReceiptPdf(feeId, options = {}) {
  const forceRegenerate = options.forceRegenerate === true;
  const publicBaseUrl = options.publicBaseUrl || '';
  const branchId = Number(options.branchId);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new Error('Branch ID is required for receipt generation');
  }
  const fee = await get(
    `SELECT f.id, f.branch_id, f.amount, f.payment_date, f.due_date, f.status, f.receipt_number, f.receipt_file_url,
            f.notes, f.payment_mode, f.added_by,
            u.id AS student_id, u.roll_no, u.name AS student_name, u.parent_name, u.batch_id,
            COALESCE(u.parent_whatsapp_number, u.guardian_phone) AS parent_phone,
            b.name AS batch_name,
            br.name AS branch_name,
            cc.name AS coaching_name, cc.contact_email,
            sfs.total_fee, sfs.paid_fee, sfs.pending_fee,
            f.receipt_storage_key, f.receipt_storage_type,
            admin.contact_phone AS admin_contact_phone,
            admin.contact_phone AS contact_phone,
            admin.whatsapp_number AS whatsapp_number,
            receiver.name AS received_by_name
     FROM fees f
     JOIN users u ON u.id = f.student_id AND u.coaching_id = f.coaching_id AND u.branch_id = f.branch_id
     LEFT JOIN batches b ON b.id = u.batch_id AND b.coaching_id = f.coaching_id AND b.branch_id = f.branch_id
     LEFT JOIN branches br ON br.id = f.branch_id AND br.coaching_id = f.coaching_id
     JOIN coaching_classes cc ON cc.id = f.coaching_id
     LEFT JOIN student_fee_structure sfs ON sfs.coaching_id = f.coaching_id AND sfs.branch_id = f.branch_id AND sfs.student_id = f.student_id
     LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.branch_id = f.branch_id AND admin.role = 'admin'
     LEFT JOIN users receiver ON receiver.id = f.added_by AND receiver.branch_id = f.branch_id
     WHERE f.id = ? AND f.branch_id = ?
     LIMIT 1`,
    [feeId, branchId]
  );

  if (!fee) {
    throw new Error(`Fee record not found for receipt generation: ${feeId}`);
  }

  const amount = Number(fee.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Cannot generate receipt for invalid amount on fee ${feeId}`);
  }

  const receiptNumber = fee.receipt_number || buildReceiptNumber(fee.id, fee.payment_date || new Date());
  if (fee.receipt_file_url && !forceRegenerate) {
    const receiptAccessUrl = buildReceiptAccessUrl({
      publicBaseUrl,
      feeId: fee.id,
      receiptNumber,
      storageKey: fee.receipt_storage_key,
      fileName: `${receiptNumber}.pdf`,
    });
    const freshUrl = await getStoredFilePublicUrl({
      storageType: fee.receipt_storage_type || 'local',
      storageKey: fee.receipt_storage_key,
      fileName: `${receiptNumber}.pdf`,
      contentType: 'application/pdf',
      dispositionType: 'attachment',
    });
    const fileUrl = receiptAccessUrl || freshUrl || fee.receipt_file_url;
    console.log('Receipt generated', {
      feeId: fee.id,
      receiptNumber,
      reused: true,
      storageType: fee.receipt_storage_type,
      storageKey: fee.receipt_storage_key,
    });
    console.log('Receipt URL', fileUrl);
    return {
      receiptNumber,
      fileUrl,
      fileName: `${receiptNumber}.pdf`,
      storageKey: fee.receipt_storage_key || null,
      storageType: fee.receipt_storage_type || null,
      fee,
    };
  }

  const receipt = await createPdfKitBuffer((doc) => {
    const totalFees = fee.total_fee == null
      ? Number(fee.paid_fee || 0) + Number(fee.pending_fee || 0)
      : Number(fee.total_fee);
    drawSccBrandedHeader(doc, 'FEE RECEIPT');

    let y = drawSectionTitle(doc, 'Receipt Details', 180);
    y = drawDetailGrid(doc, [
      ['Receipt No', receiptNumber],
      ['Date', formatDate(fee.payment_date || new Date().toISOString())],
      ['Branch', fee.branch_name || '-'],
    ], y);

    y = drawSectionTitle(doc, 'Student Details', y + 6);
    y = drawDetailGrid(doc, [
      ['Student Name', fee.student_name || '-'],
      ['Roll Number', fee.roll_no || '-'],
      ['Admission Number', fee.roll_no || '-'],
      ['Batch', fee.batch_name || '-'],
      ['Parent Mobile Number', fee.parent_phone || '-'],
    ], y);

    y = drawSectionTitle(doc, 'Fee Details', y + 6);
    const feeRows = [
      ['Total Course Fees', `Rs. ${formatAmount(totalFees || amount)}`],
      ['Fees Received', `Rs. ${formatAmount(amount)}`],
      ['Remaining Fees', `Rs. ${formatAmount(fee.pending_fee)}`],
      ['Next Installment Date', fee.due_date ? formatDate(fee.due_date) : '-'],
      ['Payment Mode', fee.payment_mode || 'Not specified'],
    ];
    feeRows.forEach(([label, value], index) => {
      const rowY = y + index * 31;
      doc.roundedRect(48, rowY, 499, 26, 3)
        .fillAndStroke(index % 2 ? '#ffffff' : '#f8fafc', '#dbe4ef');
      doc.fillColor('#334155').font('Helvetica-Bold').fontSize(9)
        .text(label, 60, rowY + 8, { width: 205 });
      doc.fillColor('#111827').font('Helvetica').fontSize(9)
        .text(value, 280, rowY + 8, { width: 250 });
    });
    y += feeRows.length * 31 + 12;

    doc.roundedRect(48, y, 499, 36, 5).fillAndStroke('#e8f7ec', '#5aa66a');
    doc.fillColor('#176b32').font('Helvetica-Bold').fontSize(11)
      .text('✓  Fees Received Successfully', 62, y + 12, { width: 470 });

    doc.fillColor('#475569').font('Helvetica').fontSize(9)
      .text(
        'Thank you for choosing Shiv Chhatrapati Coaching Classes. For any fee-related queries please contact office administration.',
        70,
        y + 68,
        { width: 455, align: 'center', lineGap: 3 }
      );
    doc.strokeColor('#cbd5e1').lineWidth(1).moveTo(48, 784).lineTo(547, 784).stroke();
    doc.fillColor('#64748b').font('Helvetica').fontSize(8)
      .text('Computer-generated receipt | Valid for Satpur and Meri Branch', 48, 793, {
        width: 499,
        align: 'center',
      });
  });

  const file = await uploadGeneratedFile({
    buffer: receipt,
    fileName: `${receiptNumber}.pdf`,
    contentType: 'application/pdf',
    folder: 'whatsapp/receipts',
  });
  const receiptAccessUrl = buildReceiptAccessUrl({
    publicBaseUrl,
    feeId: fee.id,
    receiptNumber,
    storageKey: file.storageKey || file.storedName,
    fileName: `${receiptNumber}.pdf`,
  });
  console.log('Receipt generated', {
    feeId: fee.id,
    receiptNumber,
    storageType: file.storageType,
    storageKey: file.storageKey || file.storedName,
  });
  console.log('Receipt URL', receiptAccessUrl || file.publicUrl);

  if (!receiptAccessUrl && !file.publicUrl) {
    throw new Error('Receipt PDF generated but no public URL is available. Configure APP_BASE_URL/PUBLIC_BASE_URL/RENDER_EXTERNAL_URL for the public app URL or S3_PUBLIC_BASE_URL for direct S3 access.');
  }

  await run(
    `UPDATE fees
     SET receipt_number = ?, receipt_file_url = ?, receipt_storage_key = ?, receipt_storage_type = ?, receipt_generated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND branch_id = ?`,
    [receiptNumber, receiptAccessUrl || file.publicUrl, file.storageKey || file.storedName || null, file.storageType || null, fee.id, fee.branch_id]
  );

  return {
    receiptNumber,
    fileUrl: receiptAccessUrl || file.publicUrl,
    fileName: `${receiptNumber}.pdf`,
    storageKey: file.storageKey || file.storedName || null,
    storageType: file.storageType || null,
    fee,
  };
}

async function createFeeReceiptAndSend({ student, fee, coaching, phone, recipient = 'parent', publicBaseUrl = '' }) {
  const receipt = await generateFeeReceiptPdf(fee.id, { publicBaseUrl, branchId: student.branch_id });
  console.log('Generated receipt URL', receipt.fileUrl);
  console.log('Receipt storage type', receipt.storageType);
  const validation = await validatePublicUrl(receipt.fileUrl);
  console.log('RECEIPT VALIDATION', validation);
  if (!validation.ok) {
    throw new Error(`Receipt URL is not publicly accessible with HTTP 200. Status: ${validation.status || 'unknown'}${validation.error ? ` Error: ${validation.error}` : ''}`);
  }
  return sendDocumentNotification(student.id, phone, receipt.fileUrl, receipt.fileName, 'Payment received successfully. Receipt attached.', {
    type: 'fee_receipt',
    eventKey: `fee_receipt:${recipient}:${student.id}:${fee.id}`,
    retryFailed: true,
  });
}

async function createMonthlyReportAndSend({ student, coaching, phone, monthKey }) {
  const attendanceSummary = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count
     FROM attendance
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
       AND CAST(attendance_date AS TEXT) LIKE ?`,
    [student.coaching_id, student.branch_id, student.id, `${monthKey}%`]
  );
  const pending = await get(
    `SELECT COALESCE(SUM(amount), 0) AS pending_amount
     FROM fees
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ? AND status IN ('pending', 'overdue')`,
    [student.coaching_id, student.branch_id, student.id]
  );
  const performance = await buildStudentPerformance(student.coaching_id, student.branch_id, student.id);
  const totalAttendance = Number(attendanceSummary?.total || 0);
  const present = Number(attendanceSummary?.present_count || 0);
  const attendancePercent = totalAttendance ? Number(((present / totalAttendance) * 100).toFixed(1)) : 0;
  const report = await createSimplePdfBuffer(`Monthly Parent Report - ${monthKey}`, [
    `Coaching: ${coaching?.name || 'Coaching Institute'}`,
    `Student: ${student.name || student.roll_no}`,
    `Roll No: ${student.roll_no}`,
    `Attendance: ${attendancePercent}%`,
    `Total Tests: ${performance.marked.length}`,
    Number(performance.marksSummary.papersCount || 0) > 0
      ? `Average Marks: ${performance.marksSummary.marksPercent}%`
      : 'No performance data available',
    `Pending Fees: Rs. ${formatAmount(pending?.pending_amount)}`,
  ]);
  const file = await uploadGeneratedFile({
    buffer: report,
    fileName: `monthly-report-${student.roll_no}-${monthKey}.pdf`,
    contentType: 'application/pdf',
    folder: 'whatsapp/monthly-reports',
  });
  return sendDocumentNotification(student.id, phone, file.publicUrl, `monthly-report-${student.roll_no}-${monthKey}.pdf`, 'Monthly parent report attached.', {
    type: 'monthly_parent_report',
    eventKey: `monthly_parent_report:${student.id}:${monthKey}`,
  });
}

async function handleParentAssistantMessage({ coaching, student, from, text }) {
  try {
    const incomingText = String(text || '').trim();
    const normalizedOption = normalizeParentOption(incomingText);
    const phone = cleanPhoneNumber(from);
    if (!student) return false;
    const session = await getParentSession({
      coachingId: student.coaching_id,
      branchId: student.branch_id,
      phone,
    });
    console.log('Incoming message:', incomingText);
    console.log('Normalized option:', normalizedOption);
    console.log('Session:', session);
    console.log('Student:', student?.id);

    if (normalizedOption === 'MENU' || normalizedOption === 'GREETING') {
      console.log('[HANDLER] Enter MENU');
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu',
        message: buildParentMenuMessage(coaching),
        eventKey: `parent_menu:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Menu result:', notificationResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'menu',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'FEES') {
      console.log('Before FEES block');
      console.log('[HANDLER] Enter FEES');
      const feeSummary = await getStudentFeeSummary(student.coaching_id, student.branch_id, student.id);
      const nextDueDate = await getNextDueDate(student.coaching_id, student.branch_id, student.id);
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu_fee_summary',
        message: compactWhatsAppMessage([
          `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
          '',
          '💰 Fee Summary',
          '',
          `Student: ${student.name || '-'}`,
          `Total Fees: ₹${formatAmount(feeSummary.totalFee)}`,
          `Paid Fees: ₹${formatAmount(feeSummary.paidFee)}`,
          `Pending Fees: ₹${formatAmount(feeSummary.pendingFee)}`,
          '',
          'Next Due Date:',
          formatDate(nextDueDate),
        ]),
        eventKey: `parent_menu_fee_summary:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Fee summary result:', notificationResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'fees',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'ATTENDANCE') {
      console.log('Before ATTENDANCE block');
      console.log('[HANDLER] Enter ATTENDANCE');
      const summary = await get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count,
                SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count,
                SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_count
         FROM attendance
         WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`,
        [student.coaching_id, student.branch_id, student.id]
      );
      const total = Number(summary?.total || 0);
      const present = Number(summary?.present_count || 0);
      const percent = total ? ((present / total) * 100).toFixed(1) : '0.0';
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu_attendance',
        message: compactWhatsAppMessage([
          '📅 Attendance Summary',
          '',
          `Present: ${present}`,
          `Absent: ${Number(summary?.absent_count || 0)}`,
          `Attendance Percentage: ${percent}%`,
        ]),
        eventKey: `parent_menu_attendance:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Attendance result:', notificationResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'attendance',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'RESULTS') {
      console.log('Before RESULTS block');
      console.log('[HANDLER] Enter RESULTS');
      const sent = await sendLatestResult(student, phone);
      console.log('[WHATSAPP] Latest result send status:', sent);
      if (!sent) {
        const notificationResult = await sendWhatsAppNotification({ studentId: student.id, phone, type: 'parent_menu_latest_result', message: 'No result PDF is available yet.', eventKey: `parent_menu_latest_result_empty:${student.id}:${Date.now()}` });
        console.log('[WHATSAPP] Empty latest result response:', notificationResult);
      }
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'results',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'PERFORMANCE') {
      console.log('Before PERFORMANCE block');
      console.log('[HANDLER] Enter PERFORMANCE');
      const performance = await buildStudentPerformance(student.coaching_id, student.branch_id, student.id);
      const percentages = performance.progressSeries.map((item) => Number(item.percent)).filter(Number.isFinite);
      const average = Number(performance.marksSummary.papersCount || 0) > 0 ? performance.marksSummary.marksPercent : '0';
      const highest = percentages.length ? formatPercent(Math.max(...percentages)) : '0';
      const latest = percentages.length ? formatPercent(percentages[percentages.length - 1]) : '0';
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu_performance_report',
        message: compactWhatsAppMessage([
          '📈 Performance Report',
          '',
          'Overall:',
          `${average}%`,
          'Highest:',
          `${highest}%`,
          'Latest:',
          `${latest}%`,
          '',
          'Graph attached.',
        ]),
        eventKey: `parent_menu_performance_report:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Performance report result:', notificationResult);
      const graphResult = await sendPerformanceGraph(student, phone, coaching, { sendMessage: false });
      console.log('[WHATSAPP] Performance graph result:', graphResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'performance',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'STUDENT_INFO') {
      console.log('Before STUDENT_INFO block');
      console.log('[HANDLER] Enter STUDENT_INFO');
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu_student_profile',
        message: compactWhatsAppMessage([
          '👨‍🎓 Student Information',
          '',
          `Name: ${student.name || '-'}`,
          `Roll No: ${student.roll_no || '-'}`,
          `Batch: ${student.batch_name || '-'}`,
        ]),
        eventKey: `parent_menu_student_profile:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Student info result:', notificationResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'student_info',
        lastMessage: normalizedOption,
      });
      return true;
    }

    console.log('[HANDLER] No matching option:', normalizedOption);
    return false;
  } catch (error) {
    console.error('Parent Assistant Error', error);
    console.error(error.stack);
    return false;
  }
}

async function sendMonthlyParentReports({ monthKey, coachingId = null }) {
  const params = [];
  let sql = `
    SELECT u.id, u.coaching_id, u.roll_no, u.name, u.parent_whatsapp_number, u.guardian_phone,
           cc.name, cc.contact_email,
           admin.contact_phone AS admin_contact_phone,
           admin.contact_phone AS contact_phone,
           admin.whatsapp_number AS whatsapp_number
    FROM users u
    JOIN coaching_classes cc ON cc.id = u.coaching_id
    LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.role = 'admin'
    WHERE u.role = 'student'
      AND COALESCE(u.parent_whatsapp_number, u.guardian_phone) IS NOT NULL
      AND TRIM(COALESCE(u.parent_whatsapp_number, u.guardian_phone, '')) <> ''
  `;
  if (coachingId) {
    params.push(coachingId);
    sql += ` AND u.coaching_id = ?`;
  }
  sql += ` ORDER BY u.coaching_id, u.roll_no ASC LIMIT 400`;

  const students = await all(sql, params);
  const summary = { sent: 0, skipped: 0, failed: 0 };
  for (const row of students) {
    try {
      const result = await createMonthlyReportAndSend({
        student: row,
        coaching: row,
        phone: row.parent_whatsapp_number || row.guardian_phone,
        monthKey,
      });
      if (result?.skipped) {
        summary.skipped += 1;
      } else {
        await sendPerformanceGraph(row, row.parent_whatsapp_number || row.guardian_phone, row);
        summary.sent += 1;
      }
    } catch (error) {
      console.error('Monthly parent report failed', { studentId: row.id, error: error.message });
      summary.failed += 1;
    }
  }
  return summary;
}

module.exports = {
  buildParentMenuMessage,
  createFeeReceiptAndSend,
  createMonthlyReportAndSend,
  findStudentByParentPhone,
  findStudentByParentPhoneAnyCoaching,
  findStudentByParentSession,
  generateFeeReceiptPdf,
  getCoachingByWhatsAppPhoneNumberId,
  handleParentAssistantMessage,
  sendLatestPaper,
  sendLatestResult,
  sendMonthlyParentReports,
  sendPerformanceGraph,
  verifyReceiptAccessToken,
  validatePublicUrl,
};
