import type { TimeWindow, TrafficPoint } from '../types/telemetry';
import { formatDuration } from './formatters';

export const ALL_TIME_WINDOWS: TimeWindow[] = ['5m', '15m', '1h', '6h', '24h'];

export const WINDOW_MS: Record<TimeWindow, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

/**
 * Consistent gap thresholds across time windows:
 * - 5m is pure high-res (3s cadence): 90s marks a real outage while tolerating brief reconnects.
 * - 15m and 1h both use 150s so rollup-backed spans and rollup->high-res transitions never produce
 *   phantom gaps on 15m while showing continuous data on 1h.
 * - 6h and 24h use 180s (3 missed 1-minute rollup buckets).
 */
const GAP_THRESHOLD_MS: Record<TimeWindow, number> = {
  '5m': 95_000,
  '15m': 150_000,
  '1h': 150_000,
  '6h': 180_000,
  '24h': 180_000,
};

/**
 * Uniform ~60-bucket visual density across ALL 5 time windows:
 * - 5m  / 5s   = 60 buckets
 * - 15m / 15s  = 60 buckets
 * - 1h  / 60s  = 60 buckets (matches 1-minute rollups 1:1)
 * - 6h  / 6m   = 60 buckets
 * - 24h / 24m  = 60 buckets
 * Every time period renders with consistent smoothness, detail, and proportional rhythm.
 */
export const SMOOTH_BUCKET_MS: Record<TimeWindow, number> = {
  '5m': 5_000,
  '15m': 15_000,
  '1h': 60_000,
  '6h': 360_000,
  '24h': 1_440_000,
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
 * - For short windows (5m, 15m) and zoomed inspection: uses full high-resolution history wherever
 *   available, backfilled cleanly by every 1-minute rollup strictly before `earliestHighRes`.
 * - For long windows (1h, 6h, 24h): uses 1-minute rollups plus 1-minute aggregated tail buckets
 *   from high-res history newer than the last rollup, anchored to the exact latest live sample.
 */
export function buildWindowSeries(
  window: TimeWindow,
  history: TrafficPoint[],
  rollupHistory: TrafficPoint[]
): TrafficPoint[] {
  const highRes = sortAndDedupePoints(history);
  const rollups = sortAndDedupePoints(rollupHistory);
  const isLongWindow = window === '1h' || window === '6h' || window === '24h';

  if (isLongWindow) {
    if (rollups.length === 0) return highRes;
    const merged = [...rollups];
    const lastRollupTs = merged[merged.length - 1].timestamp;

    // Include ALL recent high-res points newer than the last completed 1m rollup bucket,
    // grouped per minute so the right edge always connects smoothly on every live tick.
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
        // Anchor the newest partial minute to its exact latest live sample timestamp;
        // intermediate minutes anchor to their minute floor (strictly > lastRollupTs).
        const ts = isLastBucket
          ? group[group.length - 1].timestamp
          : Math.max(lastRollupTs + 1000, bucketKeys[i]);
        // Avoid replacing the last completed rollup if recentTail still falls in its same minute
        if (ts > lastRollupTs) {
          merged.push(averagePoints(group, ts));
        }
      }
    }
    return sortAndDedupePoints(merged);
  }

  // Short windows (5m, 15m): prefer high-res history, seamlessly backfilled by earlier rollups.
  // Critically: include rollups strictly before earliestHighRes (NO -30_000 cutout that creates false holes!).
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
 * Downsamples a single continuous segment into evenly spaced time buckets,
 * preserving boundary timestamps so clipped chart edges and no-data gaps stay exact.
 */
export function downsampleSegment(
  segment: TrafficPoint[],
  bucketMs: number
): TrafficPoint[] {
  if (segment.length <= 2 || bucketMs <= 0) return segment;

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
    let sumTs = 0;
    for (const p of group) sumTs += p.timestamp;

    // Preserve exact start/end timestamps of the segment so gap boundaries stay flush
    const timestamp =
      i === 0
        ? group[0].timestamp
        : i === keys.length - 1
          ? group[group.length - 1].timestamp
          : Math.round(sumTs / group.length);

    result.push(averagePoints(group, timestamp));
  }

  return result;
}

/**
 * Normalizes point density consistently across all 5 time windows (~60 buckets per chart width).
 * When zoomed in, returns full raw resolution unless the zoomed slice exceeds 180 points,
 * in which case it smoothly adapts to ~90 buckets.
 */
export function getDisplaySegmentsForAnalysis(
  analysis: TimeWindowAnalysis,
  isZoomed: boolean
): TrafficPoint[][] {
  if (isZoomed) {
    const totalPoints = analysis.segments.reduce((sum, seg) => sum + seg.length, 0);
    if (totalPoints <= 180) {
      return analysis.segments;
    }
    const spanMs = Math.max(1000, analysis.windowEnd - analysis.windowStart);
    const adaptiveBucketMs = Math.max(3_000, Math.floor(spanMs / 90));
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
