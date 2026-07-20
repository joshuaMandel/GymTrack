# GymTrack — native app (Expo + React Native)

Milestone 1 of the native rebuild: **email-code sign-in → Home (Send Score +
recent climbs) → log a climb** against the live Supabase backend. It shares the
web app's scoring/grade/format logic via the no-build `@gymtrack/core` package
(`../core`).

## Run it

```bash
cd native
npm install          # uses .npmrc (legacy-peer-deps) for Expo's web deps
npx expo start       # then press 'i' / 'a', or scan the QR with Expo Go
```

On a phone: install **Expo Go**, run `npx expo start`, scan the QR. Sign in with
your email — Supabase emails a 6-digit code; type it in. (Native Google/Apple
sign-in comes in a later milestone.)

## Layout

- `app/` — expo-router screens: `(auth)/sign-in`, `(tabs)/index` (Home),
  `(tabs)/log` (log a climb). `_layout.tsx` loads fonts + provides the auth gate.
- `lib/` — `supabase.ts` (AsyncStorage session), `auth.tsx` (session context),
  `climbs.ts` (fetch/insert, RLS-scoped).
- `components/ui.tsx` — shared primitives. `theme.ts` — brand tokens from the web
  app's `styles.css`.
- `@gymtrack/core` (`../core`) — shared, DOM-free logic (grades, Send Score
  rating math, formatting), verified byte-identical to the web app.

## Store submission

Not wired yet. TestFlight / App Store needs an Apple Developer account and an
EAS (Expo cloud build) login — a later milestone. `npx expo start` / Expo Go is
enough to run it on a device today.
