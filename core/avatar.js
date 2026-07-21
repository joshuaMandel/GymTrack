// Deterministic default avatar — a colored circle + initial derived purely from
// the user id, so web and native render pixel-identical defaults with no network
// call. Ported verbatim from app.js:718-724. (Uploaded photos are a later layer.)

export const AVATAR_PALETTE = ['#1f3a5f', '#2e7d5b', '#b4531f', '#6b4ea0', '#a03a5f', '#2f6f8f', '#8a6d1f', '#3f7d6b', '#9a4b3f', '#4a5db0'];

export function avatarColorFor(uid) {
  const s = String(uid || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

export const avatarInitial = (name) => (String(name || '').trim()[0] || '?').toUpperCase();
