import assert from 'node:assert/strict';
import test from 'node:test';
import { TrafficMonitorEngine } from './telemetryEngine';
import {
  applyDashboardDelta,
  buildDeltaPayload,
  buildInitPayload,
  parseClientSubscription,
} from './wsProtocol';
import type { TrafficPoint } from '../types/telemetry';

const T0 = 1_700_000_000_000;

function createSampleEngine(): TrafficMonitorEngine {
  const engine = new TrafficMonitorEngine();

  // First sample establishes baseline counters
  engine.ingest({
    probeId: 'test-probe',
    timestamp: T0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 1_000_000, txBytes: 500_000 },
    arp: [
      { ip: '192.168.50.10', mac: 'aa:bb:cc:dd:ee:01', device: 'br0', hostname: 'macbook' },
      { ip: '192.168.50.20', mac: 'aa:bb:cc:dd:ee:02', device: 'br0', hostname: 'appletv' },
    ],
    ports: [
      {
        id: 'lan1',
        label: 'LAN 1',
        role: 'lan',
        linkUp: true,
        speedMbps: 1000,
        rxBytes: 100_000,
        txBytes: 200_000,
        rxBps: 0,
        txBps: 0,
      },
    ],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.50.10',
        dst: '142.250.190.46',
        sport: 54321,
        dport: 443,
        txBytes: 50_000,
        rxBytes: 500_000,
      },
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.50.10',
        dst: '192.168.50.20',
        sport: 54322,
        dport: 8009,
        txBytes: 40_000,
        rxBytes: 80_000,
      },
    ],
  });

  // Second sample (+3s) produces non-zero throughput & clientLinks
  engine.ingest({
    probeId: 'test-probe',
    timestamp: T0 + 3_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 4_000_000, txBytes: 1_100_000 },
    arp: [
      { ip: '192.168.50.10', mac: 'aa:bb:cc:dd:ee:01', device: 'br0', hostname: 'macbook' },
      { ip: '192.168.50.20', mac: 'aa:bb:cc:dd:ee:02', device: 'br0', hostname: 'appletv' },
    ],
    ports: [
      {
        id: 'lan1',
        label: 'LAN 1',
        role: 'lan',
        linkUp: true,
        speedMbps: 1000,
        rxBytes: 400_000,
        txBytes: 800_000,
        rxBps: 100_000,
        txBps: 200_000,
      },
    ],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.50.10',
        dst: '142.250.190.46',
        sport: 54321,
        dport: 443,
        txBytes: 350_000,
        rxBytes: 3_500_000,
      },
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.50.10',
        dst: '192.168.50.20',
        sport: 54322,
        dport: 8009,
        txBytes: 120_000,
        rxBytes: 240_000,
      },
    ],
  });

  return engine;
}

test('parseClientSubscription sanitizes invalid values and defaults safely', () => {
  assert.deepEqual(parseClientSubscription({}), {
    tab: 'overview',
    subTab: 'list',
    visible: true,
  });
  assert.deepEqual(
    parseClientSubscription({ tab: 'invalid', subTab: 'map', visible: '0' }),
    { tab: 'overview', subTab: 'map', visible: false }
  );
  assert.deepEqual(
    parseClientSubscription({ tab: 'flows', subTab: 'other', visible: false }),
    { tab: 'flows', subTab: 'list', visible: false }
  );
});

test('buildInitPayload strips unused fields and scopes heavy arrays to the active view', () => {
  const engine = createSampleEngine();
  const full = engine.getSnapshot();
  const revs = engine.getRevisions();

  assert.ok(full.flows.length > 0, 'full snapshot should have flows');
  assert.ok(full.topology.routerPorts.length > 0, 'full snapshot should have topology');

  // Overview tab omits flows and topology, filters LAN links out of clientLinks, and clears protocols/remotes
  const overviewInit = buildInitPayload(full, revs, {
    tab: 'overview',
    subTab: 'list',
    visible: true,
  });
  assert.equal(overviewInit.payload.protocols.length, 0);
  assert.equal(overviewInit.payload.remotes.length, 0);
  assert.equal(overviewInit.payload.flows.length, 0);
  assert.equal(overviewInit.payload.topology.routerPorts.length, 0);
  assert.ok(overviewInit.payload.clientLinks.length > 0);
  assert.ok(
    overviewInit.payload.clientLinks.every((l) => l.scope !== 'lan'),
    'clientLinks over WS should exclude LAN links'
  );

  // Flows tab includes flows, omits topology & clientLinks
  const flowsInit = buildInitPayload(full, revs, {
    tab: 'flows',
    subTab: 'list',
    visible: true,
  });
  assert.equal(flowsInit.payload.flows.length, full.flows.length);
  assert.equal(flowsInit.payload.topology.routerPorts.length, 0);
  assert.equal(flowsInit.payload.clientLinks.length, 0);

  // Hosts -> Map includes topology, omits flows
  const mapInit = buildInitPayload(full, revs, {
    tab: 'hosts',
    subTab: 'map',
    visible: true,
  });
  assert.equal(mapInit.payload.flows.length, 0);
  assert.equal(mapInit.payload.topology.routerPorts.length, full.topology.routerPorts.length);
});

test('buildDeltaPayload sends only 1-point historyAppend, omits unchanged static slices, and catches up on tab switch', () => {
  const engine = createSampleEngine();
  const { payload: initSnapshot, state } = buildInitPayload(
    engine.getSnapshot(),
    engine.getRevisions(),
    { tab: 'overview', subTab: 'list', visible: true },
    T0 + 3_000
  );

  // No changes -> null delta
  assert.equal(
    buildDeltaPayload(engine.getSnapshot(), engine.getRevisions(), state, {
      now: T0 + 4_000,
    }),
    null
  );

  // Ingest next 3s tick within the SAME minute bucket (T0 + 6_000)
  engine.ingest({
    probeId: 'test-probe',
    timestamp: T0 + 6_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 7_500_000, txBytes: 1_900_000 },
    arp: [
      { ip: '192.168.50.10', mac: 'aa:bb:cc:dd:ee:01', device: 'br0', hostname: 'macbook' },
    ],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.50.10',
        dst: '142.250.190.46',
        sport: 54321,
        dport: 443,
        txBytes: 850_000,
        rxBytes: 7_000_000,
      },
    ],
  });

  const delta1 = buildDeltaPayload(engine.getSnapshot(), engine.getRevisions(), state, {
    now: T0 + 6_000,
  });
  assert.ok(delta1, 'expected a delta on new telemetry tick');
  assert.equal(delta1.historyAppend?.length, 1);
  assert.equal(delta1.historyAppend?.[0].timestamp, T0 + 6_000);
  assert.equal(delta1.historyReplace, undefined);
  assert.equal(delta1.rollupAppend, undefined, 'same-minute tick should not emit rollupAppend');
  assert.equal(delta1.flows, undefined, 'overview tab should not receive flows');
  assert.equal(delta1.topology, undefined, 'overview tab should not receive topology');
  assert.equal(delta1.rules, undefined, 'unchanged rules should be omitted');
  assert.equal(delta1.serverConfig, undefined, 'unchanged serverConfig should be omitted');
  assert.equal(delta1.deviceAliases, undefined, 'unchanged aliases should be omitted');
  assert.ok(Array.isArray(delta1.clientLinks), 'overview tab should receive updated clientLinks');

  const applied1 = applyDashboardDelta(initSnapshot, delta1);
  assert.equal(applied1.history.length, initSnapshot.history.length + 1);
  assert.equal(applied1.rules, initSnapshot.rules, 'unchanged rules must preserve object identity');
  assert.equal(
    applied1.serverConfig,
    initSnapshot.serverConfig,
    'unchanged serverConfig must preserve object identity'
  );

  // Switch tab to Flows -> immediate catch-up sends flows without duplicating history
  state.sub = { tab: 'flows', subTab: 'list', visible: true };
  const switchDelta = buildDeltaPayload(engine.getSnapshot(), engine.getRevisions(), state, {
    now: T0 + 7_000,
  });
  assert.ok(switchDelta);
  assert.ok(Array.isArray(switchDelta.flows) && switchDelta.flows.length > 0);
  assert.equal(switchDelta.historyAppend, undefined);
  assert.equal(switchDelta.clientLinks, undefined);

  // Advance across a minute boundary (+65s) while tab is hidden -> minimal chart + KPIs only
  state.sub = { tab: 'flows', subTab: 'list', visible: false };
  engine.ingest({
    probeId: 'test-probe',
    timestamp: T0 + 71_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 10_500_000, txBytes: 2_400_000 },
    arp: [],
    flows: [],
  });

  const hiddenDelta1 = buildDeltaPayload(engine.getSnapshot(), engine.getRevisions(), state, {
    now: T0 + 71_000,
  });
  assert.ok(hiddenDelta1);
  assert.equal(hiddenDelta1.historyAppend?.length, 1);
  assert.equal(hiddenDelta1.rollupReplace?.length, 1, 'first completed minute should emit rollupReplace');
  assert.equal(hiddenDelta1.flows, undefined, 'hidden tab must not receive flows');
  assert.equal(hiddenDelta1.hosts, undefined, 'hidden tab must not receive hosts');
  assert.equal(hiddenDelta1.clientLinks, undefined, 'hidden tab must not receive clientLinks');
  assert.equal(hiddenDelta1.topology, undefined, 'hidden tab must not receive topology');

  // Advance across a second minute boundary -> incremental 1-point rollupAppend
  engine.ingest({
    probeId: 'test-probe',
    timestamp: T0 + 135_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 12_500_000, txBytes: 2_900_000 },
    arp: [],
    flows: [],
  });

  const hiddenDelta2 = buildDeltaPayload(engine.getSnapshot(), engine.getRevisions(), state, {
    now: T0 + 135_000,
  });
  assert.ok(hiddenDelta2);
  assert.equal(hiddenDelta2.historyAppend?.length, 1);
  assert.equal(hiddenDelta2.rollupAppend?.length, 1, 'subsequent minute flip should emit 1-point rollupAppend');
  assert.equal(hiddenDelta2.rollupReplace, undefined);
});

test('buildDeltaPayload handles needsHistoryResync after backpressure drop', () => {
  const engine = createSampleEngine();
  const { state } = buildInitPayload(engine.getSnapshot(), engine.getRevisions(), {
    tab: 'overview',
    subTab: 'list',
    visible: true,
  });

  state.needsHistoryResync = true;
  const resyncDelta = buildDeltaPayload(engine.getSnapshot(), engine.getRevisions(), state);
  assert.ok(resyncDelta);
  assert.ok(Array.isArray(resyncDelta.historyReplace));
  assert.ok(Array.isArray(resyncDelta.rollupReplace));
  assert.equal(state.needsHistoryResync, false);
});

test('applyDashboardDelta is idempotent on duplicate timestamps and prunes history older than 65m', () => {
  const engine = createSampleEngine();
  const base = engine.getSnapshot();

  const p1: TrafficPoint = {
    timestamp: T0 + 6_000,
    rxBps: 1000,
    txBps: 500,
    activeFlows: 2,
  };
  const after1 = applyDashboardDelta(base, { historyAppend: [p1] });
  const afterDuplicate = applyDashboardDelta(after1, { historyAppend: [p1] });
  assert.equal(afterDuplicate.history.length, after1.history.length);
  assert.equal(
    afterDuplicate.history[afterDuplicate.history.length - 1].timestamp,
    p1.timestamp
  );

  // Jump 70 minutes ahead -> old points >65m should be pruned
  const farPoint: TrafficPoint = {
    timestamp: p1.timestamp + 70 * 60_000,
    rxBps: 2000,
    txBps: 600,
    activeFlows: 1,
  };
  const afterPrune = applyDashboardDelta(afterDuplicate, { historyAppend: [farPoint] });
  assert.equal(afterPrune.history.length, 1);
  assert.equal(afterPrune.history[0].timestamp, farPoint.timestamp);
});
