// Social data layer — typed wrappers over the SECURITY DEFINER RPCs (friends,
// feed, leaderboard) plus the profiles identity. Arg names + return shapes mirror
// supabase-schema.sql exactly. All are friends/RLS-scoped server-side.
import { supabase } from './supabase';
import type { FeedItem } from '@gymtrack/core';

export type Me = { username: string | null; display_name: string | null };

export type Friend = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  boulder: number | null;
  rope: number | null;
  last_active: string | null;
};

export type Relationship = 'self' | 'friends' | 'outgoing' | 'incoming' | 'none';

export type FriendRequest = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  direction: 'incoming' | 'outgoing';
  since: string;
};

export type SearchResult = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  relationship: Relationship;
};

export type LbRow = {
  user_id: string;
  display_name: string | null;
  is_me: boolean;
  score: number;
  sessions: number;
  provisional: boolean;
  last_delta: number;
  hardest: string | null;
};

export type UserSummary = {
  display_name: string;
  sessions: number;
  by_grade: { grade: string; result: string; n: number }[];
} | null;

export type ClimbHistoryRow = {
  id: string;
  date: string;
  discipline: string;
  grade: string;
  attempts: number;
  result: string;
};

export type FriendAct = 'request' | 'accept' | 'decline' | 'cancel' | 'unfriend';

async function myUid(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export async function loadFriends(): Promise<{ me: Me | null; list: Friend[]; requests: FriendRequest[] }> {
  const uid = await myUid();
  const [me, list, reqs] = await Promise.all([
    uid
      ? supabase.from('profiles').select('username, display_name').eq('id', uid).maybeSingle()
      : Promise.resolve({ data: null } as any),
    supabase.rpc('friend_list'),
    supabase.rpc('friend_requests'),
  ]);
  return {
    me: (me && (me as any).data) || null,
    list: ((list as any).data as Friend[]) || [],
    requests: ((reqs as any).data as FriendRequest[]) || [],
  };
}

export async function searchFriends(q: string): Promise<SearchResult[]> {
  if (q.trim().length < 2) return [];
  const { data, error } = await supabase.rpc('friend_search', { q: q.trim() });
  if (error) throw error;
  return (data as SearchResult[]) || [];
}

export async function friendAct(fact: FriendAct, uid: string): Promise<void> {
  const call =
    fact === 'request'
      ? supabase.rpc('friend_request', { target: uid })
      : fact === 'accept'
        ? supabase.rpc('friend_respond', { other: uid, accept: true })
        : fact === 'decline'
          ? supabase.rpc('friend_respond', { other: uid, accept: false })
          : fact === 'cancel'
            ? supabase.rpc('friend_cancel', { other: uid })
            : supabase.rpc('unfriend', { other: uid });
  const { error } = await call;
  if (error) throw error;
}

export async function setHandle(handle: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('friend_set_username', { handle, dname: name || null });
  if (error) throw error;
}

export async function setDisplayName(name: string): Promise<void> {
  const { error } = await supabase.rpc('profile_set_display', { dname: name });
  if (error) throw error;
}

export async function loadFeed(lim = 30): Promise<FeedItem[]> {
  const { data, error } = await supabase.rpc('friend_feed', {
    surface: 'all',
    before_ts: null,
    before_id: null,
    lim,
  });
  if (error) throw error;
  return ((data as any[]) || []).map((r) => ({
    ...r,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
  })) as FeedItem[];
}

export async function loadLeaderboard(grp: 'boulder' | 'rope'): Promise<LbRow[]> {
  const { data, error } = await supabase.rpc('climb_send_scores', { grp });
  if (error) throw error;
  return (((data as LbRow[]) || []).slice().sort((a, b) => b.score - a.score)).slice(0, 20);
}

export async function loadUserSummary(uid: string, grp: 'boulder' | 'rope'): Promise<UserSummary> {
  const { data, error } = await supabase.rpc('climb_user_summary', { target: uid, days: 36500, grp });
  if (error) throw error;
  return (data as UserSummary) ?? null;
}

export async function loadUserHistory(uid: string, grp: 'boulder' | 'rope'): Promise<ClimbHistoryRow[]> {
  const { data, error } = await supabase.rpc('climb_user_history', { target: uid, grp });
  if (error) throw error;
  return (data as ClimbHistoryRow[]) || [];
}
