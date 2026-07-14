/* ============================================================================
   GymTrack — Supabase configuration
   ----------------------------------------------------------------------------
   Paste your project's values below. Find them in your Supabase dashboard:
     Project Settings → Data API (and → API Keys)
       • Project URL     → url
       • anon public key → anonKey     (safe to commit — it's a public key,
                                         protected by Row-Level Security)

   Until real values are filled in, the app runs in local-only mode (data is
   saved in this browser, no sync) and the "Sign in to sync" button is hidden.
   ============================================================================ */
window.SUPABASE_CONFIG = {
  url: "https://YOUR-PROJECT.supabase.co",
  anonKey: "YOUR-ANON-PUBLIC-KEY"
};
