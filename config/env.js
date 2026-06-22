const path = require('path');
const dotenv = require('dotenv');

// Deployment environment is normalized here so every client copy can keep
// its own .env values while the app supports both legacy S3_* keys and the
// template-friendly AWS_* / JWT_SECRET aliases.
const ROOT_DIR = path.join(__dirname, '..');
let envPrepared = false;

function applyAlias(targetKey, aliasKeys) {
  if (process.env[targetKey]) return;

  for (const aliasKey of aliasKeys) {
    const value = process.env[aliasKey];
    if (value !== undefined && value !== '') {
      process.env[targetKey] = value;
      return;
    }
  }
}

function ensureEnv() {
  if (envPrepared) return;

  dotenv.config({
    path: path.join(ROOT_DIR, '.env'),
    quiet: true,
  });

  applyAlias('SESSION_SECRET', ['JWT_SECRET']);
  applyAlias('S3_ACCESS_KEY_ID', ['AWS_ACCESS_KEY_ID']);
  applyAlias('S3_SECRET_ACCESS_KEY', ['AWS_SECRET_ACCESS_KEY']);
  applyAlias('S3_REGION', ['AWS_REGION']);
  applyAlias('S3_BUCKET_NAME', ['AWS_BUCKET']);
  applyAlias('S3_ENDPOINT', ['AWS_ENDPOINT']);
  applyAlias('S3_PUBLIC_BASE_URL', ['AWS_PUBLIC_BASE_URL']);
  applyAlias('WHATSAPP_VERIFY_TOKEN', ['META_WEBHOOK_VERIFY_TOKEN']);

  envPrepared = true;
}

ensureEnv();

module.exports = {
  ROOT_DIR,
  ensureEnv,
};
