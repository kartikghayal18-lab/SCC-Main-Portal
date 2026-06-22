# Multi-Branch Tenancy

The portal uses PostgreSQL directly, not Prisma. Branch tenancy is therefore
implemented in the existing SQL data layer without adding an ORM or package.

## Branches

- `SCC - Satpur Branch` (`satpur`)
- `SCC - Meri Branch` (`meri`)

Existing SCC records migrate to Satpur. Other coaching tenants receive one
`Main Branch` so their existing records remain valid.

## Deployment

```bash
npm run migrate:branches
npm run seed:branches
npm run verify:branches
```

Set `MERI_ADMIN_PASSWORD` before seeding to choose the initial Meri password.
If omitted, the seed copies the current Satpur admin password hash and forces
the Meri admin to change it on first login.

## Enforcement

- `branch_id` is stored on users and all branch-owned academic/operational data.
- The authenticated session contains `branchId`, `branchCode`, and `branchName`.
- The database helper sets `app.branch_id` for every query.
- PostgreSQL Row Level Security rejects reads and writes outside that branch.
- The owner session sets `app.is_super_admin=true` and can read all branches.
- Admin and student login requires a branch, so duplicate roll numbers can
  safely exist in different branches.
- Uploaded objects remain in the shared configured bucket, while file metadata
  and signed access are protected by branch-scoped records.

## Verification Checklist

1. Run `npm run verify:branches`; both branches must report `isolation passed`.
2. Sign in as Satpur admin and create a student, batch, note, fee, attendance
   entry, and paper.
3. Sign out and sign in as Meri admin. Confirm none of the Satpur records appear.
4. Repeat step 2 in Meri and confirm Satpur cannot see those records.
5. Copy a Satpur student, paper, fee, or batch URL while logged into Meri.
   Confirm the response is `404`, `403`, or `not found`.
6. Use the same student roll number in both branches and confirm each login
   resolves only inside the selected branch.
7. Publish notes and upload papers in each branch and confirm only students in
   that branch receive them.
8. Send a WhatsApp broadcast in each branch and confirm its recipients and logs
   contain only that branch's students.
9. Sign in as owner and switch between Satpur and Meri in the owner dashboard.
   Confirm branch totals change and both branches remain visible.
10. Inspect new rows directly and confirm every academic record has a non-null
    `branch_id`.
