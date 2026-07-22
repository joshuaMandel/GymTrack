// Supabase public config — the SAME values as the web app's supabase-config.js.
// The URL and anon (publishable) key are public and protected by Row-Level
// Security; safe to commit. Provider secrets live only in the Supabase dashboard.
export const SUPABASE_URL = 'https://thrxeddfjhbvxnxeokcy.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_tkjgr8WxOXz41eeHApgcyQ_QrjjSfsz';

// Weightlifting is an owner-only surface in the web app (UI gate, not security —
// RLS keeps every account's data private regardless). Mirrored here for later.
export const OWNER_EMAILS = ['jmandelmvp@gmail.com'];

// Native social sign-in, placeholder-gated exactly like the web app's socialCfg
// (app.js:4752). A provider's button only renders when its config is real — leave
// these blank/`YOUR-…` to hide it. Native Google/Apple only run in a dev/EAS
// build (not Expo web, not the web export). Before enabling:
//   • Google — create an iOS OAuth client (iosClientId) + a Web client
//     (serverClientId) in Google Cloud, and enable the Google provider in the
//     Supabase dashboard.
//   • Apple — enable Sign in with Apple for the App ID and configure the Apple
//     provider (Services ID) in the Supabase dashboard. No client ID is needed
//     on-device; flip APPLE_ENABLED to true once the provider is configured.
export const GOOGLE_IOS_CLIENT_ID = '';
export const GOOGLE_WEB_CLIENT_ID = '';
export const APPLE_ENABLED = false;

// A config value is "real" (not a blank/placeholder) — used to gate each button.
export const isConfigured = (v: string) => !!v && !/YOUR-/i.test(v);
