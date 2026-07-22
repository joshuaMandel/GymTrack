// Social sign-in — native (iOS/Android) implementation. Mirrors the web app's
// ID-token flow (app.js:4791 `signInWithIdToken`), not the hosted-OAuth redirect:
// the platform SDK returns an identity token that we hand to Supabase, which
// writes into the same AsyncStorage session as email sign-in — so no auth or
// routing changes are needed. Metro picks this file over socialAuth.ts on native;
// the native-auth packages therefore never enter the web bundle.
import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as Crypto from 'expo-crypto';
import { supabase } from './supabase';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID, APPLE_ENABLED, isConfigured } from './config';

// A user backing out of the OS sheet isn't an error — callers ignore this.
const CANCELLED = 'CANCELLED';
const isCancel = (e: any) =>
  e?.message === CANCELLED || e?.code === 'ERR_REQUEST_CANCELED' || /cancel/i.test(e?.code || '');
export { isCancel };

// --- Apple (iOS only) ---
export const appleAvailable = Platform.OS === 'ios' && APPLE_ENABLED;

export async function signInWithApple(): Promise<void> {
  if (!(await AppleAuthentication.isAvailableAsync())) {
    throw new Error('Apple sign-in is not available on this device');
  }
  // Nonce: hand Apple the SHA-256 hash (it embeds it in the token) and Supabase
  // the raw value, which GoTrue re-hashes and compares — replay protection,
  // same shape as the web Google flow (app.js:4761-4768).
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
  let cred: AppleAuthentication.AppleAuthenticationCredential;
  try {
    cred = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (e: any) {
    if (isCancel(e)) throw new Error(CANCELLED);
    throw e;
  }
  if (!cred.identityToken) throw new Error('No Apple identity token returned');
  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: cred.identityToken,
    nonce: rawNonce,
  });
  if (error) throw error;
}

// --- Google (iOS/Android) ---
export const googleAvailable = isConfigured(GOOGLE_IOS_CLIENT_ID);

if (googleAvailable) {
  GoogleSignin.configure({
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    webClientId: isConfigured(GOOGLE_WEB_CLIENT_ID) ? GOOGLE_WEB_CLIENT_ID : undefined,
  });
}

export async function signInWithGoogle(): Promise<void> {
  await GoogleSignin.hasPlayServices();
  const res: any = await GoogleSignin.signIn();
  if (res?.type === 'cancelled') throw new Error(CANCELLED);
  const idToken = res?.data?.idToken ?? res?.idToken;
  if (!idToken) throw new Error('No Google ID token returned');
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
  if (error) throw error;
}
