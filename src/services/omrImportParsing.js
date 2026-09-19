const zlib = require('zlib');

// Pure parsing/matching helpers for the OMR Result-Excel and bulk-paper Checked-File
// Excel import formats. Extracted out of src/app.js so this logic can be exercised by
// regression tests without booting the Express app / DB pool that app.js starts as a
// side effect of being required.

function normalizeOmrHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsvRows(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(value);
      value = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => String(cell || '').trim())) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }
  row.push(value);
  if (row.some((cell) => String(cell || '').trim())) rows.push(row);
  return rows;
}

function readZipEntries(buffer) {
  const entries = [];
  let offset = buffer.length - 22;
  while (offset >= 0 && buffer.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
  if (offset < 0) throw new Error('Invalid ZIP file');
  const entryCount = buffer.readUInt16LE(offset + 10);
  let centralOffset = buffer.readUInt32LE(offset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const compression = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
    const fileName = buffer.subarray(centralOffset + 46, centralOffset + 46 + fileNameLength).toString('utf8');

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (compression === 0) {
      data = Buffer.from(compressed);
    } else if (compression === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compression}`);
    }
    if (fileName && !fileName.endsWith('/')) entries.push({ name: fileName, data });
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Rows and cells are matched as `<tag attrs/>` OR `<tag attrs>...</tag>`. Excel writes empty
// styled cells as self-closing `<c r="B2" s="1"/>` (and can write empty rows the same way);
// a plain `<c\b[\s\S]*?<\/c>` would run past the `/>` and swallow the NEXT cell, shifting
// its value into the empty cell's column — e.g. a blank Roll Number cell would pick up the
// Paper Code, so the wrong student's roll number would be resolved.
//
// Each returned row array carries `rowNumber`: the real spreadsheet row (the <row r="..">
// attribute), so skip/failure reports point at the row the admin sees in Excel even when
// blank rows precede it.
function parseSheetXml(sheetXml, sharedStrings) {
  const rows = [];
  const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(sheetXml)) !== null) {
    const rowNumber = Number((rowMatch[1].match(/\br="(\d+)"/) || [])[1]) || null;
    const rowBody = rowMatch[2] || '';
    const cells = [];
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowBody)) !== null) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1] || '';
      const columnIndex = ref.split('').reduce((sum, char) => (sum * 26) + char.charCodeAt(0) - 64, 0) - 1;
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
      const vMatch = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      const inlineText = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
        .map((part) => (part.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '')
        .join('');
      const rawValue = decodeXmlText(vMatch ? vMatch[1] : inlineText);
      const value = type === 's' ? (sharedStrings[Number(rawValue)] || '') : rawValue;
      cells[columnIndex >= 0 ? columnIndex : cells.length] = value;
    }
    if (cells.some((cell) => String(cell || '').trim())) {
      const normalized = Array.from(cells, (cell) => cell || '');
      normalized.rowNumber = rowNumber;
      rows.push(normalized);
    }
  }
  return rows;
}

function parseXlsxRows(buffer) {
  const entries = readZipEntries(buffer);
  const entryByName = new Map(entries.map((entry) => [entry.name.replace(/^\/+/, ''), entry.data]));
  const sharedXml = entryByName.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const sharedStrings = (sharedXml.match(/<si\b[\s\S]*?<\/si>/g) || []).map((item) => decodeXmlText(
    (item.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
      .map((part) => (part.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '')
      .join('')
  ));
  const sheetEntry = entries.find((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name));
  if (!sheetEntry) throw new Error('No worksheet found in XLSX file');
  return parseSheetXml(sheetEntry.data.toString('utf8'), sharedStrings);
}

function parseOmrNumber(value) {
  const cleaned = String(value ?? '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function getOmrValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[normalizeOmrHeader(alias)];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function normalizeOmrRow(row, fallbackMaxMarks = null) {
  const obtainedMarks = parseOmrNumber(getOmrValue(row, ['Total Marks', 'Correct Marks Total', 'Total Marks Total', 'Obtained Marks', 'Marks Obtained']));
  const maxMarks = parseOmrNumber(getOmrValue(row, ['Max Marks', 'Maximum Marks', 'Total Maximum Marks', 'Out Of'])) ?? fallbackMaxMarks;
  const biologyMarks = parseOmrNumber(getOmrValue(row, ['Biology Marks', 'Biology']));
  return {
    rollNo: getOmrValue(row, ['Roll No', 'RollNumber', 'Roll Number', 'Roll']),
    studentName: getOmrValue(row, ['Student Name', 'Name']),
    barcode: getOmrValue(row, ['Barcode', 'Bar Code']),
    correctCount: parseOmrNumber(getOmrValue(row, ['Correct Total', 'Correct Count'])),
    wrongCount: parseOmrNumber(getOmrValue(row, ['Wrong Total', 'Wrong Count'])),
    unattemptedCount: parseOmrNumber(getOmrValue(row, ['Unattempted Total', 'Unattempted Count', 'Blank Total'])),
    obtainedMarks,
    maxMarks,
    percentage: maxMarks && obtainedMarks !== null ? Number(((obtainedMarks / maxMarks) * 100).toFixed(2)) : parseOmrNumber(getOmrValue(row, ['Percentage', 'Percent'])),
    physicsMarks: parseOmrNumber(getOmrValue(row, ['Physics Marks', 'Physics'])),
    chemistryMarks: parseOmrNumber(getOmrValue(row, ['Chemistry Marks', 'Chemistry'])),
    biologyMarks,
    botanyMarks: biologyMarks ?? parseOmrNumber(getOmrValue(row, ['Botany Marks', 'Botany'])),
    zoologyMarks: parseOmrNumber(getOmrValue(row, ['Zoology Marks', 'Zoology'])),
    rank: parseOmrNumber(getOmrValue(row, ['Rank', 'Student Rank'])),
    raw: row,
  };
}

const REQUIRED_RESULT_EXCEL_COLUMNS = [
  { label: 'Roll No', aliases: ['Roll No', 'RollNumber', 'Roll Number', 'Roll'] },
  { label: 'Student Name', aliases: ['Student Name', 'Name'] },
  { label: 'Physics Marks', aliases: ['Physics Marks', 'Physics'] },
  { label: 'Chemistry Marks', aliases: ['Chemistry Marks', 'Chemistry'] },
  { label: 'Biology Marks', aliases: ['Biology Marks', 'Biology'] },
  { label: 'Total Marks', aliases: ['Total Marks', 'Correct Marks Total', 'Total Marks Total', 'Obtained Marks', 'Marks Obtained'] },
];

function validateResultExcelColumns(normalizedHeaders) {
  const headerSet = new Set(normalizedHeaders.filter(Boolean));
  const missing = REQUIRED_RESULT_EXCEL_COLUMNS.filter(
    (column) => !column.aliases.some((alias) => headerSet.has(normalizeOmrHeader(alias)))
  );
  if (missing.length) {
    throw new Error(`Missing required column(s): ${missing.map((column) => column.label).join(', ')}. Required columns: Roll No, Student Name, Physics Marks, Chemistry Marks, Biology Marks, Total Marks.`);
  }
}

function toOmrTableRows(fileBuffer, fallbackMaxMarks, fileName = '') {
  const isXlsx = /\.xlsx$/i.test(fileName || '');
  const sheetRows = isXlsx ? parseXlsxRows(fileBuffer) : parseCsvRows(fileBuffer);
  const headers = sheetRows.shift() || [];
  if (!headers.length) throw new Error(`${isXlsx ? 'Excel' : 'CSV'} header row is missing`);
  const normalizedHeaders = headers.map(normalizeOmrHeader);
  validateResultExcelColumns(normalizedHeaders);

  const nonBlankRows = sheetRows.filter(
    (cells) => Array.isArray(cells) && cells.some((cell) => String(cell || '').trim() !== '')
  );

  return nonBlankRows.map((cells, index) => {
    const raw = {};
    normalizedHeaders.forEach((header, cellIndex) => {
      raw[header] = cells[cellIndex] || '';
    });
    return {
      rowNumber: index + 2,
      ...normalizeOmrRow(raw, fallbackMaxMarks),
    };
  });
}

const REQUIRED_BULK_PAPER_EXCEL_COLUMNS = [
  { label: 'Roll Number', aliases: ['Roll Number', 'Roll No'] },
  { label: 'Checked File', aliases: ['Checked File'] },
];

function validateBulkPaperExcelColumns(normalizedHeaders) {
  const headerSet = new Set(normalizedHeaders.filter(Boolean));
  const missing = REQUIRED_BULK_PAPER_EXCEL_COLUMNS.filter(
    (column) => !column.aliases.some((alias) => headerSet.has(normalizeOmrHeader(alias)))
  );
  if (missing.length) {
    throw new Error(`Missing required column(s): ${missing.map((column) => column.label).join(', ')}. Required columns: Student, Roll Number, Paper Code, Physics, Chemistry, Biology, Total Score, Correct, Wrong, Blank, Multi-marked, Checked File.`);
  }
}

// Checked File is read as a raw trimmed string on purpose (never through
// parseOmrNumber) — it must match an uploaded filename exactly.
//
// Roll Number is OCR output and is frequently corrupted with leading '?'
// characters (e.g. "?????775"), or wrapped in label text (e.g. "Roll No:
// ?????91"). The actual roll number is the LAST contiguous run of digits in
// that value — not every digit in the string concatenated together, and
// never the "_0001" / "_0002" sequence number embedded in the uploaded
// filename, which is just a scan index and is never used as a roll number.
// When OCR fails completely (no digits at all, e.g. "????????"), this
// returns '' — callers must treat that as "identity unresolved", never fall
// back to guessing a student from the filename or any other source.
function extractRollNumberDigits(value) {
  // A numeric cell that Excel/pandas rendered as "75.0" is the whole number 75 — without
  // this, the "last digit run" rule below would read the ".0" fraction and yield roll "0".
  const wholeNumber = String(value || '').trim().match(/^(\d+)\.0*$/);
  if (wholeNumber) return wholeNumber[1];
  const digitRuns = String(value || '').match(/\d+/g);
  if (!digitRuns || !digitRuns.length) return '';
  return digitRuns[digitRuns.length - 1];
}

function toBulkPaperExcelRows(fileBuffer) {
  const sheetRows = parseXlsxRows(fileBuffer);
  const headers = sheetRows.shift() || [];
  if (!headers.length) throw new Error('Excel header row is missing');
  const normalizedHeaders = headers.map(normalizeOmrHeader);
  validateBulkPaperExcelColumns(normalizedHeaders);

  const nonBlankRows = sheetRows.filter(
    (cells) => Array.isArray(cells) && cells.some((cell) => String(cell || '').trim() !== '')
  );

  return nonBlankRows.map((cells, index) => {
    const raw = {};
    normalizedHeaders.forEach((header, cellIndex) => {
      raw[header] = cells[cellIndex] !== undefined ? cells[cellIndex] : '';
    });
    const rollNoRaw = getOmrValue(raw, ['Roll Number', 'Roll No']);
    return {
      rowNumber: cells.rowNumber || index + 2,
      studentName: getOmrValue(raw, ['Student']),
      rollNoRaw,
      rollNo: extractRollNumberDigits(rollNoRaw),
      paperCode: getOmrValue(raw, ['Paper Code']),
      checkedFile: getOmrValue(raw, ['Checked File']),
      physicsMarks: parseOmrNumber(getOmrValue(raw, ['Physics'])),
      chemistryMarks: parseOmrNumber(getOmrValue(raw, ['Chemistry'])),
      biologyMarks: parseOmrNumber(getOmrValue(raw, ['Biology'])),
      totalScore: parseOmrNumber(getOmrValue(raw, ['Total Score'])),
      correctCount: parseOmrNumber(getOmrValue(raw, ['Correct'])),
      wrongCount: parseOmrNumber(getOmrValue(raw, ['Wrong'])),
      blankCount: parseOmrNumber(getOmrValue(raw, ['Blank'])),
      multiMarkedCount: parseOmrNumber(getOmrValue(raw, ['Multi-marked', 'Multi Marked', 'MultiMarked'])),
    };
  });
}

function stripLeadingZeros(digits) {
  const stripped = digits.replace(/^0+(?=\d)/, '');
  return stripped || '0';
}

// The single place that decides which student a parsed roll number belongs to, used by
// both the bulk-paper Checked-File import and (as of this fix) tested independently of
// any DB call: callers pass in the already-fetched candidate student list. Roll number
// resolution is the ONLY identity signal used here — never the uploaded filename, never
// any name printed on/OCR'd from the physical answer sheet image itself, since those are
// not what admins map results by. An empty/unreadable rollNo always returns no match:
// there is no fallback that invents a student to attach a result to.
function resolveStudentForRollNumber(rollNo, students) {
  const targetRoll = String(rollNo || '').trim();
  if (!targetRoll) return { student: null, matchType: 'none' };

  // Two students sharing one exact roll number is ambiguous — picking whichever the DB
  // returned first would silently send one student's paper to the other's parent.
  const exactMatches = (students || []).filter((student) => String(student.roll_no || '').trim() === targetRoll);
  if (exactMatches.length > 1) return { student: null, matchType: 'ambiguous' };
  if (exactMatches.length === 1) return { student: exactMatches[0], matchType: 'exact' };

  // Numeric zero-pad fallback: an OCR'd roll like "00075" should still match a stored
  // "75" (or vice versa) — but only when it resolves to exactly one student, so it never
  // silently guesses between two real, differently-padded roll numbers.
  if (/^0*[0-9]+$/.test(targetRoll)) {
    const strippedTarget = stripLeadingZeros(targetRoll);
    const numericMatches = (students || []).filter((student) => {
      const candidateRoll = String(student.roll_no || '').trim();
      if (!/^0*[0-9]+$/.test(candidateRoll)) return false;
      return stripLeadingZeros(candidateRoll) === strippedTarget;
    });
    if (numericMatches.length === 1) return { student: numericMatches[0], matchType: 'numeric_fallback' };
  }

  return { student: null, matchType: 'none' };
}

module.exports = {
  normalizeOmrHeader,
  parseCsvRows,
  readZipEntries,
  decodeXmlText,
  parseSheetXml,
  parseXlsxRows,
  parseOmrNumber,
  getOmrValue,
  normalizeOmrRow,
  REQUIRED_RESULT_EXCEL_COLUMNS,
  validateResultExcelColumns,
  toOmrTableRows,
  REQUIRED_BULK_PAPER_EXCEL_COLUMNS,
  validateBulkPaperExcelColumns,
  extractRollNumberDigits,
  toBulkPaperExcelRows,
  resolveStudentForRollNumber,
};
