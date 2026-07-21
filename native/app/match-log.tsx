import { useEffect, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gradesFor, todayISO, MATCH_DISCS, matchPointsFor, matchMySide, sendMagnitude, type MatchState } from '@gymtrack/core';
import { Title, Subtitle, Body, Button, Chip } from '../components/ui';
import { colors, fonts, radius } from '../theme';
import { addClimb } from '../lib/climbs';
import { matchState } from '../lib/matches';
import { playMatchAnim } from '../lib/matchAnim';

const RESULTS = ['Send', 'Flash', 'Project'] as const;

export default function MatchLog() {
  const { mid } = useLocalSearchParams<{ mid: string }>();
  const [state, setState] = useState<MatchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [discipline, setDiscipline] = useState<string>('Bouldering');
  const [grade, setGrade] = useState<string>('V3');
  const [result, setResult] = useState<string>('Send');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    matchState(mid)
      .then((s) => {
        setState(s);
        const discs = (s && s.rules.discipline && MATCH_DISCS[s.rules.discipline]) || ['Bouldering'];
        setDiscipline(discs[0]);
        setGrade(discs[0] === 'Bouldering' ? 'V3' : '5.10a');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [mid]);

  const allowed = (state && state.rules.discipline && MATCH_DISCS[state.rules.discipline]) || ['Bouldering'];
  const grades = gradesFor(discipline);
  const myTurn = state ? matchMySide(state).can_log === true : true;
  const pts = state && result !== 'Project' ? matchPointsFor(state, discipline, grade) : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await addClimb({ date: todayISO(), discipline, grade, attempts: 1, result });
      // Fire the send/fail moment when this climb counts (your turn).
      if (myTurn && state) {
        playMatchAnim({
          type: result === 'Project' ? 'fail' : 'send',
          grade,
          discipline,
          magnitude: sendMagnitude(discipline, grade, matchMySide(state).elo ?? null),
        });
      }
      router.back(); // h2h behind picks it up on next poll
    } catch (e: any) {
      setError(e?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]} edges={['top']}>
        <ActivityIndicator color={colors.accent2} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Title>Log in match</Title>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Body style={{ color: colors.muted }}>Close</Body>
          </Pressable>
        </View>
        <Subtitle style={{ marginTop: 4, marginBottom: 16 }}>
          {myTurn ? 'Your turn — this counts toward the match.' : 'Not your turn — this logs as a normal climb.'}
        </Subtitle>

        {allowed.length > 1 && (
          <>
            <Body style={styles.label}>Discipline</Body>
            <View style={styles.row}>
              {allowed.map((d) => (
                <Chip
                  key={d}
                  label={d}
                  active={discipline === d}
                  onPress={() => {
                    setDiscipline(d);
                    setGrade(d === 'Bouldering' ? 'V3' : '5.10a');
                  }}
                />
              ))}
            </View>
          </>
        )}

        <Body style={styles.label}>Grade</Body>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gradeRow}>
          {grades.map((g) => {
            const gp = state && result !== 'Project' ? matchPointsFor(state, discipline, g) : null;
            const active = grade === g;
            return (
              <Pressable key={g} onPress={() => setGrade(g)} style={[styles.grade, active && styles.gradeActive]}>
                <Body style={[styles.gradeLabel, active && styles.gradeLabelActive]}>{g}</Body>
                {gp != null ? (
                  <Body style={[styles.gradePts, active && { color: colors.cream }]}>+{gp}</Body>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>

        <Body style={styles.label}>Result</Body>
        <View style={styles.row}>
          {RESULTS.map((r) => (
            <Chip key={r} label={r} active={result === r} onPress={() => setResult(r)} />
          ))}
        </View>

        {pts != null && myTurn ? (
          <View style={styles.ptsNote}>
            <Body style={{ color: colors.accent2, fontFamily: fonts.bodyMed }}>
              Worth +{pts} {pts === 1 ? 'point' : 'points'} in this match
            </Body>
          </View>
        ) : null}

        {error ? <Body style={{ color: colors.danger, marginTop: 14 }}>{error}</Body> : null}
        <View style={{ height: 22 }} />
        <Button label={`Log ${grade} ${result}`} onPress={save} loading={busy} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingBottom: 60, paddingTop: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontFamily: fonts.bodyMed, color: colors.muted, marginTop: 20, marginBottom: 10, fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gradeRow: { gap: 8, paddingVertical: 2, paddingRight: 20 },
  grade: {
    minWidth: 56,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    alignItems: 'center',
  },
  gradeActive: { backgroundColor: colors.accent2, borderColor: colors.accent2 },
  gradeLabel: { fontFamily: fonts.display, fontSize: 16, color: colors.text },
  gradeLabelActive: { color: colors.cream },
  gradePts: { fontFamily: fonts.bodyMed, fontSize: 11, color: colors.accentText, marginTop: 2 },
  ptsNote: { marginTop: 16, padding: 12, borderRadius: radius.sm, backgroundColor: colors.accent2Tint },
});
