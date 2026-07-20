// GymTrack design tokens, ported from styles.css :root. Kept in sync by hand
// (the web app is the source of truth for brand values).

export const colors = {
  bg: '#f3efe6', // warm cream page bg
  bgElevated: '#fffdf9',
  panel: '#fffdf9', // cards
  panel2: '#f6f1e5', // inner rows
  border: '#e7dfcd',
  hairline: '#efe9db',
  text: '#16181d',
  muted: '#5a5442',
  mutedSoft: '#8a8472',
  accent: '#f59e2c', // lifting orange
  accentText: '#b9741f',
  accentTint: '#fdf3e0',
  accent2: '#1f3a5f', // climbing navy
  accent2Tint: '#e9eef5',
  good: '#3a7d44',
  goodTint: '#e3efe3',
  danger: '#c0392b',
  ink: '#16181d', // dark pill / hero
  cream: '#fdf8ef', // text/icon on ink
} as const;

export const radius = {
  card: 22,
  sm: 18,
  row: 14,
  pill: 999,
} as const;

export const fonts = {
  // Display = Space Grotesk; body = Archivo. Loaded in the root layout.
  display: 'SpaceGrotesk_700Bold',
  displaySemi: 'SpaceGrotesk_600SemiBold',
  body: 'Archivo_400Regular',
  bodyMed: 'Archivo_600SemiBold',
} as const;

export const space = (n: number) => n * 4;
