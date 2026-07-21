import { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { router, useFocusEffect, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Body, Card } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { colors, fonts, radius } from '../theme';
import {
  loadFriends,
  searchFriends,
  friendAct,
  type Me,
  type Friend,
  type FriendRequest,
  type SearchResult,
  type Relationship,
  type FriendAct,
} from '../lib/social';

export default function Friends() {
  const [me, setMe] = useState<Me | null>(null);
  const [list, setList] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const f = await loadFriends();
      setMe(f.me);
      setList(f.list);
      setRequests(f.requests);
    } catch {
      /* keep last */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  // Debounced search
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setResults(await searchFriends(term));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function act(fact: FriendAct, uid: string) {
    setBusyUid(uid);
    try {
      await friendAct(fact, uid);
      await refresh();
      if (q.trim().length >= 2) setResults(await searchFriends(q.trim()));
    } catch (e: any) {
      Alert.alert('Something went wrong', e?.message || 'Try again');
    } finally {
      setBusyUid(null);
    }
  }

  const incoming = requests.filter((r) => r.direction === 'incoming');
  const outgoing = requests.filter((r) => r.direction === 'outgoing');

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Stack.Screen options={{ title: 'Friends', headerShown: true, headerBackTitle: 'Back' }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* Me / identity */}
        <Card style={styles.meCard}>
          <Avatar uid="me" name={me?.display_name || ''} size="md" />
          <View style={{ flex: 1 }}>
            <Body style={{ fontFamily: fonts.bodyMed, fontSize: 16 }}>{me?.display_name || 'Set your name'}</Body>
            <Body style={{ color: colors.muted, fontSize: 13 }}>
              {me?.username ? `@${me.username}` : 'No handle yet — friends can’t find you'}
            </Body>
          </View>
          <Pressable
            style={styles.editBtn}
            onPress={() =>
              router.push({ pathname: '/set-handle', params: { username: me?.username || '', name: me?.display_name || '' } })
            }
          >
            <Body style={styles.editBtnText}>{me?.username ? 'Edit' : 'Claim'}</Body>
          </Pressable>
        </Card>

        {/* Search */}
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={17} color={colors.mutedSoft} />
          <TextInput
            style={styles.searchInput}
            value={q}
            onChangeText={setQ}
            placeholder="Search by name or @handle"
            placeholderTextColor={colors.mutedSoft}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searching ? <ActivityIndicator size="small" color={colors.mutedSoft} /> : null}
        </View>

        {q.trim().length >= 2 && (
          <Card style={styles.section}>
            {results.length === 0 && !searching ? (
              <Body style={styles.emptyRow}>No one found.</Body>
            ) : (
              results.map((r) => (
                <PersonRow
                  key={r.user_id}
                  uid={r.user_id}
                  name={r.display_name}
                  handle={r.username}
                  rel={r.relationship}
                  busy={busyUid === r.user_id}
                  onAct={act}
                />
              ))
            )}
          </Card>
        )}

        {incoming.length > 0 && (
          <>
            <Body style={styles.sectionH}>Requests</Body>
            <Card style={styles.section}>
              {incoming.map((r) => (
                <PersonRow key={r.user_id} uid={r.user_id} name={r.display_name} handle={r.username} rel="incoming" busy={busyUid === r.user_id} onAct={act} />
              ))}
            </Card>
          </>
        )}

        <Body style={styles.sectionH}>Friends</Body>
        {list.length === 0 ? (
          <Card style={styles.section}>
            <Body style={styles.emptyRow}>No friends yet — search above to add climbers.</Body>
          </Card>
        ) : (
          <Card style={styles.section}>
            {list.map((f) => (
              <PersonRow
                key={f.user_id}
                uid={f.user_id}
                name={f.display_name}
                handle={f.username}
                rel="friends"
                score={f.boulder ?? f.rope ?? null}
                busy={busyUid === f.user_id}
                onAct={act}
              />
            ))}
          </Card>
        )}

        {outgoing.length > 0 && (
          <>
            <Body style={styles.sectionH}>Pending</Body>
            <Card style={styles.section}>
              {outgoing.map((r) => (
                <PersonRow key={r.user_id} uid={r.user_id} name={r.display_name} handle={r.username} rel="outgoing" busy={busyUid === r.user_id} onAct={act} />
              ))}
            </Card>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PersonRow({
  uid,
  name,
  handle,
  rel,
  score,
  busy,
  onAct,
}: {
  uid: string;
  name: string | null;
  handle: string | null;
  rel: Relationship;
  score?: number | null;
  busy?: boolean;
  onAct: (fact: FriendAct, uid: string) => void;
}) {
  return (
    <View style={styles.row}>
      <Avatar uid={uid} name={name || ''} size="sm" />
      <View style={{ flex: 1 }}>
        <Body style={{ fontFamily: fonts.bodyMed }}>{name || 'Climber'}</Body>
        {handle ? <Body style={{ color: colors.muted, fontSize: 12 }}>@{handle}</Body> : null}
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={colors.mutedSoft} />
      ) : rel === 'self' ? (
        <Body style={styles.chipMuted}>You</Body>
      ) : rel === 'friends' ? (
        <View style={styles.actGroup}>
          {score != null ? <Body style={styles.scoreChip}>{score}</Body> : null}
          <RowBtn label="Remove" onPress={() => onAct('unfriend', uid)} muted />
        </View>
      ) : rel === 'incoming' ? (
        <View style={styles.actGroup}>
          <RowBtn label="Accept" onPress={() => onAct('accept', uid)} />
          <RowBtn label="Decline" onPress={() => onAct('decline', uid)} muted />
        </View>
      ) : rel === 'outgoing' ? (
        <RowBtn label="Cancel" onPress={() => onAct('cancel', uid)} muted />
      ) : (
        <RowBtn label="Add" onPress={() => onAct('request', uid)} />
      )}
    </View>
  );
}

function RowBtn({ label, onPress, muted }: { label: string; onPress: () => void; muted?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.rowBtn, muted ? styles.rowBtnMuted : styles.rowBtnPrimary, pressed && { opacity: 0.85 }]}
    >
      <Body style={[styles.rowBtnText, muted ? { color: colors.muted } : { color: colors.cream }]}>{label}</Body>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingVertical: 14, paddingBottom: 44 },
  meCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  editBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  editBtnText: { fontFamily: fonts.bodyMed, fontSize: 13, color: colors.text },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    borderRadius: radius.sm,
  },
  searchInput: { flex: 1, minHeight: 48, fontFamily: fonts.body, fontSize: 15, color: colors.text },
  section: { padding: 4, marginTop: 8 },
  sectionH: { fontFamily: fonts.displaySemi, fontSize: 16, color: colors.text, marginTop: 22, marginBottom: 4 },
  emptyRow: { color: colors.muted, padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10 },
  actGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chipMuted: { color: colors.muted, fontSize: 13, paddingHorizontal: 8 },
  scoreChip: {
    fontFamily: fonts.displaySemi,
    fontSize: 13,
    color: colors.accent2,
    backgroundColor: colors.accent2Tint,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  rowBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill },
  rowBtnPrimary: { backgroundColor: colors.accent2 },
  rowBtnMuted: { borderWidth: 1, borderColor: colors.border },
  rowBtnText: { fontFamily: fonts.bodyMed, fontSize: 13 },
});
