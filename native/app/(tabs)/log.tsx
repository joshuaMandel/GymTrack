import { useState } from 'react';
import { View, StyleSheet, ScrollView, Pressable } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gradesFor, todayISO } from '@gymtrack/core';
import { Title, Subtitle, Body, Button, Chip } from '../../components/ui';
import { colors, fonts, radius } from '../../theme';
import { addClimb } from '../../lib/climbs';

const DISCIPLINES = ['Bouldering', 'Sport', 'Top Rope'] as const;
const RESULTS = ['Send', 'Flash', 'Project'] as const;

export default function LogClimb() {
  const [discipline, setDiscipline] = useState<string>('Bouldering');
  const [grade, setGrade] = useState<string>('V3');
  const [result, setResult] = useState<string>('Send');
  const [attempts, setAttempts] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grades = gradesFor(discipline);

  function pickDiscipline(d: string) {
    setDiscipline(d);
    // Reset the grade to a sensible default within the new scale.
    setGrade(d === 'Bouldering' ? 'V3' : '5.10a');
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await addClimb({
        date: todayISO(),
        discipline,
        grade,
        attempts: result === 'Flash' ? 1 : attempts,
        result,
      });
      // Back to Home, which refetches on focus and shows the new climb.
      setAttempts(1);
      router.navigate('/(tabs)');
    } catch (e: any) {
      setError(e?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Title>Log a climb</Title>
        <Subtitle style={{ marginTop: 4, marginBottom: 20 }}>Today · {todayISO()}</Subtitle>

        <Body style={styles.label}>Discipline</Body>
        <View style={styles.row}>
          {DISCIPLINES.map((d) => (
            <Chip key={d} label={d} active={discipline === d} onPress={() => pickDiscipline(d)} />
          ))}
        </View>

        <Body style={styles.label}>Grade</Body>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gradeRow}>
          {grades.map((g) => (
            <Pressable
              key={g}
              onPress={() => setGrade(g)}
              style={[styles.grade, grade === g && styles.gradeActive]}
            >
              <Body style={[styles.gradeLabel, grade === g && styles.gradeLabelActive]}>{g}</Body>
            </Pressable>
          ))}
        </ScrollView>

        <Body style={styles.label}>Result</Body>
        <View style={styles.row}>
          {RESULTS.map((r) => (
            <Chip key={r} label={r} active={result === r} onPress={() => setResult(r)} />
          ))}
        </View>

        {result !== 'Flash' && (
          <>
            <Body style={styles.label}>Attempts</Body>
            <View style={styles.stepper}>
              <Pressable style={styles.stepBtn} onPress={() => setAttempts((a) => Math.max(1, a - 1))}>
                <Body style={styles.stepSign}>–</Body>
              </Pressable>
              <Body style={styles.stepVal}>{attempts}</Body>
              <Pressable style={styles.stepBtn} onPress={() => setAttempts((a) => a + 1)}>
                <Body style={styles.stepSign}>+</Body>
              </Pressable>
            </View>
          </>
        )}

        {error ? <Body style={{ color: colors.danger, marginTop: 16 }}>{error}</Body> : null}

        <View style={{ height: 26 }} />
        <Button label={`Log ${grade} ${result}`} onPress={save} loading={busy} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingBottom: 60, paddingTop: 8 },
  label: { fontFamily: fonts.bodyMed, color: colors.muted, marginTop: 22, marginBottom: 10, fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gradeRow: { gap: 8, paddingVertical: 2, paddingRight: 20 },
  grade: {
    minWidth: 54,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    alignItems: 'center',
  },
  gradeActive: { backgroundColor: colors.accent2, borderColor: colors.accent2 },
  gradeLabel: { fontFamily: fonts.display, fontSize: 16, color: colors.text },
  gradeLabelActive: { color: colors.cream },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  stepBtn: {
    width: 48,
    height: 48,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepSign: { fontFamily: fonts.display, fontSize: 22, color: colors.text },
  stepVal: { fontFamily: fonts.display, fontSize: 22, color: colors.text, minWidth: 28, textAlign: 'center' },
});
