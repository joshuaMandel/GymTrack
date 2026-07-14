# 🏋️ GymTrack

A simple website for tracking **gym progress** — with **weightlifting** and
**rock climbing** tracked separately. Works offline on one device out of the
box, and can optionally sync across all your devices with a free Supabase
backend.

## Features

- **Dashboard** — totals (lifting sessions, total volume, climbing sessions,
  total sends) plus recent activity for both sports.
- **Weightlifting tracker** — log sets (exercise, weight, sets × reps, lbs/kg,
  notes); automatic **estimated 1-rep max** (Epley); per-exercise progress
  chart; PR chips (top weight, best 1RM, total volume).
- **Rock climbing tracker** — bouldering (V-scale) and roped disciplines
  (Sport / Top Rope / Trad, YDS 5.x); result tracking (Send / Flash / Onsight /
  Project), attempts, location, notes; hardest-grade-over-time chart.
- **Two storage modes:**
  - **Local (default)** — data stays in your browser via `localStorage`. No
    account needed.
  - **Cloud sync (optional)** — sign in with a magic-link email and your data
    lives in Supabase, private to you and synced across every device. Your
    existing local data is offered up for migration on first sign-in.
- **Export / import** your data as JSON, or reset it, anytime.

## Running it

No build step, no dependencies. Open `index.html` in a browser, or serve the
folder:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Cross-device sync setup (Supabase)

Sync is **opt-in** — the app works fully without it. To enable it:

1. **Create a free Supabase project** at [supabase.com](https://supabase.com).
2. **Create the tables.** In your project: **SQL Editor → New query**, paste the
   contents of [`supabase-schema.sql`](./supabase-schema.sql), and **Run**. This
   creates the `lifts` and `climbs` tables with Row-Level Security so each user
   can only ever access their own rows.
3. **Allow the site to redirect back after login.** In **Authentication → URL
   Configuration**:
   - Set **Site URL** to your deployed site, e.g.
     `https://joshuamandel.github.io/GymTrack/`
   - Add that same URL under **Redirect URLs**.
4. **Add your project keys.** In **Project Settings → Data API / API Keys**, copy
   your **Project URL** and **anon public key** into
   [`supabase-config.js`](./supabase-config.js):

   ```js
   window.SUPABASE_CONFIG = {
     url: "https://YOUR-PROJECT.supabase.co",
     anonKey: "YOUR-ANON-PUBLIC-KEY"
   };
   ```

   The anon key is designed to be public — it's safe to commit, because
   Row-Level Security is what actually protects the data.

Once configured, a **"Sign in to sync"** button appears in the header. Sign in
with your email on any device to see the same data.

> Email auth uses Supabase's built-in email sender by default, which is fine for
> personal use. For higher volume, configure a custom SMTP provider in Supabase.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup and layout for all views + login modal |
| `styles.css` | Dark, responsive styling |
| `app.js` | State, storage layer (local + cloud), auth, charts |
| `supabase-config.js` | Your Supabase project URL + anon key |
| `supabase-schema.sql` | Database tables + Row-Level Security policies |
| `.github/workflows/deploy-pages.yml` | GitHub Pages deploy workflow |

## Data model

Each row (local or cloud) looks like:

```json
{
  "lifts": [
    { "date": "2026-07-14", "exercise": "Back Squat",
      "weight": 225, "sets": 3, "reps": 5, "unit": "lbs", "notes": "" }
  ],
  "climbs": [
    { "date": "2026-07-14", "discipline": "Bouldering",
      "grade": "V4", "attempts": 2, "result": "Send",
      "location": "Home gym", "notes": "" }
  ]
}
```

In the cloud, each row additionally carries a `user_id` (set automatically) so
Row-Level Security can scope it to its owner.
