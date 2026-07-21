// Avatar: a colored default (initial from @gymtrack/core, matching the web
// pixel-for-pixel) that upgrades to the uploaded photo whenever the uid has a
// non-zero version. Version resolves automatically via the global store
// (useAvatarVersion) — pass `v` to render a known version without a lookup.
import { View, Text, Image, StyleSheet } from 'react-native';
import { avatarColorFor, avatarInitial } from '@gymtrack/core';
import { useAvatarVersion, avatarUrl } from '../lib/avatars';
import { fonts } from '../theme';

const SIZES = { sm: 34, md: 44, lg: 56, xl: 96 } as const;

export function Avatar({
  uid,
  name,
  size = 'md',
  v,
}: {
  uid: string;
  name?: string | null;
  size?: keyof typeof SIZES;
  v?: number;
}) {
  const d = SIZES[size];
  const resolved = useAvatarVersion(uid);
  const ver = v ?? resolved ?? 0;

  if (ver > 0) {
    const which = d >= SIZES.lg ? 'full' : 'thumb';
    return (
      <Image
        source={{ uri: avatarUrl(uid, which, ver) }}
        style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: avatarColorFor(uid) }}
      />
    );
  }

  return (
    <View
      style={[
        styles.circle,
        { width: d, height: d, borderRadius: d / 2, backgroundColor: avatarColorFor(uid) },
      ]}
    >
      <Text style={[styles.initial, { fontSize: d * 0.42 }]}>{avatarInitial(name || '')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  initial: { color: '#fff', fontFamily: fonts.displaySemi },
});
