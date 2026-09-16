const path = require('path');
const { all } = require('../db');

// Single source of truth for "which test_papers rows count as a valid marked result"
// for a student. Both the admin student-overview route (src/app.js) and the WhatsApp
// PERFORMANCE handler (src/services/parentAssistant.js) call this instead of running
// their own independent queries, so the two can never drift out of sync — a paper only
// shows up in either place once it has a real numeric score out of a real max.
// Intentionally unlimited: a student's full history must appear on the graph, not just
// their most recent papers.
async function getMarkedPapersForStudent(coachingId, branchId, studentId) {
  return all(
    `SELECT id, original_name, upload_date, marks_obtained, max_marks, test_label
     FROM test_papers
     WHERE coaching_id = ? AND branch_id = ? AND student_id = ?
       AND marks_obtained IS NOT NULL AND max_marks IS NOT NULL AND max_marks > 0
     ORDER BY upload_date DESC`,
    [coachingId, branchId, studentId]
  );
}

async function getStudentPerformanceSummary(coachingId, branchId, studentId) {
  const markedPapers = await getMarkedPapersForStudent(coachingId, branchId, studentId);
  return buildProgressSummaryFromPapers(markedPapers);
}

function buildProgressSummaryFromPapers(papers) {
  const normalizedPapers = (papers || [])
    .map((paper) => ({
      ...paper,
      marks_obtained: paper.marks_obtained ?? paper.obtained_marks,
      max_marks: paper.max_marks ?? paper.total_marks,
    }));
  const markedPapers = normalizedPapers
    .filter((paper) => Number.isFinite(Number(paper.marks_obtained)) && Number.isFinite(Number(paper.max_marks)) && Number(paper.max_marks) > 0)
    .slice()
    .reverse();

  const totalMarksObtained = markedPapers.reduce((sum, paper) => sum + Number(paper.marks_obtained || 0), 0);
  const totalMaxMarks = markedPapers.reduce((sum, paper) => sum + Number(paper.max_marks || 0), 0);
  const marksPercent = totalMaxMarks
    ? ((totalMarksObtained / totalMaxMarks) * 100).toFixed(2)
    : '0.00';

  const graphPapers = markedPapers.length ? markedPapers : normalizedPapers.slice().reverse();
  const progressSeries = graphPapers.map((paper, index) => {
    const marks = Number(paper.marks_obtained || 0);
    const max = Number(paper.max_marks || 0);
    return {
      label: paper.test_label || path.parse(paper.original_name || 'Test').name,
      marks,
      max,
      percent: max > 0 ? Number(((marks / max) * 100).toFixed(1)) : 0,
      testNo: index + 1,
    };
  });

  return {
    markedPapers,
    progressSeries,
    marksSummary: {
      testsCount: markedPapers.length,
      papersCount: normalizedPapers.length,
      totalMarksObtained,
      totalMaxMarks,
      marksPercent,
    },
  };
}

module.exports = {
  buildProgressSummaryFromPapers,
  getMarkedPapersForStudent,
  getStudentPerformanceSummary,
};
