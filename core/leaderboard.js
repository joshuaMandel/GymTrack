// Leaderboard summary (pyramid) aggregation — the pure half of renderLbSummary
// (app.js:4054). Collapses climb_user_summary's per-(grade,result) `by_grade`
// rows into per-grade buckets, hardest-first. `disc` is a DISCIPLINE for the
// grade scale ('Bouldering' | 'Sport'), not a rating group — the caller maps
// grp 'boulder'|'rope' → 'Bouldering'|'Sport'.
import { gradeRank } from './grades.js';

export function summarizePyramid(byGradeRows, disc) {
  const byGrade = {};
  (byGradeRows || []).forEach((g) => {
    const b = (byGrade[g.grade] = byGrade[g.grade] || { sends: 0, flash: 0, project: 0 });
    if (g.result === 'Project') b.project += g.n;
    else {
      b.sends += g.n;
      // 'Onsight' is retired — legacy rows read as flashes.
      if (g.result === 'Flash' || g.result === 'Onsight') b.flash += g.n;
    }
  });
  const grades = Object.keys(byGrade)
    .sort((a, b) => gradeRank(disc, b) - gradeRank(disc, a))
    .map((grade) => ({ grade, ...byGrade[grade] }));
  const totalSends = grades.reduce((s, g) => s + g.sends, 0);
  const totalFlash = grades.reduce((s, g) => s + g.flash, 0);
  const hardest = (grades.find((g) => g.sends > 0) || {}).grade || null;
  return { grades, totalSends, totalFlash, hardest };
}
