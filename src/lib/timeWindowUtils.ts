import type { TimeWindow, TrafficPoint } from '../types/telemetry';
import { formatDuration } from './formatters';

export const ALL_TIME_WINDOWS: TimeWindow[] = ['5m', '15m', '1h', '3h', '6h'];

export const WINDOW_MS: Record<TimeWindow, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '3h': 3 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
};

/**
 * Consistent gap thresholds across time windows:
 * - 5m is pure high-res (3s cadence): 95s marks a real outage while tolerating brief reconnects.
 * - 15m and 1h use 150s so rollup-backed spans and rollup->high-res transitions never produce
 *   phantom gaps when switching windows.
 * - 3h and 6h use 180s (3 missed 1-minute rollup buckets).
 */
const GAP_THRESHOLD_MS: Record<TimeWindow, number> = {
  '5m': 95_000,
  '15m': 150_000,
  '1h': 150_000,
  '3h': 180_000,
  '6h': 180_000,
};

/**
 * Uniform 100-point dynamic rhythm across ALL 5 time windows (windowMs / bucketMs === 100):
 * - 5m  / 3s   = 100 data points (raw 3s ticks)
 * - 15m / 9s   = 100 data points
 * - 1h  / 36s  = 100 data points
 * - 3h  / 108s = 100 data points
 * - 6h  / 216s = 100 data points
 * Every time period renders the same 100-point dynamic rhythm with proportionally scaled intervals.
 */
export const SMOOTH_BUCKET_MS: Record<TimeWindow, number> = {
  '5m': 3_000,
  '15m': 9_000,
  '1h': 36_000,
  '3h': 108_000,
  '6h': 216_000,
};

export interface TimeRange {
  start: number;
  end: number;
}

export type TimeWindowDataStatus = 'full' | 'partial' | 'empty';

export interface TimeWindowAnalysis {
  window: TimeWindow;
  windowStart: number;
  windowEnd: number;
  status: TimeWindowDataStatus;
  points: TrafficPoint[];
  segments: TrafficPoint[][];
  leadingAnchor: TrafficPoint | null;
  noDataRanges: TimeRange[];
  coveragePct: number;
  coveredMs: number;
  missingMs: number;
  summaryText: string;
}

/**
 * Sorts and deduplicates traffic points by timestamp (keeping the newer entry on exact duplicates).
 */
function sortAndDedupePoints(points: TrafficPoint[]): TrafficPoint[] {
  if (points.length <= 1) return points.slice();
  const sorted = [...points]
    .filter((p) => p && Number.isFinite(p.timestamp) && Number.isFinite(p.rxBps) && Number.isFinite(p.txBps))
    .sort((a, b) => a.timestamp - b.timestamp);
  const out: TrafficPoint[] = [];
  for (const p of sorted) {
    if (out.length > 0 && out[out.length - 1].timestamp === p.timestamp) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Aggregates a chronological group of TrafficPoints into a single averaged bucket at `timestamp`.
 */
function averagePoints(group: TrafficPoint[], timestamp: number): TrafficPoint {
  const count = group.length;
  let sumRx = 0;
  let sumTx = 0;
  let sumFlows = 0;
  let sumLoad = 0;
  let loadCount = 0;
  for (const p of group) {
    sumRx += p.rxBps;
    sumTx += p.txBps;
    sumFlows += p.activeFlows;
    if (typeof p.routerLoadPct === 'number' && Number.isFinite(p.routerLoadPct)) {
      sumLoad += p.routerLoadPct;
      loadCount += 1;
    }
  }
  return {
    timestamp,
    rxBps: Math.round(sumRx / count),
    txBps: Math.round(sumTx / count),
    activeFlows: Math.round(sumFlows / count),
    ...(loadCount > 0 ? { routerLoadPct: Math.round(sumLoad / loadCount) } : {}),
  };
}

/**
 * Seamlessly stitches 1-minute rollup history and high-resolution history without creating
 * artificial boundary holes or duplicate timestamps.
 *
 * - For 5m, 15m, and 1h: uses full high-resolution history (3s cadence, up to 65m) so 5m (3s),
 *   15m (9s), and 1h (36s) all achieve full 100-point dynamic resolution, backfilled cleanly by
 *   any earlier 1-minute rollups strictly before `earliestHighRes`.
 * - For 3h and 6h: uses 1-minute rollups (3h @ 108s and 6h @ 216s both exceed 60s so 1m rollups
 *   yield exact 100-point density) plus live tail samples anchored directly to the exact latest
 *   incoming sample so new data always draws immediately.
 */
export function buildWindowSeries(
  window: TimeWindow,
  history: TrafficPoint[],
  rollupHistory: TrafficPoint[]
): TrafficPoint[] {
  const highRes = sortAndDedupePoints(history);
  const rollups = sortAndDedupePoints(rollupHistory);
  const isLongWindow = window === '3h' || window === '6h';

  if (isLongWindow) {
    if (rollups.length === 0) return highRes;
    const merged = [...rollups];
    const lastRollupTs = merged[merged.length - 1].timestamp;

    // Include ALL recent high-res points newer than the last completed 1m rollup bucket,
    // preserving the exact latest incoming sample un-averaged at the right edge.
    const recentTail = highRes.filter((p) => p.timestamp > lastRollupTs);
    if (recentTail.length > 0) {
      const minuteBuckets = new Map<number, TrafficPoint[]>();
      for (const p of recentTail) {
        const key = Math.floor(p.timestamp / 60_000) * 60_000;
        const list = minuteBuckets.get(key);
        if (list) list.push(p);
        else minuteBuckets.set(key, [p]);
      }
      const bucketKeys = Array.from(minuteBuckets.keys()).sort((a, b) => a - b);
      for (let i = 0; i < bucketKeys.length; i++) {
        const group = minuteBuckets.get(bucketKeys[i])!;
        const isLastBucket = i === bucketKeys.length - 1;
        if (isLastBucket) {
          const latest = group[group.length - 1];
          if (group.length > 1 && latest.timestamp - group[0].timestamp >= 20_000) {
            const earlier = group.slice(0, -1);
            const earlierTs = Math.max(
              lastRollupTs + 1000,
              Math.round(earlier.reduce((s, p) => s + p.timestamp, 0) / earlier.length)
            );
            if (earlierTs > lastRollupTs && earlierTs < latest.timestamp) {
              merged.push(averagePoints(earlier, earlierTs));
            }
          }
          if (latest.timestamp > lastRollupTs) {
            merged.push(latest);
          }
        } else {
          const ts = Math.max(lastRollupTs + 1000, bucketKeys[i]);
          if (ts > lastRollupTs) {
            merged.push(averagePoints(group, ts));
          }
        }
      }
    }
    return sortAndDedupePoints(merged);
  }

  // 5m, 15m, and 1h: prefer high-res history, seamlessly backfilled by earlier rollups.
  if (highRes.length === 0) return rollups;
  if (rollups.length === 0) return highRes;

  const earliestHighRes = highRes[0].timestamp;
  const earlierRollups = rollups.filter((p) => p.timestamp < earliestHighRes);
  return sortAndDedupePoints([...earlierRollups, ...highRes]);
}

/**
 * Shared segmentation and coverage analyzer used identically by both overview and zoomed ranges.
 */
function buildAnalysisFromSeries(
  window: TimeWindow,
  series: TrafficPoint[],
  windowStart: number,
  windowEnd: number,
  gapThreshold: number,
  emptyLabel: string,
  zoomLabel?: string
): TimeWindowAnalysis {
  const windowMs = Math.max(1000, windowEnd - windowStart);
  const points = series.filter((p) => p.timestamp >= windowStart && p.timestamp <= windowEnd);

  // Capture the single point immediately preceding windowStart so the chart line
  // enters flush at the left border without any empty edge gap as time shifts.
  let leadingAnchor: TrafficPoint | null = null;
  if (points.length > 0) {
    for (let i = series.length - 1; i >= 0; i--) {
      const candidate = series[i];
      if (candidate.timestamp < windowStart) {
        if (points[0].timestamp - candidate.timestamp <= gapThreshold) {
          leadingAnchor = candidate;
        }
        break;
      }
    }
  }

  if (points.length === 0) {
    return {
      window,
      windowStart,
      windowEnd,
      status: 'empty',
      points: [],
      segments: [],
      leadingAnchor: null,
      noDataRanges: [{ start: windowStart, end: windowEnd }],
      coveragePct: 0,
      coveredMs: 0,
      missingMs: windowMs,
      summaryText: emptyLabel,
    };
  }

  const noDataRanges: TimeRange[] = [];
  const segments: TrafficPoint[][] = [];
  let currentSegment: TrafficPoint[] = [points[0]];

  const leadingGapThreshold = Math.min(gapThreshold, Math.max(15_000, Math.round(windowMs * 0.03)));
  if (!leadingAnchor && points[0].timestamp - windowStart > leadingGapThreshold) {
    noDataRanges.push({ start: windowStart, end: points[0].timestamp });
  }

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (curr.timestamp - prev.timestamp > gapThreshold) {
      segments.push(currentSegment);
      currentSegment = [curr];
      noDataRanges.push({ start: prev.timestamp, end: curr.timestamp });
    } else {
      currentSegment.push(curr);
    }
  }
  segments.push(currentSegment);

  const lastTs = points[points.length - 1].timestamp;
  if (windowEnd - lastTs > gapThreshold) {
    noDataRanges.push({ start: lastTs, end: windowEnd });
  }

  const missingMs = noDataRanges.reduce((acc, r) => acc + Math.max(0, r.end - r.start), 0);
  const coveredMs = Math.max(0, windowMs - missingMs);
  const coveragePct = Math.max(0, Math.min(100, Math.round((coveredMs / windowMs) * 100)));

  if (noDataRanges.length === 0) {
    return {
      window,
      windowStart,
      windowEnd,
      status: 'full',
      points,
      segments,
      leadingAnchor,
      noDataRanges: [],
      coveragePct: 100,
      coveredMs: windowMs,
      missingMs: 0,
      summaryText: zoomLabel || `Complete data for the last ${window}`,
    };
  }

  const isLeadingOnly =
    noDataRanges.length === 1 &&
    noDataRanges[0].start === windowStart &&
    noDataRanges[0].end === points[0].timestamp;

  const summaryText = zoomLabel
    ? `Zoomed range · ${coveragePct}% data coverage`
    : isLeadingOnly
      ? `Data available for last ${formatDuration(coveredMs / 1000)} · earlier ${formatDuration(missingMs / 1000)} has no data`
      : `${coveragePct}% data coverage · ${noDataRanges.length} no-data ${noDataRanges.length === 1 ? 'period' : 'periods'} denoted`;

  return {
    window,
    windowStart,
    windowEnd,
    status: 'partial',
    points,
    segments,
    leadingAnchor,
    noDataRanges,
    coveragePct,
    coveredMs,
    missingMs,
    summaryText,
  };
}

/**
 * Analyzes data availability and explicit no-data spans for a given time period.
 */
export function analyzeTimeWindow(
  window: TimeWindow,
  history: TrafficPoint[],
  rollupHistory: TrafficPoint[],
  now = Date.now()
): TimeWindowAnalysis {
  const windowMs = WINDOW_MS[window];
  const windowEnd = now;
  const windowStart = windowEnd - windowMs;
  const gapThreshold = GAP_THRESHOLD_MS[window];
  const rawSeries = buildWindowSeries(window, history, rollupHistory);

  return buildAnalysisFromSeries(
    window,
    rawSeries,
    windowStart,
    windowEnd,
    gapThreshold,
    `No data recorded in the last ${window}`
  );
}

export interface SelectionRangeSummary {
  start: number;
  end: number;
  durationSec: number;
  sampleCount: number;
  avgRxBps: number;
  peakRxBps: number;
  avgTxBps: number;
  peakTxBps: number;
  estimatedRxBytes: number;
  estimatedTxBytes: number;
  hasData: boolean;
}

/**
 * Computes average, peak, and estimated transferred bytes across a user-selected time range.
 */
export function summarizeSelectionRange(
  points: TrafficPoint[],
  rawStart: number,
  rawEnd: number
): SelectionRangeSummary {
  const start = Math.min(rawStart, rawEnd);
  const end = Math.max(rawStart, rawEnd);
  const durationSec = Math.max(1, (end - start) / 1000);

  const selected = points.filter((p) => p.timestamp >= start && p.timestamp <= end);
  if (selected.length === 0) {
    return {
      start,
      end,
      durationSec,
      sampleCount: 0,
      avgRxBps: 0,
      peakRxBps: 0,
      avgTxBps: 0,
      peakTxBps: 0,
      estimatedRxBytes: 0,
      estimatedTxBytes: 0,
      hasData: false,
    };
  }

  let sumRx = 0;
  let sumTx = 0;
  let peakRx = 0;
  let peakTx = 0;
  for (const p of selected) {
    sumRx += p.rxBps;
    sumTx += p.txBps;
    if (p.rxBps > peakRx) peakRx = p.rxBps;
    if (p.txBps > peakTx) peakTx = p.txBps;
  }

  const avgRxBps = Math.round(sumRx / selected.length);
  const avgTxBps = Math.round(sumTx / selected.length);

  return {
    start,
    end,
    durationSec,
    sampleCount: selected.length,
    avgRxBps,
    peakRxBps: peakRx,
    avgTxBps,
    peakTxBps: peakTx,
    estimatedRxBytes: Math.round(avgRxBps * durationSec),
    estimatedTxBytes: Math.round(avgTxBps * durationSec),
    hasData: true,
  };
}

/**
 * Slices an existing TimeWindowAnalysis down to a zoomed sub-range [rangeStart, rangeEnd].
 */
export function sliceAnalysisToRange(
  base: TimeWindowAnalysis,
  rawStart: number,
  rawEnd: number
): TimeWindowAnalysis {
  const windowStart = Math.max(base.windowStart, Math.min(rawStart, rawEnd));
  const windowEnd = Math.min(base.windowEnd, Math.max(rawStart, rawEnd));
  const windowMs = Math.max(1000, windowEnd - windowStart);

  return buildAnalysisFromSeries(
    base.window,
    base.points,
    windowStart,
    windowEnd,
    GAP_THRESHOLD_MS[base.window],
    'No data recorded in selected range',
    `Zoomed range (${formatDuration(windowMs / 1000)})`
  );
}

/**
 * Downsamples a single continuous segment into evenly spaced time buckets (~100 points per window).
 * Preserves the exact start timestamp and ALWAYS emits the exact latest incoming point un-averaged
 * at the right edge so live ticks draw immediately as they arrive.
 */
export function downsampleSegment(
  segment: TrafficPoint[],
  bucketMs: number
): TrafficPoint[] {
  if (segment.length <= 2 || bucketMs <= 0) return segment;
  // For native 3s cadence (5m window), return raw ticks directly so jitter never aliases buckets
  if (bucketMs <= 3_000 && segment.length <= 105) return segment;

  const buckets = new Map<number, TrafficPoint[]>();
  for (const p of segment) {
    const key = Math.floor(p.timestamp / bucketMs);
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }

  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  // Never collapse a multi-point continuous segment into a single bucket (which prevents drawing a curve)
  if (keys.length >= segment.length || keys.length < 2) return segment;

  const result: TrafficPoint[] = [];
  for (let i = 0; i < keys.length; i++) {
    const group = buckets.get(keys[i])!;
    const isLastBucket = i === keys.length - 1;

    if (isLastBucket) {
      const latest = group[group.length - 1];
      if (group.length > 1 && latest.timestamp - group[0].timestamp >= bucketMs * 0.45) {
        const earlier = group.slice(0, -1);
        const earlierAvgTs = Math.round(
          earlier.reduce((sum, p) => sum + p.timestamp, 0) / earlier.length
        );
        if (earlierAvgTs < latest.timestamp) {
          result.push(averagePoints(earlier, earlierAvgTs));
        }
      }
      // Emit the exact newest incoming point directly so live spikes/changes always render immediately
      result.push(latest);
      continue;
    }

    let sumTs = 0;
    for (const p of group) sumTs += p.timestamp;

    // Preserve exact start timestamp so left boundary / gap edges stay flush
    const timestamp = i === 0 ? group[0].timestamp : Math.round(sumTs / group.length);
    result.push(averagePoints(group, timestamp));
  }

  return result;
}

/**
 * Normalizes point density consistently across all 5 time windows (~100 data points per chart width):
 * 5m @ 3s, 15m @ 9s, 1h @ 36s, 3h @ 108s, 6h @ 216s.
 * When zoomed in, returns full raw resolution unless the zoomed slice exceeds 240 points.
 */
export function getDisplaySegmentsForAnalysis(
  analysis: TimeWindowAnalysis,
  isZoomed: boolean
): TrafficPoint[][] {
  if (isZoomed) {
    const totalPoints = analysis.segments.reduce((sum, seg) => sum + seg.length, 0);
    if (totalPoints <= 240) {
      return analysis.segments;
    }
    const spanMs = Math.max(1000, analysis.windowEnd - analysis.windowStart);
    const adaptiveBucketMs = Math.max(3_000, Math.floor(spanMs / 100));
    return analysis.segments.map((seg) => downsampleSegment(seg, adaptiveBucketMs));
  }

  const bucketMs = SMOOTH_BUCKET_MS[analysis.window];
  return analysis.segments.map((seg) => downsampleSegment(seg, bucketMs));
}

/**
 * Builds a full-resolution TimeWindowAnalysis for a zoomed sub-range [rawStart, rawEnd],
 * seamlessly merging high-resolution `history` over 1m `rollupHistory` with zero boundary holes.
 */
export function buildZoomedRangeAnalysis(
  base: TimeWindowAnalysis,
  rawStart: number,
  rawEnd: number,
  fullHistory?: TrafficPoint[],
  fullRollupHistory?: TrafficPoint[]
): TimeWindowAnalysis {
  if (!fullHistory && !fullRollupHistory) {
    return sliceAnalysisToRange(base, rawStart, rawEnd);
  }

  const windowStart = Math.max(base.windowStart, Math.min(rawStart, rawEnd));
  const windowEnd = Math.min(base.windowEnd, Math.max(rawStart, rawEnd));
  const windowMs = Math.max(1000, windowEnd - windowStart);

  const highResSorted = sortAndDedupePoints(fullHistory || []);
  const rollupsSorted = sortAndDedupePoints(fullRollupHistory || []);

  // Merge without any -30_000 cutout so zoom view never invents a gap at the rollup/history seam
  let mergedSeries: TrafficPoint[];
  if (highResSorted.length === 0) {
    mergedSeries = rollupsSorted;
  } else if (rollupsSorted.length === 0) {
    mergedSeries = highResSorted;
  } else {
    const earliestHighRes = highResSorted[0].timestamp;
    const earlierRollups = rollupsSorted.filter((p) => p.timestamp < earliestHighRes);
    mergedSeries = sortAndDedupePoints([...earlierRollups, ...highResSorted]);
  }

  return buildAnalysisFromSeries(
    base.window,
    mergedSeries,
    windowStart,
    windowEnd,
    GAP_THRESHOLD_MS[base.window],
    'No data recorded in zoomed range',
    `Zoomed range (${formatDuration(windowMs / 1000)}) · full resolution`
  );
}

export interface PlotPoint {
  x: number;
  y: number;
}

export interface CubicBezierSegment {
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x: number;
  y: number;
}

/**
 * Computes Fritsch-Carlson monotone cubic Hermite spline segments for sorted plot points.
 * Clamps control points cleanly between topY and baselineY and guarantees finite coordinates
 * for every segment including the final trailing segment.
 */
export function computeMonotoneSplineCurves(
  pts: PlotPoint[],
  topY: number,
  baselineY: number
): CubicBezierSegment[] {
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) {
    const dx = (pts[1].x - pts[0].x) / 3;
    const dy = (pts[1].y - pts[0].y) / 3;
    return [
      {
        cp1x: pts[0].x + dx,
        cp1y: Math.min(baselineY, Math.max(topY, pts[0].y + dy)),
        cp2x: pts[1].x - dx,
        cp2y: Math.min(baselineY, Math.max(topY, pts[1].y - dy)),
        x: pts[1].x,
        y: pts[1].y,
      },
    ];
  }

  const dx: number[] = new Array(n - 1);
  const dy: number[] = new Array(n - 1);
  const slopes: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(0.0001, pts[i + 1].x - pts[i].x);
    dy[i] = pts[i + 1].y - pts[i].y;
    slopes[i] = dy[i] / dx[i];
  }

  const tangents: number[] = new Array(n);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) {
      tangents[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangents[i] = (w1 + w2) / (w1 / slopes[i - 1] + w2 / slopes[i]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(slopes[i]) < 1e-6) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const a = tangents[i] / slopes[i];
      const b = tangents[i + 1] / slopes[i];
      const sq = a * a + b * b;
      if (sq > 9) {
        const t = 3 / Math.sqrt(sq);
        tangents[i] = t * a * slopes[i];
        tangents[i + 1] = t * b * slopes[i];
      }
    }
  }

  const curves: CubicBezierSegment[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    const rawCp1y = pts[i].y + tangents[i] * h;
    const rawCp2y = pts[i + 1].y - tangents[i + 1] * h;
    const cp1y = Number.isFinite(rawCp1y)
      ? Math.min(baselineY, Math.max(topY, rawCp1y))
      : pts[i].y;
    const cp2y = Number.isFinite(rawCp2y)
      ? Math.min(baselineY, Math.max(topY, rawCp2y))
      : pts[i + 1].y;
    curves[i] = {
      cp1x: pts[i].x + h,
      cp1y,
      cp2x: pts[i + 1].x - h,
      cp2y,
      x: pts[i + 1].x,
      y: pts[i + 1].y,
    };
  }

  return curves;
}
