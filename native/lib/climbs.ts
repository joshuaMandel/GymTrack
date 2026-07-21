// Climb data access. Reads are RLS-scoped to the signed-in user; the insert
// mirrors the web app's write path (app.js:270) — id and user_id come from the
// DB defaults (gen_random_uuid / auth.uid), so we send only the climb fields.
import { supabase } from './supabase';
import { climbRow, fromClimb } from '@gymtrack/core';
import type { Climb } from '@gymtrack/core';

export async function fetchMyClimbs(): Promise<Climb[]> {
  const { data, error } = await supabase
    .from('climbs')
    .select('*')
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(fromClimb);
}

export type NewClimb = {
  date: string;
  discipline: string;
  grade: string;
  attempts: number;
  result: string;
  location?: string;
  notes?: string;
  color?: string;
};

export async function addClimb(entry: NewClimb): Promise<Climb> {
  const { data, error } = await supabase.from('climbs').insert(climbRow(entry)).select().single();
  if (error) throw error;
  return fromClimb(data);
}

export async function updateClimb(id: string, entry: NewClimb): Promise<Climb> {
  const { data, error } = await supabase.from('climbs').update(climbRow(entry)).eq('id', id).select().single();
  if (error) throw error;
  return fromClimb(data);
}

export async function delClimb(id: string): Promise<void> {
  const { error } = await supabase.from('climbs').delete().eq('id', id);
  if (error) throw error;
}
