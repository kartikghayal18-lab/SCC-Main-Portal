# EduSync Client Deployment Template

This project keeps the existing production coaching portal behavior intact and reorganizes the codebase so the same app can be copied, rebranded, configured, and deployed separately for multiple coaching clients.

All core working flows remain in place:
- owner/admin/student authentication
- OTP login and recovery
- trusted device login
- attendance
- paper uploads
- AWS S3-compatible storage
- settings
- student management

## Template Architecture

```text
project-root/
  branding/
    logo.png
    favicon.ico
    colors.json
  config/
    client.json
    client.js
    env.js
    database.js
  routes/
    app-routes.js
  shared/
    auth/
      otp-service.js
    uploads/
      storage.js
    mail/
      mailer.js
    utils/
      branding.js
      server.js
  uploads/
  public/
  views/
  src/
    app.js
    db.js
    otp-service.js
    storage.js
```

## Where To Configure Each Client

- Branding: [config/client.json](/Users/kartiiik_001/Documents/edusync-template/config/client.json), [branding/colors.json](/Users/kartiiik_001/Documents/edusync-template/branding/colors.json), [branding/logo.png](/Users/kartiiik_001/Documents/edusync-template/branding/logo.png), [branding/favicon.ico](/Users/kartiiik_001/Documents/edusync-template/branding/favicon.ico)
- Environment variables: [.env.template](/Users/kartiiik_001/Documents/edusync-template/.env.template) then copied to `.env`
- Database config: [config/database.js](/Users/kartiiik_001/Documents/edusync-template/config/database.js)
- Deployment env normalization and aliases: [config/env.js](/Users/kartiiik_001/Documents/edusync-template/config/env.js)
- Route wiring: [routes/app-routes.js](/Users/kartiiik_001/Documents/edusync-template/routes/app-routes.js)
- Shared reusable services: [shared](/Users/kartiiik_001/Documents/edusync-template/shared)

## Quick Start

1. Install dependencies
```bash
npm install
```

2. Create env file
```bash
cp .env.template .env
```

3. Edit client branding
```bash
open config/client.json
```

4. Start locally
```bash
npm start
```

5. Open
- [http://localhost:3000/login](http://localhost:3000/login)

## Client Duplication Workflow

1. Copy the entire project folder.
2. Rename the copied folder for the client.
3. Update [config/client.json](/Users/kartiiik_001/Documents/edusync-template/config/client.json) with the client name, domain, primary color, and support email.
4. Replace [branding/logo.png](/Users/kartiiik_001/Documents/edusync-template/branding/logo.png) and [branding/favicon.ico](/Users/kartiiik_001/Documents/edusync-template/branding/favicon.ico) with client assets.
5. Copy [.env.template](/Users/kartiiik_001/Documents/edusync-template/.env.template) to `.env` and fill client-specific values.
6. Point `DATABASE_URL` to that client’s separate database.
7. Set that client’s own AWS/S3 bucket credentials and mail credentials.
8. Deploy the copied folder to the client’s separate domain.

## Branding Behavior

- Deployment-level branding now comes from `config/client.json`.
- View titles, favicon, default logo, owner console labels, and OTP email branding now resolve from that file.
- Existing coaching-level branding stored in the database still works and continues to override deployment defaults where appropriate.
- UI layout and styling structure were not redesigned.

## Upload Behavior

- Shared upload logic now lives in [shared/uploads/storage.js](/Users/kartiiik_001/Documents/edusync-template/shared/uploads/storage.js).
- Uploads are stored under a client-specific prefix derived from `client.json`.
- Example object path:
  - `demo-coaching/uploads/2026-05-21/<timestamp>_<uuid>_paper.pdf`
- Existing S3 access flow, signed URL flow, and local fallback flow remain intact.

## Environment Notes

The app now accepts template-friendly env names and maps them automatically:

- `AWS_ACCESS_KEY_ID` -> `S3_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY` -> `S3_SECRET_ACCESS_KEY`
- `AWS_REGION` -> `S3_REGION`
- `AWS_BUCKET` -> `S3_BUCKET_NAME`
- `JWT_SECRET` -> `SESSION_SECRET`

That means each client copy can use the cleaner `.env.template` values without changing runtime code.

## Verification Commands

Start the app:

```bash
npm start
```

Check storage credentials:

```bash
npm run check:cloud
```

Migrate existing local uploads to cloud storage:

```bash
npm run migrate:papers:cloud
```

To migrate and remove local copies:

```bash
npm run migrate:papers:cloud -- --delete-local
```

## Environment Variables
Important keys:
- `DATABASE_URL`
- `SESSION_SECRET`
- `FILE_STORAGE_MODE`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET_NAME`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`
- `S3_PUBLIC_BASE_URL`
- `S3_SIGNED_URL_TTL_SECONDS`

## Deployment
### Vercel
- Set `DATABASE_URL` to a Postgres/Neon database.
- Set a stable `SESSION_SECRET`.
- Set `FILE_STORAGE_MODE=s3` and all required `S3_*` variables.
- Keep uploads small on Vercel, or move large paper uploads to direct browser-to-S3 later.
- Deploy with Vercel Git integration or `npx vercel --prod`.

### Docker
Build:
```bash
docker build -t coaching-app .
```

Run:
```bash
docker run -p 3000:3000 --env-file .env coaching-app
```

### Platform Deploy (Render/Railway/Fly/etc.)
- Set all required env vars in platform settings.
- Keep `FILE_STORAGE_MODE=s3` for production.
- Use managed cloud storage bucket for all uploads.
- Use managed Postgres/Neon via `DATABASE_URL`.
- Full step-by-step: [DEPLOYMENT.md](/Users/kartiiik_001/Documents/Playground/DEPLOYMENT.md)

## Important Paths
- App entry: `src/app.js`
- Vercel entry: `api/index.js`
- DB setup: `src/db.js`
- Storage module: `src/storage.js`
- Migration script: `scripts/migrate-papers-to-cloud.js`
