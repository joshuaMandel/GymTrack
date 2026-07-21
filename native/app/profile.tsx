// Profile — the climber's own page: avatar (tap to change/remove), handle +
// display name, climbing stats (climbingProfileStats), a Send Score privacy
// toggle, member-since, and sign out. Climbing-only; no lifting anywhere.
import { useCallback, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, Switch, Alert, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { climbingProfileStats, fmtDate } from '@gymtrack/core';
import type { Climb } from '@gymtrack/core';
import { Title, Subtitle, Body, Card } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { colors, fonts, radius } from '../theme';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { fetchMyClimbs } from '../lib/climbs';
import { getMe, type MeFull } from '../lib/social';
import { useSettings, saveSettings } from '../lib/settings';
import { pickAndUploadAvatar, removeAvatar, setAvatarVersion } from '../lib/avatars';

export default function Profile() {
  const { user } = useAuth();
  const settings = useSettings();
  const [me, setMe] = useState<MeFull | null>(null);
  const [climbs, setClimbs] = useState<Climb[]>([]);
  const [busyPhoto, setBusyPhoto] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, cs] = await Promise.all([getMe(), fetchMyClimbs()]);
      setMe(m);
      if (m) setAvatarVersion(m.id, m.avatar_v);
      setClimbs(cs);
    } catch {
      /* keep last */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const uid = user?.id || me?.id || '';
  const name = me?.display_name || settings.display_name || (user?.email || 'Climber').split('@')[0];
  const handle = me?.username;
  const stats = climbingProfileStats(climbs);
  const memberSince = user?.created_at ? fmtDate(user.created_at.slice(0, 10)) : null;

  function changePhoto() {
    const hasPhoto = (me?.avatar_v ?? 0) > 0;
    const opts: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
      { text: hasPhoto ? 'Change photo' : 'Upload photo', onPress: doUpload },
    ];
    if (hasPhoto) opts.push({ text: 'Remove photo', style: 'destructive', onPress: doRemove });
    opts.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Profile photo', undefined, opts);
  }

  async function doUpload() {
    setBusyPhoto(true);
    try {
      const v = await pickAndUploadAvatar();
      if (v != null) setMe((m) => (m ? { ...m, avatar_v: v } : m));
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || 'Try again.');
    } finally {
      setBusyPhoto(false);
    }
  }

  async function doRemove() {
    setBusyPhoto(true);
    try {
      await removeAvatar();
      setMe((m) => (m ? { ...m, avatar_v: 0 } : m));
    } catch (e: any) {
      Alert.alert('Could not remove', e?.message || 'Try again.');
    } finally {
      setBusyPhoto(false);
    }
  }

  function signOut() {
    Alert.alert('Sign out?', 'You can sign back in anytime.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => supabase.auth.signOut() },
    ]);
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.headerRow}>
          <Title>Profile</Title>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Body style={{ color: colors.muted }}>Close</Body>
          </Pressable>
        </View>

        {/* Identity */}
        <Card style={styles.identity}>
          <Pressable onPress={changePhoto} disabled={busyPhoto} style={styles.avatarWrap}>
            <Avatar uid={uid} name={name} size="xl" v={me?.avatar_v} />
            <View style={styles.avatarBadge}>
              {busyPhoto ? (
                <ActivityIndicator size="small" color={colors.cream} />
              ) : (
                <Ionicons name="camera" size={15} color={colors.cream} />
              )}
            </View>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Body style={styles.name} numberOfLines={1}>
              {name}
            </Body>
            <Body style={styles.handle}>{handle ? `@${handle}` : 'No handle yet'}</Body>
            <Pressable
              onPress={() => router.push({ pathname: '/set-handle', params: { username: handle || '', name } })}
              hitSlop={6}
              style={styles.editLink}
            >
              <Ionicons name="pencil" size={13} color={colors.accent2} />
              <Body style={styles.editLinkText}>Edit name & handle</Body>
            </Pressable>
          </View>
        </Card>

        {/* Stats */}
        <View style={styles.statGrid}>
          <StatBox label="Sessions" value={String(stats.sessions)} />
          <StatBox label="Sends" value={String(stats.sends)} />
          <StatBox label="Day streak" value={String(stats.longest)} />
          <StatBox label="Hardest boulder" value={stats.hardestBoulder || '—'} />
          <StatBox label="Hardest route" value={stats.hardestRoute || '—'} />
          <StatBox label="Total climbs" value={String(climbs.length)} />
        </View>

        {/* Settings */}
        <Body style={styles.sectionH}>Settings</Body>
        <Card style={{ padding: 4 }}>
          <View style={styles.settingRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Body style={{ fontFamily: fonts.bodyMed }}>Hide Send Score</Body>
              <Body style={styles.settingSub}>Replace the rating hero with your weekly sessions.</Body>
            </View>
            <Switch
              value={!!settings.hide_rating}
              onValueChange={(v) => saveSettings({ hide_rating: v }).catch(() => {})}
              trackColor={{ true: colors.accent2, false: colors.border }}
              thumbColor={colors.cream}
            />
          </View>
        </Card>

        {memberSince ? <Body style={styles.since}>Member since {memberSince}</Body> : null}

        <Pressable onPress={signOut} style={styles.signOut}>
          <Ionicons name="log-out-outline" size={18} color={colors.danger} />
          <Body style={styles.signOutText}>Sign out</Body>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <Card style={styles.statBox}>
      <Body style={styles.statValue}>{value}</Body>
      <Body style={styles.statLabel}>{label}</Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingBottom: 44, paddingTop: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  avatarWrap: { position: 'relative' },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accent2,
    borderWidth: 2,
    borderColor: colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontFamily: fonts.display, fontSize: 22, color: colors.text },
  handle: { color: colors.muted, fontSize: 14, marginTop: 2 },
  editLink: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  editLinkText: { color: colors.accent2, fontFamily: fonts.bodyMed, fontSize: 13 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 },
  statBox: { width: '31.5%', padding: 14, alignItems: 'flex-start', flexGrow: 1 },
  statValue: { fontFamily: fonts.display, fontSize: 22, color: colors.text },
  statLabel: { color: colors.muted, fontSize: 11, marginTop: 2 },
  sectionH: { fontFamily: fonts.displaySemi, fontSize: 16, color: colors.text, marginTop: 24, marginBottom: 10 },
  settingRow: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  settingSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  since: { color: colors.mutedSoft, fontSize: 13, marginTop: 20, textAlign: 'center' },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  signOutText: { color: colors.danger, fontFamily: fonts.bodyMed, fontSize: 15 },
});
