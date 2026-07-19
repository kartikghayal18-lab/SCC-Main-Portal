const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
require('../config/env');

const { getPool, run, get, all, withTransaction } = require('./db');
const { initStorage, getStorageMode, getLocalPaperDir, uploadPaperFile, getPaperAccess, deleteStoredPaper, getStoredFileReadStream } = require('./storage');
const { PostgresSessionStore, ensureSessionTable } = require('./session-store');
const { OTP_TTL_MINUTES, generateOtpCode, smtpConfigured, resendConfigured, getOtpChannelOptions, sendOtpMessage, sendTestEmail } = require('./otp-service');
const {
  ensureWhatsAppSchema,
  getWhatsAppSettings,
  saveWhatsAppSettings,
  getRecentWhatsAppLogs,
  resendWhatsAppLog,
  updateWhatsAppLogStatus,
  sendDocumentMessage,
  sendTemplateMessage,
  sendTextMessage,
} = require('./services/whatsapp');
const {
  sendDueFeeReminder,
  sendOverdueReminder,
} = require('./services/feeReminder');
const {
  applyStudentPayment,
  ensureFeeStructureSchema,
  getStudentFeeSummary,
  setStudentTotalFee,
} = require('./services/feeStructure');
const {
  ensureNotificationSchema,
  getRecentNotificationLogs,
  sendDocumentNotification,
  sendWhatsAppNotification,
} = require('./services/notificationService');
const {
  ensureOnboardingWhatsAppSchema,
  getStudentOnboardingStatus,
  retryPendingOnboarding,
  sendStudentOnboarding,
} = require('./services/onboardingWhatsApp');
const {
  findStudentByParentPhone,
  findStudentByParentPhoneAnyCoaching,
  findStudentByParentSession,
  generateFeeReceiptPdf,
  getCoachingByWhatsAppPhoneNumberId,
  handleParentAssistantMessage,
  sendMonthlyParentReports,
  sendPerformanceGraph,
  validatePublicUrl,
  verifyReceiptAccessToken,
} = require('./services/parentAssistant');
const { buildProgressSummaryFromPapers } = require('./services/progress');
const {
  createPerfTrace,
  getGlobalSlowOperations,
  logPerfTrace,
  nowMs,
  recordPerfOperation,
  runWithPerfTrace,
} = require('./performance');
const { getBranchContext, getCurrentBranchId, runWithBranchContext } = require('./branch-context');

console.log('[BOOT] Starting app');
console.log('[BOOT] DATABASE_URL present:', Boolean(process.env.DATABASE_URL));
console.log('[BOOT] Storage mode:', process.env.FILE_STORAGE_MODE || '(auto)');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const isVercel = Boolean(process.env.VERCEL);
const isHostedProduction = Boolean(
  process.env.VERCEL
  || process.env.RENDER
  || process.env.RAILWAY_ENVIRONMENT
  || process.env.FLY_APP_NAME
  || process.env.K_SERVICE
);
const configuredSessionSecret = String(process.env.SESSION_SECRET || '').trim();
if (isProduction && isHostedProduction && !configuredSessionSecret) {
  throw new Error('SESSION_SECRET is required in production.');
}
const sessionSecret = configuredSessionSecret || crypto.randomBytes(32).toString('hex');
const requestAttemptStore = new Map();
const CAPTCHA_TTL_MS = 10 * 60 * 1000;
const sessionCookieSecure = isProduction ? 'auto' : false;
const OTP_SEND_LIMIT = 6;
const OTP_SEND_WINDOW_MS = 10 * 60 * 1000;
const TWO_FACTOR_AUTH_POST_PATHS = new Set([
  '/auth/2fa',
  '/auth/2fa/send-otp',
  '/auth/2fa/verify',
]);
const PUBLIC_WEBHOOK_POST_PATHS = new Set(['/webhook/whatsapp']);
function getRealPaperFileCondition(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `((${prefix}storage_type = 's3' AND ${prefix}public_url IS NOT NULL AND ${prefix}public_url <> '')
    OR (${prefix}storage_type = 'local' AND ${prefix}storage_key IS NOT NULL AND ${prefix}storage_key <> ''))`;
}

function resolvePort(value) {
  const raw = String(value || '').trim();
  if (!raw) return 3000;

  if (/^\d+$/.test(raw)) {
    const numericPort = Number(raw);
    if (Number.isInteger(numericPort) && numericPort > 0 && numericPort < 65536) {
      return numericPort;
    }
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }

  return 3000;
}

function getCurrentMonthValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function normalizeOmrHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsvRows(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(value);
      value = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => String(cell || '').trim())) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }
  row.push(value);
  if (row.some((cell) => String(cell || '').trim())) rows.push(row);
  return rows;
}

function readZipEntries(buffer) {
  const entries = [];
  let offset = buffer.length - 22;
  while (offset >= 0 && buffer.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
  if (offset < 0) throw new Error('Invalid ZIP file');
  const entryCount = buffer.readUInt16LE(offset + 10);
  let centralOffset = buffer.readUInt32LE(offset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const compression = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
    const fileName = buffer.subarray(centralOffset + 46, centralOffset + 46 + fileNameLength).toString('utf8');

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (compression === 0) {
      data = Buffer.from(compressed);
    } else if (compression === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compression}`);
    }
    if (fileName && !fileName.endsWith('/')) entries.push({ name: fileName, data });
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseSheetXml(sheetXml, sharedStrings) {
  const rows = [];
  const rowMatches = sheetXml.match(/<row\b[\s\S]*?<\/row>/g) || [];
  for (const rowXml of rowMatches) {
    const cells = [];
    const cellMatches = rowXml.match(/<c\b[\s\S]*?<\/c>/g) || [];
    for (const cellXml of cellMatches) {
      const ref = (cellXml.match(/\br="([A-Z]+)\d+"/) || [])[1] || '';
      const columnIndex = ref.split('').reduce((sum, char) => (sum * 26) + char.charCodeAt(0) - 64, 0) - 1;
      const type = (cellXml.match(/\bt="([^"]+)"/) || [])[1] || '';
      const rawValue = decodeXmlText((cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1] || (cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      const value = type === 's' ? (sharedStrings[Number(rawValue)] || '') : rawValue;
      cells[columnIndex >= 0 ? columnIndex : cells.length] = value;
    }
    if (cells.some((cell) => String(cell || '').trim())) rows.push(cells.map((cell) => cell || ''));
  }
  return rows;
}

function parseXlsxRows(buffer) {
  const entries = readZipEntries(buffer);
  const entryByName = new Map(entries.map((entry) => [entry.name.replace(/^\/+/, ''), entry.data]));
  const sharedXml = entryByName.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const sharedStrings = (sharedXml.match(/<si\b[\s\S]*?<\/si>/g) || []).map((item) => decodeXmlText(
    (item.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
      .map((part) => (part.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '')
      .join('')
  ));
  const sheetEntry = entries.find((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name));
  if (!sheetEntry) throw new Error('No worksheet found in XLSX file');
  return parseSheetXml(sheetEntry.data.toString('utf8'), sharedStrings);
}

function parseOmrNumber(value) {
  const cleaned = String(value ?? '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function getOmrValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[normalizeOmrHeader(alias)];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function normalizeOmrRow(row, fallbackMaxMarks = null) {
  const obtainedMarks = parseOmrNumber(getOmrValue(row, ['Total Marks', 'Correct Marks Total', 'Total Marks Total', 'Obtained Marks', 'Marks Obtained']));
  const maxMarks = parseOmrNumber(getOmrValue(row, ['Max Marks', 'Maximum Marks', 'Total Maximum Marks', 'Out Of'])) ?? fallbackMaxMarks;
  const biologyMarks = parseOmrNumber(getOmrValue(row, ['Biology Marks', 'Biology']));
  return {
    rollNo: getOmrValue(row, ['Roll No', 'RollNumber', 'Roll Number', 'Roll']),
    studentName: getOmrValue(row, ['Student Name', 'Name']),
    barcode: getOmrValue(row, ['Barcode', 'Bar Code']),
    correctCount: parseOmrNumber(getOmrValue(row, ['Correct Total', 'Correct Count'])),
    wrongCount: parseOmrNumber(getOmrValue(row, ['Wrong Total', 'Wrong Count'])),
    unattemptedCount: parseOmrNumber(getOmrValue(row, ['Unattempted Total', 'Unattempted Count', 'Blank Total'])),
    obtainedMarks,
    maxMarks,
    percentage: maxMarks && obtainedMarks !== null ? Number(((obtainedMarks / maxMarks) * 100).toFixed(2)) : parseOmrNumber(getOmrValue(row, ['Percentage', 'Percent'])),
    physicsMarks: parseOmrNumber(getOmrValue(row, ['Physics Marks', 'Physics'])),
    chemistryMarks: parseOmrNumber(getOmrValue(row, ['Chemistry Marks', 'Chemistry'])),
    biologyMarks,
    botanyMarks: biologyMarks ?? parseOmrNumber(getOmrValue(row, ['Botany Marks', 'Botany'])),
    zoologyMarks: parseOmrNumber(getOmrValue(row, ['Zoology Marks', 'Zoology'])),
    rank: parseOmrNumber(getOmrValue(row, ['Rank', 'Student Rank'])),
    raw: row,
  };
}

function sanitizeOmrFileName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.+/g, '.').slice(0, 160);
}

function getOmrStoragePath(testId, rollNo, originalName) {
  const extension = path.extname(originalName || '').toLowerCase();
  const safeExtension = ['.pdf', '.jpg', '.jpeg', '.png'].includes(extension) ? extension : '.pdf';
  return path.join(__dirname, '..', 'uploads', 'omr', String(testId), `${sanitizeOmrFileName(rollNo)}${safeExtension}`);
}

function getExactSheetRollNo(fileName) {
  return path.parse(fileName || '').name.trim();
}

function toOmrTableRows(fileBuffer, fallbackMaxMarks) {
  const csvRows = parseCsvRows(fileBuffer);
  const headers = csvRows.shift() || [];
  if (!headers.length) throw new Error('CSV header row is missing');
  const normalizedHeaders = headers.map(normalizeOmrHeader);
  return csvRows.map((cells, index) => {
    const raw = {};
    normalizedHeaders.forEach((header, cellIndex) => {
      raw[header] = cells[cellIndex] || '';
    });
    return {
      rowNumber: index + 2,
      ...normalizeOmrRow(raw, fallbackMaxMarks),
    };
  });
}

function expandOmrSheetFiles(files) {
  const expanded = [];
  const errors = [];
  for (const file of files || []) {
    if (/\.zip$/i.test(file.originalname || '')) {
      try {
        readZipEntries(file.buffer)
          .filter((entry) => /\.(pdf|jpe?g|png)$/i.test(entry.name))
          .forEach((entry) => expanded.push({
            originalname: path.basename(entry.name),
            mimetype: path.extname(entry.name).toLowerCase() === '.pdf' ? 'application/pdf' : path.extname(entry.name).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
            buffer: entry.data,
          }));
      } catch (error) {
        errors.push(`${file.originalname}: ${error.message}`);
      }
      continue;
    }
    expanded.push(file);
  }
  return { files: expanded, errors };
}

async function ensureOmrSchema() {
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS omr_barcode VARCHAR(120)`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS percentage NUMERIC(6,2)`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS correct_count INTEGER`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS wrong_count INTEGER`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS unattempted_count INTEGER`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS physics_marks NUMERIC(10,2)`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS chemistry_marks NUMERIC(10,2)`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS biology_marks NUMERIC(10,2)`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS botany_marks NUMERIC(10,2)`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS zoology_marks NUMERIC(10,2)`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_barcode VARCHAR(120)`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_rank INTEGER`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_import_id INTEGER`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_scan_path TEXT`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_scan_original_name TEXT`);
  await run(`ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS omr_scan_uploaded_at TIMESTAMPTZ`);
  await run(`
    CREATE TABLE IF NOT EXISTS omr_imports (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      test_label VARCHAR(220) NOT NULL,
      original_file_name TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      matched_count INTEGER NOT NULL DEFAULT 0,
      unmatched_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      overwrite_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(40) NOT NULL DEFAULT 'committed',
      error_report JSONB NOT NULL DEFAULT '[]'::jsonb,
      imported_by INTEGER,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS omr_import_rows (
      id SERIAL PRIMARY KEY,
      import_id INTEGER NOT NULL REFERENCES omr_imports(id) ON DELETE CASCADE,
      coaching_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      student_id INTEGER,
      roll_no VARCHAR(80),
      barcode VARCHAR(120),
      test_paper_id INTEGER,
      obtained_marks NUMERIC(10,2),
      max_marks NUMERIC(10,2),
      percentage NUMERIC(6,2),
      correct_count INTEGER,
      wrong_count INTEGER,
      unattempted_count INTEGER,
      physics_marks NUMERIC(10,2),
      chemistry_marks NUMERIC(10,2),
      biology_marks NUMERIC(10,2),
      botany_marks NUMERIC(10,2),
      zoology_marks NUMERIC(10,2),
      rank INTEGER,
      row_status VARCHAR(40) NOT NULL,
      error_message TEXT,
      raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`ALTER TABLE omr_import_rows ADD COLUMN IF NOT EXISTS biology_marks NUMERIC(10,2)`);
  await run(`ALTER TABLE omr_import_rows ADD COLUMN IF NOT EXISTS rank INTEGER`);
  await run(`CREATE INDEX IF NOT EXISTS users_omr_barcode_branch_idx ON users (coaching_id, branch_id, omr_barcode)`);
  await run(`CREATE INDEX IF NOT EXISTS omr_imports_branch_imported_idx ON omr_imports (coaching_id, branch_id, imported_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS omr_import_rows_import_idx ON omr_import_rows (import_id)`);
  await run(`CREATE INDEX IF NOT EXISTS test_papers_omr_scan_branch_idx ON test_papers (coaching_id, branch_id, student_id, test_label)`);
}

const PORT = process.env.PORT || 3000;
const SINGLE_CLIENT_COACHING_SLUG = String(process.env.CLIENT_COACHING_SLUG || 'scc').trim().toLowerCase();
const SINGLE_CLIENT_NAME = 'SHIV CHHATRAPATI CLASSES';
const OWNER_SECTIONS = new Set(['overview', 'finance', 'staff', 'permissions']);
const ADMIN_SECTIONS = new Set(['overview', 'attendance', 'students', 'fees', 'papers', 'notes', 'whatsapp', 'notifications', 'settings']);
const ALLOWED_UPLOAD_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']);
const DEFAULT_UPLOAD_LIMIT_BYTES = isVercel ? 4 * 1024 * 1024 : 25 * 1024 * 1024;
const UPLOAD_FILE_SIZE_LIMIT_BYTES = Number(process.env.UPLOAD_FILE_SIZE_LIMIT_BYTES || DEFAULT_UPLOAD_LIMIT_BYTES);
const ANSWER_UPLOAD_WINDOW_HOURS = 24;
const RETENTION_BATCH_NAME = 'Retained Student Records';
const RETENTION_MAX_STUDENTS_PER_SOURCE_BATCH = 5;
const DEFAULT_THEME = {
  brand: '#1769aa',
  background: '#f3f6fb',
  surface: '#ffffff',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_FILE_SIZE_LIMIT_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed'));
  },
});

const OMR_UPLOAD_LIMIT_BYTES = Number(process.env.OMR_UPLOAD_LIMIT_BYTES || (isVercel ? 4 * 1024 * 1024 : 25 * 1024 * 1024));
const OMR_ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/jpg',
  'application/zip',
  'application/x-zip-compressed',
]);
const omrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: OMR_UPLOAD_LIMIT_BYTES, files: 200 },
  fileFilter: (req, file, cb) => {
    if (OMR_ALLOWED_MIME_TYPES.has(file.mimetype) || /\.(csv|xlsx|pdf|jpe?g|png|zip)$/i.test(file.originalname || '')) {
      cb(null, true);
      return;
    }
    cb(new Error('Only CSV, XLSX, PDF, JPG, PNG, or ZIP files are allowed for OMR import'));
  },
});
const omrImportUpload = omrUpload.fields([
  { name: 'omrCsv', maxCount: 1 },
  { name: 'answerSheets', maxCount: 200 },
]);

app.disable('x-powered-by');
if (isProduction) {
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    name: 'coaching.sid',
    secret: sessionSecret,
    store: new PostgresSessionStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,
      httpOnly: true,
      sameSite: 'lax',
      secure: sessionCookieSecure,
    },
  })
);
app.use((req, res, next) => runWithBranchContext({
  branchId: req.session?.user?.branchId || null,
  isSuperAdmin: !req.session?.user || Boolean(req.session.user.isOwner),
}, next));
app.use((req, res, next) => {
  const shouldProfile = req.path.startsWith('/admin') || req.path.startsWith('/papers/');

  if (!shouldProfile) {
    return next();
  }

  const trace = createPerfTrace({
    method: req.method,
    path: req.originalUrl || req.url,
    route: `${req.method} ${req.path}`,
  });
  const originalRender = res.render.bind(res);

  res.render = (view, locals, callback) => {
    const renderStartedAt = nowMs();
    return originalRender(view, locals, (error, html) => {
      recordPerfOperation('render', view, nowMs() - renderStartedAt, { view });
      if (typeof callback === 'function') {
        return callback(error, html);
      }
      if (error) {
        return next(error);
      }
      return res.send(html);
    });
  };

  res.on('finish', () => {
    logPerfTrace(trace, nowMs() - trace.startedAt);
  });

  return runWithPerfTrace(trace, next);
});
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use((req, res, next) => {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }

  const csrfToken = req.session?.csrfToken || '';
  res.locals.csrfToken = csrfToken;
  res.locals.appendCsrfToUrl = (value) => {
    const target = String(value || '');
    if (!csrfToken || !target) return target;
    const separator = target.includes('?') ? '&' : '?';
    return `${target}${separator}_csrf=${encodeURIComponent(csrfToken)}`;
  };
  next();
});
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/paper-files', express.static(getLocalPaperDir()));

app.get('/receipts/:feeId/:token/:fileName', async (req, res) => {
  try {
    const feeId = Number.parseInt(String(req.params.feeId || ''), 10);
    if (!Number.isInteger(feeId) || feeId <= 0) {
      return res.sendStatus(404);
    }

    const fee = await get(
      `SELECT id, receipt_number, receipt_storage_key, receipt_storage_type
       FROM fees
       WHERE id = ?
       LIMIT 1`,
      [feeId]
    );

    if (!fee?.receipt_storage_key || !fee?.receipt_number) {
      return res.sendStatus(404);
    }

    const tokenValid = verifyReceiptAccessToken({
      feeId: fee.id,
      receiptNumber: fee.receipt_number,
      storageKey: fee.receipt_storage_key,
      token: req.params.token,
    });
    if (!tokenValid) {
      return res.sendStatus(403);
    }

    const storedFile = await getStoredFileReadStream({
      storageType: fee.receipt_storage_type || 'local',
      storageKey: fee.receipt_storage_key,
    });
    const fileName = `${fee.receipt_number}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    if (storedFile.contentLength) {
      res.setHeader('Content-Length', String(storedFile.contentLength));
    }

    if (req.method === 'HEAD') {
      return res.end();
    }

    const stream = typeof storedFile.stream?.pipe === 'function'
      ? storedFile.stream
      : Readable.fromWeb(storedFile.stream);
    stream.on('error', (error) => {
      console.error('Receipt public stream failed', { feeId: fee.id, error: error.message });
      if (!res.headersSent) res.sendStatus(500);
      else res.destroy(error);
    });
    return stream.pipe(res);
  } catch (error) {
    console.error('Receipt public route failed', {
      feeId: req.params.feeId,
      error: error.message,
    });
    return res.sendStatus(404);
  }
});

function renderWithMessage(res, view, data = {}) {
  const flash = data.flash || null;
  return res.render(view, { ...data, flash });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function asyncAdminPapersRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    console.error('[ADMIN PAPERS ROUTE ERROR]', error);
    if (req.session) {
      req.session.flash = {
        type: 'error',
        text: error.message || 'Something went wrong while processing the upload.',
      };
      return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
    }
    return next(error);
  });
}

function handleOmrImportUpload(req, res, next) {
  console.log('[OMR IMPORT] multer entered', {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    contentType: req.headers['content-type'] || '',
    contentLength: req.headers['content-length'] || '',
    csrfQuery: req.query?._csrf || '',
  });

  omrImportUpload(req, res, (error) => {
    if (error) {
      console.error('[OMR IMPORT] multer failed', {
        message: error.message,
        stack: error.stack,
      });
      if (req.session) {
        req.session.flash = {
          type: 'error',
          text: error.message || 'OMR upload failed before import started.',
        };
      }
      return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
    }

    console.log('[OMR IMPORT] multer completed', {
      bodyKeys: Object.keys(req.body || {}),
      fileFields: Object.keys(req.files || {}),
      csrfBody: req.body?._csrf || '',
      csrfQuery: req.query?._csrf || '',
    });
    return next();
  });
}

function buildOtpStatus(sessionOtp = null) {
  if (!sessionOtp?.expiresAt) return null;
  const expiresAt = new Date(sessionOtp.expiresAt);
  const remainingMs = expiresAt.getTime() - Date.now();
  return {
    ...sessionOtp,
    expired: remainingMs <= 0,
    remainingSeconds: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
  };
}

function timingSafeEqualString(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function issueCaptcha(req, scope) {
  const left = crypto.randomInt(1, 10);
  const right = crypto.randomInt(1, 10);
  const answer = String(left + right);
  const challenge = {
    prompt: `${left} + ${right}`,
    answer,
    expiresAt: Date.now() + CAPTCHA_TTL_MS,
  };

  if (!req.session.captchaChallenges) {
    req.session.captchaChallenges = {};
  }

  req.session.captchaChallenges[scope] = challenge;
  return { prompt: challenge.prompt };
}

function getCaptchaChallenge(req, scope) {
  const existing = req.session?.captchaChallenges?.[scope];
  if (existing && existing.expiresAt > Date.now()) {
    return { prompt: existing.prompt };
  }
  return issueCaptcha(req, scope);
}

function verifyCaptcha(req, scope, answer) {
  const expected = req.session?.captchaChallenges?.[scope];
  delete req.session?.captchaChallenges?.[scope];
  if (!expected || expected.expiresAt <= Date.now()) return false;
  return timingSafeEqualString(String(answer || '').trim(), String(expected.answer));
}

function ensureCsrf(req) {
  const expected = req.session?.csrfToken || '';
  const bodyToken = String(req.body?._csrf || '').trim();
  const queryToken = String(req.query?._csrf || '').trim();
  const headerToken = String(req.get?.('x-csrf-token') || req.headers?.['x-csrf-token'] || '').trim();
  const received = bodyToken || queryToken || headerToken;
  const comparisonSucceeds = Boolean(received && expected && timingSafeEqualString(received, expected));
  console.log('[CSRF CHECK]', {
    originalUrl: req.originalUrl,
    reqQueryCsrf: req.query?._csrf || '',
    reqBodyCsrf: req.body?._csrf || '',
    reqHeaderCsrf: headerToken,
    reqSessionCsrfToken: expected,
    csrfComparisonSucceeds: comparisonSucceeds,
  });
  return comparisonSucceeds;
}

function normalizeRequestPath(value) {
  const pathOnly = String(value || '').split('?')[0].trim();
  if (!pathOnly) return '/';
  return pathOnly.length > 1 ? pathOnly.replace(/\/+$/, '') : pathOnly;
}

function getRequestPathCandidates(req) {
  return [
    req.path,
    req.originalUrl,
    req.url,
  ].map(normalizeRequestPath);
}

function isTwoFactorAuthPostPath(req) {
  return getRequestPathCandidates(req).some((requestPath) => TWO_FACTOR_AUTH_POST_PATHS.has(requestPath));
}

function isLoginPostPath(req) {
  return getRequestPathCandidates(req).some((requestPath) => requestPath === '/login');
}

function isLogoutPostPath(req) {
  return getRequestPathCandidates(req).some((requestPath) => requestPath === '/logout');
}

function isOmrImportResultsPostPath(req) {
  return getRequestPathCandidates(req).some((requestPath) => requestPath === '/admin/omr/import-results');
}

function hasValidRequestOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  const referer = String(req.headers.referer || '').trim();
  const host = String(req.headers.host || '').trim();

  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch (error) {
      return false;
    }
  }

  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch (error) {
      return false;
    }
  }

  return true;
}

function getSessionIdFingerprint(req) {
  const sessionId = String(req.sessionID || '');
  if (!sessionId) return null;
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function logTwoFactorSession(req, phase) {
  const receivedCsrf = String(req.body?._csrf || req.query?._csrf || '').trim();
  console.log('[2FA SESSION]', phase, {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    url: req.url,
    sessionId: getSessionIdFingerprint(req),
    hasCookie: Boolean(req.headers.cookie),
    hasSession: Boolean(req.session),
    hasPendingLogin: Boolean(req.session?.pendingLogin?.userId),
    hasLoginOtp: Boolean(req.session?.loginOtp?.code),
    csrfTokenPresent: Boolean(req.session?.csrfToken),
    csrfSubmitted: Boolean(receivedCsrf),
    csrfMatches: Boolean(req.session?.csrfToken && receivedCsrf && timingSafeEqualString(receivedCsrf, req.session.csrfToken)),
  });
}

function getClientAddress(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 120);
}

function enforceRateLimit(req, scope, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${getClientAddress(req)}`;
  const entry = requestAttemptStore.get(key);

  if (!entry || entry.resetAt <= now) {
    requestAttemptStore.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  entry.count += 1;
  if (entry.count > limit) {
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  return null;
}

function validateAdminPasswordStrength(password) {
  if (password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'Password must include at least one letter and one number';
  }
  return null;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function signInUser(req, user, coaching = null) {
  await regenerateSession(req);
  req.session.user = buildSessionUser(user, coaching);
}

function buildRoleAwareLoginUrl(sessionUser) {
  return '/login';
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
}

function buildWhatsAppSettingsView(settings = {}) {
  settings = settings || {};
  return {
    accessTokenSaved: Boolean(settings.accessToken),
    phoneNumberId: settings.phoneNumberId || '',
    businessAccountId: settings.businessAccountId || '',
    verifyTokenSaved: Boolean(settings.verifyToken),
    hasRequiredSendConfig: Boolean(settings.accessToken && settings.phoneNumberId),
    attendanceAlertsEnabled: settings.attendanceAlertsEnabled !== false,
    feeAlertsEnabled: settings.feeAlertsEnabled !== false,
    resultAlertsEnabled: settings.resultAlertsEnabled !== false,
    testPaperAlertsEnabled: settings.testPaperAlertsEnabled !== false,
    noticeAlertsEnabled: settings.noticeAlertsEnabled !== false,
  };
}

function buildParentPortalMenuMessage() {
  return [
    '🏫 SHIV CHHATRAPATI CLASSES',
    '',
    'Welcome to Parent Portal',
    '',
    'Choose an option:',
    '',
    '1️⃣ FEES',
    '2️⃣ ATTENDANCE',
    '3️⃣ RESULTS',
    '4️⃣ PERFORMANCE',
    '5️⃣ STUDENT INFO',
    '',
    'Reply with the option name.',
  ].join('\n');
}

function buildFallbackParentPortalMenuMessage() {
  return [
    '🏫 SHIV CHHATRAPATI CLASSES',
    '',
    '1️⃣ FEES',
    '2️⃣ ATTENDANCE',
    '3️⃣ RESULTS',
    '4️⃣ PERFORMANCE',
    '5️⃣ STUDENT INFO',
  ].join('\n');
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

function formatWhatsAppPercent(value) {
  const percent = Number(value || 0);
  if (!Number.isFinite(percent)) return '0';
  return percent.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

async function sendImmediateParentPortalMenu({ phoneNumberId, to }) {
  const settings = {
    accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    phoneNumberId,
  };

  try {
    const result = await sendTextMessage({
      coachingId: null,
      to,
      message: buildParentPortalMenuMessage(),
      settings,
    });
    if (result?.failed) {
      throw new Error(result.error || 'Menu send failed');
    }
    console.log('Menu sent');
  } catch (error) {
    console.error('WhatsApp menu send failed', error);
    try {
      const coaching = await getCoachingByWhatsAppPhoneNumberId(phoneNumberId);
      if (coaching?.coaching_id) {
        const dbResult = await sendTextMessage({
          coachingId: coaching.coaching_id,
          to,
          message: buildParentPortalMenuMessage(),
        });
        if (!dbResult?.failed) {
          console.log('Menu sent');
          return;
        }
      }

      const fallbackResult = await sendTextMessage({
        coachingId: null,
        to,
        message: buildFallbackParentPortalMenuMessage(),
        settings,
      });
      if (fallbackResult?.failed) {
        throw new Error(fallbackResult.error || 'Fallback menu send failed');
      }
      console.log('Menu sent');
    } catch (fallbackError) {
      console.error('WhatsApp fallback menu send failed', fallbackError);
    }
  }
}

function buildAbsenceMessage({ student, attendanceDate, coaching }) {
  return [
    'Dear Parent,',
    '',
    `Your child ${student.name || student.roll_no} was absent today.`,
    '',
    `Date: ${attendanceDate}`,
    '',
    'Regards,',
    coaching?.name || 'Coaching Institute',
  ].join('\n');
}

async function notifyAttendanceAbsence({ req, coachingId, student, attendanceDate, coaching }) {
  try {
    const message = [
      `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
      '',
      '❌ Attendance Alert',
      '',
      `Student: ${student.name || student.roll_no}`,
      `Date: ${attendanceDate}`,
      '',
      'Your child was absent today.',
    ];
    return await sendWhatsAppNotification({
      studentId: student.id,
      phone: student.parent_whatsapp_number || student.guardian_phone,
      type: 'attendance_absent',
      message: compactWhatsAppMessage(message),
      eventKey: `attendance_absent:${student.id}:${attendanceDate}`,
    });
  } catch (error) {
    console.error('WhatsApp absence notification failed', {
      studentId: student.id,
      rollNo: student.roll_no,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }
}

async function getPaperDocumentUrl(req, paperId, studentId) {
  const paper = await get(
    `SELECT tp.id, tp.original_name, tp.stored_name, tp.storage_type, tp.storage_key, tp.public_url, tp.content_type,
            tp.marks_obtained, tp.max_marks, tp.test_label, tp.coaching_id,
            u.id AS student_id, u.roll_no, u.name, u.branch_id, u.whatsapp_number, u.parent_whatsapp_number,
            u.contact_phone, u.guardian_phone
     FROM test_papers tp
     LEFT JOIN users u ON u.id = tp.student_id
     WHERE tp.id = ? AND tp.student_id = ?
       AND tp.storage_type = 's3'
       AND tp.public_url IS NOT NULL
       AND tp.public_url <> ''
     LIMIT 1`,
    [paperId, studentId]
  );
  if (!paper) return null;

  return {
    fileUrl: paper.public_url,
    fileName: paper.original_name || 'paper.pdf',
    paper,
    student: {
      id: paper.student_id,
      roll_no: paper.roll_no,
      name: paper.name,
      branch_id: paper.branch_id,
      whatsapp_number: paper.whatsapp_number,
      parent_whatsapp_number: paper.parent_whatsapp_number,
      contact_phone: paper.contact_phone,
      guardian_phone: paper.guardian_phone,
    },
  };
}


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

function buildPaperTemplateComponents({ recipientName, student, paper, paperUrl }) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: recipientName || student.name || student.roll_no || 'Parent' },
      { type: 'text', text: student.name || student.roll_no || 'Student' },
      { type: 'text', text: paper.test_label || paper.original_name || 'Test Paper' },
      { type: 'text', text: String(paper.marks_obtained ?? '-') },
      { type: 'text', text: String(paper.max_marks ?? '-') },
      { type: 'text', text: paperUrl },
    ],
  }];
}

async function sendPaperTemplateFallback({ coachingId, branchId, student, recipient, document, paperId }) {
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

  const result = await sendTemplateMessage({
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

async function notifyPaperEvent({ req, coaching, student, paperId, type }) {
  try {
    console.log('[WHATSAPP PAPER] upload hook start', {
      studentId: student.id,
      paperId,
      type,
    });
    console.log('[WHATSAPP PAPER] paper id', { paperId });
    const isResult = type === 'test_result_published';
    const document = await getPaperDocumentUrl(req, paperId, student.id);
    if (!document?.paper) {
      console.log('[WHATSAPP PAPER] skipped: real S3 paper not found', { studentId: student.id, paperId, type });
      return { ok: false, skipped: true, reason: 'Real S3 paper not found' };
    }

    const paperStudent = document.student || student;
    const studentPhone = paperStudent.whatsapp_number || paperStudent.contact_phone;
    const parentPhone = paperStudent.parent_whatsapp_number || paperStudent.guardian_phone;
    console.log(`[WHATSAPP PAPER] student number ${studentPhone ? 'found' : 'missing'}`, {
      studentId: paperStudent.id,
      paperId,
    });
    console.log(`[WHATSAPP PAPER] parent number ${parentPhone ? 'found' : 'missing'}`, {
      studentId: paperStudent.id,
      paperId,
    });
    const subject = document.paper?.test_label || document.paper?.original_name || 'Result';
    const resultPercentage = isResult && Number(document.paper?.max_marks) > 0
      ? formatWhatsAppPercent((Number(document.paper?.marks_obtained || 0) / Number(document.paper.max_marks)) * 100)
      : null;
    const caption = isResult
      ? [
        `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
        '',
        '📚 New Result Available',
        '',
        `Student: ${student.name || student.roll_no}`,
        `Test: ${subject}`,
        `Marks: ${document.paper?.marks_obtained ?? '-'}/${document.paper?.max_marks ?? '-'}`,
        `Percentage: ${resultPercentage || '-'}%`,
        '',
        'View full result in Parent Portal.',
      ]
      : [
        `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
        '📚 New Test Paper Assigned',
        `Student: ${student.name || student.roll_no}`,
        'Paper PDF attached.',
      ];
    const compactCaption = compactWhatsAppMessage(caption);

    const recipients = [
      { key: 'student', phone: studentPhone },
      { key: 'parent', phone: parentPhone },
    ].filter((recipient, index, recipientsList) => (
      recipient.phone && recipientsList.findIndex((item) => item.phone === recipient.phone) === index
    ));

    for (const recipient of recipients) {
      const coachingId = document.paper.coaching_id || student.coaching_id || req.session?.user?.coachingId || null;
      const branchId = paperStudent.branch_id || student.branch_id || getCurrentBranchId(req);
      try {
        console.log('[PAPER WHATSAPP NORMAL START]', {
          recipient: recipient.key,
          studentId: paperStudent.id,
          paperId,
        });
        const result = await sendDocumentMessage({
          coachingId,
          branchId,
          studentId: paperStudent.id,
          to: recipient.phone,
          documentUrl: document.fileUrl,
          filename: document.fileName,
          caption: compactCaption,
        });
        if (result?.failed || result?.ok === false) {
          if (isReEngagementError(result)) {
            console.error('[PAPER WHATSAPP 131047]', {
              recipient: recipient.key,
              studentId: paperStudent.id,
              paperId,
              error: result.error || 'Re-engagement message',
            });
            await sendPaperTemplateFallback({
              coachingId,
              branchId,
              student: paperStudent,
              recipient,
              document,
              paperId,
            });
            continue;
          }
          console.error('[WHATSAPP PAPER] failed', {
            recipient: recipient.key,
            studentId: paperStudent.id,
            paperId,
            error: result.error || 'WhatsApp document send failed',
          });
          continue;
        }
        console.log('[PAPER WHATSAPP NORMAL SENT]', {
          recipient: recipient.key,
          studentId: paperStudent.id,
          paperId,
          metaMessageId: result?.metaMessageId || null,
        });
      } catch (error) {
        if (isReEngagementError(error)) {
          console.error('[PAPER WHATSAPP 131047]', {
            recipient: recipient.key,
            studentId: paperStudent.id,
            paperId,
            error: error.message,
          });
          await sendPaperTemplateFallback({
            coachingId,
            branchId,
            student: paperStudent,
            recipient,
            document,
            paperId,
          });
        } else {
          console.error('[WHATSAPP PAPER] failed', {
            recipient: recipient.key,
            studentId: paperStudent.id,
            paperId,
            error: error.message,
          });
        }
      }

      if (isResult) {
        try {
          await sendPerformanceGraph(paperStudent, recipient.phone, coaching);
        } catch (error) {
          console.error('[WHATSAPP PAPER] failed', {
            recipient: recipient.key,
            studentId: paperStudent.id,
            paperId,
            error: error.message,
          });
        }
      }
    }

    return { ok: true, sent: recipients.length };
  } catch (error) {
    console.error('WhatsApp paper/result notification failed', {
      studentId: student.id,
      rollNo: student.roll_no,
      paperId,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }
}

function getOmrScanPublicUrl(req, scanPath) {
  if (!scanPath) return null;
  const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
  const resolvedPath = path.resolve(scanPath);
  if (!resolvedPath.startsWith(`${uploadsRoot}${path.sep}`)) return null;
  const relativePath = path.relative(uploadsRoot, resolvedPath)
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${getRequestBaseUrl(req)}/uploads/${relativePath}`;
}

function buildOmrResultMessage({ coaching, student, paper }) {
  const percentage = paper.percentage !== null && paper.percentage !== undefined
    ? formatWhatsAppPercent(Number(paper.percentage))
    : Number(paper.max_marks) > 0
      ? formatWhatsAppPercent((Number(paper.marks_obtained || 0) / Number(paper.max_marks)) * 100)
      : null;
  return compactWhatsAppMessage([
    `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
    '',
    '📚 OMR Result Available',
    '',
    `Student: ${student.name || student.roll_no || '-'}`,
    `Test: ${paper.test_label || '-'}`,
    `Marks: ${paper.marks_obtained ?? '-'}/${paper.max_marks ?? '-'}`,
    `Percentage: ${percentage || '-'}%`,
  ]);
}

async function notifyOmrImportResults({ req, coaching, coachingId, branchId, testLabel, importId, importedPapers }) {
  const paperIds = [...new Set((importedPapers || []).map((item) => Number(item.paperId)).filter(Number.isInteger))];
  console.log('[WHATSAPP OMR] start', { testLabel, importId });
  console.log('[WHATSAPP OMR] imported rows count', { count: paperIds.length });
  if (!paperIds.length) return;

  try {
    const rows = await all(
      `SELECT tp.id AS paper_id, tp.student_id, tp.test_label, tp.marks_obtained, tp.max_marks, tp.percentage,
              tp.omr_scan_path, tp.omr_scan_original_name,
              u.id, u.name, u.role, u.whatsapp_number, u.parent_whatsapp_number,
              u.contact_phone, u.guardian_phone, u.branch_id, u.roll_no
       FROM test_papers tp
       LEFT JOIN users u ON u.id = tp.student_id
       WHERE tp.coaching_id = ? AND tp.branch_id = ?
         AND tp.id = ANY(?::int[])
         AND u.role = 'student'`,
      [coachingId, branchId, paperIds]
    );

    for (const row of rows) {
      const student = {
        id: row.student_id,
        name: row.name,
        roll_no: row.roll_no,
        branch_id: row.branch_id,
        whatsapp_number: row.whatsapp_number,
        parent_whatsapp_number: row.parent_whatsapp_number,
        contact_phone: row.contact_phone,
        guardian_phone: row.guardian_phone,
      };
      const paper = {
        id: row.paper_id,
        test_label: row.test_label || testLabel,
        marks_obtained: row.marks_obtained,
        max_marks: row.max_marks,
        percentage: row.percentage,
        omr_scan_path: row.omr_scan_path,
        omr_scan_original_name: row.omr_scan_original_name,
      };
      const studentPhone = student.whatsapp_number || student.contact_phone;
      const parentPhone = student.parent_whatsapp_number || student.guardian_phone;
      console.log(`[WHATSAPP OMR] student number ${studentPhone ? 'found' : 'missing'}`, {
        studentId: student.id,
        paperId: paper.id,
      });
      console.log(`[WHATSAPP OMR] parent number ${parentPhone ? 'found' : 'missing'}`, {
        studentId: student.id,
        paperId: paper.id,
      });

      const documentUrl = getOmrScanPublicUrl(req, paper.omr_scan_path);
      const message = buildOmrResultMessage({ coaching, student, paper });
      const recipients = [
        { key: 'student', phone: studentPhone },
        { key: 'parent', phone: parentPhone },
      ].filter((recipient, index, recipientsList) => (
        recipient.phone && recipientsList.findIndex((item) => item.phone === recipient.phone) === index
      ));

      for (const recipient of recipients) {
        try {
          console.log(`[WHATSAPP OMR] sending ${documentUrl ? 'document' : 'text'}`, {
            recipient: recipient.key,
            studentId: student.id,
            paperId: paper.id,
          });
          let result;
          if (documentUrl) {
            result = await sendDocumentNotification(
              student.id,
              recipient.phone,
              documentUrl,
              paper.omr_scan_original_name || `${student.roll_no || student.id}-${paper.test_label || 'omr'}.pdf`,
              message,
              { type: 'omr_result', eventKey: `omr_result:document:${recipient.key}:${student.id}:${paper.id}` }
            );
          } else {
            result = await sendWhatsAppNotification({
              studentId: student.id,
              phone: recipient.phone,
              type: 'omr_result',
              message,
              eventKey: `omr_result:text:${recipient.key}:${student.id}:${paper.id}`,
            });
          }
          if (result?.failed || result?.ok === false) {
            console.error('[WHATSAPP OMR] failed', {
              recipient: recipient.key,
              studentId: student.id,
              paperId: paper.id,
              error: result.error || result.reason || 'WhatsApp notification failed',
            });
            continue;
          }
          console.log(`[WHATSAPP OMR] sent to ${recipient.key}`, {
            studentId: student.id,
            paperId: paper.id,
          });
        } catch (error) {
          console.error('[WHATSAPP OMR] failed', {
            recipient: recipient.key,
            studentId: student.id,
            paperId: paper.id,
            error: error.message,
          });
        }
      }
    }
  } catch (error) {
    console.error('[WHATSAPP OMR] failed', { error: error.message });
  }
}

async function getFeeReminderContext(coachingId, feeId) {
  const branchId = getBranchContext().branchId;
  const row = await get(
    `SELECT
       f.id AS fee_id, f.amount, f.due_date, f.payment_date, f.status, f.notes,
       u.id AS student_id, u.roll_no, u.name, u.branch_id, u.contact_phone, u.guardian_phone, u.whatsapp_number, u.parent_whatsapp_number,
       cc.name AS coaching_name
     FROM fees f
     JOIN users u ON u.id = f.student_id AND u.coaching_id = f.coaching_id AND u.branch_id = f.branch_id
     JOIN coaching_classes cc ON cc.id = f.coaching_id
     WHERE f.id = ? AND f.coaching_id = ? AND f.branch_id = ?
     LIMIT 1`,
    [feeId, coachingId, branchId]
  );

  if (!row) return null;
  return {
    fee: {
      id: row.fee_id,
      amount: row.amount,
      due_date: row.due_date,
      payment_date: row.payment_date,
      status: row.status,
      notes: row.notes,
    },
    student: {
      id: row.student_id,
      roll_no: row.roll_no,
      name: row.name,
      contact_phone: row.contact_phone,
      guardian_phone: row.guardian_phone,
      whatsapp_number: row.whatsapp_number,
      parent_whatsapp_number: row.parent_whatsapp_number,
    },
    coaching: { name: row.coaching_name },
  };
}

async function sendFeeReminderByFeeId({ coachingId, branchId, feeId }) {
  return runWithBranchContext({ branchId, isSuperAdmin: false }, async () => {
    const context = await getFeeReminderContext(coachingId, feeId);
    if (!context) return { ok: false, reason: 'Fee record not found' };
    if (!context.fee.due_date) return { ok: false, skipped: true, reason: 'Next due date is not set.' };

    if (String(context.fee.status || '').toLowerCase() === 'overdue') {
      return sendOverdueReminder({ coachingId, ...context });
    }

    return sendDueFeeReminder({ coachingId, ...context });
  });
}

async function saveAdminFeeRecord({
  coachingId,
  branchId,
  studentId,
  amount,
  dueDate = null,
  paymentDate = null,
  status,
  notes = '',
  paymentMode = '',
  addedBy,
}) {
  console.log(`[FEE SAVE START] studentId=${studentId} branchId=${branchId} coachingId=${coachingId} amount=${amount} status=${status}`);
  try {
    const feeResult = await run(
      `INSERT INTO fees (coaching_id, branch_id, student_id, amount, due_date, payment_date, status, notes, payment_mode, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        coachingId,
        branchId,
        studentId,
        amount,
        dueDate || null,
        paymentDate || null,
        status,
        notes || null,
        paymentMode || null,
        addedBy,
      ]
    );
    console.log(`[FEE SAVE OK] feeId=${feeResult.lastID}`);
    console.log(`[FEE ENTRY CREATED] feeId=${feeResult.lastID} createdBy=${addedBy} branchId=${branchId}`);
    return feeResult.lastID;
  } catch (error) {
    console.error(`[FEE SAVE ERROR] error=${error.message}`);
    throw error;
  }
}

function logFeeWhatsAppFailure({ feeId, phone, errorCode = null, message = '' }) {
  console.error(`[FEE WHATSAPP FAILED] feeId=${feeId} errorCode=${errorCode || ''} message=${message || ''}`);
  if (String(errorCode || '') === '131047' || String(message || '').includes('131047')) {
    console.error(`[WHATSAPP TEMPLATE REQUIRED] feeId=${feeId} phone=${phone || ''}`);
  }
}

function queueFeeWhatsAppAfterSave({ coachingId, branchId, feeId, student }) {
  const phone = student.parent_whatsapp_number || student.guardian_phone;
  console.log(`[FEE WHATSAPP START] feeId=${feeId} studentId=${student.id} phone=${phone || ''}`);
  if (!phone) {
    console.error(`[FEE WHATSAPP FAILED] feeId=${feeId} errorCode= message=parent phone missing`);
    return;
  }

  setImmediate(() => {
    sendFeeReminderByFeeId({ coachingId, branchId, feeId })
      .then((result) => {
        if (result?.failed || result?.ok === false) {
          logFeeWhatsAppFailure({
            feeId,
            phone,
            errorCode: result.errorCode || result.code || null,
            message: result.error || result.reason || 'Fee WhatsApp notification failed',
          });
        }
      })
      .catch((error) => {
        logFeeWhatsAppFailure({
          feeId,
          phone,
          errorCode: error.code || error.errorCode || null,
          message: error.message,
        });
      });
  });
}

async function sendScheduledFeeReminders({ coachingId = null, branchId = null } = {}) {
  const params = [];
  let sql = `
    SELECT
      f.id AS fee_id,
      f.amount,
      f.due_date,
      f.status,
      f.branch_id,
      CASE
        WHEN CAST(f.due_date AS DATE) = CURRENT_DATE THEN 'due_date'
        ELSE 'three_days_before'
      END AS reminder_stage,
      u.id AS student_id,
      u.roll_no,
      u.name,
      u.guardian_phone,
      u.parent_whatsapp_number,
      cc.id AS coaching_id,
      cc.name AS coaching_name
    FROM fees f
    JOIN users u ON u.id = f.student_id AND u.branch_id = f.branch_id
    JOIN coaching_classes cc ON cc.id = f.coaching_id
    WHERE COALESCE(u.parent_whatsapp_number, u.guardian_phone) IS NOT NULL
      AND TRIM(COALESCE(u.parent_whatsapp_number, u.guardian_phone, '')) <> ''
      AND f.due_date IS NOT NULL
      AND CAST(f.due_date AS DATE) IN (CURRENT_DATE, CURRENT_DATE + INTERVAL '3 days')
  `;

  if (coachingId) {
    params.push(coachingId);
    sql += ` AND f.coaching_id = $${params.length}`;
  }
  if (branchId) {
    params.push(branchId);
    sql += ` AND f.branch_id = $${params.length}`;
  }

  sql += ` ORDER BY f.due_date ASC LIMIT 200`;

  const rows = await all(sql, params);
  const summary = { sent: 0, failed: 0, skipped: 0 };

  for (const row of rows) {
    const dueDate = String(row.due_date).slice(0, 10);
    const eventKey = `fee_reminder:${row.reminder_stage}:${row.branch_id}:${row.fee_id}:${dueDate}`;

    const context = {
      coachingId: row.coaching_id,
      student: {
        id: row.student_id,
        branch_id: row.branch_id,
        roll_no: row.roll_no,
        name: row.name,
        guardian_phone: row.guardian_phone,
        parent_whatsapp_number: row.parent_whatsapp_number,
      },
      fee: {
        id: row.fee_id,
        amount: row.amount,
        due_date: row.due_date,
        status: row.status,
      },
      coaching: { name: row.coaching_name },
    };

    try {
      const result = await runWithBranchContext(
        { branchId: row.branch_id, isSuperAdmin: false },
        () => sendDueFeeReminder({ ...context, eventKey })
      );
      if (result?.skipped) {
        summary.skipped += 1;
      } else {
        summary.sent += 1;
      }
    } catch (error) {
      console.error('Scheduled WhatsApp fee reminder failed', {
        feeId: row.fee_id,
        studentId: row.student_id,
        error: error.message,
      });
      summary.failed += 1;
    }
  }

  return summary;
}

function getAdminStudentPreviewSession(req) {
  const preview = req.session?.adminStudentPreview;
  const sessionUser = req.session?.user;

  if (
    !preview
    || preview.mode !== 'student-preview'
    || sessionUser?.role !== 'admin'
    || preview.adminUserId !== sessionUser.id
    || preview.coachingId !== sessionUser.coachingId
  ) {
    return null;
  }

  return preview;
}

function startAdminStudentPreview(req, studentId, returnTo = '/admin/dashboard?section=students') {
  if (!req.session?.user) return;
  req.session.adminStudentPreview = {
    mode: 'student-preview',
    adminUserId: req.session.user.id,
    coachingId: req.session.user.coachingId,
    studentId,
    returnTo,
    startedAt: new Date().toISOString(),
  };
}

function clearAdminStudentPreview(req) {
  if (!req.session) return;
  delete req.session.adminStudentPreview;
}

async function writeAuditLog({
  actorId,
  actorRole,
  coachingId = null,
  action,
  targetType = null,
  targetId = null,
  details = null,
  req = null,
}) {
  try {
    await run(
      `INSERT INTO audit_logs (
        coaching_id, actor_user_id, actor_role, action, target_type, target_id, details_json, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        coachingId,
        actorId,
        actorRole,
        action,
        targetType,
        targetId,
        details ? JSON.stringify(details) : null,
        req ? getClientAddress(req) : null,
        req ? String(req.headers['user-agent'] || '').slice(0, 500) : null,
      ]
    );
  } catch (error) {
    console.error('Failed to write audit log', error);
  }
}

async function auditActor(req, action, options = {}) {
  if (!req.session?.user) return;
  await writeAuditLog({
    actorId: req.session.user.id,
    actorRole: req.session.user.role,
    coachingId: options.coachingId ?? req.session.user.coachingId ?? null,
    action,
    targetType: options.targetType ?? null,
    targetId: options.targetId ?? null,
    details: options.details ?? null,
    req,
  });
}

function buildOtpPurposeLabel(purpose) {
  if (purpose === 'login-2fa') return 'sign in verification';
  if (purpose === 'forgot-password') return 'password reset';
  return 'security verification';
}

function getTwoFactorIdentity(user, coaching = null) {
  if (user?.is_owner) {
    return {
      adminName: user.name || 'Owner',
      className: 'Owner Control Room',
      email: user.email || String(process.env.OWNER_2FA_EMAIL || '').trim().toLowerCase() || null,
      contactPhone: user.contact_phone || String(process.env.OWNER_2FA_PHONE || '').trim() || null,
    };
  }

  return {
    adminName: user?.name || 'Admin',
    className: coaching?.name || 'Coaching Portal',
    email: user?.email || null,
    contactPhone: user?.contact_phone || null,
  };
}

const MERI_BRANCH_CODE = 'meri';
const MERI_BRANCH_NAME = 'SCC - Meri Branch';
const OWNER_PERMISSION_KEYS = [
  'dashboard.view', 'students.view', 'students.create', 'students.edit', 'students.delete',
  'attendance.view', 'attendance.manage', 'fees.entry', 'fees.view_own_entries', 'fees.view_all_entries',
  'fees.view_totals', 'fees.edit', 'fees.delete', 'expenses.view', 'expenses.manage', 'papers.view',
  'papers.upload', 'notes.view', 'notes.manage', 'whatsapp.view', 'whatsapp.send', 'notifications.view',
  'settings.view', 'settings.manage',
];
const DEFAULT_STAFF_PERMISSIONS = new Set(['dashboard.view', 'students.view', 'fees.entry', 'fees.view_own_entries']);

async function getMeriBranchRecord() {
  return get(
    `SELECT b.id, b.code, b.name, b.coaching_id, cc.name AS coaching_name
     FROM branches b
     JOIN coaching_classes cc ON cc.id = b.coaching_id
     WHERE b.code = ? AND b.name = ? AND b.is_active = TRUE
     LIMIT 1`,
    [MERI_BRANCH_CODE, MERI_BRANCH_NAME]
  );
}

async function ensureAdminPermissionSchema() {
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`);
  await run(`
    CREATE TABLE IF NOT EXISTS admin_permissions (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      admin_user_id INTEGER NOT NULL,
      permission_key VARCHAR(120) NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT FALSE,
      granted_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (coaching_id, branch_id, admin_user_id, permission_key)
    )
  `);
}

async function getAdminPermissions(coachingId, branchId, adminUserId) {
  const rows = await all(
    `SELECT permission_key, is_allowed
     FROM admin_permissions
     WHERE coaching_id = ? AND branch_id = ? AND admin_user_id = ?`,
    [coachingId, branchId, adminUserId]
  );
  const explicit = new Map(rows.map((row) => [row.permission_key, row.is_allowed === true || row.is_allowed === 1]));
  const allowed = new Set();
  OWNER_PERMISSION_KEYS.forEach((key) => {
    if (explicit.has(key) ? explicit.get(key) : DEFAULT_STAFF_PERMISSIONS.has(key)) allowed.add(key);
  });
  return allowed;
}

async function userHasPermission(req, permissionKey) {
  if (!req.session?.user || req.session.user.role !== 'admin' || req.session.user.isOwner) return false;
  const allowed = await getAdminPermissions(req.session.user.coachingId, req.session.user.branchId, req.session.user.id);
  const result = allowed.has(permissionKey);
  console.log(`[PERMISSION CHECK] userId=${req.session.user.id} permission=${permissionKey} allowed=${result}`);
  return result;
}

function accessDenied(res) {
  return res.status(403).send('Access Denied');
}

function requirePermission(permissionKey) {
  return async (req, res, next) => {
    if (await userHasPermission(req, permissionKey)) return next();
    return accessDenied(res);
  };
}

async function requireBranchOwner(req, res, next) {
  if (!req.session.user) return res.redirect('/owner/login');
  const meriBranch = await getMeriBranchRecord();
  const allowed = Boolean(
    meriBranch
    && req.session.user.isOwner
    && Number(req.session.user.coachingId) === Number(meriBranch.coaching_id)
    && Number(req.session.user.branchId) === Number(meriBranch.id)
  );
  if (!allowed) {
    console.warn(`[OWNER ACCESS DENIED] userId=${req.session.user.id || ''} branchId=${req.session.user.branchId || ''}`);
    return res.status(403).send('Forbidden');
  }
  req.ownerBranch = meriBranch;
  console.log(`[OWNER ACCESS] ownerId=${req.session.user.id} branchId=${meriBranch.id}`);
  return next();
}

async function createPendingTwoFactorLogin(req, user, coaching = null) {
  const identity = getTwoFactorIdentity(user, coaching);
  req.session.pendingLogin = {
    userId: user.id,
    coachingId: user.coaching_id || null,
    branchId: user.branch_id || null,
    isOwner: Boolean(user.is_owner),
    role: user.is_owner ? 'owner' : user.role,
    coachingName: coaching?.name || null,
    ...identity,
  };
}

async function getPendingTwoFactorContext(req) {
  const pending = req.session?.pendingLogin;
  if (!pending?.userId) return null;

  const user = await get(
    `SELECT u.*, b.code AS branch_code, b.name AS branch_name
     FROM users u
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.id = ?
     LIMIT 1`,
    [pending.userId]
  );
  if (!user) return null;

  const coaching = pending.coachingId ? await getCoachingContextById(pending.coachingId) : null;
  return {
    pending,
    user,
    coaching,
    identity: getTwoFactorIdentity(user, coaching),
  };
}

async function finishAuthenticatedLogin(req, res, user, coaching = null) {
  await run(`UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]).catch(() => {});
  await signInUser(req, user, coaching);

  if (req.session.user.role === 'admin' && !hasAcceptedAdminLegal(user)) {
    return res.redirect('/admin/legal');
  }

  if (req.session.user.role === 'admin' && user.must_change_password) {
    req.session.user.mustChangePassword = true;
    return res.redirect('/admin/password/setup');
  }

  if (!req.session.user.isOwner && coaching) {
    const subscriptionState = getSubscriptionState(coaching);
    if (subscriptionState.accessBlocked) {
      if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
      return res.redirect('/subscription-status');
    }
  }

  if (req.session.user.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
  return res.redirect('/student/dashboard');
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  return next();
}

function requireOwner(req, res, next) {
  return requireBranchOwner(req, res, next);
}

function requireCoachingAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.isOwner || req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
  return next();
}

function requireStudent(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'student') return res.status(403).send('Forbidden');
  return next();
}

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  if (req.method === 'POST' && getRequestPathCandidates(req).some((requestPath) => PUBLIC_WEBHOOK_POST_PATHS.has(requestPath))) {
    return next();
  }

  if (!hasValidRequestOrigin(req)) {
    return res.status(403).send('Invalid request origin');
  }

  if (req.method === 'POST' && isLogoutPostPath(req)) {
    return next();
  }

  // The 2FA flow is still same-origin checked above, then protected by the
  // pending-login session plus the one-time code. Path matching is normalized
  // for Vercel rewrites/trailing slashes so these posts do not fall through to
  // the generic CSRF error.
  if (req.method === 'POST' && isTwoFactorAuthPostPath(req)) {
    return next();
  }

  if (!ensureCsrf(req)) {
    if (req.method === 'POST' && isLoginPostPath(req)) {
      req.session.flash = {
        type: 'error',
        text: 'Your login page expired. Please try again.',
      };
      return res.redirect('/login');
    }

    if (req.method === 'POST' && isOmrImportResultsPostPath(req)) {
      req.session.flash = {
        type: 'error',
        text: 'Your OMR import page expired. Please try uploading the CSV again.',
      };
      return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
    }

    return res.status(403).send('Invalid security token');
  }

  return next();
});

function getOwnerSection(input) {
  const section = (input || '').trim();
  return OWNER_SECTIONS.has(section) ? section : 'overview';
}

function getAdminSection(input) {
  const section = (input || '').trim();
  return ADMIN_SECTIONS.has(section) ? section : 'overview';
}

function formatLegacyBatchLabel(standard, course) {
  const safeStandard = String(standard || '').trim();
  const safeCourse = String(course || '').trim().toUpperCase();

  if (safeStandard && safeCourse) return `${safeStandard} - ${safeCourse}`;
  if (safeStandard) return safeStandard;
  if (safeCourse) return safeCourse;
  return '';
}

function formatDaysAgo(value) {
  if (!value) return null;
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '0 days';
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  return `${days} day${days === 1 ? '' : 's'}`;
}

function getBatchLabel(item) {
  return String(item?.batch_name || '').trim()
    || formatLegacyBatchLabel(item?.standard, item?.course)
    || 'Unassigned';
}

function normalizeBatchName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeStudentStandard(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: true, value: null };

  const compact = raw.toLowerCase().replace(/\s+/g, '');
  if (/^(class)?11(th)?$/.test(compact)) return { ok: true, value: '11th' };
  if (/^(class)?12(th)?$/.test(compact)) return { ok: true, value: '12th' };

  return { ok: false, value: null };
}

function extractBatchMeta(batchName) {
  const input = String(batchName || '').trim();
  const standardMatch = input.match(/\b(class\s*)?(11|12)\s*(th)?\b/i);
  const courseMatch = input.match(/\b(jee|neet)\b/i);
  const normalizedStandard = normalizeStudentStandard(standardMatch ? standardMatch[0] : null);

  return {
    standard: normalizedStandard.ok ? normalizedStandard.value : null,
    course: courseMatch ? courseMatch[1].toUpperCase() : null,
  };
}

function toStudentBatchGroups(students, batches = []) {
  const batchOrder = new Map(batches.map((batch, index) => [String(batch.id), index]));
  const groups = new Map();

  students.forEach((student) => {
    const key = student.batch_id ? `batch-${student.batch_id}` : 'unassigned';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: student.is_retained_record ? `${getBatchLabel(student)} (Retained)` : getBatchLabel(student),
        students: [],
        order: student.is_retained_record ? -1 : (student.batch_id ? batchOrder.get(String(student.batch_id)) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER),
        isUnassigned: !student.batch_id,
        isRetained: Boolean(student.is_retained_record),
      });
    }

    groups.get(key).students.push(student);
  });

  return Array.from(groups.values()).sort((a, b) => {
    if (a.isRetained !== b.isRetained) return a.isRetained ? -1 : 1;
    if (a.isUnassigned !== b.isUnassigned) return a.isUnassigned ? 1 : -1;
    if (a.order !== b.order) return a.order - b.order;
    return a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' });
  });
}

function toBatchSummaries(students, batches = []) {
  const counts = new Map();
  students.forEach((student) => {
    const key = student.batch_id ? String(student.batch_id) : 'unassigned';
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const summaries = batches.map((batch) => ({
    ...batch,
    count: counts.get(String(batch.id)) || 0,
    createdDaysAgo: formatDaysAgo(batch.created_at),
    completedDaysAgo: formatDaysAgo(batch.completed_at),
  }));

  if (counts.get('unassigned')) {
    summaries.push({
      id: null,
      name: 'Unassigned',
      count: counts.get('unassigned'),
      isUnassigned: true,
    });
  }

  return summaries;
}

function parseAbsentees(input) {
  return new Set(
    (input || '')
      .split(/[\n,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function parsePaperMetaFromFileName(originalName) {
  const base = path.parse(originalName).name.trim();
  const parts = base.split(/[_-]+/).map((v) => v.trim()).filter(Boolean);
  const rollNo = parts[0] || base;

  let marksObtained = null;
  let maxMarks = null;
  let testLabel = '';

  if (parts.length >= 2 && /^\d+(\.\d+)?$/.test(parts[1])) {
    marksObtained = Number(parts[1]);
  }

  if (parts.length >= 3 && /^\d+(\.\d+)?$/.test(parts[2])) {
    maxMarks = Number(parts[2]);
  } else if (marksObtained !== null) {
    maxMarks = 100;
  }

  if (parts.length > 3) {
    testLabel = parts.slice(3).join(' ');
  }

  return {
    rollNo,
    marksObtained,
    maxMarks,
    testLabel: testLabel || null,
  };
}

function groupAttendanceByDate(rows) {
  return rows.reduce((acc, row) => {
    const key = row.attendance_date;
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});
}

function normalizeDateOnlyFilter(value) {
  const normalized = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function normalizeMonthOnlyFilter(value, fallback = '') {
  const normalized = String(value || '').trim();
  return /^\d{4}-\d{2}$/.test(normalized) ? normalized : fallback;
}

function getMonthDateRange(monthValue) {
  const normalized = normalizeMonthOnlyFilter(monthValue);
  if (!normalized) return null;
  const [yearValue, monthPart] = normalized.split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(yearValue) || !Number.isInteger(monthPart)) return null;
  const nextMonth = monthPart === 12 ? 1 : monthPart + 1;
  const nextYear = monthPart === 12 ? yearValue + 1 : yearValue;
  return {
    start: `${yearValue}-${String(monthPart).padStart(2, '0')}-01`,
    end: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
  };
}

async function getAttendanceReportRows(coachingId, branchId, options = {}) {
  if (typeof branchId === 'object') {
    options = branchId;
    branchId = getBranchContext().branchId;
  }
  const {
  attendanceDate = '',
  attendanceMonth = '',
  limit = 300,
  } = options;
  let attendanceSql = `
    SELECT a.id, CAST(a.attendance_date AS TEXT) AS attendance_date, a.status, a.notes, u.roll_no, u.name, u.batch_id, u.standard, u.course, b.name AS batch_name
    FROM attendance a
    JOIN users u ON u.id = a.student_id AND u.branch_id = a.branch_id
    LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = a.branch_id
    WHERE a.coaching_id = ? AND a.branch_id = ?
  `;
  const attendanceParams = [coachingId, branchId];
  if (attendanceDate) {
    attendanceSql += ` AND a.attendance_date = ? `;
    attendanceParams.push(attendanceDate);
  } else if (attendanceMonth) {
    const range = getMonthDateRange(attendanceMonth);
    if (range) {
      attendanceSql += ` AND a.attendance_date >= ? AND a.attendance_date < ? `;
      attendanceParams.push(range.start, range.end);
    }
  }
  attendanceSql += ` ORDER BY a.attendance_date DESC, a.id DESC LIMIT ? `;
  attendanceParams.push(limit);
  return all(attendanceSql, attendanceParams);
}

async function getFeeReportRows(coachingId, branchId, options = {}) {
  if (typeof branchId === 'object') {
    options = branchId;
    branchId = getBranchContext().branchId;
  }
  const {
  feesDate = '',
  feesMonth = '',
  limit = 150,
  createdBy = null,
  } = options;
  let feesSql = `
    SELECT f.id, f.amount, CAST(f.due_date AS TEXT) AS due_date, CAST(f.payment_date AS TEXT) AS payment_date, f.status, f.notes,
            f.payment_mode, f.receipt_number, f.receipt_file_url,
            u.id AS student_id, u.roll_no, u.name, u.guardian_phone, u.parent_whatsapp_number, u.batch_id, u.standard, u.course,
            b.name AS batch_name
     FROM fees f
     JOIN users u ON u.id = f.student_id AND u.branch_id = f.branch_id
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = f.branch_id
     WHERE f.coaching_id = ? AND f.branch_id = ?
  `;
  const feesParams = [coachingId, branchId];
  if (createdBy) {
    feesSql += ` AND f.added_by = ? `;
    feesParams.push(createdBy);
  }
  if (feesDate) {
    feesSql += ` AND COALESCE(f.payment_date, f.due_date, CAST(f.created_at AS DATE)) = ? `;
    feesParams.push(feesDate);
  } else if (feesMonth) {
    const range = getMonthDateRange(feesMonth);
    if (range) {
      feesSql += `
         AND COALESCE(f.payment_date, f.due_date, CAST(f.created_at AS DATE)) >= ?
         AND COALESCE(f.payment_date, f.due_date, CAST(f.created_at AS DATE)) < ?
      `;
      feesParams.push(range.start, range.end);
    }
  }
  feesSql += ` ORDER BY f.created_at DESC LIMIT ? `;
  feesParams.push(limit);
  const rows = await all(feesSql, feesParams);
  console.log(`[FEE LIST] branchId=${branchId} coachingId=${coachingId} month=${feesMonth || ''} rows=${rows.length}`);
  return rows;
}

const EXPENSE_CATEGORIES = [
  'Salary',
  'Rent',
  'Electricity',
  'Internet',
  'Marketing',
  'Stationery',
  'Maintenance',
  'Transport',
  'Software',
  'Miscellaneous',
];

function sanitizeFinanceText(value, maxLength = 180) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function formatIndianCurrency(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

async function ensureExpensesSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      expense_date DATE NOT NULL,
      amount NUMERIC(12, 2) NOT NULL,
      category VARCHAR(80) NOT NULL,
      paid_to VARCHAR(160),
      payment_mode VARCHAR(80),
      description TEXT,
      reference_no VARCHAR(160),
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getExpenseRows(coachingId, branchId, monthValue, limit = 150) {
  const params = [coachingId, branchId];
  let sql = `
    SELECT id, CAST(expense_date AS TEXT) AS expense_date, amount, category, paid_to, payment_mode, description, reference_no
    FROM expenses
    WHERE coaching_id = ? AND branch_id = ?
  `;
  const range = getMonthDateRange(monthValue);
  if (range) {
    sql += ` AND expense_date >= ? AND expense_date < ? `;
    params.push(range.start, range.end);
  }
  sql += ` ORDER BY expense_date DESC, id DESC LIMIT ? `;
  params.push(limit);
  return all(sql, params);
}

async function getFinanceSummary(coachingId, branchId, expenseMonth) {
  const feeRow = await get(`
    SELECT COALESCE(SUM(COALESCE(sfs.total_fee, 0)), 0) AS total_fees
    FROM users u
    LEFT JOIN student_fee_structure sfs
      ON sfs.student_id = u.id
     AND sfs.coaching_id = u.coaching_id
     AND sfs.branch_id = u.branch_id
    WHERE u.coaching_id = ? AND u.branch_id = ? AND u.role = 'student'
  `, [coachingId, branchId]);
  const collectedRow = await get(`
    SELECT COALESCE(SUM(amount), 0) AS total_collected
    FROM fees
    WHERE coaching_id = ? AND branch_id = ? AND status = 'paid'
  `, [coachingId, branchId]);
  const range = getMonthDateRange(expenseMonth);
  const expenseParams = [coachingId, branchId];
  let expenseSql = `
    SELECT COALESCE(SUM(amount), 0) AS total_expenses
    FROM expenses
    WHERE coaching_id = ? AND branch_id = ?
  `;
  if (range) {
    expenseSql += ` AND expense_date >= ? AND expense_date < ?`;
    expenseParams.push(range.start, range.end);
  }
  const expenseRow = await get(expenseSql, expenseParams);
  const totalFees = Number(feeRow?.total_fees || 0);
  const totalCollected = Number(collectedRow?.total_collected || 0);
  const totalPending = Math.max(totalFees - totalCollected, 0);
  const totalExpenses = Number(expenseRow?.total_expenses || 0);
  const netBalance = totalCollected - totalExpenses;
  console.log(`[FINANCE SUMMARY] coachingId=${coachingId} branchId=${branchId} totalFees=${totalFees} collected=${totalCollected} pending=${totalPending} expenses=${totalExpenses} net=${netBalance}`);
  return {
    totalFees,
    totalCollected,
    totalPending,
    totalExpenses,
    netBalance,
    formatted: {
      totalFees: formatIndianCurrency(totalFees),
      totalCollected: formatIndianCurrency(totalCollected),
      totalPending: formatIndianCurrency(totalPending),
      totalExpenses: formatIndianCurrency(totalExpenses),
      netBalance: formatIndianCurrency(netBalance),
    },
  };
}

async function ensurePerformanceIndexes() {
  const indexes = [
    `CREATE INDEX IF NOT EXISTS users_coaching_role_idx ON users (coaching_id, role)`,
    `CREATE INDEX IF NOT EXISTS users_coaching_role_batch_idx ON users (coaching_id, role, batch_id)`,
    `CREATE INDEX IF NOT EXISTS users_coaching_role_roll_idx ON users (coaching_id, role, roll_no)`,
    `CREATE INDEX IF NOT EXISTS attendance_coaching_date_idx ON attendance (coaching_id, attendance_date DESC)`,
    `CREATE INDEX IF NOT EXISTS attendance_coaching_student_date_idx ON attendance (coaching_id, student_id, attendance_date)`,
    `CREATE INDEX IF NOT EXISTS fees_coaching_created_idx ON fees (coaching_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS fees_coaching_payment_date_idx ON fees (coaching_id, payment_date DESC)`,
    `CREATE INDEX IF NOT EXISTS fees_coaching_due_date_idx ON fees (coaching_id, due_date DESC)`,
    `CREATE INDEX IF NOT EXISTS expenses_coaching_branch_date_idx ON expenses (coaching_id, branch_id, expense_date DESC)`,
    `CREATE INDEX IF NOT EXISTS expenses_coaching_branch_created_idx ON expenses (coaching_id, branch_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS test_papers_coaching_upload_idx ON test_papers (coaching_id, upload_date DESC)`,
    `CREATE INDEX IF NOT EXISTS test_papers_coaching_student_upload_idx ON test_papers (coaching_id, student_id, upload_date DESC)`,
    `CREATE INDEX IF NOT EXISTS test_papers_coaching_answer_request_idx ON test_papers (coaching_id, answer_request_id, upload_date DESC)`,
    `CREATE INDEX IF NOT EXISTS batch_notes_coaching_created_idx ON batch_notes (coaching_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS answer_upload_requests_coaching_created_idx ON answer_upload_requests (coaching_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS batches_coaching_status_idx ON batches (coaching_id, status, name)`,
  ];

  for (const statement of indexes) {
    await run(statement);
  }
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeLogoUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();

    if ((host === 'www.google.com' || host === 'google.com') && url.pathname === '/imgres') {
      const nestedImageUrl = url.searchParams.get('imgurl');
      if (nestedImageUrl && isValidHttpUrl(nestedImageUrl)) {
        return nestedImageUrl.trim();
      }
    }

    return raw;
  } catch {
    return raw;
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function normalizeTrialStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
}

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function getBatchesForCoaching(coachingId, branchId) {
  return all(
    `SELECT id, name, normalized_name, standard, course, status, completed_at, is_retention_batch, created_at
     FROM batches
     WHERE coaching_id = ? AND branch_id = ?
     ORDER BY is_retention_batch DESC, CASE WHEN status = 'active' THEN 0 ELSE 1 END, LOWER(name) ASC, id ASC`,
    [coachingId, branchId]
  );
}

async function getBatchForCoaching(coachingId, branchId, batchId) {
  if (batchId === undefined) {
    batchId = branchId;
    branchId = getBranchContext().branchId;
  }
  return get(
    `SELECT id, coaching_id, name, normalized_name, standard, course, status, completed_at, is_retention_batch, created_at
     FROM batches
     WHERE coaching_id = ? AND branch_id = ? AND id = ?
     LIMIT 1`,
    [coachingId, branchId, batchId]
  );
}

async function ensureRetentionBatch(coachingId, branchId, createdBy = null) {
  if (createdBy === null && branchId !== getBranchContext().branchId) {
    createdBy = branchId;
    branchId = getBranchContext().branchId;
  }
  const existing = await get(
    `SELECT id, coaching_id, name, normalized_name, standard, course, status, completed_at, is_retention_batch, created_at
     FROM batches
     WHERE coaching_id = ? AND branch_id = ? AND is_retention_batch = 1
     LIMIT 1`,
    [coachingId, branchId]
  );
  if (existing) return existing;

  const normalizedName = RETENTION_BATCH_NAME.toLowerCase();
  const result = await run(
    `INSERT INTO batches (coaching_id, branch_id, name, normalized_name, standard, course, status, is_retention_batch, created_by)
     VALUES (?, ?, ?, ?, NULL, NULL, 'active', 1, ?)`,
    [coachingId, branchId, RETENTION_BATCH_NAME, normalizedName, createdBy]
  );
  return getBatchForCoaching(coachingId, branchId, result.lastID);
}

function buildPortalUrl(req, slug) {
  return `${req.protocol}://${req.get('host')}/login?coaching=${encodeURIComponent(slug)}`;
}

function parseDateOnly(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateLabel(value) {
  const parsed = parseDateOnly(value);
  if (!parsed) return value || '-';

  return parsed.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function parseDateTimeLocal(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTimeLabel(value) {
  const parsed = parseDateTimeLocal(value);
  if (!parsed) return value || '-';

  return parsed.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatReportAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 'Rs. 0';
  return `Rs. ${amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}`;
}

function streamTablePdfReport(res, {
  fileName,
  title,
  subtitle,
  columns,
  rows,
  emptyMessage = 'No records found.',
}) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${String(fileName || 'report.pdf').replace(/"/g, '')}"`);
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  const drawTitle = () => {
    const logoPath = path.join(__dirname, '..', 'public', 'scc-icon.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, right - 54, 24, { fit: [52, 52] });
    }
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#35438f').text(title, left, 36, { width: right - left - 70 });
    doc.font('Helvetica').fontSize(10).fillColor('#4b5563').text(subtitle, left, 60, { width: right - left - 70 });
    doc.moveTo(left, 82).lineTo(right, 82).strokeColor('#d1d5db').stroke();
  };

  const drawHeader = (y) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#374151');
    let x = left;
    columns.forEach((column) => {
      doc.text(column.label, x, y, { width: column.width, height: 18 });
      x += column.width;
    });
    doc.moveTo(left, y + 18).lineTo(right, y + 18).strokeColor('#e5e7eb').stroke();
    return y + 26;
  };

  drawTitle();
  let y = drawHeader(96);

  if (!rows.length) {
    doc.font('Helvetica').fontSize(12).fillColor('#6b7280').text(emptyMessage, left, y + 10);
    doc.end();
    return;
  }

  rows.forEach((row) => {
    const rowHeight = 34;
    if (y + rowHeight > bottom) {
      doc.addPage();
      drawTitle();
      y = drawHeader(96);
    }

    doc.font('Helvetica').fontSize(9).fillColor('#111827');
    let x = left;
    columns.forEach((column, index) => {
      const value = String(row[index] ?? '-');
      doc.text(value, x, y, { width: column.width, height: rowHeight - 8, ellipsis: true });
      x += column.width;
    });
    doc.moveTo(left, y + rowHeight - 6).lineTo(right, y + rowHeight - 6).strokeColor('#f3f4f6').stroke();
    y += rowHeight;
  });

  doc.end();
}

function toDateTimeLocalInput(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function addHours(date, hours) {
  return new Date(date.getTime() + (hours * 60 * 60 * 1000));
}

function parseOptionalNumber(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalPositiveInteger(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return Number.NaN;
  return parsed;
}

function getStudentLimitValue(coaching) {
  if (coaching?.max_students === null || coaching?.max_students === undefined || coaching?.max_students === '') {
    return null;
  }

  const parsed = Number(coaching.max_students);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getStudentUsage(count, coaching) {
  const limit = getStudentLimitValue(coaching);
  return {
    count,
    limit,
    remaining: limit === null ? null : Math.max(limit - count, 0),
    atLimit: limit !== null && count >= limit,
  };
}

function buildResolvedPlanSql(alias = 'cc') {
  return {
    name: `COALESCE(NULLIF(${alias}.custom_plan_name, ''), sp.name)`,
    maxStudents: `COALESCE(${alias}.custom_max_students, sp.max_students)`,
  };
}

function normalizeHexColor(value, fallback) {
  const input = String(value || '').trim();
  if (!input) return fallback;

  const normalized = input.startsWith('#') ? input : `#${input}`;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalized)) {
    return fallback;
  }

  if (normalized.length === 4) {
    return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`.toLowerCase();
  }

  return normalized.toLowerCase();
}

function hexToRgb(hex) {
  const safeHex = normalizeHexColor(hex, DEFAULT_THEME.brand).slice(1);
  return {
    r: Number.parseInt(safeHex.slice(0, 2), 16),
    g: Number.parseInt(safeHex.slice(2, 4), 16),
    b: Number.parseInt(safeHex.slice(4, 6), 16),
  };
}

function rgbaFromHex(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function darkenHex(hex, amount = 22) {
  const { r, g, b } = hexToRgb(hex);
  const next = [r, g, b]
    .map((value) => Math.max(0, Math.min(255, value - amount)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `#${next}`;
}

function buildBranding(coaching = null) {
  const themePrimary = normalizeHexColor(coaching?.theme_primary, DEFAULT_THEME.brand);
  const themeBackground = normalizeHexColor(coaching?.theme_background, DEFAULT_THEME.background);
  const themeSurface = normalizeHexColor(coaching?.theme_surface, DEFAULT_THEME.surface);
  const isScc = String(coaching?.slug || '').toLowerCase() === 'scc'
    || /^scc\b/i.test(String(coaching?.name || ''));
  const brandName = String(isScc ? 'SCC' : coaching?.brand_name || coaching?.name || 'SCC').trim();

  return {
    brandName,
    coachingName: coaching?.name || brandName,
    logoUrl: isScc ? '/public/scc-logo.svg' : normalizeLogoUrl(coaching?.logo_url || '/public/scc-logo.svg'),
    faviconUrl: '/public/scc-icon.svg',
    themePrimary,
    themeBackground,
    themeSurface,
    cssVars: [
      `--brand:${themePrimary}`,
      `--brand-dark:${darkenHex(themePrimary, 26)}`,
      `--bg:${themeBackground}`,
      `--card:${themeSurface}`,
      `--line:${rgbaFromHex(themePrimary, 0.14)}`,
      `--bg-accent-a:${rgbaFromHex(themePrimary, 0.18)}`,
      `--bg-accent-b:${rgbaFromHex(themePrimary, 0.08)}`,
      `--surface-glow:${rgbaFromHex(themePrimary, 0.1)}`,
      `--shadow:0 12px 30px ${rgbaFromHex(themePrimary, 0.08)}`,
    ].join(';'),
  };
}

function normalizeSearchValue(value) {
  return String(value || '').trim().toLowerCase();
}

function toDigitSearchValue(value) {
  return String(value || '').replace(/\D/g, '');
}

function getStudentSearchResults(students, rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) {
    return {
      query: '',
      results: [],
      totalMatches: 0,
    };
  }

  const queryLower = normalizeSearchValue(query);
  const queryDigits = toDigitSearchValue(query);

  const scored = (students || []).map((student) => {
    const roll = String(student.roll_no || '').trim();
    const name = String(student.name || '').trim();
    const phone = String(student.contact_phone || '').trim();
    const email = String(student.email || '').trim();

    const rollLower = normalizeSearchValue(roll);
    const nameLower = normalizeSearchValue(name);
    const phoneDigits = toDigitSearchValue(phone);

    let score = -1;

    if (rollLower === queryLower) score = Math.max(score, 100);
    else if (rollLower.startsWith(queryLower)) score = Math.max(score, 90);
    else if (rollLower.includes(queryLower)) score = Math.max(score, 80);

    if (nameLower === queryLower) score = Math.max(score, 75);
    else if (nameLower.startsWith(queryLower)) score = Math.max(score, 65);
    else if (nameLower.includes(queryLower)) score = Math.max(score, 55);

    if (queryDigits) {
      if (phoneDigits === queryDigits) score = Math.max(score, 70);
      else if (phoneDigits.startsWith(queryDigits)) score = Math.max(score, 60);
      else if (phoneDigits.includes(queryDigits)) score = Math.max(score, 50);
    }

    return {
      ...student,
      email,
      searchScore: score,
      sortRoll: rollLower,
    };
  }).filter((student) => student.searchScore >= 0);

  scored.sort((a, b) => (
    b.searchScore - a.searchScore
    || a.sortRoll.localeCompare(b.sortRoll)
    || String(a.name || '').localeCompare(String(b.name || ''))
  ));

  return {
    query,
    results: scored.slice(0, 25),
    totalMatches: scored.length,
  };
}

async function resolveStudentForAdminEntry(coachingId, branchId, options) {
  if (options === undefined) {
    options = branchId;
    branchId = getBranchContext().branchId;
  }
  const { rollNo, studentLookup } = options;
  const selectedRollNo = String(rollNo || '').trim();
  const lookup = String(studentLookup || '').trim();
  const lookupLower = normalizeSearchValue(lookup);

  if (selectedRollNo) {
    const student = await get(
      `SELECT id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
       FROM users
       WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND roll_no = ?
       LIMIT 1`,
      [coachingId, branchId, selectedRollNo]
    );
    if (student) return { student, error: null };
  }

  if (!lookupLower) {
    return { student: null, error: 'Select a student by name or roll number' };
  }

  const rollFromLookup = lookup.match(/\broll\s+([^\s-]+)/i)?.[1]
    || lookup.match(/^([^\s-]+)\s+-/)?.[1]
    || lookup;

  const matches = await all(
    `SELECT id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
     FROM users
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student'
       AND (
         LOWER(roll_no) = LOWER(?)
         OR LOWER(name) = LOWER(?)
         OR LOWER(name) LIKE LOWER(?)
       )
     ORDER BY
       CASE
         WHEN LOWER(roll_no) = LOWER(?) THEN 1
         WHEN LOWER(name) = LOWER(?) THEN 2
         WHEN LOWER(name) LIKE LOWER(?) THEN 3
         ELSE 4
       END,
       roll_no ASC
     LIMIT 2`,
    [
      coachingId,
      branchId,
      rollFromLookup,
      lookup,
      `${lookup}%`,
      rollFromLookup,
      lookup,
      `${lookup}%`,
    ]
  );

  if (matches.length === 1) {
    return { student: matches[0], error: null };
  }

  if (matches.length > 1) {
    return { student: null, error: 'Multiple students match this name. Please choose the exact student from the list.' };
  }

  return { student: null, error: 'Student not found. Please choose a student from the list.' };
}

function getAnswerRequestState(request) {
  const now = new Date();
  const startsAt = parseDateTimeLocal(request.starts_at);
  const endsAt = parseDateTimeLocal(request.ends_at);
  const startsAtLabel = formatDateTimeLabel(request.starts_at);
  const endsAtLabel = formatDateTimeLabel(request.ends_at);
  const remainingMs = endsAt ? endsAt.getTime() - now.getTime() : null;
  const remainingHours = remainingMs !== null ? Math.max(0, Math.round((remainingMs / 3600000) * 10) / 10) : null;

  let phase = 'expired';
  if (startsAt && now < startsAt) phase = 'upcoming';
  else if (startsAt && endsAt && now >= startsAt && now <= endsAt) phase = 'active';

  return {
    phase,
    startsAt,
    endsAt,
    startsAtLabel,
    endsAtLabel,
    isUpcoming: phase === 'upcoming',
    isActive: phase === 'active',
    isExpired: phase === 'expired',
    remainingHours,
  };
}

async function buildAnswerRequestSummaries(coachingId, branchId, requests) {
  if (!requests.length) return [];

  const requestIds = requests.map((request) => Number(request.id)).filter(Number.isInteger);
  const targetStudents = await all(
    `SELECT u.id, u.roll_no, u.name, u.contact_phone, u.email, u.batch_id, u.standard, u.course, b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = u.branch_id
     WHERE u.coaching_id = ? AND u.branch_id = ? AND u.role = 'student'
     ORDER BY u.roll_no ASC`,
    [coachingId, branchId]
  );

  const submissions = requestIds.length
    ? await all(
      `SELECT tp.id, tp.student_id, tp.upload_date, tp.original_name, tp.test_label, tp.content_type,
              tp.answer_request_id,
              uploader.name AS uploaded_by_name, uploader.role AS uploaded_by_role
	       FROM test_papers tp
	       LEFT JOIN users uploader ON uploader.id = tp.uploaded_by
	       WHERE tp.coaching_id = ? AND tp.branch_id = ? AND tp.answer_request_id = ANY(?::int[])
	         AND ${getRealPaperFileCondition('tp')}
	       ORDER BY tp.upload_date DESC`,
      [coachingId, branchId, requestIds]
    )
    : [];

  const submissionsByRequest = new Map();
  submissions.forEach((submission) => {
    const requestKey = Number(submission.answer_request_id);
    if (!submissionsByRequest.has(requestKey)) {
      submissionsByRequest.set(requestKey, []);
    }
    submissionsByRequest.get(requestKey).push(submission);
  });

  return requests.map((request) => {
    const requestTargetStudents = request.batch_id
      ? targetStudents.filter((student) => Number(student.batch_id) === Number(request.batch_id))
      : targetStudents.filter((student) => (
        String(student.standard || '') === String(request.standard || '')
        && String(student.course || '') === String(request.course || '')
      ));
    const requestSubmissions = submissionsByRequest.get(Number(request.id)) || [];

    const latestSubmissionByStudent = new Map();
    requestSubmissions.forEach((submission) => {
      if (!latestSubmissionByStudent.has(submission.student_id)) {
        latestSubmissionByStudent.set(submission.student_id, submission);
      }
    });

    const uploadedStudents = [];
    const pendingStudents = [];

    for (const student of requestTargetStudents) {
      const submission = latestSubmissionByStudent.get(student.id);
      if (submission) {
        uploadedStudents.push({
          ...student,
          submission,
        });
      } else {
        pendingStudents.push(student);
      }
    }

    return {
      ...request,
      batch_name: request.batch_name || formatLegacyBatchLabel(request.standard, request.course) || null,
      state: getAnswerRequestState(request),
      totalStudents: requestTargetStudents.length,
      uploadedCount: uploadedStudents.length,
      pendingCount: pendingStudents.length,
      uploadedStudents,
      pendingStudents,
    };
  });
}

async function findRecentDuplicatePaper({
  coachingId,
  branchId,
  studentId,
  originalName,
  testLabel,
  marksObtained,
  maxMarks,
  uploadedBy,
  answerRequestId = null,
}) {
  if (answerRequestId === null) {
    return get(
      `SELECT id
       FROM test_papers
       WHERE coaching_id = ? AND branch_id = ?
         AND student_id = ?
         AND uploaded_by = ?
         AND answer_request_id IS NULL
        AND original_name = ?
        AND COALESCE(test_label, '') = COALESCE(?, '')
        AND COALESCE(marks_obtained, -999999) = COALESCE(?, -999999)
        AND COALESCE(max_marks, -999999) = COALESCE(?, -999999)
        AND upload_date >= CURRENT_TIMESTAMP - INTERVAL '20 seconds'
       ORDER BY upload_date DESC, id DESC
       LIMIT 1`,
      [coachingId, branchId, studentId, uploadedBy, originalName, testLabel || null, marksObtained, maxMarks]
    );
  }

  return get(
    `SELECT id
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ?
       AND student_id = ?
       AND uploaded_by = ?
       AND answer_request_id = ?
       AND original_name = ?
       AND COALESCE(test_label, '') = COALESCE(?, '')
       AND COALESCE(marks_obtained, -999999) = COALESCE(?, -999999)
       AND COALESCE(max_marks, -999999) = COALESCE(?, -999999)
       AND upload_date >= CURRENT_TIMESTAMP - INTERVAL '20 seconds'
     ORDER BY upload_date DESC, id DESC
     LIMIT 1`,
    [coachingId, branchId, studentId, uploadedBy, answerRequestId, originalName, testLabel || null, marksObtained, maxMarks]
  );
}

async function deletePaperRecord(paper) {
  await run(`DELETE FROM test_papers WHERE id = ? AND branch_id = ?`, [paper.id, paper.branch_id]);
  try {
    await deleteStoredPaper(paper);
  } catch (error) {
    console.error('Failed deleting stored paper asset', error);
  }
}

async function savePaperUpload({
  coachingId,
  branchId = getBranchContext().branchId,
  studentId,
  file,
  uploadedBy,
  testLabel,
  marksObtained,
  maxMarks,
  answerRequestId = null,
}) {
  const duplicate = await findRecentDuplicatePaper({
    coachingId,
    branchId,
    studentId,
    originalName: file.originalname,
    testLabel,
    marksObtained,
    maxMarks,
    uploadedBy,
    answerRequestId,
  });

  if (duplicate) {
    return { status: 'duplicate', paperId: duplicate.id };
  }

  const stored = await uploadPaperFile(file);

  if (answerRequestId !== null) {
    const existing = await get(
      `SELECT id, stored_name, storage_type, storage_key, public_url, content_type
	       FROM test_papers
	       WHERE coaching_id = ? AND branch_id = ? AND student_id = ? AND answer_request_id = ?
	         AND ${getRealPaperFileCondition()}
	       ORDER BY upload_date DESC, id DESC
       LIMIT 1`,
      [coachingId, branchId, studentId, answerRequestId]
    );

    if (existing) {
      await run(
        `UPDATE test_papers
         SET original_name = ?, stored_name = ?, uploaded_by = ?,
             storage_type = ?, storage_key = ?, public_url = ?, content_type = ?, size_bytes = ?,
             marks_obtained = ?, max_marks = ?, test_label = ?, paper_type = 'answer_submission',
             upload_date = CURRENT_TIMESTAMP
         WHERE id = ? AND branch_id = ?`,
        [
          file.originalname,
          stored.storedName,
          uploadedBy,
          stored.storageType,
          stored.storageKey,
          stored.publicUrl,
          stored.contentType,
          stored.sizeBytes,
          marksObtained,
          maxMarks,
          testLabel || file.originalname,
          existing.id,
          branchId,
        ]
      );

      if (existing.storage_key !== stored.storageKey || existing.storage_type !== stored.storageType) {
        try {
          await deleteStoredPaper(existing);
        } catch (error) {
          console.error('Failed deleting replaced answer submission asset', error);
        }
      }

      return { status: 'replaced', paperId: existing.id };
    }
  }

  const result = await run(
    `INSERT INTO test_papers (
      coaching_id, branch_id, student_id, original_name, stored_name, uploaded_by,
      storage_type, storage_key, public_url, content_type, size_bytes,
      marks_obtained, max_marks, test_label, paper_type, answer_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      branchId,
      studentId,
      file.originalname,
      stored.storedName,
      uploadedBy,
      stored.storageType,
      stored.storageKey,
      stored.publicUrl,
      stored.contentType,
      stored.sizeBytes,
      marksObtained,
      maxMarks,
      testLabel || file.originalname,
      answerRequestId !== null ? 'answer_submission' : 'general',
      answerRequestId,
    ]
  );

  return { status: 'inserted', paperId: result.lastID };
}

async function getPaperForDelete(id, sessionUser) {
  const paper = await get(
    `SELECT tp.*, u.coaching_id AS student_coaching_id
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id
     WHERE tp.id = ? AND tp.branch_id = ?`,
    [id, sessionUser.branchId]
  );

  if (!paper) return null;
  if (sessionUser.isOwner) return null;

  if (sessionUser.role === 'admin' && paper.coaching_id === sessionUser.coachingId && paper.branch_id === sessionUser.branchId) {
    return paper;
  }

  if (
    sessionUser.role === 'student' &&
    paper.student_id === sessionUser.id &&
    paper.coaching_id === sessionUser.coachingId &&
    paper.branch_id === sessionUser.branchId &&
    paper.uploaded_by === sessionUser.id
  ) {
    return paper;
  }

  return null;
}

async function cleanupDuplicateAnswerSubmissions() {
  const duplicateGroups = await all(
    `SELECT coaching_id, branch_id, student_id, answer_request_id, COUNT(*) AS duplicate_count
     FROM test_papers
     WHERE answer_request_id IS NOT NULL
     GROUP BY coaching_id, branch_id, student_id, answer_request_id
     HAVING COUNT(*) > 1`
  );

  for (const group of duplicateGroups) {
    const rows = await all(
      `SELECT id, branch_id, stored_name, storage_type, storage_key, public_url, content_type
       FROM test_papers
       WHERE coaching_id = ? AND branch_id = ? AND student_id = ? AND answer_request_id = ?
       ORDER BY upload_date DESC, id DESC`,
      [group.coaching_id, group.branch_id, group.student_id, group.answer_request_id]
    );

    const [, ...duplicates] = rows;
    for (const paper of duplicates) {
      await deletePaperRecord(paper);
    }
  }
}

async function getStudentDashboardPayload(coachingId, branchId, studentId) {
  if (studentId === undefined) {
    studentId = branchId;
    branchId = getBranchContext().branchId;
  }
  const profile = await get(
    `SELECT u.id, u.roll_no, u.name, u.batch_id, u.standard, u.course,
            u.contact_phone, u.guardian_phone, u.parent_name, u.whatsapp_number, u.parent_whatsapp_number, u.email,
            b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = u.branch_id
     WHERE u.id = ? AND u.coaching_id = ? AND u.branch_id = ? AND u.role = 'student'`,
    [studentId, coachingId, branchId]
  );

  const papers = await all(`
SELECT tp.id, tp.original_name, tp.stored_name, tp.upload_date,
	tp.storage_type, tp.storage_key, tp.public_url, tp.content_type,
tp.marks_obtained, tp.max_marks, tp.test_label, tp.paper_type,
tp.percentage, tp.correct_count, tp.wrong_count, tp.unattempted_count,
tp.physics_marks, tp.chemistry_marks, tp.biology_marks, tp.botany_marks, tp.zoology_marks,
tp.omr_barcode, tp.omr_rank, tp.omr_scan_path, tp.omr_scan_original_name, tp.omr_scan_uploaded_at,
tp.answer_request_id, tp.uploaded_by AS uploaded_by_id,
uploader.name AS uploaded_by_name, uploader.role AS uploaded_by_role
FROM test_papers tp
	LEFT JOIN users uploader ON uploader.id = tp.uploaded_by
		WHERE tp.coaching_id = ? AND tp.branch_id = ? AND tp.student_id = ?
		ORDER BY tp.upload_date DESC
	LIMIT 20
		`, [coachingId, branchId, studentId]);
  papers.forEach((paper) => {
    paper.is_downloadable_paper = (
      (paper.storage_type === 's3' && Boolean(paper.public_url))
      || (paper.storage_type === 'local' && Boolean(paper.storage_key))
    );
  });

	  const attendance = await all(
	    `SELECT attendance_date, status, notes
	     FROM attendance
	     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
	     ORDER BY attendance_date DESC, id DESC
	     LIMIT 30`,
	    [coachingId, branchId, studentId]
	  );

  const fees = await all(
    `SELECT amount, due_date, payment_date, status, notes
     FROM fees
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
     ORDER BY created_at DESC`,
    [coachingId, branchId, studentId]
  );

  const notes = profile?.batch_id
    ? await all(
      `SELECT bn.title, bn.resource_url, bn.description, bn.created_at, bn.batch_id, b.name AS batch_name
       FROM batch_notes bn
       LEFT JOIN batches b ON b.id = bn.batch_id
       WHERE bn.coaching_id = ? AND bn.branch_id = ? AND bn.batch_id = ?
       ORDER BY bn.created_at DESC`,
      [coachingId, branchId, profile.batch_id]
    )
    : profile?.standard || profile?.course
      ? await all(
        `SELECT title, resource_url, description, created_at, batch_id
         FROM batch_notes
         WHERE coaching_id = ? AND branch_id = ?
           AND COALESCE(standard, '') = COALESCE(?, '')
           AND COALESCE(course, '') = COALESCE(?, '')
         ORDER BY created_at DESC`,
        [coachingId, branchId, profile.standard || null, profile.course || null]
      )
      : [];

  const attendanceSummary = await get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count,
       SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count,
       SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_count
     FROM attendance
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`,
    [coachingId, branchId, studentId]
  );

  const feeSummary = await getStudentFeeSummary(coachingId, branchId, studentId);

  const totalAttendance = Number(attendanceSummary?.total || 0);
  const presentCount = Number(attendanceSummary?.present_count || 0);
  const attendancePercent = totalAttendance
    ? ((presentCount / totalAttendance) * 100).toFixed(1)
    : '0.0';

  const { progressSeries, marksSummary } = buildProgressSummaryFromPapers(papers);

  return {
    profile,
    papers,
    attendance,
    fees,
    notes,
    attendanceSummary: {
      total: totalAttendance,
      presentCount,
      absentCount: Number(attendanceSummary?.absent_count || 0),
      lateCount: Number(attendanceSummary?.late_count || 0),
      attendancePercent,
    },
    feeSummary: {
      totalFees: Number(feeSummary.totalFee || 0),
      pendingCount: Number(feeSummary.pendingFee || 0) > 0 ? 1 : 0,
      pendingAmount: Number(feeSummary.pendingFee || 0),
    },
    marksSummary,
    progressSeries,
  };
}

function getSubscriptionState(coaching) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const status = coaching?.subscription_status || 'active';
  const endsAt = parseDateOnly(coaching?.subscription_ends_at);
  const endsAtLabel = coaching?.subscription_ends_at ? formatDateLabel(coaching.subscription_ends_at) : null;
  const daysUntilEnd = endsAt ? Math.round((endsAt.getTime() - today.getTime()) / 86400000) : null;

  let accessBlocked = !['active', 'trial'].includes(status);
  let reason = accessBlocked ? status : null;

  if (!accessBlocked && endsAt && daysUntilEnd < 0) {
    accessBlocked = true;
    reason = 'expired';
  }

  let notice = null;
  if (!accessBlocked && endsAt && daysUntilEnd !== null && daysUntilEnd >= 0 && daysUntilEnd <= 2) {
    if (daysUntilEnd === 0) {
      notice = `Your subscription ends today (${endsAtLabel}). Renew now to avoid interruption.`;
    } else if (daysUntilEnd === 1) {
      notice = `Your subscription ends tomorrow (${endsAtLabel}). Renew to continue without interruption.`;
    } else {
      notice = `Your subscription ends in 2 days (${endsAtLabel}). Renew early to avoid interruption.`;
    }
  }

  let blockedTitle = 'Subscription inactive';
  let blockedMessage = 'Your coaching subscription is inactive. Renew to continue using the portal.';

  if (reason === 'suspended') {
    blockedTitle = 'Subscription suspended';
    blockedMessage = 'Your coaching account is suspended. Renew or reactivate the subscription to continue.';
  } else if (reason === 'cancelled') {
    blockedTitle = 'Subscription cancelled';
    blockedMessage = 'This coaching subscription has been cancelled. Renew it to restore portal access.';
  } else if (reason === 'expired') {
    blockedTitle = 'Subscription expired';
    blockedMessage = `Your subscription ended on ${endsAtLabel}. Renew to continue using the portal.`;
  }

  return {
    status,
    endsAt: coaching?.subscription_ends_at || null,
    endsAtLabel,
    daysUntilEnd,
    notice,
    accessBlocked,
    reason,
    blockedTitle,
    blockedMessage,
  };
}

async function getCoachingBySlug(slug) {
  if (!slug) return null;

  const planSql = buildResolvedPlanSql('cc');

  return get(
    `SELECT cc.*, sp.code AS plan_code, ${planSql.name} AS plan_name, sp.price_inr, ${planSql.maxStudents} AS max_students
     FROM coaching_classes cc
     LEFT JOIN subscription_plans sp ON sp.id = cc.subscription_plan_id
     WHERE cc.slug = ?`,
    [slug]
  );
}

async function getCoachingContextById(id) {
  const planSql = buildResolvedPlanSql('cc');
  return get(
    `SELECT cc.*, sp.code AS plan_code, ${planSql.name} AS plan_name, sp.price_inr, ${planSql.maxStudents} AS max_students
     FROM coaching_classes cc
     LEFT JOIN subscription_plans sp ON sp.id = cc.subscription_plan_id
     WHERE cc.id = ?`,
    [id]
  );
}

function buildSessionUser(user, coaching = null) {
  return {
    id: user.id,
    role: user.is_owner ? 'owner' : user.role,
    isOwner: Boolean(user.is_owner),
    coachingId: user.coaching_id || null,
    coachingName: coaching?.name || null,
    coachingSlug: coaching?.slug || null,
    coachingPlan: coaching?.plan_name || null,
    coachingPlanCode: coaching?.plan_code || null,
    coachingPlanMaxStudents: getStudentLimitValue(coaching),
    coachingSubscriptionStatus: coaching?.subscription_status || null,
    coachingSubscriptionEndsAt: coaching?.subscription_ends_at || null,
    branchId: user.branch_id || null,
    branchCode: user.branch_code || null,
    branchName: user.branch_name || null,
    username: user.username || null,
    rollNo: user.roll_no || null,
    name: user.name || null,
    contactPhone: user.contact_phone || null,
    email: user.email || null,
    batchId: user.batch_id || null,
    batchName: user.batch_name || formatLegacyBatchLabel(user.standard, user.course) || null,
    standard: user.standard || null,
    course: user.course || null,
    legalAcceptedAt: user.legal_accepted_at || null,
    mustChangePassword: Boolean(user.must_change_password),
  };
}

function hasAcceptedAdminLegal(user) {
  return Boolean(
    user?.legal_accepted_at
    || (user?.terms_accepted_at && user?.privacy_accepted_at && user?.saas_accepted_at)
  );
}

async function getAdminLegalAcceptance(userId, coachingId) {
  return get(
    `SELECT id, terms_accepted_at, privacy_accepted_at, saas_accepted_at, legal_accepted_at
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'admin'
     LIMIT 1`,
    [userId, coachingId]
  );
}

async function renderLoginPage(req, res, flash = null) {
  const requestedRole = String(req.query.role || req.body?.role || '').trim().toLowerCase();
  const loginRole = requestedRole === 'student' ? 'student' : 'admin';
  const coaching = await getCoachingBySlug(SINGLE_CLIENT_COACHING_SLUG);
  const branches = coaching ? await all(
    `SELECT id, code, name
     FROM branches
     WHERE coaching_id = ? AND is_active = TRUE
     ORDER BY CASE code WHEN 'satpur' THEN 1 WHEN 'meri' THEN 2 ELSE 3 END, name`,
    [coaching.id]
  ) : [];
  const nextFlash = flash || req.session?.flash || null;
  const captcha = getCaptchaChallenge(req, 'login');
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'auth-login', {
    flash: nextFlash,
    coaching,
    coachingHint: SINGLE_CLIENT_COACHING_SLUG,
    branches,
    selectedBranchCode: String(req.body?.branchCode || req.query?.branch || branches[0]?.code || '').trim(),
    loginRole,
    branding: buildBranding(coaching || { name: SINGLE_CLIENT_NAME, brand_name: SINGLE_CLIENT_NAME, slug: SINGLE_CLIENT_COACHING_SLUG }),
    captcha,
  });
}

async function renderOwnerLoginPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  const captcha = getCaptchaChallenge(req, 'owner-login');
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'owner-login', {
    flash: nextFlash,
    captcha,
  });
}

async function renderOwnerForgotPasswordPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  const captcha = getCaptchaChallenge(req, 'owner-forgot-password');
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'owner-forgot-password', {
    flash: nextFlash,
    captcha,
  });
}

async function renderOwnerResetPasswordPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  if (req.session) req.session.flash = null;
  const resetRequest = req.session?.ownerResetCandidate || null;
  const otpChannels = resetRequest
    ? getOtpChannelOptions({
      email: resetRequest.email,
      contactPhone: resetRequest.contactPhone,
    })
    : getOtpChannelOptions({});
  const captcha = getCaptchaChallenge(req, 'owner-reset-password');

  return renderWithMessage(res, 'owner-reset-password', {
    flash: nextFlash,
    resetRequest,
    otpChannels,
    otpState: buildOtpStatus(req.session?.ownerResetOtp || null),
    captcha,
  });
}

async function renderTrialApplyPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'trial-apply', {
    flash: nextFlash,
    branding: buildBranding(null),
  });
}

async function renderAdminPasswordSetupPage(req, res, flash = null) {
  const coaching = req.currentCoaching || await getCoachingContextById(req.session.user.coachingId);
  const nextFlash = flash || req.session?.flash || null;
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'admin-password-setup', {
    flash: nextFlash,
    user: req.session.user,
    coaching,
    branding: buildBranding(coaching),
  });
}

async function renderAdminForgotPasswordPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  const captcha = getCaptchaChallenge(req, 'admin-forgot-password');
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'admin-forgot-password', {
    flash: nextFlash,
    branding: buildBranding(null),
    captcha,
  });
}

async function renderAdminResetPasswordPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  if (req.session) req.session.flash = null;
  const resetRequest = req.session?.adminResetCandidate || null;
  const otpChannels = resetRequest
    ? getOtpChannelOptions({
      email: resetRequest.email,
      contactPhone: resetRequest.contactPhone,
    })
    : getOtpChannelOptions({});
  const captcha = getCaptchaChallenge(req, 'admin-reset-password');

  return renderWithMessage(res, 'admin-reset-password', {
    flash: nextFlash,
    branding: buildBranding(null),
    resetRequest,
    otpChannels,
    otpState: buildOtpStatus(req.session?.adminResetOtp || null),
    captcha,
  });
}

async function renderTwoFactorPage(req, res, flash = null) {
  const context = await getPendingTwoFactorContext(req);
  if (!context) {
    req.session.flash = { type: 'error', text: 'Start login again to continue.' };
    return res.redirect('/login');
  }

  const nextFlash = flash || req.session?.flash || null;
  if (req.session) req.session.flash = null;
  const otpChannels = getOtpChannelOptions({
    email: context.identity.email,
    contactPhone: context.identity.contactPhone,
  });

  return renderWithMessage(res, 'two-factor', {
    flash: nextFlash,
    branding: buildBranding(context.coaching),
    pendingLogin: context.pending,
    otpChannels,
    otpState: buildOtpStatus(req.session?.loginOtp || null),
    roleLabel: context.pending.isOwner ? 'Owner' : 'Admin',
  });
}

async function issueAdminOtp(req, { sessionKey, userId, coachingId, adminName, className, email, contactPhone, channel, purpose }) {
  const otpChannels = getOtpChannelOptions({ email, contactPhone });
  const selected = otpChannels.email;

  if (!selected?.available || !selected.value) {
    throw new Error(selected?.reason || 'Selected OTP channel is not available');
  }

  const existing = buildOtpStatus(req.session?.[sessionKey] || null);
  if (
    existing
    && !existing.expired
    && existing.channel === channel
    && existing.userId === userId
    && existing.coachingId === coachingId
    && Date.now() - new Date(existing.issuedAt).getTime() < 30000
  ) {
    throw new Error('Please wait 30 seconds before requesting another OTP');
  }

  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + (OTP_TTL_MINUTES * 60 * 1000)).toISOString();

  await sendOtpMessage({
    channel,
    destination: selected.value,
    otpCode,
    adminName,
    className,
    purpose,
  });

  req.session[sessionKey] = {
    userId,
    coachingId,
    adminName,
    className,
    channel,
    destinationMasked: selected.masked,
    code: otpCode,
    issuedAt: new Date().toISOString(),
    expiresAt,
  };

  return req.session[sessionKey];
}

async function deleteCoachingData(coachingId) {
  const papers = await all(
    `SELECT stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ?`,
    [coachingId]
  );

  await withTransaction(async (tx) => {
    await tx.run(`DELETE FROM attendance WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM fees WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM notification_logs WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM whatsapp_logs WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM whatsapp_settings WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM batch_notes WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM answer_upload_requests WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM test_papers WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM users WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM batches WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM coaching_classes WHERE id = ?`, [coachingId]);
  });

  for (const paper of papers) {
    try {
      await deleteStoredPaper(paper);
    } catch (error) {
      console.error('Failed deleting coaching paper asset', error);
    }
  }
}

async function getPaperForUser(id, sessionUser) {
  const paper = await get(
    `SELECT tp.*, u.roll_no, u.coaching_id AS student_coaching_id
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id
     WHERE tp.id = ? AND tp.branch_id = ?
       AND ${getRealPaperFileCondition('tp')}`,
    [id, sessionUser.branchId]
  );

  if (!paper) return null;
  if (sessionUser.isOwner) return null;
  if (sessionUser.role === 'admin' && paper.coaching_id === sessionUser.coachingId && paper.branch_id === sessionUser.branchId) return paper;
  if (sessionUser.role === 'student' && paper.student_id === sessionUser.id && paper.coaching_id === sessionUser.coachingId && paper.branch_id === sessionUser.branchId) return paper;
  return null;
}

function getPapersRedirectPath(sessionUser) {
  return sessionUser?.role === 'admin' ? '/admin/dashboard?section=papers' : '/student/dashboard';
}

app.use(async (req, res, next) => {
  if (!req.session?.user || req.session.user.isOwner) return next();

  const coaching = await getCoachingContextById(req.session.user.coachingId);
  if (!coaching) {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  const branch = await get(
    `SELECT b.id, b.code, b.name
     FROM users u
     JOIN branches b ON b.id = u.branch_id
     WHERE u.id = ? AND u.coaching_id = ? AND u.branch_id = ? AND b.is_active = TRUE
     LIMIT 1`,
    [req.session.user.id, req.session.user.coachingId, req.session.user.branchId]
  );
  if (!branch) {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  const subscriptionState = getSubscriptionState(coaching);
  req.currentCoaching = coaching;
  req.currentBranch = branch;
  req.subscriptionState = subscriptionState;
  req.session.user = {
    ...req.session.user,
    coachingName: coaching.name,
    coachingSlug: coaching.slug,
    coachingPlan: coaching.plan_name || null,
    coachingPlanCode: coaching.plan_code || null,
    coachingPlanMaxStudents: getStudentLimitValue(coaching),
    coachingSubscriptionStatus: coaching.subscription_status,
    coachingSubscriptionEndsAt: coaching.subscription_ends_at || null,
    branchId: branch.id,
    branchCode: branch.code,
    branchName: branch.name,
  };

  if (!subscriptionState.accessBlocked) {
    if (req.path === '/subscription-status') {
      return res.redirect('/');
    }
    return next();
  }

  if (req.session.user.role === 'student') {
    if (req.path === '/subscription-status' || req.path === '/logout') return next();
    return res.redirect('/subscription-status');
  }

  if (req.session.user.role === 'admin') {
    if (req.path === '/logout') return next();
    if (req.path === '/admin/legal' || req.path === '/admin/legal/accept') return next();
    if (req.method === 'GET' && req.path === '/admin/dashboard') return next();
    return res.redirect('/admin/dashboard');
  }

  return next();
});

app.use(async (req, res, next) => {
  if (!req.session.user || req.session.user.isOwner || req.session.user.role !== 'admin') {
    return next();
  }

  if (
    req.path === '/logout'
    || req.path === '/admin/legal'
    || req.path === '/admin/legal/accept'
    || req.path === '/admin/password/setup'
    || req.path === '/admin/password/setup/save'
  ) {
    return next();
  }

  const acceptance = await getAdminLegalAcceptance(req.session.user.id, req.session.user.coachingId);
  if (!acceptance || hasAcceptedAdminLegal(acceptance)) {
    req.session.user.legalAcceptedAt = acceptance?.legal_accepted_at || acceptance?.terms_accepted_at || null;
    return next();
  }

  return res.redirect('/admin/legal');
});

app.use(async (req, res, next) => {
  if (!req.session.user || req.session.user.isOwner || req.session.user.role !== 'admin') {
    return next();
  }

  if (
    req.path === '/logout'
    || req.path === '/admin/password/setup'
    || req.path === '/admin/password/setup/save'
    || req.path === '/admin/legal'
    || req.path === '/admin/legal/accept'
  ) {
    return next();
  }

  const admin = await get(
    `SELECT must_change_password
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'admin'
     LIMIT 1`,
    [req.session.user.id, req.session.user.coachingId]
  );

  if (!admin?.must_change_password) {
    req.session.user.mustChangePassword = false;
    return next();
  }

  req.session.user.mustChangePassword = true;
  return res.redirect('/admin/password/setup');
});

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
  return res.redirect('/student/dashboard');
});

app.get('/login', async (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  return renderLoginPage(req, res);
});

app.get('/test-mail', async (req, res) => {
  const debugSecret = String(process.env.MAIL_DEBUG_SECRET || '').trim();
  const providedSecret = String(req.query.secret || '').trim();
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpFrom = String(process.env.SMTP_FROM || '').trim();
  const resendFrom = String(process.env.RESEND_FROM || '').trim();
  const ownerEmail = String(process.env.OWNER_2FA_EMAIL || '').trim();
  const targetEmail = String(req.query.to || ownerEmail || smtpUser).trim();
  const provider = resendConfigured() ? 'resend' : 'smtp';

  if (debugSecret && (!providedSecret || !timingSafeEqualString(providedSecret, debugSecret))) {
    return res.status(403).json({
      ok: false,
      error: 'Invalid debug secret',
      hint: 'Pass ?secret=YOUR_MAIL_DEBUG_SECRET',
    });
  }

  if (!targetEmail) {
    return res.status(400).json({
      ok: false,
      error: 'No target email available. Set OWNER_2FA_EMAIL or pass ?to=',
      config: {
        provider,
        smtpConfigured: smtpConfigured(),
        resendConfigured: resendConfigured(),
        smtpUserSet: Boolean(smtpUser),
        smtpPassSet: Boolean(process.env.SMTP_PASS),
        smtpFromSet: Boolean(smtpFrom),
        resendFromSet: Boolean(resendFrom),
        resendApiKeySet: Boolean(process.env.RESEND_API_KEY),
      },
    });
  }

  try {
    const info = await sendTestEmail({
      to: targetEmail,
      subject: 'TEST MAIL',
      text: 'Working rocket',
    });

    return res.json({
      ok: true,
      message: 'MAIL SENT',
      provider,
      to: targetEmail,
      smtpUser,
      smtpFrom,
      resendFrom,
      messageId: info.messageId || null,
      resendId: info.id || null,
    });
  } catch (err) {
    console.error('MAIL ERROR:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Mail send failed',
      code: err.code || null,
      command: err.command || null,
      responseCode: err.responseCode || null,
      smtp: {
        host: String(process.env.SMTP_HOST || '').trim(),
        port: Number(process.env.SMTP_PORT || 0),
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        family: Number(process.env.SMTP_FAMILY || 4),
        provider,
        smtpConfigured: smtpConfigured(),
        resendConfigured: resendConfigured(),
        smtpUserSet: Boolean(smtpUser),
        smtpPassSet: Boolean(process.env.SMTP_PASS),
        smtpFromSet: Boolean(smtpFrom),
        resendFromSet: Boolean(resendFrom),
        resendApiKeySet: Boolean(process.env.RESEND_API_KEY),
      },
    });
  }
});

app.get('/admin/forgot-password', async (req, res) => {
  if (req.session.user) return res.redirect('/');
  return renderAdminForgotPasswordPage(req, res);
});

app.post('/admin/forgot-password', async (req, res) => {
  const retryAfter = enforceRateLimit(req, 'admin-forgot-password', 5, 15 * 60 * 1000);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    req.session.flash = { type: 'error', text: 'Too many reset attempts. Please wait a few minutes and try again.' };
    return res.redirect('/admin/forgot-password');
  }

  if (!verifyCaptcha(req, 'admin-forgot-password', req.body.captchaAnswer)) {
    return renderAdminForgotPasswordPage(req, res, {
      type: 'error',
      text: 'Security check failed. Please solve the CAPTCHA again.',
    });
  }

  const className = (req.body.className || '').trim();
  const adminName = (req.body.adminName || '').trim();
  const contactPhone = (req.body.contactPhone || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();

  if (!className || !adminName || !contactPhone || !email) {
    return renderAdminForgotPasswordPage(req, res, {
      type: 'error',
      text: 'Class name, admin name, contact number, and email are required',
    });
  }

  const admin = await get(
    `SELECT u.id, u.coaching_id, u.name, u.contact_phone, u.email, cc.name AS class_name, cc.brand_name
     FROM users u
     JOIN coaching_classes cc ON cc.id = u.coaching_id
     WHERE u.role = 'admin'
       AND u.is_owner = 0
       AND LOWER(u.name) = LOWER(?)
       AND u.contact_phone = ?
       AND LOWER(COALESCE(u.email, '')) = LOWER(?)
       AND (
         LOWER(cc.name) = LOWER(?)
         OR LOWER(COALESCE(cc.brand_name, '')) = LOWER(?)
       )
     LIMIT 1`,
    [adminName, contactPhone, email, className, className]
  );

  if (!admin) {
    return renderAdminForgotPasswordPage(req, res, {
      type: 'error',
      text: 'No matching admin account was found with those details',
    });
  }

  req.session.adminResetCandidate = {
    userId: admin.id,
    coachingId: admin.coaching_id,
    className: admin.class_name,
    adminName: admin.name,
    contactPhone: admin.contact_phone || contactPhone,
    email: admin.email || email,
    issuedAt: new Date().toISOString(),
  };
  delete req.session.adminResetOtp;

  return res.redirect('/admin/reset-password');
});

app.post('/admin/reset-password/send-otp', async (req, res) => {
  const retryAfter = enforceRateLimit(req, 'admin-reset-password-otp', OTP_SEND_LIMIT, OTP_SEND_WINDOW_MS);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    req.session.flash = { type: 'error', text: `Too many OTP requests. Please wait ${retryAfter}s and try again.` };
    return res.redirect('/admin/reset-password');
  }

  if (!verifyCaptcha(req, 'admin-reset-password', req.body.captchaAnswer)) {
    req.session.flash = { type: 'error', text: 'Security check failed. Please solve the CAPTCHA again.' };
    return res.redirect('/admin/reset-password');
  }

  const candidate = req.session?.adminResetCandidate;
  if (!candidate) {
    req.session.flash = { type: 'error', text: 'Start with the forgot password form first' };
    return res.redirect('/admin/forgot-password');
  }

  const channel = String(req.body.channel || '').trim() === 'sms' ? 'sms' : 'email';

  try {
    const otp = await issueAdminOtp(req, {
      sessionKey: 'adminResetOtp',
      userId: candidate.userId,
      coachingId: candidate.coachingId,
      adminName: candidate.adminName,
      className: candidate.className,
      email: candidate.email,
      contactPhone: candidate.contactPhone,
      channel: 'email',
      purpose: 'forgot-password',
    });

    req.session.flash = {
      type: 'success',
      text: `OTP sent to ${otp.destinationMasked}. It is valid for ${OTP_TTL_MINUTES} minutes.`,
    };
  } catch (error) {
    req.session.flash = { type: 'error', text: error.message || 'Failed to send OTP' };
  }

  return res.redirect('/admin/reset-password');
});

app.get('/admin/reset-password', async (req, res) => {
  if (!req.session?.adminResetCandidate) {
    req.session.flash = { type: 'error', text: 'Start with the forgot password form first' };
    return res.redirect('/admin/forgot-password');
  }

  return renderAdminResetPasswordPage(req, res);
});

app.post('/admin/reset-password', async (req, res) => {
  const candidate = req.session?.adminResetCandidate;
  const otpSession = buildOtpStatus(req.session?.adminResetOtp || null);
  if (!candidate) {
    req.session.flash = { type: 'error', text: 'Start with the forgot password form first' };
    return res.redirect('/admin/forgot-password');
  }

  const otp = (req.body.otp || '').trim();
  const newPassword = (req.body.newPassword || '').trim();
  const confirmPassword = (req.body.confirmPassword || '').trim();

  if (!verifyCaptcha(req, 'admin-reset-password', req.body.captchaAnswer)) {
    return renderAdminResetPasswordPage(req, res, {
      type: 'error',
      text: 'Security check failed. Please solve the CAPTCHA again.',
    });
  }

  if (!otpSession || otpSession.userId !== candidate.userId || otpSession.coachingId !== candidate.coachingId) {
    return renderAdminResetPasswordPage(req, res, {
      type: 'error',
      text: 'Request an OTP first to continue',
    });
  }

  if (otpSession.expired) {
    delete req.session.adminResetOtp;
    return renderAdminResetPasswordPage(req, res, {
      type: 'error',
      text: 'OTP expired. Request a new OTP and try again.',
    });
  }

  if (!otp || otp !== otpSession.code) {
    return renderAdminResetPasswordPage(req, res, {
      type: 'error',
      text: 'Invalid OTP entered',
    });
  }

  const passwordError = validateAdminPasswordStrength(newPassword);
  if (passwordError) {
    return renderAdminResetPasswordPage(req, res, {
      type: 'error',
      text: passwordError,
    });
  }

  if (newPassword !== confirmPassword) {
    return renderAdminResetPasswordPage(req, res, {
      type: 'error',
      text: 'New password and confirm password must match',
    });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await run(
    `UPDATE users
     SET password_hash = ?, must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND coaching_id = ? AND role = 'admin'`,
    [passwordHash, candidate.userId, candidate.coachingId]
  );

  delete req.session.adminResetCandidate;
  delete req.session.adminResetOtp;
  req.session.flash = { type: 'success', text: 'Password reset successful. You can now log in with your new password.' };
  return res.redirect('/login');
});

app.all('/trial/apply', (req, res) => res.redirect('/login'));

app.get('/trial/apply', async (req, res) => {
  if (req.session.user) return res.redirect('/');
  return renderTrialApplyPage(req, res);
});

app.get('/owner/login', async (req, res) => {
  if (req.session.user?.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user) return res.redirect('/');
  return renderOwnerLoginPage(req, res);
});

app.get('/owner/forgot-password', async (req, res) => {
  if (req.session.user?.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user) return res.redirect('/');
  return renderOwnerForgotPasswordPage(req, res);
});

app.post('/owner/forgot-password', async (req, res) => {
  const retryAfter = enforceRateLimit(req, 'owner-forgot-password', 5, 15 * 60 * 1000);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    req.session.flash = { type: 'error', text: 'Too many reset attempts. Please wait a few minutes and try again.' };
    return res.redirect('/owner/forgot-password');
  }

  if (!verifyCaptcha(req, 'owner-forgot-password', req.body.captchaAnswer)) {
    return renderOwnerForgotPasswordPage(req, res, {
      type: 'error',
      text: 'Security check failed. Please solve the CAPTCHA again.',
    });
  }

  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!username || !email) {
    return renderOwnerForgotPasswordPage(req, res, {
      type: 'error',
      text: 'Owner username and email are required.',
    });
  }

  const owner = await get(`SELECT u.* FROM users u JOIN branches b ON b.id = u.branch_id AND b.coaching_id = u.coaching_id WHERE u.is_owner = 1 AND b.code = ? AND b.name = ? AND LOWER(u.username) = LOWER(?) LIMIT 1`, [MERI_BRANCH_CODE, MERI_BRANCH_NAME, username]);
  if (!owner) {
    return renderOwnerForgotPasswordPage(req, res, {
      type: 'error',
      text: 'Owner account not found.',
    });
  }

  const identity = getTwoFactorIdentity(owner, null);
  if (String(identity.email || '').toLowerCase() !== email) {
    return renderOwnerForgotPasswordPage(req, res, {
      type: 'error',
      text: 'Email does not match the owner recovery email.',
    });
  }

  req.session.ownerResetCandidate = {
    userId: owner.id,
    username: owner.username,
    email: identity.email,
    contactPhone: identity.contactPhone,
    ownerName: owner.name || 'Owner',
    issuedAt: new Date().toISOString(),
  };
  delete req.session.ownerResetOtp;

  return res.redirect('/owner/reset-password');
});

app.get('/owner/reset-password', async (req, res) => {
  if (!req.session?.ownerResetCandidate) {
    req.session.flash = { type: 'error', text: 'Start with the owner forgot password form first.' };
    return res.redirect('/owner/forgot-password');
  }

  return renderOwnerResetPasswordPage(req, res);
});

app.post('/owner/reset-password/send-otp', async (req, res) => {
  const retryAfter = enforceRateLimit(req, 'owner-reset-password-otp', OTP_SEND_LIMIT, OTP_SEND_WINDOW_MS);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    req.session.flash = { type: 'error', text: `Too many OTP requests. Please wait ${retryAfter}s and try again.` };
    return res.redirect('/owner/reset-password');
  }

  if (!verifyCaptcha(req, 'owner-reset-password', req.body.captchaAnswer)) {
    req.session.flash = { type: 'error', text: 'Security check failed. Please solve the CAPTCHA again.' };
    return res.redirect('/owner/reset-password');
  }

  const candidate = req.session?.ownerResetCandidate;
  if (!candidate) {
    req.session.flash = { type: 'error', text: 'Start with the owner forgot password form first.' };
    return res.redirect('/owner/forgot-password');
  }

  try {
    const otp = await issueAdminOtp(req, {
      sessionKey: 'ownerResetOtp',
      userId: candidate.userId,
      coachingId: 0,
      adminName: candidate.ownerName,
      className: 'Owner Control Room',
      email: candidate.email,
      contactPhone: candidate.contactPhone,
      channel: 'email',
      purpose: 'forgot-password',
    });

    req.session.flash = {
      type: 'success',
      text: `OTP sent to ${otp.destinationMasked}. It is valid for ${OTP_TTL_MINUTES} minutes.`,
    };
  } catch (error) {
    req.session.flash = { type: 'error', text: error.message || 'Failed to send OTP' };
  }

  return res.redirect('/owner/reset-password');
});

app.post('/owner/reset-password', async (req, res) => {
  const candidate = req.session?.ownerResetCandidate;
  const otpSession = buildOtpStatus(req.session?.ownerResetOtp || null);

  if (!candidate) {
    req.session.flash = { type: 'error', text: 'Start with the owner forgot password form first.' };
    return res.redirect('/owner/forgot-password');
  }

  if (!verifyCaptcha(req, 'owner-reset-password', req.body.captchaAnswer)) {
    return renderOwnerResetPasswordPage(req, res, {
      type: 'error',
      text: 'Security check failed. Please solve the CAPTCHA again.',
    });
  }

  const otp = String(req.body.otp || '').trim();
  const newPassword = String(req.body.newPassword || '').trim();
  const confirmPassword = String(req.body.confirmPassword || '').trim();

  if (!otpSession || otpSession.userId !== candidate.userId) {
    return renderOwnerResetPasswordPage(req, res, {
      type: 'error',
      text: 'Request an OTP first to continue.',
    });
  }

  if (otpSession.expired) {
    delete req.session.ownerResetOtp;
    return renderOwnerResetPasswordPage(req, res, {
      type: 'error',
      text: 'OTP expired. Request a new OTP and try again.',
    });
  }

  if (!timingSafeEqualString(otp, otpSession.code)) {
    return renderOwnerResetPasswordPage(req, res, {
      type: 'error',
      text: 'Invalid OTP entered.',
    });
  }

  const passwordError = validateAdminPasswordStrength(newPassword);
  if (passwordError) {
    return renderOwnerResetPasswordPage(req, res, {
      type: 'error',
      text: passwordError,
    });
  }

  if (newPassword !== confirmPassword) {
    return renderOwnerResetPasswordPage(req, res, {
      type: 'error',
      text: 'New password and confirm password must match.',
    });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await run(
    `UPDATE users
     SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND is_owner = 1`,
    [passwordHash, candidate.userId]
  );

  delete req.session.ownerResetCandidate;
  delete req.session.ownerResetOtp;
  req.session.flash = { type: 'success', text: 'Owner password reset successful. You can now sign in.' };
  return res.redirect('/owner/login');
});

app.post('/login', async (req, res) => {
  const retryAfter = enforceRateLimit(req, 'login', 10, 15 * 60 * 1000);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return renderLoginPage(req, res, {
      type: 'error',
      text: 'Too many login attempts. Please wait a few minutes and try again.',
    });
  }

  const role = (req.body.role || '').trim();
  const username = (req.body.username || '').trim();
  const submittedPassword = req.body.password || '';
  const password = submittedPassword;
  const coachingSlug = SINGLE_CLIENT_COACHING_SLUG;
  const branchCode = String(req.body.branchCode || '').trim().toLowerCase();

  if (!verifyCaptcha(req, 'login', req.body.captchaAnswer)) {
    return renderLoginPage(req, res, {
      type: 'error',
      text: 'Security check failed. Please solve the CAPTCHA again.',
    });
  }

  let user = null;
  let coaching = null;

  if (role === 'admin' || role === 'student') {
    coaching = await getCoachingBySlug(coachingSlug);

    if (!coaching) {
      return renderLoginPage(req, res, { type: 'error', text: `${SINGLE_CLIENT_NAME} portal is not configured yet.` });
    }

    const branch = await get(
      `SELECT id, code, name
       FROM branches
       WHERE coaching_id = ? AND code = ? AND is_active = TRUE
       LIMIT 1`,
      [coaching.id, branchCode]
    );
    if (!branch) {
      return renderLoginPage(req, res, { type: 'error', text: 'Select a valid branch' });
    }

    if (role === 'admin') {
      user = await get(
        `SELECT u.*, b.code AS branch_code, b.name AS branch_name
         FROM users u
         JOIN branches b ON b.id = u.branch_id
         WHERE u.coaching_id = ? AND u.branch_id = ?
           AND u.role = 'admin' AND u.is_owner = 0 AND LOWER(u.username) = LOWER(?)
         LIMIT 1`,
        [coaching.id, branch.id, username]
      );
    } else {
      user = await get(
        `SELECT u.*, b.code AS branch_code, b.name AS branch_name
         FROM users u
         JOIN branches b ON b.id = u.branch_id
         WHERE u.coaching_id = ? AND u.branch_id = ?
           AND u.role = 'student' AND u.roll_no = ?
         LIMIT 1`,
        [coaching.id, branch.id, username]
      );
    }
  }

  if (!['admin', 'student'].includes(role)) {
    return renderLoginPage(req, res, { type: 'error', text: 'Select a valid login type' });
  }

  if (!user || user.is_disabled) {
    return renderLoginPage(req, res, { type: 'error', text: 'Invalid credentials' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return renderLoginPage(req, res, { type: 'error', text: 'Invalid credentials' });
  }

  if (role === 'admin') {
    const identity = getTwoFactorIdentity(user, coaching);
    const otpChannels = getOtpChannelOptions({
      email: identity.email,
      contactPhone: identity.contactPhone,
    });
    if (!otpChannels.email.available) {
      return renderLoginPage(req, res, {
        type: 'error',
        text: 'Two-factor login is not configured for this admin account yet. Add admin email and configure SMTP first.',
      });
    }
    await createPendingTwoFactorLogin(req, user, coaching);
    delete req.session.loginOtp;
    return res.redirect('/auth/2fa');
  }

  return finishAuthenticatedLogin(req, res, user, coaching);
});

app.post('/trial/apply', async (req, res) => {
  const className = (req.body.className || '').trim();
  const applicantName = (req.body.applicantName || '').trim();
  const contactPhone = (req.body.contactPhone || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const whatsappNumber = (req.body.whatsappNumber || '').trim();
  const logoUrl = normalizeLogoUrl(req.body.logoUrl);
  const studentRequirement = Number.parseInt(String(req.body.studentRequirement || '').trim(), 10);

  if (!className || !applicantName || !contactPhone || !email || !whatsappNumber) {
    return renderTrialApplyPage(req, res, { type: 'error', text: 'Class name, your name, contact, email, and WhatsApp are required' });
  }

  if (!isValidEmail(email)) {
    return renderTrialApplyPage(req, res, { type: 'error', text: 'Please enter a valid email address' });
  }

  if (logoUrl && !isValidHttpUrl(logoUrl)) {
    return renderTrialApplyPage(req, res, { type: 'error', text: 'Logo URL must be a valid http/https link' });
  }

  if (!Number.isInteger(studentRequirement) || studentRequirement <= 0) {
    return renderTrialApplyPage(req, res, { type: 'error', text: 'Student requirement must be a positive whole number' });
  }

  const existingPending = await get(
    `SELECT id
     FROM trial_requests
     WHERE status = 'pending' AND (LOWER(email) = LOWER(?) OR contact_phone = ? OR whatsapp_number = ?)
     LIMIT 1`,
    [email, contactPhone, whatsappNumber]
  );

  if (existingPending) {
    return renderTrialApplyPage(req, res, {
      type: 'error',
      text: 'A pending trial request already exists with this email or contact number',
    });
  }

  await run(
    `INSERT INTO trial_requests (
      class_name, applicant_name, contact_phone, email, whatsapp_number, logo_url, student_requirement, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [className, applicantName, contactPhone, email, whatsappNumber, logoUrl || null, studentRequirement]
  );

  req.session.flash = {
    type: 'success',
    text: 'Trial request submitted successfully. The owner will review it and contact you manually with login details.',
  };
  return res.redirect('/login');
});

app.post('/owner/login', async (req, res) => {
  const retryAfter = enforceRateLimit(req, 'owner-login', 8, 15 * 60 * 1000);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return renderOwnerLoginPage(req, res, {
      type: 'error',
      text: 'Too many login attempts. Please wait a few minutes and try again.',
    });
  }

  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  if (!verifyCaptcha(req, 'owner-login', req.body.captchaAnswer)) {
    return renderOwnerLoginPage(req, res, {
      type: 'error',
      text: 'Security check failed. Please solve the CAPTCHA again.',
    });
  }

  const user = await get(
    `SELECT u.*, b.code AS branch_code, b.name AS branch_name
     FROM users u
     JOIN branches b ON b.id = u.branch_id AND b.coaching_id = u.coaching_id
     WHERE u.is_owner = 1 AND u.role IN ('owner', 'super_admin', 'admin')
       AND b.code = ? AND b.name = ? AND LOWER(u.username) = LOWER(?)
     LIMIT 1`,
    [MERI_BRANCH_CODE, MERI_BRANCH_NAME, username]
  );

  if (!user || user.is_disabled) {
    return renderOwnerLoginPage(req, res, { type: 'error', text: 'Invalid owner credentials' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return renderOwnerLoginPage(req, res, { type: 'error', text: 'Invalid owner credentials' });
  }

  const identity = getTwoFactorIdentity(user, null);
  const otpChannels = getOtpChannelOptions({
    email: identity.email,
    contactPhone: identity.contactPhone,
  });
  if (!otpChannels.email.available) {
    return renderOwnerLoginPage(req, res, {
      type: 'error',
      text: 'Two-factor login is not configured for the owner account yet. Add OWNER_2FA_EMAIL and configure SMTP first.',
    });
  }

  await createPendingTwoFactorLogin(req, user, null);
  delete req.session.loginOtp;
  return res.redirect('/auth/2fa');
});

app.get('/auth/2fa', async (req, res) => {
  logTwoFactorSession(req, 'GET /auth/2fa render');
  return renderTwoFactorPage(req, res);
});

async function handleTwoFactorSendOtp(req, res) {
  const retryAfter = enforceRateLimit(req, 'auth-2fa-send-otp', OTP_SEND_LIMIT, OTP_SEND_WINDOW_MS);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    req.session.flash = { type: 'error', text: `Too many OTP requests. Please wait ${retryAfter}s and try again.` };
    return res.redirect('/auth/2fa');
  }

  const context = await getPendingTwoFactorContext(req);
  if (!context) {
    req.session.flash = { type: 'error', text: 'Start login again to continue.' };
    return res.redirect('/login');
  }

  try {
    const otp = await issueAdminOtp(req, {
      sessionKey: 'loginOtp',
      userId: context.user.id,
      coachingId: context.user.coaching_id || 0,
      adminName: context.identity.adminName,
      className: context.identity.className,
      email: context.identity.email,
      contactPhone: context.identity.contactPhone,
      channel: 'email',
      purpose: 'login-2fa',
    });

    req.session.flash = {
      type: 'success',
      text: `Verification code sent to ${otp.destinationMasked}. It is valid for ${OTP_TTL_MINUTES} minutes.`,
    };
  } catch (error) {
    req.session.flash = { type: 'error', text: error.message || 'Failed to send verification code' };
  }

  return res.redirect('/auth/2fa');
}

async function handleTwoFactorVerify(req, res, options = {}) {
  const failTwoFactor = (flash) => {
    req.session.flash = flash;
    if (options.renderOnFailure) {
      return renderTwoFactorPage(req, res);
    }

    return res.redirect('/auth/2fa');
  };

  const retryAfter = enforceRateLimit(req, 'auth-2fa-verify', 8, 15 * 60 * 1000);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return failTwoFactor({ type: 'error', text: 'Too many verification attempts. Please wait a few minutes and try again.' });
  }

  const context = await getPendingTwoFactorContext(req);
  const otpSession = buildOtpStatus(req.session?.loginOtp || null);
  const code = String(req.body.otp || '').trim();

  if (!context) {
    req.session.flash = { type: 'error', text: 'Start login again to continue.' };
    return res.redirect('/login');
  }

  if (!otpSession || otpSession.userId !== context.user.id) {
    return failTwoFactor({ type: 'error', text: 'Request a verification code first.' });
  }

  if (otpSession.expired) {
    delete req.session.loginOtp;
    return failTwoFactor({ type: 'error', text: 'Verification code expired. Request a new one.' });
  }

  if (!timingSafeEqualString(code, otpSession.code)) {
    return failTwoFactor({ type: 'error', text: 'Invalid verification code.' });
  }

  const coaching = context.user.coaching_id ? await getCoachingContextById(context.user.coaching_id) : null;
  delete req.session.pendingLogin;
  delete req.session.loginOtp;
  await writeAuditLog({
    actorId: context.user.id,
    actorRole: context.pending.isOwner ? 'owner' : context.user.role,
    coachingId: context.user.coaching_id || null,
    action: 'two_factor_login_verified',
    targetType: context.pending.isOwner ? 'owner' : 'admin',
    targetId: context.user.id,
    details: { channel: otpSession.channel },
    req,
  });
  return finishAuthenticatedLogin(req, res, context.user, coaching);
}

app.post('/auth/2fa', async (req, res) => {
  logTwoFactorSession(req, 'POST /auth/2fa');
  const submittedOtp = String(req.body?.otp || '').trim();
  if (submittedOtp) {
    return handleTwoFactorVerify(req, res, { renderOnFailure: true });
  }

  return renderTwoFactorPage(req, res, {
    type: 'error',
    text: 'Use the Send Code button first, then submit the verification code.',
  });
});

app.post('/auth/2fa/send-otp', async (req, res) => {
  logTwoFactorSession(req, 'POST /auth/2fa/send-otp');
  return handleTwoFactorSendOtp(req, res);
});

app.post('/auth/2fa/verify', async (req, res) => {
  logTwoFactorSession(req, 'POST /auth/2fa/verify');
  return handleTwoFactorVerify(req, res);
});

app.get('/webhook/whatsapp', async (req, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const envVerifyToken = String(process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN || '').trim();

  let isValidToken = Boolean(envVerifyToken && token === envVerifyToken);
  if (!isValidToken && token) {
    const setting = await get(
      `SELECT id FROM whatsapp_settings WHERE verify_token = ? LIMIT 1`,
      [token]
    );
    isValidToken = Boolean(setting);
  }

  if (mode === 'subscribe' && isValidToken) {
    return res.status(200).send(challenge);
  }

  return res.status(403).send('Forbidden');
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('WHATSAPP WEBHOOK HIT');
    console.log(JSON.stringify(req.body, null, 2));

    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const statuses = Array.isArray(change?.value?.statuses) ? change.value.statuses : [];
        for (const statusEvent of statuses) {
          try {
            await updateWhatsAppLogStatus(statusEvent.id, statusEvent.status, statusEvent.errors);
          } catch (error) {
            console.error('[WHATSAPP BOT ERROR]', error);
          }
        }

        const incomingMessages = Array.isArray(change?.value?.messages) ? change.value.messages : [];
        const phoneNumberId = String(change?.value?.metadata?.phone_number_id || '').trim();
        if (incomingMessages.length && phoneNumberId) {
          console.log('[WEBHOOK] Phone number ID:', phoneNumberId);
          for (const incomingMessage of incomingMessages) {
            let coaching = null;
            const incomingText = incomingMessage?.text?.body
              || incomingMessage?.interactive?.button_reply?.title
              || incomingMessage?.interactive?.button_reply?.id
              || incomingMessage?.interactive?.list_reply?.title
              || incomingMessage?.interactive?.list_reply?.id
              || '';
            const msg = incomingText.trim().toLowerCase();
            console.log('[WEBHOOK] Message received');
            console.log('[WEBHOOK] Incoming text:', incomingText);
            console.log('Incoming message:', incomingText);
            if (!msg) continue;

            try {
              let student = await findStudentByParentPhoneAnyCoaching(incomingMessage.from);
              if (student) {
                coaching = {
                  coaching_id: student.coaching_id,
                  branch_id: student.branch_id,
                  name: student.coaching_name,
                  contact_email: student.contact_email,
                  phone: phoneNumberId,
                  admin_contact_phone: student.admin_contact_phone,
                  contact_phone: student.contact_phone,
                  whatsapp_number: student.admin_whatsapp_number,
                };
                console.log('[STUDENT] Sender phone lookup result:', {
                  id: student.id,
                  rollNo: student.roll_no,
                  coachingId: student.coaching_id,
                  branchId: student.branch_id,
                });
              } else if (!coaching) {
                coaching = await getCoachingByWhatsAppPhoneNumberId(phoneNumberId);
                console.log('[COACHING] Lookup result:', coaching ? {
                  coachingId: coaching.coaching_id,
                  branchId: coaching.branch_id,
                  name: coaching.name,
                  phoneNumberId,
                } : null);
              }
              if (!coaching) {
                console.error('[COACHING] No coaching found for phone number ID or sender phone', {
                  phoneNumberId,
                  from: incomingMessage.from,
                });
                continue;
              }
              if (!student) {
                student = await findStudentByParentPhone(
                  coaching.coaching_id,
                  incomingMessage.from,
                  coaching.branch_id || null
                );
              }
              console.log('[STUDENT] Direct phone lookup result:', student ? {
                id: student.id,
                rollNo: student.roll_no,
                coachingId: student.coaching_id,
              } : null);
              if (!student) {
                student = await findStudentByParentSession(
                  coaching.coaching_id,
                  incomingMessage.from,
                  coaching.branch_id || null
                );
                console.log('[STUDENT] Session lookup result:', student ? {
                  id: student.id,
                  rollNo: student.roll_no,
                  coachingId: student.coaching_id,
                } : null);
              }
              if (!student) {
                console.error('WhatsApp parent assistant student not found', {
                  phoneNumberId,
                  from: incomingMessage.from,
                });
                continue;
              }
              const handled = await handleParentAssistantMessage({
                coaching,
                student,
                from: incomingMessage.from,
                text: incomingText,
              });
              console.log('[PARENT ASSISTANT RESULT]', handled);
            } catch (error) {
              console.error('WhatsApp parent assistant failed', {
                phoneNumberId,
                from: incomingMessage.from,
                error: error.message,
              });
              console.error('Parent Assistant Error', error);
              console.error(error.stack);
            }
          }
        }

      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('[WHATSAPP BOT ERROR]', error);
    return res.sendStatus(200);
  }
});

app.get('/cron/whatsapp/fee-reminders', async (req, res) => {
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  if (!cronSecret) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is required for scheduled WhatsApp reminders' });
  }

  const authorization = String(req.headers.authorization || '').trim();
  if (authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const summary = await sendScheduledFeeReminders();
  return res.json({ ok: true, summary });
});

app.get('/cron/whatsapp/onboarding-retries', async (req, res) => {
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  if (!cronSecret) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is required for onboarding retries' });
  }
  if (String(req.headers.authorization || '').trim() !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const summary = await retryPendingOnboarding();
  return res.json({ ok: true, summary });
});

app.get('/cron/whatsapp/monthly-parent-reports', async (req, res) => {
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  if (!cronSecret) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is required for scheduled WhatsApp reports' });
  }

  const authorization = String(req.headers.authorization || '').trim();
  if (authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const now = new Date();
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthKey = `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, '0')}`;
  const summary = await sendMonthlyParentReports({ monthKey });
  return res.json({ ok: true, monthKey, summary });
});

app.post('/logout', (req, res) => {
  const sessionUser = req.session?.user || null;
  const preview = getAdminStudentPreviewSession(req);
  const logoutContext = String(req.body?.logoutContext || '').trim().toLowerCase();

  if (logoutContext === 'admin-student-preview' && preview) {
    clearAdminStudentPreview(req);
    return res.redirect(preview.returnTo || '/admin/dashboard');
  }

  const redirectTarget = buildRoleAwareLoginUrl(sessionUser);
  clearAdminStudentPreview(req);
  req.session.destroy(() => res.redirect(redirectTarget));
});

app.get('/subscription-status', requireAuth, async (req, res) => {
  if (req.session.user.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');

  const coaching = req.currentCoaching || await getCoachingContextById(req.session.user.coachingId);
  const subscriptionState = req.subscriptionState || getSubscriptionState(coaching);
  if (!subscriptionState.accessBlocked) return res.redirect('/student/dashboard');

  return renderWithMessage(res, 'subscription-status', {
    user: req.session.user,
    coaching,
    subscriptionState,
    branding: buildBranding(coaching),
  });
});

app.get('/admin/legal', requireCoachingAdmin, async (req, res) => {
  const coaching = req.currentCoaching || await getCoachingContextById(req.session.user.coachingId);
  const acceptance = await getAdminLegalAcceptance(req.session.user.id, req.session.user.coachingId);

  if (hasAcceptedAdminLegal(acceptance)) {
    return res.redirect('/admin/dashboard');
  }

  renderWithMessage(res, 'admin-legal', {
    user: req.session.user,
    coaching,
    branding: buildBranding(coaching),
    flash: req.session.flash,
  });
  req.session.flash = null;
});

app.post('/admin/legal/accept', requireCoachingAdmin, async (req, res) => {
  const acceptedTerms = req.body.acceptTerms === 'on';
  const acceptedPrivacy = req.body.acceptPrivacy === 'on';
  const acceptedPortal = req.body.acceptPortal === 'on';

  if (!acceptedTerms || !acceptedPrivacy || !acceptedPortal) {
    req.session.flash = {
      type: 'error',
      text: 'You must accept the Terms and Conditions, Privacy Policy, and Portal Usage Agreement to continue.',
    };
    return res.redirect('/admin/legal');
  }

  await run(
    `UPDATE users
     SET terms_accepted_at = COALESCE(terms_accepted_at, CURRENT_TIMESTAMP),
         privacy_accepted_at = COALESCE(privacy_accepted_at, CURRENT_TIMESTAMP),
         saas_accepted_at = COALESCE(saas_accepted_at, CURRENT_TIMESTAMP),
         legal_accepted_at = COALESCE(legal_accepted_at, CURRENT_TIMESTAMP)
     WHERE id = ? AND coaching_id = ? AND role = 'admin'`,
    [req.session.user.id, req.session.user.coachingId]
  );

  req.session.user.legalAcceptedAt = new Date().toISOString();
  await auditActor(req, 'admin_legal_accepted', {
    targetType: 'coaching',
    targetId: req.session.user.coachingId,
  });
  req.session.flash = { type: 'success', text: 'Agreement accepted. Welcome to your dashboard.' };
  return res.redirect('/admin/dashboard');
});

app.get('/admin/password/setup', requireCoachingAdmin, async (req, res) => {
  const admin = await get(
    `SELECT must_change_password
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'admin'
     LIMIT 1`,
    [req.session.user.id, req.session.user.coachingId]
  );

  if (!admin?.must_change_password) {
    req.session.user.mustChangePassword = false;
    return res.redirect('/admin/dashboard');
  }

  return renderAdminPasswordSetupPage(req, res);
});

app.post('/admin/password/setup/save', requireCoachingAdmin, async (req, res) => {
  const oldPassword = req.body.oldPassword || '';
  const newPassword = (req.body.newPassword || '').trim();
  const confirmPassword = (req.body.confirmPassword || '').trim();

  const admin = await get(
    `SELECT id, password_hash
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'admin'
     LIMIT 1`,
    [req.session.user.id, req.session.user.coachingId]
  );

  if (!admin) {
    req.session.flash = { type: 'error', text: 'Admin account not found' };
    return res.redirect('/logout');
  }

  const oldPasswordMatches = await bcrypt.compare(oldPassword, admin.password_hash);
  if (!oldPasswordMatches) {
    return renderAdminPasswordSetupPage(req, res, { type: 'error', text: 'Old password is incorrect' });
  }

  const passwordError = validateAdminPasswordStrength(newPassword);
  if (passwordError) {
    return renderAdminPasswordSetupPage(req, res, { type: 'error', text: passwordError });
  }

  if (newPassword !== confirmPassword) {
    return renderAdminPasswordSetupPage(req, res, { type: 'error', text: 'New password and confirm password must match' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await run(
    `UPDATE users
     SET password_hash = ?, must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND coaching_id = ? AND role = 'admin'`,
    [passwordHash, req.session.user.id, req.session.user.coachingId]
  );

  req.session.user.mustChangePassword = false;
  await auditActor(req, 'admin_password_setup_completed');
  req.session.flash = { type: 'success', text: 'Password updated successfully.' };
  return res.redirect('/admin/dashboard');
});

app.post('/admin/settings/password', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const oldPassword = req.body.oldPassword || '';
  const newPassword = (req.body.newPassword || '').trim();
  const confirmPassword = (req.body.confirmPassword || '').trim();

  const admin = await get(
    `SELECT id, password_hash
     FROM users
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'admin'
     LIMIT 1`,
    [req.session.user.id, coachingId, branchId]
  );

  if (!admin) {
    req.session.flash = { type: 'error', text: 'Admin account not found' };
    return res.redirect('/logout');
  }

  const oldPasswordMatches = await bcrypt.compare(oldPassword, admin.password_hash);
  if (!oldPasswordMatches) {
    req.session.flash = { type: 'error', text: 'Current password is incorrect' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  const passwordError = validateAdminPasswordStrength(newPassword);
  if (passwordError) {
    req.session.flash = { type: 'error', text: passwordError };
    return res.redirect('/admin/dashboard?section=settings');
  }

  if (newPassword !== confirmPassword) {
    req.session.flash = { type: 'error', text: 'New password and confirm password must match' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updatedAdmin = await get(
    `UPDATE users
     SET password_hash = ?, must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'admin'
     RETURNING id`,
    [passwordHash, req.session.user.id, coachingId, branchId]
  );
  if (!updatedAdmin) {
    req.session.flash = { type: 'error', text: 'Password was not updated. Please sign in again and retry.' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  req.session.user.mustChangePassword = false;
  await auditActor(req, 'admin_password_changed');
  req.session.flash = { type: 'success', text: 'Admin password updated successfully.' };
  return res.redirect('/admin/dashboard?section=settings');
});

app.post('/admin/settings/profile', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const adminDisplayName = (req.body.adminDisplayName || '').trim();
  const adminContactPhone = (req.body.adminContactPhone || '').trim();
  const adminEmail = (req.body.adminEmail || '').trim().toLowerCase();
  const coachingName = (req.body.coachingName || '').trim();
  const brandName = (req.body.brandName || '').trim() || coachingName;
  const contactEmail = (req.body.contactEmail || '').trim().toLowerCase();
  const logoUrl = normalizeLogoUrl(req.body.logoUrl);
  const themePrimary = normalizeHexColor(req.body.themePrimary, DEFAULT_THEME.brand);
  const themeBackground = normalizeHexColor(req.body.themeBackground, DEFAULT_THEME.background);
  const themeSurface = normalizeHexColor(req.body.themeSurface, DEFAULT_THEME.surface);

  if (!adminDisplayName) {
    req.session.flash = { type: 'error', text: 'Admin display name is required' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  if (!coachingName) {
    req.session.flash = { type: 'error', text: 'Coaching name is required' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  if (contactEmail && !isValidEmail(contactEmail)) {
    req.session.flash = { type: 'error', text: 'Contact email must be a valid email address' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  if (!adminEmail || !isValidEmail(adminEmail)) {
    req.session.flash = { type: 'error', text: 'Admin OTP email must be a valid email address' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  if (logoUrl && !isValidHttpUrl(logoUrl)) {
    req.session.flash = { type: 'error', text: 'Logo URL must be a valid http/https link' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  const updatedAdmin = await withTransaction(async (tx) => {
    const adminUpdate = await tx.get(
      `UPDATE users
       SET name = ?, contact_phone = ?, email = ?
       WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'admin'
       RETURNING id, name, contact_phone, email`,
      [adminDisplayName, adminContactPhone || null, adminEmail, req.session.user.id, coachingId, branchId]
    );

    await tx.run(
      `UPDATE coaching_classes
       SET name = ?, brand_name = ?, contact_email = ?, logo_url = ?, theme_primary = ?, theme_background = ?, theme_surface = ?
      WHERE id = ?`,
      [coachingName, brandName, contactEmail || null, logoUrl || null, themePrimary, themeBackground, themeSurface, coachingId]
    );
    return adminUpdate;
  });

  if (!updatedAdmin) {
    req.session.flash = { type: 'error', text: 'Admin profile was not updated. Please sign in again and retry.' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  req.session.user.name = updatedAdmin.name;
  req.session.user.contactPhone = updatedAdmin.contact_phone || null;
  req.session.user.email = updatedAdmin.email;
  await auditActor(req, 'admin_profile_updated', {
    targetType: 'coaching',
    targetId: coachingId,
    details: {
      coachingName,
      brandName,
      adminEmail,
      contactEmail: contactEmail || null,
    },
  });
  req.session.user.coachingName = coachingName;
  req.session.flash = {
    type: 'success',
    text: `Settings updated successfully. Login and password reset OTPs will now be sent to ${updatedAdmin.email}.`,
  };
  return req.session.save((error) => {
    if (error) {
      console.error('Failed to persist updated admin email in session', {
        adminId: updatedAdmin.id,
        branchId,
        error: error.message,
      });
    }
    return res.redirect('/admin/dashboard?section=settings');
  });
});

app.post('/admin/settings/whatsapp-notifications', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const existing = await getWhatsAppSettings(coachingId, branchId);

  await saveWhatsAppSettings(coachingId, branchId, {
    ...existing,
    attendanceAlertsEnabled: req.body.attendanceAlertsEnabled === 'on',
    feeAlertsEnabled: req.body.feeAlertsEnabled === 'on',
    resultAlertsEnabled: req.body.resultAlertsEnabled === 'on',
    testPaperAlertsEnabled: req.body.testPaperAlertsEnabled === 'on',
    noticeAlertsEnabled: req.body.noticeAlertsEnabled === 'on',
  }, req.session.user.id);

  await auditActor(req, 'whatsapp_notification_settings_updated', {
    targetType: 'coaching',
    targetId: coachingId,
    details: {
      attendanceAlertsEnabled: req.body.attendanceAlertsEnabled === 'on',
      feeAlertsEnabled: req.body.feeAlertsEnabled === 'on',
      resultAlertsEnabled: req.body.resultAlertsEnabled === 'on',
      testPaperAlertsEnabled: req.body.testPaperAlertsEnabled === 'on',
      noticeAlertsEnabled: req.body.noticeAlertsEnabled === 'on',
    },
  });
  req.session.flash = { type: 'success', text: 'WhatsApp notification settings updated.' };
  return res.redirect('/admin/dashboard?section=settings');
});

app.post('/admin/whatsapp/settings', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const existing = await getWhatsAppSettings(coachingId, branchId);
  const accessToken = String(req.body.accessToken || '').trim() || existing.accessToken;
  const phoneNumberId = String(req.body.phoneNumberId || '').trim();
  const businessAccountId = String(req.body.businessAccountId || '').trim();
  const verifyToken = String(req.body.verifyToken || '').trim() || existing.verifyToken;

  if (!accessToken || !phoneNumberId) {
    req.session.flash = { type: 'error', text: 'WhatsApp Access Token and Phone Number ID are required.' };
    return res.redirect('/admin/dashboard?section=whatsapp');
  }

  await saveWhatsAppSettings(coachingId, branchId, {
    accessToken,
    phoneNumberId,
    businessAccountId,
    verifyToken,
    attendanceAlertsEnabled: existing.attendanceAlertsEnabled,
    feeAlertsEnabled: existing.feeAlertsEnabled,
    resultAlertsEnabled: existing.resultAlertsEnabled,
    testPaperAlertsEnabled: existing.testPaperAlertsEnabled,
    noticeAlertsEnabled: existing.noticeAlertsEnabled,
  }, req.session.user.id);

  await auditActor(req, 'whatsapp_settings_updated', {
    targetType: 'coaching',
    targetId: coachingId,
    details: { phoneNumberId, businessAccountId: businessAccountId || null },
  });
  req.session.flash = { type: 'success', text: 'WhatsApp settings saved.' };
  return res.redirect('/admin/dashboard?section=whatsapp');
});

app.post('/admin/whatsapp/test', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const testPhone = String(req.body.testPhone || '').trim();
  if (!testPhone) {
    req.session.flash = { type: 'error', text: 'Enter a phone number to test WhatsApp connection.' };
    return res.redirect('/admin/dashboard?section=whatsapp');
  }

  try {
    const result = await sendTextMessage({
      coachingId,
      branchId,
      to: testPhone,
      message: `WhatsApp connection test from ${req.session.user.coachingName || 'your coaching portal'} was successful.`,
    });
    if (result?.failed) {
      req.session.flash = { type: 'error', text: `WhatsApp test failed: ${result.error}` };
      return res.redirect('/admin/dashboard?section=whatsapp');
    }
    req.session.flash = { type: 'success', text: 'WhatsApp test message sent successfully.' };
  } catch (error) {
    req.session.flash = { type: 'error', text: `WhatsApp test failed: ${error.message}` };
  }

  return res.redirect('/admin/dashboard?section=whatsapp');
});

app.post('/admin/whatsapp/broadcast', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const targetMode = String(req.body.targetMode || 'all').trim();
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const selectedStudentIds = String(req.body.studentIds || '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  const message = String(req.body.message || '').trim();

  if (!message) {
    req.session.flash = { type: 'error', text: 'Announcement message is required.' };
    return res.redirect('/admin/dashboard?section=whatsapp');
  }

  const params = [coachingId, branchId];
  let recipientSql = `
    SELECT id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
    FROM users
    WHERE coaching_id = ? AND branch_id = ? AND role = 'student'
      AND COALESCE(whatsapp_number, contact_phone, parent_whatsapp_number, guardian_phone) IS NOT NULL
      AND TRIM(COALESCE(whatsapp_number, contact_phone, parent_whatsapp_number, guardian_phone, '')) <> ''
  `;

  if (targetMode === 'batch') {
    if (!Number.isInteger(batchId) || batchId <= 0) {
      req.session.flash = { type: 'error', text: 'Select a batch for broadcast.' };
      return res.redirect('/admin/dashboard?section=whatsapp');
    }
    params.push(batchId);
    recipientSql += ` AND batch_id = ?`;
  } else if (targetMode === 'selected') {
    if (!selectedStudentIds.length) {
      req.session.flash = { type: 'error', text: 'Enter selected student IDs for broadcast.' };
      return res.redirect('/admin/dashboard?section=whatsapp');
    }
    recipientSql += ` AND id = ANY($${params.length + 1}::int[])`;
    params.push(selectedStudentIds);
  }

  recipientSql += ` ORDER BY roll_no ASC LIMIT 500`;
  const recipients = await all(recipientSql, params);
  if (!recipients.length) {
    req.session.flash = { type: 'error', text: 'No students with WhatsApp numbers matched this broadcast target.' };
    return res.redirect('/admin/dashboard?section=whatsapp');
  }

  const messageHash = crypto.createHash('sha256').update(message).digest('hex').slice(0, 24);
  const summary = { sent: 0, failed: 0, skipped: 0 };

  for (const student of recipients) {
    try {
      const result = await sendWhatsAppNotification({
        studentId: student.id,
        phone: student.whatsapp_number || student.contact_phone || student.parent_whatsapp_number || student.guardian_phone,
        type: 'announcement',
        message,
        eventKey: `announcement:${student.id}:${messageHash}:${new Date().toISOString().slice(0, 10)}`,
      });
      if (result?.skipped) {
        summary.skipped += 1;
      } else {
        summary.sent += 1;
      }
    } catch (error) {
      console.error('WhatsApp announcement notification failed', {
        studentId: student.id,
        error: error.message,
      });
      summary.failed += 1;
    }
  }

  await auditActor(req, 'whatsapp_broadcast_sent', {
    targetType: 'coaching',
    targetId: coachingId,
    details: { targetMode, sent: summary.sent, skipped: summary.skipped, failed: summary.failed },
  });
  req.session.flash = {
    type: summary.failed ? 'warning' : 'success',
    text: `Broadcast finished. Sent: ${summary.sent}, Skipped: ${summary.skipped}, Failed: ${summary.failed}.`,
  };
  return res.redirect('/admin/dashboard?section=whatsapp');
});


app.post('/admin/whatsapp-logs/:id/resend', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const logId = Number(req.params.id);
  console.log(`[WHATSAPP MANUAL RESEND START] logId=${logId} branchId=${branchId} coachingId=${coachingId}`);

  try {
    const result = await resendWhatsAppLog({
      logId,
      coachingId,
      branchId,
      resentBy: req.session.user.id,
    });

    if (result?.denied) {
      console.warn(`[WHATSAPP MANUAL RESEND DENIED] logId=${logId}`);
      return res.status(403).send('Forbidden');
    }

    if (result?.ok) {
      req.session.flash = { type: 'success', text: 'Message resent successfully.' };
    } else {
      req.session.flash = { type: 'error', text: result?.message || 'Resend failed. Please check WhatsApp settings.' };
    }
  } catch (error) {
    console.error(`[WHATSAPP MANUAL RESEND FAILED] logId=${logId} code=${error?.code || error?.errorCode || ''}`, error);
    req.session.flash = { type: 'error', text: `Resend failed: ${String(error.message || 'Unknown error').slice(0, 180)}` };
  }

  return res.redirect('/admin/dashboard?section=whatsapp');
});

app.post('/admin/fees/:id/send-reminder', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const feeId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(feeId) || feeId <= 0) {
    req.session.flash = { type: 'error', text: 'Invalid fee record selected.' };
    return res.redirect('/admin/dashboard?section=fees');
  }

  try {
    const result = await sendFeeReminderByFeeId({ coachingId, branchId, feeId });
    if (result?.ok === false && !result?.skipped) {
      req.session.flash = { type: 'error', text: result.reason || 'Fee reminder failed.' };
    } else if (result?.skipped) {
      req.session.flash = { type: 'warning', text: result.reason || 'Fee reminder skipped.' };
    } else {
      req.session.flash = { type: 'success', text: 'Fee reminder sent on WhatsApp.' };
    }
  } catch (error) {
    req.session.flash = { type: 'error', text: `Fee reminder failed: ${error.message}` };
  }

  return res.redirect('/admin/dashboard?section=fees');
});

app.post('/admin/fees/:id/delete', requireCoachingAdmin, requirePermission('fees.delete'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const feeId = Number.parseInt(req.params.id, 10);
  const redirectTo = String(req.body.redirectTo || '').startsWith('/')
    ? String(req.body.redirectTo)
    : '/admin/dashboard?section=fees';
  console.log(`[FEE DELETE START] feeId=${feeId} branchId=${branchId} coachingId=${coachingId}`);

  if (!Number.isInteger(feeId) || feeId <= 0) {
    console.error(`[FEE DELETE DENIED] feeId=${req.params.id}`);
    return res.status(403).send('Forbidden');
  }

  try {
    const fee = await get(
      `SELECT id, coaching_id, branch_id, student_id
       FROM fees
       WHERE id = ?
       LIMIT 1`,
      [feeId]
    );

    if (!fee || Number(fee.coaching_id) !== Number(coachingId) || Number(fee.branch_id) !== Number(branchId)) {
      console.error(`[FEE DELETE DENIED] feeId=${feeId}`);
      return res.status(403).send('Forbidden');
    }

    await withTransaction(async (tx) => {
      await tx.run(
        `DELETE FROM notification_logs
         WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
           AND (
             event_key LIKE ?
             OR event_key LIKE ?
             OR event_key LIKE ?
           )`,
        [
          coachingId,
          branchId,
          fee.student_id,
          `%:${feeId}`,
          `%:${fee.student_id}:${feeId}`,
          `%:${branchId}:${feeId}:%`,
        ]
      );
      await tx.run(
        `DELETE FROM fees
         WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
        [feeId, coachingId, branchId]
      );
    });

    console.log(`[FEE DELETE OK] feeId=${feeId}`);
    req.session.flash = { type: 'success', text: 'Fee record deleted successfully.' };
    return res.redirect(redirectTo);
  } catch (error) {
    console.error(`[FEE DELETE ERROR] feeId=${feeId} error=${error.message}`);
    req.session.flash = { type: 'error', text: 'Fee record could not be deleted.' };
    return res.redirect(redirectTo);
  }
});

app.get('/admin/fees/:id/receipt', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const feeId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(feeId) || feeId <= 0) {
    return res.sendStatus(404);
  }

  const fee = await get(
    `SELECT id
     FROM fees
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND status = 'paid'
     LIMIT 1`,
    [feeId, coachingId, branchId]
  );
  if (!fee) {
    return res.sendStatus(404);
  }

  try {
    const receipt = await generateFeeReceiptPdf(fee.id, {
      branchId,
      publicBaseUrl: getRequestBaseUrl(req),
    });
    const separator = receipt.fileUrl.includes('?') ? '&' : '?';
    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
    return res.redirect(`${receipt.fileUrl}${separator}disposition=${disposition}`);
  } catch (error) {
    console.error('Admin fee receipt generation failed', { feeId, branchId, error: error.message });
    req.session.flash = { type: 'error', text: `Receipt generation failed: ${error.message}` };
    return res.redirect('/admin/dashboard?section=fees');
  }
});

app.post('/admin/whatsapp/fee-reminders/due', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const summary = await sendScheduledFeeReminders({
    coachingId,
    branchId,
  });
  req.session.flash = {
    type: summary.failed ? 'warning' : 'success',
    text: `Fee reminders processed. Sent: ${summary.sent}, Skipped: ${summary.skipped}, Failed: ${summary.failed}.`,
  };
  return res.redirect('/admin/dashboard?section=whatsapp');
});

app.get('/admin/reports/attendance.pdf', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const currentMonth = getCurrentMonthValue();
  const attendanceDate = normalizeDateOnlyFilter(req.query.attendanceDate);
  const attendanceMonth = normalizeMonthOnlyFilter(req.query.attendanceMonth, currentMonth);
  const rows = await getAttendanceReportRows(coachingId, {
    attendanceDate,
    attendanceMonth: attendanceDate ? '' : attendanceMonth,
    limit: 1000,
  });
  const periodLabel = attendanceDate
    ? `Date: ${formatDateLabel(attendanceDate)}`
    : `Month: ${attendanceMonth}`;

  return streamTablePdfReport(res, {
    fileName: `attendance-report-${attendanceDate || attendanceMonth}.pdf`,
    title: `${coaching?.name || 'Coaching'} - Attendance Report`,
    subtitle: `${periodLabel} | Generated on ${formatDateTimeLabel(new Date().toISOString())}`,
    columns: [
      { label: 'Roll', width: 55 },
      { label: 'Name', width: 130 },
      { label: 'Batch', width: 120 },
      { label: 'Status', width: 75 },
      { label: 'Notes', width: 390 },
    ],
    rows: rows.map((row) => [
      row.roll_no || '-',
      row.name || '-',
      row.batch_name || '-',
      row.status || '-',
      row.notes || '-',
    ]),
    emptyMessage: 'No attendance records found for this filter.',
  });
});

app.get('/admin/reports/fees.pdf', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const currentMonth = getCurrentMonthValue();
  const feesDate = normalizeDateOnlyFilter(req.query.feesDate);
  const feesMonth = normalizeMonthOnlyFilter(req.query.feesMonth, currentMonth);
  const rows = await getFeeReportRows(coachingId, {
    feesDate,
    feesMonth: feesDate ? '' : feesMonth,
    limit: 1000,
  });
  const periodLabel = feesDate ? `Date: ${formatDateLabel(feesDate)}` : `Month: ${feesMonth}`;

  return streamTablePdfReport(res, {
    fileName: `fees-report-${feesDate || feesMonth}.pdf`,
    title: `${coaching?.name || 'Coaching'} - Fee Report`,
    subtitle: `${periodLabel} | Generated on ${formatDateTimeLabel(new Date().toISOString())}`,
    columns: [
      { label: 'Roll', width: 50 },
      { label: 'Name', width: 120 },
      { label: 'Batch', width: 105 },
      { label: 'Amount', width: 85 },
      { label: 'Due Date', width: 85 },
      { label: 'Payment', width: 85 },
      { label: 'Status', width: 75 },
      { label: 'Notes', width: 165 },
    ],
    rows: rows.map((row) => [
      row.roll_no || '-',
      row.name || '-',
      row.batch_name || '-',
      formatReportAmount(row.amount),
      row.due_date ? formatDateLabel(row.due_date) : '-',
      row.payment_date ? formatDateLabel(row.payment_date) : '-',
      row.status || '-',
      row.notes || '-',
    ]),
    emptyMessage: 'No fee records found for this filter.',
  });
});

app.get('/admin/performance/slow-operations', requireCoachingAdmin, async (req, res) => {
  res.json({
    generatedAt: new Date().toISOString(),
    top10: getGlobalSlowOperations(),
  });
});

app.get('/owner/dashboard', requireOwner, async (req, res) => {
  const activeSection = getOwnerSection(req.query.section);
  const selectedBranch = req.ownerBranch || await getMeriBranchRecord();
  const coachingId = selectedBranch.coaching_id;
  const branchId = selectedBranch.id;
  const currentMonth = getCurrentMonthValue();
  const financeSummary = await getFinanceSummary(coachingId, branchId, currentMonth);
  const totalStudents = await get(`SELECT COUNT(*) AS count FROM users WHERE coaching_id = ? AND branch_id = ? AND role = 'student'`, [coachingId, branchId]);
  const todayFees = await all(`SELECT f.id, f.amount, f.status, f.payment_mode, f.notes, f.created_at, u.name, u.roll_no, admin.name AS entered_by_name, admin.username AS entered_by_username
    FROM fees f JOIN users u ON u.id = f.student_id AND u.branch_id = f.branch_id
    LEFT JOIN users admin ON admin.id = f.added_by AND admin.branch_id = f.branch_id
    WHERE f.coaching_id = ? AND f.branch_id = ? AND CAST(f.created_at AS DATE) = CURRENT_DATE
    ORDER BY f.created_at DESC LIMIT 50`, [coachingId, branchId]);
  const feeEntries = await all(`SELECT f.id, f.amount, f.status, f.payment_mode, f.notes, f.created_at, u.name, u.roll_no, admin.name AS entered_by_name, admin.username AS entered_by_username
    FROM fees f JOIN users u ON u.id = f.student_id AND u.branch_id = f.branch_id
    LEFT JOIN users admin ON admin.id = f.added_by AND admin.branch_id = f.branch_id
    WHERE f.coaching_id = ? AND f.branch_id = ?
    ORDER BY f.created_at DESC LIMIT 200`, [coachingId, branchId]);
  const staff = await all(`SELECT id, username, name, email, contact_phone, role, is_owner, is_disabled, last_login_at
    FROM users WHERE coaching_id = ? AND branch_id = ? AND role IN ('admin', 'owner', 'super_admin')
    ORDER BY is_owner DESC, name, username`, [coachingId, branchId]);
  const permissionRows = await all(`SELECT admin_user_id, permission_key, is_allowed FROM admin_permissions WHERE coaching_id = ? AND branch_id = ?`, [coachingId, branchId]);
  const staffPermissions = {};
  staff.forEach((admin) => {
    const explicit = new Map(permissionRows.filter((row) => Number(row.admin_user_id) === Number(admin.id)).map((row) => [row.permission_key, row.is_allowed === true || row.is_allowed === 1]));
    staffPermissions[admin.id] = OWNER_PERMISSION_KEYS.filter((key) => explicit.has(key) ? explicit.get(key) : DEFAULT_STAFF_PERMISSIONS.has(key));
  });
  const groupedByStaff = await all(`SELECT COALESCE(admin.name, admin.username, 'Unknown') AS staff_name, COUNT(*) AS entry_count, COALESCE(SUM(f.amount), 0) AS amount
    FROM fees f LEFT JOIN users admin ON admin.id = f.added_by AND admin.branch_id = f.branch_id
    WHERE f.coaching_id = ? AND f.branch_id = ?
    GROUP BY admin.id, admin.name, admin.username ORDER BY amount DESC`, [coachingId, branchId]);
  const pendingOverdue = await all(`SELECT f.id, f.amount, f.status, f.due_date, u.name, u.roll_no FROM fees f JOIN users u ON u.id = f.student_id AND u.branch_id = f.branch_id WHERE f.coaching_id = ? AND f.branch_id = ? AND f.status IN ('pending', 'overdue') ORDER BY f.created_at DESC LIMIT 50`, [coachingId, branchId]);

  return renderWithMessage(res, 'owner-dashboard', {
    user: req.session.user,
    activeSection,
    coachings: [],
    trialRequests: [],
    branches: [selectedBranch],
    selectedBranch,
    branchOwnerMode: true,
    permissionKeys: OWNER_PERMISSION_KEYS,
    staff,
    staffPermissions,
    financeSummary,
    todayFees,
    feeEntries,
    groupedByStaff,
    pendingOverdue,
    stats: {
      totalCoachings: 1,
      activeCoachings: 1,
      totalStudents: Number(totalStudents?.count || 0),
      totalSeatCapacity: null,
      expiringSoon: 0,
      pendingTrialRequests: 0,
    },
    branding: buildBranding({ name: selectedBranch.coaching_name, brand_name: selectedBranch.name, slug: 'scc' }),
    flash: req.session.flash,
  });
});

app.get('/owner/platform-dashboard-disabled', requireOwner, async (req, res) => {
  const activeSection = getOwnerSection(req.query.section);
  const planSql = buildResolvedPlanSql('cc');
  const requestedBranchId = Number.parseInt(String(req.query.branchId || req.session.ownerBranchId || ''), 10);
  const branches = await all(
    `SELECT
       b.id,
       b.code,
       b.name,
       b.coaching_id,
       cc.name AS coaching_name,
       COUNT(DISTINCT CASE WHEN u.role = 'student' THEN u.id END) AS student_count,
       COUNT(DISTINCT CASE WHEN u.role = 'admin' AND u.is_owner = 0 THEN u.id END) AS admin_count,
       COUNT(DISTINCT batch.id) AS batch_count
     FROM branches b
     JOIN coaching_classes cc ON cc.id = b.coaching_id
     LEFT JOIN users u ON u.branch_id = b.id
     LEFT JOIN batches batch ON batch.branch_id = b.id
     WHERE b.is_active = TRUE
     GROUP BY b.id, cc.name
     ORDER BY cc.name, b.name`
  );
  const selectedBranch = branches.find((branch) => Number(branch.id) === requestedBranchId) || branches[0] || null;
  req.session.ownerBranchId = selectedBranch?.id || null;

  const coachings = await all(
    `SELECT
       cc.id,
       cc.name,
       cc.slug,
       cc.brand_name,
       cc.logo_url,
       cc.theme_primary,
       cc.theme_background,
       cc.theme_surface,
       cc.contact_email,
       cc.custom_plan_name,
       cc.custom_max_students,
       cc.subscription_status,
       cc.subscription_started_at,
       cc.subscription_ends_at,
       ${planSql.name} AS plan_name,
       sp.code AS plan_code,
       sp.price_inr,
       ${planSql.maxStudents} AS max_students,
       admin.username AS admin_username,
       admin.name AS admin_name,
       admin.contact_phone AS admin_contact_phone,
       admin.email AS admin_email,
       (
         SELECT COUNT(*) FROM users u
         WHERE u.coaching_id = cc.id AND u.role = 'student'
       ) AS student_count,
       (
         SELECT COUNT(*) FROM batches b
         WHERE b.coaching_id = cc.id AND COALESCE(b.status, 'active') = 'active' AND COALESCE(b.is_retention_batch, 0) = 0
       ) AS active_batch_count,
       (
         SELECT COUNT(*) FROM batches b
         WHERE b.coaching_id = cc.id AND COALESCE(b.status, 'active') = 'completed' AND COALESCE(b.is_retention_batch, 0) = 0
       ) AS completed_batch_count,
       (
         SELECT MIN(b.created_at) FROM batches b
         WHERE b.coaching_id = cc.id AND COALESCE(b.is_retention_batch, 0) = 0
       ) AS oldest_batch_created_at
     FROM coaching_classes cc
     LEFT JOIN subscription_plans sp ON sp.id = cc.subscription_plan_id
     LEFT JOIN users admin
       ON admin.coaching_id = cc.id
      AND admin.role = 'admin'
      AND admin.is_owner = 0
      AND admin.branch_id = (
        SELECT MIN(owner_branch.id)
        FROM branches owner_branch
        WHERE owner_branch.coaching_id = cc.id
      )
     GROUP BY
       cc.id,
       sp.id,
       sp.name,
       sp.code,
       sp.price_inr,
       sp.max_students,
       admin.id,
       admin.username,
       admin.name,
       admin.contact_phone,
       admin.email
     ORDER BY cc.created_at DESC`
  );

  const totals = await get(
    `SELECT
       COUNT(*) AS total_coachings,
       SUM(CASE WHEN subscription_status IN ('active', 'trial') THEN 1 ELSE 0 END) AS active_coachings
     FROM coaching_classes`
  );

  const students = await get(`SELECT COUNT(*) AS total_students FROM users WHERE role = 'student'`);
  const trialRequests = await all(
    `SELECT id, class_name, applicant_name, contact_phone, email, whatsapp_number, logo_url, student_requirement,
            status, owner_notes, reviewed_at, created_at
     FROM trial_requests
     ORDER BY
       CASE status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
       created_at DESC`
  );
  const expiringSoon = coachings.filter((item) => {
    const subscriptionState = getSubscriptionState(item);
    return !subscriptionState.accessBlocked && Boolean(subscriptionState.notice);
  }).length;
  const estimatedRevenue = coachings
    .filter((item) => ['active', 'trial'].includes(item.subscription_status))
    .reduce((sum, item) => {
      const limit = getStudentLimitValue(item);
      return limit === null ? sum : sum + limit;
    }, 0);

  renderWithMessage(res, 'owner-dashboard', {
    user: req.session.user,
    activeSection,
    coachings: coachings.map((coaching) => ({
      ...coaching,
      portal_url: buildPortalUrl(req, coaching.slug),
      subscriptionState: getSubscriptionState(coaching),
      studentUsage: getStudentUsage(Number(coaching.student_count || 0), coaching),
      activeBatchCount: Number(coaching.active_batch_count || 0),
      completedBatchCount: Number(coaching.completed_batch_count || 0),
      oldestBatchAge: formatDaysAgo(coaching.oldest_batch_created_at),
    })),
    stats: {
      totalCoachings: Number(totals?.total_coachings || 0),
      activeCoachings: Number(totals?.active_coachings || 0),
      totalStudents: Number(students?.total_students || 0),
      totalSeatCapacity: estimatedRevenue,
      expiringSoon,
      pendingTrialRequests: trialRequests.filter((item) => item.status === 'pending').length,
    },
    trialRequests,
    branches,
    selectedBranch,
    flash: req.session.flash,
  });
  req.session.flash = null;
});


app.post('/owner/staff', requireOwner, async (req, res) => {
  const branch = req.ownerBranch;
  const username = String(req.body.username || '').trim();
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const contactPhone = String(req.body.contactPhone || '').trim();
  const password = String(req.body.password || '').trim();
  if (!username || !name || !password) {
    req.session.flash = { type: 'error', text: 'Staff username, name and password are required.' };
    return res.redirect('/owner/dashboard?section=staff');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await run(
    `INSERT INTO users (coaching_id, branch_id, role, is_owner, username, name, contact_phone, email, password_hash, must_change_password)
     VALUES (?, ?, 'admin', 0, ?, ?, ?, ?, ?, 1)`,
    [branch.coaching_id, branch.id, username, name, contactPhone || null, email || null, passwordHash]
  );
  console.log(`[STAFF CREATED] staffId=${result.lastID} ownerId=${req.session.user.id} branchId=${branch.id}`);
  req.session.flash = { type: 'success', text: 'Staff account created.' };
  return res.redirect('/owner/dashboard?section=staff');
});

app.post('/owner/staff/:id/update', requireOwner, async (req, res) => {
  const branch = req.ownerBranch;
  const staffId = Number(req.params.id);
  const staff = await get(`SELECT id, is_owner FROM users WHERE id = ? AND coaching_id = ? AND branch_id = ? LIMIT 1`, [staffId, branch.coaching_id, branch.id]);
  if (!staff || staff.is_owner) return res.status(403).send('Forbidden');
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const contactPhone = String(req.body.contactPhone || '').trim();
  const isDisabled = String(req.body.isDisabled || '') === '1';
  await run(`UPDATE users SET name = ?, email = ?, contact_phone = ?, is_disabled = ? WHERE id = ? AND coaching_id = ? AND branch_id = ?`, [name, email || null, contactPhone || null, isDisabled, staffId, branch.coaching_id, branch.id]);
  req.session.flash = { type: 'success', text: 'Staff account updated.' };
  return res.redirect('/owner/dashboard?section=staff');
});

app.post('/owner/staff/:id/password', requireOwner, async (req, res) => {
  const branch = req.ownerBranch;
  const staffId = Number(req.params.id);
  const password = String(req.body.password || '').trim();
  const staff = await get(`SELECT id, is_owner FROM users WHERE id = ? AND coaching_id = ? AND branch_id = ? LIMIT 1`, [staffId, branch.coaching_id, branch.id]);
  if (!staff || staff.is_owner || !password) return res.status(403).send('Forbidden');
  const passwordHash = await bcrypt.hash(password, 10);
  await run(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND coaching_id = ? AND branch_id = ?`, [passwordHash, staffId, branch.coaching_id, branch.id]);
  req.session.flash = { type: 'success', text: 'Staff password reset.' };
  return res.redirect('/owner/dashboard?section=staff');
});

app.post('/owner/permissions/:id', requireOwner, async (req, res) => {
  const branch = req.ownerBranch;
  const staffId = Number(req.params.id);
  const staff = await get(`SELECT id, is_owner FROM users WHERE id = ? AND coaching_id = ? AND branch_id = ? LIMIT 1`, [staffId, branch.coaching_id, branch.id]);
  if (!staff || staff.is_owner) return res.status(403).send('Forbidden');
  const selected = new Set(Array.isArray(req.body.permissions) ? req.body.permissions : [req.body.permissions].filter(Boolean));
  await withTransaction(async (tx) => {
    for (const permission of OWNER_PERMISSION_KEYS) {
      await tx.run(
        `INSERT INTO admin_permissions (coaching_id, branch_id, admin_user_id, permission_key, is_allowed, granted_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (coaching_id, branch_id, admin_user_id, permission_key)
         DO UPDATE SET is_allowed = EXCLUDED.is_allowed, granted_by = EXCLUDED.granted_by, updated_at = CURRENT_TIMESTAMP`,
        [branch.coaching_id, branch.id, staffId, permission, selected.has(permission), req.session.user.id]
      );
      console.log(`[PERMISSION UPDATED] adminId=${staffId} permission=${permission} ownerId=${req.session.user.id}`);
    }
  });
  req.session.flash = { type: 'success', text: 'Permissions updated.' };
  return res.redirect('/owner/dashboard?section=permissions');
});

app.post('/owner/branches/select', requireOwner, async (req, res) => {
  const branchId = Number.parseInt(String(req.body.branchId || ''), 10);
  const branch = await get(
    `SELECT id FROM branches WHERE id = ? AND code = ? AND name = ? AND is_active = TRUE LIMIT 1`,
    [branchId, MERI_BRANCH_CODE, MERI_BRANCH_NAME]
  );
  if (!branch) {
    req.session.flash = { type: 'error', text: 'Branch not found' };
    return res.redirect('/owner/dashboard');
  }

  req.session.ownerBranchId = branch.id;
  return res.redirect(`/owner/dashboard?branchId=${branch.id}`);
});


app.use(['/owner/plans', '/owner/coachings', '/owner/trial-requests'], requireOwner, (req, res) => {
  return res.status(403).send('Forbidden');
});

app.post('/owner/plans/:id', requireOwner, async (req, res) => {
  const planId = Number(req.params.id);
  const name = (req.body.name || '').trim();
  const price = Number(req.body.priceInr);
  const maxStudentsInput = (req.body.maxStudents || '').trim();
  const maxStudents = maxStudentsInput === '' ? null : Number(maxStudentsInput);
  const description = (req.body.description || '').trim();

  if (!name) {
    req.session.flash = { type: 'error', text: 'Plan name is required' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  if (!Number.isFinite(price) || price < 0) {
    req.session.flash = { type: 'error', text: 'Plan price must be a valid number' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  if (maxStudents !== null && (!Number.isInteger(maxStudents) || maxStudents <= 0)) {
    req.session.flash = { type: 'error', text: 'Student limit must be a positive whole number or blank for unlimited' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  const currentPlan = await get(`SELECT id, code FROM subscription_plans WHERE id = ? LIMIT 1`, [planId]);
  if (!currentPlan) {
    req.session.flash = { type: 'error', text: 'Plan not found' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  await run(
    `UPDATE subscription_plans
     SET name = ?, price_inr = ?, max_students = ?, description = ?
     WHERE id = ?`,
    [name, price, maxStudents, description, planId]
  );

  req.session.flash = { type: 'success', text: 'Plan pricing updated' };
  return res.redirect('/owner/dashboard?section=plans');
});

app.post('/owner/plans', requireOwner, async (req, res) => {
  const name = (req.body.name || '').trim();
  const price = Number(req.body.priceInr);
  const maxStudentsInput = (req.body.maxStudents || '').trim();
  const maxStudents = maxStudentsInput === '' ? null : Number(maxStudentsInput);
  const description = (req.body.description || '').trim();
  const code = slugify(name);

  if (!name || !code) {
    req.session.flash = { type: 'error', text: 'Plan name is required' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  if (!Number.isFinite(price) || price < 0) {
    req.session.flash = { type: 'error', text: 'Plan price must be a valid number' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  if (maxStudents !== null && (!Number.isInteger(maxStudents) || maxStudents <= 0)) {
    req.session.flash = { type: 'error', text: 'Student limit must be a positive whole number or blank for unlimited' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  const existingPlan = await get(`SELECT id FROM subscription_plans WHERE code = ? LIMIT 1`, [code]);
  if (existingPlan) {
    req.session.flash = { type: 'error', text: 'A plan with a similar name already exists' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  await run(
    `INSERT INTO subscription_plans (code, name, price_inr, max_students, description, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [code, name, price, maxStudents, description || null]
  );

  req.session.flash = { type: 'success', text: `Plan "${name}" created successfully` };
  return res.redirect('/owner/dashboard?section=plans');
});

app.post('/owner/plans/:id/delete', requireOwner, async (req, res) => {
  const planId = Number(req.params.id);
  const plan = await get(`SELECT id, name FROM subscription_plans WHERE id = ? LIMIT 1`, [planId]);

  if (!plan) {
    req.session.flash = { type: 'error', text: 'Plan not found' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  const usage = await get(`SELECT COUNT(*) AS total FROM coaching_classes WHERE subscription_plan_id = ?`, [planId]);
  if (Number(usage?.total || 0) > 0) {
    req.session.flash = { type: 'error', text: 'This plan is assigned to coaching tenants and cannot be deleted yet' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  const planCount = await get(`SELECT COUNT(*) AS total FROM subscription_plans`);
  if (Number(planCount?.total || 0) <= 1) {
    req.session.flash = { type: 'error', text: 'Keep at least one subscription plan in the system' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  await run(`DELETE FROM subscription_plans WHERE id = ?`, [planId]);
  req.session.flash = { type: 'success', text: `Plan "${plan.name}" deleted successfully` };
  return res.redirect('/owner/dashboard?section=plans');
});

app.post('/owner/coachings', requireOwner, async (req, res) => {
  const name = (req.body.name || '').trim();
  const slug = slugify(req.body.slug || name);
  const contactEmail = (req.body.contactEmail || '').trim() || null;
  const adminUsername = (req.body.adminUsername || '').trim();
  const adminName = (req.body.adminName || '').trim() || 'Coaching Admin';
  const adminContactPhone = (req.body.adminContactPhone || '').trim() || null;
  const adminEmail = (req.body.adminEmail || '').trim().toLowerCase() || null;
  const adminPassword = (req.body.adminPassword || '').trim();
  const planName = (req.body.planName || '').trim();
  const maxStudents = parseOptionalPositiveInteger(req.body.maxStudents);
  const subscriptionStatus = (req.body.subscriptionStatus || 'active').trim();
  const subscriptionStartedAt = req.body.subscriptionStartedAt || null;
  const subscriptionEndsAt = req.body.subscriptionEndsAt || null;

  if (!name || !slug || !adminUsername || !adminPassword || !planName) {
    req.session.flash = { type: 'error', text: 'Coaching name, slug, admin username, temporary password, and plan name are required' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  const existingSlug = await get(`SELECT id FROM coaching_classes WHERE slug = ?`, [slug]);
  if (existingSlug) {
    req.session.flash = { type: 'error', text: 'Coaching code already exists' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  if (!Number.isInteger(maxStudents) || maxStudents <= 0) {
    req.session.flash = { type: 'error', text: 'Student limit must be a positive whole number' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  const coachingInsert = await run(
    `INSERT INTO coaching_classes (
      name, brand_name, slug, contact_email, custom_plan_name, custom_max_students, subscription_status, subscription_started_at, subscription_ends_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, name, slug, contactEmail, planName, maxStudents, subscriptionStatus, subscriptionStartedAt, subscriptionEndsAt]
  );

  const coachingId = coachingInsert.lastID;
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const branchInsert = await run(
    `INSERT INTO branches (coaching_id, code, name)
     VALUES (?, 'main', ?)
     RETURNING id`,
    [coachingId, `${name} - Main Branch`]
  );
  const branchId = branchInsert.lastID;

  await run(
    `INSERT INTO users (
      coaching_id, branch_id, role, is_owner, username, roll_no, name, standard, course, contact_phone, email, password_hash, must_change_password
    ) VALUES (?, ?, 'admin', 0, ?, NULL, ?, NULL, NULL, ?, ?, ?, 1)`,
    [coachingId, branchId, adminUsername, adminName, adminContactPhone, adminEmail, passwordHash]
  );

  req.session.flash = {
    type: 'success',
    text: `Coaching created. Portal URL: ${slug}`,
  };
  await auditActor(req, 'owner_coaching_created', {
    targetType: 'coaching',
    targetId: coachingId,
    details: { slug, adminUsername, planName, maxStudents, subscriptionStatus },
  });
  return res.redirect('/owner/dashboard?section=coachings');
});

app.post('/owner/coachings/:id/subscription', requireOwner, async (req, res) => {
  const coachingId = Number(req.params.id);
  const planName = (req.body.planName || '').trim();
  const maxStudents = parseOptionalPositiveInteger(req.body.maxStudents);
  const subscriptionStatus = (req.body.subscriptionStatus || 'active').trim();
  const subscriptionStartedAt = req.body.subscriptionStartedAt || null;
  const subscriptionEndsAt = req.body.subscriptionEndsAt || null;

  const coaching = await get(`SELECT id FROM coaching_classes WHERE id = ? LIMIT 1`, [coachingId]);
  if (!coaching) {
    req.session.flash = { type: 'error', text: 'Coaching not found' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  if (!planName) {
    req.session.flash = { type: 'error', text: 'Plan name is required' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  if (!Number.isInteger(maxStudents) || maxStudents <= 0) {
    req.session.flash = { type: 'error', text: 'Student limit must be a positive whole number' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  await run(
    `UPDATE coaching_classes
     SET custom_plan_name = ?, custom_max_students = ?, subscription_status = ?, subscription_started_at = ?, subscription_ends_at = ?
     WHERE id = ?`,
    [planName, maxStudents, subscriptionStatus, subscriptionStartedAt, subscriptionEndsAt, coachingId]
  );

  await auditActor(req, 'owner_coaching_subscription_updated', {
    targetType: 'coaching',
    targetId: coachingId,
    details: { planName, maxStudents, subscriptionStatus, subscriptionStartedAt, subscriptionEndsAt },
  });
  req.session.flash = { type: 'success', text: 'Coaching access and plan settings updated' };
  return res.redirect('/owner/dashboard?section=coachings');
});

app.post('/owner/coachings/:id/branding', requireOwner, async (req, res) => {
  const coachingId = Number(req.params.id);
  const coaching = await get(`SELECT id FROM coaching_classes WHERE id = ? LIMIT 1`, [coachingId]);
  if (!coaching) {
    req.session.flash = { type: 'error', text: 'Coaching not found' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  const name = (req.body.name || '').trim();
  const brandName = (req.body.brandName || '').trim() || name;
  const logoUrl = normalizeLogoUrl(req.body.logoUrl);
  const contactEmail = (req.body.contactEmail || '').trim();
  const adminName = (req.body.adminName || '').trim();
  const adminContactPhone = (req.body.adminContactPhone || '').trim();
  const adminEmail = (req.body.adminEmail || '').trim().toLowerCase();
  const themePrimary = normalizeHexColor(req.body.themePrimary, DEFAULT_THEME.brand);
  const themeBackground = normalizeHexColor(req.body.themeBackground, DEFAULT_THEME.background);
  const themeSurface = normalizeHexColor(req.body.themeSurface, DEFAULT_THEME.surface);

  if (!name) {
    req.session.flash = { type: 'error', text: 'Coaching name is required for branding' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  if (logoUrl && !isValidHttpUrl(logoUrl)) {
    req.session.flash = { type: 'error', text: 'Logo URL must be a valid http/https link' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  if (adminEmail && !isValidEmail(adminEmail)) {
    req.session.flash = { type: 'error', text: 'Tuition owner email must be a valid email address' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE coaching_classes
       SET name = ?, brand_name = ?, logo_url = ?, contact_email = ?, theme_primary = ?, theme_background = ?, theme_surface = ?
       WHERE id = ?`,
      [name, brandName, logoUrl || null, contactEmail || null, themePrimary, themeBackground, themeSurface, coachingId]
    );

    await tx.run(
      `UPDATE users
       SET name = COALESCE(NULLIF(?, ''), name),
           contact_phone = ?,
           email = ?
       WHERE coaching_id = ? AND role = 'admin' AND is_owner = 0`,
      [adminName, adminContactPhone || null, adminEmail || null, coachingId]
    );
  });

  await auditActor(req, 'owner_coaching_branding_updated', {
    targetType: 'coaching',
    targetId: coachingId,
    details: { name, brandName, contactEmail: contactEmail || null, adminEmail: adminEmail || null },
  });
  req.session.flash = { type: 'success', text: 'Branding and tuition owner details updated' };
  return res.redirect('/owner/dashboard?section=coachings');
});

app.post('/owner/coachings/:id/delete', requireOwner, async (req, res) => {
  const coachingId = Number(req.params.id);
  const coaching = await get(`SELECT id, name FROM coaching_classes WHERE id = ? LIMIT 1`, [coachingId]);
  if (!coaching) {
    req.session.flash = { type: 'error', text: 'Coaching not found' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  await deleteCoachingData(coachingId);

  await auditActor(req, 'owner_coaching_deleted', {
    targetType: 'coaching',
    targetId: coachingId,
    details: { coachingName: coaching.name },
  });
  req.session.flash = {
    type: 'success',
    text: `${coaching.name} deleted permanently with all students, notes, papers, attendance, and fees data.`,
  };
  return res.redirect('/owner/dashboard?section=coachings');
});

app.post('/owner/trial-requests/:id/review', requireOwner, async (req, res) => {
  const trialRequestId = Number.parseInt(req.params.id, 10);
  const status = normalizeTrialStatus(req.body.status);
  const ownerNotes = (req.body.ownerNotes || '').trim();

  if (!Number.isInteger(trialRequestId) || trialRequestId <= 0) {
    req.session.flash = { type: 'error', text: 'Invalid trial request selected' };
    return res.redirect('/owner/dashboard?section=trial-requests');
  }

  if (!['approved', 'rejected'].includes(status)) {
    req.session.flash = { type: 'error', text: 'Select a valid action for the trial request' };
    return res.redirect('/owner/dashboard?section=trial-requests');
  }

  const trialRequest = await get(`SELECT id, class_name FROM trial_requests WHERE id = ? LIMIT 1`, [trialRequestId]);
  if (!trialRequest) {
    req.session.flash = { type: 'error', text: 'Trial request not found' };
    return res.redirect('/owner/dashboard?section=trial-requests');
  }

  await run(
    `UPDATE trial_requests
     SET status = ?, owner_notes = ?, reviewed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, ownerNotes || null, trialRequestId]
  );

  await auditActor(req, 'owner_trial_request_reviewed', {
    targetType: 'trial_request',
    targetId: trialRequestId,
    details: { status, className: trialRequest.class_name },
  });
  req.session.flash = {
    type: 'success',
    text: `Trial request for ${trialRequest.class_name} marked as ${status}. You can now contact them manually with login details.`,
  };
  return res.redirect('/owner/dashboard?section=trial-requests');
});

app.get('/admin/dashboard', requireCoachingAdmin, async (req, res) => {
  const subscriptionState = req.subscriptionState || getSubscriptionState(req.currentCoaching);
  const activeSection = subscriptionState.accessBlocked ? 'overview' : getAdminSection(req.query.section);
  const currentMonth = getCurrentMonthValue();
  const attendanceDateFilter = normalizeDateOnlyFilter(req.query.attendanceDate);
  const attendanceMonthFilter = normalizeMonthOnlyFilter(req.query.attendanceMonth, currentMonth);
  const papersMonthFilter = normalizeMonthOnlyFilter(req.query.papersMonth, currentMonth);
  const feesDateFilter = normalizeDateOnlyFilter(req.query.feesDate);
  const feesMonthFilter = normalizeMonthOnlyFilter(req.query.feesMonth);
  const expenseMonthFilter = normalizeMonthOnlyFilter(req.query.expenseMonth, currentMonth);
  const studentSearchQuery = (req.query.studentSearch || '').trim();
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const adminPermissions = req.session.user.role === 'admin' ? await getAdminPermissions(coachingId, branchId, req.session.user.id) : new Set();
  const canViewFeeTotals = adminPermissions.has('fees.view_totals');
  const canViewAllFeeEntries = adminPermissions.has('fees.view_all_entries');
  const canViewOwnFeeEntries = adminPermissions.has('fees.view_own_entries');
  const canManageExpenses = adminPermissions.has('expenses.manage');
  if (activeSection === 'fees' && !adminPermissions.has('fees.entry') && !canViewAllFeeEntries && !canViewOwnFeeEntries) {
    return accessDenied(res);
  }
  const isOverviewSection = activeSection === 'overview';
  const needsStudents = ['overview', 'students', 'attendance', 'fees', 'notes', 'whatsapp'].includes(activeSection);
  const needsPapers = ['overview', 'papers', 'omr'].includes(activeSection);
  const needsAttendance = ['overview', 'attendance'].includes(activeSection);
  const needsFees = ['overview', 'fees'].includes(activeSection);
  const needsNotes = ['overview', 'notes'].includes(activeSection);
  const needsAnswerRequests = ['overview', 'papers'].includes(activeSection);
  const needsWhatsAppSettings = ['whatsapp', 'settings'].includes(activeSection);
  const needsWhatsAppLogs = activeSection === 'whatsapp';
  const needsNotificationLogs = activeSection === 'notifications';
  const needsAdminProfile = activeSection === 'settings';
  const needsOmr = activeSection === 'omr';

  const studentCountPromise = get(
    `SELECT COUNT(*) AS total_students
     FROM users
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [coachingId, branchId]
  );
  const adminProfilePromise = needsAdminProfile ? get(
    `SELECT contact_phone, email
     FROM users
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'admin'
     LIMIT 1`,
    [req.session.user.id, coachingId, branchId]
  ) : Promise.resolve(null);
  const batchesPromise = getBatchesForCoaching(coachingId, branchId);
  const whatsappSettingsPromise = needsWhatsAppSettings
    ? getWhatsAppSettings(coachingId, branchId)
    : Promise.resolve(null);
  const whatsappLogsPromise = needsWhatsAppLogs
    ? getRecentWhatsAppLogs(coachingId, branchId, 25)
    : Promise.resolve([]);
  const notificationLogsPromise = needsNotificationLogs
    ? getRecentNotificationLogs(coachingId, branchId, 100)
    : Promise.resolve([]);
  const studentsPromise = needsStudents ? all(
    `SELECT u.id, u.roll_no, u.name, u.batch_id, u.standard, u.course, u.contact_phone, u.guardian_phone, u.whatsapp_number, u.parent_whatsapp_number, u.email, u.created_at,
            u.is_retained_record, u.retention_source_batch_id,
            b.name AS batch_name, b.status AS batch_status, b.completed_at AS batch_completed_at, b.is_retention_batch
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = u.branch_id
     WHERE u.role = 'student' AND u.coaching_id = ? AND u.branch_id = ?
     ORDER BY COALESCE(b.name, ''), u.roll_no ASC`,
    [coachingId, branchId]
  ) : Promise.resolve([]);

  const papersMonthRange = getMonthDateRange(papersMonthFilter);
  const papersPromise = needsPapers ? all(
    `SELECT
       tp.id,
       tp.original_name,
       tp.stored_name,
       tp.upload_date,
	       tp.storage_type,
	       tp.storage_key,
	       tp.public_url,
	       tp.size_bytes,
       tp.marks_obtained,
       tp.max_marks,
       tp.percentage,
       tp.correct_count,
       tp.wrong_count,
       tp.unattempted_count,
       tp.physics_marks,
       tp.chemistry_marks,
       tp.biology_marks,
       tp.botany_marks,
       tp.zoology_marks,
       tp.omr_barcode,
       tp.omr_rank,
       tp.omr_scan_path,
       tp.omr_scan_original_name,
       tp.omr_scan_uploaded_at,
       tp.test_label,
       tp.paper_type,
       tp.answer_request_id,
       u.roll_no,
       u.name,
       u.batch_id,
       u.standard,
       u.course,
       b.name AS batch_name,
       uploader.name AS uploaded_by_name,
       uploader.role AS uploaded_by_role
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id AND u.branch_id = tp.branch_id
     LEFT JOIN batches b ON b.id = u.batch_id AND b.branch_id = tp.branch_id
     LEFT JOIN users uploader ON uploader.id = tp.uploaded_by AND uploader.branch_id = tp.branch_id
	     WHERE tp.coaching_id = ? AND tp.branch_id = ?
	       AND tp.upload_date >= ?
       AND tp.upload_date < ?
     ORDER BY tp.upload_date DESC
     LIMIT 250`,
    [coachingId, branchId, papersMonthRange.start, papersMonthRange.end]
  ) : Promise.resolve([]);

  const shouldLoadAttendanceRecords = needsAttendance && (activeSection !== 'attendance' || Boolean(attendanceDateFilter));
  const attendancePromise = shouldLoadAttendanceRecords
    ? getAttendanceReportRows(coachingId, branchId, {
      attendanceDate: attendanceDateFilter,
      attendanceMonth: attendanceDateFilter ? '' : attendanceMonthFilter,
      limit: 300,
    })
    : Promise.resolve([]);

  const attendanceDatesPromise = activeSection === 'attendance' ? all(
    `SELECT DISTINCT CAST(attendance_date AS TEXT) AS attendance_date
     FROM attendance
     WHERE coaching_id = ? AND branch_id = ?
     ORDER BY attendance_date DESC
     LIMIT 90`,
    [coachingId, branchId]
  ) : Promise.resolve([]);

  const feeCreatedByFilter = canViewAllFeeEntries ? null : (canViewOwnFeeEntries ? req.session.user.id : -1);
  const feesPromise = needsFees ? getFeeReportRows(coachingId, branchId, {
    feesDate: feesDateFilter,
    feesMonth: feesDateFilter ? '' : feesMonthFilter,
    limit: 150,
    createdBy: feeCreatedByFilter,
  }) : Promise.resolve([]);
  if (needsFees && !canViewFeeTotals) console.log(`[FEE TOTALS HIDDEN] userId=${req.session.user.id} branchId=${branchId}`);
  const financeSummaryPromise = needsFees && canViewFeeTotals ? getFinanceSummary(coachingId, branchId, expenseMonthFilter) : Promise.resolve(null);
  const expensesPromise = needsFees && (adminPermissions.has('expenses.view') || canManageExpenses) ? getExpenseRows(coachingId, branchId, expenseMonthFilter) : Promise.resolve([]);

  const notesPromise = needsNotes ? all(
    `SELECT bn.id, bn.batch_id, bn.standard, bn.course, bn.title, bn.resource_url, bn.description, bn.created_at,
            b.name AS batch_name
     FROM batch_notes bn
     LEFT JOIN batches b ON b.id = bn.batch_id AND b.branch_id = bn.branch_id
     WHERE bn.coaching_id = ? AND bn.branch_id = ?
     ORDER BY bn.created_at DESC
     LIMIT 150`,
    [coachingId, branchId]
  ) : Promise.resolve([]);

  const answerRequestsPromise = needsAnswerRequests ? all(
    `SELECT ar.id, ar.batch_id, ar.standard, ar.course, ar.title, ar.description, ar.starts_at, ar.ends_at, ar.created_at,
            b.name AS batch_name
     FROM answer_upload_requests ar
     LEFT JOIN batches b ON b.id = ar.batch_id AND b.branch_id = ar.branch_id
     WHERE ar.coaching_id = ? AND ar.branch_id = ?
     ORDER BY ar.created_at DESC
     LIMIT 20`,
    [coachingId, branchId]
  ) : Promise.resolve([]);

  const paperStatsPromise = isOverviewSection ? all(
    `SELECT
       student_id,
       COUNT(*) AS paper_count,
       MAX(upload_date) AS last_upload,
       MAX(CASE WHEN marks_obtained IS NOT NULL AND max_marks IS NOT NULL AND max_marks > 0 THEN upload_date END) AS latest_marked_upload
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ?
     GROUP BY student_id`,
    [coachingId, branchId]
  ) : Promise.resolve([]);

  const latestMarkedPapersPromise = isOverviewSection ? all(
    `SELECT student_id, marks_obtained, max_marks, upload_date, test_label, original_name
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ? AND marks_obtained IS NOT NULL AND max_marks IS NOT NULL AND max_marks > 0
     ORDER BY upload_date DESC`,
    [coachingId, branchId]
  ) : Promise.resolve([]);
  const omrImportsPromise = needsOmr ? all(
    `SELECT oi.*, admin.name AS imported_by_name
     FROM omr_imports oi
     LEFT JOIN users admin ON admin.id = oi.imported_by AND admin.branch_id = oi.branch_id
     WHERE oi.coaching_id = ? AND oi.branch_id = ?
     ORDER BY oi.imported_at DESC
     LIMIT 30`,
    [coachingId, branchId]
  ) : Promise.resolve([]);

  const [
    studentCountRow,
    adminProfile,
    batches,
    rawWhatsappSettings,
    whatsappLogs,
    notificationLogs,
    students,
    papers,
    attendance,
    attendanceDates,
    fees,
    financeSummary,
    expenses,
    notes,
    answerRequests,
    paperStats,
    latestMarkedPapers,
    omrImports,
  ] = await Promise.all([
    studentCountPromise,
    adminProfilePromise,
    batchesPromise,
    whatsappSettingsPromise,
    whatsappLogsPromise,
    notificationLogsPromise,
    studentsPromise,
    papersPromise,
    attendancePromise,
    attendanceDatesPromise,
    feesPromise,
    financeSummaryPromise,
    expensesPromise,
    notesPromise,
    answerRequestsPromise,
    paperStatsPromise,
    latestMarkedPapersPromise,
    omrImportsPromise,
  ]);
  const totalStudentCount = Number(studentCountRow?.total_students || 0);
  const whatsappSettings = buildWhatsAppSettingsView(rawWhatsappSettings);
  const answerRequestSummaries = needsAnswerRequests
    ? await buildAnswerRequestSummaries(coachingId, branchId, answerRequests)
    : [];
  papers.forEach((paper) => {
    paper.is_downloadable_paper = (
      (paper.storage_type === 's3' && Boolean(paper.public_url))
      || (paper.storage_type === 'local' && Boolean(paper.storage_key))
    );
  });

  const paperStatsByStudent = new Map();
  paperStats.forEach((row) => paperStatsByStudent.set(row.student_id, row));

  const latestMarkedByStudent = new Map();
  latestMarkedPapers.forEach((paper) => {
    if (!latestMarkedByStudent.has(paper.student_id)) {
      latestMarkedByStudent.set(paper.student_id, paper);
    }
  });

  const overviewStudents = students.map((student) => {
    const paperRow = paperStatsByStudent.get(student.id);
    const latestMarked = latestMarkedByStudent.get(student.id);
    const latestPercent = latestMarked && Number(latestMarked.max_marks) > 0
      ? ((Number(latestMarked.marks_obtained || 0) / Number(latestMarked.max_marks)) * 100).toFixed(1)
      : null;

    return {
      ...student,
      paperCount: Number(paperRow?.paper_count || 0),
      lastUpload: paperRow?.last_upload || null,
      latestPercent,
      latestMarkedLabel: latestMarked?.test_label || latestMarked?.original_name || null,
    };
  });

  const defaultAnswerRequestStart = toDateTimeLocalInput(new Date());

  const stats = {
    totalStudents: totalStudentCount,
    totalPapers: papers.length,
    pendingFees: fees.filter((item) => item.status === 'pending' || item.status === 'overdue').length,
    absentEntries: attendance.filter((item) => item.status === 'absent').length,
    notesCount: notes.length,
    activeAnswerRequests: answerRequestSummaries.filter((item) => item.state.isActive).length,
  };
  const feesPaidThisMonth = fees.filter((item) => item.status === 'paid' && String(item.payment_date || '').startsWith(feesMonthFilter));
  const papersThisMonthCount = papers.length;
  const attendanceThisMonthCount = attendance.length;
  const studentUsage = getStudentUsage(totalStudentCount, coaching);
  const batchSummaries = activeSection === 'students' ? toBatchSummaries(students, batches) : [];
  const studentBatchGroups = activeSection === 'students' ? toStudentBatchGroups(students, batches) : [];
  const studentSearch = activeSection === 'students' ? getStudentSearchResults(students, studentSearchQuery) : { query: studentSearchQuery, results: [] };
  const completedBatches = activeSection === 'students'
    ? (() => {
      const studentCountByBatch = new Map();
      const retainedCountBySourceBatch = new Map();
      const eligibleStudentsByBatch = new Map();
      students.forEach((student) => {
        const batchId = Number(student.batch_id || 0);
        const sourceBatchId = Number(student.retention_source_batch_id || 0);
        if (batchId && !student.is_retained_record) {
          studentCountByBatch.set(batchId, (studentCountByBatch.get(batchId) || 0) + 1);
          if (!eligibleStudentsByBatch.has(batchId)) eligibleStudentsByBatch.set(batchId, []);
          eligibleStudentsByBatch.get(batchId).push(student);
        }
        if (sourceBatchId && student.is_retained_record) {
          retainedCountBySourceBatch.set(sourceBatchId, (retainedCountBySourceBatch.get(sourceBatchId) || 0) + 1);
        }
      });
      return batches.filter((batch) => batch.status === 'completed' && !batch.is_retention_batch).map((batch) => {
        const batchId = Number(batch.id);
        const retainedCount = retainedCountBySourceBatch.get(batchId) || 0;
        return {
          ...batch,
          studentCount: studentCountByBatch.get(batchId) || 0,
          retainedCount,
          eligibleRetentionStudents: eligibleStudentsByBatch.get(batchId) || [],
          createdDaysAgo: formatDaysAgo(batch.created_at),
          completedDaysAgo: formatDaysAgo(batch.completed_at),
          retentionRemaining: Math.max(0, RETENTION_MAX_STUDENTS_PER_SOURCE_BATCH - retainedCount),
        };
      });
    })()
    : [];

  renderWithMessage(res, 'admin-dashboard', {
    user: req.session.user,
    coaching,
    branch: req.currentBranch,
    branding: buildBranding(coaching),
    adminProfile,
    whatsappSettings,
    whatsappLogs,
    notificationLogs,
    subscriptionState,
    subscriptionNotice: subscriptionState.notice,
    students,
    batches,
    batchSummaries,
    studentBatchGroups,
    studentSearch,
    completedBatches,
    studentUsage,
    papers,
    omrImports,
    omrPreview: req.session.omrPreview || null,
    attendance,
    attendanceByDate: groupAttendanceByDate(attendance),
    attendanceDates,
    attendanceDateFilter,
    attendanceMonthFilter,
    papersMonthFilter,
    feesDateFilter,
    feesMonthFilter,
    expenseMonthFilter,
    adminPermissions,
    canViewFeeTotals,
    canViewAllFeeEntries,
    canViewOwnFeeEntries,
    canManageExpenses,
    fees,
    financeSummary,
    expenses,
    expenseCategories: EXPENSE_CATEGORIES,
    formatIndianCurrency,
    feesPaidThisMonth,
    notes,
    answerRequestSummaries,
    overviewStudents,
    defaultAnswerRequestStart,
    stats,
    papersThisMonthCount,
    attendanceThisMonthCount,
    activeSection,
    storageMode: getStorageMode(),
    flash: req.session.flash,
  });
  req.session.flash = null;
});

app.post('/admin/students', requireCoachingAdmin, async (req, res) => {
  const registrationStartedAt = performance.now();
  const registrationTimings = {
    studentDatabaseInsertMs: 0,
    parentCreationMs: 0,
    parentCreationExecuted: false,
    feeCreationMs: 0,
    feeCreationExecuted: false,
    receiptGenerationMs: 0,
    receiptGenerationExecuted: false,
    whatsappNotificationMs: 0,
    totalRequestMs: 0,
  };
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const rollNo = (req.body.rollNo || '').trim();
  const name = (req.body.name || '').trim() || rollNo;
  const contactPhone = (req.body.contactPhone || '').trim();
  const guardianPhone = (req.body.guardianPhone || '').trim();
  const parentName = (req.body.parentName || '').trim();
  const whatsappNumber = (req.body.whatsappNumber || contactPhone).trim();
  const parentWhatsappNumber = (req.body.parentWhatsappNumber || guardianPhone).trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const submittedPassword = (req.body.password || '').trim();
  const password = submittedPassword || rollNo;
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const totalFeeInput = String(req.body.totalFee || '').trim();
  const totalFee = totalFeeInput ? Number(totalFeeInput) : 0;

  if (!rollNo) {
    req.session.flash = { type: 'error', text: 'Roll number is required' };
    return res.redirect('/admin/dashboard?section=students');
  }

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch for the student' };
    return res.redirect('/admin/dashboard?section=students');
  }

  if (totalFeeInput && (!Number.isFinite(totalFee) || totalFee < 0)) {
    req.session.flash = { type: 'error', text: 'Enter a valid total fee amount' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const batch = await getBatchForCoaching(coachingId, branchId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=students');
  }
  const normalizedBatchStandard = normalizeStudentStandard(batch.standard);
  if (!normalizedBatchStandard.ok) {
    req.session.flash = { type: 'error', text: 'Selected batch has an invalid standard. Use 11th or 12th.' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const existing = await get(
    `SELECT id FROM users WHERE coaching_id = ? AND branch_id = ? AND roll_no = ? LIMIT 1`,
    [coachingId, branchId, rollNo]
  );
  if (existing) {
    req.session.flash = { type: 'error', text: 'Roll number already exists in this branch.' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const currentStudents = await get(
    `SELECT COUNT(*) AS total_students FROM users WHERE coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [coachingId, branchId]
  );
  const studentUsage = getStudentUsage(Number(currentStudents?.total_students || 0), coaching);
  if (studentUsage.atLimit) {
    req.session.flash = {
      type: 'error',
      text: `Student limit reached for the ${coaching?.plan_name || 'current'} plan. Upgrade or increase the plan limit to add more students.`,
    };
    return res.redirect('/admin/dashboard?section=students');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let createdStudentResult;
  const studentInsertStartedAt = performance.now();
  try {
    createdStudentResult = await run(
      `INSERT INTO users (
        coaching_id, branch_id, role, is_owner, username, roll_no, name, batch_id, standard, course, contact_phone, guardian_phone, parent_name, whatsapp_number, parent_whatsapp_number, email, password_hash
      ) VALUES (?, ?, 'student', 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        coachingId,
        branchId,
        rollNo,
        name,
        batch.id,
        normalizedBatchStandard.value,
        batch.course || null,
        contactPhone || null,
        guardianPhone || null,
        parentName || null,
        whatsappNumber || null,
        parentWhatsappNumber || null,
        email || null,
        passwordHash,
      ]
    );
    registrationTimings.studentDatabaseInsertMs = Number(
      (performance.now() - studentInsertStartedAt).toFixed(2)
    );
  } catch (error) {
    registrationTimings.studentDatabaseInsertMs = Number(
      (performance.now() - studentInsertStartedAt).toFixed(2)
    );
    const duplicateBranchRoll = error.code === '23505'
      && (
        error.constraint === 'idx_users_coaching_branch_roll'
        || String(error.detail || '').includes('(coaching_id, branch_id, roll_no)')
      );
    if (duplicateBranchRoll) {
      req.session.flash = { type: 'error', text: 'Roll number already exists in this branch.' };
      return res.redirect('/admin/dashboard?section=students');
    }
    throw error;
  }
  const createdStudentId = createdStudentResult.lastID;

  if (totalFee > 0) {
    const feeCreationStartedAt = performance.now();
    await setStudentTotalFee({
      coachingId,
      branchId,
      studentId: createdStudentId,
      totalFee,
    });
    registrationTimings.feeCreationMs = Number(
      (performance.now() - feeCreationStartedAt).toFixed(2)
    );
    registrationTimings.feeCreationExecuted = true;
  }

  const whatsappStartedAt = performance.now();
  await sendStudentOnboarding(createdStudentId, { coachingId, branchId })
    .catch((error) => console.error('[WHATSAPP ONBOARDING] Immediate send failed', {
      studentId: createdStudentId,
      branchId,
      error: error.message,
    }));
  registrationTimings.whatsappNotificationMs = Number(
    (performance.now() - whatsappStartedAt).toFixed(2)
  );

  req.session.flash = {
    type: 'success',
    text: submittedPassword
      ? `Student ${rollNo} created with a custom password`
      : `Student ${rollNo} created. Default password is the roll number`,
  };
  await auditActor(req, 'student_created', {
    targetType: 'student',
    details: { rollNo, batchId: batch.id, batchName: batch.name },
  });
  registrationTimings.totalRequestMs = Number(
    (performance.now() - registrationStartedAt).toFixed(2)
  );
  console.log('[STUDENT REGISTRATION TIMINGS]', {
    studentId: createdStudentId,
    rollNo,
    branchId,
    ...registrationTimings,
  });
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/students/import', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const csv = String(req.body.studentsCsv || '').trim();

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch for imported students' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const batch = await getBatchForCoaching(coachingId, branchId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=students');
  }
  const normalizedBatchStandard = normalizeStudentStandard(batch.standard);
  if (!normalizedBatchStandard.ok) {
    req.session.flash = { type: 'error', text: 'Selected batch has an invalid standard. Use 11th or 12th.' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const rows = csv
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.trim()))
    .filter((cells) => cells.some(Boolean));

  if (!rows.length) {
    req.session.flash = { type: 'error', text: 'Paste at least one student row to import' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const currentStudents = await get(
    `SELECT COUNT(*) AS total_students FROM users WHERE coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [coachingId, branchId]
  );
  const studentUsage = getStudentUsage(Number(currentStudents?.total_students || 0), coaching);
  if (studentUsage.limit !== null && rows.length > studentUsage.remaining) {
    req.session.flash = { type: 'error', text: `Import exceeds remaining student limit (${studentUsage.remaining}).` };
    return res.redirect('/admin/dashboard?section=students');
  }

  const summary = { created: 0, skipped: 0 };
  for (const cells of rows) {
    const [rollNoRaw, nameRaw, whatsappRaw, parentRaw, emailRaw] = cells;
    const rollNo = String(rollNoRaw || '').trim();
    if (!rollNo || rollNo.toLowerCase() === 'roll') {
      summary.skipped += 1;
      continue;
    }

    const existing = await get(
      `SELECT id FROM users WHERE coaching_id = ? AND branch_id = ? AND roll_no = ? LIMIT 1`,
      [coachingId, branchId, rollNo]
    );
    if (existing) {
      summary.skipped += 1;
      continue;
    }

    const name = String(nameRaw || '').trim() || rollNo;
    const whatsappNumber = String(whatsappRaw || '').trim();
    const parentWhatsappNumber = String(parentRaw || '').trim();
    const email = String(emailRaw || '').trim().toLowerCase();
    const passwordHash = await bcrypt.hash(rollNo, 10);

    try {
      await run(
        `INSERT INTO users (
          coaching_id, branch_id, role, is_owner, username, roll_no, name, batch_id, standard, course,
          contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number, email, password_hash
        ) VALUES (?, ?, 'student', 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          coachingId,
          branchId,
          rollNo,
          name,
          batch.id,
          normalizedBatchStandard.value,
          batch.course || null,
          whatsappNumber || null,
          parentWhatsappNumber || null,
          whatsappNumber || null,
          parentWhatsappNumber || null,
          email || null,
          passwordHash,
        ]
      );
    } catch (error) {
      const duplicateBranchRoll = error.code === '23505'
        && (
          error.constraint === 'idx_users_coaching_branch_roll'
          || String(error.detail || '').includes('(coaching_id, branch_id, roll_no)')
        );
      if (duplicateBranchRoll) {
        summary.skipped += 1;
        continue;
      }
      throw error;
    }
    summary.created += 1;
  }

  await auditActor(req, 'students_imported', {
    targetType: 'batch',
    targetId: batch.id,
    details: { batchName: batch.name, created: summary.created, skipped: summary.skipped },
  });
  req.session.flash = { type: 'success', text: `Import complete. Created: ${summary.created}, Skipped: ${summary.skipped}.` };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/batches', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const batchName = normalizeBatchName(req.body.batchName);

  if (!batchName) {
    req.session.flash = { type: 'error', text: 'Batch name is required' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const normalizedName = batchName.toLowerCase();
  const meta = extractBatchMeta(batchName);
  const existing = await get(
    `SELECT id FROM batches WHERE coaching_id = ? AND branch_id = ? AND normalized_name = ? LIMIT 1`,
    [coachingId, branchId, normalizedName]
  );

  if (existing) {
    req.session.flash = { type: 'error', text: 'This batch already exists' };
    return res.redirect('/admin/dashboard?section=students');
  }

  await run(
    `INSERT INTO batches (coaching_id, branch_id, name, normalized_name, standard, course, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [coachingId, branchId, batchName, normalizedName, meta.standard, meta.course, req.session.user.id]
  );

  await auditActor(req, 'batch_created', {
    targetType: 'batch',
    details: { batchName, standard: meta.standard, course: meta.course },
  });
  req.session.flash = { type: 'success', text: `Batch "${batchName}" created successfully` };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/batches/rename', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const newBatchName = normalizeBatchName(req.body.newBatchName);

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Select a batch to update' };
    return res.redirect('/admin/dashboard?section=students');
  }

  if (!newBatchName) {
    req.session.flash = { type: 'error', text: 'Enter the new batch name' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const batch = await getBatchForCoaching(coachingId, branchId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Batch not found' };
    return res.redirect('/admin/dashboard?section=students');
  }
  if (batch.is_retention_batch) {
    req.session.flash = { type: 'error', text: 'Retention batch cannot be renamed' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const normalizedName = newBatchName.toLowerCase();
  const meta = extractBatchMeta(newBatchName);
  const targetBatch = await get(
    `SELECT id, name
     FROM batches
     WHERE coaching_id = ? AND branch_id = ? AND normalized_name = ? AND id <> ?
     LIMIT 1`,
    [coachingId, branchId, normalizedName, batchId]
  );

  if (targetBatch) {
    await withTransaction(async (tx) => {
      await tx.run(
        `UPDATE users
         SET batch_id = ?, standard = ?, course = ?
         WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND batch_id = ?`,
        [targetBatch.id, meta.standard, meta.course, coachingId, branchId, batchId]
      );
      await tx.run(
        `UPDATE batch_notes
         SET batch_id = ?, standard = ?, course = ?
         WHERE coaching_id = ? AND branch_id = ? AND batch_id = ?`,
        [targetBatch.id, meta.standard, meta.course, coachingId, branchId, batchId]
      );
      await tx.run(
        `UPDATE answer_upload_requests
         SET batch_id = ?, standard = ?, course = ?
         WHERE coaching_id = ? AND branch_id = ? AND batch_id = ?`,
        [targetBatch.id, meta.standard, meta.course, coachingId, branchId, batchId]
      );
      await tx.run(`DELETE FROM batches WHERE coaching_id = ? AND branch_id = ? AND id = ?`, [coachingId, branchId, batchId]);
    });

    req.session.flash = {
      type: 'success',
      text: `Batch "${batch.name}" merged into "${targetBatch.name}". Student, note, and upload-window data now follow the updated batch.`,
    };
    await auditActor(req, 'batch_merged', {
      targetType: 'batch',
      targetId: targetBatch.id,
      details: { sourceBatchId: batchId, sourceBatchName: batch.name, targetBatchName: targetBatch.name },
    });
    return res.redirect('/admin/dashboard?section=students');
  }

  await run(
    `UPDATE batches
     SET name = ?, normalized_name = ?, standard = ?, course = ?
     WHERE coaching_id = ? AND branch_id = ? AND id = ?`,
    [newBatchName, normalizedName, meta.standard, meta.course, coachingId, branchId, batchId]
  );

  await run(
    `UPDATE users
     SET standard = ?, course = ?
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND batch_id = ?`,
    [meta.standard, meta.course, coachingId, branchId, batchId]
  );
  await run(
    `UPDATE batch_notes
     SET standard = ?, course = ?
     WHERE coaching_id = ? AND branch_id = ? AND batch_id = ?`,
    [meta.standard, meta.course, coachingId, branchId, batchId]
  );
  await run(
    `UPDATE answer_upload_requests
     SET standard = ?, course = ?
     WHERE coaching_id = ? AND branch_id = ? AND batch_id = ?`,
    [meta.standard, meta.course, coachingId, branchId, batchId]
  );

  req.session.flash = {
    type: 'success',
    text: `Batch updated from "${batch.name}" to "${newBatchName}". The new batch name now appears across students, attendance, fees, notes, and upload windows.`,
  };
  await auditActor(req, 'batch_renamed', {
    targetType: 'batch',
    targetId: batchId,
    details: { oldName: batch.name, newName: newBatchName },
  });
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/batches/:id/delete', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const batchId = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Invalid batch selected' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const batch = await getBatchForCoaching(coachingId, branchId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Batch not found' };
    return res.redirect('/admin/dashboard?section=students');
  }
  if (batch.is_retention_batch) {
    req.session.flash = { type: 'error', text: 'Retention batch cannot be deleted' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const linkedStudents = await get(
    `SELECT COUNT(*) AS total_students
     FROM users
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND batch_id = ?`,
    [coachingId, branchId, batchId]
  );

  if (Number(linkedStudents?.total_students || 0) > 0) {
    req.session.flash = {
      type: 'error',
      text: `Cannot delete ${batch.name} while students are still assigned. Move or delete those students first.`,
    };
    return res.redirect('/admin/dashboard?section=students');
  }

  await withTransaction(async (tx) => {
    const answerRequests = await tx.all(
      `SELECT id
       FROM answer_upload_requests
       WHERE coaching_id = ? AND branch_id = ? AND batch_id = ?`,
      [coachingId, branchId, batchId]
    );

    for (const request of answerRequests) {
      await tx.run(
        `UPDATE test_papers
         SET answer_request_id = NULL
         WHERE coaching_id = ? AND branch_id = ? AND answer_request_id = ?`,
        [coachingId, branchId, request.id]
      );
    }

    await tx.run(`DELETE FROM batch_notes WHERE coaching_id = ? AND branch_id = ? AND batch_id = ?`, [coachingId, branchId, batchId]);
    await tx.run(`DELETE FROM answer_upload_requests WHERE coaching_id = ? AND branch_id = ? AND batch_id = ?`, [coachingId, branchId, batchId]);
    await tx.run(`DELETE FROM batches WHERE coaching_id = ? AND branch_id = ? AND id = ?`, [coachingId, branchId, batchId]);
  });

  await auditActor(req, 'batch_deleted', {
    targetType: 'batch',
    targetId: batchId,
    details: { batchName: batch.name },
  });
  req.session.flash = { type: 'success', text: `Batch "${batch.name}" deleted successfully` };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/batches/:id/complete', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const batchId = Number.parseInt(req.params.id, 10);
  const batch = await getBatchForCoaching(coachingId, branchId, batchId);

  if (!batch || batch.is_retention_batch) {
    req.session.flash = { type: 'error', text: 'Batch not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  await run(
    `UPDATE batches
     SET status = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
     WHERE coaching_id = ? AND branch_id = ? AND id = ?`,
    [coachingId, branchId, batchId]
  );

  await auditActor(req, 'batch_completed', {
    targetType: 'batch',
    targetId: batchId,
    details: { batchName: batch.name },
  });
  req.session.flash = { type: 'success', text: `Batch "${batch.name}" marked as completed.` };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/batches/:id/activate', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const batchId = Number.parseInt(req.params.id, 10);
  const batch = await getBatchForCoaching(coachingId, branchId, batchId);

  if (!batch || batch.is_retention_batch) {
    req.session.flash = { type: 'error', text: 'Batch not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  await run(
    `UPDATE batches
     SET status = 'active', completed_at = NULL
     WHERE coaching_id = ? AND branch_id = ? AND id = ?`,
    [coachingId, branchId, batchId]
  );

  await auditActor(req, 'batch_reactivated', {
    targetType: 'batch',
    targetId: batchId,
    details: { batchName: batch.name },
  });
  req.session.flash = { type: 'success', text: `Batch "${batch.name}" moved back to active.` };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/batches/:id/retain-student', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const batchId = Number.parseInt(req.params.id, 10);
  const studentId = Number.parseInt(String(req.body.studentId || '').trim(), 10);
  const batch = await getBatchForCoaching(coachingId, branchId, batchId);

  if (!batch || batch.is_retention_batch || batch.status !== 'completed') {
    req.session.flash = { type: 'error', text: 'Only completed batches can move retained students.' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const student = await get(
    `SELECT id, roll_no, name, batch_id, is_retained_record
     FROM users
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'student'
     LIMIT 1`,
    [studentId, coachingId, branchId]
  );

  if (!student || Number(student.batch_id || 0) !== batchId || student.is_retained_record) {
    req.session.flash = { type: 'error', text: 'Selected student is not available in this completed batch.' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const retainedCount = await get(
    `SELECT COUNT(*) AS total
     FROM users
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND is_retained_record = 1 AND retention_source_batch_id = ?`,
    [coachingId, branchId, batchId]
  );

  if (Number(retainedCount?.total || 0) >= RETENTION_MAX_STUDENTS_PER_SOURCE_BATCH) {
    req.session.flash = { type: 'error', text: `Only ${RETENTION_MAX_STUDENTS_PER_SOURCE_BATCH} retained students are allowed from one completed batch.` };
    return res.redirect('/admin/dashboard?section=students');
  }

  const retentionBatch = await ensureRetentionBatch(coachingId, branchId, req.session.user.id);
  await run(
    `UPDATE users
     SET batch_id = ?, standard = NULL, course = NULL, is_retained_record = 1, retention_source_batch_id = ?
     WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
    [retentionBatch.id, batchId, studentId, coachingId, branchId]
  );

  await auditActor(req, 'student_moved_to_retention', {
    targetType: 'student',
    targetId: studentId,
    details: { rollNo: student.roll_no, sourceBatch: batch.name, retentionBatch: retentionBatch.name },
  });
  req.session.flash = { type: 'success', text: `${student.roll_no} moved to retained student records.` };
  return res.redirect('/admin/dashboard?section=students');
});

app.get('/admin/search-student', requireCoachingAdmin, async (req, res) => {
  const roll = String(req.query.roll || '').trim();

  if (!roll) {
    req.session.flash = { type: 'error', text: 'Please enter a roll number to search.' };
    return res.redirect('/admin/dashboard?section=students');
  }
  return res.redirect(`/admin/dashboard?section=students&studentSearch=${encodeURIComponent(roll)}`);
});

app.get('/admin/students/:id/overview', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const studentId = Number(req.params.id);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const dashboard = await getStudentDashboardPayload(coachingId, branchId, studentId);

  if (!dashboard.profile) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  startAdminStudentPreview(req, studentId);
  const whatsappOnboarding = await getStudentOnboardingStatus(coachingId, branchId, studentId);
  renderWithMessage(res, 'admin-student-overview', {
    user: req.session.user,
    coaching,
    branding: buildBranding(coaching),
    student: dashboard.profile,
    papers: dashboard.papers,
    attendance: dashboard.attendance,
    fees: dashboard.fees,
    notes: dashboard.notes,
    attendanceSummary: dashboard.attendanceSummary,
    feeSummary: dashboard.feeSummary,
    marksSummary: dashboard.marksSummary,
    progressSeries: dashboard.progressSeries,
    whatsappOnboarding,
    flash: req.session.flash,
  });
  req.session.flash = null;
});

app.post('/admin/students/:id/resend-whatsapp', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const studentId = Number(req.params.id);
  const result = await sendStudentOnboarding(studentId, { coachingId, branchId });

  req.session.flash = result.error
    ? { type: 'error', text: result.error }
    : result.failed
      ? { type: 'error', text: `WhatsApp resend failed for ${result.failed} recipient(s).` }
      : { type: 'success', text: result.sent ? 'WhatsApp onboarding sent.' : 'WhatsApp onboarding was already delivered.' };
  return res.redirect(`/admin/students/${studentId}/overview`);
});

app.post('/admin/students/:id/update', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const studentId = Number(req.params.id);
  const student = await get(
    `SELECT id
     FROM users
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'student'
     LIMIT 1`,
    [studentId, coachingId, branchId]
  );

  if (!student) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const name = String(req.body.name || '').trim();
  const contactPhone = String(req.body.contactPhone || '').trim();
  const guardianPhone = String(req.body.guardianPhone || '').trim();
  const parentName = String(req.body.parentName || '').trim();
  const whatsappNumber = String(req.body.whatsappNumber || contactPhone).trim();
  const parentWhatsappNumber = String(req.body.parentWhatsappNumber || guardianPhone).trim();
  const email = String(req.body.email || '').trim().toLowerCase();

  await run(
    `UPDATE users
     SET name = ?, contact_phone = ?, guardian_phone = ?, parent_name = ?, whatsapp_number = ?, parent_whatsapp_number = ?, email = ?
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [
      name || null,
      contactPhone || null,
      guardianPhone || null,
      parentName || null,
      whatsappNumber || null,
      parentWhatsappNumber || null,
      email || null,
      studentId,
      coachingId,
      branchId,
    ]
  );

  await auditActor(req, 'student_updated', {
    targetType: 'student',
    targetId: studentId,
    details: { contactPhone, guardianPhone, whatsappNumber, parentWhatsappNumber },
  });
  req.session.flash = { type: 'success', text: 'Student details updated.' };
  return res.redirect(`/admin/students/${studentId}/overview`);
});

app.post('/admin/students/:id/fees', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const studentId = Number.parseInt(String(req.params.id || '').trim(), 10);
  console.log('[STUDENT FEE FORM] payload=', req.body, `studentId=${studentId}`);

  const student = await get(
    `SELECT id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
     FROM users
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'student'
     LIMIT 1`,
    [studentId, coachingId, branchId]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const amount = Number(req.body.amount);
  const status = String(req.body.status || 'pending').trim().toLowerCase();
  const dueDate = String(req.body.dueDate || '').trim() || null;
  const paymentDate = String(req.body.paymentDate || '').trim() || null;
  const paymentMode = String(req.body.paymentMode || '').trim();
  const notes = String(req.body.notes || '').trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    req.session.flash = { type: 'error', text: 'Enter a valid fee amount before saving payment details.' };
    return res.redirect(`/admin/students/${studentId}/overview`);
  }
  if (!['pending', 'paid', 'overdue'].includes(status)) {
    req.session.flash = { type: 'error', text: 'Select a valid fee status.' };
    return res.redirect(`/admin/students/${studentId}/overview`);
  }

  try {
    const feeId = await saveAdminFeeRecord({
      coachingId,
      branchId,
      studentId,
      amount,
      dueDate,
      paymentDate,
      status,
      notes,
      paymentMode,
      addedBy: req.session.user.id,
    });

    if (status === 'paid') {
      await applyStudentPayment({ coachingId, branchId, studentId, amount });
    } else if (status === 'pending' || status === 'overdue') {
      await setStudentTotalFee({ coachingId, branchId, studentId, totalFee: amount });
    }

    queueFeeWhatsAppAfterSave({ coachingId, branchId, feeId, student });
    await auditActor(req, 'student_fee_saved_from_overview', {
      targetType: 'student',
      targetId: studentId,
      details: { rollNo: student.roll_no, amount, status, dueDate, paymentDate },
    });
    req.session.flash = { type: 'success', text: 'Fee record saved.' };
  } catch (error) {
    req.session.flash = { type: 'error', text: `Fee save failed: ${error.message}` };
  }

  return res.redirect(`/admin/students/${studentId}/overview`);
});

app.post('/admin/students/:id/reset-password', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const studentId = Number(req.params.id);
  const student = await get(
    `SELECT id, roll_no
     FROM users
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [studentId, coachingId, branchId]
  );

  if (!student) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const passwordHash = await bcrypt.hash(student.roll_no, 10);
  await run(`UPDATE users SET password_hash = ? WHERE id = ? AND branch_id = ?`, [passwordHash, studentId, branchId]);

  req.session.flash = {
    type: 'success',
    text: `Password reset for ${student.roll_no}. Student can now use roll number as password`,
  };
  await auditActor(req, 'student_password_reset', {
    targetType: 'student',
    targetId: studentId,
    details: { rollNo: student.roll_no },
  });
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/students/:id/delete', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const studentId = Number(req.params.id);

  const student = await get(
    `SELECT id, roll_no FROM users WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [studentId, coachingId, branchId]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const files = await all(
    `SELECT stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`,
    [coachingId, branchId, studentId]
  );

  await run(`DELETE FROM attendance WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`, [coachingId, branchId, studentId]);
  await run(`DELETE FROM fees WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`, [coachingId, branchId, studentId]);
  await run(`DELETE FROM notification_logs WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`, [coachingId, branchId, studentId]);
  await run(`DELETE FROM whatsapp_logs WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`, [coachingId, branchId, studentId]);
  await run(`DELETE FROM test_papers WHERE coaching_id = ? AND branch_id = ? AND student_id = ?`, [coachingId, branchId, studentId]);
  await run(`DELETE FROM users WHERE id = ? AND coaching_id = ? AND branch_id = ?`, [studentId, coachingId, branchId]);

  for (const file of files) {
    try {
      await deleteStoredPaper(file);
    } catch (err) {
      console.error('Failed deleting stored paper', err);
    }
  }

  req.session.flash = { type: 'success', text: `Student ${student.roll_no} deleted successfully` };
  await auditActor(req, 'student_deleted', {
    targetType: 'student',
    targetId: studentId,
    details: { rollNo: student.roll_no, filesDeleted: files.length },
  });
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/upload-paper-single', requireCoachingAdmin, upload.single('paper'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const file = req.file;
  const rollNo = (req.body.rollNo || '').trim();
  const testLabel = (req.body.testLabel || '').trim();
  const marksObtained = parseOptionalNumber(req.body.marksObtained);
  const maxMarks = parseOptionalNumber(req.body.maxMarks);
  const answerRequestId = parseOptionalNumber(req.body.answerRequestId);

  if (!file) {
    req.session.flash = { type: 'error', text: 'Select a file to upload' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  const student = await get(
    `SELECT id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number, batch_id, standard, course
     FROM users
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND roll_no = ?`,
    [coachingId, branchId, rollNo]
  );

  if (!student) {
    req.session.flash = { type: 'error', text: 'Student roll number not found' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  if ((marksObtained === null) !== (maxMarks === null)) {
    req.session.flash = { type: 'error', text: 'Enter both obtained marks and max marks, or leave both blank' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  let linkedAnswerRequest = null;
  if (answerRequestId !== null) {
    linkedAnswerRequest = await get(
      `SELECT id, batch_id, standard, course, title
       FROM answer_upload_requests
       WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
      [answerRequestId, coachingId, branchId]
    );
    if (!linkedAnswerRequest) {
      req.session.flash = { type: 'error', text: 'Selected answer upload request was not found' };
      return res.redirect('/admin/dashboard?section=papers');
    }

    const studentMatchesRequest = linkedAnswerRequest.batch_id
      ? Number(linkedAnswerRequest.batch_id) === Number(student.batch_id || 0)
      : linkedAnswerRequest.standard === student.standard && linkedAnswerRequest.course === student.course;

    if (!studentMatchesRequest) {
      req.session.flash = { type: 'error', text: `Student ${student.roll_no} does not belong to the selected upload window batch` };
      return res.redirect('/admin/dashboard?section=papers');
    }
  }

  const result = await savePaperUpload({
    coachingId,
    branchId,
    studentId: student.id,
    file,
    uploadedBy: req.session.user.id,
    testLabel: testLabel || file.originalname,
    marksObtained,
    maxMarks,
    answerRequestId: linkedAnswerRequest ? linkedAnswerRequest.id : null,
  });

  const textByStatus = {
    inserted: `Paper uploaded for ${student.roll_no}`,
    replaced: `Paper updated for ${student.roll_no}. Previous upload was replaced.`,
    duplicate: `Duplicate click ignored. Latest paper for ${student.roll_no} is already saved.`,
  };
  await auditActor(req, 'paper_uploaded_single', {
    targetType: 'student',
    targetId: student.id,
    details: { rollNo: student.roll_no, fileName: file.originalname, status: result.status },
  });
  if (result.status !== 'duplicate') {
    await notifyPaperEvent({
      req,
      coaching,
      student,
      paperId: result.paperId,
      type: marksObtained !== null && maxMarks !== null ? 'test_result_published' : 'test_paper_upload',
    });
  }
  req.session.flash = { type: 'success', text: textByStatus[result.status] || `Paper uploaded for ${student.roll_no}` };
  return res.redirect('/admin/dashboard?section=papers');
});

app.post('/admin/upload-papers', requireCoachingAdmin, upload.array('papers', 100), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const files = req.files || [];

  if (!files.length) {
    req.session.flash = { type: 'error', text: 'No files uploaded' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  const report = { assigned: 0, skipped: 0, failed: 0, duplicates: 0, details: [] };

  for (const file of files) {
    const paperMeta = parsePaperMetaFromFileName(file.originalname);
    if (!String(paperMeta.rollNo || '').trim()) {
      report.failed += 1;
      report.details.push({ file: file.originalname, reason: 'Could not detect roll number from filename' });
      continue;
    }

    const student = await get(
      `SELECT id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number FROM users WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND roll_no = ?`,
      [coachingId, branchId, paperMeta.rollNo]
    );

    if (!student) {
      report.skipped += 1;
      report.details.push({ file: file.originalname, reason: `No student found for roll number "${paperMeta.rollNo}"` });
      continue;
    }

    try {
      const result = await savePaperUpload({
        coachingId,
        branchId,
        studentId: student.id,
        file,
        uploadedBy: req.session.user.id,
        testLabel: paperMeta.testLabel || file.originalname,
        marksObtained: paperMeta.marksObtained,
        maxMarks: paperMeta.maxMarks,
        answerRequestId: null,
      });

      if (result.status === 'duplicate') {
        report.duplicates += 1;
        report.details.push({ file: file.originalname, reason: `Duplicate ignored for roll number "${paperMeta.rollNo}"` });
      } else {
        report.assigned += 1;
        report.details.push({ file: file.originalname, reason: `Assigned to roll number "${paperMeta.rollNo}"` });
        await notifyPaperEvent({
          req,
          coaching,
          student,
          paperId: result.paperId,
          type: paperMeta.marksObtained !== null && paperMeta.maxMarks !== null ? 'test_result_published' : 'test_paper_upload',
        });
      }
    } catch (err) {
      console.error('Upload failed for', file.originalname, err);
      report.failed += 1;
      report.details.push({ file: file.originalname, reason: err.message || 'Upload failed while saving file' });
    }
  }

  req.session.flash = {
    type: report.failed ? 'error' : 'success',
    text: `Upload complete. Assigned: ${report.assigned}, Duplicate ignored: ${report.duplicates}, Skipped: ${report.skipped}, Failed: ${report.failed}`,
    details: report.details.slice(0, 20),
  };
  await auditActor(req, 'paper_uploaded_bulk', {
    targetType: 'paper_batch',
    details: report,
  });
  return res.redirect('/admin/dashboard?section=papers');
});

app.get('/admin/omr/import-results', requireCoachingAdmin, (req, res) => {
  console.log('[OMR IMPORT] GET redirected to papers page', {
    originalUrl: req.originalUrl,
    adminId: req.session?.user?.id || null,
  });
  return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
});

app.post('/admin/omr/import-results', requireCoachingAdmin, handleOmrImportUpload, asyncAdminPapersRoute(async (req, res) => {
  console.log('[OMR IMPORT] handler reached', {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
    adminId: req.session?.user?.id || null,
    branchId: getCurrentBranchId(req),
    contentType: req.headers['content-type'] || '',
    contentLength: req.headers['content-length'] || '',
    bodyKeys: Object.keys(req.body || {}),
    fileFields: Object.keys(req.files || {}),
    reqBodyCsrf: req.body?._csrf || '',
    reqQueryCsrf: req.query?._csrf || '',
    reqSessionCsrfToken: req.session?.csrfToken || '',
  });

  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const testLabel = String(req.body.testLabel || '').trim();
  const maxMarks = parseOmrNumber(req.body.maxMarks);
  const csvFile = (req.files?.omrCsv || [])[0];
  const uploadedSheets = req.files?.answerSheets || [];

  if (!testLabel) {
    req.session.flash = { type: 'error', text: 'Enter a test name before importing OMR results.' };
    return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
  }
  if (!maxMarks || maxMarks <= 0) {
    req.session.flash = { type: 'error', text: 'Enter valid max marks so graphs and percentages can be generated.' };
    return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
  }
  if (!csvFile || !/\.csv$/i.test(csvFile.originalname || '')) {
    req.session.flash = { type: 'error', text: 'Upload one OMR result CSV file.' };
    return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
  }

  let parsedRows;
  try {
    parsedRows = toOmrTableRows(csvFile.buffer, maxMarks);
  } catch (error) {
    req.session.flash = { type: 'error', text: `Could not parse OMR CSV: ${error.message}` };
    console.error('[OMR IMPORT] CSV parse failed', {
      fileName: csvFile.originalname,
      error: error.message,
      stack: error.stack,
    });
    return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
  }
  console.log('[OMR IMPORT] CSV parsed', {
    fileName: csvFile.originalname,
    rowCount: parsedRows.length,
    testLabel,
    maxMarks,
  });

  const students = await all(
    `SELECT id, roll_no, name
     FROM users
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [coachingId, branchId]
  );
  const studentByRoll = new Map(students.map((student) => [String(student.roll_no || '').trim().toLowerCase(), student]));
  const normalizedRows = parsedRows.map((row) => {
    const rollKey = String(row.rollNo || '').trim().toLowerCase();
    const student = rollKey ? studentByRoll.get(rollKey) : null;
    let status = 'ready';
    let error = '';
    if (!rollKey) {
      status = 'skipped';
      error = 'Missing Roll No';
    } else if (!student) {
      status = 'unmatched';
      error = `Roll No ${row.rollNo} not found`;
    } else if (row.obtainedMarks === null || row.obtainedMarks === undefined) {
      status = 'skipped';
      error = 'Missing Total Marks';
    }
    return {
      ...row,
      studentId: student?.id || null,
      matchedRollNo: student?.roll_no || row.rollNo || '',
      studentName: student?.name || row.studentName || '',
      status,
      error,
    };
  });
  const readyRows = normalizedRows.filter((row) => row.status === 'ready');
  const readyRolls = new Map(readyRows.map((row) => [String(row.matchedRollNo || row.rollNo).trim().toLowerCase(), row]));
  const { files: scanFiles, errors: sheetErrors } = expandOmrSheetFiles(uploadedSheets);
  const scanByRoll = new Map();
  const scanErrors = [...sheetErrors];
  console.log('[OMR IMPORT] rows matched', {
    parsed: normalizedRows.length,
    ready: readyRows.length,
    skipped: normalizedRows.filter((row) => row.status === 'skipped').length,
    unmatched: normalizedRows.filter((row) => row.status === 'unmatched').length,
    uploadedSheetFiles: uploadedSheets.length,
  });

  for (const file of scanFiles) {
    if (!/\.(pdf|jpe?g|png)$/i.test(file.originalname || '')) {
      scanErrors.push(`${file.originalname}: unsupported answer sheet type`);
      continue;
    }
    let rollNo = '';
    if (scanFiles.length === 1 && readyRows.length === 1) {
      rollNo = String(readyRows[0].matchedRollNo || readyRows[0].rollNo).trim();
    } else {
      rollNo = getExactSheetRollNo(file.originalname);
    }
    const rollKey = String(rollNo || '').trim().toLowerCase();
    if (!readyRolls.has(rollKey)) {
      scanErrors.push(`${file.originalname}: filename must be exact Roll No from CSV, for example 101.pdf`);
      continue;
    }
    scanByRoll.set(rollKey, file);
  }

  console.log('[OMR IMPORT] database transaction starting', {
    readyRows: readyRows.length,
    errorRows: normalizedRows.filter((row) => row.status !== 'ready').length,
    scanErrors: scanErrors.length,
  });

  const importSummary = await withTransaction(async (tx) => {
    console.log('[OMR IMPORT][TX] callback entered');
    console.log('[OMR IMPORT][TX] before build error rows');
    const errorRows = normalizedRows.filter((row) => row.status !== 'ready').map((row) => ({
      rowNumber: row.rowNumber,
      rollNo: row.rollNo || '',
      studentName: row.studentName || '',
      status: row.status,
      error: row.error,
    }));
    console.log('[OMR IMPORT][TX] after build error rows', {
      count: errorRows.length,
    });
    console.log('[OMR IMPORT][TX] before insert import header');
    const importRow = await tx.run(
      `INSERT INTO omr_imports (
        coaching_id, branch_id, test_label, original_file_name, row_count, matched_count,
        unmatched_count, duplicate_count, overwrite_enabled, error_report, imported_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, TRUE, ?::jsonb, ?)`,
      [
        coachingId,
        branchId,
        testLabel,
        csvFile.originalname,
        normalizedRows.length,
        readyRows.length,
        normalizedRows.filter((row) => row.status === 'unmatched').length,
        JSON.stringify([...errorRows, ...scanErrors.map((error) => ({ status: 'sheet_error', error }))]),
        req.session.user.id,
      ]
    );
    console.log('[OMR IMPORT][TX] after insert import header', {
      importId: importRow.lastID,
      rowCount: importRow.rowCount,
    });
    const importId = importRow.lastID;
    const details = [];
    const importedPapers = [];
    const importedAuditRows = [];
    const skippedAuditRows = [];

    console.log('[OMR IMPORT][TX] before ready rows loop', {
      count: readyRows.length,
    });
    for (const row of readyRows) {
      console.log('[OMR IMPORT][TX] before select existing paper', {
        rollNo: row.matchedRollNo || row.rollNo,
        studentId: row.studentId,
        testLabel,
      });
      let paper = await tx.get(
        `SELECT id
         FROM test_papers
         WHERE coaching_id = ? AND branch_id = ? AND student_id = ? AND test_label = ?
         ORDER BY upload_date DESC, id DESC
         LIMIT 1`,
        [coachingId, branchId, row.studentId, testLabel]
      );
      console.log('[OMR IMPORT][TX] after select existing paper', {
        rollNo: row.matchedRollNo || row.rollNo,
        paperId: paper?.id || null,
      });
      if (paper) {
        console.log('[OMR IMPORT][TX] before update paper', {
          rollNo: row.matchedRollNo || row.rollNo,
          paperId: paper.id,
        });
        await tx.run(
          `UPDATE test_papers
           SET marks_obtained = ?, max_marks = ?, percentage = ?, physics_marks = ?, chemistry_marks = ?,
               biology_marks = ?, botany_marks = ?, zoology_marks = ?, omr_rank = ?, omr_import_id = ?,
               paper_type = 'omr_result', upload_date = CURRENT_TIMESTAMP
           WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
          [
            row.obtainedMarks,
            row.maxMarks,
            row.percentage,
            row.physicsMarks,
            row.chemistryMarks,
            row.biologyMarks,
            row.botanyMarks,
            row.zoologyMarks,
            row.rank,
            importId,
            paper.id,
            coachingId,
            branchId,
          ]
        );
        console.log('[OMR IMPORT][TX] after update paper', {
          rollNo: row.matchedRollNo || row.rollNo,
          paperId: paper.id,
        });
      } else {
        console.log('[OMR IMPORT][TX] before insert paper', {
          rollNo: row.matchedRollNo || row.rollNo,
          studentId: row.studentId,
        });
        const inserted = await tx.run(
          `INSERT INTO test_papers (
            coaching_id, branch_id, student_id, original_name, stored_name, uploaded_by,
            storage_type, storage_key, public_url, content_type, size_bytes,
            marks_obtained, max_marks, percentage, test_label, paper_type,
            physics_marks, chemistry_marks, biology_marks, botany_marks, zoology_marks,
            omr_rank, omr_import_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'omr', NULL, NULL, NULL, 0, ?, ?, ?, ?, 'omr_result', ?, ?, ?, ?, ?, ?, ?)`,
          [
            coachingId,
            branchId,
            row.studentId,
            `${testLabel}-${row.matchedRollNo}.csv`,
            `${testLabel}-${row.matchedRollNo}.csv`,
            req.session.user.id,
            row.obtainedMarks,
            row.maxMarks,
            row.percentage,
            testLabel,
            row.physicsMarks,
            row.chemistryMarks,
            row.biologyMarks,
            row.botanyMarks,
            row.zoologyMarks,
            row.rank,
            importId,
          ]
        );
        console.log('[OMR IMPORT][TX] after insert paper', {
          rollNo: row.matchedRollNo || row.rollNo,
          paperId: inserted.lastID,
          rowCount: inserted.rowCount,
        });
        paper = { id: inserted.lastID };
      }

      const rollKey = String(row.matchedRollNo || row.rollNo).trim().toLowerCase();
      const scanFile = scanByRoll.get(rollKey);
      if (scanFile) {
        const targetPath = getOmrStoragePath(paper.id, row.matchedRollNo || row.rollNo, scanFile.originalname);
        console.log('[OMR IMPORT][TX] before create answer sheet directory', {
          rollNo: row.matchedRollNo || row.rollNo,
          targetDir: path.dirname(targetPath),
        });
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        console.log('[OMR IMPORT][TX] after create answer sheet directory', {
          rollNo: row.matchedRollNo || row.rollNo,
          targetDir: path.dirname(targetPath),
        });
        console.log('[OMR IMPORT][TX] before write answer sheet', {
          rollNo: row.matchedRollNo || row.rollNo,
          targetPath,
          bytes: scanFile.buffer?.length || 0,
        });
        await fs.promises.writeFile(targetPath, scanFile.buffer);
        console.log('[OMR IMPORT][TX] after write answer sheet', {
          rollNo: row.matchedRollNo || row.rollNo,
          targetPath,
        });
        console.log('[OMR IMPORT][TX] before update paper answer sheet path', {
          rollNo: row.matchedRollNo || row.rollNo,
          paperId: paper.id,
        });
        await tx.run(
          `UPDATE test_papers
           SET omr_scan_path = ?, omr_scan_original_name = ?, omr_scan_uploaded_at = CURRENT_TIMESTAMP
           WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
          [targetPath, sanitizeOmrFileName(scanFile.originalname), paper.id, coachingId, branchId]
        );
        console.log('[OMR IMPORT][TX] after update paper answer sheet path', {
          rollNo: row.matchedRollNo || row.rollNo,
          paperId: paper.id,
        });
      }

      console.log('[OMR IMPORT][TX] before queue imported row audit', {
        rollNo: row.matchedRollNo || row.rollNo,
        paperId: paper.id,
      });
      importedAuditRows.push([
        importId,
        coachingId,
        branchId,
        row.studentId,
        row.matchedRollNo || row.rollNo,
        paper.id,
        row.obtainedMarks,
        row.maxMarks,
        row.percentage,
        row.physicsMarks,
        row.chemistryMarks,
        row.biologyMarks,
        row.botanyMarks,
        row.zoologyMarks,
        row.rank,
        JSON.stringify(row.raw || {}),
      ]);
      console.log('[OMR IMPORT][TX] after queue imported row audit', {
        rollNo: row.matchedRollNo || row.rollNo,
        paperId: paper.id,
      });
      details.push({ rollNo: row.matchedRollNo || row.rollNo, reason: scanFile ? 'Imported with answer sheet' : 'Imported' });
      importedPapers.push({ studentId: row.studentId, paperId: paper.id });
    }
    console.log('[OMR IMPORT][TX] after ready rows loop', {
      count: readyRows.length,
      importedAuditRows: importedAuditRows.length,
    });

    console.log('[OMR IMPORT][TX] before skipped rows loop', {
      count: normalizedRows.filter((item) => item.status !== 'ready').length,
    });
    for (const row of normalizedRows.filter((item) => item.status !== 'ready')) {
      console.log('[OMR IMPORT][TX] before queue skipped row audit', {
        rollNo: row.rollNo || null,
        status: row.status,
        error: row.error,
      });
      skippedAuditRows.push([
        importId,
        coachingId,
        branchId,
        row.rollNo || null,
        row.obtainedMarks,
        row.maxMarks,
        row.percentage,
        row.physicsMarks,
        row.chemistryMarks,
        row.biologyMarks,
        row.botanyMarks,
        row.zoologyMarks,
        row.rank,
        row.status,
        row.error,
        JSON.stringify(row.raw || {}),
      ]);
      console.log('[OMR IMPORT][TX] after queue skipped row audit', {
        rollNo: row.rollNo || null,
        status: row.status,
      });
      details.push({ rollNo: row.rollNo || '-', reason: row.error });
    }
    console.log('[OMR IMPORT][TX] after skipped rows loop', {
      skippedAuditRows: skippedAuditRows.length,
    });

    if (importedAuditRows.length) {
      console.log('[OMR IMPORT][TX] before batch insert imported row audits', {
        count: importedAuditRows.length,
      });
      await tx.run(
        `INSERT INTO omr_import_rows (
          import_id, coaching_id, branch_id, student_id, roll_no, test_paper_id,
          obtained_marks, max_marks, percentage, physics_marks, chemistry_marks, biology_marks,
          botany_marks, zoology_marks, rank, row_status, raw_data
        ) VALUES ${importedAuditRows.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?::jsonb)`).join(', ')}`,
        importedAuditRows.flat()
      );
      console.log('[OMR IMPORT][TX] after batch insert imported row audits', {
        count: importedAuditRows.length,
      });
    } else {
      console.log('[OMR IMPORT][TX] skipped batch insert imported row audits');
    }

    if (skippedAuditRows.length) {
      console.log('[OMR IMPORT][TX] before batch insert skipped row audits', {
        count: skippedAuditRows.length,
      });
      await tx.run(
        `INSERT INTO omr_import_rows (
          import_id, coaching_id, branch_id, student_id, roll_no, obtained_marks, max_marks,
          percentage, physics_marks, chemistry_marks, biology_marks, botany_marks, zoology_marks,
          rank, row_status, error_message, raw_data
        ) VALUES ${skippedAuditRows.map(() => `(?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)`).join(', ')}`,
        skippedAuditRows.flat()
      );
      console.log('[OMR IMPORT][TX] after batch insert skipped row audits', {
        count: skippedAuditRows.length,
      });
    } else {
      console.log('[OMR IMPORT][TX] skipped batch insert skipped row audits');
    }

    console.log('[OMR IMPORT][TX] before build import summary');
    const summary = {
      importId,
      imported: readyRows.length,
      skipped: normalizedRows.filter((row) => row.status === 'skipped').length,
      unmatchedRollNumbers: normalizedRows.filter((row) => row.status === 'unmatched').map((row) => row.rollNo),
      sheetErrors: scanErrors,
      details,
      importedPapers,
    };
    console.log('[OMR IMPORT][TX] after build import summary', {
      importId: summary.importId,
      imported: summary.imported,
      skipped: summary.skipped,
      unmatched: summary.unmatchedRollNumbers.length,
      sheetErrors: summary.sheetErrors.length,
    });
    return summary;
  });
  console.log('[OMR IMPORT] database transaction committed', {
    importId: importSummary.importId,
    imported: importSummary.imported,
    skipped: importSummary.skipped,
    unmatched: importSummary.unmatchedRollNumbers.length,
    sheetErrors: importSummary.sheetErrors.length,
  });

  await auditActor(req, 'omr_results_imported', {
    targetType: 'omr_import',
    targetId: importSummary.importId,
    details: {
      testLabel,
      imported: importSummary.imported,
      skipped: importSummary.skipped,
      unmatchedRollNumbers: importSummary.unmatchedRollNumbers,
      sheetErrors: importSummary.sheetErrors,
    },
  });

  await notifyOmrImportResults({
    req,
    coaching: req.currentCoaching || await getCoachingContextById(coachingId),
    coachingId,
    branchId,
    testLabel,
    importId: importSummary.importId,
    importedPapers: importSummary.importedPapers,
  });

  req.session.flash = {
    type: importSummary.unmatchedRollNumbers.length || importSummary.skipped || importSummary.sheetErrors.length ? 'warning' : 'success',
    text: `OMR import complete. Imported: ${importSummary.imported}, Skipped: ${importSummary.skipped}, Unmatched: ${importSummary.unmatchedRollNumbers.length}, Errors: ${importSummary.sheetErrors.length}`,
    details: [
      ...importSummary.unmatchedRollNumbers.map((rollNo) => ({ file: `Roll ${rollNo}`, reason: 'Roll No not found' })),
      ...importSummary.sheetErrors.map((error) => ({ file: 'Answer sheet', reason: error })),
      ...importSummary.details.slice(0, 15),
    ].slice(0, 30),
  };
  console.log('[OMR IMPORT] redirect executed', {
    location: '/admin/dashboard?section=papers#omr-import-panel',
    importId: importSummary.importId,
  });
  return res.redirect('/admin/dashboard?section=papers#omr-import-panel');
}));

app.post('/admin/omr/import/preview', requireCoachingAdmin, omrUpload.single('omrFile'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const testLabel = String(req.body.testLabel || '').trim();
  const fallbackMaxMarks = parseOmrNumber(req.body.maxMarks);
  const overwrite = req.body.overwrite === 'on';
  const file = req.file;

  if (!testLabel) {
    req.session.flash = { type: 'error', text: 'Enter a test name before importing OMR results.' };
    return res.redirect('/admin/dashboard?section=omr');
  }
  if (!file) {
    req.session.flash = { type: 'error', text: 'Select an OMR CSV file.' };
    return res.redirect('/admin/dashboard?section=omr');
  }
  let importRows;
  try {
    importRows = /\.xlsx$/i.test(file.originalname || '') ? parseXlsxRows(file.buffer) : parseCsvRows(file.buffer);
  } catch (error) {
    req.session.flash = { type: 'error', text: `Could not read OMR file: ${error.message}` };
    return res.redirect('/admin/dashboard?section=omr');
  }
  const headers = importRows.shift() || [];
  if (!headers.length) {
    req.session.flash = { type: 'error', text: 'The OMR file does not contain a header row.' };
    return res.redirect('/admin/dashboard?section=omr');
  }
  const normalizedHeaders = headers.map(normalizeOmrHeader);
  const rows = importRows.map((cells) => {
    const raw = {};
    normalizedHeaders.forEach((header, index) => {
      raw[header] = cells[index] || '';
    });
    return normalizeOmrRow(raw, fallbackMaxMarks);
  }).filter((row) => row.rollNo);

  const students = await all(
    `SELECT id, roll_no, name, batch_id
     FROM users
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [coachingId, branchId]
  );
  const studentByRoll = new Map(students.map((student) => [String(student.roll_no || '').trim().toLowerCase(), student]));
  const duplicateRows = await all(
    `SELECT student_id
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ? AND test_label = ?
       AND marks_obtained IS NOT NULL AND max_marks IS NOT NULL`,
    [coachingId, branchId, testLabel]
  );
  const duplicateStudentIds = new Set(duplicateRows.map((row) => Number(row.student_id)));

  const previewRows = rows.map((row, index) => {
    const student = studentByRoll.get(String(row.rollNo || '').trim().toLowerCase()) || null;
    const duplicate = student ? duplicateStudentIds.has(Number(student.id)) : false;
    const status = !student ? 'unmatched' : duplicate && !overwrite ? 'duplicate' : 'ready';
    return {
      rowNumber: index + 2,
      ...row,
      studentId: student?.id || null,
      studentName: student?.name || '',
      matchedRollNo: student?.roll_no || '',
      status,
      error: !student ? 'No student matched by roll number' : duplicate && !overwrite ? 'Duplicate test result exists' : '',
    };
  });

  req.session.omrPreview = {
    coachingId,
    branchId,
    testLabel,
    overwrite,
    maxMarks: fallbackMaxMarks,
    originalFileName: file.originalname,
    createdAt: new Date().toISOString(),
    rows: previewRows,
  };
  req.session.flash = {
    type: 'success',
    text: `Preview ready. Matched ${previewRows.filter((row) => row.status === 'ready').length} row(s), unmatched ${previewRows.filter((row) => row.status === 'unmatched').length}, duplicates ${previewRows.filter((row) => row.status === 'duplicate').length}.`,
  };
  return res.redirect('/admin/dashboard?section=omr');
});

async function getOverallBatchRank(coachingId, branchId, studentId) {
  const target = await get(
    `SELECT id, batch_id
     FROM users
     WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'student'
     LIMIT 1`,
    [studentId, coachingId, branchId]
  );
  if (!target?.batch_id) return null;
  const rows = await all(
    `SELECT u.id AS student_id,
            SUM(COALESCE(tp.marks_obtained, 0)) AS total_obtained,
            SUM(COALESCE(tp.max_marks, 0)) AS total_max
     FROM users u
     JOIN test_papers tp ON tp.student_id = u.id
       AND tp.coaching_id = u.coaching_id
       AND tp.branch_id = u.branch_id
     WHERE u.coaching_id = ? AND u.branch_id = ? AND u.batch_id = ? AND u.role = 'student'
       AND tp.marks_obtained IS NOT NULL AND tp.max_marks IS NOT NULL AND tp.max_marks > 0
     GROUP BY u.id`,
    [coachingId, branchId, target.batch_id]
  );
  const percentages = rows.map((row) => ({
    studentId: Number(row.student_id),
    percentage: Number(row.total_max) > 0 ? (Number(row.total_obtained || 0) / Number(row.total_max)) * 100 : 0,
  }));
  const current = percentages.find((row) => row.studentId === Number(studentId));
  if (!current) return null;
  return percentages.filter((row) => row.percentage > current.percentage).length + 1;
}

app.post('/admin/omr/import/commit', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const preview = req.session.omrPreview;

  if (!preview || preview.coachingId !== coachingId || preview.branchId !== branchId) {
    req.session.flash = { type: 'error', text: 'OMR preview expired. Upload the CSV again.' };
    return res.redirect('/admin/dashboard?section=omr');
  }

  const commitRows = preview.rows.filter((row) => row.status === 'ready');
  if (!commitRows.length) {
    req.session.flash = { type: 'error', text: 'No valid OMR rows to import.' };
    return res.redirect('/admin/dashboard?section=omr');
  }

  const rankBeforeByStudent = new Map();
  await Promise.all(commitRows.map(async (row) => {
    rankBeforeByStudent.set(Number(row.studentId), await getOverallBatchRank(coachingId, branchId, row.studentId));
  }));

  const importResult = await withTransaction(async (tx) => {
    const importRow = await tx.run(
      `INSERT INTO omr_imports (
        coaching_id, branch_id, test_label, original_file_name, row_count, matched_count,
        unmatched_count, duplicate_count, overwrite_enabled, error_report, imported_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)`,
      [
        coachingId,
        branchId,
        preview.testLabel,
        preview.originalFileName,
        preview.rows.length,
        commitRows.length,
        preview.rows.filter((row) => row.status === 'unmatched').length,
        preview.rows.filter((row) => row.status === 'duplicate').length,
        preview.overwrite,
        JSON.stringify(preview.rows.filter((row) => row.status !== 'ready')),
        req.session.user.id,
      ]
    );
    const importId = importRow.lastID;

    const importedPapers = [];
    for (const row of commitRows) {
      let paper = await tx.get(
        `SELECT id
         FROM test_papers
         WHERE coaching_id = ? AND branch_id = ? AND student_id = ? AND test_label = ?
         ORDER BY upload_date DESC, id DESC
         LIMIT 1`,
        [coachingId, branchId, row.studentId, preview.testLabel]
      );
      if (paper) {
        await tx.run(
          `UPDATE test_papers
           SET marks_obtained = ?, max_marks = ?, percentage = ?, correct_count = ?, wrong_count = ?,
               unattempted_count = ?, physics_marks = ?, chemistry_marks = ?, botany_marks = ?,
               zoology_marks = ?, omr_barcode = ?, omr_rank = ?, omr_import_id = ?, upload_date = CURRENT_TIMESTAMP
           WHERE id = ? AND branch_id = ?`,
          [
            row.obtainedMarks,
            row.maxMarks,
            row.percentage,
            row.correctCount,
            row.wrongCount,
            row.unattemptedCount,
            row.physicsMarks,
            row.chemistryMarks,
            row.botanyMarks,
            row.zoologyMarks,
            row.barcode || null,
            row.rank,
            importId,
            paper.id,
            branchId,
          ]
        );
      } else {
        const inserted = await tx.run(
          `INSERT INTO test_papers (
            coaching_id, branch_id, student_id, original_name, stored_name, uploaded_by,
            storage_type, storage_key, public_url, content_type, size_bytes,
            marks_obtained, max_marks, percentage, test_label, paper_type,
            correct_count, wrong_count, unattempted_count, physics_marks, chemistry_marks,
            botany_marks, zoology_marks, omr_barcode, omr_rank, omr_import_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'omr', NULL, NULL, NULL, 0, ?, ?, ?, ?, 'omr_result', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            coachingId,
            branchId,
            row.studentId,
            `${preview.testLabel}-${row.matchedRollNo || row.rollNo}.csv`,
            `${preview.testLabel}-${row.matchedRollNo || row.rollNo}.csv`,
            req.session.user.id,
            row.obtainedMarks,
            row.maxMarks,
            row.percentage,
            preview.testLabel,
            row.correctCount,
            row.wrongCount,
            row.unattemptedCount,
            row.physicsMarks,
            row.chemistryMarks,
            row.botanyMarks,
            row.zoologyMarks,
            row.barcode || null,
            row.rank,
            importId,
          ]
        );
        paper = { id: inserted.lastID };
      }
      await tx.run(
        `INSERT INTO omr_import_rows (
          import_id, coaching_id, branch_id, student_id, roll_no, barcode, test_paper_id,
          obtained_marks, max_marks, percentage, correct_count, wrong_count, unattempted_count,
          physics_marks, chemistry_marks, botany_marks, zoology_marks, rank, row_status, raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?::jsonb)`,
        [
          importId,
          coachingId,
          branchId,
          row.studentId,
          row.matchedRollNo || row.rollNo,
          row.barcode || null,
          paper.id,
          row.obtainedMarks,
          row.maxMarks,
          row.percentage,
          row.correctCount,
          row.wrongCount,
          row.unattemptedCount,
          row.physicsMarks,
          row.chemistryMarks,
          row.botanyMarks,
          row.zoologyMarks,
          row.rank,
          JSON.stringify(row.raw || {}),
        ]
      );
      importedPapers.push({ studentId: row.studentId, paperId: paper.id });
    }
    return { importId, imported: commitRows.length, importedPapers };
  });

  delete req.session.omrPreview;
  await auditActor(req, 'omr_results_imported', {
    targetType: 'omr_import',
    targetId: importResult.importId,
    details: { testLabel: preview.testLabel, imported: importResult.imported, overwrite: preview.overwrite },
  });
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  for (const item of importResult.importedPapers) {
    const beforeRank = rankBeforeByStudent.get(Number(item.studentId));
    const afterRank = await getOverallBatchRank(coachingId, branchId, item.studentId);
    if (beforeRank && afterRank && afterRank < beforeRank) {
      const student = await get(
        `SELECT id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
         FROM users
         WHERE id = ? AND coaching_id = ? AND branch_id = ?
         LIMIT 1`,
        [item.studentId, coachingId, branchId]
      );
      if (student) {
        await notifyPaperEvent({ req, coaching, student, paperId: item.paperId, type: 'test_result_published' });
      }
    }
  }
  req.session.flash = { type: 'success', text: `OMR import committed. ${importResult.imported} result(s) updated.` };
  return res.redirect('/admin/dashboard?section=omr');
});

app.post('/admin/omr/import/cancel', requireCoachingAdmin, async (req, res) => {
  delete req.session.omrPreview;
  req.session.flash = { type: 'success', text: 'OMR preview cleared.' };
  return res.redirect('/admin/dashboard?section=omr');
});

app.post('/admin/omr/scans/upload', requireCoachingAdmin, omrUpload.array('omrScans', 200), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const testLabel = String(req.body.testLabel || '').trim();
  const files = req.files || [];

  if (!testLabel) {
    req.session.flash = { type: 'error', text: 'Enter the test name before uploading OMR sheets.' };
    return res.redirect('/admin/dashboard?section=omr');
  }
  if (!files.length) {
    req.session.flash = { type: 'error', text: 'Select OMR PDF/JPG files.' };
    return res.redirect('/admin/dashboard?section=omr');
  }

  let linked = 0;
  const errors = [];
  const scanFiles = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.originalname || '')) {
      try {
        readZipEntries(file.buffer)
          .filter((entry) => /\.(pdf|jpe?g|png)$/i.test(entry.name))
          .forEach((entry) => scanFiles.push({
            originalname: path.basename(entry.name),
            mimetype: path.extname(entry.name).toLowerCase() === '.pdf' ? 'application/pdf' : path.extname(entry.name).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
            buffer: entry.data,
          }));
      } catch (error) {
        errors.push(`${file.originalname}: ${error.message}`);
      }
    } else {
      scanFiles.push(file);
    }
  }

  for (const file of scanFiles) {
    if (!/\.(pdf|jpe?g|png)$/i.test(file.originalname || '')) {
      errors.push(`${file.originalname}: unsupported file type`);
      continue;
    }
    const rollNo = path.parse(file.originalname).name.split(/[_\-\s]/)[0];
    const student = await get(
      `SELECT id, roll_no
       FROM users
       WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND roll_no = ?
       LIMIT 1`,
      [coachingId, branchId, rollNo]
    );
    if (!student) {
      errors.push(`${file.originalname}: no student found for roll ${rollNo}`);
      continue;
    }
    const paper = await get(
      `SELECT id
       FROM test_papers
       WHERE coaching_id = ? AND branch_id = ? AND student_id = ? AND test_label = ?
       ORDER BY upload_date DESC, id DESC
       LIMIT 1`,
      [coachingId, branchId, student.id, testLabel]
    );
    if (!paper) {
      errors.push(`${file.originalname}: result not imported yet for ${testLabel}`);
      continue;
    }
    const targetPath = getOmrStoragePath(paper.id, student.roll_no, file.originalname);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, file.buffer);
    await run(
      `UPDATE test_papers
       SET omr_scan_path = ?, omr_scan_original_name = ?, omr_scan_uploaded_at = CURRENT_TIMESTAMP
       WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
      [targetPath, sanitizeOmrFileName(file.originalname), paper.id, coachingId, branchId]
    );
    linked += 1;
  }

  await auditActor(req, 'omr_scans_uploaded', {
    targetType: 'omr_scan',
    details: { testLabel, linked, failed: errors.length },
  });
  req.session.flash = {
    type: errors.length ? 'warning' : 'success',
    text: `OMR sheets linked: ${linked}. Failed: ${errors.length}.`,
    details: errors.slice(0, 20),
  };
  return res.redirect('/admin/dashboard?section=omr');
});

app.post('/admin/omr/scans/:paperId/delete', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const paperId = Number(req.params.paperId);
  const paper = await get(
    `SELECT id, omr_scan_path
     FROM test_papers
     WHERE id = ? AND coaching_id = ? AND branch_id = ?
     LIMIT 1`,
    [paperId, coachingId, branchId]
  );
  if (paper?.omr_scan_path) {
    await fs.promises.unlink(paper.omr_scan_path).catch(() => {});
    await run(
      `UPDATE test_papers
       SET omr_scan_path = NULL, omr_scan_original_name = NULL, omr_scan_uploaded_at = NULL
       WHERE id = ? AND branch_id = ?`,
      [paper.id, branchId]
    );
  }
  req.session.flash = { type: 'success', text: 'OMR sheet removed.' };
  return res.redirect('/admin/dashboard?section=omr');
});

async function getOmrScanForSession(paperId, sessionUser) {
  const params = [Number(paperId), sessionUser.coachingId, sessionUser.branchId];
  let scopeSql = '';
  if (sessionUser.role === 'student') {
    scopeSql = ' AND tp.student_id = ?';
    params.push(sessionUser.id);
  }
  return get(
    `SELECT tp.id, tp.omr_scan_path, tp.omr_scan_original_name, tp.test_label, u.roll_no
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id AND u.branch_id = tp.branch_id
     WHERE tp.id = ? AND tp.coaching_id = ? AND tp.branch_id = ?
       AND tp.omr_scan_path IS NOT NULL
       ${scopeSql}
     LIMIT 1`,
    params
  );
}

async function sendOmrScan(req, res, disposition) {
  const paper = await getOmrScanForSession(req.params.paperId, req.session.user);
  if (!paper?.omr_scan_path) return res.status(404).send('OMR sheet not found');
  const resolvedPath = path.resolve(paper.omr_scan_path);
  const expectedRoot = path.resolve(__dirname, '..', 'uploads', 'omr');
  if (!resolvedPath.startsWith(`${expectedRoot}${path.sep}`)) return res.status(403).send('Invalid OMR path');
  try {
    await fs.promises.access(resolvedPath, fs.constants.R_OK);
  } catch {
    return res.status(404).send('OMR sheet file missing');
  }
  const extension = path.extname(resolvedPath).toLowerCase();
  const contentType = extension === '.pdf' ? 'application/pdf' : extension === '.png' ? 'image/png' : 'image/jpeg';
  const safeName = sanitizeOmrFileName(paper.omr_scan_original_name || `${paper.roll_no}-${paper.test_label || 'omr'}${extension}`);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  return fs.createReadStream(resolvedPath).pipe(res);
}

app.get('/omr/:paperId/view', requireAuth, (req, res) => sendOmrScan(req, res, 'inline'));
app.get('/omr/:paperId/download', requireAuth, (req, res) => sendOmrScan(req, res, 'attachment'));

app.get('/admin/papers/:id/debug', requireCoachingAdmin, async (req, res) => {
  const paper = await getPaperForUser(req.params.id, req.session.user);
  if (!paper) {
    return res.status(404).json({ ok: false, error: 'Paper not found' });
  }

  try {
    const access = await getPaperAccess(paper, 'inline');
    return res.json({
      ok: true,
      paper: {
        id: paper.id,
        originalName: paper.original_name,
        storedName: paper.stored_name,
        storageType: paper.storage_type || 'local',
        storageKey: paper.storage_key || null,
        publicUrl: paper.public_url || null,
        contentType: paper.content_type || null,
        uploadDate: paper.upload_date || null,
        coachingId: paper.coaching_id || null,
        studentId: paper.student_id || null,
      },
      access,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to inspect paper',
      paper: {
        id: paper.id,
        originalName: paper.original_name,
        storedName: paper.stored_name,
        storageType: paper.storage_type || 'local',
        storageKey: paper.storage_key || null,
        publicUrl: paper.public_url || null,
        contentType: paper.content_type || null,
      },
    });
  }
});

app.post('/admin/answer-requests', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const startsAtInput = (req.body.startsAt || '').trim() || toDateTimeLocalInput(new Date());

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Select a batch for answer upload request' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const batch = await getBatchForCoaching(coachingId, branchId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  if (!title) {
    req.session.flash = { type: 'error', text: 'Title is required for answer upload request' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const startsAt = parseDateTimeLocal(startsAtInput);
  if (!startsAt) {
    req.session.flash = { type: 'error', text: 'Enter a valid start date and time' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const endsAt = addHours(startsAt, ANSWER_UPLOAD_WINDOW_HOURS);

  await run(
    `INSERT INTO answer_upload_requests (
      coaching_id, branch_id, batch_id, standard, course, title, description, starts_at, ends_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      branchId,
      batch.id,
      batch.standard || null,
      batch.course || null,
      title,
      description || null,
      toDateTimeLocalInput(startsAt),
      toDateTimeLocalInput(endsAt),
      req.session.user.id,
    ]
  );

  req.session.flash = {
    type: 'success',
    text: `Answer upload request created for ${batch.name}. Window stays open for ${ANSWER_UPLOAD_WINDOW_HOURS} hours.`,
  };
  await auditActor(req, 'answer_request_created', {
    targetType: 'batch',
    targetId: batch.id,
    details: { batchName: batch.name, title, startsAt: toDateTimeLocalInput(startsAt), endsAt: toDateTimeLocalInput(endsAt) },
  });
  return res.redirect('/admin/dashboard?section=overview');
});

app.post('/admin/answer-requests/:id/delete', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const requestId = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    req.session.flash = { type: 'error', text: 'Invalid upload session selected' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const answerRequest = await get(
    `SELECT id, title, batch_id, standard, course, starts_at, ends_at
     FROM answer_upload_requests
     WHERE coaching_id = ? AND branch_id = ? AND id = ?
     LIMIT 1`,
    [coachingId, branchId, requestId]
  );

  if (!answerRequest) {
    req.session.flash = { type: 'error', text: 'Upload session not found' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const requestState = getAnswerRequestState(answerRequest);
  if (!requestState.isExpired) {
    req.session.flash = { type: 'error', text: 'Only expired upload sessions can be removed' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE test_papers
       SET answer_request_id = NULL
       WHERE coaching_id = ? AND branch_id = ? AND answer_request_id = ?`,
      [coachingId, branchId, requestId]
    );
    await tx.run(
      `DELETE FROM answer_upload_requests
       WHERE coaching_id = ? AND branch_id = ? AND id = ?`,
      [coachingId, branchId, requestId]
    );
  });

  await auditActor(req, 'answer_request_deleted', {
    targetType: 'answer_request',
    targetId: requestId,
    details: {
      title: answerRequest.title,
      batchId: answerRequest.batch_id || null,
      standard: answerRequest.standard || null,
      course: answerRequest.course || null,
    },
  });
  req.session.flash = { type: 'success', text: `Expired upload session "${answerRequest.title}" removed` };
  return res.redirect('/admin/dashboard?section=overview');
});

app.post('/admin/attendance', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const rollNo = (req.body.rollNo || '').trim();
  const studentLookup = (req.body.studentLookup || '').trim();
  const attendanceDate = req.body.attendanceDate;
  const status = req.body.status;
  const notes = (req.body.notes || '').trim();

  const { student, error: studentResolveError } = await resolveStudentForAdminEntry(coachingId, branchId, {
    rollNo,
    studentLookup,
  });
  if (!student) {
    req.session.flash = { type: 'error', text: studentResolveError || 'Student not found' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const existing = await get(
    `SELECT id FROM attendance WHERE coaching_id = ? AND branch_id = ? AND student_id = ? AND attendance_date = ? LIMIT 1`,
    [coachingId, branchId, student.id, attendanceDate]
  );

  if (existing) {
    await run(
      `UPDATE attendance SET status = ?, notes = ?, marked_by = ? WHERE id = ? AND branch_id = ?`,
      [status, notes, req.session.user.id, existing.id, branchId]
    );
  } else {
    await run(
      `INSERT INTO attendance (coaching_id, branch_id, student_id, attendance_date, status, notes, marked_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [coachingId, branchId, student.id, attendanceDate, status, notes, req.session.user.id]
    );
  }

  if (status === 'absent') {
    setImmediate(() => {
      notifyAttendanceAbsence({ req, coachingId, student, attendanceDate, coaching })
        .catch((error) => console.error('Background attendance notification failed', {
          studentId: student.id,
          error: error.message,
        }));
    });
  }

  req.session.flash = { type: 'success', text: 'Attendance saved' };
  await auditActor(req, 'attendance_saved_single', {
    targetType: 'student',
    targetId: student.id,
    details: { rollNo: student.roll_no, attendanceDate, status },
  });
  return res.redirect(`/admin/dashboard?section=attendance&attendanceDate=${encodeURIComponent(attendanceDate)}`);
});

app.post('/admin/attendance-bulk', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const attendanceDate = req.body.attendanceDate;
  const notes = (req.body.notes || '').trim();

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const batch = await getBatchForCoaching(coachingId, branchId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  if (!attendanceDate) {
    req.session.flash = { type: 'error', text: 'Attendance date is required' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const students = await all(
    `SELECT id, roll_no, name, guardian_phone, parent_whatsapp_number
     FROM users
     WHERE coaching_id = ? AND branch_id = ? AND role = 'student' AND batch_id = ?
     ORDER BY roll_no ASC`,
    [coachingId, branchId, batch.id]
  );

  if (!students.length) {
    req.session.flash = { type: 'error', text: 'No students found in selected batch' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const absentees = parseAbsentees(req.body.absentRollNos);
  let absentCount = 0;
  let presentCount = 0;
  const studentIds = students.map((student) => Number(student.id)).filter(Number.isInteger);
  const existingRows = studentIds.length
    ? await all(
      `SELECT id, student_id
       FROM attendance
       WHERE coaching_id = ? AND branch_id = ? AND attendance_date = ? AND student_id = ANY(?::int[])`,
      [coachingId, branchId, attendanceDate, studentIds]
    )
    : [];
  const existingByStudentId = new Map(existingRows.map((row) => [Number(row.student_id), row]));

  const absentStudents = [];
  const attendanceWrites = [];
  for (const student of students) {
    const nextStatus = absentees.has(student.roll_no) ? 'absent' : 'present';
    if (nextStatus === 'absent') absentCount += 1;
    else presentCount += 1;

    const existing = existingByStudentId.get(Number(student.id));

    if (existing) {
      attendanceWrites.push(run(
        `UPDATE attendance SET status = ?, notes = ?, marked_by = ? WHERE id = ? AND branch_id = ?`,
        [nextStatus, notes, req.session.user.id, existing.id, branchId]
      ));
    } else {
      attendanceWrites.push(run(
        `INSERT INTO attendance (coaching_id, branch_id, student_id, attendance_date, status, notes, marked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [coachingId, branchId, student.id, attendanceDate, nextStatus, notes, req.session.user.id]
      ));
    }

    if (nextStatus === 'absent') {
      absentStudents.push(student);
    }
  }
  await Promise.all(attendanceWrites);
  setImmediate(() => {
    Promise.allSettled(absentStudents.map((student) => (
      notifyAttendanceAbsence({ req, coachingId, student, attendanceDate, coaching })
    ))).then((results) => {
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed) console.error('Background bulk attendance notifications failed', { failed });
    });
  });

  req.session.flash = {
    type: 'success',
    text: `Attendance saved. Present: ${presentCount}, Absent: ${absentCount}`,
  };
  await auditActor(req, 'attendance_saved_bulk', {
    targetType: 'batch',
    targetId: batch.id,
    details: { batchName: batch.name, attendanceDate, presentCount, absentCount },
  });
  return res.redirect(`/admin/dashboard?section=attendance&attendanceDate=${encodeURIComponent(attendanceDate)}`);
});


app.post('/admin/expenses', requireCoachingAdmin, requirePermission('expenses.manage'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const amount = Number(req.body.amount);
  const expenseDate = normalizeDateOnlyFilter(req.body.expenseDate);
  const category = sanitizeFinanceText(req.body.category, 80);
  const paidTo = sanitizeFinanceText(req.body.paidTo, 160);
  const paymentMode = sanitizeFinanceText(req.body.paymentMode, 80);
  const description = sanitizeFinanceText(req.body.description, 500);
  const referenceNo = sanitizeFinanceText(req.body.referenceNo, 160);
  const redirectMonth = expenseDate ? expenseDate.slice(0, 7) : getCurrentMonthValue();

  console.log(`[EXPENSE ADD START] coachingId=${coachingId} branchId=${branchId} amount=${amount} category=${category}`);
  if (!Number.isFinite(amount) || amount <= 0) {
    req.session.flash = { type: 'error', text: 'Expense amount must be greater than 0.' };
    return res.redirect(`/admin/dashboard?section=fees&expenseMonth=${encodeURIComponent(redirectMonth)}`);
  }
  if (!expenseDate) {
    req.session.flash = { type: 'error', text: 'Expense date is required.' };
    return res.redirect('/admin/dashboard?section=fees');
  }
  if (!category) {
    req.session.flash = { type: 'error', text: 'Expense category is required.' };
    return res.redirect(`/admin/dashboard?section=fees&expenseMonth=${encodeURIComponent(redirectMonth)}`);
  }

  try {
    const result = await run(
      `INSERT INTO expenses (coaching_id, branch_id, expense_date, amount, category, paid_to, payment_mode, description, reference_no, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [coachingId, branchId, expenseDate, amount, category, paidTo || null, paymentMode || null, description || null, referenceNo || null, req.session.user.id]
    );
    console.log(`[EXPENSE ADD OK] expenseId=${result?.lastID || result?.id || ''} coachingId=${coachingId} branchId=${branchId}`);
    req.session.flash = { type: 'success', text: 'Expense added successfully.' };
    return res.redirect(`/admin/dashboard?section=fees&expenseMonth=${encodeURIComponent(redirectMonth)}`);
  } catch (error) {
    console.error('[EXPENSE ADD ERROR]', error);
    req.session.flash = { type: 'error', text: 'Could not save expense. Please try again.' };
    return res.redirect(`/admin/dashboard?section=fees&expenseMonth=${encodeURIComponent(redirectMonth)}`);
  }
});

app.post('/admin/expenses/:id/delete', requireCoachingAdmin, requirePermission('expenses.manage'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const expenseId = Number(req.params.id);
  const redirectTo = String(req.body.redirectTo || '/admin/dashboard?section=fees');
  const safeRedirect = redirectTo.startsWith('/admin/dashboard') ? redirectTo : '/admin/dashboard?section=fees';

  console.log(`[EXPENSE DELETE START] expenseId=${expenseId} branchId=${branchId} coachingId=${coachingId}`);
  if (!Number.isInteger(expenseId) || expenseId <= 0) {
    console.warn(`[EXPENSE DELETE DENIED] expenseId=${req.params.id} branchId=${branchId} coachingId=${coachingId}`);
    return res.status(403).send('Forbidden');
  }

  try {
    const expense = await get('SELECT id, coaching_id, branch_id FROM expenses WHERE id = ?', [expenseId]);
    if (!expense || Number(expense.coaching_id) !== Number(coachingId) || Number(expense.branch_id) !== Number(branchId)) {
      console.warn(`[EXPENSE DELETE DENIED] expenseId=${expenseId} branchId=${branchId} coachingId=${coachingId}`);
      return res.status(403).send('Forbidden');
    }
    await run('DELETE FROM expenses WHERE id = ? AND coaching_id = ? AND branch_id = ?', [expenseId, coachingId, branchId]);
    console.log(`[EXPENSE DELETE OK] expenseId=${expenseId}`);
    req.session.flash = { type: 'success', text: 'Expense record deleted successfully.' };
    return res.redirect(safeRedirect);
  } catch (error) {
    console.error(`[EXPENSE DELETE ERROR] expenseId=${expenseId} error=${error.message}`);
    req.session.flash = { type: 'error', text: 'Could not delete expense record.' };
    return res.redirect(safeRedirect);
  }
});

app.post('/admin/fees', requireCoachingAdmin, requirePermission('fees.entry'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const rollNo = (req.body.rollNo || '').trim();
  const studentLookup = (req.body.studentLookup || '').trim();
  const amount = Number(req.body.amount);
  const dueDate = req.body.dueDate || null;
  const paymentDate = req.body.paymentDate || null;
  const status = req.body.status;
  const paymentMode = String(req.body.paymentMode || '').trim();
  const notes = (req.body.notes || '').trim();

  const { student, error: studentResolveError } = await resolveStudentForAdminEntry(coachingId, branchId, {
    rollNo,
    studentLookup,
  });
  if (!student) {
    req.session.flash = { type: 'error', text: studentResolveError || 'Student not found' };
    return res.redirect('/admin/dashboard?section=fees');
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    req.session.flash = { type: 'error', text: 'Enter a valid fee amount before saving payment details.' };
    return res.redirect('/admin/dashboard?section=fees');
  }

  console.log(`[FEE ADD] studentId=${student.id} branchId=${branchId} coachingId=${coachingId} amount=${amount} status=${status}`);
  const feeId = await saveAdminFeeRecord({
    coachingId,
    branchId,
    studentId: student.id,
    amount,
    dueDate,
    paymentDate,
    status,
    notes,
    paymentMode,
    addedBy: req.session.user.id,
  });

  const fee = {
    id: feeId,
    amount,
    due_date: dueDate,
    payment_date: paymentDate,
    status,
    notes,
    payment_mode: paymentMode || null,
  };
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  if (status === 'paid') {
    const feeSummary = await applyStudentPayment({ coachingId, branchId, studentId: student.id, amount });
    const publicBaseUrl = getRequestBaseUrl(req);
    setImmediate(async () => {
      try {
        const feePaidMessage = [
          `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
          '✅ Payment Received',
          `Student: ${student.name || student.roll_no}`,
          `Amount Paid: ₹${formatWhatsAppAmount(amount)}`,
          `Remaining Fees: ₹${formatWhatsAppAmount(feeSummary.pendingFee)}`,
          'Payment recorded successfully.',
          'Receipt attached.',
        ];
        const compactFeePaidMessage = compactWhatsAppMessage(feePaidMessage);
        const feeRecipients = [
          { key: 'student', phone: student.whatsapp_number || student.contact_phone },
          { key: 'parent', phone: student.parent_whatsapp_number || student.guardian_phone },
        ].filter((recipient, index, recipients) => (
          recipient.phone
          && recipients.findIndex((item) => item.phone === recipient.phone) === index
        ));

        let receipt = null;
        try {
          receipt = await generateFeeReceiptPdf(fee.id, { branchId, publicBaseUrl });
          let validation = await validatePublicUrl(receipt.fileUrl);
          if (!validation.ok) {
            receipt = await generateFeeReceiptPdf(fee.id, {
              branchId,
              forceRegenerate: true,
              publicBaseUrl,
            });
            validation = await validatePublicUrl(receipt.fileUrl);
          }
          if (!validation.ok) {
            throw new Error(`Receipt URL is not publicly accessible with HTTP 200. Status: ${validation.status || 'unknown'}`);
          }
        } catch (error) {
          console.error('Background fee receipt generation failed', {
            feeId: fee.id,
            studentId: student.id,
            error: error.message,
          });
        }

        for (const recipient of feeRecipients) {
          const paymentMessageResult = await sendWhatsAppNotification({
            studentId: student.id,
            phone: recipient.phone,
            type: 'fee_payment_confirmation',
            message: compactFeePaidMessage,
            eventKey: `fee_payment_confirmation:${recipient.key}:${student.id}:${fee.id}`,
          });
          console.log('WhatsApp API response', paymentMessageResult);

          if (receipt) {
            try {
              const receiptResult = await sendDocumentNotification(
                student.id,
                recipient.phone,
                receipt.fileUrl,
                receipt.fileName,
                'Receipt attached below.',
                {
                  type: 'fee_receipt',
                  eventKey: `fee_receipt:${recipient.key}:${student.id}:${fee.id}`,
                  retryFailed: true,
                }
              );
              console.log('WhatsApp API response', receiptResult);
              if (receiptResult?.failed) {
                throw new Error(receiptResult.error || 'WhatsApp receipt attachment failed');
              }
            } catch (error) {
              console.error('WhatsApp fee receipt PDF failed', {
                feeId: fee.id,
                studentId: student.id,
                recipient: recipient.key,
                phone: recipient.phone,
                error: error.message,
              });
            }
          }
        }
      } catch (error) {
        console.error('Background fee notification failed', {
          feeId: fee.id,
          studentId: student.id,
          error: error.message,
        });
      }
    });
  } else if (status === 'overdue') {
    fee.feeSummary = await setStudentTotalFee({ coachingId, branchId, studentId: student.id, totalFee: amount });
    setImmediate(() => {
      sendOverdueReminder({ coachingId, student, fee, coaching })
        .catch((error) => console.error('Background overdue reminder failed', {
          feeId: fee.id,
          studentId: student.id,
          error: error.message,
        }));
    });
  } else if (status === 'pending') {
    fee.feeSummary = await setStudentTotalFee({ coachingId, branchId, studentId: student.id, totalFee: amount });
  }

  await auditActor(req, 'fee_record_added', {
    targetType: 'student',
    targetId: student.id,
    details: { rollNo, amount, status, dueDate, paymentDate },
  });
  req.session.flash = { type: 'success', text: 'Fee record added' };
  return res.redirect('/admin/dashboard?section=fees');
});

app.post('/admin/notes', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const noticeTarget = String(req.body.noticeTarget || 'batch').trim();
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const selectedStudentIds = Array.isArray(req.body.studentIds)
    ? req.body.studentIds
    : String(req.body.studentIds || '').split(',');
  const selectedIds = selectedStudentIds
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  const title = (req.body.title || '').trim();
  const resourceUrl = (req.body.resourceUrl || '').trim();
  const description = (req.body.description || '').trim();
  const sendNoticeWhatsApp = req.body.sendWhatsApp === 'on';
  let batch = null;

  if (noticeTarget === 'batch' && (!Number.isInteger(batchId) || batchId <= 0)) {
    req.session.flash = { type: 'error', text: 'Please select a batch for note' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (noticeTarget === 'batch') {
    batch = await getBatchForCoaching(coachingId, branchId, batchId);
    if (!batch) {
      req.session.flash = { type: 'error', text: 'Selected batch was not found' };
      return res.redirect('/admin/dashboard?section=notes');
    }
  }

  if (noticeTarget === 'selected' && !selectedIds.length) {
    req.session.flash = { type: 'error', text: 'Select at least one student for this notice' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (!['all', 'batch', 'selected'].includes(noticeTarget)) {
    req.session.flash = { type: 'error', text: 'Select a valid notice target' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (!title) {
    req.session.flash = { type: 'error', text: 'Notice title is required' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (resourceUrl && !isValidHttpUrl(resourceUrl)) {
    req.session.flash = { type: 'error', text: 'URL must be a valid http/https link' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  const noteResult = await run(
    `INSERT INTO batch_notes (coaching_id, branch_id, batch_id, standard, course, title, resource_url, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      branchId,
      batch?.id || null,
      batch?.standard || null,
      batch?.course || null,
      title,
      resourceUrl || null,
      description,
      req.session.user.id,
    ]
  );

  const recipientParams = [coachingId, branchId];
  let recipientSql = `
    SELECT id, roll_no, name, contact_phone, whatsapp_number
    FROM users
    WHERE coaching_id = ? AND branch_id = ? AND role = 'student'
  `;
  if (noticeTarget === 'batch') {
    recipientParams.push(batch.id);
    recipientSql += ` AND batch_id = ?`;
  } else if (noticeTarget === 'selected') {
    recipientParams.push(selectedIds);
    recipientSql += ` AND id = ANY($${recipientParams.length}::int[])`;
  }
  recipientSql += ` ORDER BY roll_no ASC LIMIT 500`;
  const recipients = await all(recipientSql, recipientParams);
  const noticeMessage = [
    `New notice: ${title}`,
    description ? `\n${description}` : '',
    resourceUrl ? `\nLink: ${resourceUrl}` : '',
  ].join('').trim();

  let notifiedCount = 0;
  if (sendNoticeWhatsApp) {
    for (const recipient of recipients) {
      try {
        const result = await sendWhatsAppNotification({
          studentId: recipient.id,
          phone: recipient.whatsapp_number || recipient.contact_phone,
          type: 'notice_published',
          message: noticeMessage,
          eventKey: `notice_published:${recipient.id}:${noteResult.lastID}`,
        });
        if (!result?.skipped) notifiedCount += 1;
      } catch (error) {
        console.error('WhatsApp notice notification failed', {
          noteId: noteResult.lastID,
          studentId: recipient.id,
          error: error.message,
        });
      }
    }
  }

  await auditActor(req, 'batch_note_created', {
    targetType: noticeTarget === 'batch' ? 'batch' : 'notice',
    targetId: noticeTarget === 'batch' ? batch.id : noteResult.lastID,
    details: { target: noticeTarget, batchName: batch?.name || null, title, resourceUrl, sendNoticeWhatsApp },
  });
  req.session.flash = {
    type: 'success',
    text: sendNoticeWhatsApp
      ? `Notice published. WhatsApp notifications sent for ${notifiedCount} student(s).`
      : 'Notice published without WhatsApp notifications.',
  };
  return res.redirect('/admin/dashboard?section=notes');
});

app.post('/student/upload-paper', requireStudent, upload.single('paper'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const studentId = req.session.user.id;
  const file = req.file;
  const testLabel = (req.body.testLabel || '').trim();
  const marksObtained = parseOptionalNumber(req.body.marksObtained);
  const maxMarks = parseOptionalNumber(req.body.maxMarks);

  if (!file) {
    req.session.flash = { type: 'error', text: 'Select a file to upload' };
    return res.redirect('/student/dashboard');
  }

  if ((marksObtained === null) !== (maxMarks === null)) {
    req.session.flash = { type: 'error', text: 'Enter both obtained marks and max marks, or leave both blank' };
    return res.redirect('/student/dashboard');
  }

  const result = await savePaperUpload({
    coachingId,
    branchId,
    studentId,
    file,
    uploadedBy: studentId,
    testLabel: testLabel || file.originalname,
    marksObtained,
    maxMarks,
    answerRequestId: null,
  });

  const studentUploadText = {
    inserted: 'Your paper was uploaded successfully',
    replaced: 'Your paper was updated successfully',
    duplicate: 'Duplicate click ignored. Your paper is already saved.',
  };
  await auditActor(req, 'student_paper_uploaded', {
    targetType: 'student',
    targetId: studentId,
    details: { fileName: file.originalname, status: result.status },
  });
  req.session.flash = { type: 'success', text: studentUploadText[result.status] || 'Your paper was uploaded successfully' };
  return res.redirect('/student/dashboard');
});

app.post('/student/answer-requests/:id/upload', requireStudent, upload.single('paper'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const studentId = req.session.user.id;
  const requestId = Number(req.params.id);
  const file = req.file;
  const marksObtained = parseOptionalNumber(req.body.marksObtained);
  const maxMarks = parseOptionalNumber(req.body.maxMarks);

  if (!file) {
    req.session.flash = { type: 'error', text: 'Select a file to upload for this answer request' };
    return res.redirect('/student/dashboard');
  }

  if ((marksObtained === null) !== (maxMarks === null)) {
    req.session.flash = { type: 'error', text: 'Enter both obtained marks and max marks, or leave both blank' };
    return res.redirect('/student/dashboard');
  }

  const student = await get(
    `SELECT id, batch_id, standard, course FROM users WHERE id = ? AND coaching_id = ? AND branch_id = ? AND role = 'student'`,
    [studentId, coachingId, branchId]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student account not found' };
    return res.redirect('/student/dashboard');
  }

  const answerRequest = await get(
    `SELECT id, title, batch_id, standard, course, starts_at, ends_at
     FROM answer_upload_requests
     WHERE id = ? AND coaching_id = ? AND branch_id = ?`,
    [requestId, coachingId, branchId]
  );
  if (!answerRequest) {
    req.session.flash = { type: 'error', text: 'Answer upload request not found' };
    return res.redirect('/student/dashboard');
  }

  const batchMismatch = answerRequest.batch_id
    ? Number(answerRequest.batch_id) !== Number(student.batch_id || 0)
    : answerRequest.standard !== student.standard || answerRequest.course !== student.course;

  if (batchMismatch) {
    req.session.flash = { type: 'error', text: 'This answer upload request does not belong to your batch' };
    return res.redirect('/student/dashboard');
  }

  const requestState = getAnswerRequestState(answerRequest);
  if (!requestState.isActive) {
    req.session.flash = { type: 'error', text: 'This upload window is no longer active' };
    return res.redirect('/student/dashboard');
  }

  const result = await savePaperUpload({
    coachingId,
    branchId,
    studentId,
    file,
    uploadedBy: studentId,
    testLabel: answerRequest.title,
    marksObtained,
    maxMarks,
    answerRequestId: answerRequest.id,
  });

  const answerUploadText = {
    inserted: `Uploaded for ${answerRequest.title}`,
    replaced: `Updated your upload for ${answerRequest.title}`,
    duplicate: `Duplicate click ignored. Your upload for ${answerRequest.title} is already saved.`,
  };
  await auditActor(req, 'student_answer_upload_submitted', {
    targetType: 'answer_request',
    targetId: answerRequest.id,
    details: { title: answerRequest.title, status: result.status },
  });
  req.session.flash = { type: 'success', text: answerUploadText[result.status] || `Uploaded for ${answerRequest.title}` };
  return res.redirect('/student/dashboard');
});

app.post('/papers/:id/delete', requireAuth, async (req, res) => {
  const paper = await getPaperForDelete(req.params.id, req.session.user);
  const redirectTo = String(req.body.redirectTo || '').startsWith('/')
    ? String(req.body.redirectTo)
    : req.session.user.role === 'admin'
      ? '/admin/dashboard?section=papers'
      : '/student/dashboard';

  if (!paper) {
    if (req.session) {
      req.session.flash = { type: 'error', text: 'Paper not found or delete is not allowed' };
    }
    return res.redirect(redirectTo);
  }

  await deletePaperRecord(paper);
  await auditActor(req, 'paper_deleted', {
    targetType: 'paper',
    targetId: Number(req.params.id),
    details: { redirectTo, paperType: paper.paper_type || null, studentId: paper.student_id || null },
  });
  if (req.session) {
    req.session.flash = { type: 'success', text: 'Paper deleted successfully' };
  }
  return res.redirect(redirectTo);
});

app.get('/student/dashboard', requireStudent, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const branchId = getCurrentBranchId(req);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const subscriptionState = req.subscriptionState || getSubscriptionState(coaching);
  const dashboard = await getStudentDashboardPayload(coachingId, branchId, req.session.user.id);
  const profile = dashboard.profile;

  const answerRequests = profile?.batch_id
    ? await all(
      `SELECT ar.id, ar.title, ar.description, ar.starts_at, ar.ends_at, ar.created_at, ar.batch_id, b.name AS batch_name
       FROM answer_upload_requests ar
       LEFT JOIN batches b ON b.id = ar.batch_id AND b.branch_id = ar.branch_id
       WHERE ar.coaching_id = ? AND ar.branch_id = ? AND ar.batch_id = ?
       ORDER BY ar.created_at DESC
       LIMIT 12`,
      [coachingId, branchId, profile.batch_id]
    )
    : profile?.standard || profile?.course
      ? await all(
        `SELECT id, title, description, starts_at, ends_at, created_at, batch_id
         FROM answer_upload_requests
         WHERE coaching_id = ? AND branch_id = ?
           AND COALESCE(standard, '') = COALESCE(?, '')
           AND COALESCE(course, '') = COALESCE(?, '')
         ORDER BY created_at DESC
         LIMIT 12`,
        [coachingId, branchId, profile.standard || null, profile.course || null]
      )
      : [];

  const submissions = await all(
    `SELECT id, answer_request_id, upload_date, original_name
	     FROM test_papers
	     WHERE coaching_id = ? AND branch_id = ? AND student_id = ? AND answer_request_id IS NOT NULL
	       AND ${getRealPaperFileCondition()}
	     ORDER BY upload_date DESC`,
    [coachingId, branchId, req.session.user.id]
  );

  const latestSubmissionByRequest = new Map();
  submissions.forEach((submission) => {
    if (!latestSubmissionByRequest.has(submission.answer_request_id)) {
      latestSubmissionByRequest.set(submission.answer_request_id, submission);
    }
  });

  const answerRequestCards = answerRequests.map((request) => ({
    ...request,
    state: getAnswerRequestState(request),
    mySubmission: latestSubmissionByRequest.get(request.id) || null,
  }));

  renderWithMessage(res, 'student-dashboard', {
    user: req.session.user,
    coaching,
    branding: buildBranding(coaching),
    subscriptionState,
    subscriptionNotice: subscriptionState.notice,
    profile,
    papers: dashboard.papers,
    attendance: dashboard.attendance,
    fees: dashboard.fees,
    notes: dashboard.notes,
    attendanceSummary: dashboard.attendanceSummary,
    feeSummary: dashboard.feeSummary,
    marksSummary: dashboard.marksSummary,
    progressSeries: dashboard.progressSeries,
    answerRequestCards,
    flash: req.session.flash,
  });
  req.session.flash = null;
});

app.get('/papers/:id/view', requireAuth, async (req, res) => {
  try {
    const paper = await getPaperForUser(req.params.id, req.session.user);
    if (!paper) {
      req.session.flash = { type: 'error', text: 'Paper file is not available.' };
      return res.redirect(getPapersRedirectPath(req.session.user));
    }

    if (paper.public_url) {
      return res.redirect(paper.public_url);
    }

    const access = await getPaperAccess(paper, 'inline');
    if (!access) {
      req.session.flash = { type: 'error', text: 'Paper file is not available.' };
      return res.redirect(getPapersRedirectPath(req.session.user));
    }

    if (access.type === 'redirect' && access.url) {
      return res.redirect(access.url);
    }

    if (access.type === 'local' && access.filePath) {
      return res.sendFile(access.filePath);
    }

    req.session.flash = { type: 'error', text: 'Paper file is misconfigured.' };
    return res.redirect(getPapersRedirectPath(req.session.user));
  } catch (err) {
    console.error(err);
    req.session.flash = { type: 'error', text: 'Unable to open paper file.' };
    return res.redirect(getPapersRedirectPath(req.session.user));
  }
});

app.get('/papers/:id/download', requireAuth, async (req, res) => {
  try {
    const paper = await getPaperForUser(req.params.id, req.session.user);
    if (!paper) {
      req.session.flash = { type: 'error', text: 'Paper file is not available.' };
      return res.redirect(getPapersRedirectPath(req.session.user));
    }

    if (paper.public_url) {
      return res.redirect(paper.public_url);
    }

    const access = await getPaperAccess(paper, 'attachment');
    if (!access) {
      req.session.flash = { type: 'error', text: 'Paper file is not available.' };
      return res.redirect(getPapersRedirectPath(req.session.user));
    }

    if (access.type === 'redirect' && access.url) {
      return res.redirect(access.url);
    }

    if (access.type === 'local' && access.filePath) {
      return res.download(access.filePath, paper.original_name || paper.stored_name || 'paper');
    }

    req.session.flash = { type: 'error', text: 'Paper file is misconfigured.' };
    return res.redirect(getPapersRedirectPath(req.session.user));
  } catch (err) {
    console.error(err);
    req.session.flash = { type: 'error', text: 'Unable to download paper file.' };
    return res.redirect(getPapersRedirectPath(req.session.user));
  }
});
app.use((err, req, res, next) => {
  console.error(err);

  if (req.session?.user?.isOwner) {
    req.session.flash = { type: 'error', text: err.message || 'Server error' };
    return res.redirect('/owner/dashboard');
  }

  if (req.session?.user?.role === 'admin') {
    req.session.flash = { type: 'error', text: 'Something went wrong. Please try again.' };
    return res.redirect('/admin/dashboard');
  }

  if (req.session) {
    req.session.flash = { type: 'error', text: 'Something went wrong. Please try again.' };
  }
  return res.redirect('/login');
});
// ✅ TEST MAIL ROUTE (FINAL PLACE)
app.get('/test-mail', async (req, res) => {
  try {
    const transporter = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.SMTP_USER,
      subject: 'Test Mail',
      text: 'Working ✅',
    });

    res.send('OK');
  } catch (err) {
    console.error(err);
    res.send('ERROR: ' + err.message);
  }
});
let appReadyPromise = null;

async function prepareApp() {
  if (!appReadyPromise) {
    appReadyPromise = Promise.resolve()
      .then(() => {
        console.log('[BOOT] Storage mode:', process.env.FILE_STORAGE_MODE || getStorageMode());
        initStorage();
        console.log('[BOOT] Preparing database');
        return getPool().query('SELECT 1');
      })
      .then(() => ensureSessionTable())
      .then(() => ensureWhatsAppSchema())
      .then(() => ensureNotificationSchema())
      .then(() => ensureOnboardingWhatsAppSchema())
      .then(() => ensureFeeStructureSchema())
      .then(() => ensureAdminPermissionSchema())
      .then(() => ensureExpensesSchema())
      .then(() => ensureOmrSchema())
      .then(() => ensurePerformanceIndexes())
      .then(async () => {
        console.log('[BOOT] Database ready');
        if (process.env.RUN_STARTUP_MAINTENANCE === 'true') {
          await cleanupDuplicateAnswerSubmissions();
        }
      })
      .then(() => {
        console.log(`File storage mode: ${getStorageMode()}`);
        if (isVercel) console.log('Running on Vercel serverless runtime');
      })
      .catch((error) => {
        console.error('[BOOT ERROR]', error);
        appReadyPromise = null;
        throw error;
      });
  }

  return appReadyPromise;
}

async function startServer() {
  await prepareApp();

  const server = app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
  });
  const retryTimer = setInterval(() => {
    retryPendingOnboarding().catch((error) => {
      console.error('[WHATSAPP ONBOARDING] Scheduled retry failed', error);
    });
  }, 5 * 60 * 1000);
  retryTimer.unref();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const suggestedPort = Number(PORT) + 1;
      console.error(`Port ${PORT} is already in use. Start with another port, for example: PORT=${suggestedPort} npm start`);
      process.exitCode = 1;
      return;
    }

    console.error('Startup server error', err);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Startup failed', err);
    process.exitCode = 1;
  });
}

async function serverlessHandler(req, res) {
  await prepareApp();
  return app(req, res);
}

module.exports = serverlessHandler;
module.exports.app = app;
module.exports.prepareApp = prepareApp;
module.exports.startServer = startServer;
