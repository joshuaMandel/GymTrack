// Small shared primitives so screens stay declarative and on-brand.
import React from 'react';
import {
  Text,
  TextProps,
  View,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { SafeAreaView, Edge } from 'react-native-safe-area-context';
import { colors, fonts, radius } from '../theme';

export function Screen({
  children,
  scroll,
  edges = ['top'],
}: {
  children: React.ReactNode;
  scroll?: boolean;
  edges?: Edge[];
}) {
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollBody} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={styles.body}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Title(props: TextProps) {
  return <Text {...props} style={[styles.title, props.style]} />;
}
export function Subtitle(props: TextProps) {
  return <Text {...props} style={[styles.subtitle, props.style]} />;
}
export function Body(props: TextProps) {
  return <Text {...props} style={[styles.bodyText, props.style]} />;
}
export function Display(props: TextProps) {
  return <Text {...props} style={[styles.display, props.style]} />;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
}) {
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        isPrimary ? styles.btnPrimary : styles.btnGhost,
        (disabled || loading) && styles.btnDisabled,
        pressed && !disabled && { opacity: 0.85 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? colors.cream : colors.accent2} />
      ) : (
        <Text style={[styles.btnLabel, isPrimary ? styles.btnLabelPrimary : styles.btnLabelGhost]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.85 }]}
    >
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, paddingHorizontal: 20 },
  scrollBody: { paddingHorizontal: 20, paddingBottom: 40 },
  title: { fontFamily: fonts.display, fontSize: 26, color: colors.text, letterSpacing: -0.4 },
  subtitle: { fontFamily: fonts.body, fontSize: 14, color: colors.muted },
  bodyText: { fontFamily: fonts.body, fontSize: 15, color: colors.text },
  display: { fontFamily: fonts.display, fontSize: 44, color: colors.text, letterSpacing: -1 },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: 18,
  },
  btn: { minHeight: 52, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  btnPrimary: { backgroundColor: colors.accent2 },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  btnDisabled: { opacity: 0.5 },
  btnLabel: { fontFamily: fonts.bodyMed, fontSize: 16 },
  btnLabelPrimary: { color: colors.cream },
  btnLabelGhost: { color: colors.text },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipLabel: { fontFamily: fonts.bodyMed, fontSize: 14, color: colors.text },
  chipLabelActive: { color: colors.cream },
});
