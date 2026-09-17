// Regression tests for the bulk "Checked File" Excel import's roll-number-to-student
// matching. Requires src/services/omrImportParsing.js directly (a pure module with no
// Express/DB side effects, unlike src/app.js) so these stay fast and repeatable.
//
// Run with: node scripts/test-omr-import-parsing.js
const assert = require('assert');
const {
  extractRollNumberDigits,
  resolveStudentForRollNumber,
} = require('../src/services/omrImportParsing');

let failures = 0;
function check(description, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`PASS  ${description}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${description}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
  }
}

// --- extractRollNumberDigits: the "Roll Number" column value, not the filename ---
check(
  'plain roll number is kept as-is',
  extractRollNumberDigits('75'),
  '75'
);
check(
  'trimmed roll number with spaces',
  extractRollNumberDigits(' 75 '),
  '75'
);
check(
  'OCR-corrupted roll number keeps only the digits',
  extractRollNumberDigits('?????75'),
  '75'
);
check(
  'no digits at all resolves to empty (never guessed)',
  extractRollNumberDigits('????????'),
  ''
);

// --- resolveStudentForRollNumber: the ONLY identity signal, never the filename ---
const students = [
  { id: 1, roll_no: '75' },
  { id: 2, roll_no: '101' },
  { id: 3, roll_no: '0002' },
];

check(
  'exact roll number match resolves to the correct student, ignoring an unrelated filename sequence number',
  resolveStudentForRollNumber('75', students),
  { student: students[0], matchType: 'exact' }
);
check(
  'the "0002" scan-sequence number from a filename must NEVER be treated as a roll number match for a different student',
  resolveStudentForRollNumber('75', students).student.id,
  1
);
check(
  'zero-padded OCR roll number still matches the stored unpadded roll number',
  resolveStudentForRollNumber('075', [{ id: 5, roll_no: '75' }]),
  { student: { id: 5, roll_no: '75' }, matchType: 'numeric_fallback' }
);
check(
  'blank roll number never matches any student',
  resolveStudentForRollNumber('', students),
  { student: null, matchType: 'none' }
);
check(
  'unknown roll number never matches any student',
  resolveStudentForRollNumber('9999', students),
  { student: null, matchType: 'none' }
);

// --- The exact scenario from the summary.xlsx spec: Roll Number 75, Checked File
// 20260915160533_0002_checked.jpg. The "0002" is a scan sequence number embedded in the
// filename and must never be confused with the roll number column value.
const summaryRow = { rollNoRaw: '75', rollNo: extractRollNumberDigits('75'), checkedFile: '20260915160533_0002_checked.jpg' };
check(
  'summary.xlsx example: Roll Number column (75) is used, not the filename sequence number (0002)',
  resolveStudentForRollNumber(summaryRow.rollNo, students).student.roll_no,
  '75'
);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll tests passed.');
