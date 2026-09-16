const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { measurePerfOperation } = require('./performance');

const ROOT_DIR = path.join(__dirname, '..');
const LOCAL_PAPER_DIR = process.env.LOCAL_PAPER_DIR
  ? path.resolve(process.env.LOCAL_PAPER_DIR)
  : path.join(ROOT_DIR, 'papers');

const modeFromEnv = (process.env.FILE_STORAGE_MODE || '').trim().toLowerCase();
const storageMode = modeFromEnv || (process.env.S3_BUCKET_NAME ? 's3' : 'local');

const s3Config = {
  bucket: process.env.S3_BUCKET_NAME,
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
  signedUrlTtlSeconds: Number(process.env.S3_SIGNED_URL_TTL_SECONDS || 600),
};

const s3PublicBaseUrl = (process.env.S3_PUBLIC_BASE_URL || '').trim();
let s3Sdk = null;
let s3Presigner = null;
let s3Client = null;

function getS3Sdk() {
  if (!s3Sdk) {
    s3Sdk = require('@aws-sdk/client-s3');
  }
  return s3Sdk;
}

function getS3Presigner() {
  if (!s3Presigner) {
    s3Presigner = require('@aws-sdk/s3-request-presigner');
  }
  return s3Presigner;
}

function getAppPublicBaseUrl() {
  return String(
    process.env.APP_BASE_URL
    || process.env.PUBLIC_BASE_URL
    || process.env.RENDER_EXTERNAL_URL
    || process.env.VERCEL_URL
    || ''
  ).trim().replace(/\/$/, '').replace(/^([^h])/, 'https://$1');
}

function sanitizeFileName(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180);
}

function quoteFileName(name) {
  return String(name || 'file').replace(/"/g, '');
}

function ensureLocalDir() {
  if (!fs.existsSync(LOCAL_PAPER_DIR)) {
    fs.mkdirSync(LOCAL_PAPER_DIR, { recursive: true });
  }
}

function getS3Client() {
  if (!s3Client) {
    const { S3Client } = getS3Sdk();
    s3Client = new S3Client({
      region: s3Config.region,
      endpoint: s3Config.endpoint || undefined,
      forcePathStyle: s3Config.forcePathStyle,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    });
  }
  return s3Client;
}

function validateS3Config() {
  const missing = [];
  if (!s3Config.bucket) missing.push('S3_BUCKET_NAME');
  if (!s3Config.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
  if (!s3Config.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
  if (!s3Config.endpoint) missing.push('S3_ENDPOINT');
  if (missing.length) {
    throw new Error(`S3 mode enabled but missing env vars: ${missing.join(', ')}`);
  }
}

function initStorage() {
  if (storageMode === 's3') {
    validateS3Config();
    return;
  }

  if (!['local', 's3'].includes(storageMode)) {
    throw new Error(`Unsupported FILE_STORAGE_MODE: ${storageMode}`);
  }

  if (process.env.VERCEL) {
    throw new Error('Vercel deployments require FILE_STORAGE_MODE=s3 because local uploaded files are not persistent.');
  }

  ensureLocalDir();
}

function getStorageMode() {
  return storageMode;
}

function getLocalPaperDir() {
  return LOCAL_PAPER_DIR;
}

async function uploadPaperFile(file) {
  const safeOriginal = sanitizeFileName(file.originalname);

  if (storageMode === 's3') {
    const { PutObjectCommand } = getS3Sdk();
    const key = `papers/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${crypto.randomUUID()}_${safeOriginal}`;

    await measurePerfOperation('s3', 'PutObject paper upload', () => getS3Client().send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype || 'application/octet-stream',
      })
    ), { key });

    const publicUrl = s3PublicBaseUrl ? `${s3PublicBaseUrl.replace(/\/$/, '')}/${key}` : null;

    return {
      storedName: key,
      storageType: 's3',
      storageKey: key,
      publicUrl,
      contentType: file.mimetype || null,
      sizeBytes: file.size || null,
    };
  }

  ensureLocalDir();
  const fileName = `${Date.now()}_${safeOriginal}`;
  const localPath = path.join(LOCAL_PAPER_DIR, fileName);
  await fs.promises.writeFile(localPath, file.buffer);

  return {
    storedName: fileName,
    storageType: 'local',
    storageKey: fileName,
    publicUrl: getAppPublicBaseUrl() ? `${getAppPublicBaseUrl()}/paper-files/${encodeURIComponent(fileName)}` : null,
    contentType: file.mimetype || null,
    sizeBytes: file.size || null,
  };
}

async function uploadGeneratedFile({ buffer, fileName, contentType = 'application/octet-stream', folder = 'generated' }) {
  const safeOriginal = sanitizeFileName(fileName);

  if (storageMode === 's3') {
    const { PutObjectCommand, GetObjectCommand } = getS3Sdk();
    const { getSignedUrl } = getS3Presigner();
    const key = `${folder}/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${crypto.randomUUID()}_${safeOriginal}`;

    await measurePerfOperation('s3', 'PutObject generated file upload', () => getS3Client().send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    ), { key, contentType });

    const publicUrl = s3PublicBaseUrl
      ? `${s3PublicBaseUrl.replace(/\/$/, '')}/${key}`
      : await measurePerfOperation('s3', 'GetObject signed URL generated file', () => getSignedUrl(
        getS3Client(),
        new GetObjectCommand({
          Bucket: s3Config.bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${quoteFileName(safeOriginal)}"`,
          ResponseContentType: contentType,
        }),
        { expiresIn: s3Config.signedUrlTtlSeconds }
      ), { key, expiresIn: s3Config.signedUrlTtlSeconds });

    return {
      storedName: key,
      storageType: 's3',
      storageKey: key,
      publicUrl,
      contentType,
      sizeBytes: buffer.length,
    };
  }

  ensureLocalDir();
  const fileNameWithPrefix = `${Date.now()}_${safeOriginal}`;
  const localPath = path.join(LOCAL_PAPER_DIR, fileNameWithPrefix);
  await fs.promises.writeFile(localPath, buffer);

  return {
    storedName: fileNameWithPrefix,
    storageType: 'local',
    storageKey: fileNameWithPrefix,
    publicUrl: getAppPublicBaseUrl() ? `${getAppPublicBaseUrl()}/paper-files/${encodeURIComponent(fileNameWithPrefix)}` : null,
    contentType,
    sizeBytes: buffer.length,
  };
}

function resolveStorageType(paper) {
  return paper.storage_type || 'local';
}

function resolveStorageKey(paper) {
  return paper.storage_key || paper.stored_name;
}

async function getSignedPaperUrl(paper, dispositionType) {
  const key = resolveStorageKey(paper);
  if (!key) return null;

  const { GetObjectCommand } = getS3Sdk();
  const { getSignedUrl } = getS3Presigner();
  const command = new GetObjectCommand({
    Bucket: s3Config.bucket,
    Key: key,
    ResponseContentDisposition: `${dispositionType}; filename="${quoteFileName(paper.original_name)}"`,
    ResponseContentType: paper.content_type || undefined,
  });

  return measurePerfOperation('s3', 'GetObject signed URL paper', () => getSignedUrl(getS3Client(), command, {
    expiresIn: s3Config.signedUrlTtlSeconds,
  }), { key, expiresIn: s3Config.signedUrlTtlSeconds });
}

async function getStoredFilePublicUrl({
  storageType,
  storageKey,
  fileName = 'file',
  contentType,
  dispositionType = 'attachment',
}) {
  if (!storageKey) return null;

  if (storageType === 's3') {
    if (s3PublicBaseUrl) {
      return `${s3PublicBaseUrl.replace(/\/$/, '')}/${storageKey}`;
    }

    const { GetObjectCommand } = getS3Sdk();
    const { getSignedUrl } = getS3Presigner();
    return measurePerfOperation('s3', 'GetObject signed URL stored file', () => getSignedUrl(
      getS3Client(),
      new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: storageKey,
        ResponseContentDisposition: `${dispositionType}; filename="${quoteFileName(fileName)}"`,
        ResponseContentType: contentType || undefined,
      }),
      { expiresIn: s3Config.signedUrlTtlSeconds }
    ), { key: storageKey, expiresIn: s3Config.signedUrlTtlSeconds });
  }

  return getAppPublicBaseUrl()
    ? `${getAppPublicBaseUrl()}/paper-files/${encodeURIComponent(storageKey)}`
    : null;
}

async function getStoredFileReadStream({
  storageType,
  storageKey,
}) {
  if (!storageKey) {
    throw new Error('Stored file key is required');
  }

  if (storageType === 's3') {
    const { GetObjectCommand } = getS3Sdk();
    const response = await measurePerfOperation('s3', 'GetObject read stream', () => getS3Client().send(
      new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: storageKey,
      })
    ), { key: storageKey });
    return {
      stream: response.Body,
      contentType: response.ContentType || 'application/octet-stream',
      contentLength: response.ContentLength || null,
    };
  }

  const safeFileName = path.basename(storageKey);
  const filePath = path.join(LOCAL_PAPER_DIR, safeFileName);
  const relativePath = path.relative(LOCAL_PAPER_DIR, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !fs.existsSync(filePath)) {
    throw new Error('Stored file not found');
  }

  const stat = await fs.promises.stat(filePath);
  return {
    stream: fs.createReadStream(filePath),
    contentType: 'application/octet-stream',
    contentLength: stat.size,
  };
}

async function getPaperAccess(paper, dispositionType) {
  const storageType = resolveStorageType(paper);

  if (storageType === 's3') {
    const signedUrl = await getSignedPaperUrl(paper, dispositionType);
    return { type: 'redirect', url: signedUrl };
  }

  if (process.env.VERCEL) {
    return null;
  }

  const fileName = resolveStorageKey(paper);
  const filePath = path.join(LOCAL_PAPER_DIR, fileName);
  return { type: 'local', filePath };
}

async function deleteStoredPaper(paper) {
  const storageType = resolveStorageType(paper);
  const storageKey = resolveStorageKey(paper);
  if (!storageKey) return;

  if (storageType === 's3') {
    const { DeleteObjectCommand } = getS3Sdk();
    await measurePerfOperation('s3', 'DeleteObject paper', () => getS3Client().send(
      new DeleteObjectCommand({
        Bucket: s3Config.bucket,
        Key: storageKey,
      })
    ), { key: storageKey });
    return;
  }

  if (process.env.VERCEL) {
    return;
  }

  const filePath = path.join(LOCAL_PAPER_DIR, storageKey);
  if (fs.existsSync(filePath)) {
    await fs.promises.unlink(filePath);
  }
}

module.exports = {
  initStorage,
  getStorageMode,
  getLocalPaperDir,
  uploadPaperFile,
  uploadGeneratedFile,
  getStoredFilePublicUrl,
  getStoredFileReadStream,
  getPaperAccess,
  deleteStoredPaper,
};
