const { resolveStudentForRollNumber } = require('./omrImportParsing');
const {
  NO_VALID_NUMBER_REASON,
  DELIVERY_CATEGORIES,
  classifyDeliveryProblem,
  describeInvalidNumbers,
  selectPaperRecipients,
} = require('./paperWhatsApp');

// Routing of the bulk paper upload: which uploaded file belongs to which student, and
// what happens to each paper. The business rule —
//
//   the uploaded FILENAME identifies the student (76.jpg -> roll 76). Every paper whose
//   student exists is saved and sent, whether or not its roll is in the Excel file.
//   The Excel file only supplies marks/progress-card data, matched by roll number.
//
// A scanner-named file (no roll in its name) can still be paired by the Excel row that
// lists it under "Checked File". Nothing is matched by array index, upload order or
// sorting, and anything ambiguous is reported with an explicit reason instead of guessed.
//
// This module is pure (no DB / Express / network): the route injects persistence and
// WhatsApp delivery, which lets the regression tests drive the same code path.

const FILENAME_LIKE_ROLL = /\.(jpe?g|png|pdf|tiff?|bmp|webp|gif)\s*$/i;

// "parent:***240" style labels, so logs show which numbers are configured without exposing them.
function describeConfiguredNumbers(student) {
  return selectPaperRecipients(student)
    .map((recipient) => `${recipient.key}:***${String(recipient.phone).replace(/\D/g, '').slice(-3)}`);
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

// A filename names a roll when its first token is a short run of digits: "76.jpg",
// "76_checked.jpg", "076-PC1.jpg". Long digit runs are scanner sequence numbers or
// timestamps ("20260915160533_0002.jpg"), never a roll.
function rollFromFileName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  const first = base.split(/[_\-\s]+/).filter(Boolean)[0] || '';
  return /^\d{1,6}$/.test(first) ? first : null;
}

// Classifies every UPLOADED FILE (the paper is what gets sent; Excel only supplies marks).
// Returns one plan per file, in upload order:
//   { file, fileName, status: 'ready' | 'student_not_found' | 'invalid_filename' | 'duplicate_file',
//     reason, category, student, rollNo, source: 'filename' | 'excel_checked_file', excelRow, notes }
// plus excelOnlyRows: Excel rows with no uploaded paper.
function planPaperFiles(files, excelRows, students) {
  const excelPlans = planCheckedPaperRows(excelRows, students, files);
  const excelByStudent = new Map();
  const excelByFile = new Map();
  for (const excelPlan of excelPlans) {
    if (excelPlan.student) {
      if (!excelByStudent.has(excelPlan.student.id)) excelByStudent.set(excelPlan.student.id, []);
      excelByStudent.get(excelPlan.student.id).push(excelPlan);
    }
    if (excelPlan.row.checkedFile) {
      if (!excelByFile.has(excelPlan.row.checkedFile)) excelByFile.set(excelPlan.row.checkedFile, []);
      excelByFile.get(excelPlan.row.checkedFile).push(excelPlan);
    }
  }
  const uploadedNameCounts = new Map();
  for (const file of files) {
    uploadedNameCounts.set(file.originalname, (uploadedNameCounts.get(file.originalname) || 0) + 1);
  }

  const plans = files.map((file) => {
    const fileName = file.originalname;
    const plan = {
      file, fileName, status: 'ready', reason: null, category: null,
      student: null, rollNo: null, source: null, excelRow: null, notes: [],
    };
    if ((uploadedNameCounts.get(fileName) || 0) > 1) {
      return Object.assign(plan, {
        status: 'invalid_filename',
        category: DELIVERY_CATEGORIES.INVALID_FILENAME,
        reason: `The filename "${fileName}" was uploaded more than once; cannot tell which copy to send`,
      });
    }

    // 1. The filename is the primary source: 76.jpg -> roll 76.
    const filenameRoll = rollFromFileName(fileName);
    if (filenameRoll) {
      const { student, matchType } = resolveStudentForRollNumber(filenameRoll, students);
      if (matchType === 'ambiguous') {
        return Object.assign(plan, {
          status: 'student_not_found',
          rollNo: filenameRoll,
          category: DELIVERY_CATEGORIES.STUDENT_NOT_FOUND,
          reason: `Roll number ${filenameRoll} matches more than one student in the database; refusing to guess`,
        });
      }
      if (student) Object.assign(plan, { student, rollNo: student.roll_no, source: 'filename' });
    }

    // 2. A scanner-named file ("20260915160533_0002.jpg") can still be paired explicitly by
    //    the Excel row that lists it in its Checked File column.
    if (!plan.student) {
      const naming = excelByFile.get(fileName) || [];
      if (naming.length === 1 && naming[0].student) {
        Object.assign(plan, { student: naming[0].student, rollNo: naming[0].student.roll_no, source: 'excel_checked_file', excelRow: naming[0].row });
      }
    }

    if (!plan.student) {
      const naming = excelByFile.get(fileName) || [];
      if (!filenameRoll && naming.length === 1 && naming[0].reason) {
        // The Excel row pairing this file names a roll that cannot be resolved; say why.
        return Object.assign(plan, {
          status: 'student_not_found',
          rollNo: naming[0].row.rollNo || null,
          category: naming[0].status === 'invalid_roll_number' ? DELIVERY_CATEGORIES.INVALID_FILENAME : DELIVERY_CATEGORIES.STUDENT_NOT_FOUND,
          reason: `Excel row ${naming[0].row.rowNumber}: ${naming[0].reason}`,
        });
      }
      return Object.assign(plan, filenameRoll
        ? {
          status: 'student_not_found',
          rollNo: filenameRoll,
          category: DELIVERY_CATEGORIES.STUDENT_NOT_FOUND,
          reason: `Student with roll number ${filenameRoll} not found in database.`,
        }
        : {
          status: 'invalid_filename',
          category: DELIVERY_CATEGORIES.INVALID_FILENAME,
          reason: `Could not read a roll number from filename "${fileName}" and no Excel row lists it under Checked File`,
        });
    }

    // Excel only supplies marks, matched by the resolved student's roll number.
    if (!plan.excelRow) {
      const rows = excelByStudent.get(plan.student.id) || [];
      if (rows.length === 1) plan.excelRow = rows[0].row;
      if (rows.length > 1) {
        plan.notes.push(`Roll ${plan.rollNo} appears in ${rows.length} Excel rows (${rows.map((r) => r.row.rowNumber).join(', ')}); Excel marks not applied`);
      }
    }
    for (const naming of excelByFile.get(fileName) || []) {
      if (naming.student && naming.student.id !== plan.student.id) {
        plan.notes.push(`Excel row ${naming.row.rowNumber} lists this file under roll ${naming.row.rollNo}; the filename's roll ${plan.rollNo} was used`);
      }
    }
    return plan;
  });

  // Two different files resolving to the same student: nobody can tell which is the paper.
  const plansByStudent = new Map();
  for (const plan of plans) {
    if (plan.status !== 'ready') continue;
    if (!plansByStudent.has(plan.student.id)) plansByStudent.set(plan.student.id, []);
    plansByStudent.get(plan.student.id).push(plan);
  }
  for (const group of plansByStudent.values()) {
    if (group.length < 2) continue;
    const names = group.map((plan) => plan.fileName).join(', ');
    for (const plan of group) {
      Object.assign(plan, {
        status: 'duplicate_file',
        category: DELIVERY_CATEGORIES.DUPLICATE_FILE,
        reason: `Files ${names} all resolve to roll ${plan.rollNo}; ambiguous, so none of them is sent`,
      });
    }
  }

  const usedExcelRows = new Set(plans.filter((plan) => plan.excelRow).map((plan) => plan.excelRow));
  const excelOnlyRows = excelRows
    .filter((row) => !usedExcelRows.has(row))
    .map((row) => ({
      row: row.rowNumber,
      rollNo: row.rollNo || row.rollNoRaw || '-',
      checkedFile: row.checkedFile || '(blank)',
      reason: 'Excel row has no uploaded paper for this roll number (marks not saved)',
    }));

  return { plans, excelOnlyRows };
}

function maskNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-3)}` : '-';
}

// Executes the plan. deps:
//   savePaper({ row, student, file })  -> { status: 'inserted'|'replaced'|'duplicate', paperId, notifyType }
//                                         (row is the student's Excel row, or null)
//   notify({ row, student, paperId, notifyType }) -> notifyPaperEvent-style result
//   onFileDone(progress) (optional) — called once per uploaded file on every exit path
// Returns { results, excelOnlyRows }: one processing result per uploaded file:
//   { studentId, studentName, rollNo, filename, paperId, excelRowNumber, recipients, sentCount,
//     failedCount, finalStatus: 'sent'|'partial'|'failed'|'skipped', reasons: [{category, detail}], notes }
async function runPaperUpload({ files, excelRows = [], students, deps, onFileDone = () => {}, logger = console }) {
  const { plans, excelOnlyRows } = planPaperFiles(files, excelRows, students);
  const progress = { processed: 0, saved: 0, notSaved: 0 };
  const results = [];

  for (const plan of plans) {
    const result = {
      studentId: plan.student?.id || null,
      studentName: plan.student?.name || null,
      rollNo: plan.rollNo,
      filename: plan.fileName,
      paperId: null,
      excelRowNumber: plan.excelRow?.rowNumber || null,
      recipients: [],
      sentCount: 0,
      failedCount: 0,
      finalStatus: 'skipped',
      reasons: [],
      notes: plan.notes,
    };
    try {
      if (plan.status !== 'ready') {
        result.reasons.push({ category: plan.category, detail: plan.reason });
        progress.notSaved += 1;
        logger.log(`[PAPER UPLOAD] ${plan.fileName}: NOT SENT - ${plan.reason}`);
        continue;
      }

      const { student, file, excelRow } = plan;
      logger.log(`[PAPER UPLOAD] ${plan.fileName} → roll ${plan.rollNo} (${plan.source}) → student_id=${student.id} → Excel row ${excelRow?.rowNumber || 'none'} → numbers ${describeConfiguredNumbers(student).join(', ') || 'NONE'}`);

      let saved;
      try {
        saved = await deps.savePaper({ row: excelRow, student, file });
      } catch (err) {
        logger.error('[PAPER UPLOAD] save failed', { file: plan.fileName, rollNo: plan.rollNo, error: err.message });
        result.finalStatus = 'failed';
        result.reasons.push({ category: DELIVERY_CATEGORIES.SAVE_FAILED, detail: err.message || 'Upload failed while saving file' });
        progress.notSaved += 1;
        continue;
      }
      progress.saved += 1;
      result.paperId = saved.paperId;

      for (const invalid of describeInvalidNumbers(student)) {
        result.reasons.push({ category: DELIVERY_CATEGORIES.INVALID_NUMBER, detail: `${invalid.key}: ${invalid.reason}`, recipient: invalid.phone });
      }

      if (saved.status === 'duplicate') {
        result.reasons.push({ category: DELIVERY_CATEGORIES.DUPLICATE_UPLOAD, detail: 'Duplicate click ignored; this paper was already uploaded and sent moments ago' });
        continue;
      }

      // Isolated from the save above: a WhatsApp failure is never an upload failure and
      // never stops the remaining files.
      let notifyResult;
      try {
        notifyResult = await deps.notify({ row: excelRow, student, paperId: saved.paperId, notifyType: saved.notifyType });
      } catch (notifyErr) {
        notifyResult = { ok: false, error: `WhatsApp send threw: ${notifyErr.message}` };
      }

      result.recipients = (notifyResult?.results || []).map((outcome) => ({
        key: outcome.key,
        to: outcome.to || outcome.phone,
        ok: outcome.ok,
        channel: outcome.channel,
        logId: outcome.logId || null,
        metaMessageId: outcome.metaMessageId || null,
        error: outcome.error || null,
        errorCode: outcome.errorCode || null,
      }));
      result.sentCount = result.recipients.filter((r) => r.ok).length;
      result.failedCount = result.recipients.length - result.sentCount;
      for (const recipient of result.recipients.filter((r) => !r.ok)) {
        result.reasons.push({ category: classifyDeliveryProblem(recipient), detail: recipient.error, recipient: recipient.to });
      }
      if (!result.recipients.length) {
        const detail = notifyResult?.reason || notifyResult?.error || 'WhatsApp notification returned no result';
        result.reasons.push({
          category: detail === NO_VALID_NUMBER_REASON ? DELIVERY_CATEGORIES.NO_VALID_NUMBER : classifyDeliveryProblem({ error: detail }),
          detail,
        });
        result.finalStatus = notifyResult?.skipped ? 'skipped' : 'failed';
      } else {
        result.finalStatus = !result.failedCount ? 'sent' : (result.sentCount ? 'partial' : 'failed');
      }
      logger.log('[PAPER UPLOAD SEND]', JSON.stringify({
        file: result.filename,
        student_id: result.studentId,
        roll: result.rollNo,
        recipients: result.recipients.map((r) => ({ role: r.key, to: maskNumber(r.to), ok: r.ok, channel: r.channel, error: r.error })),
        final: result.finalStatus,
      }));
    } finally {
      results.push(result);
      progress.processed += 1;
      onFileDone(progress);
    }
  }

  return { results, excelOnlyRows };
}

module.exports = {
  planCheckedPaperRows,
  planPaperFiles,
  rollFromFileName,
  runPaperUpload,
  describeConfiguredNumbers,
};
