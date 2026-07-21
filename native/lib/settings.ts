// User settings — stored on the account in Supabase user_metadata, so they
// follow the climber across devices (mirrors the web app's saveSettings,
// app.js:4587). Signed-in-only on native; there's no local-mode fallback.
// updateUser fires a USER_UPDATED auth event, so anything reading useSettings()
// (via useAuth) re-renders automatically after a save.
import { useAuth } from './auth';
import { supabase } from './supabase';

export type Settings = {
  display_name?: string;
  hide_rating?: boolean;
  weekly_goal?: number;
  avatar_color?: string;
};

export function useSettings(): Settings {
  const { user } = useAuth();
  return (user?.user_metadata ?? {}) as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const { error } = await supabase.auth.updateUser({ data: patch });
  if (error) throw error;
}
