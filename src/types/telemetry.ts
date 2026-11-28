export type TransportProtocol = 'TCP' | 'UDP' | 'ICMP' | 'OTHER';

export type BandwidthUnit = 'Mbps' | 'MB/s';

export type TimeFormat = '12h' | '24h';

export type TimeWindow = '5m' | '15m' | '1h' | '3h' | '6h';

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

export type DestinationCategory =
  | 'Streaming'
  | 'Social & Messaging'
  | 'Gaming'
  | 'Cloud & Hosting'
  | 'CDN & Web'
  | 'Communication'
  | 'Apple & Devices'
  | 'DNS & Infrastructure'
  | 'File & Downloads'
  | 'Local Network'
  | 'Other';

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
  serviceName?: string;
  serviceProtocol?: string;
  advertisedServices?: string[];
  model?: string;
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

export interface EthernetPortMetrics {
  id: string;
  label: string;
  role: 'wan' | 'lan' | 'backhaul' | 'wifi';
  linkUp: boolean;
  speedMbps: number;
  duplex?: 'full' | 'half' | 'unknown';
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
}

export type WifiBand = '2.4 GHz' | '5 GHz' | '6 GHz';

export interface SatelliteClientLink {
  mac: string;
  ip?: string;
  connectionType: 'ethernet' | 'wifi';
  portOrRadio: string;
  wifiBand?: WifiBand;
  linkSpeedMbps: number;
  wifiRxMbps?: number;
  wifiTxMbps?: number;
  signalDbm?: number;
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
}

export type SatelliteAuthMethod = 'password' | 'key';

export interface SatelliteConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SatelliteAuthMethod;
  password?: string;
  privateKey?: string;
  backhaulInterface?: string;
  pollIntervalSec: number;
  enabled: boolean;
}

export interface PublicSatelliteConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SatelliteAuthMethod;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  backhaulInterface: string;
  pollIntervalSec: number;
  enabled: boolean;
}

export interface WanDetails {
  ip?: string;
  gateway?: string;
  dns: string[];
  iface: string;
  linkSpeedMbps: number;
  duplex?: 'full' | 'half' | 'unknown';
  mtu?: number;
  state?: string;
  connectionType?: string;
  mac?: string;
}

export interface SatelliteInfoEntry {
  mac?: string;
  ip?: string;
  name?: string;
  model?: string;
  backhaulType: 'ethernet' | 'wifi';
  backhaulStatus?: string;
  backhaulSpeedMbps?: number;
  signalDbm?: number;
  band?: string;
}

export interface SatelliteTelemetry {
  id: string;
  name: string;
  host: string;
  model?: string;
  connected: boolean;
  source: 'ssh' | 'router' | 'simulator';
  lastSeen: number;
  lastError?: string;
  uptimeSec: number;
  backhaulType: 'ethernet' | 'wifi';
  backhaulIface: string;
  backhaulSpeedMbps: number;
  backhaulSignalDbm?: number;
  backhaulStatus?: string;
  rxBps: number;
  txBps: number;
  rxBytes: number;
  txBytes: number;
  ports: EthernetPortMetrics[];
  clients: SatelliteClientLink[];
}

export interface TopologyTelemetry {
  routerPorts: EthernetPortMetrics[];
  routerWanSpeedMbps: number;
  wan?: WanDetails;
  routerClients: SatelliteClientLink[];
  satellites: SatelliteTelemetry[];
  satelliteConfigs: PublicSatelliteConfig[];
}

export interface ProbeSubnetEntry {
  cidr: string;
  iface: string;
  vlanId?: number;
  source?: 'interface' | 'vlan' | 'route';
}

export interface VlanConfig {
  id: string;
  name: string;
  cidr: string;
  vlanId?: number;
  description?: string;
}

export interface DetectedSubnet {
  cidr: string;
  iface?: string;
  vlanId?: number;
  hostCount: number;
  name?: string;
  isPrimary?: boolean;
  source?: 'router' | 'configured' | 'hosts';
}

export interface ProbeSnapshot {
  probeId: string;
  timestamp: number;
  source: 'live' | 'simulator';
  iface: InterfaceCounters;
  lanIfaces?: InterfaceCounters[];
  flows: RawConntrackFlow[];
  arp: ArpEntry[];
  system?: SystemMetrics;
  rawConntrackLines?: string[];
  ports?: EthernetPortMetrics[];
  wan?: WanDetails;
  subnets?: ProbeSubnetEntry[];
  satelliteInfo?: SatelliteInfoEntry[];
  routerClients?: SatelliteClientLink[];
  satellites?: SatelliteTelemetry[];
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
  dstCategory: DestinationCategory;
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
  lastActiveAt?: number;
  ended?: boolean;
  endedAt?: number;
}

export interface TrafficPoint {
  timestamp: number;
  rxBps: number;
  txBps: number;
  activeFlows: number;
  routerLoadPct?: number;
}

export type DeviceNameSource = 'alias' | 'lan-dns' | 'service' | 'dhcp' | 'fingerprint' | 'ip';

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
  serviceName?: string;
  serviceProtocol?: string;
  advertisedServices?: string[];
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
  topServices: string[];
  lastSeen: number;
  connectionType?: 'ethernet' | 'wifi';
  linkRadioOrPort?: string;
  wifiBand?: WifiBand;
  apName?: string;
  wifiRxMbps?: number;
  wifiTxMbps?: number;
  wifiSignalDbm?: number;
  vlanName?: string;
  vlanCidr?: string;
  vlanId?: number;
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
  category: DestinationCategory;
  ports: number[];
  bytes: number;
  bps: number;
  flowCount: number;
}

export interface ClientDestinationLink {
  clientIp: string;
  clientName: string;
  service: string;
  category: DestinationCategory;
  scope: 'internet' | 'lan';
  dstIp?: string;
  rxBps: number;
  txBps: number;
  totalBps: number;
  totalBytes: number;
  flowCount: number;
}

export type AlertMetric =
  | 'wan_rx_mbps'
  | 'wan_tx_mbps'
  | 'wan_combined_mbps'
  | 'host_rx_mbps'
  | 'host_tx_mbps'
  | 'host_flows'
  | 'total_flows'
  | 'new_device'
  | 'agent_offline'
  | 'router_high_load'
  | 'router_high_mem';

export interface AlertRule {
  id: string;
  name: string;
  metric: AlertMetric;
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

export interface NotificationConfig {
  ntfy: {
    enabled: boolean;
    serverUrl: string;
    topic: string;
    token: string;
    priority: 'low' | 'default' | 'high' | 'urgent';
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
  };
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
  simulatorAvailable: boolean;
}

export interface ConnectionsTablePrefs {
  showAppProtocol: boolean;
  showProtocol: boolean;
  showLocalDevice: boolean;
  showLocalIp: boolean;
  showLocalPort: boolean;
  showDestination: boolean;
  showDestinationRdns: boolean;
  showDestinationIpPort: boolean;
  showCategory: boolean;
  showDownload: boolean;
  showUpload: boolean;
  showTotal: boolean;
  showDuration: boolean;
}

export interface DevicesTablePrefs {
  showIp: boolean;
  showMac: boolean;
  showVendorSource: boolean;
  showConnection: boolean;
  showTopServices: boolean;
  showConnections: boolean;
  showDownload: boolean;
  showUpload: boolean;
  showTotal: boolean;
}

export interface TablePreferences {
  connections: ConnectionsTablePrefs;
  devices: DevicesTablePrefs;
}

export interface FeatureVisibility {
  flows: boolean;
  topDevices: boolean;
  topDestinations: boolean;
  trafficMap: boolean;
  connections: boolean;
  devices: boolean;
  alerts: boolean;
  agent: boolean;
}

export interface ServerConfig {
  probeToken: string;
  persistenceMode: PersistenceMode;
  cacheDir: string;
  rdnsEnabled: boolean;
  rdnsServer: string;
  rdnsTtlSec: number;
  rdnsSkipPrivate: boolean;
  lanDnsEnabled: boolean;
  lanDnsServer: string;
  lanDnsTtlSec: number;
  stripLanDomain: boolean;
  inferDeviceNames: boolean;
  dhcpLeasesPath: string;
  ispName: string;
  ispMaxDownMbps: number;
  ispMaxUpMbps: number;
  timeFormat: TimeFormat;
  vlans?: VlanConfig[];
  tablePreferences: TablePreferences;
  featureVisibility: FeatureVisibility;
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
}

export interface LanTrafficSummary {
  iface: string;
  rxBps: number;
  txBps: number;
  totalBps: number;
  rxBytes: number;
  txBytes: number;
  activeInterfaces?: string[];
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
  lanSummary?: LanTrafficSummary;
  detectedSubnets?: DetectedSubnet[];
  history: TrafficPoint[];
  rollupHistory: TrafficPoint[];
  flows: EnrichedFlow[];
  hosts: HostSummary[];
  protocols: ProtocolSummary[];
  remotes: RemoteEndpointSummary[];
  clientLinks: ClientDestinationLink[];
  topology: TopologyTelemetry;
  rules: AlertRule[];
  alerts: AlertEvent[];
  notifications: NotificationConfig;
  deviceAliases: Record<string, DeviceAlias>;
  serverConfig: ServerConfig;
  serverStats: ServerStats;
}
