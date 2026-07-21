// Avatar photos. Uploaded photos live in the public `avatars` Storage bucket at
// {uid}/thumb.webp (96px) and {uid}/full.webp (400px); profiles.avatar_v is the
// version (0 = default initials, >0 = photo + cache-buster). A tiny global store
// batches avatars_for lookups so <Avatar> shows photos everywhere with no
// per-screen wiring.
import { useEffect, useReducer } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { decode } from 'base64-arraybuffer';
import { supabase } from './supabase';
import { SUPABASE_URL } from './config';

const AV_THUMB = 96;
const AV_FULL = 400;

// ---- version store ----
const versions = new Map<string, number>();
let pending = new Set<string>();
const subs = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  subs.forEach((f) => f());
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const uids = [...pending];
    pending = new Set();
    if (!uids.length) return;
    try {
      const { data } = await supabase.rpc('avatars_for', { uids });
      (data as { id: string; v: number }[] | null)?.forEach((r) => versions.set(r.id, r.v));
      notify();
    } catch {
      /* ignore */
    }
  }, 120);
}

export function setAvatarVersion(uid: string, v: number) {
  versions.set(uid, v);
  notify();
}

// Subscribe to a uid's photo version (batched lookup on first use).
export function useAvatarVersion(uid?: string): number | undefined {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    if (!uid) return;
    subs.add(force);
    if (!versions.has(uid)) {
      pending.add(uid);
      scheduleFlush();
    }
    return () => {
      subs.delete(force);
    };
  }, [uid]);
  return uid ? versions.get(uid) : undefined;
}

export function avatarUrl(uid: string, which: 'thumb' | 'full', v: number): string {
  return `${SUPABASE_URL}/storage/v1/object/public/avatars/${uid}/${which}.webp?v=${v || 1}`;
}

// ---- upload / remove ----
async function fileToArrayBuffer(uri: string, size: number): Promise<ArrayBuffer> {
  const ctx = ImageManipulator.ImageManipulator.manipulate(uri).resize({ width: size, height: size });
  const rendered = await ctx.renderAsync();
  const out = await rendered.saveAsync({
    compress: size <= AV_THUMB ? 0.8 : 0.7,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  return decode(out.base64 || '');
}

// Returns the new avatar version, or null if the user cancelled the picker.
export async function pickAndUploadAvatar(): Promise<number | null> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  if (res.canceled || !res.assets?.length) return null;
  const uri = res.assets[0].uri;

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error('Not signed in');

  const [thumb, full] = await Promise.all([fileToArrayBuffer(uri, AV_THUMB), fileToArrayBuffer(uri, AV_FULL)]);
  const up1 = await supabase.storage.from('avatars').upload(`${uid}/thumb.webp`, thumb, { upsert: true, contentType: 'image/jpeg' });
  if (up1.error) throw up1.error;
  const up2 = await supabase.storage.from('avatars').upload(`${uid}/full.webp`, full, { upsert: true, contentType: 'image/jpeg' });
  if (up2.error) throw up2.error;

  const { data: nv, error } = await supabase.rpc('avatar_set');
  if (error) throw error;
  const version = (nv as number) || (versions.get(uid) || 0) + 1;
  setAvatarVersion(uid, version);
  return version;
}

export async function removeAvatar(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return;
  await supabase.storage.from('avatars').remove([`${uid}/thumb.webp`, `${uid}/full.webp`]);
  const { error } = await supabase.rpc('avatar_clear');
  if (error) throw error;
  setAvatarVersion(uid, 0);
}
