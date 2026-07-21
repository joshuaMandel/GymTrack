// Line chart rendered with react-native-svg, driven entirely by @gymtrack/core's
// pure `lineScale` geometry (the same math the web app's SVG chart uses). A single
// series gets a soft area fill; multiple series each get a brand color + legend.
import { useState } from 'react';
import { View, Text, StyleSheet, LayoutChangeEvent } from 'react-native';
import Svg, { Line, Polyline, Polygon, Circle, Text as SvgText } from 'react-native-svg';
import { lineScale, CHART_COLORS, fmtDateShort } from '@gymtrack/core';
import type { Series } from '@gymtrack/core';
import { colors, fonts } from '../theme';

type Props = {
  series: Series[];
  fmt: (v: number) => string;
  height?: number;
};

export function LineChart({ series, fmt, height = 200 }: Props) {
  const [w, setW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setW(Math.round(e.nativeEvent.layout.width));

  const scale = w >= 200 ? lineScale(series, w, height) : null;
  const single = series.filter((s) => s.points && s.points.length).length === 1;
  const seriesColor = (color: string | null, si: number) => color || CHART_COLORS[si % CHART_COLORS.length];

  return (
    <View onLayout={onLayout} style={{ width: '100%' }}>
      {!scale ? (
        <View style={[styles.empty, { height }]}>
          <Text style={styles.emptyText}>{w >= 200 ? 'No data yet.' : ''}</Text>
        </View>
      ) : (
        <Svg width={scale.W} height={scale.H}>
          {/* y gridlines */}
          {scale.ticks.map((t, i) => (
            <Line
              key={`g${i}`}
              x1={scale.padL}
              y1={scale.y(t)}
              x2={scale.W - scale.padR}
              y2={scale.y(t)}
              stroke={colors.hairline}
              strokeWidth={1}
            />
          ))}
          {/* y labels */}
          {scale.ticks.map((t, i) => (
            <SvgText
              key={`yl${i}`}
              x={scale.padL - 6}
              y={scale.y(t) + 3}
              fontSize={10}
              fill={colors.muted}
              textAnchor="end"
              fontFamily={fonts.body}
            >
              {fmt(t)}
            </SvgText>
          ))}
          {/* baseline */}
          <Line
            x1={scale.padL}
            y1={scale.baselineY}
            x2={scale.W - scale.padR}
            y2={scale.baselineY}
            stroke={colors.border}
            strokeWidth={1}
          />
          {/* area fill (single series only) */}
          {single &&
            scale.lines.map((ln, si) => {
              if (ln.pts.length < 2) return null;
              const area = [
                `${ln.pts[0].cx},${scale.baselineY}`,
                ...ln.pts.map((p) => `${p.cx},${p.cy}`),
                `${ln.pts[ln.pts.length - 1].cx},${scale.baselineY}`,
              ].join(' ');
              return <Polygon key={`a${si}`} points={area} fill={seriesColor(ln.color, si)} fillOpacity={0.08} />;
            })}
          {/* series polylines */}
          {scale.lines.map((ln, si) => (
            <Polyline
              key={`p${si}`}
              points={ln.pts.map((p) => `${p.cx},${p.cy}`).join(' ')}
              fill="none"
              stroke={seriesColor(ln.color, si)}
              strokeWidth={3}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {/* end dot per series */}
          {scale.lines.map((ln, si) => {
            const last = ln.pts[ln.pts.length - 1];
            if (!last) return null;
            return <Circle key={`d${si}`} cx={last.cx} cy={last.cy} r={4} fill={seriesColor(ln.color, si)} />;
          })}
          {/* single-point series get a ringed marker so they don't vanish */}
          {scale.lines.map((ln, si) =>
            ln.pts.length === 1 ? (
              <Circle
                key={`m${si}`}
                cx={ln.pts[0].cx}
                cy={ln.pts[0].cy}
                r={5}
                fill={colors.panel}
                stroke={seriesColor(ln.color, si)}
                strokeWidth={3}
              />
            ) : null
          )}
          {/* x labels: first / middle / last */}
          {scale.labelIdxs.map((i) => (
            <SvgText
              key={`xl${i}`}
              x={scale.x(i)}
              y={scale.H - 8}
              fontSize={10}
              fill={colors.muted}
              textAnchor="middle"
              fontFamily={fonts.body}
            >
              {fmtDateShort(scale.dates[i])}
            </SvgText>
          ))}
        </Svg>
      )}

      {/* legend for multi-series */}
      {!single && scale && (
        <View style={styles.legend}>
          {scale.lines.map((ln, si) => (
            <View key={`lg${si}`} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: seriesColor(ln.color, si) }]} />
              <Text style={styles.legendText}>{ln.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.mutedSoft, fontFamily: fonts.body },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 8, paddingLeft: 46 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendText: { fontFamily: fonts.body, fontSize: 12, color: colors.muted },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
});
