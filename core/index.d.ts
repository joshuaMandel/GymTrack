// Hand-written types for @gymtrack/core (the runtime is plain ESM JS).

export type Discipline = 'Bouldering' | 'Sport' | 'Top Rope';
export type ClimbResult = 'Send' | 'Flash' | 'Project';
export type RatingGroupKey = 'boulder' | 'rope';

export interface Climb {
  id: string;
  date: string;
  discipline: Discipline | string;
  grade: string;
  attempts: number;
  result: ClimbResult | string;
  location?: string;
  notes?: string;
  color?: string;
  created_at?: string;
}

// --- grades ---
export const V_GRADES: string[];
export const YDS_GRADES: string[];
export function gradesFor(d: string): string[];
export function gradeRank(d: string, g: string): number;
export const V_D: Record<string, number>;
export const YDS_D: Record<string, number>;
export function gradeD(discipline: string, grade: string): number | undefined;

// --- rating ---
export const SS_BASE: number;
export const SS_STEP: number;
export const SS_SPREAD: number;
export const SS_K_PROV: number;
export const SS_K_EST: number;
export const SS_PROV_SESSIONS: number;
export const SS_FLASH_BONUS: number;
export const SS_ROPE_OFFSET: number;
export function ratingGroup(discipline: string): RatingGroupKey;
export function isSend(r: string): boolean;

export const ALL_DISCIPLINES: string[];
export const ROPE_DISCIPLINES: string[];
export interface Series { label: string; color?: string; points: { date: string; value: number }[]; }
export function hardestSeries(discipline: string, sends: Climb[]): Series;
export function sendsSeries(discipline: string, sends: Climb[]): Series;
export function routeRating(discipline: string, grade: string): number;
export function sendExpected(R: number, routeR: number): number;
export function sendMagnitude(discipline: string, grade: string, myRating?: number | null): 1 | 2 | 3;

export interface RatingGroupDef { key: RatingGroupKey; label: string; scale: string; color: string; }
export const RATING_GROUPS: RatingGroupDef[];

export interface ClimbDelta { id: string; group: RatingGroupKey; delta: number; climb: Climb; }
export interface RatingSession {
  date: string; delta: number; end: number; count: number; sends: number;
  climbs: ClimbDelta[]; hardest: string | null;
}
export interface Breakdown {
  group: RatingGroupKey; sessions: RatingSession[]; rating: number | null;
  provisional: boolean; hasData: boolean;
}
export function scoreBreakdown(allClimbs: Climb[], group: RatingGroupKey): Breakdown;

export interface ClimberRating {
  group: RatingGroupKey; rating: number | null; provisional: boolean; sessions: number;
  hasData: boolean; history: { date: string; value: number }[];
  lastSession: RatingSession | null; lastSessionDelta: number;
}
export function climberRatingFromClimbs(climbs: Climb[], group: RatingGroupKey, matchAdj?: Record<string, number>): ClimberRating;

// --- format ---
export function uid(): string;
export function isoOf(d: Date): string;
export function todayISO(): string;
export function daysAgoISO(days: number): string;
export function fmtNum(n: number): string;
export function fmtDate(iso: string): string;
export function fmtDateShort(iso: string): string;
export function fmtRemaining(iso: string): string;
export function ago(iso: string): string;

// --- climbs ---
export function climbRow(c: Partial<Climb>): Record<string, unknown>;
export function fromClimb(r: any): Climb;
export const CLIMB_COLORS: Record<string, string>;
export const DISC_COLORS: Record<string, string>;

// --- sessions ---
export interface ClimbPts { group: RatingGroupKey; pts: number; }
export function climbPoints(allClimbs: Climb[]): Record<string, ClimbPts>;
export interface Session {
  date: string;
  climbs: Climb[];
  deltas: Partial<Record<RatingGroupKey, number>>;
  hardest: string;
  pts: Record<string, ClimbPts>;
}
export function sessionizeClimbs(climbs: Climb[], allClimbs?: Climb[]): Session[];

// --- chart ---
export function niceTicks(lo: number, hi: number, count: number): number[];
export const CHART_COLORS: string[];
export interface ScaledPoint { date: string; value: number; cx: number; cy: number; }
export interface ScaledLine { label: string; color: string | null; pts: ScaledPoint[]; }
export interface LineScale {
  W: number; H: number; padL: number; padR: number; padT: number; padB: number;
  innerW: number; innerH: number; n: number; min: number; max: number;
  dataMin: number; dataMax: number; dates: string[]; ticks: number[];
  labelIdxs: number[]; baselineY: number;
  x: (i: number) => number; y: (v: number) => number; lines: ScaledLine[];
}
export function lineScale(series: Series[], W: number, H?: number): LineScale | null;

// --- avatar ---
export const AVATAR_PALETTE: string[];
export function avatarColorFor(uid: string): string;
export function avatarInitial(name: string): string;

// --- feed ---
export interface FeedPayload {
  opponent?: string; result?: 'won' | 'lost' | 'draw'; delta?: number; group?: string;
  my_score?: number; opp_score?: number; match_id?: string;
  sends?: number; flashes?: number; attempts?: number; hardest?: string;
  hardest_discipline?: string; new_hardest?: boolean;
  sets?: number; volume?: number; exercises?: number; unit?: string; top_exercise?: string;
}
export interface FeedItem {
  id: string; user_id: string; username?: string | null; display_name?: string | null;
  kind: 'climb_session' | 'lift_session' | 'match_result';
  occurred_on?: string; created_at: string; payload: FeedPayload;
}
export interface FeedLine {
  ico: 'bolt' | 'barbell' | 'mountain'; cls: string; main: string; sub: string;
  delta?: number; pr?: boolean;
}
export function feedLine(it: FeedItem): FeedLine;

// --- leaderboard ---
export interface PyramidGrade { grade: string; sends: number; flash: number; project: number; }
export interface Pyramid { grades: PyramidGrade[]; totalSends: number; totalFlash: number; hardest: string | null; }
export function summarizePyramid(
  byGradeRows: { grade: string; result: string; n: number }[],
  disc: string
): Pyramid;

// --- matches ---
export type MatchDiscipline = 'boulder' | 'lead' | 'toprope' | 'agnostic';
export const MATCH_DISCS: Record<MatchDiscipline, string[]>;

export interface MatchLast { grade: string; result: string; points: number; at?: string; }
export interface MatchSide {
  name: string; uid: string; avatar_v?: number; is_bot?: boolean;
  baseline?: number | null; par?: string | null; par_d?: number | null;
  can_log?: boolean; last?: MatchLast | null; elo?: number | null;
  score?: number; counted?: number; ended?: boolean; delta?: number | null;
}
export interface MatchRules {
  discipline: MatchDiscipline | null; best_n: number | null; ranked: boolean; style_label?: string;
}
export interface MatchState {
  id: string; status: 'pending' | 'active' | 'resolved' | 'abandoned' | 'canceled';
  window_start?: string; window_end?: string; i_am: 'challenger' | 'opponent';
  winner?: 'challenger' | 'opponent' | 'draw' | null; group?: string | null;
  practice?: boolean; forfeited_by?: string | null;
  turn?: 'challenger' | 'opponent' | null; rules: MatchRules;
  challenger: MatchSide; opponent: MatchSide;
}
export function matchMySide(s: MatchState): MatchSide;
export function matchTheirSide(s: MatchState): MatchSide;
export function matchPointsFor(state: MatchState | null, discipline: string, grade: string): number | null;
export function matchLastLine(side: MatchSide | null | undefined): string;
