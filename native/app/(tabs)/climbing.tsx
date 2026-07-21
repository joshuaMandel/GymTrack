import { useCallback, useState } from 'react';
import { View, StyleSheet, Pressable, RefreshControl, ScrollView, Alert } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  climberRatingFromClimbs,
  sessionizeClimbs,
  hardestSeries,
  sendsSeries,
  isSend,
  gradeRank,
  fmtDate,
  fmtNum,
  daysAgoISO,
  RATING_GROUPS,
  DISC_COLORS,
  ROPE_DISCIPLINES,
  V_GRADES,
  YDS_GRADES,
} from '@gymtrack/core';
import type { Climb, Series } from '@gymtrack/core';
import { Title, Subtitle, Body, Card, Segmented, RouteDot } from '../../components/ui';
import { LineChart } from '../../components/charts';
import { colors, fonts, radius } from '../../theme';
import { fetchMyClimbs, delClimb } from '../../lib/climbs';
import { loadMatches } from '../../lib/matches';
import { useSettings } from '../../lib/settings';

type Metric = 'rating' | 'hardest' | 'sends';
type Range = 'all' | '30' | '60' | '90';

const gradeLabel = (arr: string[]) => (v: number) => arr[Math.round(v)] ?? '';

export default function Climbing() {
  const settings = useSettings();
  const hideRating = !!settings.hide_rating;
  const [climbs, setClimbs] = useState<Climb[]>([]);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<Metric>('rating');
  const [range, setRange] = useState<Range>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adj, setAdj] = useState<{ boulder: number; rope: number }>({ boulder: 0, rope: 0 });

  const load = useCallback(async () => {
    try {
      setClimbs(await fetchMyClimbs());
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
    try {
      setAdj((await loadMatches()).adj);
    } catch {
      /* ignore */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // With the rating hidden, drop the Send Score metric and never default to it.
  const effMetric: Metric = hideRating && metric === 'rating' ? 'hardest' : metric;
  const cutoff = range === 'all' ? null : daysAgoISO(parseInt(range, 10));
  const boulder = climberRatingFromClimbs(climbs, 'boulder', adj);
  const rope = climberRatingFromClimbs(climbs, 'rope', adj);
  const ratings = [
    { def: RATING_GROUPS[0], r: boulder },
    { def: RATING_GROUPS[1], r: rope },
  ];

  const sessions = sessionizeClimbs(climbs, climbs);
  const sends = climbs.filter((c) => isSend(c.result) && (!cutoff || c.date >= cutoff));

  // PR chips
  const hardestBoulder = maxGrade(climbs, 'Bouldering', V_GRADES);
  const hardestRope = ['Sport', 'Top Rope', 'Trad']
    .map((d) => maxGrade(climbs, d, YDS_GRADES))
    .filter(Boolean)
    .sort((a, b) => YDS_GRADES.indexOf(b!) - YDS_GRADES.indexOf(a!))[0];
  const totalSends = climbs.filter((c) => isSend(c.result)).length;

  function confirmDelete(c: Climb) {
    Alert.alert('Delete climb?', `${c.grade} · ${c.result}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await delClimb(c.id);
            load();
          } catch (e: any) {
            Alert.alert('Could not delete', e?.message || 'Try again');
          }
        },
      },
    ]);
  }

  const toggle = (date: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(date) ? next.delete(date) : next.add(date);
      return next;
    });

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent2} />}
      >
        <Title>Progress</Title>
        <Subtitle style={{ marginTop: 4, marginBottom: 16 }}>Your Send Score and climbing history</Subtitle>

        {/* Rating cards (hidden by preference) */}
        {!hideRating && (
        <View style={styles.ratingRow}>
          {ratings.map(({ def, r }) => (
            <Card key={def.key} style={styles.ratingCard}>
              <Body style={styles.ratingLabel}>{def.label} Send Score</Body>
              <View style={styles.ratingValueRow}>
                <Body style={styles.ratingValue}>{r.hasData && r.rating != null ? r.rating : 1000}</Body>
                {r.hasData && r.lastSessionDelta ? (
                  <Body
                    style={[
                      styles.ratingDelta,
                      { color: r.lastSessionDelta > 0 ? colors.good : colors.danger },
                    ]}
                  >
                    {r.lastSessionDelta > 0 ? '▲' : '▼'} {Math.abs(r.lastSessionDelta)}
                  </Body>
                ) : null}
              </View>
              <Body style={styles.ratingSub}>
                {r.hasData
                  ? `${def.scale} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}${r.provisional ? ' · provisional' : ''}`
                  : 'Log a climb to set your rating.'}
              </Body>
            </Card>
          ))}
        </View>
        )}

        {/* Chart controls */}
        <View style={{ marginTop: 20, gap: 10 }}>
          <Segmented<Metric>
            value={effMetric}
            onChange={setMetric}
            options={[
              ...(hideRating ? [] : [{ label: 'Send Score', value: 'rating' as Metric }]),
              { label: 'Hardest', value: 'hardest' },
              { label: 'Sends', value: 'sends' },
            ]}
          />
          <Segmented<Range>
            value={range}
            onChange={setRange}
            options={[
              { label: 'All', value: 'all' },
              { label: '30d', value: '30' },
              { label: '60d', value: '60' },
              { label: '90d', value: '90' },
            ]}
          />
        </View>

        {/* Charts */}
        <Card style={{ marginTop: 12, paddingVertical: 12, paddingHorizontal: 8 }}>
          {effMetric === 'rating' && (
            <LineChart
              series={ratings
                .filter(({ r }) => r.hasData)
                .map(({ def, r }) => ({
                  label: def.label,
                  color: def.color,
                  points: r.history.filter((p) => !cutoff || p.date >= cutoff),
                }))}
              fmt={(v) => fmtNum(Math.round(v))}
            />
          )}
          {effMetric === 'sends' && (
            <LineChart
              series={(['Bouldering', 'Sport', 'Top Rope', 'Trad'] as const)
                .map((d) => ({ ...sendsSeries(d, sends), color: DISC_COLORS[d] }))
                .filter((s) => s.points.length)}
              fmt={(v) => fmtNum(Math.round(v))}
            />
          )}
          {effMetric === 'hardest' && (
            <View style={{ gap: 16 }}>
              <View>
                <Body style={styles.subchartTitle}>Bouldering (V scale)</Body>
                <LineChart series={[{ ...hardestSeries('Bouldering', sends), color: DISC_COLORS.Bouldering }]} fmt={gradeLabel(V_GRADES)} />
              </View>
              <View>
                <Body style={styles.subchartTitle}>Ropes (YDS)</Body>
                <LineChart
                  series={ROPE_DISCIPLINES.map((d) => ({ ...hardestSeries(d, sends), color: DISC_COLORS[d] })).filter((s) => s.points.length)}
                  fmt={gradeLabel(YDS_GRADES)}
                />
              </View>
            </View>
          )}
        </Card>

        {/* PR chips */}
        <View style={styles.prRow}>
          <PrChip label="Hardest boulder" value={hardestBoulder || '—'} />
          <PrChip label="Hardest route" value={hardestRope || '—'} />
          <PrChip label="Total sends" value={String(totalSends)} />
        </View>

        {/* Session history */}
        <Body style={styles.sectionH}>Sessions</Body>
        {sessions.length === 0 && !loading ? (
          <Card>
            <Body style={{ color: colors.muted }}>No climbs yet — log one to start your history.</Body>
          </Card>
        ) : (
          sessions.map((s) => {
            const isOpen = open.has(s.date);
            const chips = (['boulder', 'rope'] as const)
              .filter((g) => s.deltas[g] != null)
              .map((g) => ({ g, v: s.deltas[g] as number }));
            const bothGroups = chips.length > 1;
            return (
              <Card key={s.date} style={styles.sessionCard}>
                <Pressable style={styles.sessRow} onPress={() => toggle(s.date)}>
                  <Body style={styles.chevron}>{isOpen ? '▾' : '▸'}</Body>
                  <View style={{ flex: 1 }}>
                    <Body style={{ fontFamily: fonts.bodyMed }}>{fmtDate(s.date)}</Body>
                    <Body style={{ color: colors.muted, fontSize: 13 }}>
                      {s.climbs.length} climb{s.climbs.length === 1 ? '' : 's'}
                      {s.hardest ? ` · hardest ${s.hardest}` : ''}
                    </Body>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {chips.map(({ g, v }) => (
                      <Body
                        key={g}
                        style={[styles.deltaChip, { color: v > 0 ? colors.good : v < 0 ? colors.danger : colors.muted }]}
                      >
                        {bothGroups ? (g === 'boulder' ? 'B ' : 'R ') : ''}
                        {v > 0 ? '▲' : v < 0 ? '▼' : '·'} {Math.abs(v)}
                      </Body>
                    ))}
                  </View>
                </Pressable>

                {isOpen &&
                  s.climbs.map((c) => {
                    const p = s.pts[c.id];
                    return (
                      <View key={c.id} style={styles.climbRow}>
                        <RouteDot color={c.color} />
                        <Body style={styles.scGrade}>{c.grade}</Body>
                        <View
                          style={[styles.badge, c.result === 'Project' ? styles.badgeProject : styles.badgeSend]}
                        >
                          <Body style={styles.badgeText}>{c.result}</Body>
                        </View>
                        {c.attempts > 1 ? (
                          <Body style={{ color: colors.muted, fontSize: 12 }}>{c.attempts} tries</Body>
                        ) : null}
                        <View style={{ flex: 1 }} />
                        {p ? (
                          <Body style={[styles.scPts, { color: p.pts >= 0 ? colors.good : colors.danger }]}>
                            {p.pts > 0 ? '+' : ''}
                            {p.pts}
                          </Body>
                        ) : null}
                        <Pressable
                          hitSlop={8}
                          onPress={() =>
                            router.push({
                              pathname: '/edit-climb',
                              params: {
                                id: c.id,
                                discipline: c.discipline,
                                grade: c.grade,
                                result: c.result,
                                attempts: String(c.attempts),
                                color: c.color ?? '',
                                notes: c.notes ?? '',
                                date: c.date,
                              },
                            })
                          }
                          style={styles.rowAction}
                        >
                          <Ionicons name="pencil" size={15} color={colors.muted} />
                        </Pressable>
                        <Pressable hitSlop={8} onPress={() => confirmDelete(c)} style={styles.rowAction}>
                          <Ionicons name="trash-outline" size={15} color={colors.muted} />
                        </Pressable>
                      </View>
                    );
                  })}
              </Card>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function maxGrade(climbs: Climb[], discipline: string, scale: string[]): string | null {
  let rk = -1;
  climbs.forEach((c) => {
    if (c.discipline === discipline && isSend(c.result)) {
      const r = gradeRank(discipline, c.grade);
      if (r > rk) rk = r;
    }
  });
  return rk >= 0 ? scale[rk] : null;
}

function PrChip({ label, value }: { label: string; value: string }) {
  return (
    <Card style={styles.prChip}>
      <Body style={styles.prValue}>{value}</Body>
      <Body style={styles.prLabel}>{label}</Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingBottom: 44, paddingTop: 8 },
  ratingRow: { flexDirection: 'row', gap: 10 },
  ratingCard: { flex: 1, padding: 14 },
  ratingLabel: { fontFamily: fonts.bodyMed, fontSize: 12, color: colors.muted },
  ratingValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 },
  ratingValue: { fontFamily: fonts.display, fontSize: 30, color: colors.text },
  ratingDelta: { fontFamily: fonts.bodyMed, fontSize: 13 },
  ratingSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  subchartTitle: { fontFamily: fonts.bodyMed, fontSize: 13, color: colors.muted, marginBottom: 4, paddingLeft: 46 },
  prRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  prChip: { flex: 1, padding: 12, alignItems: 'flex-start' },
  prValue: { fontFamily: fonts.display, fontSize: 18, color: colors.text },
  prLabel: { color: colors.muted, fontSize: 11, marginTop: 2 },
  sectionH: { fontFamily: fonts.displaySemi, fontSize: 16, color: colors.text, marginTop: 24, marginBottom: 10 },
  sessionCard: { padding: 6, marginBottom: 10 },
  sessRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  chevron: { color: colors.muted, fontSize: 14, width: 14 },
  deltaChip: { fontFamily: fonts.bodyMed, fontSize: 13 },
  climbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  scGrade: { fontFamily: fonts.display, fontSize: 15, color: colors.text, minWidth: 40 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeSend: { backgroundColor: colors.goodTint },
  badgeProject: { backgroundColor: colors.accentTint },
  badgeText: { fontFamily: fonts.bodyMed, fontSize: 11, color: colors.text },
  scPts: { fontFamily: fonts.bodyMed, fontSize: 13 },
  rowAction: { padding: 5 },
});
