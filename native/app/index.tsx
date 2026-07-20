import { Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useAuth } from '../lib/auth';
import { colors } from '../theme';

// Entry redirector: send to the app once a session is known, else to sign-in.
export default function Index() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent2} />
      </View>
    );
  }
  return <Redirect href={session ? '/(tabs)' : '/(auth)/sign-in'} />;
}
