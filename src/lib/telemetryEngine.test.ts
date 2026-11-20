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

  // 5 seconds later: +50 MB rx => 80 Mb/s (triggers > 50 Mb/s alert)
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

import { generateDockerCompose, generatePythonProbe } from './probeTemplates';

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
    message: 'Download speed reached 250 Mb/s (threshold 200 Mb/s)',
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


