import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  matchMySide,
  matchTheirSide,
  matchLastLine,
  fmtRemaining,
  type MatchState,
  type MatchSide,
} from '@gymtrack/core';
import { Body, Card, Button } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { colors, fonts, radius } from '../theme';
import { matchState, botMove } from '../lib/matches';
import { useSocialRealtime } from '../lib/realtime';
import { playMatchAnim } from '../lib/matchAnim';

export default function H2H() {
  const { mid } = useLocalSearchParams<{ mid: string }>();
  const [s, setS] = useState<MatchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [forfeitArm, setForfeitArm] = useState(false);
  const botMoving = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const maybeBotMove = useCallback(
    (st: MatchState) => {
      if (!st || !st.practice || st.status !== 'active' || botMoving.current) return;
      const bot = st.challenger.is_bot ? st.challenger : st.opponent.is_bot ? st.opponent : null;
      if (!bot || bot.can_log !== true) return;
      botMoving.current = true;
      setTimeout(async () => {
        try {
          const next = await botMove(st.id);
          if (next) setS(next);
        } catch {
          /* ignore */
        }
        botMoving.current = false;
      }, 800);
    },
    []
  );

  const refresh = useCallback(async () => {
    try {
      const st = await matchState(mid);
      if (st) {
        setS(st);
        maybeBotMove(st);
        if (st.status === 'resolved' || st.status === 'abandoned') {
          if (timer.current) {
            clearInterval(timer.current);
            timer.current = null;
          }
        }
      }
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }, [mid, maybeBotMove]);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  useSocialRealtime({ onFriendships: () => {}, onActivity: () => {}, onPoll: () => {}, onMatches: refresh });

  // Receive moment: fire when the opponent's last counting climb changes.
  const prevLastAt = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!s) return;
    const them = matchTheirSide(s);
    const at = them.last?.at ?? null;
    if (prevLastAt.current !== undefined && at && at !== prevLastAt.current) {
      playMatchAnim({
        type: 'receive',
        variant: them.last?.result === 'Project' ? 'fail' : 'send',
        grade: them.last?.grade,
        from: them.name,
      });
    }
    prevLastAt.current = at;
  }, [s]);

  async function doForfeit() {
    try {
      const { forfeit } = await import('../lib/matches');
      await forfeit(mid);
    } catch {
      /* ignore */
    }
    setForfeitArm(false);
    refresh();
  }

  if (loading || !s) {
    return (
      <SafeAreaView style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]} edges={['top']}>
        <ActivityIndicator color={colors.accent2} />
      </SafeAreaView>
    );
  }

  const me = matchMySide(s);
  const them = matchTheirSide(s);
  const rules = s.rules || ({} as any);
  const parMode = rules.discipline != null && rules.best_n != null;
  const resolved = s.status === 'resolved' || s.status === 'abandoned';
  const myTurn = me.can_log === true;
  const myFull = rules.best_n != null && (me.counted ?? 0) >= rules.best_n;

  const outcome = resolved
    ? s.status === 'abandoned'
      ? 'draw'
      : s.winner === 'draw'
        ? 'draw'
        : s.winner === s.i_am
          ? 'won'
          : 'lost'
    : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.headerRow}>
        <Body style={{ fontFamily: fonts.displaySemi, fontSize: 18 }}>vs {them.name}</Body>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Body style={{ color: colors.muted }}>Close</Body>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Scoreboard */}
        <View style={styles.scoreRow}>
          <SideCard side={me} isMe lead={(me.score ?? 0) >= (them.score ?? 0)} />
          <View style={styles.vs}>
            <Body style={styles.vsText}>vs</Body>
          </View>
          <SideCard side={them} lead={(them.score ?? 0) > (me.score ?? 0)} />
        </View>

        {rules.style_label ? <Body style={styles.rulesBanner}>{rules.style_label}</Body> : null}
        {s.practice ? <Body style={styles.practiceNote}>Practice — your real Send Score is untouched.</Body> : null}

        {/* Progress */}
        {parMode ? (
          <View style={styles.progressBlock}>
            <ProgressBar label="You" counted={me.counted ?? 0} best={rules.best_n ?? 0} />
            <ProgressBar label={them.name} counted={them.counted ?? 0} best={rules.best_n ?? 0} />
          </View>
        ) : null}

        {/* Live status */}
        {resolved ? (
          <Card style={[styles.resultCard, outcome === 'won' && { borderColor: colors.good }, outcome === 'lost' && { borderColor: colors.danger }]}>
            <Body style={styles.resultTitle}>
              {outcome === 'won' ? 'You won 🏆' : outcome === 'lost' ? 'You lost' : 'Draw'}
            </Body>
            <Body style={{ color: colors.muted, marginTop: 4 }}>
              {s.forfeited_by ? (s.forfeited_by === me.uid ? 'You forfeited.' : `${them.name} forfeited.`) : ''}
              {s.practice
                ? '  Practice — real score untouched.'
                : rules.ranked === false
                  ? '  Unranked — no Send Score exchanged.'
                  : me.delta != null && me.delta !== 0
                    ? `  ${me.delta > 0 ? '+' : ''}${me.delta} Send Score.`
                    : ''}
            </Body>
          </Card>
        ) : parMode && s.turn ? (
          <Card style={styles.turnCard}>
            <Body style={{ fontFamily: fonts.bodyMed }}>
              {myTurn
                ? them.last && them.last.grade
                  ? `${them.name} ${matchLastLine(them)} — your turn.`
                  : 'Your turn.'
                : `${them.name}’s turn…`}
            </Body>
            <Body style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>{fmtRemaining(s.window_end || '')}</Body>
          </Card>
        ) : null}

        {/* Actions */}
        {!resolved ? (
          <View style={{ marginTop: 18, gap: 10 }}>
            <Button
              label={myFull ? 'Your climbs are in' : myTurn ? 'Log a climb' : `Waiting for ${them.name}`}
              onPress={() => router.push({ pathname: '/match-log', params: { mid } })}
              disabled={myFull || !myTurn}
            />
            {!forfeitArm ? (
              <Pressable onPress={() => setForfeitArm(true)} style={styles.forfeitLink}>
                <Body style={{ color: colors.muted, fontSize: 13 }}>Forfeit match</Body>
              </Pressable>
            ) : (
              <View style={styles.forfeitConfirm}>
                <Body style={{ color: colors.danger, fontFamily: fonts.bodyMed }}>Forfeit and lose?</Body>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Pressable onPress={doForfeit} style={[styles.confBtn, { backgroundColor: colors.danger }]}>
                    <Body style={{ color: '#fff', fontFamily: fonts.bodyMed, fontSize: 13 }}>Yes</Body>
                  </Pressable>
                  <Pressable onPress={() => setForfeitArm(false)} style={[styles.confBtn, styles.confMuted]}>
                    <Body style={{ color: colors.muted, fontFamily: fonts.bodyMed, fontSize: 13 }}>No</Body>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
        ) : (
          <View style={{ marginTop: 18 }}>
            <Button label="Back to matches" variant="ghost" onPress={() => router.back()} />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SideCard({ side, isMe, lead }: { side: MatchSide; isMe?: boolean; lead?: boolean }) {
  return (
    <Card style={[styles.sideCard, lead && styles.sideLead]}>
      <Avatar uid={side.uid} name={side.name} size="md" />
      <Body style={styles.sideName} numberOfLines={1}>
        {isMe ? 'You' : side.name}
      </Body>
      <Body style={styles.sideScore}>{Math.round(side.score ?? 0)}</Body>
      <Body style={styles.sideScoreLabel}>pts</Body>
      <Body style={styles.sidePar}>
        {side.par ? `par ${side.par}` : side.par_d == null ? 'par · 1st send' : 'unranked'}
      </Body>
    </Card>
  );
}

function ProgressBar({ label, counted, best }: { label: string; counted: number; best: number }) {
  const pct = Math.min(1, best ? counted / best : 0);
  const noun = 'climbs';
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={styles.progHead}>
        <Body style={{ fontSize: 12, color: colors.muted }} numberOfLines={1}>
          {label}
        </Body>
        <Body style={{ fontSize: 12, color: colors.muted }}>
          {Math.min(counted, best)} of {best} {noun}
        </Body>
      </View>
      <View style={styles.progTrack}>
        <View style={[styles.progFill, { width: `${pct * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 8 },
  body: { paddingHorizontal: 20, paddingVertical: 14, paddingBottom: 44 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sideCard: { flex: 1, alignItems: 'center', padding: 14, gap: 2 },
  sideLead: { borderColor: colors.accent2, borderWidth: 1.5 },
  sideName: { fontFamily: fonts.bodyMed, fontSize: 14, marginTop: 6 },
  sideScore: { fontFamily: fonts.display, fontSize: 34, color: colors.text, marginTop: 2 },
  sideScoreLabel: { color: colors.mutedSoft, fontSize: 11, marginTop: -4 },
  sidePar: { color: colors.muted, fontSize: 12, marginTop: 4 },
  vs: { width: 20, alignItems: 'center' },
  vsText: { color: colors.mutedSoft, fontFamily: fonts.display },
  rulesBanner: { textAlign: 'center', color: colors.muted, fontSize: 13, marginTop: 12 },
  practiceNote: { textAlign: 'center', color: colors.accentText, fontSize: 12, marginTop: 4 },
  progressBlock: { marginTop: 16 },
  progHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  progTrack: { height: 8, borderRadius: 4, backgroundColor: colors.panel2, overflow: 'hidden' },
  progFill: { height: 8, borderRadius: 4, backgroundColor: colors.accent2 },
  turnCard: { marginTop: 16, padding: 14 },
  resultCard: { marginTop: 16, padding: 16, alignItems: 'center' },
  resultTitle: { fontFamily: fonts.display, fontSize: 22, color: colors.text },
  forfeitLink: { alignItems: 'center', paddingVertical: 8 },
  forfeitConfirm: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, paddingHorizontal: 4 },
  confBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.pill },
  confMuted: { borderWidth: 1, borderColor: colors.border },
});
