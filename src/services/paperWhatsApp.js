const whatsappApi = require('./whatsapp');

// Delivery of one stored paper document to a list of WhatsApp recipients.
//
// Extracted from src/app.js (notifyPaperEvent) so the real send path can be exercised by
// regression tests with a fake Meta API, without booting the Express app / DB pool. The
// behaviour is unchanged (document message first, approved-template fallback on Meta
// error 131047 "re-engagement / 24-hour window") with one deliberate difference: every
// recipient gets an explicit outcome instead of failures being logged and then reported
// upstream as a blanket `ok: true`.

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

// Who receives a paper. recipientMode 'parent' (the checked-paper Excel import) sends ONLY to
// the parent/guardian WhatsApp number; 'all' keeps the original student + parent fan-out.
// Duplicate numbers are collapsed so nobody gets the same document twice.
function selectPaperRecipients(paperStudent, recipientMode = 'all') {
  const studentPhone = paperStudent.whatsapp_number || paperStudent.contact_phone;
  const parentPhone = paperStudent.parent_whatsapp_number || paperStudent.guardian_phone;
  return [
    ...(recipientMode === 'parent' ? [] : [{ key: 'student', phone: studentPhone }]),
    { key: 'parent', phone: parentPhone },
  ].filter((recipient, index, recipientsList) => (
    recipient.phone && recipientsList.findIndex((item) => item.phone === recipient.phone) === index
  ));
}

function buildPaperTemplateComponents({ recipientName, student, paper, paperUrl, fileName }) {
  return [
    {
      type: 'header',
      parameters: [
        { type: 'document', document: { link: paperUrl, filename: fileName || paper.original_name || 'paper.pdf' } },
      ],
    },
    {
      type: 'body',
      parameters: [
        { type: 'text', text: recipientName || student.name || student.roll_no || 'Parent' },
        { type: 'text', text: student.name || student.roll_no || 'Student' },
        { type: 'text', text: paper.test_label || paper.original_name || 'Test Paper' },
        { type: 'text', text: String(paper.marks_obtained ?? '-') },
        { type: 'text', text: String(paper.max_marks ?? '-') },
      ],
    },
  ];
}

async function sendPaperTemplateFallback({ coachingId, branchId, student, recipient, document, paperId, api = whatsappApi }) {
  const templateName = String(process.env.WHATSAPP_PAPER_TEMPLATE_NAME || 'paper_result_notification').trim();
  const languageCode = String(process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en').trim();
  if (!templateName) {
    console.error('[WHATSAPP TEMPLATE REQUIRED]', { paperId, studentId: student.id, recipient: recipient.key, reason: 'missing template name' });
    return { ok: false, failed: true, error: 'WhatsApp paper template name is missing' };
  }

  console.log('[PAPER WHATSAPP TEMPLATE START]', {
    paperId,
    studentId: student.id,
    recipient: recipient.key,
    templateName,
    languageCode,
  });

  const result = await api.sendTemplateMessage({
    coachingId,
    branchId,
    studentId: student.id,
    to: recipient.phone,
    templateName,
    languageCode,
    components: buildPaperTemplateComponents({
      recipientName: recipient.key === 'parent' ? student.parent_name || student.name || 'Parent' : student.name,
      student,
      paper: document.paper,
      paperUrl: document.fileUrl,
      fileName: document.fileName,
    }),
  });

  if (result?.failed || result?.ok === false) {
    console.error('[PAPER WHATSAPP TEMPLATE FAILED]', {
      paperId,
      studentId: student.id,
      recipient: recipient.key,
      error: result.error || result.reason || 'Template send failed',
    });
    console.error('[WHATSAPP TEMPLATE REQUIRED]', { paperId, studentId: student.id, recipient: recipient.key });
    return result;
  }

  console.log('[PAPER WHATSAPP TEMPLATE SENT]', {
    paperId,
    studentId: student.id,
    recipient: recipient.key,
    metaMessageId: result?.metaMessageId || null,
  });
  return result;
}

function outcomeFromResult(recipient, channel, result, extra = {}) {
  const failed = !result || result.failed || result.ok === false;
  return {
    key: recipient.key,
    phone: recipient.phone,
    // The E.164-style number actually handed to the WhatsApp API (country code added).
    to: whatsappApi.cleanPhoneNumber(recipient.phone),
    ok: !failed,
    channel,
    metaMessageId: result?.metaMessageId || null,
    error: failed ? (result?.error || result?.reason || 'WhatsApp send failed') : null,
    errorCode: failed ? (getWhatsAppErrorCode(result) || null) : null,
    response: result?.response || null,
    ...extra,
  };
}

// Sends `document` (the row's own stored file: {fileUrl, fileName, paper}) to each
// recipient and returns one outcome per recipient:
//   { key, phone, ok, channel: 'document' | 'template', metaMessageId, error, errorCode,
//     response, reEngagement }
// `ok` is true only when the Meta API accepted that message. It never throws.
async function deliverPaperDocument({
  document,
  student,
  recipients,
  caption,
  coachingId,
  branchId,
  paperId,
  api = whatsappApi,
}) {
  const outcomes = [];

  for (const recipient of recipients) {
    let reEngagement = false;
    let normalFailure = null;

    try {
      console.log('[PAPER WHATSAPP NORMAL START]', { recipient: recipient.key, studentId: student.id, paperId });
      const result = await api.sendDocumentMessage({
        coachingId,
        branchId,
        studentId: student.id,
        to: recipient.phone,
        documentUrl: document.fileUrl,
        filename: document.fileName,
        caption,
      });
      if (result?.failed || result?.ok === false) {
        normalFailure = result;
        reEngagement = isReEngagementError(result);
      } else {
        console.log('[PAPER WHATSAPP NORMAL SENT]', {
          recipient: recipient.key,
          studentId: student.id,
          paperId,
          metaMessageId: result?.metaMessageId || null,
        });
        outcomes.push(outcomeFromResult(recipient, 'document', result));
        continue;
      }
    } catch (error) {
      normalFailure = { ok: false, failed: true, error: error.message, errorCode: getWhatsAppErrorCode(error), response: error.response || null };
      reEngagement = isReEngagementError(error);
    }

    if (!reEngagement) {
      console.error('[WHATSAPP PAPER] failed', {
        recipient: recipient.key,
        studentId: student.id,
        paperId,
        error: normalFailure.error || 'WhatsApp document send failed',
      });
      outcomes.push(outcomeFromResult(recipient, 'document', normalFailure, { reEngagement: false }));
      continue;
    }

    console.error('[PAPER WHATSAPP 131047]', {
      recipient: recipient.key,
      studentId: student.id,
      paperId,
      error: normalFailure.error || 'Re-engagement message',
    });
    try {
      const templateResult = await sendPaperTemplateFallback({
        coachingId, branchId, student, recipient, document, paperId, api,
      });
      const outcome = outcomeFromResult(recipient, 'template', templateResult, { reEngagement: true });
      if (!outcome.ok) {
        outcome.error = `24-hour messaging window closed (131047) and template fallback failed: ${outcome.error}`;
      }
      outcomes.push(outcome);
    } catch (templateError) {
      outcomes.push(outcomeFromResult(recipient, 'template', {
        ok: false,
        failed: true,
        error: `24-hour messaging window closed (131047) and template fallback threw: ${templateError.message}`,
      }, { reEngagement: true }));
    }
  }

  return outcomes;
}

module.exports = {
  getWhatsAppErrorCode,
  isReEngagementError,
  selectPaperRecipients,
  buildPaperTemplateComponents,
  sendPaperTemplateFallback,
  deliverPaperDocument,
};
