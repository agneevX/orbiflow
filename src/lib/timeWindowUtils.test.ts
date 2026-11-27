import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TIME_WINDOWS, analyzeTimeWindow } from './timeWindowUtils';
import type { TrafficPoint } from '../types/telemetry';

test('ALL_TIME_WINDOWS covers 5m, 15m, 1h, 3h, and 6h', () => {
  assert.deepEqual(ALL_TIME_WINDOWS, ['5m', '15m', '1h', '3h', '6h']);
});

test('analyzeTimeWindow returns empty status when no samples fall in the window', () => {
  const now = 1_700_000_000_000;
  const oldPoints: TrafficPoint[] = [
    { timestamp: now - 400_000, rxBps: 1000, txBps: 500, activeFlows: 3 },
  ];

  const res = analyzeTimeWindow('5m', oldPoints, [], now);
  assert.equal(res.status, 'empty');
  assert.equal(res.points.length, 0);
  assert.equal(res.coveragePct, 0);
  assert.equal(res.noDataRanges.length, 1);
  assert.equal(res.noDataRanges[0].start, now - 300_000);
  assert.equal(res.noDataRanges[0].end, now);
  assert.match(res.summaryText, /No data recorded/i);
});

test('analyzeTimeWindow detects leading no-data period for 6h window with 3h of rollup history', () => {
  const now = 1_700_000_000_000;
  const rollups: TrafficPoint[] = [];
  // 180 minutes of 1-minute samples ending 30s ago
  for (let m = 180; m >= 1; m--) {
    rollups.push({
      timestamp: now - m * 60_000,
      rxBps: 5_000_000,
      txBps: 1_000_000,
      activeFlows: 10,
    });
  }

  const res = analyzeTimeWindow('6h', [], rollups, now);
  assert.equal(res.status, 'partial');
  assert.equal(res.segments.length, 1);
  assert.equal(res.noDataRanges.length, 1);
  assert.equal(res.noDataRanges[0].start, now - 6 * 3600_000);
  assert.equal(res.noDataRanges[0].end, now - 180 * 60_000);
  assert.equal(res.coveragePct, 50);
  assert.match(res.summaryText, /no data/i);
});

test('analyzeTimeWindow splits internal gaps into separate line segments and no-data ranges', () => {
  const now = 1_700_000_000_000;
  const history: TrafficPoint[] = [
    { timestamp: now - 290_000, rxBps: 1_000_000, txBps: 200_000, activeFlows: 5 },
    { timestamp: now - 280_000, rxBps: 1_100_000, txBps: 220_000, activeFlows: 5 },
    // 180s gap (> 30s threshold for 5m window)
    { timestamp: now - 100_000, rxBps: 2_000_000, txBps: 300_000, activeFlows: 7 },
    { timestamp: now - 5_000, rxBps: 2_100_000, txBps: 310_000, activeFlows: 7 },
  ];

  const res = analyzeTimeWindow('5m', history, [], now);
  assert.equal(res.status, 'partial');
  assert.equal(res.segments.length, 2);
  assert.equal(res.segments[0].length, 2);
  assert.equal(res.segments[1].length, 2);
  assert.equal(res.noDataRanges.length, 1);
  assert.equal(res.noDataRanges[0].start, now - 280_000);
  assert.equal(res.noDataRanges[0].end, now - 100_000);
});

test('analyzeTimeWindow returns full status when samples continuously cover the window', () => {
  const now = 1_700_000_000_000;
  const history: TrafficPoint[] = [];
  for (let s = 295; s >= 0; s -= 5) {
    history.push({
      timestamp: now - s * 1000,
      rxBps: 4_000_000,
      txBps: 800_000,
      activeFlows: 12,
    });
  }

  const res = analyzeTimeWindow('5m', history, [], now);
  assert.equal(res.status, 'full');
  assert.equal(res.coveragePct, 100);
  assert.equal(res.noDataRanges.length, 0);
  assert.equal(res.segments.length, 1);
});

test('summarizeSelectionRange calculates average, peak, and estimated volume for selected points', async () => {
  const { summarizeSelectionRange } = await import('./timeWindowUtils');
  const now = 1_700_000_000_000;
  const points: TrafficPoint[] = [
    { timestamp: now - 30_000, rxBps: 1_000_000, txBps: 200_000, activeFlows: 5 },
    { timestamp: now - 20_000, rxBps: 3_000_000, txBps: 400_000, activeFlows: 6 },
    { timestamp: now - 10_000, rxBps: 2_000_000, txBps: 600_000, activeFlows: 7 },
  ];

  const summary = summarizeSelectionRange(points, now - 30_000, now - 10_000);
  assert.equal(summary.hasData, true);
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.avgRxBps, 2_000_000);
  assert.equal(summary.peakRxBps, 3_000_000);
  assert.equal(summary.avgTxBps, 400_000);
  assert.equal(summary.peakTxBps, 600_000);
  assert.equal(summary.estimatedRxBytes, 40_000_000);

  const empty = summarizeSelectionRange(points, now - 60_000, now - 40_000);
  assert.equal(empty.hasData, false);
  assert.equal(empty.sampleCount, 0);
});

test('analyzeTimeWindow populates leadingAnchor when a sample immediately precedes windowStart', () => {
  const now = 1_700_000_000_000;

  // Continuous leading edge (3s before 5m windowStart -> leadingAnchor captured)
  const continuous: TrafficPoint[] = [];
  for (let s = 306; s >= 0; s -= 3) {
    continuous.push({
      timestamp: now - s * 1000,
      rxBps: 2_000_000,
      txBps: 400_000,
      activeFlows: 6,
      routerLoadPct: 32,
    });
  }
  const fullRes = analyzeTimeWindow('5m', continuous, [], now);
  assert.equal(fullRes.status, 'full');
  assert.ok(fullRes.leadingAnchor);
  assert.equal(fullRes.leadingAnchor?.timestamp, now - 303_000);
  assert.equal(fullRes.noDataRanges.length, 0);

  // Leading sample separated by > 5m gapThreshold (125s before first in-window sample) is NOT used as leadingAnchor
  const gappedHistory: TrafficPoint[] = [
    { timestamp: now - 420_000, rxBps: 1_000_000, txBps: 100_000, activeFlows: 2 },
    { timestamp: now - 295_000, rxBps: 2_000_000, txBps: 200_000, activeFlows: 4 },
    { timestamp: now, rxBps: 2_200_000, txBps: 250_000, activeFlows: 5 },
  ];
  const gappedRes = analyzeTimeWindow('5m', gappedHistory, [], now);
  assert.equal(gappedRes.leadingAnchor, null);
});

test('getDisplaySegmentsForAnalysis produces consistent ~100-point dynamic density across all 5 windows and full resolution when zoomed', async () => {
  const { getDisplaySegmentsForAnalysis, buildZoomedRangeAnalysis, SMOOTH_BUCKET_MS } = await import(
    './timeWindowUtils'
  );
  const now = 1_700_000_000_000;
  const history: TrafficPoint[] = [];
  // 1,220 high-res samples (every 3s over 61 minutes — covers 5m, 15m, and 1h)
  for (let s = 3660; s >= 0; s -= 3) {
    history.push({
      timestamp: now - s * 1000,
      rxBps: 4_000_000 + (s % 30) * 50_000,
      txBps: 800_000 + (s % 15) * 10_000,
      activeFlows: 10,
    });
  }
  // 6h of 1-minute rollups
  const rollups: TrafficPoint[] = [];
  for (let m = 360; m >= 1; m--) {
    rollups.push({
      timestamp: now - m * 60_000,
      rxBps: 3_500_000 + (m % 20) * 40_000,
      txBps: 700_000 + (m % 10) * 10_000,
      activeFlows: 9,
    });
  }

  // Every single time window targets ~100 points (97..104 points across full window)
  const counts: number[] = [];
  for (const win of ['5m', '15m', '1h', '3h', '6h'] as const) {
    const analysis = analyzeTimeWindow(win, history, rollups, now);
    assert.equal(analysis.status, 'full', `Expected ${win} to have full coverage`);
    assert.equal(analysis.segments.length, 1, `Expected ${win} to have 1 continuous segment`);
    const segs = getDisplaySegmentsForAnalysis(analysis, false);
    const count = segs.flat().length;
    counts.push(count);
    assert.ok(
      count >= 97 && count <= 104,
      `Expected consistent ~100 points on ${win} (bucket=${SMOOTH_BUCKET_MS[win]}ms), got ${count}`
    );
  }
  assert.ok(
    Math.max(...counts) - Math.min(...counts) <= 6,
    `Expected all 5 windows to share tight 100-point density spread, got ${counts.join(', ')}`
  );

  // Zooming into a 3-minute slice restores full 3s resolution (~61 points)
  const analysis15m = analyzeTimeWindow('15m', history, rollups, now);
  const zoomed = buildZoomedRangeAnalysis(analysis15m, now - 180_000, now, history, rollups);
  const zoomedSegments = getDisplaySegmentsForAnalysis(zoomed, true);
  assert.ok(
    zoomedSegments.flat().length >= 58,
    `Expected full-res zoomed points >= 58, got ${zoomedSegments.flat().length}`
  );
});

test('getDisplaySegmentsForAnalysis always preserves the exact latest incoming live data point un-averaged across every window', async () => {
  const { getDisplaySegmentsForAnalysis } = await import('./timeWindowUtils');
  const now = 1_700_000_000_000;
  const rollups: TrafficPoint[] = [];
  for (let m = 360; m >= 2; m--) {
    rollups.push({
      timestamp: now - m * 60_000,
      rxBps: 2_000_000,
      txBps: 400_000,
      activeFlows: 8,
    });
  }
  const history: TrafficPoint[] = [];
  for (let s = 3600; s >= 3; s -= 3) {
    history.push({
      timestamp: now - s * 1000,
      rxBps: 2_000_000,
      txBps: 400_000,
      activeFlows: 8,
    });
  }
  // Newest incoming live spike arrives at `now`
  const liveSpike: TrafficPoint = {
    timestamp: now,
    rxBps: 18_750_000,
    txBps: 4_250_000,
    activeFlows: 24,
  };
  history.push(liveSpike);

  for (const win of ['5m', '15m', '1h', '3h', '6h'] as const) {
    const analysis = analyzeTimeWindow(win, history, rollups, now);
    const plotted = getDisplaySegmentsForAnalysis(analysis, false).flat();
    const last = plotted[plotted.length - 1];
    assert.equal(last.timestamp, liveSpike.timestamp, `Expected exact latest timestamp on ${win}`);
    assert.equal(last.rxBps, liveSpike.rxBps, `Expected un-averaged live rxBps on ${win}`);
    assert.equal(last.txBps, liveSpike.txBps, `Expected un-averaged live txBps on ${win}`);
  }
});

test('analyzeTimeWindow stitches rollupHistory into high-res history on 15m with zero false gap at the seam', () => {
  const now = 1_700_000_000_000;
  // 20 minutes of 1m rollups ending 6 minutes ago
  const rollups: TrafficPoint[] = [];
  for (let m = 20; m >= 6; m--) {
    rollups.push({
      timestamp: now - m * 60_000,
      rxBps: 2_500_000,
      txBps: 450_000,
      activeFlows: 8,
    });
  }
  // High-res 3s history starting 5m30s ago (just 30s after the last rollup — previously dropped by -30_000!)
  const history: TrafficPoint[] = [];
  for (let s = 330; s >= 0; s -= 3) {
    history.push({
      timestamp: now - s * 1000,
      rxBps: 2_800_000,
      txBps: 500_000,
      activeFlows: 9,
    });
  }

  const res15m = analyzeTimeWindow('15m', history, rollups, now);
  assert.equal(res15m.status, 'full');
  assert.equal(res15m.segments.length, 1);
  assert.equal(res15m.noDataRanges.length, 0);

  const res1h = analyzeTimeWindow('1h', history, rollups, now);
  assert.equal(res1h.segments.length, 1);
});

test('analyzeTimeWindow stitches all live history points newer than last rollup so right edge connects seamlessly', () => {
  const now = 1_700_000_000_000;
  // 1-minute rollups up to 90s ago
  const rollups: TrafficPoint[] = [];
  for (let m = 60; m >= 2; m--) {
    rollups.push({
      timestamp: now - m * 60_000,
      rxBps: 2_000_000,
      txBps: 500_000,
      activeFlows: 8,
    });
  }
  // Live 3s history continuing all the way to `now` (spanning 2 newer minutes beyond rollups)
  const history: TrafficPoint[] = [];
  for (let s = 120; s >= 0; s -= 3) {
    history.push({
      timestamp: now - s * 1000,
      rxBps: 3_000_000,
      txBps: 700_000,
      activeFlows: 10,
    });
  }

  const res = analyzeTimeWindow('1h', history, rollups, now);
  assert.equal(res.segments.length, 1);
  assert.equal(res.noDataRanges.length, 0);
  const lastPoint = res.points[res.points.length - 1];
  assert.equal(lastPoint.timestamp, now);
});

test('getDisplaySegmentsForAnalysis preserves >=2 endpoints when live segment is shorter than bucket size on 15m/1h windows', async () => {
  const { getDisplaySegmentsForAnalysis } = await import('./timeWindowUtils');
  const now = 1_700_000_000_000;
  // Fresh boot with only 4 live samples (every 3s = 9s span, much smaller than 15m 15s bucket)
  const freshLive: TrafficPoint[] = [
    { timestamp: now - 9_000, rxBps: 1_000_000, txBps: 200_000, activeFlows: 4 },
    { timestamp: now - 6_000, rxBps: 1_500_000, txBps: 250_000, activeFlows: 5 },
    { timestamp: now - 3_000, rxBps: 1_200_000, txBps: 220_000, activeFlows: 5 },
    { timestamp: now, rxBps: 2_000_000, txBps: 300_000, activeFlows: 6 },
  ];

  for (const win of ['5m', '15m', '1h', '3h', '6h'] as const) {
    const analysis = analyzeTimeWindow(win, freshLive, [], now);
    const segs = getDisplaySegmentsForAnalysis(analysis, false);
    assert.equal(segs.length, 1);
    assert.ok(
      segs[0].length >= 2,
      `Expected >=2 drawable points on ${win} for 4 live samples, got ${segs[0].length}`
    );
    assert.equal(segs[0][0].timestamp, freshLive[0].timestamp);
    assert.equal(segs[0][segs[0].length - 1].timestamp, freshLive[freshLive.length - 1].timestamp);
  }
});

test('computeMonotoneSplineCurves produces finite bezier segments connecting through the final data point', async () => {
  const { computeMonotoneSplineCurves } = await import('./timeWindowUtils');
  for (const count of [2, 3, 10, 100]) {
    const pts = Array.from({ length: count }, (_, i) => ({
      x: 60 + i * 8.32,
      y: 120 + Math.sin(i * 0.7) * 55,
    }));
    const curves = computeMonotoneSplineCurves(pts, 12, 224);
    assert.equal(curves.length, count - 1);
    for (let i = 0; i < curves.length; i++) {
      const c = curves[i];
      assert.ok(Number.isFinite(c.cp1x), `cp1x finite at ${i}`);
      assert.ok(Number.isFinite(c.cp1y), `cp1y finite at ${i}`);
      assert.ok(Number.isFinite(c.cp2x), `cp2x finite at ${i}`);
      assert.ok(Number.isFinite(c.cp2y), `cp2y finite at ${i}`);
      assert.ok(c.cp1y >= 12 && c.cp1y <= 224, `cp1y clamped at ${i}`);
      assert.ok(c.cp2y >= 12 && c.cp2y <= 224, `cp2y clamped at ${i}`);
      assert.equal(c.x, pts[i + 1].x);
      assert.equal(c.y, pts[i + 1].y);
    }
    const last = curves[curves.length - 1];
    assert.equal(last.x, pts[pts.length - 1].x);
    assert.equal(last.y, pts[pts.length - 1].y);
  }
});


