import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TIME_WINDOWS, analyzeTimeWindow } from './timeWindowUtils';
import type { TrafficPoint } from '../types/telemetry';

test('ALL_TIME_WINDOWS omits 1m and starts at 5m', () => {
  assert.deepEqual(ALL_TIME_WINDOWS, ['5m', '15m', '1h', '6h', '24h']);
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

test('getDisplaySegmentsForAnalysis downsamples 15m+ windows when unzoomed and preserves full points when zoomed or on 5m', async () => {
  const { getDisplaySegmentsForAnalysis, buildZoomedRangeAnalysis } = await import('./timeWindowUtils');
  const now = 1_700_000_000_000;
  const history: TrafficPoint[] = [];
  // 300 high-res samples (every 3s over 15 minutes)
  for (let s = 900; s >= 0; s -= 3) {
    history.push({
      timestamp: now - s * 1000,
      rxBps: 4_000_000 + (s % 30) * 50_000,
      txBps: 800_000 + (s % 15) * 10_000,
      activeFlows: 10,
    });
  }

  const analysis15m = analyzeTimeWindow('15m', history, [], now);
  const overviewSegments = getDisplaySegmentsForAnalysis(analysis15m, false);
  const overviewCount = overviewSegments.flat().length;
  assert.ok(overviewCount < 55, `Expected downsampled 15m points < 55, got ${overviewCount}`);
  assert.ok(overviewCount >= 20, `Expected downsampled 15m points >= 20, got ${overviewCount}`);

  // Zooming into a 3-minute slice restores full 3s resolution (~61 points)
  const zoomed = buildZoomedRangeAnalysis(
    analysis15m,
    now - 180_000,
    now,
    history,
    []
  );
  const zoomedSegments = getDisplaySegmentsForAnalysis(zoomed, true);
  assert.ok(
    zoomedSegments.flat().length >= 58,
    `Expected full-res zoomed points >= 58, got ${zoomedSegments.flat().length}`
  );

  // 5m window keeps full high-res points un-downsampled
  const analysis5m = analyzeTimeWindow('5m', history, [], now);
  const segs5m = getDisplaySegmentsForAnalysis(analysis5m, false);
  assert.equal(segs5m.flat().length, analysis5m.points.length);
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
