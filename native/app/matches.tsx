import { useCallback, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, Alert } from 'react-native';
import { router, useFocusEffect, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Body, Card, Button } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { colors, fonts, radius } from '../theme';
import { useAuth } from '../lib/auth';
import { OWNER_EMAILS } from '../lib/config';
import { loadMatches, respond, cancel, type Matches, type MatchListRow } from '../lib/matches';
import { useSocialRealtime } from '../lib/realtime';

export default function MatchesHub() {
  const { user } = useAuth();
  const isOwner = !!user?.email && OWNER_EMAILS.includes(user.email.toLowerCase());
  const [m, setM] = useState<Matches | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setM(await loadMatches());
    } catch {
      /* keep last */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );
  useSocialRealtime({ onFriendships: () => {}, onActivity: () => {}, onPoll: refresh, onMatches: refresh });

  async function act(fn: () => Promise<void>, id: string, thenOpen?: string) {
    setBusyId(id);
    try {
      await fn();
      await refresh();
      if (thenOpen) router.push({ pathname: '/h2h', params: { mid: thenOpen } });
    } catch (e: any) {
      Alert.alert('Something went wrong', e?.message || 'Try again');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Stack.Screen options={{ title: 'Matches', headerShown: true, headerBackTitle: 'Back' }} />
      <ScrollView contentContainerStyle={styles.body}>
        {/* Active */}
        {m?.active ? (
          <Pressable onPress={() => router.push({ pathname: '/h2h', params: { mid: m.active!.id } })}>
            <Card style={styles.activeCard}>
              <Avatar uid={m.active.opponent} name={m.active.opponent_name} size="md" />
              <View style={{ flex: 1 }}>
                <Body style={{ fontFamily: fonts.bodyMed, fontSize: 16 }}>vs {m.active.opponent_name || 'Climber'}</Body>
                <Body style={{ color: colors.muted, fontSize: 13 }}>{m.active.rules_label || 'Match in progress'}</Body>
              </View>
              <View style={styles.liveBadge}>
                <Body style={styles.liveText}>LIVE</Body>
              </View>
            </Card>
          </Pressable>
        ) : null}

        {/* Incoming challenges */}
        {m?.incoming.length ? (
          <>
            <Body style={styles.sectionH}>Challenges</Body>
            {m.incoming.map((r) => (
              <Card key={r.id} style={styles.rowCard}>
                <Avatar uid={r.opponent} name={r.opponent_name} size="sm" />
                <View style={{ flex: 1 }}>
                  <Body style={{ fontFamily: fonts.bodyMed }}>{r.opponent_name || 'Climber'} challenged you</Body>
                  <Body style={{ color: colors.muted, fontSize: 12 }}>
                    {r.rules_label || 'Match'}
                    {r.ranked === false ? ' · no elo' : ''}
                  </Body>
                </View>
                <View style={styles.actGroup}>
                  <MiniBtn label="Accept" onPress={() => act(() => respond(r.id, true), r.id, r.id)} disabled={busyId === r.id} />
                  <MiniBtn label="Decline" muted onPress={() => act(() => respond(r.id, false), r.id)} disabled={busyId === r.id} />
                </View>
              </Card>
            ))}
          </>
        ) : null}

        {/* Outgoing */}
        {m?.outgoing.length ? (
          <>
            <Body style={styles.sectionH}>Sent</Body>
            {m.outgoing.map((r) => (
              <Card key={r.id} style={styles.rowCard}>
                <Avatar uid={r.opponent} name={r.opponent_name} size="sm" />
                <View style={{ flex: 1 }}>
                  <Body style={{ fontFamily: fonts.bodyMed }}>Waiting on {r.opponent_name || 'Climber'}</Body>
                  <Body style={{ color: colors.muted, fontSize: 12 }}>{r.rules_label || 'Match'}</Body>
                </View>
                <MiniBtn label="Cancel" muted onPress={() => act(() => cancel(r.id), r.id)} disabled={busyId === r.id} />
              </Card>
            ))}
          </>
        ) : null}

        {/* New match buttons */}
        <View style={{ marginTop: 22, gap: 10 }}>
          <Button label="Challenge a friend" onPress={() => router.push('/match-create')} />
          {isOwner ? (
            <Button label="Practice vs bot" variant="ghost" onPress={() => router.push({ pathname: '/match-create', params: { practice: '1' } })} />
          ) : null}
        </View>

        {/* History */}
        {m?.history.length ? (
          <>
            <Body style={styles.sectionH}>History</Body>
            <Card style={{ padding: 4 }}>
              {m.history.map((r, i) => {
                const outcome =
                  r.status === 'abandoned' ? 'draw' : r.winner === 'draw' ? 'draw' : (r.winner === r.i_am ? 'won' : 'lost');
                return (
                  <View key={r.id} style={[styles.histRow, i > 0 && styles.divider]}>
                    <View style={[styles.outcomeDot, outcome === 'won' ? styles.won : outcome === 'lost' ? styles.lost : styles.draw]} />
                    <View style={{ flex: 1 }}>
                      <Body style={{ fontFamily: fonts.bodyMed }}>
                        {outcome === 'won' ? 'Won' : outcome === 'lost' ? 'Lost' : 'Draw'} vs {r.opponent_name || 'Climber'}
                      </Body>
                      <Body style={{ color: colors.muted, fontSize: 12 }}>{r.rules_label || 'Match'}</Body>
                    </View>
                    {r.my_delta ? (
                      <Body style={{ color: r.my_delta > 0 ? colors.good : colors.danger, fontFamily: fonts.bodyMed }}>
                        {r.my_delta > 0 ? '+' : ''}
                        {r.my_delta}
                      </Body>
                    ) : null}
                  </View>
                );
              })}
            </Card>
          </>
        ) : null}

        {m && !m.active && !m.incoming.length && !m.outgoing.length && !m.history.length ? (
          <Card style={{ marginTop: 22 }}>
            <Body style={{ fontFamily: fonts.bodyMed, marginBottom: 4 }}>No matches yet</Body>
            <Body style={{ color: colors.muted }}>Challenge a friend to a head-to-head, or practice against the bot.</Body>
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function MiniBtn({ label, onPress, muted, disabled }: { label: string; onPress: () => void; muted?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.miniBtn,
        muted ? styles.miniMuted : styles.miniPrimary,
        (disabled || pressed) && { opacity: 0.7 },
      ]}
    >
      <Body style={[styles.miniText, muted ? { color: colors.muted } : { color: colors.cream }]}>{label}</Body>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingVertical: 14, paddingBottom: 44 },
  activeCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderColor: colors.accent2, borderWidth: 1 },
  liveBadge: { backgroundColor: colors.accent2, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  liveText: { color: colors.cream, fontFamily: fonts.bodyMed, fontSize: 11 },
  sectionH: { fontFamily: fonts.displaySemi, fontSize: 16, color: colors.text, marginTop: 22, marginBottom: 8 },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, marginBottom: 8 },
  actGroup: { flexDirection: 'row', gap: 8 },
  miniBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill },
  miniPrimary: { backgroundColor: colors.accent2 },
  miniMuted: { borderWidth: 1, borderColor: colors.border },
  miniText: { fontFamily: fonts.bodyMed, fontSize: 12 },
  histRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.hairline },
  outcomeDot: { width: 10, height: 10, borderRadius: 5 },
  won: { backgroundColor: colors.good },
  lost: { backgroundColor: colors.danger },
  draw: { backgroundColor: colors.mutedSoft },
});
