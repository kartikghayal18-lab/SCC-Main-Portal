# OMR Result Import

Admins can import OMR result exports from **Admin Dashboard > Test Papers > Import OMR Results**.

## CSV Import

1. Export the result as CSV.
2. Open **Admin Dashboard > Test Papers**.
3. Enter the exact test name.
4. Enter max marks for percentage, graph, and analytics generation.
5. Upload the CSV and optional scanned answer sheets.
6. Submit the import.

Supported columns include:

- RollNumber
- Roll No
- Student Name
- Barcode
- Correct Total
- Wrong Total
- Unattempted Total
- Correct Marks Total
- Wrong Marks Total
- Total Marks Total
- Physics Marks
- Chemistry Marks
- Biology Marks
- Rank
- Student Rank

Rows are matched strictly by roll number. If a CSV roll number is not found, that row is added to the import error report and the remaining matched rows can still be committed.

Duplicate rows for the same branch, test, and student are skipped unless **Overwrite duplicate roll numbers for this test** is selected.

## OMR Sheet Uploads

Scanned answer sheets can be uploaded as PDF, JPG, JPEG, PNG, or a ZIP containing those files.

Name each file with the exact roll number:

- `101.pdf`
- `101.jpg`

Do not encode marks in answer sheet filenames. Names like `101_78_100.pdf` are not used by the OMR import.

Files are stored under:

```text
uploads/omr/<testPaperId>/<rollNumber>.pdf
```

Student and admin access is branch-scoped. Students can only view their own OMR sheets.

## Performance Integration

Imported marks are stored in `test_papers`, so existing performance summaries, reports, graphs, and ranking code continue to read from the same source of truth.
