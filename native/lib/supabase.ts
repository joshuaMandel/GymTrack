// Supabase client for React Native. Differences from the web setup:
//  - session persists via AsyncStorage (no localStorage on native)
//  - detectSessionInUrl: false (there's no URL hash to parse on native)
//  - autoRefreshToken is paced by app foreground/background (see below)
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// Only refresh the auth token while the app is in the foreground — the standard
// Supabase RN recommendation, so we don't burn refreshes in the background.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
