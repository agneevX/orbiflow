import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TrafficMonitorEngine,
  exportFlowsToCsv,
  parseProcConntrackLines,
} from './telemetryEngine';
import { RdnsCache } from '../../server/rdnsCache';

test('parseProcConntrackLines parses Linux 3.14 TCP and UDP nf_conntrack records', () => {
  const lines = [
    'ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.1.42 dst=23.246.18.145 sport=52314 dport=443 packets=142 bytes=18420 src=23.246.18.145 dst=73.45.12.88 sport=443 dport=52314 packets=210 bytes=198430 [ASSURED] mark=0 zone=0 use=2',
    'ipv4     2 udp      17 179 src=192.168.1.15 dst=1.1.1.1 sport=41920 dport=53 packets=2 bytes=136 src=1.1.1.1 dst=73.45.12.88 sport=53 dport=41920 packets=2 bytes=256 [ASSURED] mark=0 zone=0 use=2',
  ];

  const parsed = parseProcConntrackLines(lines);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].proto, 'tcp');
  assert.equal(parsed[0].state, 'ESTABLISHED');
  assert.equal(parsed[0].txBytes, 18420);
  assert.equal(parsed[0].rxBytes, 198430);
  assert.equal(parsed[1].proto, 'udp');
  assert.equal(parsed[1].dport, 53);
});

test('TrafficMonitorEngine builds client-destination flow links, 1m rollups, and alerts', () => {
  const engine = new TrafficMonitorEngine();
  engine.updateRules([
    {
      id: 'rule-rx',
      name: 'High Rx',
      metric: 'wan_rx_mbps',
      threshold: 50,
      enabled: true,
    },
  ]);

  const t0 = 1_700_000_000_000;
  engine.ingest({
    probeId: 'orbi-rbk50',
    timestamp: t0,
    source: 'live',
    iface: {
      iface: 'eth0',
      rxBytes: 1_000_000,
      txBytes: 500_000,
    },
    arp: [
      {
        ip: '192.168.1.42',
        mac: 'aa:bb:cc:dd:ee:01',
        device: 'br0',
        hostname: 'livingroom-atv',
        vendor: 'Apple TV',
      },
    ],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.42',
        dst: '23.246.18.145',
        sport: 52000,
        dport: 443,
        txBytes: 10_000,
        rxBytes: 100_000,
      },
    ],
  });

  // 5 seconds later: +50 MB rx => 80 Mbps (triggers > 50 Mbps alert)
  const { dashboard, newAlerts } = engine.ingest({
    probeId: 'orbi-rbk50',
    timestamp: t0 + 5_000,
    source: 'live',
    iface: {
      iface: 'eth0',
      rxBytes: 51_000_000,
      txBytes: 5_500_000,
    },
    arp: [
      {
        ip: '192.168.1.42',
        mac: 'aa:bb:cc:dd:ee:01',
        device: 'br0',
        hostname: 'livingroom-atv',
        vendor: 'Apple TV',
      },
    ],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.42',
        dst: '23.246.18.145',
        sport: 52000,
        dport: 443,
        txBytes: 5_010_000,
        rxBytes: 50_100_000,
      },
    ],
  });

  assert.equal(dashboard.kpis.rxBps, 10_000_000);
  assert.equal(dashboard.kpis.txBps, 1_000_000);
  assert.equal(dashboard.kpis.combinedBps, 11_000_000);
  assert.equal(dashboard.clientLinks.length, 1);
  assert.equal(dashboard.clientLinks[0].clientName, 'livingroom-atv');
  assert.equal(dashboard.clientLinks[0].service, 'Netflix');
  assert.equal(newAlerts.length, 1);

  // Trigger a minute rollup on t0 + 65s
  const { dashboard: d3 } = engine.ingest({
    probeId: 'orbi-rbk50',
    timestamp: t0 + 65_000,
    source: 'live',
    iface: {
      iface: 'eth0',
      rxBytes: 61_000_000,
      txBytes: 6_500_000,
    },
    arp: [],
    flows: [],
  });
  assert.equal(d3.rollupHistory.length, 1);

  const csv = exportFlowsToCsv(dashboard.flows);
  assert.ok(csv.includes('Netflix'));
  assert.ok(!csv.includes('Packets'));
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../server/storage';

test('RdnsCache caches entries, skips private IPs, and respects disabled config', () => {
  const cache = new RdnsCache({ enabled: false, ttlSec: 60, skipPrivate: true });
  assert.equal(cache.lookup('192.168.1.5'), null);
  assert.equal(cache.lookup('8.8.8.8'), null);
  assert.equal(cache.getStats().misses, 0);

  cache.setEntry('8.8.8.8', 'dns.google');
  assert.equal(cache.lookup('8.8.8.8'), 'dns.google');
  assert.equal(cache.getStats().hits, 1);
});

test('PersistenceStore saves user config in configDir and supports changing cacheDir', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbiflow-storage-'));
  const cfgDir = path.join(tmpRoot, 'config');
  const cacheDir1 = path.join(cfgDir, 'cache');
  const cacheDir2 = path.join(tmpRoot, 'custom-cache');

  try {
    const store = new PersistenceStore('memory', cfgDir, cacheDir1);
    assert.equal(store.getConfigPath(), path.join(cfgDir, 'config.json'));
    assert.equal(store.getActiveCacheDir(), cacheDir1);

    store.saveUserConfig({
      probeToken: 'custom-router-token',
      simulatorEnabled: false,
      persistenceMode: 'disk',
      cacheDir: cacheDir2,
      rdnsEnabled: true,
      rdnsTtlSec: 1800,
      rdnsSkipPrivate: true,
    });

    const reloaded = store.loadUserConfig();
    assert.ok(reloaded);
    assert.equal(reloaded?.probeToken, 'custom-router-token');
    assert.equal(reloaded?.simulatorEnabled, false);
    assert.equal(reloaded?.persistenceMode, 'disk');
    assert.equal(reloaded?.cacheDir, cacheDir2);
    assert.equal(reloaded?.rdnsEnabled, true);

    store.setCacheDir(cacheDir2);
    store.setMode('disk');
    store.appendSnapshotLog({
      timestamp: Date.now(),
      rxBps: 1000,
      txBps: 500,
      activeFlows: 3,
      source: 'live',
    });

    assert.ok(fs.existsSync(path.join(cacheDir2, 'traffic-snapshots.jsonl')));
    assert.ok(store.getStats().diskLogSizeBytes > 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

import { generateDockerCompose, generateInitScript, generatePythonProbe } from './probeTemplates';

test('generateDockerCompose only includes PUID, PGID, and TZ environment variables', () => {
  const yaml = generateDockerCompose();
  assert.ok(yaml.includes('- PUID=1000'));
  assert.ok(yaml.includes('- PGID=1000'));
  assert.ok(yaml.includes('- TZ=UTC'));
  assert.ok(!yaml.includes('ORBIFLOW_'));
  assert.ok(!yaml.includes('NODE_ENV'));
  assert.ok(!yaml.includes('PORT='));
});

test('generatePythonProbe avoids urllib and idna so it runs on Entware python3-light', () => {
  const py = generatePythonProbe({
    wsUrl: 'ws://192.168.1.10:3000/ws/ingest',
    httpUrl: 'http://192.168.1.10:3000/api/ingest',
    token: 'test-token',
    iface: 'eth0',
    intervalSec: 5,
    probeId: 'router-eth0',
  });
  assert.ok(!py.includes('urllib'));
  assert.ok(!py.includes('socket.create_connection'));
  assert.ok(py.includes('def parse_ws_url('));
  assert.ok(py.includes('def create_tcp_connection('));
});

import { generateRandomProbeToken, LEGACY_STATIC_PROBE_TOKEN } from '../../server/storage';
import { NotificationDispatcher } from '../../server/notifications';

test('generateRandomProbeToken produces unique cryptographically random tokens', () => {
  const t1 = generateRandomProbeToken();
  const t2 = generateRandomProbeToken();
  assert.notEqual(t1, t2);
  assert.notEqual(t1, LEGACY_STATIC_PROBE_TOKEN);
  assert.match(t1, /^of_[a-f0-9]{48}$/);
});

test('TrafficMonitorEngine triggers expanded alert rules (combined, host rx/tx, new_device, agent_offline, router load/mem)', () => {
  const engine = new TrafficMonitorEngine();
  engine.updateRules([
    { id: 'r-comb', name: 'High Combined', metric: 'wan_combined_mbps', threshold: 40, enabled: true },
    { id: 'r-hrx', name: 'Host Download Spike', metric: 'host_rx_mbps', threshold: 25, enabled: true },
    { id: 'r-new', name: 'New Device', metric: 'new_device', threshold: 1, enabled: true },
    { id: 'r-off', name: 'Agent Offline', metric: 'agent_offline', threshold: 1, enabled: true },
    { id: 'r-load', name: 'Router Load', metric: 'router_high_load', threshold: 1.5, enabled: true },
    { id: 'r-mem', name: 'Router Mem', metric: 'router_high_mem', threshold: 80, enabled: true },
  ]);

  const t0 = 1_710_000_000_000;
  // Snapshot 1 establishes baseline devices (no new_device alert on first snapshot)
  const res1 = engine.ingest({
    probeId: 'router-wan',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 0, txBytes: 0 },
    arp: [{ ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:10', device: 'br0', hostname: 'laptop' }],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.10',
        dst: '1.1.1.1',
        sport: 50000,
        dport: 443,
        txBytes: 0,
        rxBytes: 0,
      },
    ],
    system: {
      hostname: 'router',
      kernel: '6.6',
      arch: 'arm64',
      uptimeSec: 1000,
      load1m: 0.4,
      memUsedPct: 30,
      conntrackCount: 10,
      conntrackMax: 32768,
    },
  });
  assert.equal(res1.newAlerts.length, 0);

  // Snapshot 2 introduces a brand-new device, high combined/host bandwidth, high CPU load, and high memory
  const res2 = engine.ingest({
    probeId: 'router-wan',
    timestamp: t0 + 5_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 30_000_000, txBytes: 5_000_000 },
    arp: [
      { ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:10', device: 'br0', hostname: 'laptop' },
      { ip: '192.168.1.99', mac: 'aa:bb:cc:dd:ee:99', device: 'br0', hostname: 'guest-phone' },
    ],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.10',
        dst: '1.1.1.1',
        sport: 50000,
        dport: 443,
        txBytes: 1_000_000,
        rxBytes: 25_000_000,
      },
    ],
    system: {
      hostname: 'router',
      kernel: '6.6',
      arch: 'arm64',
      uptimeSec: 1005,
      load1m: 2.3,
      memUsedPct: 88,
      conntrackCount: 20,
      conntrackMax: 32768,
    },
  });

  const firedIds = new Set(res2.newAlerts.map((a) => a.ruleId));
  assert.ok(firedIds.has('r-comb'), 'expected wan_combined_mbps alert');
  assert.ok(firedIds.has('r-hrx'), 'expected host_rx_mbps alert');
  assert.ok(firedIds.has('r-new'), 'expected new_device alert');
  assert.ok(firedIds.has('r-load'), 'expected router_high_load alert');
  assert.ok(firedIds.has('r-mem'), 'expected router_high_mem alert');

  // Disconnect triggers agent_offline alert
  const offlineAlerts = engine.markProbeDisconnected('router-wan');
  assert.equal(offlineAlerts.length, 1);
  assert.equal(offlineAlerts[0].ruleId, 'r-off');
});

test('NotificationDispatcher sends formatted payloads to ntfy and Telegram and validates missing fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const dispatcher = new NotificationDispatcher(
    {
      ntfy: {
        enabled: true,
        serverUrl: 'https://ntfy.example.com/',
        topic: 'orbiflow-home',
        token: 'tk_secret123',
        priority: 'high',
      },
      telegram: {
        enabled: true,
        botToken: '12345:BOTTOKEN',
        chatId: '-100999',
      },
    },
    fakeFetch
  );

  const sampleAlert = {
    id: 'al-1',
    ruleId: 'r-1',
    ruleName: 'High Download Usage',
    severity: 'warning' as const,
    message: 'Download speed reached 250 Mbps (threshold 200 Mbps)',
    value: 250,
    threshold: 200,
    timestamp: 1_710_000_000_000,
    acknowledged: false,
  };

  const results = await dispatcher.dispatchAlert(sampleAlert);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.equal(calls.length, 2);

  // Verify ntfy request
  assert.equal(calls[0].url, 'https://ntfy.example.com/orbiflow-home');
  const ntfyHeaders = calls[0].init.headers as Record<string, string>;
  assert.equal(ntfyHeaders.Authorization, 'Bearer tk_secret123');
  assert.equal(ntfyHeaders.Priority, 'high');
  assert.ok(ntfyHeaders.Title.includes('High Download Usage'));

  // Verify Telegram request
  assert.equal(calls[1].url, 'https://api.telegram.org/bot12345:BOTTOKEN/sendMessage');
  const tgBody = JSON.parse(String(calls[1].init.body));
  assert.equal(tgBody.chat_id, '-100999');
  assert.equal(tgBody.parse_mode, 'HTML');
  assert.ok(tgBody.text.includes('High Download Usage'));

  // Missing topic returns validation error without calling fetch
  const badNtfy = await dispatcher.sendNtfy(sampleAlert, {
    enabled: true,
    serverUrl: 'https://ntfy.example.com',
    topic: '',
    token: '',
    priority: 'default',
  });
  assert.equal(badNtfy.ok, false);
  assert.equal(calls.length, 2);
});

test('TrafficMonitorEngine drops closing flows, categorizes via rDNS, and excludes idle 0 B/s flows from active summaries', () => {
  const engine = new TrafficMonitorEngine();
  const rdnsMap: Record<string, string> = {
    '198.51.100.10': 'rr2---sn-example.googlevideo.com',
    '198.51.100.20': 'idle-node.example.com',
  };
  const rdnsLookup = (ip: string) => rdnsMap[ip] ?? null;

  const t0 = 1_720_000_000_000;
  engine.ingest(
    {
      probeId: 'router-eth0',
      timestamp: t0,
      source: 'live',
      iface: { iface: 'eth0', rxBytes: 1_000, txBytes: 500 },
      arp: [
        { ip: '192.168.1.42', mac: 'aa:bb:cc:dd:ee:42', device: 'br0', hostname: 'apple-tv' },
        { ip: '192.168.1.84', mac: 'aa:bb:cc:dd:ee:84', device: 'br0', hostname: 'idle-sensor' },
      ],
      flows: [
        {
          proto: 'tcp',
          state: 'ESTABLISHED',
          src: '192.168.1.42',
          dst: '198.51.100.10',
          sport: 50001,
          dport: 443,
          txBytes: 1_000,
          rxBytes: 10_000,
        },
        {
          proto: 'tcp',
          state: 'ESTABLISHED',
          src: '192.168.1.84',
          dst: '198.51.100.20',
          sport: 50002,
          dport: 443,
          txBytes: 500,
          rxBytes: 500,
        },
        {
          proto: 'tcp',
          state: 'TIME_WAIT',
          src: '192.168.1.42',
          dst: '151.101.65.140',
          sport: 50003,
          dport: 443,
          txBytes: 2_000,
          rxBytes: 8_000,
        },
      ],
    },
    rdnsLookup
  );

  // 1 second later: apple-tv downloads 1 MB/s from YouTube, idle-sensor transfers 0 bytes, TIME_WAIT still present
  const { dashboard } = engine.ingest(
    {
      probeId: 'router-eth0',
      timestamp: t0 + 1_000,
      source: 'live',
      iface: { iface: 'eth0', rxBytes: 1_001_000, txBytes: 50_500 },
      arp: [
        { ip: '192.168.1.42', mac: 'aa:bb:cc:dd:ee:42', device: 'br0', hostname: 'apple-tv' },
        { ip: '192.168.1.84', mac: 'aa:bb:cc:dd:ee:84', device: 'br0', hostname: 'idle-sensor' },
      ],
      flows: [
        {
          proto: 'tcp',
          state: 'ESTABLISHED',
          src: '192.168.1.42',
          dst: '198.51.100.10',
          sport: 50001,
          dport: 443,
          txBytes: 51_000,
          rxBytes: 1_010_000,
        },
        {
          proto: 'tcp',
          state: 'ESTABLISHED',
          src: '192.168.1.84',
          dst: '198.51.100.20',
          sport: 50002,
          dport: 443,
          txBytes: 500,
          rxBytes: 500,
        },
        {
          proto: 'tcp',
          state: 'TIME_WAIT',
          src: '192.168.1.42',
          dst: '151.101.65.140',
          sport: 50003,
          dport: 443,
          txBytes: 2_000,
          rxBytes: 8_000,
        },
      ],
    },
    rdnsLookup
  );

  // TIME_WAIT must be dropped completely
  assert.equal(dashboard.flows.some((f) => f.dstIp === '151.101.65.140'), false);
  assert.equal(dashboard.flows.every((f) => f.state === 'ESTABLISHED'), true);

  // Active YouTube flow is categorized via rDNS
  const ytFlow = dashboard.flows.find((f) => f.dstIp === '198.51.100.10');
  assert.ok(ytFlow);
  assert.equal(ytFlow.dstService, 'YouTube');
  assert.equal(ytFlow.dstCategory, 'Streaming');
  assert.equal(ytFlow.dstHost, 'rr2---sn-example.googlevideo.com');

  // Idle 0 B/s flow is excluded from KPI activeFlows, clientLinks, and remotes
  assert.equal(dashboard.kpis.activeFlows, 1);
  assert.equal(dashboard.kpis.activeHosts, 1);
  assert.equal(dashboard.clientLinks.length, 1);
  assert.equal(dashboard.clientLinks[0].category, 'Streaming');
  assert.equal(dashboard.remotes.length, 1);
  assert.equal(dashboard.remotes[0].ip, '198.51.100.10');
  assert.equal(dashboard.remotes[0].category, 'Streaming');

  // CSV export uses Category column instead of State
  const csv = exportFlowsToCsv(dashboard.flows);
  assert.ok(csv.startsWith('Protocol,Application,Category,'));
  assert.ok(!csv.split('\n')[0].includes('State'));
  assert.ok(csv.includes('Streaming'));
});

test('TrafficMonitorEngine throttles topServices updates, toggles inferDeviceNames live, and preserves slow-polled system metrics', () => {
  const engine = new TrafficMonitorEngine();
  const t0 = 1_730_000_000_000;

  // Tick 1: includes system metrics, unnamed device hits Apple APNs -> inferred name & Apple service
  engine.ingest({
    probeId: 'router-wan',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 1_000, txBytes: 500 },
    arp: [{ ip: '192.168.1.91', mac: 'da:a1:19:4c:82:10', device: 'br0' }],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.91',
        dst: '17.57.144.84',
        sport: 50000,
        dport: 5223,
        txBytes: 10_000,
        rxBytes: 50_000,
      },
    ],
    system: {
      hostname: 'my-router',
      kernel: '6.6',
      arch: 'armv7l',
      uptimeSec: 9999,
      load1m: 0.42,
      memUsedPct: 33.5,
      conntrackCount: 120,
      conntrackMax: 32768,
    },
  });

  // Tick 2 (+3s): omits system metrics, switches traffic to Netflix — topServices should stay throttled for 15s
  const { dashboard: d2 } = engine.ingest({
    probeId: 'router-wan',
    timestamp: t0 + 3_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 101_000, txBytes: 10_500 },
    arp: [{ ip: '192.168.1.91', mac: 'da:a1:19:4c:82:10', device: 'br0' }],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.91',
        dst: '23.246.18.145',
        sport: 50001,
        dport: 443,
        txBytes: 10_000,
        rxBytes: 500_000,
      },
    ],
  });

  // System metrics from Tick 1 are preserved when omitted on fast tick
  assert.equal(d2.probe.hostname, 'my-router');
  assert.equal(d2.probe.uptimeSec, 9999);
  assert.equal(d2.probe.load1m, 0.42);
  assert.equal(d2.probe.memUsedPct, 33.5);

  // Top services stays cached ('Apple') at t0 + 3s (under 15s refresh window)
  const h2 = d2.hosts.find((h) => h.ip === '192.168.1.91');
  assert.ok(h2);
  assert.deepEqual(h2.topServices, ['Apple']);

  // Tick 3 (+16s): topServices refreshes to include Netflix
  const { dashboard: d3 } = engine.ingest({
    probeId: 'router-wan',
    timestamp: t0 + 16_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 601_000, txBytes: 20_500 },
    arp: [{ ip: '192.168.1.91', mac: 'da:a1:19:4c:82:10', device: 'br0' }],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.91',
        dst: '23.246.18.145',
        sport: 50001,
        dport: 443,
        txBytes: 20_000,
        rxBytes: 1_000_000,
      },
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.91',
        dst: '17.57.144.84',
        sport: 50000,
        dport: 5223,
        txBytes: 12_000,
        rxBytes: 60_000,
      },
    ],
  });

  const h3 = d3.hosts.find((h) => h.ip === '192.168.1.91');
  assert.ok(h3);
  assert.equal(h3.hostname, 'Apple Device (.91)');
  assert.equal(h3.nameSource, 'fingerprint');
  assert.deepEqual(h3.topServices, ['Netflix', 'Apple']);

  // Disabling inferDeviceNames immediately updates snapshot host & flow names to raw IP
  engine.updateServerConfig({ inferDeviceNames: false });
  const snapDisabled = engine.getSnapshot();
  const hDisabled = snapDisabled.hosts.find((h) => h.ip === '192.168.1.91');
  assert.equal(hDisabled?.hostname, '192.168.1.91');
  assert.equal(hDisabled?.nameSource, 'ip');

  // Re-enabling restores inferred name immediately
  engine.updateServerConfig({ inferDeviceNames: true });
  const snapReenabled = engine.getSnapshot();
  const hReenabled = snapReenabled.hosts.find((h) => h.ip === '192.168.1.91');
  assert.equal(hReenabled?.hostname, 'Apple Device (.91)');
  assert.equal(hReenabled?.nameSource, 'fingerprint');
});

test('generatePythonProbe includes daemonize, logging options, dhcp-leases, and slow-polled system interval without urllib/argparse', () => {
  const cfg = {
    wsUrl: 'ws://192.168.1.10:3000/ws/ingest',
    httpUrl: 'http://192.168.1.10:3000/api/ingest',
    token: 'of_test',
    iface: 'eth0',
    intervalSec: 3,
    probeId: 'router-eth0',
    dhcpLeasesPath: '/var/lib/misc/custom.leases',
  };
  const py = generatePythonProbe(cfg);
  assert.ok(py.includes('INTERVAL_SEC = 3'));
  assert.ok(py.includes('SYS_INTERVAL_SEC = 30'));
  assert.ok(py.includes('PORTS_INTERVAL_SEC = 30'));
  assert.ok(py.includes('def fast_ws_mask('));
  assert.ok(py.includes('class LeaseCache'));
  assert.ok(py.includes('wifiRxMbps'));
  assert.ok(py.includes('wifiTxMbps'));
  assert.ok(py.includes('DHCP_LEASES_PATH = "/var/lib/misc/custom.leases"'));
  assert.ok(py.includes('--dhcp-leases'));
  assert.ok(py.includes('--daemonize'));
  assert.ok(py.includes('def daemonize_process('));
  assert.ok(py.includes('--log-level'));
  assert.ok(py.includes('--log-file'));
  assert.ok(!py.includes('import argparse'));
  assert.ok(!py.includes('import urllib'));

  const init = generateInitScript(cfg);
  assert.ok(init.includes('--dhcp-leases "/var/lib/misc/custom.leases"'));
});

test('TrafficMonitorEngine retains recently ended flows for reading and keeps idle connected hosts visible across ARP misses', () => {
  const engine = new TrafficMonitorEngine();
  const t0 = 1_740_000_000_000;

  // Tick 1: two connected devices (one active transfer, one idle)
  engine.ingest({
    probeId: 'router-wan',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 1_000, txBytes: 500 },
    arp: [
      { ip: '192.168.1.20', mac: 'aa:bb:cc:00:00:20', device: 'br0', hostname: 'workstation' },
      { ip: '192.168.1.30', mac: 'aa:bb:cc:00:00:30', device: 'br0', hostname: 'smart-tv' },
    ],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.20',
        dst: '140.82.114.4',
        sport: 51000,
        dport: 443,
        txBytes: 5_000,
        rxBytes: 20_000,
      },
    ],
  });

  // Tick 2 (+2s): active flow transfers data
  const tick2 = engine.ingest({
    probeId: 'router-wan',
    timestamp: t0 + 2_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 501_000, txBytes: 20_500 },
    arp: [
      { ip: '192.168.1.20', mac: 'aa:bb:cc:00:00:20', device: 'br0', hostname: 'workstation' },
      { ip: '192.168.1.30', mac: 'aa:bb:cc:00:00:30', device: 'br0', hostname: 'smart-tv' },
    ],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.20',
        dst: '140.82.114.4',
        sport: 51000,
        dport: 443,
        txBytes: 25_000,
        rxBytes: 520_000,
      },
    ],
  });
  assert.equal(tick2.dashboard.kpis.activeFlows, 1);
  assert.equal(tick2.dashboard.flows.length, 1);
  assert.equal(tick2.dashboard.flows[0].ended, false);

  // Tick 3 (+5s): flow finishes & disappears from conntrack, and smart-tv briefly misses ARP
  const tick3 = engine.ingest({
    probeId: 'router-wan',
    timestamp: t0 + 5_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 501_000, txBytes: 20_500 },
    arp: [
      { ip: '192.168.1.20', mac: 'aa:bb:cc:00:00:20', device: 'br0', hostname: 'workstation' },
    ],
    flows: [],
  });

  // Ended flow stays in dashboard.flows with ended=true and 0 B/s rate, without inflating live KPIs
  assert.equal(tick3.dashboard.flows.length, 1);
  assert.equal(tick3.dashboard.flows[0].ended, true);
  assert.equal(tick3.dashboard.flows[0].rxBps, 0);
  assert.equal(tick3.dashboard.flows[0].totalBytes, 545_000);
  assert.equal(tick3.dashboard.kpis.activeFlows, 0);
  assert.equal(tick3.dashboard.clientLinks.length, 0);

  // Idle smart-tv remains present in dashboard.hosts across the brief ARP gap
  assert.equal(tick3.dashboard.hosts.some((h) => h.ip === '192.168.1.30'), true);
});

test('TrafficMonitorEngine attaches Wi-Fi RX/TX rates and Ethernet connection type to HostSummary', () => {
  const engine = new TrafficMonitorEngine();
  const t0 = 1_710_000_000_000;

  const snap = engine.ingest({
    probeId: 'router-wan',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 100_000, txBytes: 50_000 },
    arp: [
      { ip: '192.168.1.50', mac: 'aa:bb:cc:00:00:50', device: 'br0', hostname: 'macbook-pro' },
      { ip: '192.168.1.51', mac: 'aa:bb:cc:00:00:51', device: 'br0', hostname: 'desktop-nas' },
    ],
    routerClients: [
      {
        mac: 'aa:bb:cc:00:00:50',
        ip: '192.168.1.50',
        connectionType: 'wifi',
        portOrRadio: '5 GHz (ath1)',
        linkSpeedMbps: 1200,
        wifiRxMbps: 1080,
        wifiTxMbps: 1200,
        signalDbm: -48,
        rxBytes: 0,
        txBytes: 0,
        rxBps: 0,
        txBps: 0,
      },
      {
        mac: 'aa:bb:cc:00:00:51',
        ip: '192.168.1.51',
        connectionType: 'ethernet',
        portOrRadio: 'Ethernet',
        linkSpeedMbps: 0,
        rxBytes: 0,
        txBytes: 0,
        rxBps: 0,
        txBps: 0,
      },
    ],
    flows: [],
  });

  const wifiHost = snap.dashboard.hosts.find((h) => h.ip === '192.168.1.50');
  const wiredHost = snap.dashboard.hosts.find((h) => h.ip === '192.168.1.51');

  assert.ok(wifiHost);
  assert.equal(wifiHost.connectionType, 'wifi');
  assert.equal(wifiHost.wifiRxMbps, 1080);
  assert.equal(wifiHost.wifiTxMbps, 1200);
  assert.equal(wifiHost.wifiSignalDbm, -48);
  assert.equal(wifiHost.linkRadioOrPort, '5 GHz');
  assert.equal(wifiHost.wifiBand, '5 GHz');
  assert.equal(wifiHost.apName, 'Main AP');

  assert.ok(wiredHost);
  assert.equal(wiredHost.connectionType, 'ethernet');
  assert.equal(wiredHost.apName, 'Main AP');
  assert.equal(wiredHost.wifiRxMbps, undefined);
  assert.equal(wiredHost.wifiTxMbps, undefined);
});

test('TrafficMonitorEngine separates Internet and LAN clientLinks with zero cross-leakage', () => {
  const engine = new TrafficMonitorEngine();
  const t0 = 1_710_000_000_000;
  const arp = [
    { ip: '192.168.1.24', mac: 'aa:bb:cc:00:00:24', device: 'br0', hostname: 'macbook-pro' },
    { ip: '192.168.1.38', mac: 'aa:bb:cc:00:00:38', device: 'br0', hostname: 'synology-nas' },
    { ip: '192.168.1.52', mac: 'aa:bb:cc:00:00:52', device: 'br0', hostname: 'apple-tv' },
  ];

  // Tick 1 establishes flow baselines
  engine.ingest({
    probeId: 'router-wan',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 100_000, txBytes: 50_000 },
    arp,
    flows: [
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.24', dst: '140.82.114.4', sport: 51000, dport: 443, rxBytes: 10_000, txBytes: 5_000 },
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.24', dst: '192.168.1.38', sport: 52000, dport: 445, rxBytes: 10_000, txBytes: 5_000 },
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.52', dst: '23.246.18.145', sport: 53000, dport: 443, rxBytes: 10_000, txBytes: 5_000 },
    ],
  });

  // Tick 2 generates tangible delta rates
  const snap = engine.ingest({
    probeId: 'router-wan',
    timestamp: t0 + 3_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 900_000, txBytes: 250_000 },
    arp,
    flows: [
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.24', dst: '140.82.114.4', sport: 51000, dport: 443, rxBytes: 310_000, txBytes: 55_000 },
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.24', dst: '192.168.1.38', sport: 52000, dport: 445, rxBytes: 610_000, txBytes: 105_000 },
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.52', dst: '23.246.18.145', sport: 53000, dport: 443, rxBytes: 910_000, txBytes: 25_000 },
    ],
  });

  const internetLinks = snap.dashboard.clientLinks.filter((l) => l.scope === 'internet');
  const lanLinks = snap.dashboard.clientLinks.filter((l) => l.scope === 'lan');

  assert.equal(internetLinks.length, 2);
  assert.equal(lanLinks.length, 1);
  assert.ok(internetLinks.every((l) => l.category !== 'Local Network'));
  assert.equal(lanLinks[0].clientName, 'macbook-pro');
  assert.equal(lanLinks[0].service, 'synology-nas');
  assert.equal(lanLinks[0].category, 'Local Network');
});

test('validateRouterDeployInput blocks shell injection, path traversal, and loopback targets', async () => {
  const { validateRouterDeployInput } = await import('../../server/routerDeployer');

  const valid = validateRouterDeployInput({
    host: '192.168.1.1',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: 'secret',
    remotePath: '/opt/bin/orbi_probe.py',
    wsUrl: 'ws://192.168.1.10:3000/ws/ingest',
    iface: 'eth0',
  });
  assert.equal(valid.ok, true);

  assert.equal(
    validateRouterDeployInput({
      host: '127.0.0.1',
      password: 'x',
      wsUrl: 'ws://192.168.1.10:3000/ws/ingest',
    }).ok,
    false
  );
  assert.equal(
    validateRouterDeployInput({
      host: '192.168.1.1; rm -rf /',
      password: 'x',
      wsUrl: 'ws://192.168.1.10:3000/ws/ingest',
    }).ok,
    false
  );
  assert.equal(
    validateRouterDeployInput({
      host: '192.168.1.1',
      password: 'x',
      remotePath: '/opt/../etc/passwd',
      wsUrl: 'ws://192.168.1.10:3000/ws/ingest',
    }).ok,
    false
  );
  assert.equal(
    validateRouterDeployInput({
      host: '192.168.1.1',
      password: 'x',
      remotePath: "/opt/bin/probe';id;'",
      wsUrl: 'ws://192.168.1.10:3000/ws/ingest',
    }).ok,
    false
  );
});

test('TrafficMonitorEngine excludes public WAN IPs and WAN-interface ARP entries from LAN hosts and surfaces WAN & satelliteinfo telemetry', async () => {
  const { sanitizeFeatureVisibility } = await import('./tablePreferences');
  const engine = new TrafficMonitorEngine();
  const t0 = 1_750_000_000_000;

  const { dashboard } = engine.ingest({
    probeId: 'orbi-main',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 200_000, txBytes: 50_000 },
    wan: {
      ip: '73.162.48.214',
      gateway: '73.162.48.1',
      dns: ['1.1.1.1', '8.8.8.8'],
      iface: 'eth0',
      linkSpeedMbps: 2500,
      duplex: 'full',
      mtu: 1500,
      state: 'up',
      connectionType: 'DHCP',
    },
    satelliteInfo: [
      {
        mac: 'aa:bb:cc:dd:00:02',
        ip: '192.168.1.2',
        name: 'Office Satellite',
        model: 'RBS50',
        backhaulType: 'ethernet',
        backhaulStatus: 'Good',
        backhaulSpeedMbps: 1000,
      },
    ],
    arp: [
      { ip: '192.168.1.25', mac: 'aa:bb:cc:00:00:25', device: 'br0', hostname: 'workstation' },
      // Public ISP gateway on WAN iface (must be excluded)
      { ip: '73.162.48.1', mac: '00:11:22:33:44:55', device: 'eth0' },
      // Private cable-modem / CGNAT upstream neighbor on WAN iface (must be excluded)
      { ip: '192.168.100.1', mac: '00:11:22:33:44:66', device: 'eth0' },
      // Public IP accidentally reported on br0 (must be excluded)
      { ip: '8.8.8.8', mac: '00:11:22:33:44:77', device: 'br0' },
    ],
    flows: [],
  });

  // Only genuine private LAN host remains in dashboard.hosts
  assert.deepEqual(
    dashboard.hosts.map((h) => h.ip),
    ['192.168.1.25']
  );

  // Router WAN details and /usr/sbin/satelliteinfo satellites appear in topology
  assert.equal(dashboard.topology?.wan?.ip, '73.162.48.214');
  assert.equal(dashboard.topology?.wan?.gateway, '73.162.48.1');
  assert.equal(dashboard.topology?.satellites.length, 1);
  assert.equal(dashboard.topology?.satellites[0].source, 'router');
  assert.equal(dashboard.topology?.satellites[0].backhaulType, 'ethernet');
  assert.equal(dashboard.topology?.satellites[0].backhaulSpeedMbps, 1000);

  // Feature visibility sanitization and config update
  const vis = sanitizeFeatureVisibility({ flows: false, connections: false });
  assert.equal(vis.flows, false);
  assert.equal(vis.connections, false);
  assert.equal(vis.devices, true);

  engine.updateServerConfig({ featureVisibility: vis });
  const updatedCfg = engine.getSnapshot().serverConfig;
  assert.equal(updatedCfg.featureVisibility.flows, false);
  assert.equal(updatedCfg.featureVisibility.connections, false);
  assert.equal(updatedCfg.featureVisibility.trafficMap, true);
});

test('buildRouterRestartCommand stops previous agent without self-killing shell or emitting /proc stderr errors', async () => {
  const { execFileSync } = await import('node:child_process');
  const { buildRouterRestartCommand } = await import('../../server/routerDeployer');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbiflow-restart-'));
  const scriptPath = path.join(tmpDir, 'orbi_probe_test.py');
  const pidPath = path.join(tmpDir, 'orbi-probe-test.pid');
  let spawnedPid = 0;

  try {
    // Minimal daemon script matching orbi_probe.py -d --pid-file behavior
    fs.writeFileSync(
      scriptPath,
      [
        'import os, signal, sys, time',
        'pid_file = sys.argv[sys.argv.index("--pid-file") + 1]',
        'if os.fork() > 0: os._exit(0)',
        'os.setsid()',
        'if os.fork() > 0: os._exit(0)',
        'devnull = os.open(os.devnull, os.O_RDWR)',
        'for fd in (0, 1, 2): os.dup2(devnull, fd)',
        'if devnull > 2: os.close(devnull)',
        'with open(pid_file, "w") as f: f.write(f"{os.getpid()}\\n")',
        'running = True',
        'def stop(_s, _f):',
        '    global running',
        '    running = False',
        'signal.signal(signal.SIGTERM, stop)',
        'while running: time.sleep(0.2)',
      ].join('\n'),
      { mode: 0o755 }
    );

    const cmd = buildRouterRestartCommand(scriptPath, pidPath);
    // First start
    const out1 = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const m1 = out1.match(/OK_PID=(\d+)/);
    assert.ok(m1, `Expected OK_PID in first start output: ${out1}`);
    const pid1 = Number(m1[1]);
    spawnedPid = pid1;

    // Second start (replaces running agent cleanly without self-kill)
    const out2 = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const m2 = out2.match(/OK_PID=(\d+)/);
    assert.ok(m2, `Expected OK_PID in restart output: ${out2}`);
    const pid2 = Number(m2[1]);
    spawnedPid = pid2;
    assert.notEqual(pid2, pid1);
    assert.equal(fs.existsSync(`/proc/${pid1}`), false);
    assert.equal(fs.existsSync(`/proc/${pid2}`), true);
  } finally {
    if (spawnedPid > 1) {
      try {
        process.kill(spawnedPid, 'SIGKILL');
      } catch {
        // already exited
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TrafficMonitorEngine computes pure LAN traffic from eth1 minus WAN and restricts host.topServices to named brands', () => {
  const engine = new TrafficMonitorEngine();
  const t0 = 1_760_000_000_000;
  const arp = [
    { ip: '192.168.1.40', mac: 'aa:bb:cc:00:00:40', device: 'br0', hostname: 'studio-mac' },
  ];

  // Tick 1 baseline
  engine.ingest({
    probeId: 'orbi-main',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 1_000_000, txBytes: 500_000 },
    lanIfaces: [{ iface: 'eth1', rxBytes: 2_000_000, txBytes: 3_000_000 }],
    arp,
    flows: [
      // Unknown public IP over HTTPS (should NOT appear as "HTTPS" in host.topServices)
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.40', dst: '203.0.113.55', sport: 51000, dport: 443, rxBytes: 50_000, txBytes: 10_000 },
      // Recognized Apple IP
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.40', dst: '17.253.144.10', sport: 51001, dport: 443, rxBytes: 20_000, txBytes: 5_000 },
    ],
  });

  // Tick 2 (+5s):
  // WAN rx = +5 MB (1 MB/s), WAN tx = +1 MB (200 KB/s)
  // eth1 rx = +6 MB (WAN tx 1 MB + 5 MB pure LAN rx = 1 MB/s LAN rx)
  // eth1 tx = +10 MB (WAN rx 5 MB + 5 MB pure LAN tx = 1 MB/s LAN tx)
  const { dashboard } = engine.ingest({
    probeId: 'orbi-main',
    timestamp: t0 + 5_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 6_000_000, txBytes: 1_500_000 },
    lanIfaces: [{ iface: 'eth1', rxBytes: 8_000_000, txBytes: 13_000_000 }],
    arp,
    flows: [
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.40', dst: '203.0.113.55', sport: 51000, dport: 443, rxBytes: 550_000, txBytes: 60_000 },
      { proto: 'tcp', state: 'ESTABLISHED', src: '192.168.1.40', dst: '17.253.144.10', sport: 51001, dport: 443, rxBytes: 220_000, txBytes: 25_000 },
    ],
  });

  assert.ok(dashboard.lanSummary);
  assert.equal(dashboard.lanSummary.iface, 'eth1');
  assert.equal(dashboard.lanSummary.rxBps, 1_000_000);
  assert.equal(dashboard.lanSummary.txBps, 1_000_000);
  assert.equal(dashboard.lanSummary.totalBps, 2_000_000);

  // Switched LAN traffic without conntrack entries synthesizes a LAN-scoped link
  const lanLinks = dashboard.clientLinks.filter((l) => l.scope === 'lan');
  assert.equal(lanLinks.length, 1);
  assert.equal(lanLinks[0].totalBps, 2_000_000);

  // Host topServices includes Apple and NEVER includes HTTPS / QUIC / External IP
  const host = dashboard.hosts.find((h) => h.ip === '192.168.1.40');
  assert.ok(host);
  assert.deepEqual(host.topServices, ['Apple']);
});

test('TrafficMonitorEngine caps router ports to 4 (1 WAN + 3 LAN), detects VLANs, and tracks dual-endpoint inter-VLAN hosts', () => {
  const engine = new TrafficMonitorEngine();
  const t0 = 1_770_000_000_000;

  // Configure custom Docker VLAN name
  engine.updateServerConfig({
    vlans: [{ id: 'vlan-docker', name: 'Docker Containers', cidr: '10.0.1.0/24', vlanId: 10 }],
  });

  // Simulate an older/noisy probe reporting 7 ports (WAN + 6 switch/virtual ports) + Docker VLAN subnet
  const { dashboard } = engine.ingest({
    probeId: 'orbi-rbr50',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 500_000, txBytes: 250_000 },
    ports: [
      { id: 'eth0', label: 'WAN (eth0)', role: 'wan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 500_000, txBytes: 250_000, rxBps: 0, txBps: 0 },
      { id: 'port0', label: 'Port 0', role: 'lan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 0, txBytes: 0, rxBps: 0, txBps: 0 },
      { id: 'port1', label: 'LAN 1', role: 'lan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 0, txBytes: 0, rxBps: 0, txBps: 0 },
      { id: 'port2', label: 'LAN 2', role: 'lan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 0, txBytes: 0, rxBps: 0, txBps: 0 },
      { id: 'port3', label: 'LAN 3', role: 'lan', linkUp: false, speedMbps: 0, duplex: 'unknown', rxBytes: 0, txBytes: 0, rxBps: 0, txBps: 0 },
      { id: 'port5', label: 'LAN 5', role: 'lan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 0, txBytes: 0, rxBps: 0, txBps: 0 },
      { id: 'eth1.10', label: 'eth1.10', role: 'lan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 0, txBytes: 0, rxBps: 0, txBps: 0 },
    ],
    subnets: [
      { cidr: '10.0.0.0/24', iface: 'br0', source: 'interface' },
      { cidr: '10.0.1.0/24', iface: 'br0.10', vlanId: 10, source: 'vlan' },
    ],
    arp: [
      { ip: '10.0.0.15', mac: 'aa:bb:cc:00:00:15', device: 'br0', hostname: 'workstation' },
    ],
    flows: [
      // Inter-VLAN flow: primary LAN host -> Docker container on 10.0.1.20 (not in ARP)
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '10.0.0.15',
        dst: '10.0.1.20',
        sport: 54000,
        dport: 8080,
        txBytes: 12_000,
        rxBytes: 85_000,
      },
    ],
  });

  // Router ports strictly normalized to 4: 1 WAN + 3 LAN (port0, port5, eth1.10 dropped)
  const routerPorts = dashboard.topology?.routerPorts || [];
  assert.equal(routerPorts.length, 4);
  assert.equal(routerPorts[0].role, 'wan');
  assert.equal(routerPorts.filter((p) => p.role === 'lan').length, 3);

  // Both endpoints of inter-VLAN flow exist as hosts, and 10.0.1.20 is tagged with Docker Containers VLAN
  const workstation = dashboard.hosts.find((h) => h.ip === '10.0.0.15');
  const container = dashboard.hosts.find((h) => h.ip === '10.0.1.20');
  assert.ok(workstation);
  assert.equal(workstation.vlanName, undefined);
  assert.ok(container, 'Expected Docker container 10.0.1.20 to be discovered from inter-VLAN flow');
  assert.equal(container.vlanName, 'Docker Containers');
  assert.equal(container.vlanCidr, '10.0.1.0/24');
  assert.equal(container.vlanId, 10);

  // Detected subnets list includes primary 10.0.0.0/24 and VLAN 10.0.1.0/24
  assert.ok(dashboard.detectedSubnets && dashboard.detectedSubnets.length >= 2);
  const dockerSub = dashboard.detectedSubnets.find((s) => s.cidr === '10.0.1.0/24');
  assert.ok(dockerSub);
  assert.equal(dockerSub.name, 'Docker Containers');
  assert.equal(dockerSub.isPrimary, false);
  assert.equal(dockerSub.hostCount, 1);
});

test('TrafficMonitorEngine recovers cleanly from 32-bit unsigned counter wraps on WAN and conntrack flows', async () => {
  const { computeCounterDelta } = await import('./telemetryEngine');
  const UINT32 = 0x1_0000_0000;

  // Direct unit check on computeCounterDelta: 4,294,900,000 -> 15,000,000 over 3s = ~15,067,296 bytes
  const expectedWrap = UINT32 - 4_294_900_000 + 15_000_000;
  assert.equal(computeCounterDelta(15_000_000, 4_294_900_000, 3), expectedWrap);
  // Counter reset (huge wrap that would imply >10 Gbps) returns 0 instead of spiking
  assert.equal(computeCounterDelta(100, 100_000, 3), 0);

  const engine = new TrafficMonitorEngine();
  const t0 = 1_780_000_000_000;

  // Tick 1: just below 32-bit unsigned max (4.29 GB)
  engine.ingest({
    probeId: 'orbi-rbr50',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 4_294_900_000, txBytes: 1_000_000 },
    arp: [{ ip: '192.168.1.50', mac: 'aa:bb:cc:dd:ee:50', device: 'br0', hostname: 'media-box' }],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.50',
        dst: '23.246.18.145',
        sport: 50000,
        dport: 443,
        txBytes: 500_000,
        rxBytes: 4_294_900_000,
      },
    ],
  });

  // Tick 2 (3s later): rxBytes wraps past 2^32 to 15,000,000; txBytes increases normally by +3,000,000
  const { dashboard } = engine.ingest({
    probeId: 'orbi-rbr50',
    timestamp: t0 + 3_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 15_000_000, txBytes: 4_000_000 },
    arp: [{ ip: '192.168.1.50', mac: 'aa:bb:cc:dd:ee:50', device: 'br0', hostname: 'media-box' }],
    flows: [
      {
        proto: 'tcp',
        state: 'ESTABLISHED',
        src: '192.168.1.50',
        dst: '23.246.18.145',
        sport: 50000,
        dport: 443,
        txBytes: 800_000,
        rxBytes: 15_000_000,
      },
    ],
  });

  // Both WAN rxBps and txBps stay accurate across the 32-bit wrap (no drop to 0!)
  assert.equal(dashboard.kpis.rxBps, Math.round(expectedWrap / 3));
  assert.equal(dashboard.kpis.txBps, 1_000_000);
  // Conntrack flow rxBps also recovers cleanly across the 32-bit wrap
  assert.equal(dashboard.flows[0].rxBps, Math.round(expectedWrap / 3));
  assert.equal(dashboard.flows[0].txBps, 100_000);
});

test('TrafficMonitorEngine rejects out-of-order/micro-burst spikes and computes 30s port rates accurately', () => {
  const engine = new TrafficMonitorEngine();
  const t0 = 1_785_000_000_000;

  // Tick 1: establish baseline + initial port counters
  engine.ingest({
    probeId: 'orbi-rbr50',
    timestamp: t0,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 10_000_000, txBytes: 2_000_000 },
    ports: [
      { id: 'eth0', label: 'WAN', role: 'wan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 10_000_000, txBytes: 2_000_000, rxBps: 0, txBps: 0 },
      { id: 'port1', label: 'LAN 1', role: 'lan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 5_000_000, txBytes: 1_000_000, rxBps: 0, txBps: 0 },
    ],
    arp: [],
    flows: [],
  });

  // Tick 2 (+3s): normal 10 MB/s rx
  const r2 = engine.ingest({
    probeId: 'orbi-rbr50',
    timestamp: t0 + 3_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 40_000_000, txBytes: 5_000_000 },
    arp: [],
    flows: [],
  });
  assert.equal(r2.dashboard.kpis.rxBps, 10_000_000);

  // Out-of-order / duplicate timestamp snapshot is ignored cleanly without corrupting history
  const rDup = engine.ingest({
    probeId: 'orbi-rbr50',
    timestamp: t0 + 2_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 99_000_000, txBytes: 9_000_000 },
    arp: [],
    flows: [],
  });
  assert.equal(rDup.dashboard.kpis.rxBps, 10_000_000);
  assert.equal(rDup.dashboard.history.length, 2);

  // Micro-burst packet arriving 150ms later does NOT create a 20x spike
  const rBurst = engine.ingest({
    probeId: 'orbi-rbr50',
    timestamp: t0 + 3_150,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 70_000_000, txBytes: 8_000_000 },
    arp: [],
    flows: [],
  });
  assert.equal(rBurst.dashboard.kpis.rxBps, 10_000_000);

  // 27s later (30s total since Tick 1): ports refresh with +30 MB on LAN 1 -> must divide by 30s (= 1 MB/s), NOT 3s (= 10 MB/s)!
  const rPorts = engine.ingest({
    probeId: 'orbi-rbr50',
    timestamp: t0 + 30_000,
    source: 'live',
    iface: { iface: 'eth0', rxBytes: 340_000_000, txBytes: 35_000_000 },
    ports: [
      { id: 'eth0', label: 'WAN', role: 'wan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 340_000_000, txBytes: 35_000_000, rxBps: 0, txBps: 0 },
      { id: 'port1', label: 'LAN 1', role: 'lan', linkUp: true, speedMbps: 1000, duplex: 'full', rxBytes: 35_000_000, txBytes: 7_000_000, rxBps: 0, txBps: 0 },
    ],
    arp: [],
    flows: [],
  });
  const lan1 = rPorts.dashboard.topology?.routerPorts.find((p) => p.id === 'port1');
  assert.ok(lan1);
  assert.equal(lan1.rxBps, 1_000_000);
  assert.equal(lan1.txBps, 200_000);
});





