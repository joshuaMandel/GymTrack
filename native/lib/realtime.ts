// Live social updates — subscribe to the `friends-activity` channel (mirrors
// app.js:3017) and fall back to an 8s poll when the socket isn't connected.
//   onFriendships → friendship changed (reload friends + feed)
//   onActivity(row) → a friend's activity row inserted/updated (update feed)
// The caller decides what to reload; this hook only routes events + paces polling.
import { useEffect, useRef } from 'react';
import { supabase } from './supabase';

type Handlers = {
  onFriendships: () => void;
  onActivity: (row: any) => void;
  onPoll: () => void; // fired every 8s while the socket is not live
  onMatches?: () => void; // any change to the matches table
};

export function useSocialRealtime({ onFriendships, onActivity, onPoll, onMatches }: Handlers) {
  const live = useRef(false);
  const cbs = useRef({ onFriendships, onActivity, onPoll, onMatches });
  cbs.current = { onFriendships, onActivity, onPoll, onMatches };

  useEffect(() => {
    const channel = supabase
      .channel('friends-activity')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity' }, (p) =>
        cbs.current.onActivity(p.new)
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'activity' }, (p) =>
        cbs.current.onActivity(p.new)
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () =>
        cbs.current.onFriendships()
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () =>
        cbs.current.onMatches?.()
      )
      .subscribe((status) => {
        live.current = status === 'SUBSCRIBED';
      });

    // Poll fallback: only does work while the socket isn't live.
    const timer = setInterval(() => {
      if (!live.current) cbs.current.onPoll();
    }, 8000);

    return () => {
      clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, []);
}
