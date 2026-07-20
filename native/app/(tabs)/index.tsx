import { useCallback, useState } from 'react';
import { View, StyleSheet, Pressable, RefreshControl, ScrollView } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { climberRatingFromClimbs, fmtDateShort, todayISO } from '@gymtrack/core';
import type { Climb } from '@gymtrack/core';
import { Title, Subtitle, Body, Display, Card } from '../../components/ui';
import { colors, fonts, radius } from '../../theme';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { fetchMyClimbs } from '../../lib/climbs';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const { user } = useAuth();
  const [climbs, setClimbs] = useState<Climb[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setClimbs(await fetchMyClimbs());
    } catch (e: any) {
      setError(e?.message || 'Could not load climbs');
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch whenever Home regains focus (e.g. after logging a climb).
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const boulder = climberRatingFromClimbs(climbs, 'boulder');
  const rope = climberRatingFromClimbs(climbs, 'rope');
  const primary = boulder.hasData || !rope.hasData ? boulder : rope;
  const primaryLabel = primary.group === 'boulder' ? 'Bouldering' : 'Roped';

  const name = (user?.email || 'climber').split('@')[0];
  const sends = climbs.filter((c) => c.result !== 'Project').length;
  const today = todayISO();
  const todayCount = climbs.filter((c) => c.date === today).length;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent2} />}
      >
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Title numberOfLines={1}>
              {greeting()}, {name}
            </Title>
            <Subtitle style={{ marginTop: 4 }}>
              {climbs.length} climbs logged{todayCount ? ` · ${todayCount} today` : ''}
            </Subtitle>
          </View>
          <Pressable onPress={() => supabase.auth.signOut()} style={styles.signOut} hitSlop={8}>
            <Body style={{ color: colors.muted, fontSize: 13 }}>Sign out</Body>
          </Pressable>
        </View>

        {/* Send Score hero */}
        <Card style={styles.hero}>
          <Body style={styles.heroKicker}>{primaryLabel.toUpperCase()} · SEND SCORE</Body>
          {primary.hasData && primary.rating != null ? (
            <>
              <Display style={styles.heroNum}>{primary.rating}</Display>
              <Body style={styles.heroSub}>
                {primary.provisional ? 'Provisional' : 'Established'} · {primary.sessions} session
                {primary.sessions === 1 ? '' : 's'}
                {primary.lastSessionDelta ? `  ${primary.lastSessionDelta > 0 ? '▲' : '▼'} ${Math.abs(primary.lastSessionDelta)}` : ''}
              </Body>
            </>
          ) : (
            <>
              <Display style={[styles.heroNum, { color: colors.mutedSoft }]}>—</Display>
              <Body style={styles.heroSub}>Log a climb to start your Send Score.</Body>
            </>
          )}
        </Card>

        {/* Quick stats */}
        <View style={styles.statRow}>
          <Stat label="Total climbs" value={String(climbs.length)} />
          <Stat label="Sends" value={String(sends)} />
          <Stat
            label="Roped"
            value={rope.hasData && rope.rating != null ? String(rope.rating) : '—'}
          />
        </View>

        {/* Recent */}
        <Body style={styles.sectionH}>Recent climbs</Body>
        {error ? (
          <Card>
            <Body style={{ color: colors.danger }}>{error}</Body>
          </Card>
        ) : climbs.length === 0 && !loading ? (
          <Card>
            <Body style={{ color: colors.muted }}>No climbs yet — tap “Log climb” to add your first.</Body>
          </Card>
        ) : (
          <Card style={{ padding: 4 }}>
            {climbs.slice(0, 12).map((c, i) => (
              <View key={c.id} style={[styles.climbRow, i > 0 && styles.climbDivider]}>
                <View style={styles.gradeChip}>
                  <Body style={styles.gradeText}>{c.grade}</Body>
                </View>
                <View style={{ flex: 1 }}>
                  <Body style={{ fontFamily: fonts.bodyMed }}>
                    {c.discipline} · {c.result}
                  </Body>
                  <Body style={{ color: colors.muted, fontSize: 13 }}>
                    {fmtDateShort(c.date)}
                    {c.attempts > 1 ? ` · ${c.attempts} tries` : ''}
                  </Body>
                </View>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card style={styles.stat}>
      <Body style={styles.statValue}>{value}</Body>
      <Body style={styles.statLabel}>{label}</Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 8, marginBottom: 18 },
  signOut: { paddingTop: 6, paddingLeft: 8 },
  hero: { backgroundColor: colors.ink, borderColor: colors.ink, marginBottom: 14 },
  heroKicker: { color: colors.mutedSoft, fontSize: 11, letterSpacing: 1, fontFamily: fonts.bodyMed },
  heroNum: { color: colors.cream, marginTop: 4 },
  heroSub: { color: colors.mutedSoft, marginTop: 2 },
  statRow: { flexDirection: 'row', gap: 10, marginBottom: 22 },
  stat: { flex: 1, padding: 14, alignItems: 'flex-start' },
  statValue: { fontFamily: fonts.display, fontSize: 22, color: colors.text },
  statLabel: { color: colors.muted, fontSize: 12, marginTop: 2 },
  sectionH: { fontFamily: fonts.displaySemi, fontSize: 16, color: colors.text, marginBottom: 10 },
  climbRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  climbDivider: { borderTopWidth: 1, borderTopColor: colors.hairline },
  gradeChip: {
    minWidth: 46,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: radius.row,
    backgroundColor: colors.accent2Tint,
    alignItems: 'center',
  },
  gradeText: { fontFamily: fonts.display, color: colors.accent2, fontSize: 15 },
});
