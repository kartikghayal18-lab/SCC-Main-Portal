require('../../config/env');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT_DIR } = require('../../config/env');
const { getClientConfig } = require('../../config/client');

function resolveLocalPaperDir() {
  if (process.env.LOCAL_PAPER_DIR) {
    return path.resolve(process.env.LOCAL_PAPER_DIR);
  }

  const uploadsDir = path.join(ROOT_DIR, 'uploads');
  if (fs.existsSync(uploadsDir)) {
    return uploadsDir;
  }

  return path.join(ROOT_DIR, 'papers');
}

const LOCAL_PAPER_DIR = resolveLocalPaperDir();
const modeFromEnv = (process.env.FILE_STORAGE_MODE || '').trim().toLowerCase();
const storageMode = modeFromEnv || (process.env.S3_BUCKET_NAME ? 's3' : 'local');

const s3Config = {
  bucket: process.env.S3_BUCKET_NAME,
  region: process.env.S3_REGION || 'ap-south-1',
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

function sanitizeFileName(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 240);
}

function sanitizePathSegment(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function quoteFileName(name) {
  return String(name || 'file').replace(/"/g, '');
}

function ensureLocalDir(targetDir = LOCAL_PAPER_DIR) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
}

function getS3Client() {
  if (!s3Client) {
    const { S3Client } = getS3Sdk();
    const clientConfig = {
      region: s3Config.region,
      forcePathStyle: s3Config.forcePathStyle,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    };

    if (s3Config.endpoint) {
      clientConfig.endpoint = s3Config.endpoint;
    }

    s3Client = new S3Client(clientConfig);
  }
  return s3Client;
}

function validateS3Config() {
  const missing = [];
  if (!s3Config.bucket) missing.push('AWS_BUCKET');
  if (!s3Config.accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
  if (!s3Config.secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
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

function getClientUploadPrefix() {
  const clientConfig = getClientConfig();
  return sanitizePathSegment(clientConfig.uploadPrefix || clientConfig.clientName) || 'demo-coaching';
}

function buildStorageKey(file, options = {}) {
  const safeOriginal = sanitizeFileName(file.originalname);
  const folderPrefix = sanitizePathSegment(options.clientFolder) || getClientUploadPrefix();
  const dateFolder = new Date().toISOString().slice(0, 10);
  return path.posix.join(
    folderPrefix,
    'uploads',
    dateFolder,
    `${Date.now()}_${crypto.randomUUID()}_${safeOriginal}`
  );
}

async function uploadPaperFile(file, options = {}) {
  const storageKey = buildStorageKey(file, options);

  if (storageMode === 's3') {
    const { PutObjectCommand } = getS3Sdk();
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: storageKey,
        Body: file.buffer,
        ContentType: file.mimetype || 'application/octet-stream',
      })
    );

    const publicUrl = s3PublicBaseUrl ? `${s3PublicBaseUrl.replace(/\/$/, '')}/${storageKey}` : null;

    return {
      storedName: storageKey,
      storageType: 's3',
      storageKey,
      publicUrl,
      contentType: file.mimetype || null,
      sizeBytes: file.size || null,
    };
  }

  ensureLocalDir();
  const localPath = path.join(LOCAL_PAPER_DIR, storageKey);
  ensureLocalDir(path.dirname(localPath));
  await fs.promises.writeFile(localPath, file.buffer);

  return {
    storedName: storageKey,
    storageType: 'local',
    storageKey,
    publicUrl: null,
    contentType: file.mimetype || null,
    sizeBytes: file.size || null,
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

  return getSignedUrl(getS3Client(), command, {
    expiresIn: s3Config.signedUrlTtlSeconds,
  });
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

  const storageKey = resolveStorageKey(paper);
  const filePath = path.join(LOCAL_PAPER_DIR, storageKey);
  return { type: 'local', filePath };
}

async function deleteStoredPaper(paper) {
  const storageType = resolveStorageType(paper);
  const storageKey = resolveStorageKey(paper);
  if (!storageKey) return;

  if (storageType === 's3') {
    const { DeleteObjectCommand } = getS3Sdk();
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: s3Config.bucket,
        Key: storageKey,
      })
    );
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
  uploadPaperFile,
  getPaperAccess,
  deleteStoredPaper,
};
