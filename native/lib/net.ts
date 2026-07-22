// Sync triggers for the offline climb queue. Flushes when connectivity is
// restored (NetInfo), when the app returns to the foreground (AppState), and
// once on startup — the native analog of the web app's `online` event +
// post-mutation flush (app.js:334, 821, 5326). Mounted once from the root layout.
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { flushClimbQueue } from './climbs';

let started = false;

export function startSyncTriggers(): () => void {
  if (started) return () => {};
  started = true;

  const unsubNet = NetInfo.addEventListener((state) => {
    if (state.isConnected) flushClimbQueue();
  });
  const appSub = AppState.addEventListener('change', (s) => {
    if (s === 'active') flushClimbQueue();
  });

  flushClimbQueue(); // drain anything left from a previous session

  return () => {
    unsubNet();
    appSub.remove();
    started = false;
  };
}
