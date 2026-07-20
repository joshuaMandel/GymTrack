// Supabase public config — the SAME values as the web app's supabase-config.js.
// The URL and anon (publishable) key are public and protected by Row-Level
// Security; safe to commit. Provider secrets live only in the Supabase dashboard.
export const SUPABASE_URL = 'https://thrxeddfjhbvxnxeokcy.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_tkjgr8WxOXz41eeHApgcyQ_QrjjSfsz';

// Weightlifting is an owner-only surface in the web app (UI gate, not security —
// RLS keeps every account's data private regardless). Mirrored here for later.
export const OWNER_EMAILS = ['jmandelmvp@gmail.com'];
