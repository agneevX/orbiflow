import type { TimeWindow, TrafficPoint } from '../types/telemetry';
import { formatDuration } from './formatters';

export const ALL_TIME_WINDOWS: TimeWindow[] = ['1m', '5m', '15m', '1h', '6h', '24h'];

export const WINDOW_MS: Record<TimeWindow, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

const GAP_THRESHOLD_MS: Record<TimeWindow, number> = {
  '1m': 20_000,
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
    const merged = [...rollupHistory];
    const lastRollupTs = merged[merged.length - 1].timestamp;
    // Append recent high-res points that fall in the current minute after the last completed 1m bucket
    const recentTail = history.filter((p) => p.timestamp > lastRollupTs + 30_000);
    if (recentTail.length > 0) {
      const avgRx = Math.round(recentTail.reduce((s, p) => s + p.rxBps, 0) / recentTail.length);
      const avgTx = Math.round(recentTail.reduce((s, p) => s + p.txBps, 0) / recentTail.length);
      const avgFlows = Math.round(
        recentTail.reduce((s, p) => s + p.activeFlows, 0) / recentTail.length
      );
      const loadSamples = recentTail.filter((p) => typeof p.routerLoadPct === 'number');
      const avgLoad =
        loadSamples.length > 0
          ? Math.round(
              loadSamples.reduce((s, p) => s + (p.routerLoadPct ?? 0), 0) / loadSamples.length
            )
          : undefined;
      merged.push({
        timestamp: recentTail[recentTail.length - 1].timestamp,
        rxBps: avgRx,
        txBps: avgTx,
        activeFlows: avgFlows,
        ...(avgLoad !== undefined ? { routerLoadPct: avgLoad } : {}),
      });
    }
    return merged.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Short windows (1m, 5m, 15m): prefer high-res history, backfilled by earlier 1m rollups if needed
  if (history.length === 0) {
    return [...rollupHistory].sort((a, b) => a.timestamp - b.timestamp);
  }
  const sortedHighRes = [...history].sort((a, b) => a.timestamp - b.timestamp);
  if (window === '1m' || rollupHistory.length === 0) {
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

  if (!leadingAnchor && points[0].timestamp - windowStart > gapThreshold) {
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

