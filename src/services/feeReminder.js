const { sendWhatsAppNotification } = require('./notificationService');
const { getStudentFeeSummary } = require('./feeStructure');

function formatDate(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
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

function formatWhatsAppAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return '0';
  return amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

async function buildFeeReminderMessage({ student, fee, coaching, reminderType }) {
  const feeSummary = fee.feeSummary || await getStudentFeeSummary(
    student.coaching_id || coaching?.coaching_id || coaching?.id,
    student.branch_id,
    student.id
  );
  return compactWhatsAppMessage([
    `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
    '',
    '💰 Fee Reminder',
    '',
    `Student: ${student.name || student.roll_no}`,
    `Pending Amount: ₹${formatWhatsAppAmount(feeSummary.pendingFee ?? fee.amount ?? 0)}`,
    `Due Date: ${formatDate(fee.due_date)}`,
    '',
    'Reply FEES for complete details.',
  ]);
}

async function sendDueFeeReminder({ coachingId, student, fee, coaching, eventKey = null }) {
  return sendWhatsAppNotification({
    studentId: student.id,
    phone: student.parent_whatsapp_number || student.guardian_phone,
    type: 'fee_due_reminder',
    message: await buildFeeReminderMessage({ student: { ...student, coaching_id: coachingId }, fee, coaching, reminderType: 'due' }),
    eventKey: eventKey || `fee_due_reminder:${student.id}:${fee.id || fee.fee_id}:${formatDate(fee.due_date)}`,
  });
}

async function sendOverdueReminder({ coachingId, student, fee, coaching, eventKey = null }) {
  return sendWhatsAppNotification({
    studentId: student.id,
    phone: student.parent_whatsapp_number || student.guardian_phone,
    type: 'fee_overdue_reminder',
    message: await buildFeeReminderMessage({ student: { ...student, coaching_id: coachingId }, fee, coaching, reminderType: 'overdue' }),
    eventKey: eventKey || `fee_overdue_reminder:${student.id}:${fee.id || fee.fee_id}:${formatDate(fee.due_date)}`,
  });
}

module.exports = {
  sendDueFeeReminder,
  sendOverdueReminder,
};
