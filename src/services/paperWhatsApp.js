const whatsappApi = require('./whatsapp');

// Delivery of one stored paper document to a list of WhatsApp recipients.
//
// Extracted from src/app.js (notifyPaperEvent) so the real send path can be exercised by
// regression tests with a fake Meta API, without booting the Express app / DB pool.
// Papers go TEMPLATE FIRST (see deliverPaperDocument), and every recipient gets an explicit
// outcome instead of failures being reported upstream as a blanket `ok: true`.

function getWhatsAppErrorCode(resultOrError) {
  return String(
    resultOrError?.errorCode
    || resultOrError?.code
    || resultOrError?.response?.error?.code
    || resultOrError?.response?.error?.error_subcode
    || ''
  );
}

function isReEngagementError(resultOrError) {
  const code = getWhatsAppErrorCode(resultOrError);
  const message = String(resultOrError?.error || resultOrError?.message || resultOrError?.reason || '').toLowerCase();
  return code === '131047' || message.includes('131047') || message.includes('re-engagement');
}

const NO_VALID_NUMBER_REASON = 'No valid WhatsApp number available for this student';

// Columns that can hold a number for the student, in send priority order.
const PAPER_RECIPIENT_FIELDS = [
  { key: 'parent', field: 'parent_whatsapp_number' },
  { key: 'guardian', field: 'guardian_phone' },
  { key: 'student', field: 'whatsapp_number' },
  { key: 'contact', field: 'contact_phone' },
];

// Who receives a paper: EVERY valid number stored against the student (parent, guardian,
// student WhatsApp, contact), none of them required. Numbers are compared after the same
// normalization the send uses, so one person never gets the same document twice.
function selectPaperRecipients(paperStudent) {
  const seen = new Set();
  const recipients = [];
  for (const { key, field } of PAPER_RECIPIENT_FIELDS) {
    const phone = String(paperStudent?.[field] || '').trim();
    const normalized = whatsappApi.cleanPhoneNumber(phone);
    if (!/^\d{11,15}$/.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    recipients.push({ key, phone });
  }
  return recipients;
}

// Numbers that are stored for the student but cannot be sent to, so the admin sees them
// instead of them silently dropping out of the recipient list.
function describeInvalidNumbers(paperStudent) {
  const invalid = [];
  for (const { key, field } of PAPER_RECIPIENT_FIELDS) {
    const phone = String(paperStudent?.[field] || '').trim();
    if (!phone) continue;
    const normalized = whatsappApi.cleanPhoneNumber(phone);
    if (/^\d{11,15}$/.test(normalized)) continue;
    invalid.push({ key, phone, reason: `Invalid phone number in ${field} (${normalized.length} digits)` });
  }
  return invalid;
}

// The separate failure categories shown to the admin. Never collapsed into a generic
// "WhatsApp failed" when Meta (or our own checks) gave a specific reason.
const DELIVERY_CATEGORIES = {
  STUDENT_NOT_FOUND: 'Student not found for filename/roll number',
  INVALID_FILENAME: 'Invalid/missing filename or roll number',
  NO_VALID_NUMBER: 'No valid WhatsApp number',
  INVALID_NUMBER: 'Invalid phone number',
  NOT_ON_WHATSAPP: 'WhatsApp number is not registered on WhatsApp',
  WINDOW_131047: 'Meta 131047 – 24-hour messaging window closed',
  MEDIA_131053: 'File larger than WhatsApp limit / media rejected (131053)',
  TEMPLATE: 'Meta template/message policy rejection',
  DOCUMENT_URL: 'S3/document URL problem',
  OTHER_META: 'Other Meta API error',
  // Upload-side outcomes (the paper itself), kept apart from delivery problems.
  DUPLICATE_FILE: 'Several uploaded files for the same roll number',
  DUPLICATE_UPLOAD: 'Duplicate upload ignored',
  SAVE_FAILED: 'Paper could not be saved',
};

// Maps one recipient failure (Meta error code and/or text) to a category.
function classifyDeliveryProblem({ errorCode, error } = {}) {
  const text = String(error || '');
  const code = String(errorCode || '')
    || (text.match(/\(#(\d+)\)/) || [])[1]
    || (text.match(/^(\d{3,6})\b/) || [])[1]
    || '';
  // A Meta error code decides first; the text is only used when there is no code.
  if (code === '131026') return DELIVERY_CATEGORIES.NOT_ON_WHATSAPP;
  if (code === '131047') return DELIVERY_CATEGORIES.WINDOW_131047;
  if (code === '131053') return DELIVERY_CATEGORIES.MEDIA_131053;
  if (code === '131052') return DELIVERY_CATEGORIES.DOCUMENT_URL;
  if (/^132\d{3}$/.test(code)) return DELIVERY_CATEGORIES.TEMPLATE;
  if (/undeliverable|not a valid whatsapp|not on whatsapp/i.test(text)) return DELIVERY_CATEGORIES.NOT_ON_WHATSAPP;
  if (/re-engagement/i.test(text)) return DELIVERY_CATEGORIES.WINDOW_131047;
  if (/media upload error|file has size|larger than whatsapp limit/i.test(text)) return DELIVERY_CATEGORIES.MEDIA_131053;
  if (/media download|real s3 paper not found|document url/i.test(text)) return DELIVERY_CATEGORIES.DOCUMENT_URL;
  if (/template/i.test(text)) return DELIVERY_CATEGORIES.TEMPLATE;
  return DELIVERY_CATEGORIES.OTHER_META;
}

// Approved UTILITY template (WHATSAPP_PAPER_TEMPLATE_NAME, default paper_result_notification), IMAGE header:
// "Dear {{1}}, the checked answer sheet of {{2}} for the test {{3}} is attached with this message.
//  Marks obtained: {{4}} out of {{5}}. Please review it with your child. Thank you."
function buildPaperTemplateComponents({ recipientName, student, paper, paperUrl }) {
  const text = whatsappApi.templateText;
  return [
    {
      type: 'header',
      parameters: [{ type: 'image', image: { link: paperUrl } }],
    },
    {
      type: 'body',
      parameters: [
        { type: 'text', text: text(recipientName || student.name || student.roll_no, 'Parent') },
        { type: 'text', text: text(student.name || student.roll_no, 'Student') },
        { type: 'text', text: text(paper.test_label || paper.original_name, 'Test Paper') },
        { type: 'text', text: text(paper.marks_obtained) },
        { type: 'text', text: text(paper.max_marks) },
      ],
    },
  ];
}

// Meta's media limits for the template header we put the paper in.
const META_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024; // 5,242,880 — IMAGE header (paper_result_notification)
const META_DOCUMENT_LIMIT_BYTES = 100 * 1024 * 1024; // DOCUMENT header (coaching_document)

// Actual size of the stored paper: test_papers.size_bytes, else a HEAD request to the S3 URL.
async function resolveDocumentSize(document, fetchImpl = global.fetch) {
  const stored = Number(document?.sizeBytes);
  if (Number.isFinite(stored) && stored > 0) return { sizeBytes: stored, source: 'stored' };
  try {
    const response = await fetchImpl(document.fileUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const length = Number(response?.headers?.get?.('content-length'));
    if (response?.ok && Number.isFinite(length) && length > 0) return { sizeBytes: length, source: 's3_head' };
  } catch (error) {
    console.warn('[PAPER WHATSAPP] could not read paper size from storage', { fileUrl: document?.fileUrl, error: error.message });
  }
  return { sizeBytes: null, source: 'unknown' };
}

const formatMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

// Which approved template carries this paper (the same for every recipient):
//   image ≤ 5 MB                 -> paper_result_notification (IMAGE header, shows marks)
//   image > 5 MB / size unknown  -> coaching_document (DOCUMENT header, up to 100 MB)
//   PDF / any other file         -> coaching_document
//   > 100 MB                     -> nothing can carry it: explicit failure, Meta is not called
function choosePaperTemplate({ document, sizeBytes }) {
  const config = whatsappApi.getTemplateConfig();
  if (sizeBytes !== null && sizeBytes > META_DOCUMENT_LIMIT_BYTES) {
    return {
      kind: 'too_large',
      error: `File larger than WhatsApp limit: ${formatMb(sizeBytes)} exceeds the 100 MB WhatsApp document limit`,
    };
  }
  const isImage = whatsappApi.isImageFile(document.fileName, document.fileUrl);
  if (isImage && sizeBytes !== null && sizeBytes <= META_IMAGE_LIMIT_BYTES) {
    return { kind: 'image', templateName: config.paperTemplate, languageCode: config.languageCode };
  }
  return {
    kind: 'document',
    templateName: config.documentTemplate,
    languageCode: config.languageCode,
    why: !isImage ? 'not an image' : (sizeBytes === null ? 'image size unknown' : `image is ${formatMb(sizeBytes)} (over the 5 MB image limit)`),
  };
}

// {{1}} of coaching_document: "please find attached the {{1}} for {{2}} from {{3}}".
function paperDocumentLabel(paper = {}) {
  const label = String(paper.test_label || '').trim();
  const named = label && !/\.(jpe?g|png|webp|pdf|tiff?|bmp|gif)$/i.test(label) ? `${label} checked test paper` : 'checked test paper';
  const marks = paper.marks_obtained !== null && paper.marks_obtained !== undefined && paper.marks_obtained !== ''
    ? ` (Marks ${paper.marks_obtained}${paper.max_marks ? `/${paper.max_marks}` : ''})`
    : '';
  return `${named}${marks}`;
}

async function sendPaperTemplate({ choice, coachingId, branchId, student, recipient, document, paperId, coachingName, api = whatsappApi }) {
  if (!choice.templateName) {
    console.error('[WHATSAPP TEMPLATE REQUIRED]', { paperId, studentId: student.id, recipient: recipient.key, reason: 'missing template name' });
    return { ok: false, failed: true, error: `WhatsApp ${choice.kind === 'image' ? 'paper' : 'document'} template name is missing` };
  }
  console.log('[PAPER WHATSAPP TEMPLATE START]', {
    paperId,
    studentId: student.id,
    recipient: recipient.key,
    templateName: choice.templateName,
    header: choice.kind === 'image' ? 'IMAGE' : 'DOCUMENT',
    why: choice.why || null,
  });
  const result = await api.sendTemplateMessage({
    coachingId,
    branchId,
    studentId: student.id,
    to: recipient.phone,
    templateName: choice.templateName,
    languageCode: choice.languageCode,
    // Stored on the log row so a later webhook failure (e.g. 131053) can be retried with the same file.
    documentUrl: document.fileUrl,
    documentFilename: document.fileName,
    components: choice.kind === 'image'
      ? buildPaperTemplateComponents({
        recipientName: (recipient.key === 'parent' || recipient.key === 'guardian') ? student.parent_name || student.name || 'Parent' : student.name,
        student,
        paper: document.paper || {},
        paperUrl: document.fileUrl,
      })
      : whatsappApi.buildDocumentTemplateComponents({
        documentUrl: document.fileUrl,
        filename: document.fileName || document.paper?.original_name || 'paper.pdf',
        documentLabel: paperDocumentLabel(document.paper),
        studentName: student.name || student.roll_no,
        coachingName,
      }),
  });
  if (result?.failed || result?.ok === false) {
    console.error('[PAPER WHATSAPP TEMPLATE FAILED]', {
      paperId, studentId: student.id, recipient: recipient.key, templateName: choice.templateName, error: result.error || 'Template send failed',
    });
  } else {
    console.log('[PAPER WHATSAPP TEMPLATE SENT]', {
      paperId, studentId: student.id, recipient: recipient.key, templateName: choice.templateName, metaMessageId: result?.metaMessageId || null,
    });
  }
  return result;
}

const isMediaSizeError = (result) => getWhatsAppErrorCode(result) === '131053' || /131053|media upload error|file has size/i.test(String(result?.error || ''));
const isTemplateConfigError = (result) => /^132\d{3}$/.test(getWhatsAppErrorCode(result)) || /\(#132\d{3}\)/.test(String(result?.error || ''));

function outcomeFromResult(recipient, channel, result, extra = {}) {
  const failed = !result || result.failed || result.ok === false;
  return {
    key: recipient.key,
    phone: recipient.phone,
    // The E.164-style number actually handed to the WhatsApp API (country code added).
    to: whatsappApi.cleanPhoneNumber(recipient.phone),
    ok: !failed,
    // whatsapp_logs row of this attempt; its live status (and any superseding retry) is the
    // recipient's final outcome.
    logId: result?.logId || null,
    channel,
    metaMessageId: result?.metaMessageId || null,
    error: failed ? (result?.error || result?.reason || 'WhatsApp send failed') : null,
    errorCode: failed ? (getWhatsAppErrorCode(result) || null) : null,
    response: result?.response || null,
    ...extra,
  };
}

// Sends `document` (the paper's own stored file: {fileUrl, fileName, sizeBytes, paper}) to each
// recipient, TEMPLATE FIRST (business-initiated messages outside a 24-hour window must be
// templates, and the app cannot know whether a parent's window is open). Per recipient:
//   1. approved template chosen by choosePaperTemplate (IMAGE ≤ 5 MB, else DOCUMENT)
//   2. IMAGE template rejected for media size (131053) -> same file via the DOCUMENT template
//   3. template itself rejected (132xxx: missing/unapproved/mismatched) -> plain document
//      message, which Meta delivers only inside a 24-hour window
//   4. anything else -> failed with Meta's exact error (no free-form retry)
// Returns one outcome per recipient:
//   { key, phone, to, ok, logId, channel: 'template' | 'document', templateName, metaMessageId,
//     error, errorCode, response }
// `ok` is true only when the Meta API accepted the message that now carries the paper. It never throws.
async function deliverPaperDocument({
  document,
  student,
  recipients,
  caption,
  coachingId,
  branchId,
  paperId,
  coachingName = null,
  api = whatsappApi,
  fetchImpl = global.fetch,
}) {
  const { sizeBytes, source: sizeSource } = await resolveDocumentSize(document, fetchImpl);
  const choice = choosePaperTemplate({ document, sizeBytes });
  console.log('[PAPER WHATSAPP] delivery plan', {
    paperId, studentId: student.id, sizeBytes, sizeSource, kind: choice.kind, templateName: choice.templateName || null, recipients: recipients.length,
  });
  const outcomes = [];

  for (const recipient of recipients) {
    try {
      if (choice.kind === 'too_large') {
        const logId = typeof api.logWhatsAppMessage === 'function'
          ? await api.logWhatsAppMessage({
            coachingId, branchId, studentId: student.id, phoneNumber: recipient.phone, messageType: 'document',
            messageContent: document.fileName, status: 'failed', documentUrl: document.fileUrl,
            documentFilename: document.fileName, lastError: choice.error,
          })
          : null;
        outcomes.push(outcomeFromResult(recipient, 'document', { ok: false, failed: true, error: choice.error, logId }));
        continue;
      }

      const common = { coachingId, branchId, student, recipient, document, paperId, coachingName, api };
      let current = await sendPaperTemplate({ choice, ...common });
      let currentChoice = choice;
      let channel = 'template';

      if (!current?.ok && choice.kind === 'image' && isMediaSizeError(current)) {
        const config = whatsappApi.getTemplateConfig();
        const documentChoice = { kind: 'document', templateName: config.documentTemplate, languageCode: config.languageCode, why: 'IMAGE template rejected the file size (131053)' };
        const retry = await sendPaperTemplate({ choice: documentChoice, ...common });
        if (retry?.ok && current?.logId && typeof api.markLogSuperseded === 'function') await api.markLogSuperseded(current.logId, retry.logId);
        if (!retry?.ok) retry.error = `Image template rejected for size (131053) and document template failed: ${retry.error}`;
        current = retry;
        currentChoice = documentChoice;
      }

      if (!current?.ok && isTemplateConfigError(current)) {
        console.error('[PAPER WHATSAPP] template rejected; trying plain document (delivered only inside a 24-hour window)', {
          paperId, studentId: student.id, recipient: recipient.key, templateName: currentChoice.templateName, error: current.error,
        });
        const plain = await api.sendDocumentMessage({
          coachingId, branchId, studentId: student.id, to: recipient.phone,
          documentUrl: document.fileUrl, filename: document.fileName, caption,
        });
        if (plain?.ok && current?.logId && typeof api.markLogSuperseded === 'function') await api.markLogSuperseded(current.logId, plain.logId);
        if (!plain?.ok) {
          plain.error = `Template ${currentChoice.templateName} rejected (${current.error}) and plain document failed: ${plain.error}`;
          plain.errorCode = getWhatsAppErrorCode(current) || plain.errorCode;
        }
        current = plain;
        channel = 'document';
      }

      outcomes.push(outcomeFromResult(recipient, channel, current, { templateName: channel === 'template' ? currentChoice.templateName : null }));
    } catch (error) {
      outcomes.push(outcomeFromResult(recipient, 'template', {
        ok: false, failed: true, error: error.message, errorCode: getWhatsAppErrorCode(error), response: error.response || null,
      }));
    }
  }

  return outcomes;
}

module.exports = {
  NO_VALID_NUMBER_REASON,
  DELIVERY_CATEGORIES,
  classifyDeliveryProblem,
  describeInvalidNumbers,
  getWhatsAppErrorCode,
  isReEngagementError,
  selectPaperRecipients,
  buildPaperTemplateComponents,
  META_IMAGE_LIMIT_BYTES,
  META_DOCUMENT_LIMIT_BYTES,
  resolveDocumentSize,
  choosePaperTemplate,
  paperDocumentLabel,
  deliverPaperDocument,
};
