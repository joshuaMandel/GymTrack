// Tiny event bus so any screen can fire the match "moment" into the single
// root <MatchAnim/> overlay. One listener (the overlay); callers import
// playMatchAnim and call it after a counting send/fail or an opponent's climb.

export type MatchAnimOpts = {
  type: 'send' | 'fail' | 'receive';
  grade?: string;
  discipline?: string;
  magnitude?: number; // 1..3 (send/fail)
  variant?: 'send' | 'fail'; // receive only
  from?: string; // opponent name (receive)
};

type Listener = (opts: MatchAnimOpts) => void;

let listener: Listener | null = null;

export function subscribeMatchAnim(cb: Listener): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

export function playMatchAnim(opts: MatchAnimOpts): void {
  listener?.(opts);
}
