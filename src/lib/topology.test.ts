import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTopologyGraph,
  computeIspUtilization,
  formatLinkSpeed,
  formatWifiRatesLabel,
  inferTopologyDeviceIcon,
  parseSatelliteInfoWifi,
  parseSatelliteSshOutput,
  toPublicSatelliteConfig,
} from './topology';
import { convertProbeToTelemetry, validateSatelliteInput } from '../../server/satellitePoller';
import { DEFAULT_FEATURE_VISIBILITY, DEFAULT_TABLE_PREFERENCES } from './tablePreferences';
import type { DashboardSnapshot, HostSummary, SatelliteConfig } from '../types/telemetry';

test('computeIspUtilization calculates Mbps, unclamped percentages >100%, and health tiers', () => {
  // 50 MB/s = 400 Mbps on 1000 Mbps plan = 40% (moderate)
  const mod = computeIspUtilization(50_000_000, 5_000_000, 1000, 200);
  assert.equal(mod.downMbps, 400);
  assert.equal(mod.upMbps, 40);
  assert.equal(mod.downPct, 40);
  assert.equal(mod.upPct, 20);
  assert.equal(mod.peakPct, 40);
  assert.equal(mod.dominantDirection, 'down');
  assert.equal(mod.health, 'moderate');

  // Over-subscribed upload: 30 MB/s = 240 Mbps on 200 Mbps plan = 120% (exceeds 100%)
  const sat = computeIspUtilization(1_000_000, 30_000_000, 1000, 200);
  assert.equal(sat.upPct, 120);
  assert.equal(sat.peakPct, 120);
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
  assert.equal(formatWifiRatesLabel(780, 866), 'RX 780 / TX 866 Mbps');
  assert.equal(formatWifiRatesLabel(0, 866), 'TX 866 Mbps');
  assert.equal(formatWifiRatesLabel(780, 0), 'RX 780 Mbps');
  assert.equal(formatWifiRatesLabel(0, 0, 433), '433 Mbps Wi-Fi');
  assert.equal(formatWifiRatesLabel(0, 0, 0), 'Wi-Fi');
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
              wifiRxMbps: 390,
              wifiTxMbps: 433,
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
      featureVisibility: DEFAULT_FEATURE_VISIBILITY,
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
  assert.equal(full.nodes.find((n) => n.id === 'client:192.168.1.10')?.linkSpeedLabel, 'Ethernet');
  assert.equal(full.nodes.find((n) => n.id === 'client:192.168.1.10')?.linkSpeedMbps, 0);
  assert.equal(full.nodes.find((n) => n.id === 'client:192.168.1.11')?.linkSpeedLabel, 'RX 390 / TX 433 Mbps');
  assert.equal(full.nodes.find((n) => n.id === 'client:192.168.1.20')?.column, 2);
  assert.equal(full.nodes.find((n) => n.id === 'client:192.168.1.20')?.linkSpeedLabel, 'Ethernet');
  assert.equal(full.nodes.find((n) => n.id === 'client:192.168.1.20')?.linkSpeedMbps, 0);

  // Verify top-to-bottom vertical layout (Internet -> Router -> Satellite/Direct -> Satellite Clients)
  const internetNode = full.nodes.find((n) => n.id === 'internet')!;
  const routerNode = full.nodes.find((n) => n.id === 'router')!;
  const satNode = full.nodes.find((n) => n.id === 'sat:sat-living')!;
  const directClient = full.nodes.find((n) => n.id === 'client:192.168.1.20')!;
  const satClient = full.nodes.find((n) => n.id === 'client:192.168.1.10')!;
  assert.ok(internetNode.y < routerNode.y, 'Internet should be above Main Router');
  assert.ok(routerNode.y < satNode.y, 'Main Router should be above Satellite');
  assert.ok(routerNode.y < directClient.y, 'Main Router should be above direct clients');
  assert.ok(satNode.y < satClient.y, 'Satellite should be above its connected clients');

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

test('convertProbeToTelemetry detects Wi-Fi backhaul via gateway MAC + brif and excludes main-AP MACs', () => {
  const cfg: SatelliteConfig = {
    id: 'sat-wifi',
    name: 'Upstairs Orbi',
    host: '192.168.1.3',
    port: 22,
    username: 'root',
    authMethod: 'password',
    pollIntervalSec: 5,
    enabled: true,
  };

  const sampleWifiBackhaul = [
    '===META===',
    'HOST=RBS50-Upstairs',
    'UPTIME=54000.00 100000.00',
    '===ROUTE===',
    'default via 192.168.1.1 dev br0',
    'IP address       HW type     Flags       HW address            Mask     Device',
    '192.168.1.1      0x1         0x2         c0:ff:ee:00:00:01     *        br0',
    '192.168.1.52     0x1         0x2         b4:fb:e4:12:77:09     *        br0',
    '192.168.1.67     0x1         0x2         7c:d9:5c:31:aa:02     *        br0',
    '===BRIF===',
    'eth0|0x1',
    'ath0|0x2',
    'ath1|0x3',
    'ath2|0x4',
    '===IFACES===',
    'eth0|up|1000|full|900000|400000|0|aa:00:00:00:00:01',
    'ath0|up|0|unknown|10000|5000|1|aa:00:00:00:00:02',
    'ath1|up|0|unknown|300000|100000|1|aa:00:00:00:00:03',
    'ath2|up|0|unknown|5000000|1200000|1|aa:00:00:00:00:04',
    '===SWCONFIG===',
    'Port 0:',
    '  link: port:0 link:up speed:1000baseT full-duplex',
    'Port 1:',
    '  link: port:1 link:down',
    'Port 2:',
    '  link: port:2 link:up speed:1000baseT full-duplex',
    '  RxGoodByte : 900000',
    '  TxByte     : 400000',
    '===SWITCH_FDB===',
    '===BRCTL===',
    '  4   c0:ff:ee:00:00:01   no   0.10',
    '  4   11:11:11:11:11:11   no   0.20',
    '  4   22:22:22:22:22:22   no   0.30',
    '  1   b4:fb:e4:12:77:09   no   0.40',
    '  3   7c:d9:5c:31:aa:02   no   0.50',
    '===WIFI_INFO===',
    'ath0      IEEE 802.11ng  ESSID:"HomeWiFi"',
    '          Mode:Master  Frequency:2.437 GHz  Access Point: AA:00:00:00:00:02',
    'ath1      IEEE 802.11ac  ESSID:"HomeWiFi"',
    '          Mode:Master  Frequency:5.18 GHz  Access Point: AA:00:00:00:00:03',
    'ath2      IEEE 802.11ac  ESSID:"ORBI_BH"',
    '          Mode:Managed  Frequency:5.745 GHz  Access Point: C0:FF:EE:00:00:02',
    '          Bit Rate:866.7 Mb/s',
    '===WIFI===',
    'WIFI_IF=ath1',
    'ADDR               AID CHAN TXRATE RXRATE RSSI MINRSSI MAXRSSI IDLE',
    '7c:d9:5c:31:aa:02    1   36   866M   780M   40      32      44    0',
    'WIFI_IF=ath2',
    'ADDR               AID CHAN TXRATE RXRATE RSSI MINRSSI MAXRSSI IDLE',
    'c0:ff:ee:00:00:02    1  149   866M   866M   45      40      48    0',
  ].join('\n');

  const { telemetry } = convertProbeToTelemetry(cfg, sampleWifiBackhaul, null, 1_700_000_000_000);

  assert.equal(telemetry.backhaulType, 'wifi');
  assert.equal(telemetry.backhaulIface, 'ath2');
  assert.equal(telemetry.backhaulSpeedMbps, 867);
  assert.equal(telemetry.rxBytes, 5_000_000);
  assert.equal(telemetry.txBytes, 1_200_000);

  // Switch ports only (eth0 trunk not duplicated), all marked LAN (none falsely marked backhaul)
  assert.equal(telemetry.ports.length, 2);
  assert.equal(telemetry.ports.every((p) => p.role === 'lan'), true);

  // Clients must ONLY include the satellite's own Wi-Fi client (7c:d9...) and wired LAN client (b4:fb...)
  // Main-AP devices on bridge port 4 (11:11..., 22:22...), gateway MAC, and backhaul BSSID MUST be excluded!
  const clientMacs = telemetry.clients.map((c) => c.mac).sort();
  assert.deepEqual(clientMacs, ['7c:d9:5c:31:aa:02', 'b4:fb:e4:12:77:09']);
  const wifiClient = telemetry.clients.find((c) => c.mac === '7c:d9:5c:31:aa:02');
  assert.equal(wifiClient?.connectionType, 'wifi');
  assert.equal(wifiClient?.portOrRadio, '5 GHz');
  assert.equal(wifiClient?.wifiBand, '5 GHz');
  assert.equal(wifiClient?.wifiTxMbps, 866);
  assert.equal(wifiClient?.wifiRxMbps, 780);
  const wiredClient = telemetry.clients.find((c) => c.mac === 'b4:fb:e4:12:77:09');
  assert.equal(wiredClient?.connectionType, 'ethernet');
  assert.equal(wiredClient?.linkSpeedMbps, 0);
});

test('convertProbeToTelemetry detects Ethernet backhaul via switch FDB and excludes uplink port MACs', () => {
  const cfg: SatelliteConfig = {
    id: 'sat-eth',
    name: 'Office Orbi',
    host: '192.168.1.4',
    port: 22,
    username: 'root',
    authMethod: 'password',
    pollIntervalSec: 5,
    enabled: true,
  };

  const sampleEthBackhaul = [
    '===META===',
    'HOST=RBS50-Office',
    'UPTIME=12000.00 20000.00',
    '===ROUTE===',
    'default via 192.168.1.1 dev br0',
    '192.168.1.1      0x1         0x2         c0:ff:ee:00:00:01     *        br0',
    '===BRIF===',
    'eth0|0x1',
    'ath1|0x2',
    '===IFACES===',
    'eth0|up|1000|full|2000000|800000|0|bb:00:00:00:00:01',
    'ath1|up|0|unknown|100000|50000|1|bb:00:00:00:00:02',
    '===SWCONFIG===',
    'Port 0:',
    '  link: port:0 link:up speed:1000baseT full-duplex',
    'Port 1:',
    '  link: port:1 link:down',
    'Port 2:',
    '  link: port:2 link:up speed:1000baseT full-duplex',
    '  RxGoodByte : 2500000',
    '  TxByte     : 900000',
    'Port 3:',
    '  link: port:3 link:up speed:1000baseT full-duplex',
    '  RxGoodByte : 300000',
    '  TxByte     : 100000',
    '===SWITCH_FDB===',
    'Port 2: MAC c0:ff:ee:00:00:01',
    'Port 2: MAC 33:33:33:33:33:33',
    'Port 3: MAC 44:44:44:44:44:44',
    '===BRCTL===',
    '  1   c0:ff:ee:00:00:01   no   0.10',
    '  1   33:33:33:33:33:33   no   0.20',
    '  1   44:44:44:44:44:44   no   0.30',
    '===WIFI_INFO===',
    'ath1      IEEE 802.11ac  ESSID:"HomeWiFi"',
    '          Mode:Master  Frequency:5.18 GHz',
    '===WIFI===',
    'WIFI_IF=ath1',
  ].join('\n');

  const { telemetry } = convertProbeToTelemetry(cfg, sampleEthBackhaul, null, 1_700_000_000_000);

  assert.equal(telemetry.backhaulType, 'ethernet');
  assert.equal(telemetry.backhaulIface, 'port2');
  assert.equal(telemetry.backhaulSpeedMbps, 1000);
  assert.equal(telemetry.ports.find((p) => p.id === 'port2')?.role, 'backhaul');
  assert.equal(telemetry.ports.find((p) => p.id === 'port3')?.role, 'lan');

  // Only Port 3 downstream client is included; Port 2 uplink main-AP client (33:33...) is excluded!
  assert.deepEqual(
    telemetry.clients.map((c) => c.mac),
    ['44:44:44:44:44:44']
  );
  assert.equal(telemetry.clients[0].portOrRadio, 'LAN 3');
});

test('buildTopologyGraph designates non-Wi-Fi direct clients as Ethernet without fake link speeds', () => {
  const snap = makeSnapshot();
  snap.hosts.push(
    makeHost({
      ip: '192.168.1.99',
      mac: 'de:ad:be:ef:00:99',
      hostname: 'Desktop Mac',
      rxBps: 250_000,
      txBps: 40_000,
    })
  );
  const graph = buildTopologyGraph(snap);
  const wiredNode = graph.nodes.find((n) => n.id === 'client:192.168.1.99');
  assert.ok(wiredNode);
  assert.equal(wiredNode.connectionType, 'ethernet');
  assert.equal(wiredNode.linkSpeedLabel, 'Ethernet');
  assert.equal(wiredNode.linkSpeedMbps, 0);

  // Internet node reflects WAN details from router
  const internetNode = graph.nodes.find((n) => n.id === 'internet');
  assert.ok(internetNode);
  assert.equal(internetNode.ip, '73.162.48.214');
  assert.equal(internetNode.wan?.gateway, '73.162.48.1');
  assert.equal(internetNode.sublabel, '73.162.48.214 · 2.5 GbE');
});

test('parseSatelliteInfoWifi parses JSON and text outputs from /usr/sbin/satelliteinfo wifi', () => {
  const jsonRaw = JSON.stringify([
    {
      mac: 'AA:BB:CC:11:22:33',
      ip: '192.168.1.3',
      model: 'RBS50',
      name: 'Living Room',
      backhaul_type: '5G',
      backhaul_status: 'Good',
      link_rate: '1733 Mbps',
      rssi: '-54',
    },
    {
      mac: 'AA:BB:CC:44:55:66',
      ip: '192.168.1.4',
      model: 'RBS50',
      backhaul_type: 'Wired',
      backhaul_status: 'Good',
      link_rate: 1000,
    },
  ]);

  const parsed = parseSatelliteInfoWifi(jsonRaw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].mac, 'aa:bb:cc:11:22:33');
  assert.equal(parsed[0].backhaulType, 'wifi');
  assert.equal(parsed[0].backhaulSpeedMbps, 1733);
  assert.equal(parsed[0].signalDbm, -54);
  assert.equal(parsed[0].backhaulStatus, 'Good');
  assert.equal(parsed[1].backhaulType, 'ethernet');
  assert.equal(parsed[1].backhaulSpeedMbps, 1000);
});

test('convertProbeToTelemetry filters tagged CPU switch ports and 0M/0M ghost Wi-Fi stations', () => {
  const cfg: SatelliteConfig = {
    id: 'sat-vlan',
    name: 'Den Satellite',
    host: '192.168.1.5',
    port: 22,
    username: 'root',
    authMethod: 'password',
    pollIntervalSec: 5,
    enabled: true,
  };

  const raw = [
    '===META===',
    'HOST=RBS50-Den',
    'UPTIME=9000.00 10000.00',
    '===SWCONFIG===',
    'VLAN|ports: 0t 1 2 3 4 6t',
    'Port 0:',
    '  link: port:0 link:up speed:1000baseT full-duplex',
    'Port 1:',
    '  link: port:1 link:up speed:1000baseT full-duplex',
    'Port 6:',
    '  link: port:6 link:up speed:1000baseT full-duplex',
    '===WIFI_INFO===',
    'ath1      IEEE 802.11ac  ESSID:"HomeWiFi"',
    '          Mode:Master  Frequency:5.18 GHz',
    '===WIFI===',
    'WIFI_IF=ath1',
    'ADDR               AID CHAN TXRATE RXRATE RSSI MINRSSI MAXRSSI IDLE',
    'aa:aa:aa:aa:aa:01    1   36     0M     0M   30      20      35    0',
    'bb:bb:bb:bb:bb:02    2   36   866M   780M   44      40      48    0',
  ].join('\n');

  const { telemetry } = convertProbeToTelemetry(cfg, raw, null, 1_700_000_000_000);
  // Only physical Port 1 remains (CPU ports 0t and 6t excluded)
  assert.deepEqual(
    telemetry.ports.map((p) => p.id),
    ['port1']
  );
  // Ghost 0M/0M station excluded; real station kept with 5 GHz band
  assert.deepEqual(
    telemetry.clients.map((c) => c.mac),
    ['bb:bb:bb:bb:bb:02']
  );
  assert.equal(telemetry.clients[0].wifiBand, '5 GHz');
});

test('convertProbeToTelemetry filters 7-port QCA8337 satellite switch down to 4 physical LAN ports (1..4)', () => {
  const cfg: SatelliteConfig = {
    id: 'sat-qca7',
    name: 'Garage Satellite',
    host: '192.168.1.6',
    port: 22,
    username: 'root',
    authMethod: 'password',
    pollIntervalSec: 5,
    enabled: true,
  };

  const raw = [
    '===META===',
    'HOST=RBS50-Garage',
    'UPTIME=5000.00 9000.00',
    '===IFACES===',
    'eth0|up|1000|full|100000|50000|0',
    'eth0.1|up|1000|full|100000|50000|0',
    'eth0.10|up|1000|full|20000|10000|0',
    '===SWCONFIG===',
    'Port 0:',
    '  link: port:0 link:up speed:1000baseT full-duplex',
    'Port 1:',
    '  link: port:1 link:up speed:1000baseT full-duplex',
    'Port 2:',
    '  link: port:2 link:down',
    'Port 3:',
    '  link: port:3 link:up speed:1000baseT full-duplex',
    'Port 4:',
    '  link: port:4 link:down',
    'Port 5:',
    '  link: port:5 link:up speed:1000baseT full-duplex',
    'Port 6:',
    '  link: port:6 link:up speed:1000baseT full-duplex',
  ].join('\n');

  const { telemetry } = convertProbeToTelemetry(cfg, raw, null, 1_700_000_000_000);
  assert.equal(telemetry.ports.length, 4);
  assert.deepEqual(
    telemetry.ports.map((p) => p.id),
    ['port1', 'port2', 'port3', 'port4']
  );
  assert.deepEqual(
    telemetry.ports.map((p) => p.label),
    ['LAN 1 (Backhaul)', 'LAN 2', 'LAN 3', 'LAN 4']
  );
});

