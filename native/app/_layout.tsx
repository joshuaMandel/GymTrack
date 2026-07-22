import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as SplashScreen from 'expo-splash-screen';
import {
  useFonts,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import { Archivo_400Regular, Archivo_600SemiBold } from '@expo-google-fonts/archivo';
import { AuthProvider } from '../lib/auth';
import { MatchAnim } from '../components/MatchAnim';
import { startSyncTriggers } from '../lib/net';
import { colors } from '../theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    Archivo_400Regular,
    Archivo_600SemiBold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded, fontError]);

  // Flush any queued offline climb writes on reconnect / foreground / startup.
  useEffect(() => startSyncTriggers(), []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="friends" />
            <Stack.Screen name="leaderboard" />
            <Stack.Screen name="profile" />
            <Stack.Screen name="matches" />
            <Stack.Screen name="h2h" />
            <Stack.Screen name="edit-climb" options={{ presentation: 'modal' }} />
            <Stack.Screen name="lb-summary" options={{ presentation: 'modal' }} />
            <Stack.Screen name="set-handle" options={{ presentation: 'modal' }} />
            <Stack.Screen name="match-create" options={{ presentation: 'modal' }} />
            <Stack.Screen name="match-log" options={{ presentation: 'modal' }} />
          </Stack>
          <MatchAnim />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
