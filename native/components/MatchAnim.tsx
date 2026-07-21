// The head-to-head "moment" — send / fail / receive — rebuilt for React Native
// with Reanimated + react-native-svg (the web used Motion springs + CSS). Purely
// presentational: it reads no scoring and fires via the matchAnim event bus.
// Mounted once at the app root, above everything. Honors reduce-motion.
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, AccessibilityInfo, Pressable, Dimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withDelay,
  interpolate,
  Easing,
} from 'react-native-reanimated';
import Svg, { Circle, Path, G } from 'react-native-svg';
import { colors, fonts, radius } from '../theme';
import { subscribeMatchAnim, type MatchAnimOpts } from '../lib/matchAnim';

const { width: SCREEN_W } = Dimensions.get('window');
const CONFETTI = ['#ffd23f', '#e0459b', '#22c1c3', '#7ee06a', '#e2574c', '#a06bff'];

// Stick-figure poses (viewBox 0 0 46 58) — ported from app.js MA_POSES.
type Pose = 'climb' | 'top' | 'fall' | 'splat';
const POSES: Record<Pose, { hd: [number, number]; ln: string[] }> = {
  climb: { hd: [23, 12], ln: ['M23 17 L22 34', 'M23 20 L14 8', 'M23 22 L31 18', 'M22 34 L14 43', 'M22 34 L28 49'] },
  top: { hd: [23, 11], ln: ['M23 16 L23 35', 'M23 19 L13 7', 'M23 19 L33 7', 'M23 35 L18 50', 'M23 35 L28 50'] },
  fall: { hd: [23, 15], ln: ['M23 20 L23 34', 'M23 23 L11 17', 'M23 23 L35 17', 'M23 34 L12 45', 'M23 34 L34 45'] },
  splat: { hd: [13, 42], ln: ['M18 43 L35 46', 'M23 44 L18 35', 'M28 45 L32 37', 'M35 46 L42 41', 'M35 46 L41 51'] },
};

function Figure({ pose, rope }: { pose: Pose; rope: boolean }) {
  const p = POSES[pose];
  return (
    <Svg width={66} height={84} viewBox="0 0 46 58">
      <G>
        {p.ln.map((d, i) => (
          <Path key={i} d={d} stroke={colors.ink} strokeWidth={4.3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ))}
        <Circle cx={p.hd[0]} cy={p.hd[1]} r={5} fill={rope ? colors.accent : colors.accent2} stroke="#fff" strokeWidth={1.4} />
      </G>
    </Svg>
  );
}

function ConfettiPiece({ dx, dy, color, delay }: { dx: number; dy: number; color: string; delay: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withTiming(1, { duration: 950, easing: Easing.out(Easing.cubic) }));
  }, []);
  const st = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.12, 1], [0, 1, 0]),
    transform: [
      { translateX: dx * t.value },
      { translateY: dy * t.value },
      { scale: 0.4 + 0.6 * t.value },
      { rotate: `${t.value * 240}deg` },
    ],
  }));
  return <Animated.View style={[styles.confetti, { backgroundColor: color }, st]} />;
}

type Live = MatchAnimOpts & { nonce: number };

export function MatchAnim() {
  const [live, setLive] = useState<Live | null>(null);
  const reduced = useRef(false);
  const nonce = useRef(0);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        reduced.current = v;
      })
      .catch(() => {});
    return subscribeMatchAnim((opts) => setLive({ ...opts, nonce: ++nonce.current }));
  }, []);

  if (!live) return null;
  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Moment key={live.nonce} opts={live} reduced={reduced.current} onDone={() => setLive(null)} />
    </View>
  );
}

function Moment({ opts, reduced, onDone }: { opts: Live; reduced: boolean; onDone: () => void }) {
  const recv = opts.type === 'receive';
  const fail = opts.type === 'fail' || (recv && opts.variant === 'fail');
  const rope = opts.discipline !== 'Bouldering';
  const mag = opts.magnitude || 2;

  const op = useSharedValue(0);
  const scale = useSharedValue(recv ? 0.85 : 0.86);
  const tx = useSharedValue(recv ? 60 : 0);
  const ty = useSharedValue(recv ? 0 : -14);
  const rot = useSharedValue(0);
  const figTy = useSharedValue(fail ? 8 : recv ? 0 : 40);
  const figRot = useSharedValue(0);
  const xScale = useSharedValue(0);

  const [pose, setPose] = useState<Pose>(recv ? (fail ? 'splat' : 'top') : 'climb');

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    if (reduced) {
      op.value = withTiming(1, { duration: 200 });
      at(1500, onDone);
      return () => timers.forEach(clearTimeout);
    }

    // entrance
    op.value = withTiming(1, { duration: 180 });
    if (recv) {
      tx.value = withSpring(0, { stiffness: 480, damping: 17 });
      scale.value = withSpring(1, { stiffness: 480, damping: 17 });
    } else {
      ty.value = withSpring(0, { stiffness: 560, damping: 26, mass: 0.9 });
      scale.value = withSpring(1, { stiffness: 560, damping: 26, mass: 0.9 });
    }

    if (opts.type === 'send') {
      figTy.value = withTiming(0, { duration: 1300, easing: Easing.out(Easing.quad) }); // climb up
      at(900, () => setPose('top'));
      // fling toward the opponent
      at(1500, () => {
        tx.value = withTiming(SCREEN_W * 0.62, { duration: 600, easing: Easing.in(Easing.cubic) });
        ty.value = withTiming(-SCREEN_W * 0.26, { duration: 600 });
        rot.value = withTiming(20, { duration: 600 });
        scale.value = withTiming(0.18, { duration: 600 });
        op.value = withTiming(0, { duration: 600 });
      });
      at(2250, onDone);
    } else if (opts.type === 'fail') {
      // climb → pop off → splat
      at(500, () => {
        setPose('fall');
        figTy.value = withTiming(-24, { duration: 260, easing: Easing.out(Easing.quad) });
        figRot.value = withTiming(200, { duration: 620 });
      });
      at(1120, () => {
        setPose('splat');
        figTy.value = withTiming(10, { duration: 220, easing: Easing.in(Easing.quad) });
      });
      at(1600, () => {
        xScale.value = withSpring(1, { stiffness: 300, damping: 12 });
      });
      at(2050, () => {
        tx.value = withTiming(SCREEN_W * 0.5, { duration: 700, easing: Easing.in(Easing.cubic) });
        ty.value = withTiming(-SCREEN_W * 0.22, { duration: 700 });
        rot.value = withTiming(18, { duration: 700 });
        scale.value = withTiming(0.2, { duration: 700 });
        op.value = withTiming(0, { duration: 700 });
      });
      at(2750, onDone);
    } else {
      // receive: hold, then slide out to the left
      at(1900, () => {
        tx.value = withTiming(-22, { duration: 400, easing: Easing.in(Easing.quad) });
        ty.value = withTiming(-10, { duration: 400 });
        scale.value = withTiming(0.9, { duration: 400 });
        op.value = withTiming(0, { duration: 400 });
      });
      at(2300, onDone);
    }

    return () => timers.forEach(clearTimeout);
  }, []);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: op.value,
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }, { rotate: `${rot.value}deg` }],
  }));
  const figStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: figTy.value }, { rotate: `${figRot.value}deg` }],
  }));
  const xStyle = useAnimatedStyle(() => ({ opacity: xScale.value > 0 ? 1 : 0, transform: [{ scale: xScale.value }, { rotate: '-9deg' }] }));

  // titles
  const gradeStr = opts.grade || '';
  const title = recv
    ? fail
      ? 'came off'
      : 'sent'
    : fail
      ? 'Whipped!'
      : mag >= 3
        ? 'Big send!'
        : 'Sent!';
  const titleColor = fail ? colors.danger : colors.good;

  // confetti (send + receive-send)
  const showConfetti = !reduced && !fail;
  const n = recv ? 8 : mag === 3 ? 24 : mag === 2 ? 16 : 8;
  const pieces = showConfetti
    ? Array.from({ length: n }, (_, i) => ({
        dx: ((i * 53) % 170) - 85,
        dy: -(22 + ((i * 37) % 72)),
        color: CONFETTI[i % CONFETTI.length],
        delay: (recv ? 120 : 300) + (i % 6) * 40,
      }))
    : [];

  return (
    <Animated.View style={[styles.card, recv && styles.cardRecv, cardStyle]}>
      <Pressable onPress={onDone}>
        {recv && opts.from ? <Text style={styles.from}>{opts.from.toUpperCase()}</Text> : null}
        {reduced ? (
          <View style={styles.reducedStage}>
            <Text style={[styles.mark, { color: titleColor }]}>{fail ? '✕' : '✓'}</Text>
          </View>
        ) : (
          <View style={styles.stage}>
            <Animated.View style={figStyle}>
              <Figure pose={pose} rope={rope} />
            </Animated.View>
            {pieces.map((p, i) => (
              <ConfettiPiece key={i} dx={p.dx} dy={p.dy} color={p.color} delay={p.delay} />
            ))}
            {fail ? (
              <Animated.Text style={[styles.x, xStyle]}>✕</Animated.Text>
            ) : null}
          </View>
        )}
        <View style={styles.label}>
          <Text style={[styles.title, { color: titleColor }]}>{title}</Text>
          {gradeStr ? <Text style={styles.grade}>{gradeStr}</Text> : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 90, zIndex: 1000 },
  card: {
    width: 212,
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 12,
    paddingHorizontal: 12,
    alignItems: 'center',
    shadowColor: '#16181d',
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  cardRecv: { width: 198 },
  from: { fontSize: 11, fontFamily: fonts.bodyMed, color: colors.muted, letterSpacing: 1, marginBottom: 4 },
  stage: {
    width: 132,
    height: 132,
    borderRadius: 10,
    backgroundColor: colors.panel2,
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'hidden',
    marginBottom: 8,
  },
  reducedStage: { paddingVertical: 6, marginBottom: 4 },
  mark: { fontFamily: fonts.display, fontSize: 46 },
  confetti: { position: 'absolute', top: '22%', left: '48%', width: 10, height: 10, borderRadius: 2 },
  x: { position: 'absolute', right: 10, top: 24, fontFamily: fonts.display, fontSize: 52, color: colors.danger },
  label: { alignItems: 'center' },
  title: { fontFamily: fonts.display, fontSize: 18 },
  grade: { fontFamily: fonts.displaySemi, fontSize: 15, color: colors.text, marginTop: 1 },
});
