// Deterministic default avatar (colored circle + initial) from @gymtrack/core, so
// it matches the web pixel-for-pixel. Photo upload is a later milestone.
import { View, Text, StyleSheet } from 'react-native';
import { avatarColorFor, avatarInitial } from '@gymtrack/core';
import { fonts } from '../theme';

const SIZES = { sm: 34, md: 44, lg: 56 } as const;

export function Avatar({
  uid,
  name,
  size = 'md',
}: {
  uid: string;
  name?: string | null;
  size?: keyof typeof SIZES;
}) {
  const d = SIZES[size];
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
