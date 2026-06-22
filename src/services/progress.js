const path = require('path');

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
};
