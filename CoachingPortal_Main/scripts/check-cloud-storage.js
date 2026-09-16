#!/usr/bin/env node
require('../config/env');

const { S3Client, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

async function main() {
  const mode = (process.env.FILE_STORAGE_MODE || '').trim().toLowerCase();
  if (mode !== 's3') {
    throw new Error('FILE_STORAGE_MODE is not s3. Set FILE_STORAGE_MODE=s3 in .env first.');
  }

  const endpoint = String(process.env.S3_ENDPOINT || '').trim();
  const region = process.env.S3_REGION || 'ap-south-1';
  const bucket = required('S3_BUCKET_NAME');
  const accessKeyId = required('S3_ACCESS_KEY_ID');
  const secretAccessKey = required('S3_SECRET_ACCESS_KEY');
  const forcePathStyle = String(process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true';

  const clientConfig = {
    region,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  };
  if (endpoint) {
    clientConfig.endpoint = endpoint;
  }
  const s3 = new S3Client(clientConfig);

  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  const testKey = `healthchecks/${Date.now()}_codex_check.txt`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: testKey, Body: 'ok' }));
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: testKey }));

  console.log('Cloud storage check passed. Bucket access is working.');
}

main().catch((err) => {
  console.error('Cloud storage check failed:', err.message);
  process.exitCode = 1;
});
