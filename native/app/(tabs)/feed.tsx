import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, RefreshControl } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { feedLine, ago, type FeedItem } from '@gymtrack/core';
import { Title, Body, Card } from '../../components/ui';
import { Avatar } from '../../components/Avatar';
import { colors, fonts, radius } from '../../theme';
import { useAuth } from '../../lib/auth';
import { loadFeed, loadFriends, type Me, type Friend } from '../../lib/social';
import { useSocialRealtime } from '../../lib/realtime';

const ICON: Record<string, any> = { bolt: 'flash', barbell: 'barbell', mountain: 'triangle' };
const cacheKey = (uid: string) => `gymtrack.feed.${uid}`;

export default function Feed() {
  const { user } = useAuth();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const booted = useRef(false);

  const scoreFor = (uid: string) => {
    const f = friends.find((x) => x.user_id === uid);
    return f ? (f.boulder ?? f.rope ?? null) : null;
  };

  const pullFeed = useCallback(async () => {
    try {
      const fresh = await loadFeed();
      setItems(fresh);
      if (user?.id) AsyncStorage.setItem(cacheKey(user.id), JSON.stringify(fresh.slice(0, 50))).catch(() => {});
    } catch {
      /* keep cache */
    }
  }, [user?.id]);

  const pullFriends = useCallback(async () => {
    try {
      const f = await loadFriends();
      setMe(f.me);
      setFriends(f.list);
      setIncoming(f.requests.filter((r) => r.direction === 'incoming').length);
    } catch {
      /* keep last */
    }
  }, []);

  // Instant paint from cache, then refresh.
  useEffect(() => {
    if (!user?.id || booted.current) return;
    booted.current = true;
    AsyncStorage.getItem(cacheKey(user.id))
      .then((raw) => {
        if (raw) setItems(JSON.parse(raw));
      })
      .catch(() => {});
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      pullFeed();
      pullFriends();
    }, [pullFeed, pullFriends])
  );

  useSocialRealtime({
    onFriendships: () => {
      pullFriends();
      pullFeed();
    },
    onActivity: () => pullFeed(),
    onPoll: () => {
      pullFeed();
      pullFriends();
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([pullFeed(), pullFriends()]);
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Title>Feed</Title>
        <View style={styles.headerBtns}>
          <Pressable style={styles.iconBtn} onPress={() => router.push('/leaderboard')}>
            <Ionicons name="trophy-outline" size={20} color={colors.text} />
          </Pressable>
          <Pressable style={styles.iconBtn} onPress={() => router.push('/friends')}>
            <Ionicons name="people-outline" size={20} color={colors.text} />
            {incoming > 0 ? (
              <View style={styles.badge}>
                <Body style={styles.badgeText}>{incoming}</Body>
              </View>
            ) : null}
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent2} />}
      >
        {/* Claim-handle CTA */}
        {me && !me.username ? (
          <Pressable onPress={() => router.push('/set-handle')}>
            <Card style={styles.cta}>
              <Ionicons name="at" size={20} color={colors.accent2} />
              <View style={{ flex: 1 }}>
                <Body style={{ fontFamily: fonts.bodyMed }}>Claim your handle</Body>
                <Body style={{ color: colors.muted, fontSize: 13 }}>So friends can find and challenge you.</Body>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mutedSoft} />
            </Card>
          </Pressable>
        ) : null}

        {items.length === 0 ? (
          <Card style={{ marginTop: 12 }}>
            <Body style={{ fontFamily: fonts.bodyMed, marginBottom: 4 }}>No friend activity yet</Body>
            <Body style={{ color: colors.muted }}>
              Add friends to see their sends here — tap the people icon above.
            </Body>
          </Card>
        ) : (
          <Card style={{ padding: 4, marginTop: 12 }}>
            {items.map((it, i) => {
              const line = feedLine(it);
              const score = scoreFor(it.user_id);
              return (
                <View key={it.id} style={[styles.feedRow, i > 0 && styles.divider]}>
                  <Avatar uid={it.user_id} name={it.display_name} size="sm" />
                  <View style={styles.iconBadge}>
                    <Ionicons name={ICON[line.ico] || 'ellipse'} size={13} color={colors.muted} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Body style={{ fontFamily: fonts.bodyMed }}>{line.main}</Body>
                    <Body style={{ color: colors.muted, fontSize: 13 }}>
                      {line.sub}
                      {line.delta ? (
                        <Body style={{ color: line.delta > 0 ? colors.good : colors.danger, fontSize: 13 }}>
                          {'  '}
                          {line.delta > 0 ? '+' : ''}
                          {line.delta}
                        </Body>
                      ) : null}
                      {line.pr ? <Body style={{ color: colors.accentText, fontSize: 13 }}>{'  · new PR!'}</Body> : null}
                    </Body>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Body style={{ color: colors.mutedSoft, fontSize: 12 }}>{ago(it.created_at)}</Body>
                    {score != null ? <Body style={styles.scoreChip}>{score}</Body> : null}
                  </View>
                </View>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 6,
  },
  headerBtns: { flexDirection: 'row', gap: 6 },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontFamily: fonts.bodyMed },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  cta: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  feedRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.hairline },
  iconBadge: { width: 22, alignItems: 'center' },
  scoreChip: {
    fontFamily: fonts.displaySemi,
    fontSize: 12,
    color: colors.accent2,
    marginTop: 2,
  },
});
