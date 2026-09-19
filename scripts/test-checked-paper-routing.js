// End-to-end regression test for the checked-paper Excel import → WhatsApp flow.
//
//   real .xlsx bytes → toBulkPaperExcelRows (real parser) → runCheckedPaperImport (real
//   planner + orchestrator) → deliverPaperDocument → whatsapp.js sendDocumentMessage /
//   sendMetaMessage (real code) → fetch (FAKE Meta Graph API)
//
// Only the edges are faked: the database (stubbed module), file storage (in-memory), and the
// network (global.fetch). No real DB, S3 or WhatsApp credentials are ever loaded or used —
// this script never requires src/app.js or .env, and refuses to run if DATABASE_URL is set.
//
// Business rule under test: the file named in a row's "Checked File" column goes to the
// parent WhatsApp number of the student whose "Roll Number" is in THAT SAME row.
//
// Run with: node scripts/test-checked-paper-routing.js

const assert = require('assert');
const path = require('path');

if (process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is set. This test must never touch a real database.');
  process.exit(2);
}
process.env.WHATSAPP_ACCESS_TOKEN = 'TEST_ONLY_TOKEN';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'TEST_PHONE_NUMBER_ID';
process.env.WHATSAPP_PAPER_TEMPLATE_NAME = 'paper_result_notification';

// Stub src/db.js BEFORE anything requires it, so config/database (and .env) never load.
const dbLogs = [];
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    run: async (sql, params) => { dbLogs.push({ sql, params }); return { lastID: dbLogs.length }; },
    get: async () => null,
    all: async () => [],
  },
};

const { buildXlsx } = require('./lib/xlsx-fixture');
const { toBulkPaperExcelRows, extractRollNumberDigits } = require('../src/services/omrImportParsing');
const { runCheckedPaperImport } = require('../src/services/checkedPaperImport');
const { selectPaperRecipients, deliverPaperDocument } = require('../src/services/paperWhatsApp');

let failures = 0;
let passes = 0;
function check(description, fn) {
  try {
    fn();
    passes += 1;
    console.log(`PASS  ${description}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${description}`);
    console.error(`      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

// ---------- fixtures ----------
const HEADERS = ['Student', 'Roll Number', 'Paper Code', 'Physics', 'Chemistry', 'Biology', 'Total Score', 'Correct', 'Wrong', 'Blank', 'Multi-marked', 'Checked File'];
const excelRow = (student, roll, file) => [student, roll, 'PC1', 40, 30, 50, 120, 30, 5, 2, 0, file];

const STUDENTS = [
  { id: 175, roll_no: '75', name: 'Asha', parent_whatsapp_number: '9000000075', whatsapp_number: '8000000075', contact_phone: '7000000075' },
  { id: 191, roll_no: '91', name: 'Bhavna', parent_whatsapp_number: '9000000091', whatsapp_number: '8000000091' },
  { id: 180, roll_no: '80', name: 'Chirag', parent_whatsapp_number: '9000000080', whatsapp_number: '8000000080' },
  // Distractors: their roll numbers equal the "_0002/_0003/_0004" scan sequence numbers
  // embedded in the checked filenames. They must NEVER receive 75/91/80's files.
  { id: 2, roll_no: '2', name: 'Distractor Two', parent_whatsapp_number: '9000000002' },
  { id: 3, roll_no: '3', name: 'Distractor Three', parent_whatsapp_number: '9000000003' },
  { id: 4, roll_no: '4', name: 'Distractor Four', parent_whatsapp_number: '9000000004' },
  // No parent number, but the student has their own WhatsApp number — must not be used.
  { id: 160, roll_no: '60', name: 'No Parent', whatsapp_number: '8000000060', contact_phone: '7000000060' },
  // Parent number stored only as guardian_phone.
  { id: 161, roll_no: '61', name: 'Guardian Only', guardian_phone: '9000000061' },
  // Two students sharing one roll number (data problem) — ambiguous.
  { id: 199, roll_no: '99', name: 'Dup A', parent_whatsapp_number: '9000000199' },
  { id: 299, roll_no: '99', name: 'Dup B', parent_whatsapp_number: '9000000299' },
];
const PARENT_TO = (student) => `91${student.parent_whatsapp_number || student.guardian_phone}`;
const byRoll = (roll) => STUDENTS.find((s) => s.roll_no === roll);

// ---------- harness ----------
function makeUploaded(names) {
  return names.map((name) => ({ originalname: name, buffer: Buffer.from(`BYTES-OF:${name}`), mimetype: 'image/jpeg', size: 20 }));
}

const okApi = (body, callNumber) => ({ status: 200, json: { messaging_product: 'whatsapp', messages: [{ id: `wamid.TEST${callNumber}` }] } });

async function runImport({ rows, uploaded, students = STUDENTS, api = okApi, savePaperImpl = null, excelBuffer = null }) {
  const buffer = excelBuffer || buildXlsx([HEADERS, ...rows]);
  const excelRows = toBulkPaperExcelRows(buffer);
  const files = makeUploaded(uploaded);

  const calls = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, authorization: options.headers.Authorization, body });
    const scripted = api(body, calls.length);
    if (scripted.throw) throw new Error(scripted.throw);
    return { status: scripted.status, ok: scripted.status >= 200 && scripted.status < 300, json: async () => scripted.json };
  };

  const store = [];
  const logs = [];
  const logger = {
    log: (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    error: (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
  };
  const realLog = console.log;
  const realError = console.error;
  const realWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};

  let report;
  try {
    report = await runCheckedPaperImport({
      excelRows,
      students,
      files,
      logger,
      deps: {
        savePaper: savePaperImpl || (async ({ student, file }) => {
          const paperId = store.length + 1000;
          store.push({
            paperId,
            studentId: student.id,
            originalname: file.originalname,
            bytes: file.buffer.toString(),
            url: `https://cdn.test/papers/2026-09-15/uuid-${paperId}_${file.originalname}`,
          });
          return { status: 'inserted', paperId, notifyType: 'test_result_published' };
        }),
        // Mirrors notifyPaperEvent: looks the paper up by (paperId AND studentId) exactly like
        // getPaperDocumentUrl's SQL, picks recipients with the shared selectPaperRecipients
        // (parent-only), then delivers through the real send code.
        notify: async ({ student, paperId }) => {
          const paper = store.find((p) => p.paperId === paperId && p.studentId === student.id);
          if (!paper) return { ok: false, skipped: true, reason: 'Real S3 paper not found' };
          const recipients = selectPaperRecipients(student, 'parent');
          if (!recipients.length) {
            return { ok: false, skipped: true, reason: 'No parent/guardian WhatsApp number on file', fileUrl: paper.url, fileName: paper.originalname, results: [] };
          }
          const results = await deliverPaperDocument({
            document: { fileUrl: paper.url, fileName: paper.originalname, paper: { original_name: paper.originalname, test_label: 'PC1', marks_obtained: 120, max_marks: 180 } },
            student,
            recipients,
            caption: 'caption',
            coachingId: 1,
            branchId: 1,
            paperId,
          });
          const failed = results.filter((r) => !r.ok);
          return {
            ok: failed.length === 0,
            sent: results.length - failed.length,
            failed: failed.length,
            fileUrl: paper.url,
            fileName: paper.originalname,
            results,
            ...(failed.length ? { reason: failed.map((r) => `${r.key}: ${r.error}`).join('; ') } : {}),
          };
        },
      },
    });
  } finally {
    console.log = realLog;
    console.error = realError;
    console.warn = realWarn;
  }
  return { report, calls, store, logs, files, excelRows };
}

const docCalls = (calls) => calls.filter((c) => c.body.type === 'document');
const detail = (report, rowNumber) => report.details.find((d) => d.row === rowNumber);

(async () => {
  // =====================================================================================
  console.log('\n=== 1. Excel parsing (real .xlsx bytes, Excel-style XML) ===');
  // =====================================================================================
  const parse = (rows) => toBulkPaperExcelRows(buildXlsx([HEADERS, ...rows]));

  check('Roll Number and Checked File are read from the same row (75/91/80)', () => {
    const rows = parse([
      excelRow('Asha', 75, 'file_0002_checked.jpg'),
      excelRow('Bhavna', 91, 'file_0003_checked.jpg'),
      excelRow('Chirag', 80, 'file_0004_checked.jpg'),
    ]);
    assert.deepStrictEqual(rows.map((r) => [r.rollNo, r.checkedFile, r.rowNumber]), [
      ['75', 'file_0002_checked.jpg', 2],
      ['91', 'file_0003_checked.jpg', 3],
      ['80', 'file_0004_checked.jpg', 4],
    ]);
  });

  check('blank Roll Number cell does NOT shift the next cell (Paper Code) into the Roll column', () => {
    const [row] = parse([excelRow('Ghost', null, '20260915160540_0003_checked.jpg')]);
    assert.strictEqual(row.rollNoRaw, '');
    assert.strictEqual(row.rollNo, '');
    assert.strictEqual(row.paperCode, 'PC1');
    assert.strictEqual(row.checkedFile, '20260915160540_0003_checked.jpg');
  });

  check('blank Student cell does NOT shift the Roll Number into the Student column', () => {
    const [row] = parse([excelRow(null, 75, 'file_0002_checked.jpg')]);
    assert.strictEqual(row.studentName, '');
    assert.strictEqual(row.rollNo, '75');
  });

  check('blank Checked File (last cell) is empty, not borrowed from a neighbour', () => {
    const [row] = parse([excelRow('Asha', 75, null)]);
    assert.strictEqual(row.checkedFile, '');
    assert.strictEqual(row.rollNo, '75');
  });

  check('roll number stored as text "75.0" resolves to 75, not 0', () => {
    assert.strictEqual(extractRollNumberDigits('75.0'), '75');
    const [row] = parse([excelRow('Asha', '75.0', 'file_0002_checked.jpg')]);
    assert.strictEqual(row.rollNo, '75');
  });

  check('OCR-corrupted roll numbers ("?????91", "Roll No: ?????775") keep only the real trailing digits', () => {
    assert.strictEqual(extractRollNumberDigits('?????91'), '91');
    assert.strictEqual(extractRollNumberDigits('Roll No: ?????775'), '775');
    assert.strictEqual(extractRollNumberDigits('????????'), '');
  });

  check('blank / self-closing rows are skipped and later rows report their REAL Excel row number', () => {
    const rows = toBulkPaperExcelRows(buildXlsx([
      HEADERS,
      excelRow('Asha', 75, 'file_0002_checked.jpg'),
      null,
      [null, null, null],
      excelRow('Chirag', 80, 'file_0004_checked.jpg'),
    ]));
    assert.deepStrictEqual(rows.map((r) => [r.rowNumber, r.rollNo, r.checkedFile]), [
      [2, '75', 'file_0002_checked.jpg'],
      [5, '80', 'file_0004_checked.jpg'],
    ]);
  });

  // =====================================================================================
  console.log('\n=== 2. Main flow: 75 / 91 / 80, files uploaded in a DIFFERENT order than the Excel rows ===');
  // =====================================================================================
  const CASES = [
    { roll: '75', file: 'file_0002_checked.jpg' },
    { roll: '91', file: 'file_0003_checked.jpg' },
    { roll: '80', file: 'file_0004_checked.jpg' },
  ];
  const main = await runImport({
    rows: CASES.map((c) => excelRow(byRoll(c.roll).name, Number(c.roll), c.file)),
    // reversed + shuffled relative to the Excel: any zip-by-index / sort bug would misroute
    uploaded: ['file_0004_checked.jpg', 'file_0002_checked.jpg', 'file_0003_checked.jpg'],
  });

  const evidence = [];
  for (const c of CASES) {
    const student = byRoll(c.roll);
    const request = docCalls(main.calls).find((call) => call.body.document.filename === c.file);
    const stored = request && main.store.find((p) => request.body.document.link.endsWith(`_${p.originalname}`) && request.body.document.link.includes(`uuid-${p.paperId}_`));
    evidence.push({ roll: c.roll, expected: c.file, actual: request?.body.document.filename, storedFor: stored?.studentId, storedBytes: stored?.bytes, recipient: request?.body.to, expectedRecipient: PARENT_TO(student) });

    check(`Roll ${c.roll} → ${c.file}: sent to parent ${PARENT_TO(student)} (student_id=${student.id}) with the SAME file`, () => {
      assert.ok(request, `no WhatsApp document request carried filename ${c.file}`);
      assert.strictEqual(request.body.to, PARENT_TO(student));
      assert.strictEqual(request.body.type, 'document');
      assert.strictEqual(request.body.messaging_product, 'whatsapp');
      assert.ok(stored, 'document.link does not point at a stored upload');
      assert.strictEqual(stored.studentId, student.id, 'stored paper belongs to a different student');
      assert.strictEqual(stored.bytes, `BYTES-OF:${c.file}`, 'attachment bytes are not the Excel row\'s checked file');
    });
  }
  check('exactly 3 WhatsApp document messages, one per row, nothing extra', () => {
    assert.strictEqual(docCalls(main.calls).length, 3);
    assert.strictEqual(main.calls.length, 3);
  });
  check('no message went to the student\'s own number or to the distractor students 2/3/4 (parent-only)', () => {
    const recipients = new Set(main.calls.map((c) => c.body.to));
    assert.deepStrictEqual([...recipients].sort(), CASES.map((c) => PARENT_TO(byRoll(c.roll))).sort());
  });
  check('every request used the configured phone number id and bearer token (fake endpoint only)', () => {
    for (const call of main.calls) {
      assert.ok(call.url.endsWith('/TEST_PHONE_NUMBER_ID/messages'), call.url);
      assert.strictEqual(call.authorization, 'Bearer TEST_ONLY_TOKEN');
    }
  });
  check('report: 3 rows, 3 imported, 3 WhatsApp accepted by API, 0 failed/skipped', () => {
    assert.strictEqual(main.report.totalRows, 3);
    assert.strictEqual(main.report.imported, 3);
    assert.strictEqual(main.report.whatsappSent, 3);
    assert.strictEqual(main.report.whatsappFailed, 0);
    assert.deepStrictEqual(main.report.unmatchedFiles, []);
  });
  check('each send log record carries student_id, roll, filename, file URL, recipient, API response, final status', () => {
    for (const c of CASES) {
      const record = main.report.sendLog.find((r) => r.roll_number === c.roll);
      assert.ok(record, `no send log for roll ${c.roll}`);
      assert.strictEqual(record.student_id, byRoll(c.roll).id);
      assert.strictEqual(record.checked_filename, c.file);
      assert.ok(record.resolved_file_url.endsWith(`_${c.file}`), record.resolved_file_url);
      assert.strictEqual(record.recipients.length, 1);
      assert.strictEqual(record.recipients[0].role, 'parent');
      assert.strictEqual(record.recipients[0].whatsapp_number, PARENT_TO(byRoll(c.roll)));
      assert.ok(record.recipients[0].api_response?.messages?.[0]?.id, 'API response missing');
      assert.strictEqual(record.final, 'sent');
    }
    assert.ok(main.logs.some((line) => line.startsWith('[CHECKED PAPER SEND]')));
  });

  // The exact example from the task: real timestamped scanner filename, roll 75
  const spec = await runImport({
    rows: [excelRow('Asha', 75, '20260915160533_0002_checked.jpg')],
    uploaded: ['20260915160533_0002_checked.jpg'],
  });
  check('spec example: Roll 75 → 20260915160533_0002_checked.jpg → parent 919000000075 (not distractor roll 2 = 919000000002)', () => {
    assert.strictEqual(spec.calls.length, 1);
    assert.strictEqual(spec.calls[0].body.to, '919000000075');
    assert.strictEqual(spec.calls[0].body.document.filename, '20260915160533_0002_checked.jpg');
    assert.strictEqual(spec.store[0].studentId, 175);
  });

  // =====================================================================================
  console.log('\n=== 3. Edge cases: every skipped/failed row is reported with an exact reason, never sent ===');
  // =====================================================================================
  const good75 = excelRow('Asha', 75, 'file_0002_checked.jpg');
  const good80 = excelRow('Chirag', 80, 'file_0004_checked.jpg');

  const missingRoll = await runImport({ rows: [excelRow('Ghost', null, 'file_0003_checked.jpg'), good80], uploaded: ['file_0003_checked.jpg', 'file_0004_checked.jpg'] });
  check('missing roll number → skipped "Roll Number is blank"; file NOT sent to anyone; other row unaffected', () => {
    assert.strictEqual(detail(missingRoll.report, 2).status, 'invalid_roll_number');
    assert.match(detail(missingRoll.report, 2).reason, /Roll Number is blank/);
    assert.deepStrictEqual(docCalls(missingRoll.calls).map((c) => c.body.to), ['919000000080']);
    assert.ok(missingRoll.logs.some((l) => l.includes('Skipped') && l.includes('Roll Number is blank') && l.includes('row 2')));
    assert.deepStrictEqual(missingRoll.report.unmatchedFiles, ['file_0003_checked.jpg']);
  });

  const invalidRoll = await runImport({ rows: [excelRow('Ghost', '????????', 'file_0003_checked.jpg')], uploaded: ['file_0003_checked.jpg'] });
  check('invalid roll number ("????????") → skipped, nothing sent', () => {
    assert.strictEqual(detail(invalidRoll.report, 2).status, 'invalid_roll_number');
    assert.match(detail(invalidRoll.report, 2).reason, /no digits found/);
    assert.strictEqual(invalidRoll.calls.length, 0);
  });

  const fileNameInRoll = await runImport({ rows: [excelRow('Ghost', '20260915160540_0003_checked.jpg', 'file_0003_checked.jpg')], uploaded: ['file_0003_checked.jpg'] });
  check('a filename sitting in the Roll Number column is rejected (its digits are NOT used as a roll → never routes to roll 3)', () => {
    assert.strictEqual(detail(fileNameInRoll.report, 2).status, 'invalid_roll_number');
    assert.match(detail(fileNameInRoll.report, 2).reason, /looks like a filename/);
    assert.strictEqual(fileNameInRoll.calls.length, 0);
  });

  const noStudent = await runImport({ rows: [excelRow('Nobody', 12345, 'file_0003_checked.jpg')], uploaded: ['file_0003_checked.jpg'] });
  check('student not found → "No student found for roll number", nothing sent', () => {
    assert.strictEqual(detail(noStudent.report, 2).status, 'missing_student');
    assert.match(detail(noStudent.report, 2).reason, /No student found for roll number "12345"/);
    assert.strictEqual(noStudent.calls.length, 0);
    assert.strictEqual(noStudent.store.length, 0);
  });

  const ambiguousStudents = await runImport({ rows: [excelRow('Dup', 99, 'file_0003_checked.jpg')], uploaded: ['file_0003_checked.jpg'] });
  check('two students share roll 99 → ambiguous, refuses to guess, nothing sent', () => {
    assert.strictEqual(detail(ambiguousStudents.report, 2).status, 'missing_student');
    assert.match(detail(ambiguousStudents.report, 2).reason, /more than one student/);
    assert.strictEqual(ambiguousStudents.calls.length, 0);
  });

  const blankFile = await runImport({ rows: [excelRow('Asha', 75, null)], uploaded: ['file_0002_checked.jpg'] });
  check('missing Checked File value → skipped; the uploaded file is NOT guessed for roll 75', () => {
    assert.strictEqual(detail(blankFile.report, 2).status, 'invalid_filename');
    assert.match(detail(blankFile.report, 2).reason, /Checked File value is blank/);
    assert.strictEqual(blankFile.calls.length, 0);
    assert.deepStrictEqual(blankFile.report.unmatchedFiles, ['file_0002_checked.jpg']);
  });

  const notUploaded = await runImport({ rows: [good75], uploaded: ['file_0009_checked.jpg'] });
  check('checked file named in Excel but not uploaded → missing_file; a different uploaded file is NOT substituted', () => {
    assert.strictEqual(detail(notUploaded.report, 2).status, 'missing_file');
    assert.match(detail(notUploaded.report, 2).reason, /No uploaded file matches Checked File "file_0002_checked.jpg"/);
    assert.strictEqual(notUploaded.calls.length, 0);
    assert.deepStrictEqual(notUploaded.report.unmatchedFiles, ['file_0009_checked.jpg']);
  });

  const dupRoll = await runImport({
    rows: [excelRow('Asha', 75, 'file_0002_checked.jpg'), excelRow('Asha again', 75, 'file_0003_checked.jpg'), good80],
    uploaded: ['file_0002_checked.jpg', 'file_0003_checked.jpg', 'file_0004_checked.jpg'],
  });
  check('duplicate roll number (rows 2 and 3) → BOTH skipped as ambiguous, neither sent; unrelated roll 80 still sent', () => {
    assert.strictEqual(detail(dupRoll.report, 2).status, 'duplicate_mapping');
    assert.strictEqual(detail(dupRoll.report, 3).status, 'duplicate_mapping');
    assert.match(detail(dupRoll.report, 2).reason, /Duplicate Roll Number "75" in Excel \(rows 2, 3\)/);
    assert.deepStrictEqual(docCalls(dupRoll.calls).map((c) => c.body.to), ['919000000080']);
  });

  const dupRollPadded = await runImport({
    rows: [excelRow('Asha', '075', 'file_0002_checked.jpg'), excelRow('Asha', 75, 'file_0003_checked.jpg')],
    uploaded: ['file_0002_checked.jpg', 'file_0003_checked.jpg'],
  });
  check('"075" and "75" both resolve to the same student → recognised as duplicate, neither sent', () => {
    assert.strictEqual(dupRollPadded.calls.length, 0);
    assert.ok(dupRollPadded.report.details.every((d) => d.status === 'duplicate_mapping'));
  });

  const dupFile = await runImport({
    rows: [excelRow('Asha', 75, 'file_0002_checked.jpg'), excelRow('Bhavna', 91, 'file_0002_checked.jpg'), good80],
    uploaded: ['file_0002_checked.jpg', 'file_0004_checked.jpg'],
  });
  check('duplicate checked filename (rows 2 and 3 name the same file for rolls 75 and 91) → BOTH skipped, the file goes to neither', () => {
    assert.strictEqual(detail(dupFile.report, 2).status, 'duplicate_mapping');
    assert.strictEqual(detail(dupFile.report, 3).status, 'duplicate_mapping');
    assert.match(detail(dupFile.report, 2).reason, /Duplicate Checked File "file_0002_checked.jpg" in Excel \(rows 2, 3\)/);
    assert.deepStrictEqual(docCalls(dupFile.calls).map((c) => c.body.to), ['919000000080']);
  });

  const dupUpload = await runImport({ rows: [good75], uploaded: ['file_0002_checked.jpg', 'file_0002_checked.jpg'] });
  check('two uploaded files share the name in the Excel row → cannot pick one, skipped', () => {
    assert.strictEqual(detail(dupUpload.report, 2).status, 'duplicate_mapping');
    assert.match(detail(dupUpload.report, 2).reason, /Multiple uploaded files share the filename/);
    assert.strictEqual(dupUpload.calls.length, 0);
  });

  const blankRows = await runImport({
    rows: [good75, null, [null, null, null, null], excelRow('Chirag', 80, 'file_0004_checked.jpg')],
    uploaded: ['file_0002_checked.jpg', 'file_0004_checked.jpg'],
  });
  check('blank Excel rows are ignored; rolls 75 and 80 still get their own files', () => {
    assert.strictEqual(blankRows.report.totalRows, 2);
    assert.deepStrictEqual(docCalls(blankRows.calls).map((c) => [c.body.to, c.body.document.filename]), [
      ['919000000075', 'file_0002_checked.jpg'],
      ['919000000080', 'file_0004_checked.jpg'],
    ]);
  });

  // ---------- WhatsApp recipient / API edge cases ----------
  console.log('\n=== 4. WhatsApp recipient + API failure edge cases ===');
  const noParent = await runImport({ rows: [excelRow('No Parent', 60, 'file_0002_checked.jpg')], uploaded: ['file_0002_checked.jpg'] });
  check('parent WhatsApp number missing → paper imported, WhatsApp SKIPPED with reason; student\'s own number NOT used', () => {
    assert.strictEqual(noParent.report.imported, 1);
    assert.strictEqual(noParent.report.whatsappSkipped, 1);
    assert.strictEqual(noParent.report.whatsappSent, 0);
    assert.strictEqual(noParent.calls.length, 0);
    assert.match(detail(noParent.report, 2).whatsapp.reason, /No parent\/guardian WhatsApp number/);
    assert.ok(noParent.logs.some((l) => l.includes('WhatsApp SKIPPED') && l.includes('student_id=160')));
  });

  const guardian = await runImport({ rows: [excelRow('Guardian Only', 61, 'file_0002_checked.jpg')], uploaded: ['file_0002_checked.jpg'] });
  check('parent number stored only as guardian_phone → that number receives the file', () => {
    assert.deepStrictEqual(docCalls(guardian.calls).map((c) => c.body.to), ['919000000061']);
  });

  const apiFail = await runImport({
    rows: [good75],
    uploaded: ['file_0002_checked.jpg'],
    api: () => ({ status: 400, json: { error: { message: '(#100) Invalid parameter', code: 100 } } }),
  });
  check('WhatsApp API rejects (HTTP 400) → reported FAILED with the API error, never counted as sent', () => {
    assert.strictEqual(apiFail.report.whatsappSent, 0);
    assert.strictEqual(apiFail.report.whatsappFailed, 1);
    assert.strictEqual(detail(apiFail.report, 2).whatsapp.status, 'failed');
    assert.match(detail(apiFail.report, 2).whatsapp.reason, /Invalid parameter/);
    assert.strictEqual(apiFail.report.sendLog[0].final, 'failed');
    assert.strictEqual(apiFail.report.sendLog[0].recipients[0].accepted_by_api, false);
    assert.ok(!apiFail.logs.some((l) => l.includes('WhatsApp accepted by API')));
    assert.strictEqual(apiFail.report.imported, 1, 'the paper import itself is still recorded');
  });

  const netFail = await runImport({ rows: [good75], uploaded: ['file_0002_checked.jpg'], api: () => ({ throw: 'ECONNRESET' }) });
  check('network error while calling the API → FAILED, not sent', () => {
    assert.strictEqual(netFail.report.whatsappFailed, 1);
    assert.match(detail(netFail.report, 2).whatsapp.reason, /ECONNRESET/);
  });

  const windowClosed = (templateOutcome) => (body, n) => {
    if (body.type === 'document') return { status: 400, json: { error: { message: '(#131047) Re-engagement message', code: 131047 } } };
    return templateOutcome(body, n);
  };
  const tplOk = await runImport({ rows: [good75], uploaded: ['file_0002_checked.jpg'], api: windowClosed(okApi) });
  check('24-hour window closed (131047) → approved TEMPLATE fallback carries the SAME file to the SAME parent', () => {
    assert.deepStrictEqual(tplOk.calls.map((c) => c.body.type), ['document', 'template']);
    const template = tplOk.calls[1].body;
    assert.strictEqual(template.to, '919000000075');
    assert.strictEqual(template.template.name, 'paper_result_notification');
    const header = template.template.components.find((c) => c.type === 'header');
    assert.strictEqual(header.parameters[0].document.filename, 'file_0002_checked.jpg');
    assert.strictEqual(header.parameters[0].document.link, tplOk.calls[0].body.document.link);
    assert.strictEqual(tplOk.report.whatsappSent, 1);
    assert.strictEqual(tplOk.report.sendLog[0].recipients[0].channel, 'template');
  });

  const tplFail = await runImport({
    rows: [good75],
    uploaded: ['file_0002_checked.jpg'],
    api: windowClosed(() => ({ status: 400, json: { error: { message: '(#132001) Template does not exist', code: 132001 } } })),
  });
  check('131047 AND template rejected → FAILED with a reason naming both (never reported as success)', () => {
    assert.strictEqual(tplFail.report.whatsappSent, 0);
    assert.strictEqual(tplFail.report.whatsappFailed, 1);
    assert.match(detail(tplFail.report, 2).whatsapp.reason, /131047/);
    assert.match(detail(tplFail.report, 2).whatsapp.reason, /Template does not exist/);
  });

  const partial = await runImport({
    rows: [good75, excelRow('Bhavna', 91, 'file_0003_checked.jpg'), good80],
    uploaded: ['file_0002_checked.jpg', 'file_0003_checked.jpg', 'file_0004_checked.jpg'],
    api: (body, n) => (body.to === '919000000091' ? { status: 500, json: { error: { message: 'Internal error', code: 2 } } } : okApi(body, n)),
  });
  check('one recipient failing does not stop or mislabel the others (75 ok, 91 failed, 80 ok)', () => {
    assert.strictEqual(detail(partial.report, 2).whatsapp.status, 'sent');
    assert.strictEqual(detail(partial.report, 3).whatsapp.status, 'failed');
    assert.strictEqual(detail(partial.report, 4).whatsapp.status, 'sent');
  });

  const saveFail = await runImport({
    rows: [good75, good80],
    uploaded: ['file_0002_checked.jpg', 'file_0004_checked.jpg'],
    savePaperImpl: async ({ student }) => { if (student.roll_no === '75') throw new Error('S3 PutObject failed'); return { status: 'inserted', paperId: 5, notifyType: 'test_paper_upload' }; },
  });
  check('file storage failure for a row → row FAILED, nothing sent for it', () => {
    assert.strictEqual(detail(saveFail.report, 2).status, 'failed');
    assert.match(detail(saveFail.report, 2).reason, /S3 PutObject failed/);
    assert.ok(!saveFail.calls.some((c) => c.body.to === '919000000075'));
  });

  // =====================================================================================
  console.log('\n=== 5. Cross-student safety: a paper can only be delivered for the student it was stored for ===');
  // =====================================================================================
  const crossed = await runImport({
    rows: [good75],
    uploaded: ['file_0002_checked.jpg'],
    // A buggy save that files the upload under the WRONG student must be caught, not sent.
    savePaperImpl: async ({ file }) => ({ status: 'inserted', paperId: 4242, notifyType: 'test_paper_upload' }),
  });
  check('notify looks the paper up by (paperId AND studentId): a mismatch sends nothing', () => {
    assert.strictEqual(crossed.calls.length, 0);
    assert.strictEqual(crossed.report.whatsappSkipped, 1);
  });

  // ---------- printed evidence ----------
  console.log('\n=== EVIDENCE: main scenario, straight from the fake Meta API requests ===');
  console.log('Roll | expected file            | actual file (API payload) | recipient (API "to")  | expected recipient | stored-for student | verdict');
  for (const e of evidence) {
    const pass = e.expected === e.actual && e.recipient === e.expectedRecipient && e.storedBytes === `BYTES-OF:${e.expected}`;
    console.log(`${e.roll.padEnd(4)} | ${e.expected.padEnd(24)} | ${String(e.actual).padEnd(25)} | ${String(e.recipient).padEnd(21)} | ${e.expectedRecipient.padEnd(18)} | ${String(e.storedFor).padEnd(18)} | ${pass ? 'PASS' : 'FAIL'}`);
  }
  console.log('\nSample [CHECKED PAPER SEND] log line (roll 75):');
  console.log(main.logs.find((l) => l.startsWith('[CHECKED PAPER SEND]') && l.includes('"roll_number":"75"')));
  console.log('\nSample skip log lines:');
  for (const line of [...missingRoll.logs, ...dupFile.logs, ...noParent.logs, ...tplFail.logs].filter((l) => /Skipped|SKIPPED|FAILED/.test(l)).slice(0, 6)) console.log(`  ${line}`);

  console.log(`\n${passes} passed, ${failures} failed.`);
  if (failures > 0) process.exit(1);
  console.log('All checked-paper routing tests passed.');
})().catch((error) => {
  console.error('Test harness crashed:', error);
  process.exit(1);
});
