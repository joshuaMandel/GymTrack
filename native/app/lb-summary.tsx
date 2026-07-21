import { useEffect, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { summarizePyramid, sessionizeClimbs, fmtDate, type Pyramid, type Climb } from '@gymtrack/core';
import { Title, Subtitle, Body, Card } from '../components/ui';
import { colors, fonts, radius } from '../theme';
import { loadUserSummary, loadUserHistory, type UserSummary } from '../lib/social';

type Grp = 'boulder' | 'rope';
const DISC = (g: Grp) => (g === 'boulder' ? 'Bouldering' : 'Sport');

export default function LbSummary() {
  const p = useLocalSearchParams<{ uid: string; name: string; score: string; grp: Grp }>();
  const grp = (p.grp as Grp) || 'boulder';
  const [summary, setSummary] = useState<UserSummary>(null);
  const [history, setHistory] = useState<Climb[]>([]);
  const [loading, setLoading] = useState(true);
  const [gated, setGated] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await loadUserSummary(p.uid, grp);
        if (!alive) return;
        if (!s) {
          setGated(true);
        } else {
          setSummary(s);
          const h = await loadUserHistory(p.uid, grp);
          if (alive) setHistory(h as unknown as Climb[]);
        }
      } catch {
        if (alive) setGated(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [p.uid, grp]);

  const pyramid: Pyramid | null = summary ? summarizePyramid(summary.by_grade, DISC(grp)) : null;
  const sessions = history.length ? sessionizeClimbs(history, history) : [];

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Title numberOfLines={1}>{p.name}</Title>
          <Subtitle style={{ marginTop: 2 }}>
            {grp === 'boulder' ? 'Bouldering' : 'Roped'} · Send Score {p.score} · all time
          </Subtitle>
        </View>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Body style={{ color: colors.muted }}>Close</Body>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent2} />
        ) : gated ? (
          <Card>
            <Body style={{ fontFamily: fonts.bodyMed, marginBottom: 4 }}>Sessions are friends-only</Body>
            <Body style={{ color: colors.muted }}>Add {p.name} as a friend to see their pyramid and history.</Body>
          </Card>
        ) : (
          <>
            {pyramid && (
              <Card style={{ marginBottom: 14 }}>
                <View style={styles.chipRow}>
                  <PyChip label="Hardest" value={pyramid.hardest || '—'} />
                  <PyChip label="Sends" value={String(pyramid.totalSends)} />
                  {pyramid.totalFlash ? <PyChip label="Flashes" value={String(pyramid.totalFlash)} /> : null}
                  <PyChip label="Sessions" value={String(summary?.sessions ?? 0)} />
                </View>
                <View style={styles.pills}>
                  {pyramid.grades.map((g) => (
                    <View key={g.grade} style={{ flexDirection: 'row', gap: 6 }}>
                      {g.sends ? (
                        <View style={styles.pill}>
                          <Body style={styles.pillText}>
                            {g.grade}
                            {g.sends > 1 ? ` ×${g.sends}` : ''}
                          </Body>
                        </View>
                      ) : null}
                      {g.project ? (
                        <View style={[styles.pill, styles.pillProj]}>
                          <Body style={[styles.pillText, { color: colors.muted }]}>
                            {g.grade} proj{g.project > 1 ? ` ×${g.project}` : ''}
                          </Body>
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              </Card>
            )}

            <Body style={styles.sectionH}>Sessions</Body>
            {sessions.slice(0, 8).map((s) => (
              <Card key={s.date} style={styles.sessCard}>
                <Body style={{ fontFamily: fonts.bodyMed }}>{fmtDate(s.date)}</Body>
                <Body style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>
                  {s.climbs.length} climb{s.climbs.length === 1 ? '' : 's'}
                  {s.hardest ? ` · hardest ${s.hardest}` : ''}
                </Body>
              </Card>
            ))}
            {sessions.length === 0 ? (
              <Card>
                <Body style={{ color: colors.muted }}>No {grp === 'boulder' ? 'boulders' : 'routes'} logged.</Body>
              </Card>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PyChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.pyChip}>
      <Body style={styles.pyLabel}>{label}</Body>
      <Body style={styles.pyValue}>{value}</Body>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 20, paddingTop: 8, gap: 10 },
  body: { paddingHorizontal: 20, paddingVertical: 14, paddingBottom: 44 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  pyChip: { flexDirection: 'row', alignItems: 'baseline', gap: 6, backgroundColor: colors.panel2, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  pyLabel: { color: colors.muted, fontSize: 12 },
  pyValue: { fontFamily: fonts.displaySemi, fontSize: 14, color: colors.text },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: { backgroundColor: colors.accent2Tint, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  pillProj: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  pillText: { fontFamily: fonts.bodyMed, fontSize: 13, color: colors.accent2 },
  sectionH: { fontFamily: fonts.displaySemi, fontSize: 16, color: colors.text, marginBottom: 10 },
  sessCard: { padding: 12, marginBottom: 8 },
});
