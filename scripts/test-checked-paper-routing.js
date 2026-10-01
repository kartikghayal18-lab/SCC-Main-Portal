// End-to-end regression test for the bulk paper upload → WhatsApp flow.
//
//   uploaded files (+ optional real .xlsx bytes → toBulkPaperExcelRows) → runPaperUpload (real
//   planner + orchestrator) → deliverPaperDocument → whatsapp.js sendDocumentMessage /
//   sendMetaMessage (real code) → fetch (FAKE Meta Graph API) → buildPaperUploadSummary
//
// Only the edges are faked: the database (stubbed module), file storage (in-memory), and the
// network (global.fetch). No real DB, S3 or WhatsApp credentials are ever loaded or used —
// this script never requires src/app.js or .env, and refuses to run if DATABASE_URL is set.
//
// Business rules under test:
//   * the uploaded FILENAME identifies the student (76.jpg -> roll 76); the Excel file is
//     optional and only supplies marks, matched by roll number;
//   * the paper goes to EVERY valid, distinct number stored for the student (parent,
//     guardian, student WhatsApp, contact);
//   * every paper ends with an explicit status and a categorised reason.
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
process.env.WHATSAPP_DOCUMENT_TEMPLATE_NAME = 'coaching_document';

// Stub src/db.js BEFORE anything requires it, so config/database (and .env) never load.
const dbLogs = [];
const fakeLogRows = new Map();
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    run: async (sql, params) => { dbLogs.push({ sql, params }); return { lastID: dbLogs.length }; },
    get: async () => null,
    all: async (sql, params) => (/FROM whatsapp_logs WHERE id IN/.test(sql) ? params.map((id) => fakeLogRows.get(id)).filter(Boolean) : []),
  },
};

const { buildXlsx } = require('./lib/xlsx-fixture');
const { toBulkPaperExcelRows, extractRollNumberDigits } = require('../src/services/omrImportParsing');
const { runPaperUpload } = require('../src/services/checkedPaperImport');
const {
  NO_VALID_NUMBER_REASON,
  DELIVERY_CATEGORIES: CAT,
  selectPaperRecipients,
  deliverPaperDocument,
} = require('../src/services/paperWhatsApp');
const { buildPaperUploadSummary } = require('../src/services/paperUploadSummary');
const { getFinalLogStatuses } = require('../src/services/whatsapp');

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
const excelRow = (student, roll, file, total = 120) => [student, roll, 'PC1', 40, 30, 50, total, 30, 5, 2, 0, file];

const STUDENTS = [
  { id: 175, roll_no: '75', name: 'Asha', parent_whatsapp_number: '9000000075', whatsapp_number: '8000000075', contact_phone: '7000000075' },
  { id: 191, roll_no: '91', name: 'Bhavna', parent_whatsapp_number: '9000000091' },
  { id: 180, roll_no: '80', name: 'Chirag', whatsapp_number: '8000000080' },
  // Distractors: their roll numbers equal the "_0002/_0003" scan sequence numbers embedded in
  // scanner filenames. They must NEVER receive another student's file.
  { id: 2, roll_no: '2', name: 'Distractor Two', parent_whatsapp_number: '9000000002' },
  { id: 3, roll_no: '3', name: 'Distractor Three', parent_whatsapp_number: '9000000003' },
  // The six recipient cases.
  { id: 301, roll_no: '31', name: 'Parent Only', parent_whatsapp_number: '9000000031' },
  { id: 302, roll_no: '32', name: 'Student Only', whatsapp_number: '8000000032' },
  { id: 303, roll_no: '33', name: 'Student And Parent', whatsapp_number: '8000000033', parent_whatsapp_number: '9000000033' },
  { id: 304, roll_no: '34', name: 'Three Numbers', whatsapp_number: '8000000034', parent_whatsapp_number: '9000000034', guardian_phone: '6000000034' },
  { id: 305, roll_no: '35', name: 'Same Number Everywhere', parent_whatsapp_number: '9000000035', guardian_phone: '+91 90000 00035', whatsapp_number: '919000000035', contact_phone: '09000000035' },
  { id: 306, roll_no: '36', name: 'No Numbers' },
  { id: 307, roll_no: '37', name: 'Bad Contact', whatsapp_number: '8000000037', contact_phone: '700000037' },
  // Two siblings sharing the parent's number: each paper still goes to it.
  { id: 308, roll_no: '38', name: 'Sibling A', parent_whatsapp_number: '9000000038' },
  { id: 309, roll_no: '39', name: 'Sibling B', parent_whatsapp_number: '9000000038' },
  // Two students sharing one roll number (data problem) — ambiguous.
  { id: 199, roll_no: '99', name: 'Dup A', parent_whatsapp_number: '9000000199' },
  { id: 299, roll_no: '99', name: 'Dup B', parent_whatsapp_number: '9000000299' },
];
const byRoll = (roll) => STUDENTS.find((s) => s.roll_no === roll);

// ---------- harness ----------
function makeUploaded(names) {
  return names.map((name) => ({ originalname: name, buffer: Buffer.from(`BYTES-OF:${name}`), mimetype: 'image/jpeg', size: 20 }));
}

const okApi = (body, callNumber) => ({ status: 200, json: { messaging_product: 'whatsapp', messages: [{ id: `wamid.TEST${callNumber}` }] } });

const MB = 1024 * 1024;

async function runUpload({ rows = null, uploaded, students = STUDENTS, api = okApi, savePaperImpl = null, sizes = {}, storedSize = true }) {
  const excelRows = rows ? toBulkPaperExcelRows(buildXlsx([HEADERS, ...rows])) : [];
  const files = makeUploaded(uploaded);

  const calls = [];
  const heads = [];
  global.fetch = async (url, options = {}) => {
    if (options.method === 'HEAD') {
      // Fake S3: the paper's real size, read from Content-Length.
      heads.push(url);
      const paper = store.find((p) => p.url === url);
      return { ok: Boolean(paper), status: paper ? 200 : 404, headers: { get: (h) => (h.toLowerCase() === 'content-length' && paper ? String(paper.size) : null) } };
    }
    const body = JSON.parse(options.body);
    calls.push({ url, authorization: options.headers.Authorization, body });
    const scripted = api(body, calls.length);
    if (scripted.throw) throw new Error(scripted.throw);
    return { status: scripted.status, ok: scripted.status >= 200 && scripted.status < 300, json: async () => scripted.json };
  };

  const store = [];
  const saves = [];
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
    report = await runPaperUpload({
      excelRows,
      students,
      files,
      logger,
      deps: {
        savePaper: savePaperImpl || (async ({ row, student, file }) => {
          const paperId = store.length + 1000;
          saves.push({ studentId: student.id, file: file.originalname, row });
          store.push({
            paperId,
            studentId: student.id,
            originalname: file.originalname,
            bytes: file.buffer.toString(),
            url: `https://cdn.test/papers/2026-09-15/uuid-${paperId}_${file.originalname}`,
            size: sizes[file.originalname] || 3 * MB,
          });
          return { status: 'inserted', paperId, notifyType: row ? 'test_result_published' : 'test_paper_upload' };
        }),
        // Mirrors notifyPaperEvent: looks the paper up by (paperId AND studentId) exactly like
        // getPaperDocumentUrl's SQL, picks recipients with the shared selectPaperRecipients,
        // then delivers through the real send code.
        notify: async ({ student, paperId }) => {
          const paper = store.find((p) => p.paperId === paperId && p.studentId === student.id);
          if (!paper) return { ok: false, skipped: true, reason: 'Real S3 paper not found' };
          const recipients = selectPaperRecipients(student);
          if (!recipients.length) {
            return { ok: false, skipped: true, reason: NO_VALID_NUMBER_REASON, fileUrl: paper.url, fileName: paper.originalname, results: [] };
          }
          const results = await deliverPaperDocument({
            document: { fileUrl: paper.url, fileName: paper.originalname, sizeBytes: storedSize ? paper.size : null, paper: { original_name: paper.originalname, test_label: 'PC1', marks_obtained: 120, max_marks: 180 } },
            student,
            recipients,
            caption: 'caption',
            coachingId: 1,
            branchId: 1,
            paperId,
            coachingName: 'TEST COACHING',
          });
          const failed = results.filter((r) => !r.ok);
          return { ok: failed.length === 0, fileUrl: paper.url, fileName: paper.originalname, results };
        },
      },
    });
  } finally {
    console.log = realLog;
    console.error = realError;
    console.warn = realWarn;
  }
  return { report, results: report.results, calls, store, saves, logs, files, excelRows, heads };
}

// The stored file a WhatsApp request carries: plain document link, or the template header's
// image/document link.
function linkOf(call) {
  if (call.body.type === 'document') return call.body.document.link;
  const header = call.body.template.components.find((c) => c.type === 'header');
  const param = header.parameters[0];
  return (param.image || param.document).link;
}
const fileOf = (run, call) => run.store.find((p) => p.url === linkOf(call))?.originalname;
const headerOf = (call) => call.body.template.components.find((c) => c.type === 'header').parameters[0];
const resultFor = (run, filename) => run.results.find((r) => r.filename === filename);
const sentTo = (run, filename) => run.calls.filter((c) => fileOf(run, c) === filename).map((c) => c.body.to).sort();

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
  console.log('\n=== 2. Main flow: the FILENAME picks the student; Excel is optional and only adds marks ===');
  // =====================================================================================
  // Excel has rows for 75 and 91 only; 80.jpg has no Excel row. Files uploaded in a different
  // order than the Excel rows.
  const main = await runUpload({
    rows: [excelRow('Asha', 75, '75.jpg', 120), excelRow('Bhavna', 91, '91.jpg', 150)],
    uploaded: ['80.jpg', '91.jpg', '75.jpg'],
  });
  check('75.jpg → roll 75 → sent to ALL 3 of Asha\'s numbers (parent, student, contact), with the 75.jpg file', () => {
    assert.deepStrictEqual(sentTo(main, '75.jpg'), ['917000000075', '918000000075', '919000000075']);
    for (const call of main.calls.filter((c) => fileOf(main, c) === '75.jpg')) {
      const stored = main.store.find((p) => p.url === linkOf(call));
      assert.strictEqual(stored.studentId, 175);
      assert.strictEqual(stored.bytes, 'BYTES-OF:75.jpg');
    }
  });
  check('91.jpg → roll 91 → sent to its only (parent) number', () => {
    assert.deepStrictEqual(sentTo(main, '91.jpg'), ['919000000091']);
  });
  check('80.jpg is NOT in the Excel but roll 80 exists → STILL saved and sent', () => {
    assert.deepStrictEqual(sentTo(main, '80.jpg'), ['918000000080']);
    assert.strictEqual(resultFor(main, '80.jpg').finalStatus, 'sent');
    assert.strictEqual(main.saves.find((s) => s.file === '80.jpg').row, null, 'no Excel marks for roll 80');
  });
  check('rolls in the Excel get their Excel marks for the progress card (75 → 120, 91 → 150)', () => {
    assert.strictEqual(main.saves.find((s) => s.file === '75.jpg').row.totalScore, 120);
    assert.strictEqual(main.saves.find((s) => s.file === '91.jpg').row.totalScore, 150);
  });
  check('per-paper result: student, rollNo, filename, recipients, sentCount, failedCount, finalStatus, reasons', () => {
    const r = resultFor(main, '75.jpg');
    assert.strictEqual(r.studentId, 175);
    assert.strictEqual(r.studentName, 'Asha');
    assert.strictEqual(r.rollNo, '75');
    assert.strictEqual(r.recipients.length, 3);
    assert.strictEqual(r.sentCount, 3);
    assert.strictEqual(r.failedCount, 0);
    assert.strictEqual(r.finalStatus, 'sent');
    assert.deepStrictEqual(r.reasons, []);
    assert.strictEqual(main.results.length, 3);
  });
  check('every request used the configured phone number id and bearer token (fake endpoint only)', () => {
    for (const call of main.calls) {
      assert.ok(call.url.endsWith('/TEST_PHONE_NUMBER_ID/messages'), call.url);
      assert.strictEqual(call.authorization, 'Bearer TEST_ONLY_TOKEN');
    }
  });

  const noExcel = await runUpload({ uploaded: ['91.jpg'] });
  check('no Excel attached at all → paper still saved and sent', () => {
    assert.deepStrictEqual(sentTo(noExcel, '91.jpg'), ['919000000091']);
    assert.strictEqual(noExcel.saves[0].row, null);
  });

  const scanner = await runUpload({
    rows: [excelRow('Asha', 75, '20260915160533_0002_checked.jpg')],
    uploaded: ['20260915160533_0002_checked.jpg'],
  });
  check('scanner-named file (no roll in name) is paired by its Excel "Checked File" row → roll 75, NOT distractor roll 2', () => {
    assert.deepStrictEqual(sentTo(scanner, '20260915160533_0002_checked.jpg'), ['917000000075', '918000000075', '919000000075']);
    assert.strictEqual(scanner.store[0].studentId, 175);
    assert.strictEqual(scanner.saves[0].row.totalScore, 120);
  });

  const excelOnly = await runUpload({ rows: [excelRow('Asha', 75, '75.jpg'), excelRow('Bhavna', 91, '91.jpg')], uploaded: ['75.jpg'] });
  check('Excel row without an uploaded paper (roll 91) → reported as Excel-only, nothing sent for it', () => {
    assert.deepStrictEqual(excelOnly.report.excelOnlyRows.map((r) => r.rollNo), ['91']);
    assert.ok(!excelOnly.calls.some((c) => c.body.to === '919000000091'));
  });

  const conflict = await runUpload({ rows: [excelRow('Bhavna', 91, '75.jpg')], uploaded: ['75.jpg'] });
  check('Excel lists 75.jpg under roll 91 → the FILENAME wins (sent to 75), conflict noted, 91\'s marks not applied to 75', () => {
    assert.deepStrictEqual(sentTo(conflict, '75.jpg'), ['917000000075', '918000000075', '919000000075']);
    assert.ok(!conflict.calls.some((c) => c.body.to === '919000000091'));
    assert.match(resultFor(conflict, '75.jpg').notes.join(' '), /lists this file under roll 91/);
    assert.strictEqual(conflict.saves[0].row, null);
  });

  // =====================================================================================
  console.log('\n=== 3. Papers that cannot be routed: explicit reason, never sent ===');
  // =====================================================================================
  const notFound = await runUpload({ uploaded: ['76.jpg', '91.jpg'] });
  check('76.jpg but no roll 76 in the database → "Student with roll number 76 not found in database.", not saved, not sent', () => {
    const r = resultFor(notFound, '76.jpg');
    assert.strictEqual(r.finalStatus, 'skipped');
    assert.strictEqual(r.reasons[0].category, CAT.STUDENT_NOT_FOUND);
    assert.strictEqual(r.reasons[0].detail, 'Student with roll number 76 not found in database.');
    assert.ok(!notFound.saves.some((s) => s.file === '76.jpg'));
    assert.deepStrictEqual(sentTo(notFound, '91.jpg'), ['919000000091'], 'other papers unaffected');
  });

  const badName = await runUpload({ uploaded: ['scan.jpg'] });
  check('filename without a roll number and no Excel pairing → invalid filename, nothing sent', () => {
    assert.strictEqual(resultFor(badName, 'scan.jpg').reasons[0].category, CAT.INVALID_FILENAME);
    assert.strictEqual(badName.calls.length, 0);
  });

  const padded = await runUpload({ uploaded: ['075.jpg'] });
  check('"075.jpg" resolves to roll 75', () => {
    assert.strictEqual(resultFor(padded, '075.jpg').studentId, 175);
  });

  const ambiguous = await runUpload({ uploaded: ['99.jpg'] });
  check('two students share roll 99 → refuses to guess, nothing sent', () => {
    assert.match(resultFor(ambiguous, '99.jpg').reasons[0].detail, /more than one student/);
    assert.strictEqual(ambiguous.calls.length, 0);
  });

  const twoFiles = await runUpload({ uploaded: ['75.jpg', '075_checked.jpg', '91.jpg'] });
  check('two different files resolve to roll 75 → both reported as ambiguous, neither sent; 91 still sent', () => {
    assert.strictEqual(resultFor(twoFiles, '75.jpg').reasons[0].category, CAT.DUPLICATE_FILE);
    assert.strictEqual(resultFor(twoFiles, '075_checked.jpg').reasons[0].category, CAT.DUPLICATE_FILE);
    assert.deepStrictEqual(twoFiles.calls.map((c) => c.body.to), ['919000000091']);
  });

  const sameName = await runUpload({ uploaded: ['75.jpg', '75.jpg'] });
  check('the same filename uploaded twice → cannot pick a copy, nothing sent', () => {
    assert.strictEqual(sameName.calls.length, 0);
    assert.ok(sameName.results.every((r) => r.reasons[0].category === CAT.INVALID_FILENAME));
  });

  const dupExcel = await runUpload({ rows: [excelRow('Asha', 75, '75.jpg'), excelRow('Asha again', 75, 'x.jpg')], uploaded: ['75.jpg'] });
  check('roll 75 twice in the Excel → paper STILL sent; ambiguous Excel marks are not applied (noted)', () => {
    assert.deepStrictEqual(sentTo(dupExcel, '75.jpg'), ['917000000075', '918000000075', '919000000075']);
    assert.strictEqual(dupExcel.saves[0].row, null);
    assert.match(resultFor(dupExcel, '75.jpg').notes.join(' '), /appears in 2 Excel rows/);
  });

  // =====================================================================================
  console.log('\n=== 4. Recipients: every valid unique number ===');
  // =====================================================================================
  const rcp = await runUpload({ uploaded: ['31.jpg', '32.jpg', '33.jpg', '34.jpg', '35.jpg', '36.jpg', '37.jpg'] });
  check('1. parent number only → sent to the parent', () => {
    assert.deepStrictEqual(sentTo(rcp, '31.jpg'), ['919000000031']);
  });
  check('2. student WhatsApp number only → sent to the student', () => {
    assert.deepStrictEqual(sentTo(rcp, '32.jpg'), ['918000000032']);
  });
  check('3. student + parent numbers → sent to BOTH', () => {
    assert.deepStrictEqual(sentTo(rcp, '33.jpg'), ['918000000033', '919000000033']);
  });
  check('4. student + parent + guardian numbers → sent to ALL THREE', () => {
    assert.deepStrictEqual(sentTo(rcp, '34.jpg'), ['916000000034', '918000000034', '919000000034']);
    assert.deepStrictEqual(resultFor(rcp, '34.jpg').recipients.map((r) => r.key), ['parent', 'guardian', 'student']);
  });
  check('5. the same number in all four fields (different formats) → sent ONCE', () => {
    assert.deepStrictEqual(sentTo(rcp, '35.jpg'), ['919000000035']);
  });
  check('6. no numbers → paper saved, WhatsApp skipped: "No valid WhatsApp number available for this student"', () => {
    const r = resultFor(rcp, '36.jpg');
    assert.strictEqual(r.finalStatus, 'skipped');
    assert.ok(r.paperId, 'paper still saved');
    assert.strictEqual(r.reasons[0].category, CAT.NO_VALID_NUMBER);
    assert.strictEqual(r.reasons[0].detail, 'No valid WhatsApp number available for this student');
    assert.deepStrictEqual(sentTo(rcp, '36.jpg'), []);
  });
  check('invalid stored number (9-digit contact) is reported, the valid one still receives the paper', () => {
    const r = resultFor(rcp, '37.jpg');
    assert.deepStrictEqual(sentTo(rcp, '37.jpg'), ['918000000037']);
    assert.strictEqual(r.finalStatus, 'sent');
    assert.strictEqual(r.reasons[0].category, CAT.INVALID_NUMBER);
  });

  const siblings = await runUpload({ uploaded: ['38.jpg', '39.jpg'] });
  check('a number shared by two students is NOT blocked: it receives each student\'s own paper', () => {
    assert.deepStrictEqual(sentTo(siblings, '38.jpg'), ['919000000038']);
    assert.deepStrictEqual(sentTo(siblings, '39.jpg'), ['919000000038']);
  });

  // =====================================================================================
  console.log('\n=== 5. Template-first sending, size routing, and failures (saved, never silent, categorised) ===');
  // =====================================================================================
  // ---------- template-first decision ----------
  const small = await runUpload({ uploaded: ['91.jpg'] });
  check('normal paper under the image limit → ONE request: approved template paper_result_notification, IMAGE header = the paper', () => {
    assert.strictEqual(small.calls.length, 1, 'no plain document is tried first');
    const call = small.calls[0].body;
    assert.strictEqual(call.type, 'template');
    assert.strictEqual(call.template.name, 'paper_result_notification');
    assert.strictEqual(headerOf(small.calls[0]).type, 'image');
    assert.strictEqual(linkOf(small.calls[0]), small.store[0].url, 'same S3 URL');
    const body = call.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
    assert.deepStrictEqual(body.slice(3), ['120', '180'], 'marks carried in the template');
    assert.strictEqual(resultFor(small, '91.jpg').recipients[0].channel, 'template');
    assert.strictEqual(resultFor(small, '91.jpg').finalStatus, 'sent');
  });
  check('no 131047 is ever provoked: no free-form document request was made', () => {
    assert.ok(!small.calls.some((c) => c.body.type === 'document'));
  });

  const big = await runUpload({ uploaded: ['83.jpg', '91.jpg'], students: [...STUDENTS, { id: 383, roll_no: '83', name: 'Vaibhavi', parent_whatsapp_number: '9000000083', whatsapp_number: '8000000083' }], sizes: { '83.jpg': 5283822 } });
  check('paper over 5 MB (5,283,822 bytes) → coaching_document with the SAME file as a DOCUMENT header, to EVERY number', () => {
    const calls = big.calls.filter((c) => fileOf(big, c) === '83.jpg');
    assert.deepStrictEqual(calls.map((c) => c.body.to).sort(), ['918000000083', '919000000083']);
    for (const c of calls) {
      assert.strictEqual(c.body.template.name, 'coaching_document');
      assert.strictEqual(headerOf(c).type, 'document');
      assert.strictEqual(headerOf(c).document.filename, '83.jpg');
      assert.strictEqual(linkOf(c), big.store.find((p) => p.originalname === '83.jpg').url);
      const body = c.body.template.components.find((x) => x.type === 'body').parameters.map((p) => p.text);
      assert.deepStrictEqual(body, ['PC1 checked test paper (Marks 120/180)', 'Vaibhavi', 'TEST COACHING']);
    }
    assert.strictEqual(resultFor(big, '83.jpg').finalStatus, 'sent');
  });
  check('the under-limit paper in the same upload still uses paper_result_notification', () => {
    assert.strictEqual(big.calls.find((c) => fileOf(big, c) === '91.jpg').body.template.name, 'paper_result_notification');
  });

  const exactLimit = await runUpload({ uploaded: ['91.jpg'], sizes: { '91.jpg': 5242880 } });
  check('exactly 5,242,880 bytes is still within the image limit → paper_result_notification', () => {
    assert.strictEqual(exactLimit.calls[0].body.template.name, 'paper_result_notification');
  });

  const fromS3 = await runUpload({ uploaded: ['91.jpg'], sizes: { '91.jpg': 6 * MB }, storedSize: false });
  check('size missing in the DB → read from S3 (HEAD Content-Length) → 6 MB → coaching_document', () => {
    assert.strictEqual(fromS3.heads.length, 1);
    assert.strictEqual(fromS3.calls[0].body.template.name, 'coaching_document');
  });

  const pdf = await runUpload({ uploaded: ['91.pdf'] });
  check('a PDF paper → coaching_document (DOCUMENT header)', () => {
    assert.strictEqual(pdf.calls[0].body.template.name, 'coaching_document');
    assert.strictEqual(headerOf(pdf.calls[0]).document.filename, '91.pdf');
  });

  const huge = await runUpload({ uploaded: ['91.jpg'], sizes: { '91.jpg': 120 * MB } });
  check('over 100 MB → NOT sent, paper still saved, FAILED "File larger than WhatsApp limit" (never silently dropped)', () => {
    assert.strictEqual(huge.calls.length, 0);
    const r = resultFor(huge, '91.jpg');
    assert.ok(r.paperId);
    assert.strictEqual(r.finalStatus, 'failed');
    assert.strictEqual(r.reasons[0].category, CAT.MEDIA_131053);
    assert.match(r.reasons[0].detail, /100 MB/);
  });

  dbLogs.length = 0;
  const sync131053 = await runUpload({
    uploaded: ['91.jpg'],
    api: (body, n) => (body.template?.name === 'paper_result_notification'
      ? { status: 400, json: { error: { message: '(#131053) Media upload error', code: 131053 } } }
      : okApi(body, n)),
  });
  check('IMAGE template rejected for size (131053) → same file re-sent via coaching_document; SENT; first attempt superseded', () => {
    assert.deepStrictEqual(sync131053.calls.map((c) => c.body.template.name), ['paper_result_notification', 'coaching_document']);
    assert.strictEqual(linkOf(sync131053.calls[1]), linkOf(sync131053.calls[0]));
    assert.strictEqual(resultFor(sync131053, '91.jpg').finalStatus, 'sent');
    assert.ok(dbLogs.some((l) => /SET status = 'superseded'/.test(l.sql)));
  });

  const docTplFail = await runUpload({
    uploaded: ['91.jpg'],
    sizes: { '91.jpg': 6 * MB },
    api: () => ({ status: 400, json: { error: { message: '(#131052) Media download error', code: 131052 } } }),
  });
  check('coaching_document send fails → FAILED with Meta\'s exact error in the summary (S3/document URL problem)', () => {
    const r = resultFor(docTplFail, '91.jpg');
    assert.strictEqual(r.finalStatus, 'failed');
    assert.strictEqual(r.reasons[0].category, CAT.DOCUMENT_URL);
    assert.match(r.reasons[0].detail, /131052\) Media download error/);
    assert.strictEqual(docTplFail.calls.length, 1, 'no plain-message retry for a media error');
  });

  // ---------- Meta rejections ----------
  const notOnWa = await runUpload({ uploaded: ['91.jpg'], api: () => ({ status: 400, json: { error: { message: '(#131026) Message undeliverable', code: 131026 } } }) });
  check('number not registered on WhatsApp (131026) → FAILED "not registered on WhatsApp", paper saved, no other attempts', () => {
    const r = resultFor(notOnWa, '91.jpg');
    assert.ok(r.paperId);
    assert.strictEqual(r.reasons[0].category, CAT.NOT_ON_WHATSAPP);
    assert.strictEqual(notOnWa.calls.length, 1);
  });

  const apiFail = await runUpload({ uploaded: ['91.jpg'], api: () => ({ status: 400, json: { error: { message: '(#100) Invalid parameter', code: 100 } } }) });
  check('other Meta rejection (HTTP 400 #100) → FAILED with the exact Meta error (Other Meta API error)', () => {
    const r = resultFor(apiFail, '91.jpg');
    assert.strictEqual(r.finalStatus, 'failed');
    assert.strictEqual(r.reasons[0].category, CAT.OTHER_META);
    assert.match(r.reasons[0].detail, /Invalid parameter/);
  });

  const netFail = await runUpload({ uploaded: ['91.jpg'], api: () => ({ throw: 'ECONNRESET' }) });
  check('network error → FAILED with the error text', () => {
    assert.strictEqual(resultFor(netFail, '91.jpg').finalStatus, 'failed');
    assert.match(resultFor(netFail, '91.jpg').reasons[0].detail, /ECONNRESET/);
  });

  dbLogs.length = 0;
  const tplMissing = await runUpload({
    uploaded: ['91.jpg'],
    api: (body, n) => (body.type === 'template' ? { status: 400, json: { error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } } } : okApi(body, n)),
  });
  check('template itself rejected (132001) → plain document with the SAME file (allowed inside a 24h window); SENT; template attempt superseded', () => {
    assert.deepStrictEqual(tplMissing.calls.map((c) => c.body.type), ['template', 'document']);
    assert.strictEqual(linkOf(tplMissing.calls[1]), linkOf(tplMissing.calls[0]));
    assert.strictEqual(resultFor(tplMissing, '91.jpg').recipients[0].channel, 'document');
    assert.ok(dbLogs.some((l) => /SET status = 'superseded'/.test(l.sql)));
  });

  const window131047 = await runUpload({
    uploaded: ['91.jpg'],
    api: (body) => (body.type === 'template'
      ? { status: 400, json: { error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } } }
      : { status: 400, json: { error: { message: '(#131047) Re-engagement message', code: 131047 } } }),
  });
  check('131047 scenario: template rejected AND plain document outside the 24h window → FAILED as a template rejection naming both errors', () => {
    const r = resultFor(window131047, '91.jpg');
    assert.strictEqual(r.finalStatus, 'failed');
    assert.strictEqual(r.reasons[0].category, CAT.TEMPLATE);
    assert.match(r.reasons[0].detail, /132001/);
    assert.match(r.reasons[0].detail, /131047/);
  });

  const partial = await runUpload({ uploaded: ['33.jpg'], api: (body, n) => (body.to === '918000000033' ? { status: 500, json: { error: { message: 'Internal error', code: 2 } } } : okApi(body, n)) });
  check('one of two numbers fails → paper PARTIAL, the failing number named', () => {
    const r = resultFor(partial, '33.jpg');
    assert.strictEqual(r.finalStatus, 'partial');
    assert.strictEqual(r.sentCount, 1);
    assert.strictEqual(r.failedCount, 1);
    assert.strictEqual(r.reasons[0].recipient, '918000000033');
  });

  const saveFail = await runUpload({
    uploaded: ['75.jpg', '91.jpg'],
    savePaperImpl: async ({ student }) => { if (student.roll_no === '75') throw new Error('S3 PutObject failed'); return { status: 'inserted', paperId: 5, notifyType: 'test_paper_upload' }; },
  });
  check('storage failure → FAILED "Paper could not be saved", nothing sent for it', () => {
    const r = resultFor(saveFail, '75.jpg');
    assert.strictEqual(r.finalStatus, 'failed');
    assert.strictEqual(r.reasons[0].category, CAT.SAVE_FAILED);
    assert.ok(!saveFail.calls.some((c) => /75$/.test(c.body.to)));
  });

  const crossed = await runUpload({ uploaded: ['91.jpg'], savePaperImpl: async () => ({ status: 'inserted', paperId: 4242, notifyType: 'test_paper_upload' }) });
  check('notify looks the paper up by (paperId AND studentId): a mismatch sends nothing (S3/document URL problem)', () => {
    assert.strictEqual(crossed.calls.length, 0);
    assert.strictEqual(resultFor(crossed, '91.jpg').reasons[0].category, CAT.DOCUMENT_URL);
  });

  // =====================================================================================
  console.log('\n=== 6. Summary bar: live final status (template retry wins over the 131047 first attempt) ===');
  // =====================================================================================
  fakeLogRows.clear();
  fakeLogRows.set(1101, { id: 1101, status: 'superseded', superseded_by_log_id: 1103, last_error: '131047 Re-engagement message' });
  fakeLogRows.set(1103, { id: 1103, status: 'read', superseded_by_log_id: null, last_error: null, message_type: 'template' });
  fakeLogRows.set(1200, { id: 1200, status: 'failed', superseded_by_log_id: null, last_error: '131026 Message undeliverable' });
  fakeLogRows.set(1300, { id: 1300, status: 'failed', superseded_by_log_id: null, last_error: '131053 Media upload error - Image file has size 5283822 bytes' });
  const statuses = await getFinalLogStatuses([1101, 1200, 1300]);
  check('getFinalLogStatuses follows superseded → template row (read)', () => {
    assert.strictEqual(statuses.get(1101).status, 'read');
    assert.strictEqual(statuses.get(1101).viaTemplate, true);
    assert.strictEqual(statuses.get(1200).status, 'failed');
  });
  const summary = buildPaperUploadSummary({
    results: [
      { studentName: 'APEKSHA UMBARKAR', rollNo: '88', filename: '88.jpg', finalStatus: 'sent', recipients: [{ key: 'parent', to: '91XXXXXX426', ok: true, logId: 1101 }], reasons: [] },
      { studentName: 'SHRAVANI AHER', rollNo: '77', filename: '77.jpg', finalStatus: 'sent', recipients: [{ key: 'student', to: '91XXXXXX314', ok: true, logId: 1200 }], reasons: [] },
      { studentName: 'ROHAN DURKAR', rollNo: '2', filename: '2.jpg', finalStatus: 'sent', recipients: [{ key: 'student', to: '91XXXXXX001', ok: true, logId: 1300 }], reasons: [] },
      { studentName: 'No Numbers', rollNo: '36', filename: '36.jpg', finalStatus: 'skipped', recipients: [], reasons: [{ category: CAT.NO_VALID_NUMBER, detail: NO_VALID_NUMBER_REASON }] },
      { studentName: null, rollNo: '76', filename: '76.jpg', finalStatus: 'skipped', recipients: [], reasons: [{ category: CAT.STUDENT_NOT_FOUND, detail: 'Student with roll number 76 not found in database.' }] },
    ],
  }, statuses);
  check('counts come from the real outcomes: 5 processed, 1 sent, 2 failed, 2 skipped', () => {
    assert.deepStrictEqual(summary.counts, { processed: 5, sent: 1, partial: 0, failed: 2, skipped: 2, pending: 0 });
  });
  check('Apeksha shows the template retry\'s final "Read", NOT the 131047 failure', () => {
    const row = summary.rows.find((r) => r.paper === '88.jpg');
    assert.strictEqual(row.status, 'Read');
    assert.match(row.reason, /approved template/);
    assert.ok(!summary.reasons.some((r) => r.category === CAT.WINDOW_131047));
  });
  check('reasons are separate, never a generic "WhatsApp failed"', () => {
    const byCat = Object.fromEntries(summary.reasons.map((r) => [r.category, r.count]));
    assert.deepStrictEqual(byCat, {
      [CAT.NOT_ON_WHATSAPP]: 1,
      [CAT.MEDIA_131053]: 1,
      [CAT.NO_VALID_NUMBER]: 1,
      [CAT.STUDENT_NOT_FOUND]: 1,
    });
  });

  // ---------- printed evidence ----------
  console.log('\n=== EVIDENCE: summary rows (Student | Roll | Paper | Recipient | Status | Reason) ===');
  for (const row of summary.rows) console.log(`  ${row.student} | ${row.rollNo} | ${row.paper} | ${row.recipient} | ${row.status} | ${row.reason}`);
  console.log('\nSample upload log lines:');
  for (const line of [...main.logs, ...notFound.logs].filter((l) => l.startsWith('[PAPER UPLOAD')).slice(0, 5)) console.log(`  ${line}`);

  console.log(`\n${passes} passed, ${failures} failed.`);
  if (failures > 0) process.exit(1);
  console.log('All paper upload routing tests passed.');
})().catch((error) => {
  console.error('Test harness crashed:', error);
  process.exit(1);
});
