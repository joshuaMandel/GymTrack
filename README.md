# 🏋️ GymTrack

A simple, self-contained website for tracking **gym progress** — with
**weightlifting** and **rock climbing** tracked separately.

> This repository previously held a budget tracker. That was cleared out and
> replaced with GymTrack per the project's new purpose.

## Features

- **Dashboard** — at-a-glance totals: lifting sessions, total volume moved,
  climbing sessions, total sends, plus recent activity for both.
- **Weightlifting tracker**
  - Log sets: exercise, weight, sets × reps, units (lbs/kg), notes.
  - Automatic **estimated 1-rep max** (Epley formula) per set.
  - Progress chart of your best est. 1RM over time, per exercise.
  - Personal-record chips: top weight, best 1RM, total volume.
- **Rock climbing tracker**
  - Log climbs across **Bouldering** (V-scale) and **roped** disciplines —
    Sport, Top Rope, Trad (YDS 5.x scale).
  - Track result (Send / Flash / Onsight / Project), attempts, location, notes.
  - Progress chart of the hardest grade sent over time, per discipline.
  - PR chips: hardest grade, total sends, flashes/onsights.
- **Your data stays local** — everything is saved in your browser via
  `localStorage`. Export/import as JSON, or reset anytime.

## Running it

No build step, no dependencies. Either:

- Open `index.html` directly in a browser, or
- Serve the folder, e.g.:

  ```bash
  python3 -m http.server 8000
  # then visit http://localhost:8000
  ```

## Deploying

It's a static site, so it works on any static host:

- **GitHub Pages** — enable Pages for the repo (serve from the branch root).
- **Vercel / Netlify** — point it at the repo; no framework preset needed.

## Files

| File         | Purpose                                        |
|--------------|------------------------------------------------|
| `index.html` | Markup and layout for all three views          |
| `styles.css` | Styling (dark theme, responsive)               |
| `app.js`     | State, localStorage, charts, and interactions  |

## Data model

Data is stored under the `gymtrack.v1` localStorage key:

```json
{
  "lifts": [
    { "id": "...", "date": "2026-07-14", "exercise": "Back Squat",
      "weight": 225, "sets": 3, "reps": 5, "unit": "lbs", "notes": "" }
  ],
  "climbs": [
    { "id": "...", "date": "2026-07-14", "discipline": "Bouldering",
      "grade": "V4", "attempts": 2, "result": "Send",
      "location": "Home gym", "notes": "" }
  ]
}
```
