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

test('RdnsCache caches entries, skips private IPs, and respects disabled config', () => {
  const cache = new RdnsCache({ enabled: false, ttlSec: 60, skipPrivate: true });
  assert.equal(cache.lookup('192.168.1.5'), null);
  assert.equal(cache.lookup('8.8.8.8'), null);
  assert.equal(cache.getStats().misses, 0);

  cache.setEntry('8.8.8.8', 'dns.google');
  assert.equal(cache.lookup('8.8.8.8'), 'dns.google');
  assert.equal(cache.getStats().hits, 1);
});
