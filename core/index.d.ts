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
export function routeRating(discipline: string, grade: string): number;
export function sendExpected(R: number, routeR: number): number;

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
export function fmtNum(n: number): string;
export function fmtDate(iso: string): string;
export function fmtDateShort(iso: string): string;
export function ago(iso: string): string;

// --- climbs ---
export function climbRow(c: Partial<Climb>): Record<string, unknown>;
export function fromClimb(r: any): Climb;
