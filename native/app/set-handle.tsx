import { useState } from 'react';
import { View, TextInput, StyleSheet, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Title, Subtitle, Body, Button } from '../components/ui';
import { colors, fonts, radius } from '../theme';
import { useAuth } from '../lib/auth';
import { setHandle } from '../lib/social';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

function suggestHandle(email: string): string {
  let base = (email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (base.length < 3) base = (base + 'climber').slice(0, 20);
  return base.slice(0, 20);
}

export default function SetHandle() {
  const { user } = useAuth();
  const params = useLocalSearchParams<{ username?: string; name?: string }>();
  const [handle, setHandleVal] = useState(params.username || suggestHandle(user?.email || ''));
  const [name, setName] = useState(params.name || (user?.email || '').split('@')[0] || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const h = handle.trim().toLowerCase();
    if (!HANDLE_RE.test(h)) {
      setError('Handle must be 3–20 chars: lowercase letters, numbers, or _');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setHandle(h, name.trim());
      router.back();
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(/taken|duplicate|unique|23505/i.test(msg) ? `@${h} is taken — try another.` : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.body}>
        <View style={styles.headerRow}>
          <Title>Your handle</Title>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Body style={{ color: colors.muted }}>Close</Body>
          </Pressable>
        </View>
        <Subtitle style={{ marginTop: 4, marginBottom: 24 }}>
          Friends find you by handle; your name shows on the feed and leaderboard.
        </Subtitle>

        <Body style={styles.label}>Display name</Body>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={colors.mutedSoft}
          autoCapitalize="words"
        />

        <Body style={styles.label}>Handle</Body>
        <View style={styles.handleWrap}>
          <Body style={styles.at}>@</Body>
          <TextInput
            style={styles.handleInput}
            value={handle}
            onChangeText={(t) => setHandleVal(t.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
            placeholder="handle"
            placeholderTextColor={colors.mutedSoft}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={20}
          />
        </View>

        {error ? <Body style={{ color: colors.danger, marginTop: 16 }}>{error}</Body> : null}
        <View style={{ height: 24 }} />
        <Button label="Save" onPress={save} loading={busy} disabled={!handle.trim() || !name.trim()} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontFamily: fonts.bodyMed, color: colors.muted, marginTop: 18, marginBottom: 8, fontSize: 13 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    fontFamily: fonts.body,
    fontSize: 17,
    color: colors.text,
  },
  handleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    borderRadius: radius.sm,
    paddingLeft: 16,
  },
  at: { fontFamily: fonts.body, fontSize: 17, color: colors.muted },
  handleInput: { flex: 1, minHeight: 52, paddingHorizontal: 6, fontFamily: fonts.body, fontSize: 17, color: colors.text },
});
