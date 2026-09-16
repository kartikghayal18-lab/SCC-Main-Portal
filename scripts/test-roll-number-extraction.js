// Regression tests for the bulk paper import's OCR roll-number extraction.
//
// This is a verbatim copy of `extractRollNumberDigits` from src/app.js (used by
// `toBulkPaperExcelRows`). It is duplicated here, instead of required from
// src/app.js directly, because requiring app.js starts the full HTTP server and
// its startup DB/schema calls — too heavy for a quick, repeatable unit test. If
// `extractRollNumberDigits` in src/app.js ever changes, update this copy too.
//
// Run with: node scripts/test-roll-number-extraction.js
const assert = require('assert');

function extractRollNumberDigits(value) {
  const digitRuns = String(value || '').match(/\d+/g);
  if (!digitRuns || !digitRuns.length) return '';
  return digitRuns[digitRuns.length - 1];
}

const cases = [
  // [input, expected, description]
  ['?????75', '75', 'leading question marks stripped, digits kept'],
  ['?????775', '775', 'longer digit run preserved in full'],
  ['?????91', '91', ''],
  ['?????80', '80', ''],
  ['Roll No: ?????775', '775', 'label text before the OCR value is ignored'],
  ['Roll No: ?????91', '91', ''],
  ['00075', '00075', 'leading zeros in a clean numeric value are preserved'],
  ['???????', '', 'no digits at all -> empty, never treated as a valid roll number'],
  ['', '', 'blank value -> empty'],
  [undefined, '', 'undefined -> empty, does not throw'],
  ['Scan_0001 - Roll ?????42', '42', 'a leading filename-style index is NOT used; only the final digit run (the OCR roll number) is kept'],
];

let failures = 0;
for (const [input, expected, description] of cases) {
  const actual = extractRollNumberDigits(input);
  try {
    assert.strictEqual(actual, expected);
    console.log(`PASS  ${JSON.stringify(input)} -> ${JSON.stringify(actual)}${description ? `  (${description})` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${JSON.stringify(input)} -> ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}${description ? `  (${description})` : ''}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} tests passed.`);
