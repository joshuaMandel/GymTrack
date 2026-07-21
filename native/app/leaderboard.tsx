import { useCallback, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { router, useFocusEffect, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Card, Segmented } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { colors, fonts, radius } from '../theme';
import { loadLeaderboard, type LbRow } from '../lib/social';

type Grp = 'boulder' | 'rope';

export default function Leaderboard() {
  const [grp, setGrp] = useState<Grp>('boulder');
  const [rows, setRows] = useState<LbRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (g: Grp) => {
    setLoading(true);
    try {
      setRows(await loadLeaderboard(g));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(grp);
    }, [load, grp])
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Stack.Screen options={{ title: 'Leaderboard', headerShown: true, headerBackTitle: 'Back' }} />
      <View style={styles.controls}>
        <Segmented<Grp>
          value={grp}
          onChange={setGrp}
          options={[
            { label: 'Bouldering', value: 'boulder' },
            { label: 'Roped', value: 'rope' },
          ]}
        />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {loading && rows.length === 0 ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent2} />
        ) : rows.length === 0 ? (
          <Card>
            <Body style={{ color: colors.muted }}>No rankings yet.</Body>
          </Card>
        ) : (
          <Card style={{ padding: 4 }}>
            {rows.map((r, i) => {
              const rank = i + 1;
              return (
                <Pressable
                  key={r.user_id}
                  style={[styles.row, i > 0 && styles.divider]}
                  onPress={() =>
                    router.push({
                      pathname: '/lb-summary',
                      params: { uid: r.user_id, name: r.display_name || 'Climber', score: String(r.score), grp },
                    })
                  }
                >
                  <Body style={[styles.rank, rank <= 3 && styles.rankTop]}>{rank}</Body>
                  <Avatar uid={r.user_id} name={r.display_name} size="sm" />
                  <View style={{ flex: 1 }}>
                    <Body style={{ fontFamily: fonts.bodyMed }}>
                      {r.display_name || 'Climber'}
                      {r.is_me ? <Body style={styles.youChip}>{'  You'}</Body> : null}
                    </Body>
                    <Body style={{ color: colors.muted, fontSize: 12 }}>
                      {r.sessions} session{r.sessions === 1 ? '' : 's'}
                      {r.hardest ? ` · hardest ${r.hardest}` : ''}
                      {r.provisional ? ' · provisional' : ''}
                    </Body>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Body style={styles.score}>{r.score}</Body>
                    {r.last_delta ? (
                      <Body style={{ color: r.last_delta > 0 ? colors.good : colors.danger, fontSize: 12 }}>
                        {r.last_delta > 0 ? '▲' : '▼'} {Math.abs(r.last_delta)}
                      </Body>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  controls: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  body: { paddingHorizontal: 20, paddingVertical: 12, paddingBottom: 44 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.hairline },
  rank: { fontFamily: fonts.display, fontSize: 15, color: colors.mutedSoft, minWidth: 22, textAlign: 'center' },
  rankTop: { color: colors.accent },
  youChip: { color: colors.accent2, fontSize: 12, fontFamily: fonts.bodyMed },
  score: { fontFamily: fonts.display, fontSize: 18, color: colors.text },
});
