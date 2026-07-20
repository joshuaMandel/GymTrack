import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../lib/auth';

export default function AuthLayout() {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (session) return <Redirect href="/(tabs)" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
