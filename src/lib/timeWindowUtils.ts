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

const GAP_THRESHOLD_MS: Record<TimeWindow, number> = {
  '5m': 95_000,
  '15m': 95_000,
  '1h': 150_000,
  '6h': 180_000,
  '24h': 180_000,
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
 * Merges 1-minute rollup buckets and high-resolution history points for a given TimeWindow
 * without inventing samples or extrapolating across gaps.
 */
export function buildWindowSeries(
  window: TimeWindow,
  history: TrafficPoint[],
  rollupHistory: TrafficPoint[]
): TrafficPoint[] {
  const isLongWindow = window === '1h' || window === '6h' || window === '24h';

  if (isLongWindow) {
    if (rollupHistory.length === 0) return [...history].sort((a, b) => a.timestamp - b.timestamp);
    const merged = [...rollupHistory].sort((a, b) => a.timestamp - b.timestamp);
    const lastRollupTs = merged[merged.length - 1].timestamp;
    // Include ALL recent high-res points newer than the last completed 1m rollup bucket,
    // grouped per minute so the right edge always connects smoothly on every live tick
    // without a 30s dead zone or false gap split.
    const recentTail = history
      .filter((p) => p.timestamp > lastRollupTs)
      .sort((a, b) => a.timestamp - b.timestamp);
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
        const avgRx = Math.round(group.reduce((s, p) => s + p.rxBps, 0) / group.length);
        const avgTx = Math.round(group.reduce((s, p) => s + p.txBps, 0) / group.length);
        const avgFlows = Math.round(group.reduce((s, p) => s + p.activeFlows, 0) / group.length);
        const loadSamples = group.filter((p) => typeof p.routerLoadPct === 'number');
        const avgLoad =
          loadSamples.length > 0
            ? Math.round(
                loadSamples.reduce((s, p) => s + (p.routerLoadPct ?? 0), 0) / loadSamples.length
              )
            : undefined;
        // Anchor the newest partial minute to its exact latest live sample timestamp
        const ts =
          i === bucketKeys.length - 1
            ? group[group.length - 1].timestamp
            : Math.max(lastRollupTs + 1000, bucketKeys[i]);
        merged.push({
          timestamp: ts,
          rxBps: avgRx,
          txBps: avgTx,
          activeFlows: avgFlows,
          ...(avgLoad !== undefined ? { routerLoadPct: avgLoad } : {}),
        });
      }
    }
    return merged.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Short windows (5m, 15m): prefer high-res history, backfilled by earlier 1m rollups if needed
  if (history.length === 0) {
    return [...rollupHistory].sort((a, b) => a.timestamp - b.timestamp);
  }
  const sortedHighRes = [...history].sort((a, b) => a.timestamp - b.timestamp);
  if (rollupHistory.length === 0) {
    return sortedHighRes;
  }

  const earliestHighRes = sortedHighRes[0].timestamp;
  const earlierRollups = rollupHistory.filter((p) => p.timestamp < earliestHighRes - 30_000);
  return [...earlierRollups, ...sortedHighRes].sort((a, b) => a.timestamp - b.timestamp);
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
  const points = rawSeries.filter((p) => p.timestamp >= windowStart && p.timestamp <= windowEnd);

  // Capture the single point immediately preceding windowStart so the chart line
  // enters flush at the left border without any empty edge gap as time shifts.
  let leadingAnchor: TrafficPoint | null = null;
  if (points.length > 0) {
    for (let i = rawSeries.length - 1; i >= 0; i--) {
      const candidate = rawSeries[i];
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
      summaryText: `No data recorded in the last ${window}`,
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
      summaryText: `Complete data for the last ${window}`,
    };
  }

  const isLeadingOnly =
    noDataRanges.length === 1 &&
    noDataRanges[0].start === windowStart &&
    noDataRanges[0].end === points[0].timestamp;

  const summaryText = isLeadingOnly
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

  const points = base.points.filter((p) => p.timestamp >= windowStart && p.timestamp <= windowEnd);
  const segments = base.segments
    .map((seg) => seg.filter((p) => p.timestamp >= windowStart && p.timestamp <= windowEnd))
    .filter((seg) => seg.length > 0);

  let leadingAnchor: TrafficPoint | null = null;
  if (points.length > 0) {
    const gapThreshold = GAP_THRESHOLD_MS[base.window];
    for (let i = base.points.length - 1; i >= 0; i--) {
      const candidate = base.points[i];
      if (candidate.timestamp < windowStart) {
        if (points[0].timestamp - candidate.timestamp <= gapThreshold) {
          leadingAnchor = candidate;
        }
        break;
      }
    }
  }

  const noDataRanges: TimeRange[] = [];
  for (const r of base.noDataRanges) {
    const s = Math.max(windowStart, r.start);
    const e = Math.min(windowEnd, r.end);
    if (e > s) noDataRanges.push({ start: s, end: e });
  }

  if (points.length === 0) {
    return {
      ...base,
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
      summaryText: 'No data recorded in selected range',
    };
  }

  const missingMs = noDataRanges.reduce((acc, r) => acc + Math.max(0, r.end - r.start), 0);
  const coveredMs = Math.max(0, windowMs - missingMs);
  const coveragePct = Math.max(0, Math.min(100, Math.round((coveredMs / windowMs) * 100)));

  return {
    ...base,
    windowStart,
    windowEnd,
    status: noDataRanges.length === 0 ? 'full' : 'partial',
    points,
    segments,
    leadingAnchor,
    noDataRanges,
    coveragePct,
    coveredMs,
    missingMs,
    summaryText:
      noDataRanges.length === 0
        ? `Zoomed range (${formatDuration(windowMs / 1000)})`
        : `Zoomed range · ${coveragePct}% data coverage`,
  };
}

/**
 * Target bucket size (ms) for downsampling overview graphs on 15m+ windows.
 * Keeps charts clean and smooth while zooming reveals full un-downsampled resolution.
 */
const SMOOTH_BUCKET_MS: Partial<Record<TimeWindow, number>> = {
  '15m': 25_000,   // ~36 points across 15m
  '1h': 120_000,   // ~30 points across 1h
  '6h': 600_000,   // ~36 points across 6h
  '24h': 1_800_000, // ~48 points across 24h
};

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
    const count = group.length;
    let sumRx = 0;
    let sumTx = 0;
    let sumFlows = 0;
    let sumLoad = 0;
    let loadCount = 0;
    let sumTs = 0;

    for (const p of group) {
      sumRx += p.rxBps;
      sumTx += p.txBps;
      sumFlows += p.activeFlows;
      sumTs += p.timestamp;
      if (typeof p.routerLoadPct === 'number' && Number.isFinite(p.routerLoadPct)) {
        sumLoad += p.routerLoadPct;
        loadCount += 1;
      }
    }

    // Preserve exact start/end timestamps of the segment so gap boundaries stay flush
    const timestamp =
      i === 0
        ? group[0].timestamp
        : i === keys.length - 1
          ? group[group.length - 1].timestamp
          : Math.round(sumTs / count);

    result.push({
      timestamp,
      rxBps: Math.round(sumRx / count),
      txBps: Math.round(sumTx / count),
      activeFlows: Math.round(sumFlows / count),
      ...(loadCount > 0 ? { routerLoadPct: Math.round(sumLoad / loadCount) } : {}),
    });
  }

  return result;
}

/**
 * Reduces point density for 15m and larger overview windows so curves are smooth and uncluttered.
 * Returns original full-resolution segments for 1m/5m or when zoomed in.
 */
export function getDisplaySegmentsForAnalysis(
  analysis: TimeWindowAnalysis,
  isZoomed: boolean
): TrafficPoint[][] {
  if (isZoomed) return analysis.segments;
  const bucketMs = SMOOTH_BUCKET_MS[analysis.window];
  if (!bucketMs) return analysis.segments;
  return analysis.segments.map((seg) => downsampleSegment(seg, bucketMs));
}

/**
 * Builds a full-resolution TimeWindowAnalysis for a zoomed sub-range [rawStart, rawEnd],
 * merging raw high-resolution `history` points whenever available over 1m `rollupHistory`.
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

  const highResSorted = [...(fullHistory || [])].sort((a, b) => a.timestamp - b.timestamp);
  const rollupsSorted = [...(fullRollupHistory || [])].sort((a, b) => a.timestamp - b.timestamp);

  // Merge: prefer full high-res history wherever it covers, backfilled by 1m rollups earlier
  let mergedSeries: TrafficPoint[];
  if (highResSorted.length === 0) {
    mergedSeries = rollupsSorted;
  } else if (rollupsSorted.length === 0) {
    mergedSeries = highResSorted;
  } else {
    const earliestHighRes = highResSorted[0].timestamp;
    const earlierRollups = rollupsSorted.filter((p) => p.timestamp < earliestHighRes - 30_000);
    mergedSeries = [...earlierRollups, ...highResSorted].sort((a, b) => a.timestamp - b.timestamp);
  }

  const points = mergedSeries.filter((p) => p.timestamp >= windowStart && p.timestamp <= windowEnd);
  const gapThreshold = GAP_THRESHOLD_MS[base.window];

  let leadingAnchor: TrafficPoint | null = null;
  if (points.length > 0) {
    for (let i = mergedSeries.length - 1; i >= 0; i--) {
      const candidate = mergedSeries[i];
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
      ...base,
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
      summaryText: 'No data recorded in zoomed range',
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

  return {
    ...base,
    windowStart,
    windowEnd,
    status: noDataRanges.length === 0 ? 'full' : 'partial',
    points,
    segments,
    leadingAnchor,
    noDataRanges,
    coveragePct,
    coveredMs,
    missingMs,
    summaryText:
      noDataRanges.length === 0
        ? `Zoomed range (${formatDuration(windowMs / 1000)}) · full resolution`
        : `Zoomed range · ${coveragePct}% data coverage`,
  };
}
