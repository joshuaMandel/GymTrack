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

   ----------------------------------------------------------------------------
   ONE-TAP SOCIAL SIGN-IN (Google + Apple) — optional, safe to commit
   ----------------------------------------------------------------------------
   These are PUBLIC client identifiers (never secrets). The provider secrets
   live only in the Supabase dashboard (Authentication → Providers). Leave a
   value blank/placeholder and its button simply doesn't show — email sign-in
   keeps working. Full setup steps are in SOCIAL-LOGIN-SETUP.md.

     • googleClientId  → Google Cloud → Credentials → OAuth 2.0 Client ID of
                         type "Web application". Add this SAME id in Supabase
                         (Auth → Providers → Google → "Authorized Client IDs")
                         so One Tap tokens verify. Looks like:
                         "1234567890-abc123.apps.googleusercontent.com"
     • appleServicesId → Apple Developer → Identifiers → Services ID (its
                         identifier, e.g. "com.yoursite.gymtrack.web"). The
                         Apple key/secret are configured in Supabase, not here.
   ============================================================================ */
window.SUPABASE_CONFIG = {
  url: "https://thrxeddfjhbvxnxeokcy.supabase.co",
  anonKey: "sb_publishable_tkjgr8WxOXz41eeHApgcyQ_QrjjSfsz",

  // Public client IDs for one-tap social sign-in. Blank = button hidden.
  googleClientId: "YOUR-GOOGLE-WEB-CLIENT-ID.apps.googleusercontent.com",
  appleServicesId: "YOUR-APPLE-SERVICES-ID"
};
