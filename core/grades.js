// Grade systems — ported verbatim from the web app (app.js:17-28, 1257-1260).
// Pure data + index math, no DOM. The single source of truth for both clients.

export const V_GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16', 'V17'];
export const YDS_GRADES = [
  '5.5', '5.6', '5.7', '5.8', '5.9',
  '5.10a', '5.10b', '5.10c', '5.10d',
  '5.11a', '5.11b', '5.11c', '5.11d',
  '5.12a', '5.12b', '5.12c', '5.12d',
  '5.13a', '5.13b', '5.13c', '5.13d',
  '5.14a', '5.14b', '5.14c', '5.14d',
  '5.15a', '5.15b', '5.15c', '5.15d'
];

export const gradesFor = (d) => (d === 'Bouldering' ? V_GRADES : YDS_GRADES);
export const gradeRank = (d, g) => gradesFor(d).indexOf(g); // higher = harder

// Grade → difficulty index D (V-scale units; 5.10c ≈ V0 ≈ D0).
export const V_D = {}; V_GRADES.forEach((g, i) => { V_D[g] = i - 1; }); // VB=-1, V0=0 … V17=17
const YDS_D_LIST = [-4, -3.5, -3, -2.5, -2, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.7, 4.3, 5, 6, 6.7, 7.3, 8, 9, 9.7, 10.3, 11, 12, 13, 14, 15];
export const YDS_D = {}; YDS_GRADES.forEach((g, i) => { YDS_D[g] = YDS_D_LIST[i]; });
export const gradeD = (discipline, grade) => (discipline === 'Bouldering' ? V_D[grade] : YDS_D[grade]);
