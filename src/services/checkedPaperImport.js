const { resolveStudentForRollNumber } = require('./omrImportParsing');

// Routing of the bulk "Checked File" Excel import: which uploaded file belongs to which
// student, and what happens to each row. The business rule is strict —
//
//   the file named in a row's "Checked File" column goes to the student whose
//   "Roll Number" is in THAT SAME row, and to nobody else.
//
// so the Excel row is the only thing that pairs a roll number with a file. Nothing here
// matches by array index, upload order, sorting, or a roll number parsed from a filename,
// and anything ambiguous is skipped with an explicit reason instead of being guessed.
//
// This module is pure (no DB / Express / network): the route injects persistence and
// WhatsApp delivery, which lets the regression tests drive the same code path.

const FILENAME_LIKE_ROLL = /\.(jpe?g|png|pdf|tiff?|bmp|webp|gif)\s*$/i;

function resolveParentPhone(student) {
  return student?.parent_whatsapp_number || student?.guardian_phone || null;
}

// Classifies every Excel row. Returns one plan per row, in Excel order:
//   { row, status: 'ready' | 'invalid_filename' | 'invalid_roll_number' | 'missing_student'
//                  | 'duplicate_mapping' | 'missing_file', reason, student, matchType, file }
// A 'ready' plan carries the resolved student and the uploaded file object.
function planCheckedPaperRows(excelRows, students, uploadedFiles) {
  const filesByName = new Map();
  const uploadedNameCounts = new Map();
  for (const file of uploadedFiles) {
    uploadedNameCounts.set(file.originalname, (uploadedNameCounts.get(file.originalname) || 0) + 1);
    if (!filesByName.has(file.originalname)) filesByName.set(file.originalname, file);
  }

  // Pass 1: per-row identity checks that need no other row.
  const plans = excelRows.map((row) => {
    const plan = { row, status: 'ready', reason: null, student: null, matchType: 'none', file: null };
    if (!row.checkedFile) {
      return Object.assign(plan, { status: 'invalid_filename', reason: 'Checked File value is blank' });
    }
    if (!row.rollNo) {
      return Object.assign(plan, {
        status: 'invalid_roll_number',
        reason: row.rollNoRaw
          ? `Could not extract a roll number from Roll Number value "${row.rollNoRaw}" (no digits found)`
          : 'Roll Number is blank',
      });
    }
    // A filename (or the row's own Checked File) sitting in the Roll Number column means
    // the cells are misaligned; its digits are a scan sequence / timestamp, never a roll.
    if (row.rollNoRaw === row.checkedFile || FILENAME_LIKE_ROLL.test(row.rollNoRaw || '')) {
      return Object.assign(plan, {
        status: 'invalid_roll_number',
        reason: `Roll Number value "${row.rollNoRaw}" looks like a filename, not a roll number`,
      });
    }
    const { student, matchType } = resolveStudentForRollNumber(row.rollNo, students);
    plan.student = student;
    plan.matchType = matchType;
    if (!student) {
      plan.status = 'missing_student';
      plan.reason = matchType === 'ambiguous'
        ? `Roll number "${row.rollNo}" matches more than one student; refusing to guess`
        : `No student found for roll number "${row.rollNo}"`;
    }
    return plan;
  });

  // Pass 2: ambiguity across rows. If two rows claim the same student, or the same file,
  // nobody can tell which pairing is right — so NONE of them is sent.
  const rowsByStudentKey = new Map();
  const rowsByFile = new Map();
  for (const plan of plans) {
    if (!plan.row.checkedFile) continue;
    // Keyed by the RESOLVED student, so "075" and "75" (same student via the zero-pad
    // fallback) are still recognised as two rows claiming one student.
    if (plan.student) {
      const studentKey = `student:${plan.student.id}`;
      if (!rowsByStudentKey.has(studentKey)) rowsByStudentKey.set(studentKey, []);
      rowsByStudentKey.get(studentKey).push(plan);
    }
    if (!rowsByFile.has(plan.row.checkedFile)) rowsByFile.set(plan.row.checkedFile, []);
    rowsByFile.get(plan.row.checkedFile).push(plan);
  }
  for (const group of rowsByStudentKey.values()) {
    if (group.length < 2) continue;
    const rowNumbers = group.map((plan) => plan.row.rowNumber).join(', ');
    for (const plan of group) {
      if (plan.status !== 'ready' && plan.status !== 'missing_student') continue;
      plan.status = 'duplicate_mapping';
      plan.reason = `Duplicate Roll Number "${plan.row.rollNo}" in Excel (rows ${rowNumbers}); ambiguous, so none of these rows is sent`;
    }
  }
  for (const [fileName, group] of rowsByFile) {
    if (group.length < 2) continue;
    const rowNumbers = group.map((plan) => plan.row.rowNumber).join(', ');
    for (const plan of group) {
      if (plan.status !== 'ready' && plan.status !== 'missing_student' && plan.status !== 'invalid_roll_number') continue;
      plan.status = 'duplicate_mapping';
      plan.reason = `Duplicate Checked File "${fileName}" in Excel (rows ${rowNumbers}); ambiguous, so none of these rows is sent`;
    }
  }

  // Pass 3: the uploaded file itself.
  for (const plan of plans) {
    if (plan.status !== 'ready') continue;
    const name = plan.row.checkedFile;
    if ((uploadedNameCounts.get(name) || 0) > 1) {
      plan.status = 'duplicate_mapping';
      plan.reason = `Multiple uploaded files share the filename "${name}"; cannot determine which one to use`;
    } else if (!filesByName.has(name)) {
      plan.status = 'missing_file';
      plan.reason = `No uploaded file matches Checked File "${name}"`;
    } else {
      plan.file = filesByName.get(name);
    }
  }

  return plans;
}

const REPORT_COUNTER_BY_STATUS = {
  invalid_filename: 'invalidFilename',
  invalid_roll_number: 'failed',
  missing_student: 'missingStudent',
  duplicate_mapping: 'duplicateMapping',
  missing_file: 'missingFile',
};

function summarizeWhatsApp(student, notifyResult) {
  if (!notifyResult) return { status: 'failed', reason: 'WhatsApp notification returned no result' };
  if (notifyResult.ok) return { status: 'sent', reason: null };
  if (notifyResult.skipped) return { status: 'skipped', reason: notifyResult.reason || 'skipped' };
  return { status: 'failed', reason: notifyResult.reason || notifyResult.error || 'WhatsApp send failed' };
}

// Executes the plan. deps:
//   savePaper({ row, student, file })  -> { status: 'inserted'|'replaced'|'duplicate', paperId, notifyType }
//   notify({ row, student, paperId, notifyType }) -> notifyPaperEvent-style result
//   onRowDone(report) (optional) — progress hook, called once per Excel row on every exit path
// Every row ends with exactly one report.details entry and one [CHECKED PAPER] log line.
async function runCheckedPaperImport({ excelRows, students, files, deps, onRowDone = () => {}, logger = console }) {
  const report = {
    totalRows: 0,
    imported: 0,
    missingStudent: 0,
    missingFile: 0,
    invalidFilename: 0,
    duplicateMapping: 0,
    failed: 0,
    whatsappSent: 0,
    whatsappFailed: 0,
    whatsappSkipped: 0,
    details: [],
    sendLog: [],
  };
  const plans = planCheckedPaperRows(excelRows, students, files);
  const referencedFiles = new Set();

  for (const plan of plans) {
    const { row } = plan;
    try {
      report.totalRows += 1;

      if (plan.status !== 'ready') {
        report[REPORT_COUNTER_BY_STATUS[plan.status]] += 1;
        report.details.push({
          row: row.rowNumber,
          rollNo: row.rollNo || row.rollNoRaw || '-',
          file: row.checkedFile || '(blank)',
          status: plan.status,
          reason: plan.reason,
        });
        logger.log(`[CHECKED PAPER] Skipped: ${plan.reason} (row ${row.rowNumber}, roll ${row.rollNo || row.rollNoRaw || '-'}, file ${row.checkedFile || '(blank)'})`);
        continue;
      }

      const { student, file } = plan;
      const recipientPhone = resolveParentPhone(student);
      referencedFiles.add(row.checkedFile);
      logger.log('[BULK PAPER UPLOAD] roll number resolution', {
        row: row.rowNumber,
        rollNoRaw: row.rollNoRaw,
        rollNo: row.rollNo,
        excelStudentName: row.studentName || null,
        matchType: plan.matchType,
        resolvedStudentId: student.id,
        resolvedRollNo: student.roll_no,
        resolvedStudentName: student.name || null,
      });
      logger.log(`[CHECKED PAPER] Row ${row.rowNumber}: Roll ${row.rollNo} → student_id=${student.id} → file=${row.checkedFile} → parent recipient=${recipientPhone || 'MISSING'}`);

      let saved;
      try {
        saved = await deps.savePaper({ row, student, file });
      } catch (err) {
        logger.error('[BULK PAPER UPLOAD] Excel row save failed', { row: row.rowNumber, file: row.checkedFile, rollNo: row.rollNo, error: err.message });
        report.failed += 1;
        report.details.push({ row: row.rowNumber, rollNo: row.rollNo, file: row.checkedFile, status: 'failed', reason: err.message || 'Upload failed while saving file' });
        continue;
      }

      let whatsapp;
      let notifyResult = null;
      if (saved.status === 'duplicate') {
        whatsapp = { status: 'skipped', reason: 'Duplicate click ignored; this paper was already imported and sent moments ago' };
      } else {
        // Isolated from the save above: a WhatsApp failure is never an import failure and
        // never stops the remaining rows.
        try {
          notifyResult = await deps.notify({ row, student, paperId: saved.paperId, notifyType: saved.notifyType });
          whatsapp = summarizeWhatsApp(student, notifyResult);
        } catch (notifyErr) {
          whatsapp = { status: 'failed', reason: `WhatsApp send threw: ${notifyErr.message}` };
        }
      }
      if (whatsapp.status === 'sent') report.whatsappSent += 1;
      else if (whatsapp.status === 'failed') report.whatsappFailed += 1;
      else report.whatsappSkipped += 1;

      report.imported += 1;
      report.details.push({
        row: row.rowNumber,
        rollNo: row.rollNo,
        file: row.checkedFile,
        status: saved.status === 'duplicate' ? 'duplicate_recent_upload' : 'imported',
        reason: saved.status === 'duplicate'
          ? `Duplicate click ignored for roll number "${row.rollNo}" (already imported moments ago)`
          : `Assigned to roll number "${row.rollNo}"`,
        whatsapp,
      });

      const sendRecord = {
        row: row.rowNumber,
        student_id: student.id,
        roll_number: row.rollNo,
        checked_filename: row.checkedFile,
        resolved_file_url: notifyResult?.fileUrl || null,
        sent_document_filename: notifyResult?.fileName || null,
        recipients: (notifyResult?.results || []).map((outcome) => ({
          role: outcome.key,
          whatsapp_number: outcome.to || outcome.phone,
          channel: outcome.channel,
          accepted_by_api: outcome.ok,
          meta_message_id: outcome.metaMessageId,
          api_response: outcome.response,
          error: outcome.error,
        })),
        configured_parent_number: recipientPhone,
        final: whatsapp.status,
        reason: whatsapp.reason,
      };
      report.sendLog.push(sendRecord);
      logger.log('[CHECKED PAPER SEND]', JSON.stringify(sendRecord));
      if (whatsapp.status === 'sent') {
        logger.log(`[CHECKED PAPER] Row ${row.rowNumber}: WhatsApp accepted by API for roll ${row.rollNo} (${row.checkedFile})`);
      } else {
        logger.log(`[CHECKED PAPER] Row ${row.rowNumber}: WhatsApp ${whatsapp.status.toUpperCase()} for student_id=${student.id} (roll ${row.rollNo}) - ${whatsapp.reason}`);
      }
    } finally {
      onRowDone(report);
    }
  }

  report.unmatchedFiles = files
    .map((file) => file.originalname)
    .filter((name) => !referencedFiles.has(name));
  return report;
}

module.exports = {
  planCheckedPaperRows,
  runCheckedPaperImport,
  resolveParentPhone,
};
