export type TransportProtocol = 'TCP' | 'UDP' | 'ICMP' | 'OTHER';

export type BandwidthUnit = 'Mb/s' | 'MB/s';

export type TimeWindow = '1m' | '5m' | '15m' | '1h' | '6h' | '24h';

export type PersistenceMode = 'memory' | 'disk';

export type ConntrackState =
  | 'ESTABLISHED'
  | 'SYN_SENT'
  | 'SYN_RECV'
  | 'FIN_WAIT'
  | 'TIME_WAIT'
  | 'CLOSE_WAIT'
  | 'CLOSE'
  | 'STATELESS';

export interface RawConntrackFlow {
  id?: string;
  proto: string;
  state?: string;
  ttl?: number;
  src: string;
  dst: string;
  sport: number;
  dport: number;
  txBytes: number;
  rxBytes: number;
  txPackets?: number;
  rxPackets?: number;
  assured?: boolean;
  mark?: number;
}

export interface InterfaceCounters {
  iface: string;
  rxBytes: number;
  txBytes: number;
  rxPackets?: number;
  txPackets?: number;
  rxErrors?: number;
  txErrors?: number;
}

export interface ArpEntry {
  ip: string;
  mac: string;
  device: string;
  hostname?: string;
  vendor?: string;
}

export interface SystemMetrics {
  hostname: string;
  kernel: string;
  arch: string;
  uptimeSec: number;
  load1m: number;
  memUsedPct: number;
  conntrackCount: number;
  conntrackMax: number;
}

export interface ProbeSnapshot {
  probeId: string;
  timestamp: number;
  source: 'live' | 'simulator';
  iface: InterfaceCounters;
  flows: RawConntrackFlow[];
  arp: ArpEntry[];
  system?: SystemMetrics;
  rawConntrackLines?: string[];
}

export interface GeoIpInfo {
  countryCode?: string;
  countryName?: string;
  city?: string;
  asn?: number;
  org?: string;
  source: 'maxmind';
}

export interface EnrichedFlow {
  id: string;
  proto: TransportProtocol;
  app: string;
  state: ConntrackState;
  ttl: number;
  srcIp: string;
  srcHost: string;
  srcMac?: string;
  sport: number;
  dstIp: string;
  dstHost?: string;
  dstService: string;
  dstGeo?: GeoIpInfo;
  dport: number;
  txBytes: number;
  rxBytes: number;
  totalBytes: number;
  txBps: number;
  rxBps: number;
  totalBps: number;
  assured: boolean;
  firstSeen: number;
  lastSeen: number;
}

export interface TrafficPoint {
  timestamp: number;
  rxBps: number;
  txBps: number;
  activeFlows: number;
}

export type DeviceNameSource = 'alias' | 'lan-dns' | 'dhcp' | 'fingerprint' | 'ip';

export interface DeviceAlias {
  key: string;
  matchBy: 'mac' | 'ip';
  name: string;
}

export interface HostSummary {
  ip: string;
  mac: string;
  hostname: string;
  vendor: string;
  nameSource: DeviceNameSource;
  isRandomizedMac: boolean;
  ptrHostname?: string;
  deviceHint?: string;
  aliasKey?: string;
  aliasMatchBy?: 'mac' | 'ip';
  activeFlows: number;
  rxBytes: number;
  txBytes: number;
  totalBytes: number;
  rxBps: number;
  txBps: number;
  topApps: string[];
  lastSeen: number;
}

export interface ProtocolSummary {
  app: string;
  proto: TransportProtocol;
  bytes: number;
  bps: number;
  flowCount: number;
  sharePct: number;
}

export interface RemoteEndpointSummary {
  ip: string;
  label: string;
  service: string;
  geo?: GeoIpInfo;
  ports: number[];
  bytes: number;
  bps: number;
  flowCount: number;
}

export interface ClientDestinationLink {
  clientIp: string;
  clientName: string;
  service: string;
  rxBps: number;
  txBps: number;
  totalBps: number;
  totalBytes: number;
  flowCount: number;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: 'wan_rx_mbps' | 'wan_tx_mbps' | 'host_flows' | 'total_flows';
  threshold: number;
  enabled: boolean;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
  acknowledged: boolean;
}

export interface ProbeStatus {
  connected: boolean;
  mode: 'live' | 'simulator' | 'disconnected';
  probeId: string;
  hostname: string;
  kernel: string;
  arch: string;
  iface: string;
  uptimeSec: number;
  load1m: number;
  memUsedPct: number;
  conntrackCount: number;
  conntrackMax: number;
  lastHeartbeat: number;
  simulatorEnabled: boolean;
}

export interface ServerConfig {
  probeToken: string;
  persistenceMode: PersistenceMode;
  cacheDir: string;
  rdnsEnabled: boolean;
  rdnsTtlSec: number;
  rdnsSkipPrivate: boolean;
  lanDnsEnabled: boolean;
  lanDnsServer: string;
  lanDnsTtlSec: number;
  stripLanDomain: boolean;
  geoipEnabled: boolean;
  geoipDir: string;
}

export interface ServerStats {
  configPath: string;
  activeCacheDir: string;
  persistedSnapshots: number;
  diskLogSizeBytes: number;
  rdnsCacheSize: number;
  rdnsHits: number;
  rdnsMisses: number;
  lanDnsCacheSize: number;
  lanDnsHits: number;
  lanDnsMisses: number;
  lanDnsResolved: number;
  randomizedMacCount: number;
  geoipActiveDir: string;
  geoipCityLoaded: boolean;
  geoipAsnLoaded: boolean;
  geoipCityFile: string | null;
  geoipAsnFile: string | null;
  geoipLookups: number;
}

export interface DashboardSnapshot {
  probe: ProbeStatus;
  kpis: {
    rxBps: number;
    txBps: number;
    combinedBps: number;
    totalRxBytes: number;
    totalTxBytes: number;
    activeFlows: number;
    activeHosts: number;
    peakRxBps: number;
    peakTxBps: number;
  };
  history: TrafficPoint[];
  rollupHistory: TrafficPoint[];
  flows: EnrichedFlow[];
  hosts: HostSummary[];
  protocols: ProtocolSummary[];
  remotes: RemoteEndpointSummary[];
  clientLinks: ClientDestinationLink[];
  rules: AlertRule[];
  alerts: AlertEvent[];
  deviceAliases: Record<string, DeviceAlias>;
  serverConfig: ServerConfig;
  serverStats: ServerStats;
}
