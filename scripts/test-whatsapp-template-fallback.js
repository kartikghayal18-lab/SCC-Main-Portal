// Regression tests for the 131047 (24-hour window closed) template fallback in src/services/whatsapp.js:
// webhook status handling, buildTemplateFallback() and the dashboard Resend button.
//
// Meta, the database and the network are stubbed: this never requires src/app.js or .env, and
// refuses to run if DATABASE_URL is set.
//
// Run: node scripts/test-whatsapp-template-fallback.js

const assert = require('assert');

if (process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is set. This test must never touch a real database.');
  process.exit(1);
}
process.env.WHATSAPP_ACCESS_TOKEN = 'TEST_ONLY_TOKEN';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'TEST_PHONE_NUMBER_ID';
delete process.env.WHATSAPP_PAPER_TEMPLATE_NAME;
delete process.env.WHATSAPP_DOCUMENT_TEMPLATE_NAME;
delete process.env.WHATSAPP_TEXT_TEMPLATE_NAME;
delete process.env.WHATSAPP_TEMPLATE_LANGUAGE;

const PAPER_URL = 'https://files.example.com/papers/roll75_checked.jpg';
const RECEIPT_URL = 'https://edusync.example.com/receipts/RCP-0042.pdf';
const BIG_PAPER_URL = 'https://files.example.com/papers/83.jpg';
const logs = new Map();
const dbRuns = [];
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    run: async (sql, params) => { dbRuns.push({ sql, params }); return { lastID: 900 + dbRuns.length }; },
    get: async (sql, params) => {
      if (/FROM whatsapp_logs wl/.test(sql)) return logs.get(params[0]) || null;
      if (/FROM users/.test(sql)) return { name: 'Rahul Patil', roll_no: '75', parent_name: 'Suresh Patil' };
      if (/FROM coaching_classes/.test(sql)) return { name: 'Shiv Chhatrapati Classes', brand_name: null };
      if (/FROM test_papers/.test(sql)) {
        if (params[0] === PAPER_URL) return { test_label: 'Unit Test\n1', marks_obtained: 42, max_marks: 50, size_bytes: 3000000 };
        if (params[0] === BIG_PAPER_URL) return { test_label: 'PC1', marks_obtained: 120, max_marks: 180, size_bytes: 5283822 };
        return null;
      }
      return null;
    },
    all: async () => [],
  },
};

const apiCalls = [];
let metaReply = () => ({ status: 200, json: { messages: [{ id: `wamid.T${apiCalls.length}` }] } });
global.fetch = async (url, options) => {
  assert.ok(String(url).startsWith('https://graph.facebook.com/'), `unexpected network call: ${url}`);
  const body = JSON.parse(options.body);
  apiCalls.push({ url, body });
  const { status, json } = metaReply(body);
  return { ok: status < 400, status, json: async () => json };
};

const wa = require('../src/services/whatsapp');

let failures = 0;
let passes = 0;
async function check(description, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`PASS  ${description}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${description}`);
    console.error(`      ${String(error.stack || error.message).split('\n').join('\n      ')}`);
  }
}
const lastRun = (pattern) => [...dbRuns].reverse().find((r) => pattern.test(r.sql));
const reset = () => { apiCalls.length = 0; dbRuns.length = 0; };

function baseLog(overrides) {
  return {
    coaching_id: 1, branch_id: 2, student_id: 75, phone_number: '9000000075', status: 'failed',
    retry_count: 0, student_name: 'Rahul Patil', roll_no: '75', ...overrides,
  };
}

(async () => {
  await check('webhook 131047 → error code + details go to last_error only; message_content untouched', async () => {
    reset();
    await wa.updateWhatsAppLogStatus('wamid.X', 'failed', [{
      code: 131047, title: 'Re-engagement message',
      message: 'Re-engagement message',
      error_data: { details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.' },
    }]);
    const update = lastRun(/UPDATE whatsapp_logs/);
    assert.ok(!/message_content/.test(update.sql), 'must not append errors to message_content');
    assert.strictEqual(update.params[0], 'failed');
    assert.match(update.params[2], /^131047 Re-engagement message - Message failed to send because more than 24 hours/);
    assert.strictEqual(update.params[3], 'wamid.X');
  });

  await check('fallback for a text log → coaching_update with flattened text (no newlines) and old error text removed', async () => {
    const fb = await wa.buildTemplateFallback(baseLog({
      message_type: 'text',
      message_content: '🏫 SCC\n\n❌ Attendance Alert\n\nStudent: Rahul Patil\nDate: 01-10-2026\n\nDelivery error: Re-engagement message',
    }));
    assert.strictEqual(fb.templateName, 'coaching_update');
    assert.strictEqual(fb.languageCode, 'en');
    const params = fb.components[0].parameters.map((p) => p.text);
    assert.deepStrictEqual(params.slice(0, 2), ['Shiv Chhatrapati Classes', 'Rahul Patil']);
    assert.strictEqual(params[2], '🏫 SCC ❌ Attendance Alert Student: Rahul Patil Date: 01-10-2026');
    assert.ok(params.every((t) => !/[\n\t]/.test(t)));
  });

  await check('fallback for a JPEG checked paper → paper_result_notification, IMAGE header, marks from test_papers', async () => {
    const fb = await wa.buildTemplateFallback(baseLog({
      message_type: 'document', document_url: PAPER_URL, document_filename: 'roll75_checked.jpg', message_content: 'Checked paper',
    }));
    assert.strictEqual(fb.templateName, 'paper_result_notification');
    const [header, body] = fb.components;
    assert.deepStrictEqual(header.parameters[0], { type: 'image', image: { link: PAPER_URL } });
    assert.deepStrictEqual(body.parameters.map((p) => p.text), ['Suresh Patil', 'Rahul Patil', 'Unit Test 1', '42', '50']);
  });

  await check('fallback for a PDF receipt → coaching_document, DOCUMENT header with same link + filename', async () => {
    const fb = await wa.buildTemplateFallback(baseLog({
      message_type: 'document', document_url: RECEIPT_URL, document_filename: 'RCP-0042.pdf', message_content: 'Receipt attached below.',
    }));
    assert.strictEqual(fb.templateName, 'coaching_document');
    assert.deepStrictEqual(fb.components[0].parameters[0], { type: 'document', document: { link: RECEIPT_URL, filename: 'RCP-0042.pdf' } });
    assert.deepStrictEqual(fb.components[1].parameters.map((p) => p.text), ['fee receipt', 'Rahul Patil', 'Shiv Chhatrapati Classes']);
  });

  await check('fallback for a template log → null (an auto-retry can never loop)', async () => {
    assert.strictEqual(await wa.buildTemplateFallback(baseLog({ message_type: 'template', message_content: 'template:coaching_update;language:en' })), null);
  });

  await check('env names override template names', async () => {
    process.env.WHATSAPP_TEXT_TEMPLATE_NAME = 'custom_update';
    try {
      const fb = await wa.buildTemplateFallback(baseLog({ message_type: 'text', message_content: 'hi' }));
      assert.strictEqual(fb.templateName, 'custom_update');
    } finally {
      delete process.env.WHATSAPP_TEXT_TEMPLATE_NAME;
    }
  });

  await check('Resend of a 131047 text log → ONE template request (no doomed free-form retry), same number, log marked sent', async () => {
    reset();
    logs.set(11, baseLog({ id: 11, message_type: 'text', message_content: 'Fee paid. Thank you.', last_error: '131047 Re-engagement message' }));
    const result = await wa.resendWhatsAppLog({ logId: 11, coachingId: 1, branchId: 2, resentBy: 5 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.template, true);
    assert.deepStrictEqual(apiCalls.map((c) => c.body.type), ['template']);
    assert.strictEqual(apiCalls[0].body.to, '919000000075');
    assert.strictEqual(apiCalls[0].body.template.name, 'coaching_update');
    const update = lastRun(/UPDATE whatsapp_logs/);
    assert.match(update.sql, /status = 'sent'/);
    assert.strictEqual(update.params[0], 'wamid.T1');
  });

  await check('Resend of a 131047 checked paper → image template carrying the SAME file link', async () => {
    reset();
    logs.set(12, baseLog({ id: 12, message_type: 'document', document_url: PAPER_URL, document_filename: 'roll75_checked.jpg', message_content: 'Checked paper', last_error: 'Re-engagement message' }));
    const result = await wa.resendWhatsAppLog({ logId: 12, coachingId: 1, branchId: 2, resentBy: 5 });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(apiCalls.map((c) => c.body.type), ['template']);
    assert.strictEqual(apiCalls[0].body.template.components[0].parameters[0].image.link, PAPER_URL);
  });

  await check('Resend of a non-131047 failure → free-form message resent first, without old error text', async () => {
    reset();
    logs.set(13, baseLog({ id: 13, message_type: 'text', message_content: 'Hello parent\n\nError: timeout', last_error: 'timeout' }));
    const result = await wa.resendWhatsAppLog({ logId: 13, coachingId: 1, branchId: 2, resentBy: 5 });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(apiCalls.map((c) => c.body.type), ['text']);
    assert.strictEqual(apiCalls[0].body.text.body, 'Hello parent');
  });

  await check('Resend when Meta rejects the template → FAILED with the real Meta error, never marked sent', async () => {
    reset();
    metaReply = () => ({ status: 400, json: { error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } } });
    try {
      logs.set(14, baseLog({ id: 14, message_type: 'text', message_content: 'Absent today', last_error: '131047 Re-engagement message' }));
      const result = await wa.resendWhatsAppLog({ logId: 14, coachingId: 1, branchId: 2, resentBy: 5 });
      assert.strictEqual(result.ok, false);
      assert.match(result.message, /132001/);
      const update = lastRun(/UPDATE whatsapp_logs/);
      assert.match(update.sql, /status = 'failed'/);
      assert.match(update.params[0], /Template resend failed: 132001/);
    } finally {
      metaReply = () => ({ status: 200, json: { messages: [{ id: `wamid.T${apiCalls.length}` }] } });
    }
  });

  await check('Resend of a log that is not failed / other branch → denied, nothing sent', async () => {
    reset();
    logs.set(15, baseLog({ id: 15, status: 'sent', message_type: 'text', message_content: 'x' }));
    const sent = await wa.resendWhatsAppLog({ logId: 15, coachingId: 1, branchId: 2 });
    logs.set(16, baseLog({ id: 16, branch_id: 3, message_type: 'text', message_content: 'x' }));
    const otherBranch = await wa.resendWhatsAppLog({ logId: 16, coachingId: 1, branchId: 2 });
    assert.ok(sent.denied && otherBranch.denied);
    assert.strictEqual(apiCalls.length, 0);
  });

  await check('131047 fallback for a checked paper OVER 5 MB → coaching_document (DOCUMENT header), not the image template', async () => {
    const fallback = await wa.buildTemplateFallback(baseLog({ id: 30, message_type: 'document', document_url: BIG_PAPER_URL, document_filename: '83.jpg' }));
    assert.strictEqual(fallback.templateName, 'coaching_document');
    const header = fallback.components.find((c) => c.type === 'header').parameters[0];
    assert.strictEqual(header.type, 'document');
    assert.strictEqual(header.document.link, BIG_PAPER_URL);
  });

  await check('webhook 131053 on a paper_result_notification log → coaching_document with the SAME file, marks in the label', async () => {
    const fallback = await wa.buildOversizeImageFallback(baseLog({
      id: 31, message_type: 'template', message_content: 'template:paper_result_notification;language:en',
      document_url: BIG_PAPER_URL, document_filename: '83.jpg',
    }));
    assert.strictEqual(fallback.templateName, 'coaching_document');
    assert.strictEqual(fallback.documentUrl, BIG_PAPER_URL);
    const header = fallback.components.find((c) => c.type === 'header').parameters[0];
    assert.deepStrictEqual(header, { type: 'document', document: { link: BIG_PAPER_URL, filename: '83.jpg' } });
    const body = fallback.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
    assert.strictEqual(body[0], 'PC1 checked test paper (Marks 120/180)');
  });

  await check('131053 retry builder ignores non-paper templates and logs without a document (no loop)', async () => {
    assert.strictEqual(await wa.buildOversizeImageFallback(baseLog({ message_type: 'template', message_content: 'template:coaching_document;language:en', document_url: BIG_PAPER_URL })), null);
    assert.strictEqual(await wa.buildOversizeImageFallback(baseLog({ message_type: 'template', message_content: 'template:paper_result_notification;language:en', document_url: null })), null);
    assert.strictEqual(await wa.buildOversizeImageFallback(baseLog({ message_type: 'document', message_content: 'x', document_url: BIG_PAPER_URL })), null);
  });

  await check('a superseded log is never overwritten by a late webhook status', async () => {
    reset();
    await wa.updateWhatsAppLogStatus('wamid.OLD', 'failed', [{ code: 131047, title: 'Re-engagement message' }]);
    assert.match(lastRun(/UPDATE whatsapp_logs/).sql, /status <> 'superseded'/);
  });

  console.log(`\n${passes} passed, ${failures} failed.`);
  console.log('LABEL: API REQUEST VERIFIED — REAL WHATSAPP DELIVERY NOT VERIFIED (Meta API and DB are stubbed).');
  process.exit(failures ? 1 : 0);
})();
