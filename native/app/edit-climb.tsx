import { useState } from 'react';
import { View, StyleSheet, ScrollView, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gradesFor, CLIMB_COLORS } from '@gymtrack/core';
import { Title, Subtitle, Body, Button, Chip } from '../components/ui';
import { colors, fonts, radius } from '../theme';
import { updateClimb } from '../lib/climbs';

const DISCIPLINES = ['Bouldering', 'Sport', 'Top Rope', 'Trad'];
const RESULTS = ['Send', 'Flash', 'Project'];
const COLOR_NAMES = Object.keys(CLIMB_COLORS);

export default function EditClimb() {
  const p = useLocalSearchParams<{
    id: string;
    discipline: string;
    grade: string;
    result: string;
    attempts: string;
    color: string;
    notes: string;
    date: string;
  }>();

  const [discipline, setDiscipline] = useState(p.discipline || 'Bouldering');
  const [grade, setGrade] = useState(p.grade || 'V3');
  const [result, setResult] = useState(p.result || 'Send');
  const [attempts, setAttempts] = useState(Math.max(1, parseInt(p.attempts || '1', 10)));
  const [color, setColor] = useState(p.color || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grades = gradesFor(discipline);

  function pickDiscipline(d: string) {
    setDiscipline(d);
    if (!gradesFor(d).includes(grade)) setGrade(d === 'Bouldering' ? 'V3' : '5.10a');
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateClimb(p.id, {
        date: p.date,
        discipline,
        grade,
        attempts: result === 'Flash' ? 1 : attempts,
        result,
        color,
        notes: p.notes || '',
      });
      router.back();
    } catch (e: any) {
      setError(e?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Title>Edit climb</Title>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Body style={{ color: colors.muted }}>Close</Body>
          </Pressable>
        </View>
        <Subtitle style={{ marginTop: 4, marginBottom: 18 }}>{p.date}</Subtitle>

        <Body style={styles.label}>Discipline</Body>
        <View style={styles.row}>
          {DISCIPLINES.map((d) => (
            <Chip key={d} label={d} active={discipline === d} onPress={() => pickDiscipline(d)} />
          ))}
        </View>

        <Body style={styles.label}>Grade</Body>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gradeRow}>
          {grades.map((g) => (
            <Pressable key={g} onPress={() => setGrade(g)} style={[styles.grade, grade === g && styles.gradeActive]}>
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

        <Body style={styles.label}>Hold color</Body>
        <View style={styles.colorRow}>
          <Pressable onPress={() => setColor('')} style={[styles.swatch, styles.swatchNone, color === '' && styles.swatchActive]}>
            <Body style={{ color: colors.muted, fontSize: 11 }}>None</Body>
          </Pressable>
          {COLOR_NAMES.map((name) => (
            <Pressable
              key={name}
              onPress={() => setColor(name)}
              style={[styles.swatch, { backgroundColor: CLIMB_COLORS[name] }, color === name && styles.swatchActive]}
            />
          ))}
        </View>

        {error ? <Body style={{ color: colors.danger, marginTop: 16 }}>{error}</Body> : null}
        <View style={{ height: 24 }} />
        <Button label="Save changes" onPress={save} loading={busy} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingBottom: 60, paddingTop: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: { width: 34, height: 34, borderRadius: 10, borderWidth: 2, borderColor: 'transparent' },
  swatchNone: {
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.border,
    backgroundColor: colors.panel,
    width: 'auto',
    paddingHorizontal: 10,
  },
  swatchActive: { borderColor: colors.ink },
});
