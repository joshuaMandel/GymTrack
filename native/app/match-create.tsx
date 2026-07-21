import { useEffect, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Title, Subtitle, Body, Button, Chip, Segmented } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { colors, fonts, radius } from '../theme';
import { loadFriends, type Friend } from '../lib/social';
import { challenge, practice, type MatchDiscipline } from '../lib/matches';

type DiscPick = 'boulder' | 'routes';
type Style = 'lead' | 'toprope' | 'agnostic';

const DISC_NOUN: Record<MatchDiscipline, string> = {
  boulder: 'boulder problems',
  lead: 'lead routes',
  toprope: 'top-rope routes',
  agnostic: 'routes (lead or TR)',
};

export default function MatchCreate() {
  const params = useLocalSearchParams<{ practice?: string; friendUid?: string; friendName?: string }>();
  const isPractice = params.practice === '1';

  const [friends, setFriends] = useState<Friend[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(!isPractice);
  const [target, setTarget] = useState<{ uid: string; name: string } | null>(
    params.friendUid ? { uid: params.friendUid, name: params.friendName || 'Friend' } : null
  );

  const [disc, setDisc] = useState<DiscPick>('boulder');
  const [style, setStyle] = useState<Style>('lead');
  const [bestN, setBestN] = useState(3);
  const [ranked, setRanked] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isPractice) return;
    loadFriends()
      .then((f) => {
        setFriends(f.list);
        if (!target && f.list.length === 1) setTarget({ uid: f.list[0].user_id, name: f.list[0].display_name || 'Friend' });
      })
      .catch(() => {})
      .finally(() => setLoadingFriends(false));
  }, [isPractice]);

  const mapped: MatchDiscipline = disc === 'boulder' ? 'boulder' : style;

  async function send() {
    if (!isPractice && !target) return;
    setBusy(true);
    setError(null);
    try {
      const ruleset = { discipline: mapped, best_n: bestN, ranked };
      const mid = isPractice ? await practice(ruleset) : await challenge(target!.uid, ruleset);
      router.replace({ pathname: '/h2h', params: { mid } });
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(/already in progress/i.test(msg) ? 'You already have a match going with them.' : msg);
    } finally {
      setBusy(false);
    }
  }

  const summary = `First to win the most of ${bestN} ${DISC_NOUN[mapped]}. ${
    ranked ? 'Ranked — winner takes Send Score.' : 'Unranked — no Send Score at stake.'
  }`;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Title>{isPractice ? 'Practice match' : 'New challenge'}</Title>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Body style={{ color: colors.muted }}>Close</Body>
          </Pressable>
        </View>

        {!isPractice && (
          <>
            <Body style={styles.label}>Opponent</Body>
            {loadingFriends ? (
              <ActivityIndicator color={colors.accent2} style={{ alignSelf: 'flex-start', marginVertical: 8 }} />
            ) : friends.length === 0 ? (
              <Body style={{ color: colors.muted }}>Add a friend first to challenge them.</Body>
            ) : (
              <View style={styles.friendRow}>
                {friends.map((f) => {
                  const active = target?.uid === f.user_id;
                  return (
                    <Pressable
                      key={f.user_id}
                      onPress={() => setTarget({ uid: f.user_id, name: f.display_name || 'Friend' })}
                      style={[styles.friendChip, active && styles.friendChipActive]}
                    >
                      <Avatar uid={f.user_id} name={f.display_name} size="sm" />
                      <Body style={[styles.friendName, active && { color: colors.cream }]}>{f.display_name || 'Climber'}</Body>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </>
        )}
        {isPractice ? (
          <Body style={{ color: colors.muted, marginTop: 6 }}>Play a full match against the practice bot — your real score is untouched.</Body>
        ) : null}

        <Body style={styles.label}>Discipline</Body>
        <View style={styles.row}>
          <Chip label="Bouldering" active={disc === 'boulder'} onPress={() => setDisc('boulder')} />
          <Chip label="Routes" active={disc === 'routes'} onPress={() => setDisc('routes')} />
        </View>
        {disc === 'routes' && (
          <View style={[styles.row, { marginTop: 10 }]}>
            <Chip label="Lead" active={style === 'lead'} onPress={() => setStyle('lead')} />
            <Chip label="Top rope" active={style === 'toprope'} onPress={() => setStyle('toprope')} />
            <Chip label="Either" active={style === 'agnostic'} onPress={() => setStyle('agnostic')} />
          </View>
        )}

        <Body style={styles.label}>Best of</Body>
        <Segmented<string>
          value={String(bestN)}
          onChange={(v) => setBestN(parseInt(v, 10))}
          options={[
            { label: '3', value: '3' },
            { label: '5', value: '5' },
            { label: '7', value: '7' },
            { label: '9', value: '9' },
          ]}
        />

        <Body style={styles.label}>Stakes</Body>
        <View style={styles.row}>
          <Chip label="Ranked" active={ranked} onPress={() => setRanked(true)} />
          <Chip label="Unranked" active={!ranked} onPress={() => setRanked(false)} />
        </View>

        <View style={styles.summaryCard}>
          <Body style={{ color: colors.muted }}>{summary}</Body>
        </View>

        {error ? <Body style={{ color: colors.danger, marginTop: 12 }}>{error}</Body> : null}
        <View style={{ height: 20 }} />
        <Button
          label={isPractice ? 'Start practice match' : 'Send challenge'}
          onPress={send}
          loading={busy}
          disabled={!isPractice && !target}
        />
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
  friendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  friendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  },
  friendChipActive: { backgroundColor: colors.accent2, borderColor: colors.accent2 },
  friendName: { fontFamily: fonts.bodyMed, fontSize: 14, color: colors.text },
  summaryCard: { marginTop: 20, padding: 14, borderRadius: radius.sm, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border },
});
