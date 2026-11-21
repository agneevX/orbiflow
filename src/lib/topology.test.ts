import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTopologyGraph,
  computeIspUtilization,
  formatLinkSpeed,
  inferTopologyDeviceIcon,
  parseSatelliteSshOutput,
  toPublicSatelliteConfig,
} from './topology';
import { validateSatelliteInput } from '../../server/satellitePoller';
import { DEFAULT_TABLE_PREFERENCES } from './tablePreferences';
import type { DashboardSnapshot, HostSummary, SatelliteConfig } from '../types/telemetry';

test('computeIspUtilization calculates Mbps, percentages, and health tiers', () => {
  // 50 MB/s = 400 Mbps on 1000 Mbps plan = 40% (moderate)
  const mod = computeIspUtilization(50_000_000, 5_000_000, 1000, 200);
  assert.equal(mod.downMbps, 400);
  assert.equal(mod.upMbps, 40);
  assert.equal(mod.downPct, 40);
  assert.equal(mod.upPct, 20);
  assert.equal(mod.peakPct, 40);
  assert.equal(mod.dominantDirection, 'down');
  assert.equal(mod.health, 'moderate');

  // Saturated upload: 25 MB/s = 200 Mbps on 200 Mbps plan = 100%
  const sat = computeIspUtilization(1_000_000, 30_000_000, 1000, 200);
  assert.equal(sat.upPct, 100);
  assert.equal(sat.dominantDirection, 'up');
  assert.equal(sat.health, 'saturated');

  // Idle optimal
  const opt = computeIspUtilization(0, 0, 1000, 200);
  assert.equal(opt.peakPct, 0);
  assert.equal(opt.health, 'optimal');
});

test('formatLinkSpeed formats Ethernet negotiation rates and Wi-Fi speeds', () => {
  assert.equal(formatLinkSpeed(10000, 'ethernet', true), '10 GbE');
  assert.equal(formatLinkSpeed(2500, 'ethernet', true), '2.5 GbE');
  assert.equal(formatLinkSpeed(1000, 'ethernet', true), '1 GbE');
  assert.equal(formatLinkSpeed(100, 'ethernet', true), '100 MbE');
  assert.equal(formatLinkSpeed(1200, 'wifi', true), '1.2 Gbps Wi-Fi');
  assert.equal(formatLinkSpeed(866, 'wifi', true), '866 Mbps Wi-Fi');
  assert.equal(formatLinkSpeed(1000, 'ethernet', false), 'Down');
});

test('toPublicSatelliteConfig strips raw SSH password and privateKey', () => {
  const secretCfg: SatelliteConfig = {
    id: 'sat-1',
    name: 'Office Satellite',
    host: '192.168.1.3',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: 'super-secret-password',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----',
    backhaulInterface: 'eth0',
    pollIntervalSec: 5,
    enabled: true,
  };

  const pub = toPublicSatelliteConfig(secretCfg);
  assert.equal(pub.hasPassword, true);
  assert.equal(pub.hasPrivateKey, true);
  assert.equal('password' in pub, false);
  assert.equal('privateKey' in pub, false);
  assert.equal(JSON.stringify(pub).includes('super-secret-password'), false);
  assert.equal(JSON.stringify(pub).includes('OPENSSH PRIVATE KEY'), false);
});

test('parseSatelliteSshOutput parses sysfs, swconfig, brctl, wlanconfig, and iw outputs', () => {
  const sample = [
    '===META===',
    'HOST=RBS50-Living',
    'UPTIME=123456.78 987654.32',
    '===IFACES===',
    'eth0|up|2500|full|1000000|500000|0',
    'ath0|up|0|unknown|200000|100000|1',
    'lo|unknown|0|unknown|10|10|0',
    '===SWCONFIG===',
    'Port 0:',
    '  link: port:0 link:up speed:1000baseT full-duplex',
    'Port 1:',
    '  link: port:1 link:up speed:1000baseT full-duplex',
    '  RxGoodByte : 450000',
    '  TxByte     : 120000',
    'Port 2:',
    '  link: port:2 link:down',
    '===BRCTL===',
    '  1   aa:bb:cc:dd:ee:01   no   0.50',
    '  1   aa:bb:cc:dd:ee:99   yes  0.00',
    '===WIFI===',
    'WIFI_IF=ath0',
    'ADDR               AID CHAN TXRATE RXRATE RSSI MINRSSI MAXRSSI IDLE',
    '11:22:33:44:55:66    1   36   866M   780M   42      30      45    0',
    'WIFI_IF=wlan1',
    'Station 77:88:99:aa:bb:cc (on wlan1)',
    '  rx bytes: 8192',
    '  tx bytes: 16384',
    '  signal: -58 dBm',
    '  tx bitrate: 1200.5 MBit/s',
  ].join('\n');

  const parsed = parseSatelliteSshOutput(sample);
  assert.equal(parsed.hostname, 'RBS50-Living');
  assert.equal(parsed.uptimeSec, 123456);
  assert.equal(parsed.interfaces.length, 2);
  assert.equal(parsed.interfaces[0].name, 'eth0');
  assert.equal(parsed.interfaces[0].speedMbps, 2500);
  assert.equal(parsed.interfaces[1].isWireless, true);

  assert.equal(parsed.switchPorts.length, 3);
  assert.equal(parsed.switchPorts[1].portNum, 1);
  assert.equal(parsed.switchPorts[1].linkUp, true);
  assert.equal(parsed.switchPorts[1].speedMbps, 1000);
  assert.equal(parsed.switchPorts[1].rxBytes, 450000);
  assert.equal(parsed.switchPorts[1].txBytes, 120000);
  assert.equal(parsed.switchPorts[2].linkUp, false);

  // Only non-local MACs kept
  assert.equal(parsed.bridgeMacs.length, 1);
  assert.equal(parsed.bridgeMacs[0].mac, 'aa:bb:cc:dd:ee:01');

  assert.equal(parsed.wifiStations.length, 2);
  assert.equal(parsed.wifiStations[0].mac, '11:22:33:44:55:66');
  assert.equal(parsed.wifiStations[0].txRateMbps, 866);
  assert.equal(parsed.wifiStations[1].mac, '77:88:99:aa:bb:cc');
  assert.equal(parsed.wifiStations[1].txRateMbps, 1201);
  assert.equal(parsed.wifiStations[1].rxBytes, 8192);
  assert.equal(parsed.wifiStations[1].signalDbm, -58);
});

function makeHost(overrides: Partial<HostSummary>): HostSummary {
  return {
    ip: '192.168.1.50',
    mac: 'aa:bb:cc:11:22:33',
    hostname: 'Test Device',
    vendor: 'Apple',
    nameSource: 'dhcp',
    isRandomizedMac: false,
    rxBps: 500_000,
    txBps: 100_000,
    rxBytes: 10_000_000,
    txBytes: 2_000_000,
    totalBytes: 12_000_000,
    activeFlows: 3,
    topApps: ['YouTube'],
    topServices: ['YouTube'],
    lastSeen: Date.now(),
    ...overrides,
  };
}

function makeSnapshot(): DashboardSnapshot {
  const hosts: HostSummary[] = [
    makeHost({ ip: '192.168.1.10', mac: 'aa:bb:cc:00:00:10', hostname: 'Apple TV 4K', rxBps: 2_000_000, txBps: 100_000 }),
    makeHost({ ip: '192.168.1.11', mac: 'aa:bb:cc:00:00:11', hostname: 'Idle Camera', rxBps: 0, txBps: 0 }),
    makeHost({ ip: '192.168.1.20', mac: 'aa:bb:cc:00:00:20', hostname: 'Synology NAS', vendor: 'Synology', rxBps: 1_500_000, txBps: 900_000 }),
  ];

  return {
    probe: {
      connected: true,
      mode: 'live',
      probeId: 'orbi-main',
      hostname: 'Orbi-Main',
      kernel: '3.14.77',
      arch: 'armv7l',
      iface: 'eth0',
      uptimeSec: 7200,
      load1m: 0.2,
      memUsedPct: 35,
      conntrackCount: 120,
      conntrackMax: 16384,
      lastHeartbeat: Date.now(),
      simulatorEnabled: false,
      simulatorAvailable: false,
    },
    kpis: {
      rxBps: 3_500_000,
      txBps: 1_000_000,
      combinedBps: 4_500_000,
      totalRxBytes: 100_000_000,
      totalTxBytes: 20_000_000,
      activeFlows: 6,
      activeHosts: 2,
      peakRxBps: 5_000_000,
      peakTxBps: 2_000_000,
    },
    history: [],
    rollupHistory: [],
    flows: [],
    hosts,
    protocols: [],
    remotes: [],
    clientLinks: [],
    topology: {
      routerPorts: [
        {
          id: 'eth0',
          label: 'WAN (eth0)',
          role: 'wan',
          linkUp: true,
          speedMbps: 2500,
          duplex: 'full',
          rxBytes: 1000,
          txBytes: 500,
          rxBps: 3_500_000,
          txBps: 1_000_000,
        },
      ],
      routerWanSpeedMbps: 2500,
      routerClients: [
        {
          mac: 'aa:bb:cc:00:00:20',
          ip: '192.168.1.20',
          connectionType: 'ethernet',
          portOrRadio: 'LAN 3',
          linkSpeedMbps: 1000,
          rxBytes: 100,
          txBytes: 50,
          rxBps: 1_500_000,
          txBps: 900_000,
        },
      ],
      satellites: [
        {
          id: 'sat-living',
          name: 'Living Room Satellite',
          host: '192.168.1.2',
          connected: true,
          source: 'ssh',
          lastSeen: Date.now(),
          uptimeSec: 3600,
          backhaulType: 'ethernet',
          backhaulIface: 'eth0',
          backhaulSpeedMbps: 2500,
          rxBps: 2_000_000,
          txBps: 100_000,
          rxBytes: 5000,
          txBytes: 1000,
          ports: [],
          clients: [
            {
              mac: 'aa:bb:cc:00:00:10',
              connectionType: 'ethernet',
              portOrRadio: 'LAN 1',
              linkSpeedMbps: 1000,
              rxBytes: 100,
              txBytes: 50,
              rxBps: 2_000_000,
              txBps: 100_000,
            },
            {
              mac: 'aa:bb:cc:00:00:11',
              connectionType: 'wifi',
              portOrRadio: 'ath0',
              linkSpeedMbps: 433,
              rxBytes: 0,
              txBytes: 0,
              rxBps: 0,
              txBps: 0,
            },
          ],
        },
      ],
      satelliteConfigs: [],
    },
    rules: [],
    alerts: [],
    notifications: {
      ntfy: {
        enabled: false,
        serverUrl: 'https://ntfy.sh',
        topic: '',
        token: '',
        priority: 'default',
      },
      telegram: {
        enabled: false,
        botToken: '',
        chatId: '',
      },
    },
    deviceAliases: {},
    serverConfig: {
      probeToken: 'tok',
      persistenceMode: 'memory',
      cacheDir: '/tmp',
      rdnsEnabled: true,
      rdnsTtlSec: 3600,
      rdnsSkipPrivate: true,
      rdnsServer: '',
      timeFormat: '12h',
      lanDnsEnabled: false,
      lanDnsServer: '',
      lanDnsTtlSec: 600,
      stripLanDomain: true,
      inferDeviceNames: true,
      dhcpLeasesPath: '',
      ispName: 'Fiber 1G',
      ispMaxDownMbps: 1000,
      ispMaxUpMbps: 200,
      tablePreferences: DEFAULT_TABLE_PREFERENCES,
    },
    serverStats: {
      configPath: '/config/config.json',
      activeCacheDir: '/tmp',
      persistedSnapshots: 0,
      diskLogSizeBytes: 0,
      rdnsCacheSize: 0,
      rdnsHits: 0,
      rdnsMisses: 0,
      lanDnsCacheSize: 0,
      lanDnsHits: 0,
      lanDnsMisses: 0,
      lanDnsResolved: 0,
      randomizedMacCount: 0,
    },
  };
}

test('buildTopologyGraph builds 4-tier hierarchy and handles collapse + idle filtering', () => {
  const snap = makeSnapshot();
  const full = buildTopologyGraph(snap);

  // Internet + Router + Satellite + 2 sat clients + 1 router direct client = 6 nodes
  assert.equal(full.nodes.length, 6);
  assert.equal(full.edges.length, 5);
  assert.equal(full.nodes.find((n) => n.id === 'internet')?.label, 'Fiber 1G');
  assert.equal(full.nodes.find((n) => n.id === 'router')?.linkSpeedLabel, '2.5 GbE');
  assert.equal(full.nodes.find((n) => n.id === 'sat:sat-living')?.linkSpeedLabel, '2.5 GbE');
  assert.equal(full.nodes.find((n) => n.id === 'client:192.168.1.10')?.column, 3);
  assert.equal(full.nodes.find((n) => n.id === 'client:192.168.1.20')?.column, 2);

  // Collapse satellite hides its 2 clients
  const collapsedSat = buildTopologyGraph(snap, {
    collapsedIds: new Set(['sat:sat-living']),
  });
  assert.equal(collapsedSat.nodes.length, 4);
  assert.equal(collapsedSat.nodes.some((n) => n.id === 'client:192.168.1.10'), false);

  // Hide idle clients removes Idle Camera
  const activeOnly = buildTopologyGraph(snap, { showIdleClients: false });
  assert.equal(activeOnly.nodes.some((n) => n.id === 'client:192.168.1.11'), false);
  assert.equal(activeOnly.nodes.some((n) => n.id === 'client:192.168.1.10'), true);
});

test('inferTopologyDeviceIcon classifies hardware silhouettes accurately', () => {
  assert.equal(inferTopologyDeviceIcon(makeHost({ hostname: 'Apple TV 4K' })), 'tv');
  assert.equal(inferTopologyDeviceIcon(makeHost({ hostname: 'MacBook Pro M3' })), 'laptop');
  assert.equal(inferTopologyDeviceIcon(makeHost({ hostname: 'Synology DS920+' })), 'nas');
  assert.equal(inferTopologyDeviceIcon(makeHost({ hostname: 'iPhone 15 Pro' })), 'phone');
});

test('validateSatelliteInput enforces strict host, port, username, and interface rules', () => {
  assert.equal(
    validateSatelliteInput({
      name: 'Office Sat',
      host: '192.168.1.3',
      port: 22,
      username: 'root',
      backhaulInterface: 'eth0',
    }).ok,
    true
  );

  // Rejects shell metacharacters & leading hyphens
  assert.equal(
    validateSatelliteInput({ name: 'Bad', host: '192.168.1.3; rm -rf /', port: 22, username: 'root' }).ok,
    false
  );
  assert.equal(
    validateSatelliteInput({ name: 'Bad', host: '-oProxyCommand=id', port: 22, username: 'root' }).ok,
    false
  );
  assert.equal(
    validateSatelliteInput({ name: 'Bad', host: '192.168.1.3', port: 70000, username: 'root' }).ok,
    false
  );
  assert.equal(
    validateSatelliteInput({ name: 'Bad', host: '192.168.1.3', port: 22, username: 'root;id' }).ok,
    false
  );
});
