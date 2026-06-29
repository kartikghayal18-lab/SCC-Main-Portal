const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
require('../config/env');

const { getPool, run, get, all, withTransaction } = require('../config/database');
const { getBrandingColors, getClientConfig } = require('../config/client');
const { initStorage, getStorageMode, uploadPaperFile, getPaperAccess, deleteStoredPaper } = require('../shared/uploads/storage');
const { PostgresSessionStore, ensureSessionTable } = require('../src/session-store');
const { OTP_TTL_MINUTES, generateOtpCode, smtpConfigured, resendConfigured, getOtpChannelOptions, sendOtpMessage, sendTestEmail } = require('../shared/auth/otp-service');
const brandingUtils = require('../shared/utils/branding');
const { resolvePort } = require('../shared/utils/server');

// Route registration stays in one place for stability, while branding,
// uploads, mail, auth, and database concerns now resolve through reusable
// shared/config modules for client-by-client deployments.
const app = express();
const isProduction = process.env.NODE_ENV === 'production';
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
const clientConfig = getClientConfig();
const defaultBrandingColors = getBrandingColors();

function getCurrentMonthValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

const PORT = resolvePort(process.env.PORT || 3000);
const OWNER_SECTIONS = new Set(['overview', 'coachings', 'trial-requests']);
const ADMIN_SECTIONS = new Set(['overview', 'attendance', 'students', 'fees', 'papers', 'notes', 'settings']);
const ALLOWED_UPLOAD_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']);
const ANSWER_UPLOAD_WINDOW_HOURS = 24;
const RETENTION_BATCH_NAME = 'Retained Student Records';
const RETENTION_MAX_STUDENTS_PER_SOURCE_BATCH = 5;
const DEFAULT_THEME = {
  brand: clientConfig.primaryColor || defaultBrandingColors.primary || '#2563eb',
  background: defaultBrandingColors.background || '#f3f6fb',
  surface: defaultBrandingColors.surface || '#ffffff',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed'));
  },
});

app.disable('x-powered-by');
if (isProduction) {
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
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
app.use('/branding', express.static(path.join(__dirname, '..', 'branding')));

function renderWithMessage(res, view, data = {}) {
  const flash = data.flash || null;
  return res.render(view, { ...data, flash });
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
  const received = String(req.body?._csrf || req.query?._csrf || '').trim();
  return timingSafeEqualString(received, expected);
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
      className: `${clientConfig.clientName} Owner Control`,
      email: user.email || String(process.env.OWNER_2FA_EMAIL || '').trim().toLowerCase() || null,
      contactPhone: user.contact_phone || String(process.env.OWNER_2FA_PHONE || '').trim() || null,
    };
  }

  return {
    adminName: user?.name || 'Admin',
    className: coaching?.name || buildBranding(coaching).portalLabel,
    email: user?.email || null,
    contactPhone: user?.contact_phone || null,
  };
}

async function createPendingTwoFactorLogin(req, user, coaching = null) {
  const identity = getTwoFactorIdentity(user, coaching);
  req.session.pendingLogin = {
    userId: user.id,
    coachingId: user.coaching_id || null,
    isOwner: Boolean(user.is_owner),
    role: user.is_owner ? 'owner' : user.role,
    coachingName: coaching?.name || null,
    ...identity,
  };
}

async function getPendingTwoFactorContext(req) {
  const pending = req.session?.pendingLogin;
  if (!pending?.userId) return null;

  const user = await get(`SELECT * FROM users WHERE id = ? LIMIT 1`, [pending.userId]);
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
  if (!req.session.user) return res.redirect('/owner/login');
  if (!req.session.user.isOwner) return res.status(403).send('Forbidden');
  return next();
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

  if (!hasValidRequestOrigin(req)) {
    return res.status(403).send('Invalid request origin');
  }

  // The 2FA flow is still same-origin checked above, then protected by the
  // pending-login session plus the one-time code. Path matching is normalized
  // for Vercel rewrites/trailing slashes so these posts do not fall through to
  // the generic CSRF error.
  if (req.method === 'POST' && isTwoFactorAuthPostPath(req)) {
    return next();
  }

  if (!ensureCsrf(req)) {
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

function isValidHttpUrl(value) {
  return brandingUtils.isValidHttpUrl(value);
}

function normalizeLogoUrl(value) {
  return brandingUtils.normalizeLogoUrl(value);
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

async function getBatchesForCoaching(coachingId) {
  return all(
    `SELECT id, name, normalized_name, standard, course, status, completed_at, is_retention_batch, created_at
     FROM batches
     WHERE coaching_id = ?
     ORDER BY is_retention_batch DESC, CASE WHEN status = 'active' THEN 0 ELSE 1 END, LOWER(name) ASC, id ASC`,
    [coachingId]
  );
}

async function getBatchForCoaching(coachingId, batchId) {
  return get(
    `SELECT id, coaching_id, name, normalized_name, standard, course, status, completed_at, is_retention_batch, created_at
     FROM batches
     WHERE coaching_id = ? AND id = ?
     LIMIT 1`,
    [coachingId, batchId]
  );
}

async function ensureRetentionBatch(coachingId, createdBy = null) {
  const existing = await get(
    `SELECT id, coaching_id, name, normalized_name, standard, course, status, completed_at, is_retention_batch, created_at
     FROM batches
     WHERE coaching_id = ? AND is_retention_batch = 1
     LIMIT 1`,
    [coachingId]
  );
  if (existing) return existing;

  const normalizedName = RETENTION_BATCH_NAME.toLowerCase();
  const result = await run(
    `INSERT INTO batches (coaching_id, name, normalized_name, standard, course, status, is_retention_batch, created_by)
     VALUES (?, ?, ?, NULL, NULL, 'active', 1, ?)`,
    [coachingId, RETENTION_BATCH_NAME, normalizedName, createdBy]
  );
  return getBatchForCoaching(coachingId, result.lastID);
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
  return brandingUtils.buildBranding(coaching);
}

function buildProgressSummaryFromPapers(papers) {
  const markedPapers = (papers || [])
    .filter((paper) => paper.marks_obtained !== null && paper.max_marks !== null && Number(paper.max_marks) > 0)
    .slice()
    .reverse();

  const totalMarksObtained = markedPapers.reduce((sum, paper) => sum + Number(paper.marks_obtained || 0), 0);
  const totalMaxMarks = markedPapers.reduce((sum, paper) => sum + Number(paper.max_marks || 0), 0);
  const marksPercent = totalMaxMarks
    ? ((totalMarksObtained / totalMaxMarks) * 100).toFixed(1)
    : '0.0';

  const progressSeries = markedPapers.map((paper, index) => ({
    label: paper.test_label || path.parse(paper.original_name || 'Test').name,
    marks: Number(paper.marks_obtained),
    max: Number(paper.max_marks),
    percent: Number(((Number(paper.marks_obtained) / Number(paper.max_marks)) * 100).toFixed(1)),
    testNo: index + 1,
  }));

  return {
    markedPapers,
    progressSeries,
    marksSummary: {
      testsCount: markedPapers.length,
      totalMarksObtained,
      totalMaxMarks,
      marksPercent,
    },
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

async function buildAnswerRequestSummaries(coachingId, requests) {
  const summaries = [];

  for (const request of requests) {
    const targetStudents = request.batch_id
      ? await all(
        `SELECT u.id, u.roll_no, u.name, u.contact_phone, u.email, u.batch_id, b.name AS batch_name
         FROM users u
         LEFT JOIN batches b ON b.id = u.batch_id
         WHERE u.coaching_id = ? AND u.role = 'student' AND u.batch_id = ?
         ORDER BY u.roll_no ASC`,
        [coachingId, request.batch_id]
      )
      : await all(
        `SELECT id, roll_no, name, contact_phone, email, batch_id
         FROM users
         WHERE coaching_id = ? AND role = 'student' AND standard = ? AND course = ?
         ORDER BY roll_no ASC`,
        [coachingId, request.standard, request.course]
      );

    const submissions = await all(
      `SELECT tp.id, tp.student_id, tp.upload_date, tp.original_name, tp.test_label, tp.content_type,
              uploader.name AS uploaded_by_name, uploader.role AS uploaded_by_role
       FROM test_papers tp
       LEFT JOIN users uploader ON uploader.id = tp.uploaded_by
       WHERE tp.coaching_id = ? AND tp.answer_request_id = ?
       ORDER BY tp.upload_date DESC`,
      [coachingId, request.id]
    );

    const latestSubmissionByStudent = new Map();
    submissions.forEach((submission) => {
      if (!latestSubmissionByStudent.has(submission.student_id)) {
        latestSubmissionByStudent.set(submission.student_id, submission);
      }
    });

    const uploadedStudents = [];
    const pendingStudents = [];

    for (const student of targetStudents) {
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

    summaries.push({
      ...request,
      batch_name: request.batch_name || formatLegacyBatchLabel(request.standard, request.course) || null,
      state: getAnswerRequestState(request),
      totalStudents: targetStudents.length,
      uploadedCount: uploadedStudents.length,
      pendingCount: pendingStudents.length,
      uploadedStudents,
      pendingStudents,
    });
  }

  return summaries;
}

async function findRecentDuplicatePaper({
  coachingId,
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
       WHERE coaching_id = ?
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
      [coachingId, studentId, uploadedBy, originalName, testLabel || null, marksObtained, maxMarks]
    );
  }

  return get(
    `SELECT id
     FROM test_papers
     WHERE coaching_id = ?
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
    [coachingId, studentId, uploadedBy, answerRequestId, originalName, testLabel || null, marksObtained, maxMarks]
  );
}

async function deletePaperRecord(paper) {
  await run(`DELETE FROM test_papers WHERE id = ?`, [paper.id]);
  try {
    await deleteStoredPaper(paper);
  } catch (error) {
    console.error('Failed deleting stored paper asset', error);
  }
}

async function savePaperUpload({
  coachingId,
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
       WHERE coaching_id = ? AND student_id = ? AND answer_request_id = ?
       ORDER BY upload_date DESC, id DESC
       LIMIT 1`,
      [coachingId, studentId, answerRequestId]
    );

    if (existing) {
      await run(
        `UPDATE test_papers
         SET original_name = ?, stored_name = ?, uploaded_by = ?,
             storage_type = ?, storage_key = ?, public_url = ?, content_type = ?, size_bytes = ?,
             marks_obtained = ?, max_marks = ?, test_label = ?, paper_type = 'answer_submission',
             upload_date = CURRENT_TIMESTAMP
         WHERE id = ?`,
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
      coaching_id, student_id, original_name, stored_name, uploaded_by,
      storage_type, storage_key, public_url, content_type, size_bytes,
      marks_obtained, max_marks, test_label, paper_type, answer_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
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
     WHERE tp.id = ?`,
    [id]
  );

  if (!paper) return null;
  if (sessionUser.isOwner) return null;

  if (sessionUser.role === 'admin' && paper.coaching_id === sessionUser.coachingId) {
    return paper;
  }

  if (
    sessionUser.role === 'student' &&
    paper.student_id === sessionUser.id &&
    paper.coaching_id === sessionUser.coachingId &&
    paper.uploaded_by === sessionUser.id
  ) {
    return paper;
  }

  return null;
}

async function cleanupDuplicateAnswerSubmissions() {
  const duplicateGroups = await all(
    `SELECT coaching_id, student_id, answer_request_id, COUNT(*) AS duplicate_count
     FROM test_papers
     WHERE answer_request_id IS NOT NULL
     GROUP BY coaching_id, student_id, answer_request_id
     HAVING COUNT(*) > 1`
  );

  for (const group of duplicateGroups) {
    const rows = await all(
      `SELECT id, stored_name, storage_type, storage_key, public_url, content_type
       FROM test_papers
       WHERE coaching_id = ? AND student_id = ? AND answer_request_id = ?
       ORDER BY upload_date DESC, id DESC`,
      [group.coaching_id, group.student_id, group.answer_request_id]
    );

    const [, ...duplicates] = rows;
    for (const paper of duplicates) {
      await deletePaperRecord(paper);
    }
  }
}

async function getStudentDashboardPayload(coachingId, studentId) {
  const profile = await get(
    `SELECT u.id, u.roll_no, u.name, u.batch_id, u.standard, u.course, u.contact_phone, u.email,
            b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE u.id = ? AND u.coaching_id = ? AND u.role = 'student'`,
    [studentId, coachingId]
  );

  const papers = await all(`
SELECT tp.id, tp.original_name, tp.stored_name, tp.upload_date,
tp.storage_type, tp.storage_key, tp.content_type,
tp.marks_obtained, tp.max_marks, tp.test_label, tp.paper_type,
tp.answer_request_id, tp.uploaded_by AS uploaded_by_id,
uploader.name AS uploaded_by_name, uploader.role AS uploaded_by_role
FROM test_papers tp
	LEFT JOIN users uploader ON uploader.id = tp.uploaded_by
	WHERE tp.coaching_id = ? AND tp.student_id = ?
	ORDER BY tp.upload_date DESC
	LIMIT 20
	`, [coachingId, studentId]);

	  const attendance = await all(
	    `SELECT attendance_date, status, notes
	     FROM attendance
	     WHERE coaching_id = ? AND student_id = ?
	     ORDER BY attendance_date DESC, id DESC
	     LIMIT 30`,
	    [coachingId, studentId]
	  );

  const fees = await all(
    `SELECT amount, due_date, payment_date, status, notes
     FROM fees
     WHERE coaching_id = ? AND student_id = ?
     ORDER BY created_at DESC`,
    [coachingId, studentId]
  );

  const notes = profile?.batch_id
    ? await all(
      `SELECT bn.title, bn.resource_url, bn.description, bn.created_at, bn.batch_id, b.name AS batch_name
       FROM batch_notes bn
       LEFT JOIN batches b ON b.id = bn.batch_id
       WHERE bn.coaching_id = ? AND bn.batch_id = ?
       ORDER BY bn.created_at DESC`,
      [coachingId, profile.batch_id]
    )
    : profile?.standard || profile?.course
      ? await all(
        `SELECT title, resource_url, description, created_at, batch_id
         FROM batch_notes
         WHERE coaching_id = ?
           AND COALESCE(standard, '') = COALESCE(?, '')
           AND COALESCE(course, '') = COALESCE(?, '')
         ORDER BY created_at DESC`,
        [coachingId, profile.standard || null, profile.course || null]
      )
      : [];

  const attendanceSummary = await get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count,
       SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count,
       SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_count
     FROM attendance
     WHERE coaching_id = ? AND student_id = ?`,
    [coachingId, studentId]
  );

  const feeSummary = await get(
    `SELECT
       COUNT(*) AS total_fees,
       SUM(CASE WHEN status IN ('pending', 'overdue') THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status IN ('pending', 'overdue') THEN amount ELSE 0 END) AS pending_amount
     FROM fees
     WHERE coaching_id = ? AND student_id = ?`,
    [coachingId, studentId]
  );

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
      totalFees: Number(feeSummary?.total_fees || 0),
      pendingCount: Number(feeSummary?.pending_count || 0),
      pendingAmount: Number(feeSummary?.pending_amount || 0),
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
  const coachingHint = (req.query.coaching || req.body?.coachingSlug || '').trim().toLowerCase();
  const coaching = coachingHint ? await getCoachingBySlug(coachingHint) : null;
  const nextFlash = flash || req.session?.flash || null;
  const captcha = getCaptchaChallenge(req, 'login');
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'auth-login', {
    flash: nextFlash,
    coaching,
    coachingHint,
    branding: buildBranding(coaching),
    captcha,
  });
}

async function renderOwnerLoginPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  const captcha = getCaptchaChallenge(req, 'owner-login');
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'owner-login', {
    flash: nextFlash,
    branding: buildBranding(null),
    captcha,
  });
}

async function renderOwnerForgotPasswordPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  const captcha = getCaptchaChallenge(req, 'owner-forgot-password');
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'owner-forgot-password', {
    flash: nextFlash,
    branding: buildBranding(null),
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
    branding: buildBranding(null),
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
     WHERE tp.id = ?`,
    [id]
  );

  if (!paper) return null;
  if (sessionUser.isOwner) return null;
  if (sessionUser.role === 'admin' && paper.coaching_id === sessionUser.coachingId) return paper;
  if (sessionUser.role === 'student' && paper.student_id === sessionUser.id && paper.coaching_id === sessionUser.coachingId) return paper;
  return null;
}

app.use(async (req, res, next) => {
  if (!req.session?.user || req.session.user.isOwner) return next();

  const coaching = await getCoachingContextById(req.session.user.coachingId);
  if (!coaching) {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  const subscriptionState = getSubscriptionState(coaching);
  req.currentCoaching = coaching;
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

  const owner = await get(`SELECT * FROM users WHERE is_owner = 1 AND username = ? LIMIT 1`, [username]);
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
      className: `${clientConfig.clientName} Owner Control`,
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
  const password =
    role === 'student' && !submittedPassword.trim()
      ? username
      : submittedPassword;
  const coachingSlug = (req.body.coachingSlug || '').trim().toLowerCase();

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
      return renderLoginPage(req, res, { type: 'error', text: 'Invalid coaching code' });
    }

    if (role === 'admin') {
      user = await get(
        `SELECT * FROM users
         WHERE coaching_id = ? AND role = 'admin' AND is_owner = 0 AND username = ?
         LIMIT 1`,
        [coaching.id, username]
      );
    } else {
      user = await get(
        `SELECT * FROM users
         WHERE coaching_id = ? AND role = 'student' AND roll_no = ?
         LIMIT 1`,
        [coaching.id, username]
      );
    }
  }

  if (!['admin', 'student'].includes(role)) {
    return renderLoginPage(req, res, { type: 'error', text: 'Select a valid login type' });
  }

  if (!user) {
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
    `SELECT * FROM users WHERE is_owner = 1 AND username = ? LIMIT 1`,
    [username]
  );

  if (!user) {
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

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
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
  const acceptedSaas = req.body.acceptSaas === 'on';

  if (!acceptedTerms || !acceptedPrivacy || !acceptedSaas) {
    req.session.flash = {
      type: 'error',
      text: 'You must accept the Terms and Conditions, Privacy Policy, and SaaS Agreement to continue.',
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
  await run(
    `UPDATE users
     SET password_hash = ?, must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND coaching_id = ? AND role = 'admin'`,
    [passwordHash, req.session.user.id, req.session.user.coachingId]
  );

  req.session.user.mustChangePassword = false;
  await auditActor(req, 'admin_password_changed');
  req.session.flash = { type: 'success', text: 'Admin password updated successfully.' };
  return res.redirect('/admin/dashboard?section=settings');
});

app.post('/admin/settings/profile', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
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

  if (adminEmail && !isValidEmail(adminEmail)) {
    req.session.flash = { type: 'error', text: 'Admin email must be a valid email address' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  if (logoUrl && !isValidHttpUrl(logoUrl)) {
    req.session.flash = { type: 'error', text: 'Logo URL must be a valid http/https link' };
    return res.redirect('/admin/dashboard?section=settings');
  }

  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE users
       SET name = ?, contact_phone = ?, email = ?
       WHERE id = ? AND coaching_id = ? AND role = 'admin'`,
      [adminDisplayName, adminContactPhone || null, adminEmail || null, req.session.user.id, coachingId]
    );

    await tx.run(
      `UPDATE coaching_classes
       SET name = ?, brand_name = ?, contact_email = ?, logo_url = ?, theme_primary = ?, theme_background = ?, theme_surface = ?
       WHERE id = ?`,
      [coachingName, brandName, contactEmail || null, logoUrl || null, themePrimary, themeBackground, themeSurface, coachingId]
    );
  });

  req.session.user.name = adminDisplayName;
  req.session.user.contactPhone = adminContactPhone || null;
  req.session.user.email = adminEmail || null;
  await auditActor(req, 'admin_profile_updated', {
    targetType: 'coaching',
    targetId: coachingId,
    details: {
      coachingName,
      brandName,
      adminEmail: adminEmail || null,
      contactEmail: contactEmail || null,
    },
  });
  req.session.user.coachingName = coachingName;
  req.session.flash = { type: 'success', text: 'Settings updated successfully.' };
  return res.redirect('/admin/dashboard?section=settings');
});

app.get('/owner/dashboard', requireOwner, async (req, res) => {
  const activeSection = getOwnerSection(req.query.section);
  const planSql = buildResolvedPlanSql('cc');

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
     LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.role = 'admin' AND admin.is_owner = 0
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
    branding: buildBranding(null),
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
    flash: req.session.flash,
  });
  req.session.flash = null;
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

  await run(
    `INSERT INTO users (
      coaching_id, role, is_owner, username, roll_no, name, standard, course, contact_phone, email, password_hash, must_change_password
    ) VALUES (?, 'admin', 0, ?, NULL, ?, NULL, NULL, ?, ?, ?, 1)`,
    [coachingId, adminUsername, adminName, adminContactPhone, adminEmail, passwordHash]
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
  const attendanceDateFilter = (req.query.attendanceDate || '').trim();
  const currentMonth = getCurrentMonthValue();
  const attendanceMonthFilter = (req.query.attendanceMonth || currentMonth).trim();
  const papersMonthFilter = (req.query.papersMonth || currentMonth).trim();
  const feesMonthFilter = (req.query.feesMonth || currentMonth).trim();
  const studentSearchQuery = (req.query.studentSearch || '').trim();
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const adminProfile = await get(
    `SELECT contact_phone, email
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'admin'
     LIMIT 1`,
    [req.session.user.id, coachingId]
  );
  const batches = await getBatchesForCoaching(coachingId);

  const students = await all(
    `SELECT u.id, u.roll_no, u.name, u.batch_id, u.standard, u.course, u.contact_phone, u.email, u.created_at,
            u.is_retained_record, u.retention_source_batch_id,
            b.name AS batch_name, b.status AS batch_status, b.completed_at AS batch_completed_at, b.is_retention_batch
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE u.role = 'student' AND u.coaching_id = ?
     ORDER BY COALESCE(b.name, ''), u.roll_no ASC`,
    [coachingId]
  );

  const papers = await all(
    `SELECT
       tp.id,
       tp.original_name,
       tp.stored_name,
       tp.upload_date,
       tp.storage_type,
       tp.storage_key,
       tp.size_bytes,
       tp.marks_obtained,
       tp.max_marks,
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
     JOIN users u ON u.id = tp.student_id
     LEFT JOIN batches b ON b.id = u.batch_id
     LEFT JOIN users uploader ON uploader.id = tp.uploaded_by
     WHERE tp.coaching_id = ?
       AND CAST(tp.upload_date AS TEXT) LIKE ?
     ORDER BY tp.upload_date DESC
     LIMIT 250`,
    [coachingId, `${papersMonthFilter}%`]
  );

  let attendanceSql = `
    SELECT a.id, a.attendance_date, a.status, a.notes, u.roll_no, u.name, u.batch_id, u.standard, u.course, b.name AS batch_name
    FROM attendance a
    JOIN users u ON u.id = a.student_id
    LEFT JOIN batches b ON b.id = u.batch_id
    WHERE a.coaching_id = ?
  `;
  const attendanceParams = [coachingId];
  if (attendanceDateFilter) {
    attendanceSql += ` AND a.attendance_date = ? `;
    attendanceParams.push(attendanceDateFilter);
  } else if (attendanceMonthFilter) {
    attendanceSql += ` AND CAST(a.attendance_date AS TEXT) LIKE ? `;
    attendanceParams.push(`${attendanceMonthFilter}%`);
  }
  attendanceSql += ` ORDER BY a.attendance_date DESC, a.id DESC LIMIT 300 `;
  const attendance = await all(attendanceSql, attendanceParams);

  const attendanceDates = await all(
    `SELECT DISTINCT attendance_date
     FROM attendance
     WHERE coaching_id = ?
     ORDER BY attendance_date DESC
     LIMIT 90`,
    [coachingId]
  );

  const fees = await all(
    `SELECT f.id, f.amount, f.due_date, f.payment_date, f.status, f.notes, u.roll_no, u.name, u.batch_id, u.standard, u.course, b.name AS batch_name
     FROM fees f
     JOIN users u ON u.id = f.student_id
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE f.coaching_id = ?
       AND (
         CAST(COALESCE(f.payment_date, '') AS TEXT) LIKE ?
         OR CAST(COALESCE(f.due_date, '') AS TEXT) LIKE ?
       )
     ORDER BY f.created_at DESC
     LIMIT 150`,
    [coachingId, `${feesMonthFilter}%`, `${feesMonthFilter}%`]
  );

  const notes = await all(
    `SELECT bn.id, bn.batch_id, bn.standard, bn.course, bn.title, bn.resource_url, bn.description, bn.created_at,
            b.name AS batch_name
     FROM batch_notes bn
     LEFT JOIN batches b ON b.id = bn.batch_id
     WHERE bn.coaching_id = ?
     ORDER BY bn.created_at DESC
     LIMIT 150`,
    [coachingId]
  );

  const answerRequests = await all(
    `SELECT ar.id, ar.batch_id, ar.standard, ar.course, ar.title, ar.description, ar.starts_at, ar.ends_at, ar.created_at,
            b.name AS batch_name
     FROM answer_upload_requests ar
     LEFT JOIN batches b ON b.id = ar.batch_id
     WHERE ar.coaching_id = ?
     ORDER BY ar.created_at DESC
     LIMIT 20`,
    [coachingId]
  );

  const answerRequestSummaries = await buildAnswerRequestSummaries(coachingId, answerRequests);

  const paperStats = await all(
    `SELECT
       student_id,
       COUNT(*) AS paper_count,
       MAX(upload_date) AS last_upload,
       MAX(CASE WHEN marks_obtained IS NOT NULL AND max_marks IS NOT NULL AND max_marks > 0 THEN upload_date END) AS latest_marked_upload
     FROM test_papers
     WHERE coaching_id = ?
     GROUP BY student_id`,
    [coachingId]
  );

  const latestMarkedPapers = await all(
    `SELECT student_id, marks_obtained, max_marks, upload_date, test_label, original_name
     FROM test_papers
     WHERE coaching_id = ? AND marks_obtained IS NOT NULL AND max_marks IS NOT NULL AND max_marks > 0
     ORDER BY upload_date DESC`,
    [coachingId]
  );

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
    totalStudents: students.length,
    totalPapers: papers.length,
    pendingFees: fees.filter((item) => item.status === 'pending' || item.status === 'overdue').length,
    absentEntries: attendance.filter((item) => item.status === 'absent').length,
    notesCount: notes.length,
    activeAnswerRequests: answerRequestSummaries.filter((item) => item.state.isActive).length,
  };
  const feesPaidThisMonth = fees.filter((item) => item.status === 'paid' && String(item.payment_date || '').startsWith(feesMonthFilter));
  const papersThisMonthCount = papers.length;
  const attendanceThisMonthCount = attendance.length;
  const studentUsage = getStudentUsage(students.length, coaching);
  const batchSummaries = toBatchSummaries(students, batches);
  const studentBatchGroups = toStudentBatchGroups(students, batches);
  const studentSearch = getStudentSearchResults(students, studentSearchQuery);
  const completedBatches = batches.filter((batch) => batch.status === 'completed' && !batch.is_retention_batch).map((batch) => ({
    ...batch,
    studentCount: students.filter((student) => Number(student.batch_id) === Number(batch.id) && !student.is_retained_record).length,
    retainedCount: students.filter((student) => Number(student.retention_source_batch_id || 0) === Number(batch.id) && student.is_retained_record).length,
    eligibleRetentionStudents: students.filter((student) => Number(student.batch_id) === Number(batch.id) && !student.is_retained_record),
    createdDaysAgo: formatDaysAgo(batch.created_at),
    completedDaysAgo: formatDaysAgo(batch.completed_at),
    retentionRemaining: Math.max(
      0,
      RETENTION_MAX_STUDENTS_PER_SOURCE_BATCH
        - students.filter((student) => Number(student.retention_source_batch_id || 0) === Number(batch.id) && student.is_retained_record).length
    ),
  }));

  renderWithMessage(res, 'admin-dashboard', {
    user: req.session.user,
    coaching,
    branding: buildBranding(coaching),
    adminProfile,
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
    attendance,
    attendanceByDate: groupAttendanceByDate(attendance),
    attendanceDates,
    attendanceDateFilter,
    attendanceMonthFilter,
    papersMonthFilter,
    feesMonthFilter,
    fees,
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
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const rollNo = (req.body.rollNo || '').trim();
  const name = (req.body.name || '').trim() || rollNo;
  const contactPhone = (req.body.contactPhone || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const submittedPassword = (req.body.password || '').trim();
  const password = submittedPassword || rollNo;
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);

  if (!rollNo) {
    req.session.flash = { type: 'error', text: 'Roll number is required' };
    return res.redirect('/admin/dashboard?section=students');
  }

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch for the student' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
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
    `SELECT id FROM users WHERE coaching_id = ? AND roll_no = ? LIMIT 1`,
    [coachingId, rollNo]
  );
  if (existing) {
    req.session.flash = { type: 'error', text: 'Roll number already exists in this coaching' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const currentStudents = await get(
    `SELECT COUNT(*) AS total_students FROM users WHERE coaching_id = ? AND role = 'student'`,
    [coachingId]
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
  await run(
    `INSERT INTO users (
      coaching_id, role, is_owner, username, roll_no, name, batch_id, standard, course, contact_phone, email, password_hash
    ) VALUES (?, 'student', 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      rollNo,
      name,
      batch.id,
      normalizedBatchStandard.value,
      batch.course || null,
      contactPhone || null,
      email || null,
      passwordHash,
    ]
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
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/batches', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const batchName = normalizeBatchName(req.body.batchName);

  if (!batchName) {
    req.session.flash = { type: 'error', text: 'Batch name is required' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const normalizedName = batchName.toLowerCase();
  const meta = extractBatchMeta(batchName);
  const existing = await get(
    `SELECT id FROM batches WHERE coaching_id = ? AND normalized_name = ? LIMIT 1`,
    [coachingId, normalizedName]
  );

  if (existing) {
    req.session.flash = { type: 'error', text: 'This batch already exists' };
    return res.redirect('/admin/dashboard?section=students');
  }

  await run(
    `INSERT INTO batches (coaching_id, name, normalized_name, standard, course, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [coachingId, batchName, normalizedName, meta.standard, meta.course, req.session.user.id]
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

  const batch = await getBatchForCoaching(coachingId, batchId);
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
     WHERE coaching_id = ? AND normalized_name = ? AND id <> ?
     LIMIT 1`,
    [coachingId, normalizedName, batchId]
  );

  if (targetBatch) {
    await withTransaction(async (tx) => {
      await tx.run(
        `UPDATE users
         SET batch_id = ?, standard = ?, course = ?
         WHERE coaching_id = ? AND role = 'student' AND batch_id = ?`,
        [targetBatch.id, meta.standard, meta.course, coachingId, batchId]
      );
      await tx.run(
        `UPDATE batch_notes
         SET batch_id = ?, standard = ?, course = ?
         WHERE coaching_id = ? AND batch_id = ?`,
        [targetBatch.id, meta.standard, meta.course, coachingId, batchId]
      );
      await tx.run(
        `UPDATE answer_upload_requests
         SET batch_id = ?, standard = ?, course = ?
         WHERE coaching_id = ? AND batch_id = ?`,
        [targetBatch.id, meta.standard, meta.course, coachingId, batchId]
      );
      await tx.run(`DELETE FROM batches WHERE coaching_id = ? AND id = ?`, [coachingId, batchId]);
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
     WHERE coaching_id = ? AND id = ?`,
    [newBatchName, normalizedName, meta.standard, meta.course, coachingId, batchId]
  );

  await run(
    `UPDATE users
     SET standard = ?, course = ?
     WHERE coaching_id = ? AND role = 'student' AND batch_id = ?`,
    [meta.standard, meta.course, coachingId, batchId]
  );
  await run(
    `UPDATE batch_notes
     SET standard = ?, course = ?
     WHERE coaching_id = ? AND batch_id = ?`,
    [meta.standard, meta.course, coachingId, batchId]
  );
  await run(
    `UPDATE answer_upload_requests
     SET standard = ?, course = ?
     WHERE coaching_id = ? AND batch_id = ?`,
    [meta.standard, meta.course, coachingId, batchId]
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
  const batchId = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Invalid batch selected' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
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
     WHERE coaching_id = ? AND role = 'student' AND batch_id = ?`,
    [coachingId, batchId]
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
       WHERE coaching_id = ? AND batch_id = ?`,
      [coachingId, batchId]
    );

    for (const request of answerRequests) {
      await tx.run(
        `UPDATE test_papers
         SET answer_request_id = NULL
         WHERE coaching_id = ? AND answer_request_id = ?`,
        [coachingId, request.id]
      );
    }

    await tx.run(`DELETE FROM batch_notes WHERE coaching_id = ? AND batch_id = ?`, [coachingId, batchId]);
    await tx.run(`DELETE FROM answer_upload_requests WHERE coaching_id = ? AND batch_id = ?`, [coachingId, batchId]);
    await tx.run(`DELETE FROM batches WHERE coaching_id = ? AND id = ?`, [coachingId, batchId]);
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
  const batchId = Number.parseInt(req.params.id, 10);
  const batch = await getBatchForCoaching(coachingId, batchId);

  if (!batch || batch.is_retention_batch) {
    req.session.flash = { type: 'error', text: 'Batch not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  await run(
    `UPDATE batches
     SET status = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
     WHERE coaching_id = ? AND id = ?`,
    [coachingId, batchId]
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
  const batchId = Number.parseInt(req.params.id, 10);
  const batch = await getBatchForCoaching(coachingId, batchId);

  if (!batch || batch.is_retention_batch) {
    req.session.flash = { type: 'error', text: 'Batch not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  await run(
    `UPDATE batches
     SET status = 'active', completed_at = NULL
     WHERE coaching_id = ? AND id = ?`,
    [coachingId, batchId]
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
  const batchId = Number.parseInt(req.params.id, 10);
  const studentId = Number.parseInt(String(req.body.studentId || '').trim(), 10);
  const batch = await getBatchForCoaching(coachingId, batchId);

  if (!batch || batch.is_retention_batch || batch.status !== 'completed') {
    req.session.flash = { type: 'error', text: 'Only completed batches can move retained students.' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const student = await get(
    `SELECT id, roll_no, name, batch_id, is_retained_record
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'student'
     LIMIT 1`,
    [studentId, coachingId]
  );

  if (!student || Number(student.batch_id || 0) !== batchId || student.is_retained_record) {
    req.session.flash = { type: 'error', text: 'Selected student is not available in this completed batch.' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const retainedCount = await get(
    `SELECT COUNT(*) AS total
     FROM users
     WHERE coaching_id = ? AND role = 'student' AND is_retained_record = 1 AND retention_source_batch_id = ?`,
    [coachingId, batchId]
  );

  if (Number(retainedCount?.total || 0) >= RETENTION_MAX_STUDENTS_PER_SOURCE_BATCH) {
    req.session.flash = { type: 'error', text: `Only ${RETENTION_MAX_STUDENTS_PER_SOURCE_BATCH} retained students are allowed from one completed batch.` };
    return res.redirect('/admin/dashboard?section=students');
  }

  const retentionBatch = await ensureRetentionBatch(coachingId, req.session.user.id);
  await run(
    `UPDATE users
     SET batch_id = ?, standard = NULL, course = NULL, is_retained_record = 1, retention_source_batch_id = ?
     WHERE id = ? AND coaching_id = ?`,
    [retentionBatch.id, batchId, studentId, coachingId]
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
  const studentId = Number(req.params.id);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const dashboard = await getStudentDashboardPayload(coachingId, studentId);

  if (!dashboard.profile) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=overview');
  }

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
    flash: req.session.flash,
  });
  req.session.flash = null;
});

app.post('/admin/students/:id/reset-password', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const studentId = Number(req.params.id);
  const student = await get(
    `SELECT id, roll_no
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'student'`,
    [studentId, coachingId]
  );

  if (!student) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const passwordHash = await bcrypt.hash(student.roll_no, 10);
  await run(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, studentId]);

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
  const studentId = Number(req.params.id);

  const student = await get(
    `SELECT id, roll_no FROM users WHERE id = ? AND coaching_id = ? AND role = 'student'`,
    [studentId, coachingId]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const files = await all(
    `SELECT stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ?`,
    [coachingId, studentId]
  );

  await run(`DELETE FROM attendance WHERE coaching_id = ? AND student_id = ?`, [coachingId, studentId]);
  await run(`DELETE FROM fees WHERE coaching_id = ? AND student_id = ?`, [coachingId, studentId]);
  await run(`DELETE FROM test_papers WHERE coaching_id = ? AND student_id = ?`, [coachingId, studentId]);
  await run(`DELETE FROM users WHERE id = ? AND coaching_id = ?`, [studentId, coachingId]);

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
    `SELECT id, roll_no, batch_id, standard, course
     FROM users
     WHERE coaching_id = ? AND role = 'student' AND roll_no = ?`,
    [coachingId, rollNo]
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
       WHERE id = ? AND coaching_id = ?`,
      [answerRequestId, coachingId]
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
  req.session.flash = { type: 'success', text: textByStatus[result.status] || `Paper uploaded for ${student.roll_no}` };
  return res.redirect('/admin/dashboard?section=papers');
});

app.post('/admin/upload-papers', requireCoachingAdmin, upload.array('papers', 100), async (req, res) => {
  const coachingId = req.session.user.coachingId;
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
      `SELECT id FROM users WHERE coaching_id = ? AND role = 'student' AND roll_no = ?`,
      [coachingId, paperMeta.rollNo]
    );

    if (!student) {
      report.skipped += 1;
      report.details.push({ file: file.originalname, reason: `No student found for roll number "${paperMeta.rollNo}"` });
      continue;
    }

    try {
      const result = await savePaperUpload({
        coachingId,
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
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const startsAtInput = (req.body.startsAt || '').trim() || toDateTimeLocalInput(new Date());

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Select a batch for answer upload request' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
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
      coaching_id, batch_id, standard, course, title, description, starts_at, ends_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
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
  const requestId = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    req.session.flash = { type: 'error', text: 'Invalid upload session selected' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const answerRequest = await get(
    `SELECT id, title, batch_id, standard, course, starts_at, ends_at
     FROM answer_upload_requests
     WHERE coaching_id = ? AND id = ?
     LIMIT 1`,
    [coachingId, requestId]
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
       WHERE coaching_id = ? AND answer_request_id = ?`,
      [coachingId, requestId]
    );
    await tx.run(
      `DELETE FROM answer_upload_requests
       WHERE coaching_id = ? AND id = ?`,
      [coachingId, requestId]
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
  const rollNo = (req.body.rollNo || '').trim();
  const attendanceDate = req.body.attendanceDate;
  const status = req.body.status;
  const notes = (req.body.notes || '').trim();

  const student = await get(
    `SELECT id FROM users WHERE coaching_id = ? AND role = 'student' AND roll_no = ?`,
    [coachingId, rollNo]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student roll number not found' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const existing = await get(
    `SELECT id FROM attendance WHERE coaching_id = ? AND student_id = ? AND attendance_date = ? LIMIT 1`,
    [coachingId, student.id, attendanceDate]
  );

  if (existing) {
    await run(
      `UPDATE attendance SET status = ?, notes = ?, marked_by = ? WHERE id = ?`,
      [status, notes, req.session.user.id, existing.id]
    );
  } else {
    await run(
      `INSERT INTO attendance (coaching_id, student_id, attendance_date, status, notes, marked_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [coachingId, student.id, attendanceDate, status, notes, req.session.user.id]
    );
  }

  req.session.flash = { type: 'success', text: 'Attendance saved' };
  await auditActor(req, 'attendance_saved_single', {
    targetType: 'student',
    targetId: student.id,
    details: { rollNo, attendanceDate, status },
  });
  return res.redirect(`/admin/dashboard?section=attendance&attendanceDate=${encodeURIComponent(attendanceDate)}`);
});

app.post('/admin/attendance-bulk', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const attendanceDate = req.body.attendanceDate;
  const notes = (req.body.notes || '').trim();

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  if (!attendanceDate) {
    req.session.flash = { type: 'error', text: 'Attendance date is required' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const students = await all(
    `SELECT id, roll_no
     FROM users
     WHERE coaching_id = ? AND role = 'student' AND batch_id = ?
     ORDER BY roll_no ASC`,
    [coachingId, batch.id]
  );

  if (!students.length) {
    req.session.flash = { type: 'error', text: 'No students found in selected batch' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const absentees = parseAbsentees(req.body.absentRollNos);
  let absentCount = 0;
  let presentCount = 0;

  for (const student of students) {
    const nextStatus = absentees.has(student.roll_no) ? 'absent' : 'present';
    if (nextStatus === 'absent') absentCount += 1;
    else presentCount += 1;

    const existing = await get(
      `SELECT id FROM attendance WHERE coaching_id = ? AND student_id = ? AND attendance_date = ? LIMIT 1`,
      [coachingId, student.id, attendanceDate]
    );

    if (existing) {
      await run(
        `UPDATE attendance SET status = ?, notes = ?, marked_by = ? WHERE id = ?`,
        [nextStatus, notes, req.session.user.id, existing.id]
      );
    } else {
      await run(
        `INSERT INTO attendance (coaching_id, student_id, attendance_date, status, notes, marked_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [coachingId, student.id, attendanceDate, nextStatus, notes, req.session.user.id]
      );
    }
  }

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

app.post('/admin/fees', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const rollNo = (req.body.rollNo || '').trim();
  const amount = Number(req.body.amount);
  const dueDate = req.body.dueDate || null;
  const paymentDate = req.body.paymentDate || null;
  const status = req.body.status;
  const notes = (req.body.notes || '').trim();

  const student = await get(
    `SELECT id FROM users WHERE coaching_id = ? AND role = 'student' AND roll_no = ?`,
    [coachingId, rollNo]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student roll number not found' };
    return res.redirect('/admin/dashboard?section=fees');
  }

  await run(
    `INSERT INTO fees (coaching_id, student_id, amount, due_date, payment_date, status, notes, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [coachingId, student.id, amount, dueDate, paymentDate, status, notes, req.session.user.id]
  );

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
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const title = (req.body.title || '').trim();
  const resourceUrl = (req.body.resourceUrl || '').trim();
  const description = (req.body.description || '').trim();

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch for note' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (!title || !resourceUrl || !isValidHttpUrl(resourceUrl)) {
    req.session.flash = { type: 'error', text: 'Valid title and URL are required' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  await run(
    `INSERT INTO batch_notes (coaching_id, batch_id, standard, course, title, resource_url, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [coachingId, batch.id, batch.standard || null, batch.course || null, title, resourceUrl, description, req.session.user.id]
  );

  await auditActor(req, 'batch_note_created', {
    targetType: 'batch',
    targetId: batch.id,
    details: { batchName: batch.name, title, resourceUrl },
  });
  req.session.flash = { type: 'success', text: `Batch note published for ${batch.name}` };
  return res.redirect('/admin/dashboard?section=notes');
});

app.post('/student/upload-paper', requireStudent, upload.single('paper'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
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
    `SELECT id, batch_id, standard, course FROM users WHERE id = ? AND coaching_id = ? AND role = 'student'`,
    [studentId, coachingId]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student account not found' };
    return res.redirect('/student/dashboard');
  }

  const answerRequest = await get(
    `SELECT id, title, batch_id, standard, course, starts_at, ends_at
     FROM answer_upload_requests
     WHERE id = ? AND coaching_id = ?`,
    [requestId, coachingId]
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
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const subscriptionState = req.subscriptionState || getSubscriptionState(coaching);
  const dashboard = await getStudentDashboardPayload(coachingId, req.session.user.id);
  const profile = dashboard.profile;

  const answerRequests = profile?.batch_id
    ? await all(
      `SELECT ar.id, ar.title, ar.description, ar.starts_at, ar.ends_at, ar.created_at, ar.batch_id, b.name AS batch_name
       FROM answer_upload_requests ar
       LEFT JOIN batches b ON b.id = ar.batch_id
       WHERE ar.coaching_id = ? AND ar.batch_id = ?
       ORDER BY ar.created_at DESC
       LIMIT 12`,
      [coachingId, profile.batch_id]
    )
    : profile?.standard || profile?.course
      ? await all(
        `SELECT id, title, description, starts_at, ends_at, created_at, batch_id
         FROM answer_upload_requests
         WHERE coaching_id = ?
           AND COALESCE(standard, '') = COALESCE(?, '')
           AND COALESCE(course, '') = COALESCE(?, '')
         ORDER BY created_at DESC
         LIMIT 12`,
        [coachingId, profile.standard || null, profile.course || null]
      )
      : [];

  const submissions = await all(
    `SELECT id, answer_request_id, upload_date, original_name
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ? AND answer_request_id IS NOT NULL
     ORDER BY upload_date DESC`,
    [coachingId, req.session.user.id]
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
    if (!paper) return res.status(404).send('Paper not found');

    const access = await getPaperAccess(paper, 'inline');
    if (!access) return res.status(404).send('Paper access not available');

    if (access.type === 'redirect' && access.url) {
      return res.redirect(access.url);
    }

    if (access.type === 'local' && access.filePath) {
      return res.sendFile(access.filePath);
    }

    return res.status(500).send('Paper access is misconfigured');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Server error');
  }
});

app.get('/papers/:id/download', requireAuth, async (req, res) => {
  try {
    const paper = await getPaperForUser(req.params.id, req.session.user);
    if (!paper) return res.status(404).send('Paper not found');

    const access = await getPaperAccess(paper, 'attachment');
    if (!access) return res.status(404).send('Paper access not available');

    if (access.type === 'redirect' && access.url) {
      return res.redirect(access.url);
    }

    if (access.type === 'local' && access.filePath) {
      return res.download(access.filePath, paper.original_name || paper.stored_name || 'paper');
    }

    return res.status(500).send('Paper access is misconfigured');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Server error');
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
let appReadyPromise = null;

async function prepareApp() {
  if (!appReadyPromise) {
    appReadyPromise = Promise.resolve()
      .then(() => {
        initStorage();
        return getPool().query('SELECT 1');
      })
      .then(() => ensureSessionTable())
      .then(async () => {
        if (process.env.RUN_STARTUP_MAINTENANCE === 'true') {
          await cleanupDuplicateAnswerSubmissions();
        }
      })
      .then(() => {
        console.log(`File storage mode: ${getStorageMode()}`);
      })
      .catch((error) => {
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
