const { classifyDeliveryProblem } = require('./paperWhatsApp');

// Builds the top-of-page summary of one bulk paper upload from the stored per-paper results
// plus the LIVE status of each recipient's whatsapp_logs row (finalStatuses: Map from the
// first attempt's log id to the status of the attempt that finally carried the message, as
// returned by whatsapp.getFinalLogStatuses). A first attempt that failed with 131047 and was
// replaced by an approved-template retry therefore reports the retry's sent/delivered/read.

const DELIVERED_STATUSES = new Set(['sent', 'delivered', 'read']);

function recipientLiveState(recipient, finalStatuses) {
  const live = recipient.logId ? finalStatuses.get(Number(recipient.logId)) : null;
  if (!live) {
    return recipient.ok
      ? { state: 'sent', status: 'Sent', reason: 'Accepted by WhatsApp' }
      : { state: 'failed', status: 'Failed', reason: recipient.error || 'WhatsApp send failed', category: classifyDeliveryProblem(recipient) };
  }
  const status = String(live.status || '').toLowerCase();
  const via = live.viaTemplate ? ' (via approved template after the first attempt was rejected)' : '';
  if (status === 'read') return { state: 'sent', status: 'Read', reason: `Delivered and read${via}` };
  if (status === 'delivered') return { state: 'sent', status: 'Delivered', reason: `Delivered successfully${via}` };
  if (status === 'sent') return { state: 'sent', status: 'Sent', reason: `Accepted by WhatsApp, waiting for delivery report${via}` };
  if (status === 'failed') {
    const error = live.lastError || recipient.error || 'WhatsApp reported the message as failed';
    return { state: 'failed', status: 'Failed', reason: error, category: classifyDeliveryProblem({ error }) };
  }
  return { state: 'pending', status: 'Pending', reason: 'Waiting for WhatsApp to respond' };
}

function buildPaperUploadSummary({ results = [], excelOnlyRows = [] }, finalStatuses = new Map()) {
  const counts = { processed: results.length, sent: 0, partial: 0, failed: 0, skipped: 0, pending: 0 };
  const reasonCounts = new Map();
  const rows = [];
  const countReason = (category) => reasonCounts.set(category, (reasonCounts.get(category) || 0) + 1);

  for (const paper of results) {
    const base = { student: paper.studentName || '-', rollNo: paper.rollNo || '-', paper: paper.filename };
    const states = (paper.recipients || []).map((recipient) => ({ recipient, ...recipientLiveState(recipient, finalStatuses) }));

    for (const item of states) {
      rows.push({ ...base, recipient: item.recipient.to || '-', status: item.status, reason: item.category ? `${item.category}: ${item.reason}` : item.reason });
      if (item.category) countReason(item.category);
    }
    // Paper-level reasons (not found, no valid number, invalid stored numbers, save failure, ...).
    // Recipient failures are already counted above from their live state.
    for (const reason of paper.reasons || []) {
      if (states.some((item) => item.recipient.to === reason.recipient)) continue;
      rows.push({ ...base, recipient: reason.recipient || '-', status: states.length ? 'Not sent' : (paper.finalStatus === 'failed' ? 'Failed' : 'Skipped'), reason: `${reason.category}: ${reason.detail}` });
      countReason(reason.category);
    }

    let finalStatus;
    if (!states.length) finalStatus = paper.finalStatus === 'failed' ? 'failed' : 'skipped';
    else {
      const sent = states.filter((item) => item.state === 'sent').length;
      const failed = states.filter((item) => item.state === 'failed').length;
      if (failed && sent) finalStatus = 'partial';
      else if (failed) finalStatus = 'failed';
      else if (sent === states.length) finalStatus = 'sent';
      else finalStatus = 'pending';
    }
    counts[finalStatus] += 1;
  }

  const reasons = [...reasonCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  return { counts, reasons, rows, excelOnlyRows };
}

module.exports = {
  recipientLiveState,
  buildPaperUploadSummary,
};
