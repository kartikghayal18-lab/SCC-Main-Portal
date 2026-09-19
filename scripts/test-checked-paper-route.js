// Route-level test: drives the REAL Express handler for POST /admin/upload-papers (loaded from
// src/app.js) with a real .xlsx summary + uploaded checked JPGs, through the real
// runCheckedPaperImport → savePaperUpload → notifyPaperEvent → getPaperDocumentUrl →
// deliverPaperDocument → whatsapp.js → fetch chain.
//
// Faked at the edges ONLY:  database (in-memory module stub), file storage (in-memory),
// network (global.fetch → fake Meta Graph API + fake CDN), multer/auth middleware (req.files
// and req.session are filled in the shape multer/express-session produce).
//
// => proves "API REQUEST VERIFIED", NOT real WhatsApp acceptance or delivery.
//
// Real credentials are never used: every env var the project's .env defines is pre-seeded with
// a dummy so dotenv cannot override it, and the fake network refuses anything that is not
// the Graph API endpoint with the dummy token.
//
// Usage:
//   node scripts/test-checked-paper-route.js                      # built-in fixture (75/91/80)
//   node scripts/test-checked-paper-route.js --xlsx <summary.xlsx> [--expected expected.json]
//        expected.json = {"75":"<checked file>", ...} produced independently of the JS parser

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- hard isolation from production ----------
const DUMMY_ENV = {
  DATABASE_URL: 'postgresql://stub:stub@127.0.0.1:1/stub', // unreachable on purpose
  NODE_ENV: 'test',
  FILE_STORAGE_MODE: 's3',
  S3_ACCESS_KEY_ID: 'dummy', S3_SECRET_ACCESS_KEY: 'dummy', S3_BUCKET_NAME: 'dummy', S3_ENDPOINT: 'http://127.0.0.1:1',
  S3_FORCE_PATH_STYLE: 'true', S3_PUBLIC_BASE_URL: 'https://cdn.test', S3_REGION: 'auto', S3_SIGNED_URL_TTL_SECONDS: '60',
  PUBLIC_BASE_URL: 'https://portal.test', SESSION_SECRET: 'dummy-session-secret',
  ADMIN_USERNAME: 'dummy', ADMIN_PASSWORD: 'dummy', ADMIN_FORCE_RESET: 'false', MERI_ADMIN_USERNAME: 'dummy', MERI_ADMIN_PASSWORD: 'dummy',
  RESEND_API_KEY: 'dummy', RESEND_FROM: 'dummy@example.test',
  WHATSAPP_ACCESS_TOKEN: 'TEST_ONLY_TOKEN', WHATSAPP_PHONE_NUMBER_ID: 'TEST_PHONE_NUMBER_ID',
  WHATSAPP_BUSINESS_ACCOUNT_ID: 'TEST_WABA', WHATSAPP_VERIFY_TOKEN: 'dummy', WHATSAPP_PAPER_TEMPLATE_NAME: 'paper_result_notification',
};
Object.assign(process.env, DUMMY_ENV);

const ROOT = path.join(__dirname, '..');
const state = { students: [], papers: [], waLogs: [], sql: [] };
let nextId = 5000;

// ---------- fake database (stub for src/db.js AND config/database.js) ----------
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const fakeDb = {
  getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }),
  withTransaction: async (fn) => fn(fakeDb),
  all: async (sql) => {
    const n = norm(sql);
    state.sql.push(`all: ${n.slice(0, 90)}`);
    if (/FROM users WHERE coaching_id = \? AND branch_id = \? AND role = 'student'$/.test(n)) return state.students.map((s) => ({ ...s }));
    return [];
  },
  get: async (sql, params = []) => {
    const n = norm(sql);
    state.sql.push(`get: ${n.slice(0, 90)}`);
    // getPaperDocumentUrl: "WHERE tp.id = ? AND tp.student_id = ? AND storage_type='s3' AND public_url <> ''"
    if (n.startsWith('SELECT tp.id, tp.original_name')) {
      const [paperId, studentId] = params;
      const paper = state.papers.find((p) => p.id === paperId && p.student_id === studentId && p.storage_type === 's3' && p.public_url);
      if (!paper) return null;
      const s = state.students.find((x) => x.id === paper.student_id);
      return { id: paper.id, original_name: paper.original_name, stored_name: paper.stored_name, storage_type: paper.storage_type, storage_key: paper.storage_key, public_url: paper.public_url, content_type: paper.content_type, marks_obtained: paper.marks_obtained, max_marks: paper.max_marks, test_label: paper.test_label, coaching_id: paper.coaching_id, student_id: s.id, roll_no: s.roll_no, name: s.name, branch_id: paper.branch_id, whatsapp_number: s.whatsapp_number, parent_whatsapp_number: s.parent_whatsapp_number, contact_phone: s.contact_phone, guardian_phone: s.guardian_phone };
    }
    return null;
  },
  run: async (sql, params = []) => {
    const n = norm(sql);
    state.sql.push(`run: ${n.slice(0, 90)}`);
    if (n.startsWith('INSERT INTO test_papers')) {
      const id = ++nextId;
      state.papers.push({ id, coaching_id: params[0], branch_id: params[1], student_id: params[2], original_name: params[3], stored_name: params[4], storage_type: params[6], storage_key: params[7], public_url: params[8], content_type: params[9], marks_obtained: params[11], max_marks: params[12], test_label: params[14] });
      return { lastID: id, rowCount: 1 };
    }
    if (n.startsWith('INSERT INTO whatsapp_logs')) {
      const id = ++nextId;
      state.waLogs.push({ id, student_id: params[2], phone: params[3], type: params[4], status: params[6], meta_message_id: params[7], document_url: params[8], document_filename: params[9], last_error: params[10] });
      return { lastID: id, rowCount: 1 };
    }
    if (n.startsWith('UPDATE whatsapp_logs SET status = ?, meta_message_id = ? WHERE id = ?')) {
      const log = state.waLogs.find((l) => l.id === params[2]);
      if (log) { log.status = params[0]; log.meta_message_id = params[1]; }
      return { rowCount: 1 };
    }
    if (n.startsWith('UPDATE whatsapp_logs SET status = ?, message_content = ?, last_error = ? WHERE id = ?')) {
      const log = state.waLogs.find((l) => l.id === params[3]);
      if (log) { log.status = params[0]; log.last_error = params[2]; }
      return { rowCount: 1 };
    }
    return { lastID: ++nextId, rowCount: 1 };
  },
};
for (const modulePath of [require.resolve('../src/db'), path.join(ROOT, 'config', 'database.js')]) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: fakeDb };
}

// ---------- fake storage (in-memory "S3") ----------
const cdn = new Map(); // public url -> Buffer
const storagePath = require.resolve('../src/storage');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true,
  exports: {
    initStorage() {}, getStorageMode: () => 's3', getLocalPaperDir: () => '/nonexistent',
    uploadPaperFile: async (file) => {
      const key = `papers/2026-09-19/${++nextId}_${crypto.randomUUID()}_${file.originalname}`;
      const publicUrl = `https://cdn.test/${key}`;
      cdn.set(publicUrl, Buffer.from(file.buffer));
      return { storedName: key, storageType: 's3', storageKey: key, publicUrl, contentType: file.mimetype, sizeBytes: file.size };
    },
    uploadGeneratedFile: async () => ({ publicUrl: null }), getStoredFilePublicUrl: () => null,
    getStoredFileReadStream: async () => null, getPaperAccess: async () => null, deleteStoredPaper: async () => {},
  },
};

// ---------- fake network ----------
const apiCalls = [];
let apiScript = (body, n) => ({ status: 200, json: { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.FAKE${n}` }] } });
global.fetch = async (url, options = {}) => {
  if (String(url).startsWith('https://cdn.test/')) {
    const buffer = cdn.get(String(url));
    return { status: buffer ? 200 : 404, ok: Boolean(buffer), arrayBuffer: async () => buffer };
  }
  if (!String(url).startsWith('https://graph.facebook.com/') || !String(url).endsWith('/TEST_PHONE_NUMBER_ID/messages')
    || options.headers?.Authorization !== 'Bearer TEST_ONLY_TOKEN') {
    throw new Error(`NETWORK GUARD: refusing request to ${url}`);
  }
  const body = JSON.parse(options.body);
  apiCalls.push({ url, body });
  const scripted = apiScript(body, apiCalls.length);
  if (scripted.throw) throw new Error(scripted.throw);
  return { status: scripted.status, ok: scripted.status < 300, json: async () => scripted.json };
};

// ---------- load the REAL app and grab the REAL route handler ----------
const realConsole = { log: console.log, error: console.error, warn: console.warn };
const captured = [];
const capture = (...args) => captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
console.log = capture; console.error = capture; console.warn = capture;
const appModule = require('../src/app');
const routeLayer = appModule.app._router.stack.find((layer) => layer.route && layer.route.path === '/admin/upload-papers' && layer.route.methods.post);
console.log = realConsole.log; console.error = realConsole.error; console.warn = realConsole.warn;
if (!routeLayer) { console.error('Could not find POST /admin/upload-papers in the real app'); process.exit(1); }
const routeHandler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle; // the handler after auth + multer

const { buildXlsx } = require('./lib/xlsx-fixture');

// ---------- helpers ----------
let failures = 0; let passes = 0;
function check(description, fn) {
  try { fn(); passes += 1; realConsole.log(`PASS  ${description}`); } catch (e) { failures += 1; realConsole.error(`FAIL  ${description}\n      ${String(e.message).split('\n').join('\n      ')}`); }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const maskNum = (n) => (n ? `${String(n).slice(0, 2)}******${String(n).slice(-4)}` : '-');
const jpg = (name) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`SYNTHETIC-CHECKED-PAPER:${name}`), Buffer.from([0xff, 0xd9])]);

async function invokeRoute({ excelBuffer, uploadedNames, students, api }) {
  state.students = students; state.papers = []; state.waLogs = []; state.sql = []; cdn.clear(); apiCalls.length = 0; captured.length = 0;
  if (api) apiScript = api;
  const uploaded = uploadedNames.map((name) => ({ fieldname: 'papers', originalname: name, mimetype: 'image/jpeg', buffer: jpg(name), size: jpg(name).length }));
  const req = {
    method: 'POST', originalUrl: '/admin/upload-papers', ip: '127.0.0.1', headers: {}, protocol: 'https',
    get: (h) => (req.headers[h.toLowerCase()] || ''),
    session: { user: { id: 1, role: 'admin', coachingId: 1, branchId: 1, isOwner: false }, flash: null },
    currentCoaching: { coaching_id: 1, name: 'TEST COACHING' },
    body: { maxMarks: '720' },
    files: { papers: uploaded, resultsExcel: [{ fieldname: 'resultsExcel', originalname: 'summary.xlsx', buffer: excelBuffer, mimetype: 'application/octet-stream' }] },
  };
  let redirectedTo = null;
  const res = { redirect: (u) => { redirectedTo = u; }, setHeader() {}, write() {}, end() {}, status() { return res; }, send() {} };
  console.log = capture; console.error = capture; console.warn = capture;
  try { await routeHandler(req, res, (e) => { if (e) throw e; }); } finally { console.log = realConsole.log; console.error = realConsole.error; console.warn = realConsole.warn; }
  return { flash: req.session.flash, redirectedTo, uploaded, logs: [...captured] };
}

const student = (id, roll, extra = {}) => ({ id, roll_no: String(roll), name: `Student ${roll}`, parent_whatsapp_number: `90000${String(roll).padStart(5, '0')}`, whatsapp_number: `80000${String(roll).padStart(5, '0')}`, contact_phone: null, guardian_phone: null, ...extra });
const graphDocCalls = () => apiCalls.filter((c) => c.body.type === 'document');

(async () => {
  const args = process.argv.slice(2);
  const xlsxArg = args.includes('--xlsx') ? args[args.indexOf('--xlsx') + 1] : null;
  const expectedArg = args.includes('--expected') ? args[args.indexOf('--expected') + 1] : null;

  let excelBuffer; let expected; let source;
  if (xlsxArg) {
    excelBuffer = fs.readFileSync(xlsxArg);
    expected = JSON.parse(fs.readFileSync(expectedArg, 'utf8')); // roll -> checked file, from an INDEPENDENT parser
    source = `REAL workbook ${xlsxArg}`;
  } else {
    const H = ['Student', 'Roll Number', 'Paper Code', 'Physics', 'Chemistry', 'Biology', 'Total Score', 'Correct', 'Wrong', 'Blank', 'Multi-marked', 'Checked File'];
    excelBuffer = buildXlsx([H,
      ['20260915160533_0002', '??????75', null, 2, 0, 40, 42, 1, 1, 1, 0, '20260915160533_0002_checked.jpg'],
      ['20260915160533_0003', '??????91', null, 18, 25, 143, 186, 1, 1, 1, 0, '20260915160533_0003_checked.jpg'],
      ['20260915160533_0004', '??????80', null, 6, -1, 56, 61, 1, 1, 1, 0, '20260915160533_0004_checked.jpg']]);
    expected = { 75: '20260915160533_0002_checked.jpg', 91: '20260915160533_0003_checked.jpg', 80: '20260915160533_0004_checked.jpg' };
    source = 'built-in fixture (Excel-shaped bytes)';
  }
  realConsole.log(`\nSOURCE: ${source}\n`);

  const { toBulkPaperExcelRows } = require('../src/services/omrImportParsing');
  const excelRows = toBulkPaperExcelRows(excelBuffer);
  const checkedNames = excelRows.map((r) => r.checkedFile).filter(Boolean);
  const rollsInExcel = [...new Set(excelRows.map((r) => r.rollNo).filter(Boolean))];

  // Students: one per Excel roll, plus DISTRACTORS whose roll numbers equal the scan sequence
  // numbers embedded in the filenames (1..30) so any filename-based routing would hit them.
  const students = [];
  let sid = 100;
  for (const r of rollsInExcel) students.push(student(sid += 1, r));
  for (const seq of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 30]) {
    if (!students.some((s) => s.roll_no === String(seq))) students.push(student(sid += 1, seq));
  }
  const studentByRoll = (roll) => students.find((s) => s.roll_no === String(roll));

  // ================= MAIN RUN: all rows through the real route, files uploaded in REVERSE order =================
  const run1 = await invokeRoute({ excelBuffer, uploadedNames: [...checkedNames].reverse(), students });
  const docs = graphDocCalls();
  const outcome = (roll) => {
    const s = studentByRoll(roll); const file = expected[roll];
    const call = docs.find((c) => c.body.document.filename === file);
    const paper = state.papers.find((p) => p.original_name === file);
    const cdnBytes = call ? cdn.get(call.body.document.link) : null;
    const intended = s ? `91${s.parent_whatsapp_number}` : null;
    return { roll, file, s, call, paper, cdnBytes, intended };
  };

  realConsole.log('Excel Roll | Expected Checked File | Actual Checked File (API filename) | Student (id) | Intended Recipient | Actual API Recipient | Attachment (sha256 of CDN bytes == uploaded file) | API Status | Result');
  const focus = ['75', '91', '80'].filter((r) => expected[r]);
  const focusSet = new Set(focus);
  const allExpectedRolls = Object.keys(expected);
  for (const roll of [...focus, ...allExpectedRolls.filter((r) => !focusSet.has(r))]) {
    const o = outcome(roll);
    const attachmentOk = o.cdnBytes && sha(o.cdnBytes) === sha(jpg(o.file));
    const ok = o.call && o.call.body.to === o.intended && o.paper && o.paper.student_id === o.s.id && attachmentOk;
    realConsole.log([roll, o.file, o.call?.body.document.filename || 'NOT SENT', `${o.s?.name} (${o.s?.id})`, maskNum(o.intended), maskNum(o.call?.body.to), attachmentOk ? `sha256 ${sha(jpg(o.file)).slice(0, 12)}… match` : 'MISMATCH', o.call ? '200 (FAKE API)' : '-', ok ? 'PASS' : 'FAIL'].join(' | '));
  }

  realConsole.log('\n--- Full Meta payload for the first focus roll ---');
  const first = outcome(focus[0]);
  realConsole.log(JSON.stringify(first.call.body, null, 2));
  realConsole.log('--- Fake API response body returned for it ---');
  realConsole.log(JSON.stringify({ status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: first.call.body.to, wa_id: first.call.body.to }], messages: [{ id: 'wamid.FAKE1' }] } }));
  realConsole.log('--- whatsapp_logs rows written for it (status after API acceptance) ---');
  realConsole.log(JSON.stringify(state.waLogs.filter((l) => l.document_filename === first.file)));
  realConsole.log('--- route flash message ---');
  realConsole.log(JSON.stringify(run1.flash?.text));
  realConsole.log('');

  check('the REAL route ran and redirected back to the papers section', () => assert.strictEqual(run1.redirectedTo, '/admin/dashboard?section=papers'));
  for (const roll of allExpectedRolls) {
    const o = outcome(roll);
    check(`Roll ${roll} → ${o.file}: stored for student ${o.s?.id}, sent to that student's PARENT number, attachment bytes identical`, () => {
      assert.ok(o.s, 'no student for roll'); assert.ok(o.paper, 'paper not stored'); assert.ok(o.call, 'no WhatsApp document request');
      assert.strictEqual(o.paper.student_id, o.s.id, 'stored under the wrong student');
      assert.strictEqual(o.call.body.to, o.intended, 'wrong recipient');
      assert.strictEqual(o.call.body.type, 'document');
      assert.strictEqual(o.call.body.document.link, o.paper.public_url, 'document.link is not this row\'s stored file');
      assert.strictEqual(sha(o.cdnBytes), sha(jpg(o.file)), 'attachment bytes differ from the uploaded checked file');
    });
  }
  check('recipient rule: parent-only — no document was sent to any student/own number', () => {
    const studentOwn = new Set(students.map((s) => `91${s.whatsapp_number}`));
    for (const c of docs) assert.ok(!studentOwn.has(c.body.to), `document sent to a student's own number ${maskNum(c.body.to)}`);
  });
  check('one document per resolvable Excel row; unreadable-roll rows sent nothing', () => {
    assert.strictEqual(docs.length, allExpectedRolls.length);
    const unresolved = excelRows.filter((r) => !r.rollNo).length;
    assert.strictEqual(run1.flash.details.filter((d) => d.status === 'invalid_roll_number').length, unresolved);
  });
  check('every document is addressed to exactly the parent of the roll in ITS row (cross-check all pairs)', () => {
    const rows = excelRows.filter((r) => r.rollNo && expected[r.rollNo]);
    for (const r of rows) {
      const call = docs.find((c) => c.body.document.filename === r.checkedFile);
      assert.strictEqual(call.body.to, `91${studentByRoll(r.rollNo).parent_whatsapp_number}`, `row ${r.rowNumber}`);
    }
  });
  check('API acceptance is reported as "accepted by API" and logged status is "sent" — never "delivered"', () => {
    assert.match(run1.flash.text, /WhatsApp accepted by API: \d+/);
    assert.ok(!/deliver/i.test(run1.flash.text));
    for (const l of state.waLogs.filter((x) => x.type === 'document')) assert.strictEqual(l.status, 'sent');
  });
  check('route logged a [CHECKED PAPER SEND] record per imported row', () => {
    assert.ok(run1.logs.filter((l) => l.startsWith('[CHECKED PAPER SEND]')).length >= allExpectedRolls.length);
  });

  // ================= EXTRA MESSAGES the real route sends besides the paper =================
  const nonDoc = apiCalls.filter((c) => c.body.type !== 'document');
  realConsole.log(`\nNOTE: besides the ${docs.length} paper documents, the real route also issued ${nonDoc.length} other WhatsApp API request(s): ${JSON.stringify(nonDoc.map((c) => ({ type: c.body.type, to: maskNum(c.body.to) })))}`);
  check('every extra (non-document) message goes only to that row\'s parent number', () => {
    const parents = new Set(allExpectedRolls.map((r) => `91${studentByRoll(r).parent_whatsapp_number}`));
    for (const c of nonDoc) assert.ok(parents.has(c.body.to), `extra message to unexpected number ${maskNum(c.body.to)}`);
  });

  // ================= FAILURE MODES through the real route (focus roll only) =================
  const oneRoll = focus[0]; const oneFile = expected[oneRoll];
  const oneRow = buildXlsx([
    ['Student', 'Roll Number', 'Paper Code', 'Physics', 'Chemistry', 'Biology', 'Total Score', 'Correct', 'Wrong', 'Blank', 'Multi-marked', 'Checked File'],
    ['x', `??????${oneRoll}`, null, 1, 1, 1, 3, 1, 1, 1, 0, oneFile]]);
  const oneStudents = [student(1, oneRoll), student(2, 2)];

  const rejected = await invokeRoute({ excelBuffer: oneRow, uploadedNames: [oneFile], students: oneStudents, api: () => ({ status: 400, json: { error: { message: '(#131030) Recipient phone number not in allowed list', code: 131030 } } }) });
  check('Meta rejects (HTTP 400 / 131030) → flash + logs say FAILED, "accepted" count is 0', () => {
    assert.match(rejected.flash.text, /WhatsApp accepted by API: 0, WhatsApp failed: 1/);
    assert.strictEqual(rejected.flash.type, 'warning');
    assert.ok(rejected.logs.some((l) => l.includes('WhatsApp FAILED') && l.includes('131030')));
    assert.ok(state.waLogs.some((l) => l.status === 'failed' && /131030/.test(l.last_error || '')));
  });

  const windowClosed = await invokeRoute({ excelBuffer: oneRow, uploadedNames: [oneFile], students: oneStudents, api: (b, n) => (b.type === 'document' ? { status: 400, json: { error: { message: '(#131047) Re-engagement message', code: 131047 } } } : { status: 200, json: { messages: [{ id: `wamid.T${n}` }] } }) });
  check('24h window closed (131047) → template fallback sent to SAME parent with SAME file link', () => {
    const doc = apiCalls.find((c) => c.body.type === 'document'); const tpl = apiCalls.find((c) => c.body.type === 'template');
    assert.ok(doc && tpl); assert.strictEqual(tpl.body.to, doc.body.to);
    assert.strictEqual(tpl.body.template.components[0].parameters[0].document.link, doc.body.document.link);
    assert.match(windowClosed.flash.text, /WhatsApp accepted by API: 1/);
  });

  const cross = await invokeRoute({ excelBuffer: oneRow, uploadedNames: [oneFile], students: [student(1, 2), student(2, oneRoll)] });
  check('roll numbers and ids deliberately swapped in the DB: the file still follows the ROLL NUMBER to that roll\'s own parent', () => {
    const c = graphDocCalls()[0];
    assert.strictEqual(c.body.to, `91${student(2, oneRoll).parent_whatsapp_number}`);
    assert.notStrictEqual(c.body.to, `91${student(1, 2).parent_whatsapp_number}`);
  });

  const noParent = await invokeRoute({ excelBuffer: oneRow, uploadedNames: [oneFile], students: [student(1, oneRoll, { parent_whatsapp_number: null }), student(2, 2)] });
  check('no parent number → NOTHING sent (student\'s own number not used), reported as skipped', () => {
    assert.strictEqual(apiCalls.length, 0);
    assert.match(noParent.flash.text, /WhatsApp skipped: 1/);
  });

  const dupStudents = await invokeRoute({ excelBuffer: oneRow, uploadedNames: [oneFile], students: [student(1, oneRoll), student(9, oneRoll, { parent_whatsapp_number: '9111111111' })] });
  check('two students share the roll → ambiguous, nothing stored, nothing sent', () => {
    assert.strictEqual(apiCalls.length, 0); assert.strictEqual(state.papers.length, 0);
    assert.match(dupStudents.flash.text, /Missing student: 1/);
  });

  const missingFile = await invokeRoute({ excelBuffer: oneRow, uploadedNames: ['some_other_checked.jpg'], students: oneStudents });
  check('Checked File not uploaded → nothing sent, other uploaded file not substituted', () => {
    assert.strictEqual(apiCalls.length, 0); assert.match(missingFile.flash.text, /Missing file: 1/);
  });

  realConsole.log(`\n${passes} passed, ${failures} failed.`);
  realConsole.log('LABEL: API REQUEST VERIFIED — REAL WHATSAPP DELIVERY NOT VERIFIED (Meta API, DB, storage and network are stubbed).');
  process.exit(failures ? 1 : 0);
})().catch((error) => { realConsole.error('Harness crashed:', error); process.exit(1); });
