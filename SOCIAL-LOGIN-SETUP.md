# One-tap sign-in — setup & verification (Google + Apple)

This app now supports **true one-tap sign-in** with Google and Apple, on top of
the existing email code sign-in. The web PWA hands the provider's signed ID
token to Supabase (`signInWithIdToken`), and Supabase (GoTrue) **verifies the
token's signature and audience server-side** before issuing a session — the same
backend that already powers email auth. There is no separate server to run.

The code ships gated on two **public** client IDs in `supabase-config.js`. Until
you fill them in, the buttons stay hidden and email sign-in works exactly as
before. Nothing here is a secret — provider secrets live only in the Supabase
dashboard.

---

## 1. Google (One Tap / "Continue as …")

1. **Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application.**
2. Under **Authorized JavaScript origins**, add your site origin(s):
   - `https://<your-domain>` (your GitHub Pages / custom domain)
   - `http://localhost:PORT` if you test locally
3. Under **Authorized redirect URIs**, add your Supabase callback:
   - `https://<PROJECT-REF>.supabase.co/auth/v1/callback`
4. Copy the **Client ID** (looks like `1234567890-abc.apps.googleusercontent.com`).
5. **Supabase dashboard → Authentication → Providers → Google → enable.** Paste the
   Client ID and Client Secret. In **"Authorized Client IDs"**, add the **same**
   Web Client ID (this is what lets One Tap ID tokens verify).
6. Put the Client ID into `supabase-config.js` → `googleClientId`.

Returning users then get Google's **"Continue as [name]"** One Tap prompt — a
genuine single tap. The rendered "Continue with Google" button is the fallback.

## 2. Apple (Sign in with Apple)

Apple requires this whenever Google is offered in a native iOS app; on web it's
optional but included so both go in together.

1. **Apple Developer → Certificates, Identifiers & Profiles → Identifiers.**
   - Ensure you have an **App ID** with "Sign in with Apple" enabled.
   - Create a **Services ID** (e.g. `com.yoursite.gymtrack.web`). Enable
     "Sign in with Apple", and under **Configure**:
     - **Domains**: `<your-domain>` and `<PROJECT-REF>.supabase.co`
     - **Return URLs**: `https://<PROJECT-REF>.supabase.co/auth/v1/callback`
2. Create a **Sign in with Apple Key** (`.p8`). Note the **Key ID** and your **Team ID**.
3. **Supabase dashboard → Authentication → Providers → Apple → enable.** Enter the
   **Services ID** (as the client id), **Team ID**, **Key ID**, and the **`.p8`**
   contents so Supabase can mint the client secret.
4. Put the **Services ID** into `supabase-config.js` → `appleServicesId`.

## 3. Same-email = one account, and Apple private relay

- In **Supabase → Authentication → Settings**, keep **"Allow linking identities
  with the same email"** enabled. Then Google and Apple with the **same verified
  email** resolve to **one** account automatically — same history, friends, elo.
- Apple's **"Hide My Email"** returns a `@privaterelay.appleid.com` address that
  does **not** match your Google email, so it will **not** auto-link (by design —
  we never silently merge two accounts). To join them, the signed-in user opens
  **Profile → Sign-in methods → Link** and links the other provider explicitly.
  This is safe and reversible.

---

## 4. What's already verified automatically (in `scratchpad/login.mjs`, in CI)

Run `node scratchpad/suite.mjs login`. It drives the real login UI + auth module
with mocked provider SDKs and asserts:

- both branded buttons render (Apple solid-black per guidelines) with the email
  divider still present;
- One Tap `prompt()` fires for returning users;
- **one** tap → signed in → dashboard;
- a **new** user gets the username step **once**, prefilled, and never again;
- the ID token is **exchanged** (not trusted client-side) and the session carries
  a verified identity;
- **cancel** returns to the gate with no error;
- **same email** via Google then Apple = one account, no duplicate;
- Apple **private relay** stays a separate account until an **explicit link**;
- **session persists** across reloads and across providers.

## 5. What you must confirm on a real device (I can't drive real provider sheets)

After filling in the two client IDs and configuring the dashboard, do this pass
on a real phone + desktop browser and tick each box. Count the taps literally.

- [ ] **Returning user, Google:** open logged out → the "Continue as [name]"
      prompt appears → **1 tap** → on the dashboard. (Repeat on desktop.)
- [ ] **Returning user, Apple:** open logged out → tap "Sign in with Apple" →
      Face ID / confirm → on the dashboard. Count the taps.
- [ ] **New user, Google:** fresh Google account → 1 tap starts it → name/email
      returned → account created → single username step → in the app.
- [ ] **New user, Apple:** same, including a first-time consent screen if shown.
- [ ] **Same email, both orders:** sign in Google, sign out, sign in Apple with
      the **same** email → same account + same data. Then the reverse order.
- [ ] **Existing email account links:** an account that previously used the email
      code, then signs in with Google/Apple on that same email → same account,
      all history intact.
- [ ] **Apple private relay:** sign in with Apple using "Hide My Email" → verify
      **no duplicate**; link it from Profile → both now sign into one account.
- [ ] **Cancel, both providers:** dismiss the sheet → back on the login screen,
      no red banner, no crash.
- [ ] **Persistence:** sign in, force-quit, reopen → still signed in. Both
      providers. Log out and back in → still one tap.
- [ ] **Branding/tokens:** buttons match Google/Apple guidelines and the app's
      look on mobile and desktop.
