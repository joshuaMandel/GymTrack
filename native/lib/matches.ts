// Match data layer — typed wrappers over the SECURITY DEFINER match RPCs. Scoring
// is server-side (match_play); the client only reads match_state and writes normal
// climbs rows. Arg names + shapes mirror supabase-schema.sql.
import { supabase } from './supabase';
import type { MatchState } from '@gymtrack/core';

export type { MatchState } from '@gymtrack/core';

export type MatchListRow = {
  id: string;
  status: 'pending' | 'active' | 'declined' | 'canceled' | 'resolved' | 'abandoned';
  i_am: 'challenger' | 'opponent';
  opponent: string;
  opponent_name: string | null;
  winner: 'challenger' | 'opponent' | 'draw' | null;
  my_delta: number | null;
  my_score: number | null;
  opp_score: number | null;
  discipline: string | null;
  best_n: number | null;
  ranked: boolean;
  rules_label: string | null;
  created_at: string;
};

export type MatchDiscipline = 'boulder' | 'lead' | 'toprope' | 'agnostic';
export type Ruleset = { discipline: MatchDiscipline; best_n: number; ranked: boolean };

export type MatchAdj = { boulder: number; rope: number };

export type Matches = {
  active: MatchListRow | null;
  incoming: MatchListRow[];
  outgoing: MatchListRow[];
  history: MatchListRow[];
  adj: MatchAdj;
};

export async function loadMatches(): Promise<Matches> {
  const [list, adj] = await Promise.all([supabase.rpc('match_list'), supabase.rpc('match_my_adjustments')]);
  const rows = ((list as any).data as MatchListRow[]) || [];
  const a = ((adj as any).data as MatchAdj) || { boulder: 0, rope: 0 };
  return {
    active: rows.find((r) => r.status === 'active') || null,
    incoming: rows.filter((r) => r.status === 'pending' && r.i_am === 'opponent'),
    outgoing: rows.filter((r) => r.status === 'pending' && r.i_am === 'challenger'),
    history: rows.filter((r) => r.status === 'resolved' || r.status === 'abandoned').slice(0, 8),
    adj: { boulder: a.boulder || 0, rope: a.rope || 0 },
  };
}

export async function matchState(mid: string): Promise<MatchState | null> {
  const { data, error } = await supabase.rpc('match_state', { mid });
  if (error) throw error;
  return (data as MatchState) ?? null;
}

export async function challenge(friend: string, r: Ruleset): Promise<string> {
  const { data, error } = await supabase.rpc('match_challenge', {
    friend,
    discipline: r.discipline,
    best_n: r.best_n,
    ranked: r.ranked,
  });
  if (error) throw error;
  return data as string; // new match id
}

export async function practice(r: Ruleset): Promise<string> {
  const { data, error } = await supabase.rpc('match_practice', {
    discipline: r.discipline,
    best_n: r.best_n,
    ranked: r.ranked,
  });
  if (error) throw error;
  return data as string;
}

export async function respond(mid: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('match_respond', { mid, accept });
  if (error) throw error;
}

export async function cancel(mid: string): Promise<void> {
  const { error } = await supabase.rpc('match_cancel', { mid });
  if (error) throw error;
}

export async function forfeit(mid: string): Promise<void> {
  const { error } = await supabase.rpc('match_forfeit', { mid });
  if (error) throw error;
}

export async function botMove(mid: string): Promise<MatchState | null> {
  const { data, error } = await supabase.rpc('match_bot_move', { mid });
  if (error) throw error;
  return (data as MatchState) ?? null;
}
