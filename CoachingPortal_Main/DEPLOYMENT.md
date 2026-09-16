# Deployment Guide

This project supports both a normal long-running Node server (`npm start`, useful for Render/Railway/Fly/VM) and Vercel Serverless Functions (`api/index.js`, configured by `vercel.json`).

Each client copy should have:
- its own folder
- its own `.env`
- its own `config/client.json` when using the reusable client template files
- its own database
- its own storage bucket or bucket prefix
- its own domain

## 1. Create Cloud Storage

Cloudflare R2, AWS S3, or another S3-compatible provider works.

For Cloudflare R2:
1. Create a Cloudflare account.
2. Open R2 and create a private bucket.
3. Create an R2 API token with read/write bucket access.
4. Note the account ID, bucket name, access key ID, and secret access key.

R2 endpoint format:

```text
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

## 2. Configure Environment Variables

Use `.env.example` as the base and set at least:

```bash
DATABASE_URL=postgresql://...
SESSION_SECRET=...
FILE_STORAGE_MODE=s3
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET_NAME=<YOUR_BUCKET>
S3_ACCESS_KEY_ID=<YOUR_KEY>
S3_SECRET_ACCESS_KEY=<YOUR_SECRET>
S3_SIGNED_URL_TTL_SECONDS=600
```

Before deployment, verify storage credentials:

```bash
npm run check:cloud
```

## 3. Deploy on Vercel

Required for Vercel:
- `DATABASE_URL` must point to Postgres or Neon. Do not use SQLite on Vercel.
- `SESSION_SECRET` must be a stable random string.
- `FILE_STORAGE_MODE=s3` is required because Vercel cannot persist local uploads.
- `S3_*` variables must point to Cloudflare R2, AWS S3, or another S3-compatible bucket.
- Existing `local` paper records must be migrated to S3/R2 before Vercel can serve those files.
- Large file uploads are limited by Vercel request limits. Use direct browser-to-S3 uploads later if you need large PDFs.

Deploy:

```bash
npm install
npx vercel
npx vercel --prod
```

Vercel entrypoint:
- `api/index.js` imports `src/app.js`.
- `src/app.js` exports `app`, `prepareApp`, and `startServer`.
- `vercel.json` rewrites app traffic to the Vercel function.

Database migration:

```bash
psql "$DATABASE_URL" -f migrations/001_vercel_sessions.sql
```

The app also creates this session table automatically during startup, but running the migration first makes deployment failures easier to diagnose.

## 4. Deploy on Render / Railway / Fly / VM

Docker:

```bash
docker build -t edusync-client-template .
docker run -p 3000:3000 --env-file .env edusync-client-template
```

Native Node:

```bash
npm ci --omit=dev
npm start
```

Keep `FILE_STORAGE_MODE=s3` in production so papers are stored in cloud storage.

## 5. Migrate Existing Local Files to Cloud

Only needed if you already uploaded files in local mode.

```bash
npm run migrate:papers:cloud
```

To migrate and remove local copies:

```bash
npm run migrate:papers:cloud -- --delete-local
```

## 6. Post-Deploy Verification

Verify these flows after deployment:

1. Owner login
2. Admin login
3. OTP flow
4. Trusted device flow
5. Admin dashboard
6. Student dashboard
7. Paper upload
8. Paper view/download
9. Attendance update
10. Settings save

## 7. New Client Checklist

1. Copy project folder.
2. Rename folder.
3. Edit `config/client.json` if using the client template.
4. Replace branding assets if needed.
5. Copy `.env.example` to `.env`.
6. Set separate database credentials.
7. Set separate storage credentials.
8. Set separate mail credentials.
9. Deploy.
10. Connect domain.
