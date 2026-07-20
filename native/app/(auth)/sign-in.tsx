import { useState } from 'react';
import { View, TextInput, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { Screen, Title, Subtitle, Body, Button } from '../../components/ui';
import { supabase } from '../../lib/supabase';
import { colors, fonts, radius } from '../../theme';

// Email → 6-digit code sign-in. Mirrors the web app's OTP flow (app.js:4658):
// signInWithOtp({ email }) then verifyOtp({ email, token, type:'email' }). No
// deep-linking needed — the user types the code, so this works on-device today.
// (Native Google/Apple sign-in comes in a later milestone.)
export default function SignIn() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<{ msg: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    const e = email.trim();
    if (!e) return;
    setBusy(true);
    setStatus({ msg: 'Sending…' });
    try {
      const { error } = await supabase.auth.signInWithOtp({ email: e });
      if (error) throw error;
      setStep('code');
      setStatus({ msg: 'Check your email and enter the 6-digit code.' });
    } catch (err: any) {
      setStatus({ msg: 'Error: ' + (err?.message || String(err)), err: true });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    const token = code.trim().replace(/\s+/g, '');
    if (!token) return;
    setBusy(true);
    setStatus({ msg: 'Checking…' });
    try {
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: 'email' });
      if (error) throw error;
      // Success fires onAuthStateChange(SIGNED_IN) → the auth gate redirects.
    } catch (err: any) {
      setStatus({
        msg: `That code didn't work (${err?.message || String(err)}). Codes are single-use — request a fresh one and paste the newest.`,
        err: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.wrap}
      >
        <View style={styles.brandRow}>
          <View style={styles.mark}>
            <Body style={styles.markText}>◆</Body>
          </View>
          <Title>GymTrack</Title>
        </View>
        <Subtitle style={{ marginTop: 6, marginBottom: 28 }}>
          Track climbs, build your Send Score, challenge friends.
        </Subtitle>

        {step === 'email' ? (
          <>
            <TextInput
              style={styles.input}
              placeholder="you@email.com"
              placeholderTextColor={colors.mutedSoft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              onSubmitEditing={sendCode}
              returnKeyType="send"
            />
            <View style={{ height: 12 }} />
            <Button label="Email me a code" onPress={sendCode} loading={busy} disabled={!email.trim()} />
          </>
        ) : (
          <>
            <TextInput
              style={styles.input}
              placeholder="123456"
              placeholderTextColor={colors.mutedSoft}
              keyboardType="number-pad"
              value={code}
              onChangeText={setCode}
              onSubmitEditing={verify}
              returnKeyType="done"
              autoFocus
            />
            <View style={{ height: 12 }} />
            <Button label="Verify & sign in" onPress={verify} loading={busy} disabled={!code.trim()} />
            <View style={{ height: 10 }} />
            <Button
              label="Use a different email"
              variant="ghost"
              onPress={() => {
                setStep('email');
                setCode('');
                setStatus(null);
              }}
            />
          </>
        )}

        {status ? (
          <Body style={[styles.status, status.err ? { color: colors.danger } : { color: colors.good }]}>
            {status.msg}
          </Body>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: { color: colors.accent, fontSize: 20 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    fontFamily: fonts.body,
    fontSize: 17,
    color: colors.text,
  },
  status: { marginTop: 18, fontSize: 14 },
});
