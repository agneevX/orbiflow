import type {
  AlertEvent,
  AlertRule,
  ArpEntry,
  ClientDestinationLink,
  DashboardSnapshot,
  DetectedSubnet,
  DeviceAlias,
  EnrichedFlow,
  EthernetPortMetrics,
  HostSummary,
  InterfaceCounters,
  LanTrafficSummary,
  NotificationConfig,
  ProbeSnapshot,
  ProbeStatus,
  ProbeSubnetEntry,
  ProtocolSummary,
  PublicSatelliteConfig,
  RawConntrackFlow,
  RemoteEndpointSummary,
  SatelliteClientLink,
  SatelliteInfoEntry,
  SatelliteTelemetry,
  ServerConfig,
  ServerStats,
  TopologyTelemetry,
  TrafficPoint,
  WanDetails,
} from '../types/telemetry';
import {
  classifyApplication,
  computePerceivedRouterLoadPct,
  describeRemoteIp,
  extractNamedService,
  extractWifiBand,
  hasTangibleTraffic,
  isActiveConnectionState,
  isPrivateIp,
  normalizeProtocol,
  normalizeState,
} from './formatters';
import {
  fingerprintDeviceHint,
  isMeaningfulHostname,
  normalizeMac,
  resolveHostIdentity,
} from './deviceIdentity';
import {
  DEFAULT_FEATURE_VISIBILITY,
  DEFAULT_TABLE_PREFERENCES,
  sanitizeFeatureVisibility,
  sanitizeTablePreferences,
} from './tablePreferences';
import {
  findMatchingVlan,
  getIpv4Slash24,
  ipMatchesCidr,
  parseIpv4Cidr,
  sanitizeVlanConfigs,
} from './vlanUtils';
import { createInitialRevisions, type SnapshotRevisions } from './wsProtocol';

interface FlowTrackRecord {
  firstSeen: number;
  lastSeen: number;
  lastActiveAt: number;
  hadTangibleTraffic: boolean;
  endedAt?: number;
  prevTxBytes: number;
  prevRxBytes: number;
  txBps: number;
  rxBps: number;
  flow: EnrichedFlow;
}

interface KnownHostRecord {
  ip: string;
  mac: string;
  dhcpHostname?: string;
  providedVendor?: string;
  serviceName?: string;
  serviceProtocol?: string;
  serviceModel?: string;
  advertisedServices?: string[];
  lastSeen: number;
}

export type RdnsLookupFn = (ip: string) => string | null;

export interface ServiceIdentityLookupResult {
  name?: string;
  protocol?: string;
  model?: string;
  services?: string[];
}

export type ServiceLookupFn = (ip: string) => ServiceIdentityLookupResult | null;

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    id: 'rule-wan-rx',
    name: 'High Download Speed',
    metric: 'wan_rx_mbps',
    threshold: 250,
    enabled: true,
  },
  {
    id: 'rule-wan-tx',
    name: 'High Upload Speed',
    metric: 'wan_tx_mbps',
    threshold: 65,
    enabled: true,
  },
  {
    id: 'rule-wan-combined',
    name: 'High Combined Bandwidth',
    metric: 'wan_combined_mbps',
    threshold: 300,
    enabled: false,
  },
  {
    id: 'rule-host-rx',
    name: 'Device Download Spike',
    metric: 'host_rx_mbps',
    threshold: 150,
    enabled: true,
  },
  {
    id: 'rule-host-tx',
    name: 'Device Upload Spike',
    metric: 'host_tx_mbps',
    threshold: 40,
    enabled: true,
  },
  {
    id: 'rule-host-flows',
    name: 'Device Connection Spike',
    metric: 'host_flows',
    threshold: 60,
    enabled: true,
  },
  {
    id: 'rule-total-flows',
    name: 'High Total Connections',
    metric: 'total_flows',
    threshold: 1000,
    enabled: false,
  },
  {
    id: 'rule-new-device',
    name: 'New Device Joined Network',
    metric: 'new_device',
    threshold: 1,
    enabled: true,
  },
  {
    id: 'rule-agent-offline',
    name: 'Router Agent Disconnected',
    metric: 'agent_offline',
    threshold: 1,
    enabled: true,
  },
  {
    id: 'rule-router-load',
    name: 'High Router CPU Load',
    metric: 'router_high_load',
    threshold: 3,
    enabled: false,
  },
  {
    id: 'rule-router-mem',
    name: 'High Router Memory Usage',
    metric: 'router_high_mem',
    threshold: 85,
    enabled: false,
  },
];

const DEFAULT_NOTIFICATIONS: NotificationConfig = {
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
};

/**
 * Parses raw Linux 3.14 /proc/net/nf_conntrack lines emitted by lightweight BusyBox agents.
 */
export function parseProcConntrackLines(lines: string[]): RawConntrackFlow[] {
  const flows: RawConntrackFlow[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 10) continue;

    const proto = tokens[2] || 'tcp';
    const ttl = Number(tokens[4]) || 0;

    let state: string | undefined;
    let searchStart = 5;
    if (tokens[5] && !tokens[5].includes('=')) {
      state = tokens[5];
      searchStart = 6;
    }

    const orig: Record<string, string> = {};
    const reply: Record<string, string> = {};
    let inReply = false;
    let assured = false;

    for (let i = searchStart; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === '[ASSURED]') {
        assured = true;
        continue;
      }
      if (tok.startsWith('[')) continue;
      const eq = tok.indexOf('=');
      if (eq === -1) continue;
      const k = tok.slice(0, eq);
      const v = tok.slice(eq + 1);

      if (k === 'src' && orig.src !== undefined) {
        inReply = true;
      }
      const target = inReply ? reply : orig;
      if (target[k] === undefined) {
        target[k] = v;
      }
    }

    if (!orig.src || !orig.dst) continue;

    const sport = Number(orig.sport) || 0;
    const dport = Number(orig.dport) || 0;
    const txBytes = Number(orig.bytes) || 0;
    const rxBytes = Number(reply.bytes) || 0;

    flows.push({
      id: `${proto}:${orig.src}:${sport}->${orig.dst}:${dport}`,
      proto,
      state,
      ttl,
      src: orig.src,
      dst: orig.dst,
      sport,
      dport,
      txBytes,
      rxBytes,
      assured,
    });
  }

  return flows;
}

const UINT32_MODULO = 0x1_0000_0000; // 4,294,967,296 (32-bit ARMv7 Linux /proc/net/dev & conntrack wrap)
const DEFAULT_MAX_PLAUSIBLE_BPS = 1_250_000_000; // 10 Gbps ceiling to reject corrupted counter spikes

/**
 * Computes a safe byte delta across polling ticks:
 * - Recovers cleanly from 32-bit unsigned counter wraps (every 4.29 GB on 32-bit ARM routers)
 * - Rejects counter resets / interface reboots and physically impossible single-tick spikes
 */
export function computeCounterDelta(
  curr: number,
  prev: number,
  dtSec: number,
  maxPlausibleBps = DEFAULT_MAX_PLAUSIBLE_BPS
): number {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || curr < 0 || prev < 0) return 0;
  if (!Number.isFinite(dtSec) || dtSec <= 0) return 0;

  let delta = 0;
  if (curr >= prev) {
    delta = curr - prev;
  } else if (prev <= UINT32_MODULO && curr <= UINT32_MODULO) {
    // Candidate 32-bit unsigned counter wrap
    const wrappedDelta = UINT32_MODULO - prev + curr;
    // Only treat as a genuine wrap if the implied rate is plausible (otherwise it was a counter reset)
    if (wrappedDelta / dtSec <= maxPlausibleBps) {
      delta = wrappedDelta;
    } else {
      return 0;
    }
  } else {
    return 0;
  }

  if (delta / dtSec > maxPlausibleBps) {
    return 0;
  }
  return delta;
}

export class TrafficMonitorEngine {
  private history: TrafficPoint[] = []; // High-resolution samples (up to 65 minutes at 3s cadence for 5m/15m/1h)
  private readonly maxHistoryPoints = 1800;
  private readonly maxHistoryAgeMs = 65 * 60_000;
  private rollupHistory: TrafficPoint[] = []; // 1-minute buckets (strictly capped at 6h = 360 buckets)
  private readonly maxRollupPoints = 360;
  private readonly maxRollupAgeMs = 6 * 60 * 60_000;
  private currentBucketStart = 0;
  private bucketSamples: TrafficPoint[] = [];

  private flowRecords = new Map<string, FlowTrackRecord>();
  private readonly endedFlowRetentionMs = 5 * 60_000; // Keep ended flows visible for 5m
  private readonly maxActiveSnapshotFlows = 300; // Keep top 300 active flows for browser efficiency
  private readonly maxRetainedEndedFlows = 100;
  private readonly maxTrackedFlowRecords = 4000; // Hard bound on internal conntrack map over long uptime
  private knownHostsCache = new Map<string, KnownHostRecord>();
  private readonly hostPresenceTtlMs = 15 * 60_000; // Keep connected hosts stable across brief ARP aging
  private lastIface: InterfaceCounters | null = null;
  private lastTimestamp = 0;
  private peakRxBps = 0;
  private peakTxBps = 0;
  private rules: AlertRule[] = DEFAULT_ALERT_RULES.map((r) => ({ ...r }));
  private alerts: AlertEvent[] = [];
  private lastAlertFiredAt = new Map<string, number>();
  private knownDeviceKeys = new Set<string>();
  private hasDeviceBaseline = false;
  private deviceAliases: Record<string, DeviceAlias> = {};
  private notifications: NotificationConfig = {
    ntfy: { ...DEFAULT_NOTIFICATIONS.ntfy },
    telegram: { ...DEFAULT_NOTIFICATIONS.telegram },
  };

  private serverConfig: ServerConfig = {
    probeToken: '',
    persistenceMode: 'memory',
    cacheDir: '/config/cache',
    rdnsEnabled: true,
    rdnsServer: '',
    rdnsTtlSec: 3600,
    rdnsSkipPrivate: true,
    lanDnsEnabled: true,
    lanDnsServer: '',
    lanDnsTtlSec: 300,
    stripLanDomain: true,
    inferDeviceNames: true,
    dhcpLeasesPath: '',
    ispName: 'Internet',
    ispMaxDownMbps: 1000,
    ispMaxUpMbps: 200,
    timeFormat: '12h',
    vlans: [],
    tablePreferences: sanitizeTablePreferences(DEFAULT_TABLE_PREFERENCES),
    featureVisibility: sanitizeFeatureVisibility(DEFAULT_FEATURE_VISIBILITY),
  };

  private hostTopServicesCache = new Map<string, { services: string[]; updatedAt: number }>();
  private readonly topServicesRefreshMs = 15_000;
  private routerPorts: EthernetPortMetrics[] = [];
  private routerSubnets: ProbeSubnetEntry[] = [];
  private prevRouterPortBytes = new Map<string, { rx: number; tx: number; ts: number }>();
  private prevLanIfaceBytes = new Map<string, { rx: number; tx: number; ts: number }>();
  private lastWanRxBps = 0;
  private lastWanTxBps = 0;
  private latestLanSummary: LanTrafficSummary | undefined = undefined;
  private wanDetails: WanDetails | null = null;
  private routerSatelliteInfo: SatelliteInfoEntry[] = [];
  private routerClients: SatelliteClientLink[] = [];
  private probeSatellites: SatelliteTelemetry[] = [];
  private sshSatellites: SatelliteTelemetry[] = [];
  private satelliteConfigs: PublicSatelliteConfig[] = [];

  private serverStats: ServerStats = {
    configPath: '/config/config.json',
    activeCacheDir: '/config/cache',
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
  };

  private probeStatus: ProbeStatus = {
    connected: false,
    mode: 'disconnected',
    probeId: 'router-wan',
    hostname: 'router',
    kernel: 'Linux',
    arch: '',
    iface: 'eth0',
    uptimeSec: 0,
    load1m: 0,
    memUsedPct: 0,
    conntrackCount: 0,
    conntrackMax: 32768,
    lastHeartbeat: 0,
    simulatorEnabled: false,
    simulatorAvailable: false,
  };

  private latestSnapshot: DashboardSnapshot;
  private revisions: SnapshotRevisions = createInitialRevisions();
  private lastDetectedSubnetsSig = '';
  private lastTopologySig = '';

  constructor() {
    this.latestSnapshot = this.buildEmptySnapshot();
  }

  public getRevisions(): SnapshotRevisions {
    return { ...this.revisions };
  }

  private buildEmptySnapshot(): DashboardSnapshot {
    return {
      probe: { ...this.probeStatus },
      kpis: {
        rxBps: 0,
        txBps: 0,
        combinedBps: 0,
        totalRxBytes: 0,
        totalTxBytes: 0,
        activeFlows: 0,
        activeHosts: 0,
        peakRxBps: 0,
        peakTxBps: 0,
      },
      history: [],
      rollupHistory: [],
      flows: [],
      hosts: [],
      protocols: [],
      remotes: [],
      clientLinks: [],
      detectedSubnets: [],
      topology: this.buildTopologyTelemetry(),
      rules: this.rules.map((r) => ({ ...r })),
      alerts: [],
      notifications: {
        ntfy: { ...this.notifications.ntfy },
        telegram: { ...this.notifications.telegram },
      },
      deviceAliases: { ...this.deviceAliases },
      serverConfig: { ...this.serverConfig },
      serverStats: { ...this.serverStats },
    };
  }

  private normalizePhysicalPorts(
    ports: EthernetPortMetrics[],
    mode: 'router' | 'satellite',
    wanIface?: string
  ): EthernetPortMetrics[] {
    if (!Array.isArray(ports) || ports.length === 0) return [];
    const cleaned = ports.filter((p) => {
      const id = String(p.id || '').trim();
      if (!id) return false;
      // Exclude virtual VLAN subinterfaces / aliases (e.g. eth0.1, eth1.10, eth1@if2)
      if (id.includes('.') || id.includes('@') || id.includes(':')) return false;
      // Exclude QCA8337 internal CPU/GMAC ports (port0, port5, port6)
      const portMatch = /^port(\d+)$/i.exec(id);
      if (portMatch) {
        const num = Number(portMatch[1]);
        if (num === 0 || num >= 5) return false;
      }
      return true;
    });

    if (mode === 'router') {
      const wanPort =
        cleaned.find((p) => p.role === 'wan') ||
        (wanIface ? cleaned.find((p) => p.id === wanIface) : undefined);
      const lanPorts = cleaned
        .filter((p) => p !== wanPort && p.role !== 'wan')
        .slice(0, 3)
        .map((p, idx) => ({
          ...p,
          role: 'lan' as const,
          label: /^LAN\s+\d+/i.test(p.label) ? `LAN ${idx + 1}` : p.label || `LAN ${idx + 1}`,
        }));
      return wanPort ? [{ ...wanPort, role: 'wan' as const }, ...lanPorts] : lanPorts;
    }

    // Satellite: all 4 physical ports are LAN (one may serve as Ethernet backhaul)
    return cleaned.slice(0, 4).map((p, idx) => {
      const isBackhaul = p.role === 'backhaul' || /backhaul/i.test(p.label || '');
      return {
        ...p,
        role: isBackhaul ? ('backhaul' as const) : ('lan' as const),
        label: isBackhaul ? `LAN ${idx + 1} (Backhaul)` : `LAN ${idx + 1}`,
      };
    });
  }

  private buildTopologyTelemetry(): TopologyTelemetry {
    const normalizedRouterPorts = this.normalizePhysicalPorts(
      this.routerPorts,
      'router',
      this.probeStatus.iface
    );
    const wanPort =
      normalizedRouterPorts.find((p) => p.role === 'wan') ||
      normalizedRouterPorts.find((p) => p.id === this.probeStatus.iface) ||
      normalizedRouterPorts.find((p) => p.linkUp && p.speedMbps > 0);
    const routerWanSpeedMbps = this.wanDetails?.linkSpeedMbps || wanPort?.speedMbps || 1000;

    // Combine SSH-polled satellites with any probe-reported/simulated satellites (SSH takes precedence by id)
    const mergedById = new Map<string, SatelliteTelemetry>();
    for (const sat of this.probeSatellites) {
      mergedById.set(sat.id, {
        ...sat,
        ports: this.normalizePhysicalPorts(sat.ports, 'satellite'),
      });
    }
    for (const sat of this.sshSatellites) {
      mergedById.set(sat.id, {
        ...sat,
        ports: this.normalizePhysicalPorts(sat.ports, 'satellite'),
      });
    }

    // Merge authoritative Orbi `/usr/sbin/satelliteinfo wifi` entries reported by the main router
    const matchedHosts = new Set<string>();
    for (const sat of mergedById.values()) {
      const info = this.routerSatelliteInfo.find(
        (entry) => entry.ip && entry.ip === sat.host
      );
      if (info) {
        matchedHosts.add(info.ip!);
        sat.backhaulType = info.backhaulType;
        if (info.backhaulSpeedMbps && info.backhaulSpeedMbps > 0) {
          if (info.backhaulType === 'wifi' || sat.backhaulSpeedMbps <= 0) {
            sat.backhaulSpeedMbps = info.backhaulSpeedMbps;
          }
        }
        if (info.signalDbm !== undefined) sat.backhaulSignalDbm = info.signalDbm;
        if (info.backhaulStatus) sat.backhaulStatus = info.backhaulStatus;
        if (info.model && !sat.model) sat.model = info.model;
      }
    }

    // Surface router-discovered Orbi satellites even when SSH polling is not yet configured
    for (let idx = 0; idx < this.routerSatelliteInfo.length; idx++) {
      const info = this.routerSatelliteInfo[idx];
      if (info.ip && matchedHosts.has(info.ip)) continue;
      const hostKey = info.ip || info.mac || `router-sat-${idx + 1}`;
      const synthId = `router-sat:${hostKey}`;
      if (mergedById.has(synthId)) continue;
      mergedById.set(synthId, {
        id: synthId,
        name: info.name || info.model || `Orbi Satellite ${idx + 1}`,
        host: info.ip || info.mac || 'unknown',
        model: info.model,
        connected: !info.backhaulStatus || !/disconnect|offline|down/i.test(info.backhaulStatus),
        source: 'router',
        lastSeen: this.probeStatus.lastHeartbeat || Date.now(),
        uptimeSec: 0,
        backhaulType: info.backhaulType,
        backhaulIface: info.band || (info.backhaulType === 'ethernet' ? 'Ethernet' : 'Wi-Fi'),
        backhaulSpeedMbps: info.backhaulSpeedMbps || 0,
        ...(info.signalDbm !== undefined ? { backhaulSignalDbm: info.signalDbm } : {}),
        ...(info.backhaulStatus ? { backhaulStatus: info.backhaulStatus } : {}),
        rxBps: 0,
        txBps: 0,
        rxBytes: 0,
        txBytes: 0,
        ports: [],
        clients: [],
      });
    }

    const wan: WanDetails | undefined = this.wanDetails
      ? {
          ...this.wanDetails,
          dns: [...(this.wanDetails.dns || [])],
          linkSpeedMbps: this.wanDetails.linkSpeedMbps || routerWanSpeedMbps,
        }
      : wanPort
        ? {
            iface: wanPort.id,
            dns: [],
            linkSpeedMbps: wanPort.speedMbps,
            duplex: wanPort.duplex,
            state: wanPort.linkUp ? 'up' : 'down',
          }
        : undefined;

    return {
      routerPorts: normalizedRouterPorts.map((p) => ({ ...p })),
      routerWanSpeedMbps,
      ...(wan ? { wan } : {}),
      routerClients: this.routerClients.map((c) => ({ ...c })),
      satellites: Array.from(mergedById.values()),
      satelliteConfigs: this.satelliteConfigs.map((c) => ({ ...c })),
    };
  }

  private isLanClientIp(ip: string, device?: string): boolean {
    if (!ip || !isPrivateIp(ip)) return false;
    if (ip.startsWith('127.') || ip.startsWith('169.254.')) return false;
    const wanIface = this.wanDetails?.iface || this.probeStatus.iface;
    if (device && wanIface && device === wanIface) return false;
    if (this.wanDetails?.ip && ip === this.wanDetails.ip) return false;
    if (this.wanDetails?.gateway && ip === this.wanDetails.gateway) return false;
    return true;
  }

  public setSatelliteConfigs(configs: PublicSatelliteConfig[]): void {
    this.satelliteConfigs = configs.map((c) => ({ ...c }));
    this.latestSnapshot = {
      ...this.latestSnapshot,
      topology: this.buildTopologyTelemetry(),
    };
    this.revisions.topology += 1;
  }

  public setSshSatellites(satellites: SatelliteTelemetry[]): void {
    this.sshSatellites = satellites.map((s) => ({
      ...s,
      ports: s.ports.map((p) => ({ ...p })),
      clients: s.clients.map((c) => ({ ...c })),
    }));
    this.latestSnapshot = {
      ...this.latestSnapshot,
      topology: this.buildTopologyTelemetry(),
    };
    this.revisions.topology += 1;
  }

  public hydrateFromStorage(
    saved: {
      history?: TrafficPoint[];
      rollupHistory?: TrafficPoint[];
      peakRxBps?: number;
      peakTxBps?: number;
      rules?: AlertRule[];
      alerts?: AlertEvent[];
      serverConfig?: ServerConfig;
    },
    now = Date.now()
  ): void {
    const historyCutoff = now - this.maxHistoryAgeMs;
    const rollupCutoff = now - this.maxRollupAgeMs;

    if (Array.isArray(saved.history)) {
      const sorted = saved.history
        .filter(
          (p) =>
            p &&
            Number.isFinite(p.timestamp) &&
            p.timestamp >= historyCutoff &&
            Number.isFinite(p.rxBps) &&
            Number.isFinite(p.txBps)
        )
        .sort((a, b) => a.timestamp - b.timestamp);
      const deduped: TrafficPoint[] = [];
      for (const p of sorted) {
        if (deduped.length > 0 && deduped[deduped.length - 1].timestamp === p.timestamp) {
          deduped[deduped.length - 1] = p;
        } else {
          deduped.push(p);
        }
      }
      this.history = deduped.slice(-this.maxHistoryPoints);
    }
    if (Array.isArray(saved.rollupHistory)) {
      const sorted = saved.rollupHistory
        .filter(
          (p) =>
            p &&
            Number.isFinite(p.timestamp) &&
            p.timestamp >= rollupCutoff &&
            Number.isFinite(p.rxBps) &&
            Number.isFinite(p.txBps)
        )
        .sort((a, b) => a.timestamp - b.timestamp);
      const deduped: TrafficPoint[] = [];
      for (const p of sorted) {
        if (deduped.length > 0 && deduped[deduped.length - 1].timestamp === p.timestamp) {
          deduped[deduped.length - 1] = p;
        } else {
          deduped.push(p);
        }
      }
      this.rollupHistory = deduped.slice(-this.maxRollupPoints);
    }
    if (typeof saved.peakRxBps === 'number') this.peakRxBps = saved.peakRxBps;
    if (typeof saved.peakTxBps === 'number') this.peakTxBps = saved.peakTxBps;
    if (Array.isArray(saved.rules) && saved.rules.length > 0) this.rules = saved.rules;
    if (Array.isArray(saved.alerts)) this.alerts = saved.alerts;
    if (saved.serverConfig) {
      this.serverConfig = {
        ...this.serverConfig,
        ...saved.serverConfig,
        vlans: sanitizeVlanConfigs(saved.serverConfig.vlans),
        tablePreferences: sanitizeTablePreferences(saved.serverConfig.tablePreferences),
        featureVisibility: sanitizeFeatureVisibility(saved.serverConfig.featureVisibility),
      };
    }
    this.latestSnapshot = {
      ...this.latestSnapshot,
      history: [...this.history],
      rollupHistory: [...this.rollupHistory],
      rules: this.rules.map((r) => ({ ...r })),
      alerts: this.alerts.map((a) => ({ ...a })),
      serverConfig: { ...this.serverConfig },
    };
    this.revisions.history += 1;
    this.revisions.rollup += 1;
    this.revisions.rules += 1;
    this.revisions.alerts += 1;
    this.revisions.serverConfig += 1;
  }

  public getExportableState() {
    return {
      history: this.history,
      rollupHistory: this.rollupHistory,
      peakRxBps: this.peakRxBps,
      peakTxBps: this.peakTxBps,
      rules: this.rules,
      alerts: this.alerts,
      serverConfig: this.serverConfig,
    };
  }

  public updateServerConfig(cfg: Partial<ServerConfig>, stats?: Partial<ServerStats>): void {
    const prevInfer = this.serverConfig.inferDeviceNames;
    const prevStrip = this.serverConfig.stripLanDomain;
    const prevLanDnsEnabled = this.serverConfig.lanDnsEnabled;
    const prevVlansSig = JSON.stringify(this.serverConfig.vlans || []);
    const nextTablePrefs = cfg.tablePreferences
      ? sanitizeTablePreferences(cfg.tablePreferences, this.serverConfig.tablePreferences)
      : this.serverConfig.tablePreferences;
    const nextFeatureVis = cfg.featureVisibility
      ? sanitizeFeatureVisibility(cfg.featureVisibility, this.serverConfig.featureVisibility)
      : this.serverConfig.featureVisibility;
    const nextVlans =
      cfg.vlans !== undefined
        ? sanitizeVlanConfigs(cfg.vlans)
        : sanitizeVlanConfigs(this.serverConfig.vlans);
    this.serverConfig = {
      ...this.serverConfig,
      ...cfg,
      vlans: nextVlans,
      tablePreferences: nextTablePrefs,
      featureVisibility: nextFeatureVis,
    };
    if (stats) {
      this.serverStats = { ...this.serverStats, ...stats };
    }
    this.latestSnapshot = {
      ...this.latestSnapshot,
      serverConfig: {
        ...this.serverConfig,
        vlans: nextVlans,
        tablePreferences: sanitizeTablePreferences(this.serverConfig.tablePreferences),
        featureVisibility: sanitizeFeatureVisibility(this.serverConfig.featureVisibility),
      },
      serverStats: { ...this.serverStats },
    };
    this.revisions.serverConfig += 1;
    if (stats) {
      this.revisions.serverStats += 1;
    }
    if (
      prevInfer !== this.serverConfig.inferDeviceNames ||
      prevStrip !== this.serverConfig.stripLanDomain ||
      prevLanDnsEnabled !== this.serverConfig.lanDnsEnabled ||
      prevVlansSig !== JSON.stringify(nextVlans)
    ) {
      this.reapplyAliasesToLatestSnapshot();
    }
  }

  public setServerStats(stats: Partial<ServerStats>): void {
    let changed = false;
    for (const [k, v] of Object.entries(stats)) {
      if ((this.serverStats as unknown as Record<string, unknown>)[k] !== v) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.serverStats = { ...this.serverStats, ...stats };
    this.latestSnapshot = {
      ...this.latestSnapshot,
      serverStats: { ...this.serverStats },
    };
    this.revisions.serverStats += 1;
  }

  public setSimulatorAvailable(available: boolean): void {
    this.probeStatus.simulatorAvailable = available;
    if (!available) {
      this.probeStatus.simulatorEnabled = false;
      if (this.probeStatus.mode === 'simulator') {
        this.probeStatus.connected = false;
        this.probeStatus.mode = 'disconnected';
      }
    }
    this.latestSnapshot = {
      ...this.latestSnapshot,
      probe: { ...this.probeStatus },
    };
  }

  public setSimulatorEnabled(enabled: boolean): void {
    const effective = this.probeStatus.simulatorAvailable ? enabled : false;
    this.probeStatus.simulatorEnabled = effective;
    if (!effective && this.probeStatus.mode === 'simulator') {
      this.probeStatus.connected = false;
      this.probeStatus.mode = 'disconnected';
    }
    this.latestSnapshot = {
      ...this.latestSnapshot,
      probe: { ...this.probeStatus },
    };
  }

  public isSimulatorEnabled(): boolean {
    return this.probeStatus.simulatorAvailable && this.probeStatus.simulatorEnabled;
  }

  public hasActiveLiveProbe(now = Date.now()): boolean {
    return this.probeStatus.mode === 'live' && now - this.probeStatus.lastHeartbeat < 20_000;
  }

  public markProbeDisconnected(probeId: string, now = Date.now()): AlertEvent[] {
    const fired: AlertEvent[] = [];
    if (this.probeStatus.mode === 'live' && this.probeStatus.probeId === probeId) {
      this.probeStatus.connected = false;
      this.probeStatus.mode = 'disconnected';

      const offlineRule = this.rules.find((r) => r.metric === 'agent_offline' && r.enabled);
      if (offlineRule) {
        const lastFired = this.lastAlertFiredAt.get(offlineRule.id) || 0;
        if (now - lastFired >= 20_000) {
          const alert: AlertEvent = {
            id: `${offlineRule.id}-${now}`,
            ruleId: offlineRule.id,
            ruleName: offlineRule.name,
            severity: 'critical',
            message: `Router agent "${probeId}" disconnected from server`,
            value: 1,
            threshold: offlineRule.threshold,
            timestamp: now,
            acknowledged: false,
          };
          this.lastAlertFiredAt.set(offlineRule.id, now);
          this.alerts.unshift(alert);
          if (this.alerts.length > 50) this.alerts.pop();
          fired.push(alert);
        }
      }

      this.latestSnapshot = {
        ...this.latestSnapshot,
        probe: { ...this.probeStatus },
        alerts: this.alerts.map((a) => ({ ...a })),
      };
      if (fired.length > 0) {
        this.revisions.alerts += 1;
      }
    }
    return fired;
  }

  public updateNotifications(cfg: NotificationConfig): NotificationConfig {
    this.notifications = {
      ntfy: { ...cfg.ntfy },
      telegram: { ...cfg.telegram },
    };
    this.latestSnapshot = {
      ...this.latestSnapshot,
      notifications: {
        ntfy: { ...this.notifications.ntfy },
        telegram: { ...this.notifications.telegram },
      },
    };
    this.revisions.notifications += 1;
    return this.latestSnapshot.notifications;
  }

  public mergeWithDefaultRules(savedRules: AlertRule[]): AlertRule[] {
    const byId = new Map(savedRules.map((r) => [r.id, r]));
    const merged: AlertRule[] = [];
    for (const def of DEFAULT_ALERT_RULES) {
      const existing = byId.get(def.id);
      if (existing) {
        merged.push({
          ...def,
          ...existing,
          threshold: Math.max(0.1, Number(existing.threshold) || def.threshold),
        });
        byId.delete(def.id);
      } else {
        merged.push({ ...def });
      }
    }
    for (const extra of byId.values()) {
      merged.push({
        ...extra,
        threshold: Math.max(0.1, Number(extra.threshold) || 1),
      });
    }
    return this.updateRules(merged);
  }

  public updateRules(nextRules: AlertRule[]): AlertRule[] {
    this.rules = nextRules.map((r) => ({
      ...r,
      threshold: Math.max(0.1, Number(r.threshold) || 1),
    }));
    this.latestSnapshot = {
      ...this.latestSnapshot,
      rules: this.rules.map((r) => ({ ...r })),
    };
    this.revisions.rules += 1;
    return this.rules;
  }

  public acknowledgeAlert(id: string): void {
    this.alerts = this.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a));
    this.latestSnapshot = {
      ...this.latestSnapshot,
      alerts: this.alerts.map((a) => ({ ...a })),
    };
    this.revisions.alerts += 1;
  }

  public clearAlerts(): void {
    this.alerts = [];
    this.latestSnapshot = {
      ...this.latestSnapshot,
      alerts: [],
    };
    this.revisions.alerts += 1;
  }

  public getDeviceAliases(): Record<string, DeviceAlias> {
    return { ...this.deviceAliases };
  }

  public setDeviceAliases(aliases: Record<string, DeviceAlias>): void {
    const clean: Record<string, DeviceAlias> = {};
    for (const [k, v] of Object.entries(aliases || {})) {
      if (v && typeof v.name === 'string' && v.name.trim()) {
        clean[k] = {
          key: k,
          matchBy: v.matchBy === 'ip' ? 'ip' : 'mac',
          name: v.name.trim().slice(0, 64),
        };
      }
    }
    this.deviceAliases = clean;
    this.reapplyAliasesToLatestSnapshot();
  }

  public setDeviceAlias(alias: DeviceAlias): Record<string, DeviceAlias> {
    const cleanName = alias.name.trim().slice(0, 64);
    if (!cleanName) {
      delete this.deviceAliases[alias.key];
    } else {
      this.deviceAliases[alias.key] = {
        key: alias.key,
        matchBy: alias.matchBy === 'ip' ? 'ip' : 'mac',
        name: cleanName,
      };
    }
    this.reapplyAliasesToLatestSnapshot();
    return this.getDeviceAliases();
  }

  public deleteDeviceAlias(key: string): Record<string, DeviceAlias> {
    delete this.deviceAliases[key];
    this.reapplyAliasesToLatestSnapshot();
    return this.getDeviceAliases();
  }

  private applyVlanTagsAndBuildSubnets(hosts: HostSummary[]): {
    hosts: HostSummary[];
    detectedSubnets: DetectedSubnet[];
  } {
    const userVlans = sanitizeVlanConfigs(this.serverConfig.vlans);
    const routerSubnetsNormalized: Array<{ cidr: string; iface?: string; vlanId?: number }> = [];
    for (const rs of this.routerSubnets) {
      const parsed = parseIpv4Cidr(rs.cidr);
      if (!parsed) continue;
      routerSubnetsNormalized.push({
        cidr: parsed.normalized,
        iface: rs.iface,
        vlanId: rs.vlanId,
      });
    }

    // Count hosts per /24 to determine primary LAN subnet when router does not explicitly report br0
    const slash24Counts = new Map<string, number>();
    for (const h of hosts) {
      const s24 = getIpv4Slash24(h.ip);
      if (s24) slash24Counts.set(s24, (slash24Counts.get(s24) || 0) + 1);
    }

    const explicitPrimaryRouter = routerSubnetsNormalized.find(
      (s) =>
        s.vlanId === undefined &&
        (s.iface === 'br0' || s.iface === 'br-lan' || s.iface === 'eth1')
    );

    let primaryCidr = explicitPrimaryRouter?.cidr || '';
    if (!primaryCidr) {
      // Exclude user-named VLANs when picking primary LAN if other subnets exist
      const userCidrs = new Set(userVlans.map((v) => v.cidr));
      const ranked = Array.from(slash24Counts.entries()).sort((a, b) => b[1] - a[1]);
      const nonUser = ranked.find(([c]) => !userCidrs.has(c));
      primaryCidr = nonUser?.[0] || ranked[0]?.[0] || '';
    }

    const taggedHosts = hosts.map((h) => {
      const matchedUser = findMatchingVlan(h.ip, userVlans);
      if (matchedUser) {
        return {
          ...h,
          vlanName: matchedUser.name,
          vlanCidr: matchedUser.cidr,
          ...(matchedUser.vlanId !== undefined ? { vlanId: matchedUser.vlanId } : { vlanId: undefined }),
        };
      }

      // Check router-reported VLAN / secondary subnets (longest prefix match)
      const matchedRouter = routerSubnetsNormalized
        .filter((rs) => ipMatchesCidr(h.ip, rs.cidr))
        .sort((a, b) => {
          const pa = parseIpv4Cidr(a.cidr)?.prefix ?? 0;
          const pb = parseIpv4Cidr(b.cidr)?.prefix ?? 0;
          return pb - pa;
        })[0];

      if (matchedRouter && (matchedRouter.vlanId !== undefined || (primaryCidr && matchedRouter.cidr !== primaryCidr))) {
        const autoName =
          matchedRouter.vlanId !== undefined
            ? `VLAN ${matchedRouter.vlanId}`
            : `Subnet ${matchedRouter.cidr}`;
        return {
          ...h,
          vlanName: autoName,
          vlanCidr: matchedRouter.cidr,
          vlanId: matchedRouter.vlanId,
        };
      }

      const hostSlash24 = getIpv4Slash24(h.ip);
      if (hostSlash24 && primaryCidr && !ipMatchesCidr(h.ip, primaryCidr)) {
        return {
          ...h,
          vlanName: `VLAN ${hostSlash24}`,
          vlanCidr: hostSlash24,
          vlanId: undefined,
        };
      }

      return {
        ...h,
        vlanName: undefined,
        vlanCidr: undefined,
        vlanId: undefined,
      };
    });

    // Build detectedSubnets summary combining routerSubnets, userVlans, and observed /24s
    const subnetMap = new Map<string, DetectedSubnet>();
    const ensureSubnet = (cidr: string, patch: Partial<DetectedSubnet>) => {
      const parsed = parseIpv4Cidr(cidr);
      if (!parsed) return;
      const key = parsed.normalized;
      const cur = subnetMap.get(key) || {
        cidr: key,
        isPrimary: key === primaryCidr,
        hostCount: 0,
        source: 'hosts' as const,
      };
      subnetMap.set(key, {
        ...cur,
        ...patch,
        cidr: key,
        isPrimary: cur.isPrimary || key === primaryCidr,
      });
    };

    for (const rs of routerSubnetsNormalized) {
      ensureSubnet(rs.cidr, {
        iface: rs.iface,
        vlanId: rs.vlanId,
        source: 'router',
      });
    }
    for (const uv of userVlans) {
      ensureSubnet(uv.cidr, {
        name: uv.name,
        vlanId: uv.vlanId,
        source: 'configured',
      });
    }
    for (const s24 of slash24Counts.keys()) {
      // Only add observed /24 if not already covered by an existing router/configured subnet
      const alreadyCovered = Array.from(subnetMap.keys()).some((existing) =>
        ipMatchesCidr(s24.split('/')[0], existing)
      );
      if (!alreadyCovered) {
        ensureSubnet(s24, { source: 'hosts' });
      }
    }

    // Count matching hosts for each detected subnet
    for (const sub of subnetMap.values()) {
      sub.hostCount = taggedHosts.filter((h) => ipMatchesCidr(h.ip, sub.cidr)).length;
      if (!sub.name) {
        if (sub.isPrimary) {
          sub.name = 'Primary LAN';
        } else if (sub.vlanId !== undefined) {
          sub.name = `VLAN ${sub.vlanId}`;
        }
      }
    }

    const detectedSubnets = Array.from(subnetMap.values()).sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (a.source === 'configured' && b.source !== 'configured') return -1;
      if (b.source === 'configured' && a.source !== 'configured') return 1;
      return b.hostCount - a.hostCount || a.cidr.localeCompare(b.cidr);
    });

    return { hosts: taggedHosts, detectedSubnets };
  }

  private reapplyAliasesToLatestSnapshot(): void {
    const allowLanPtr = this.serverConfig.lanDnsEnabled !== false;
    const hostNameByIp = new Map<string, string>();
    const renamedHosts = this.latestSnapshot.hosts.map((h) => {
      const effectivePtr = allowLanPtr ? h.ptrHostname : undefined;
      const known = this.knownHostsCache.get(h.ip);
      const identity = resolveHostIdentity({
        ip: h.ip,
        mac: h.mac,
        dhcpHostname: known?.dhcpHostname ?? (h.nameSource === 'dhcp' ? h.hostname : undefined),
        ptrHostname: effectivePtr,
        serviceName: h.serviceName ?? known?.serviceName,
        serviceProtocol: h.serviceProtocol ?? known?.serviceProtocol,
        serviceModel: known?.serviceModel,
        advertisedServices: h.advertisedServices ?? known?.advertisedServices,
        providedVendor: known?.providedVendor ?? (h.vendor.includes('Private MAC') ? undefined : h.vendor),
        deviceHint: h.deviceHint,
        aliases: this.deviceAliases,
        stripDomain: this.serverConfig.stripLanDomain,
        inferDeviceNames: this.serverConfig.inferDeviceNames,
      });
      hostNameByIp.set(h.ip, identity.hostname);
      return {
        ...h,
        hostname: identity.hostname,
        vendor: identity.vendor,
        nameSource: identity.nameSource,
        isRandomizedMac: identity.isRandomizedMac,
        ptrHostname: identity.ptrHostname,
        serviceName: identity.serviceName,
        serviceProtocol: identity.serviceProtocol,
        advertisedServices: identity.advertisedServices,
        aliasKey: identity.aliasKey,
        aliasMatchBy: identity.aliasMatchBy,
      };
    });

    const { hosts: updatedHosts, detectedSubnets } = this.applyVlanTagsAndBuildSubnets(renamedHosts);

    const updatedFlows = this.latestSnapshot.flows.map((f) => {
      const resolvedSrc = isPrivateIp(f.srcIp) ? hostNameByIp.get(f.srcIp) : undefined;
      const resolvedDst = isPrivateIp(f.dstIp) ? hostNameByIp.get(f.dstIp) : undefined;
      if (!resolvedSrc && !resolvedDst) return f;
      return {
        ...f,
        ...(resolvedSrc ? { srcHost: resolvedSrc } : {}),
        ...(resolvedDst ? { dstHost: resolvedDst } : {}),
      };
    });

    const updatedLinks = this.latestSnapshot.clientLinks.map((l) => {
      const resolved = hostNameByIp.get(l.clientIp);
      return resolved ? { ...l, clientName: resolved } : l;
    });

    this.latestSnapshot = {
      ...this.latestSnapshot,
      hosts: updatedHosts,
      detectedSubnets,
      flows: updatedFlows,
      clientLinks: updatedLinks,
      deviceAliases: { ...this.deviceAliases },
    };
    this.revisions.hosts += 1;
    this.revisions.detectedSubnets += 1;
    this.revisions.flows += 1;
    this.revisions.clientLinks += 1;
    this.revisions.deviceAliases += 1;
  }

  /**
   * Re-applies freshly resolved private reverse-DNS (PTR) and advertised LAN service names
   * (mDNS/Google Cast/ADB/AirPlay/UPnP/NetBIOS) immediately when asynchronous discovery completes.
   */
  public refreshLanHostnames(
    lanRdnsLookup: RdnsLookupFn,
    serviceLookup?: ServiceLookupFn
  ): boolean {
    const allowLanPtr = this.serverConfig.lanDnsEnabled !== false;
    let changed = false;
    const hostNameByIp = new Map<string, string>();

    const nextHosts = this.latestSnapshot.hosts.map((h) => {
      const known = this.knownHostsCache.get(h.ip);
      const freshPtr = allowLanPtr ? lanRdnsLookup(h.ip) : null;
      const effectivePtr = allowLanPtr ? (freshPtr || h.ptrHostname) : undefined;
      const freshSvc = serviceLookup ? serviceLookup(h.ip) : null;
      const mergedServices = Array.from(
        new Set([
          ...(known?.advertisedServices || []),
          ...(h.advertisedServices || []),
          ...(freshSvc?.services || []),
        ])
      );
      const effectiveServiceName = freshSvc?.name || known?.serviceName || h.serviceName;
      const effectiveServiceProtocol =
        (freshSvc?.name ? freshSvc.protocol : undefined) ||
        known?.serviceProtocol ||
        h.serviceProtocol ||
        freshSvc?.protocol;
      const effectiveServiceModel = freshSvc?.model || known?.serviceModel;

      const identity = resolveHostIdentity({
        ip: h.ip,
        mac: h.mac,
        dhcpHostname: known?.dhcpHostname ?? (h.nameSource === 'dhcp' ? h.hostname : undefined),
        ptrHostname: effectivePtr,
        serviceName: effectiveServiceName,
        serviceProtocol: effectiveServiceProtocol,
        serviceModel: effectiveServiceModel,
        advertisedServices: mergedServices.length > 0 ? mergedServices : undefined,
        providedVendor: known?.providedVendor ?? (h.vendor.includes('Private MAC') ? undefined : h.vendor),
        deviceHint: h.deviceHint,
        aliases: this.deviceAliases,
        stripDomain: this.serverConfig.stripLanDomain,
        inferDeviceNames: this.serverConfig.inferDeviceNames,
      });
      hostNameByIp.set(h.ip, identity.hostname);

      if (
        identity.hostname !== h.hostname ||
        identity.ptrHostname !== h.ptrHostname ||
        identity.nameSource !== h.nameSource ||
        identity.serviceName !== h.serviceName ||
        identity.vendor !== h.vendor ||
        (identity.advertisedServices?.length || 0) !== (h.advertisedServices?.length || 0)
      ) {
        changed = true;
      }

      return {
        ...h,
        hostname: identity.hostname,
        vendor: identity.vendor,
        nameSource: identity.nameSource,
        isRandomizedMac: identity.isRandomizedMac,
        ptrHostname: identity.ptrHostname,
        serviceName: identity.serviceName,
        serviceProtocol: identity.serviceProtocol,
        advertisedServices: identity.advertisedServices,
        aliasKey: identity.aliasKey,
        aliasMatchBy: identity.aliasMatchBy,
      };
    });

    if (!changed) return false;

    const updatedFlows = this.latestSnapshot.flows.map((f) => {
      const resolvedSrc = isPrivateIp(f.srcIp) ? hostNameByIp.get(f.srcIp) : undefined;
      const resolvedDst = isPrivateIp(f.dstIp) ? hostNameByIp.get(f.dstIp) : undefined;
      if (!resolvedSrc && !resolvedDst) return f;
      return {
        ...f,
        ...(resolvedSrc ? { srcHost: resolvedSrc } : {}),
        ...(resolvedDst ? { dstHost: resolvedDst } : {}),
      };
    });

    const updatedLinks = this.latestSnapshot.clientLinks.map((l) => {
      const resolved = hostNameByIp.get(l.clientIp);
      return resolved ? { ...l, clientName: resolved } : l;
    });

    this.latestSnapshot = {
      ...this.latestSnapshot,
      hosts: nextHosts,
      flows: updatedFlows,
      clientLinks: updatedLinks,
    };
    this.revisions.hosts += 1;
    this.revisions.flows += 1;
    this.revisions.clientLinks += 1;

    return true;
  }

  private recordHistoryPoint(point: TrafficPoint): { historyUpdated: boolean; rollupUpdated: boolean } {
    // Keep high-res history strictly monotonic (ignore out-of-order / duplicate timestamps)
    const lastHist = this.history.length > 0 ? this.history[this.history.length - 1] : null;
    if (lastHist && point.timestamp < lastHist.timestamp) {
      return { historyUpdated: false, rollupUpdated: false };
    }
    if (lastHist && point.timestamp === lastHist.timestamp) {
      this.history[this.history.length - 1] = point;
    } else {
      this.history.push(point);
    }

    // Prune high-res history strictly to 65m / maxHistoryPoints
    const historyCutoff = point.timestamp - this.maxHistoryAgeMs;
    while (
      this.history.length > this.maxHistoryPoints ||
      (this.history.length > 0 && this.history[0].timestamp < historyCutoff)
    ) {
      this.history.shift();
    }

    let rollupUpdated = false;
    const minuteFloor = Math.floor(point.timestamp / 60_000) * 60_000;
    if (this.currentBucketStart === 0) {
      this.currentBucketStart = minuteFloor;
    }

    if (minuteFloor > this.currentBucketStart) {
      if (this.bucketSamples.length > 0) {
        const count = this.bucketSamples.length;
        const avgRx = Math.round(this.bucketSamples.reduce((s, p) => s + p.rxBps, 0) / count);
        const avgTx = Math.round(this.bucketSamples.reduce((s, p) => s + p.txBps, 0) / count);
        const avgFlows = Math.round(this.bucketSamples.reduce((s, p) => s + p.activeFlows, 0) / count);
        const loadValues = this.bucketSamples
          .map((p) => p.routerLoadPct)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        const peakRouterLoadPct = loadValues.length > 0 ? Math.max(...loadValues) : undefined;
        const rollupPoint: TrafficPoint = {
          timestamp: this.currentBucketStart,
          rxBps: avgRx,
          txBps: avgTx,
          activeFlows: avgFlows,
          ...(peakRouterLoadPct !== undefined ? { routerLoadPct: peakRouterLoadPct } : {}),
        };
        const lastRollup =
          this.rollupHistory.length > 0 ? this.rollupHistory[this.rollupHistory.length - 1] : null;
        if (!lastRollup || rollupPoint.timestamp > lastRollup.timestamp) {
          this.rollupHistory.push(rollupPoint);
          rollupUpdated = true;
        } else if (rollupPoint.timestamp === lastRollup.timestamp) {
          this.rollupHistory[this.rollupHistory.length - 1] = rollupPoint;
          rollupUpdated = true;
        }
      }
      this.currentBucketStart = minuteFloor;
      this.bucketSamples = [point];
    } else if (minuteFloor === this.currentBucketStart) {
      this.bucketSamples.push(point);
    }

    // Strictly cap rollup retention at 6 hours (do not retain data any longer)
    const rollupCutoff = point.timestamp - this.maxRollupAgeMs;
    while (
      this.rollupHistory.length > this.maxRollupPoints ||
      (this.rollupHistory.length > 0 && this.rollupHistory[0].timestamp < rollupCutoff)
    ) {
      this.rollupHistory.shift();
      rollupUpdated = true;
    }

    return { historyUpdated: true, rollupUpdated };
  }

  public ingest(
    snapshot: ProbeSnapshot,
    rdnsLookup?: RdnsLookupFn,
    lanRdnsLookup?: RdnsLookupFn,
    serviceLookup?: ServiceLookupFn
  ): {
    dashboard: DashboardSnapshot;
    newAlerts: AlertEvent[];
  } {
    const rawNow =
      typeof snapshot.timestamp === 'number' && Number.isFinite(snapshot.timestamp) && snapshot.timestamp > 0
        ? snapshot.timestamp
        : Date.now();

    // Ignore out-of-order or duplicate snapshots that would corrupt counter deltas and timeline order
    if (this.lastTimestamp > 0 && rawNow <= this.lastTimestamp) {
      return {
        dashboard: this.latestSnapshot,
        newAlerts: [],
      };
    }

    const now = rawNow;
    const rawDtSec = this.lastTimestamp > 0 ? (now - this.lastTimestamp) / 1000 : 1;
    const isMicroBurst = this.lastTimestamp > 0 && rawDtSec < 0.5;
    const dtSec = this.lastTimestamp > 0 ? Math.max(0.5, rawDtSec) : 1;

    // Upper sanity ceiling: max of 10 Gbps or 4× configured ISP speed (rejects impossible glitch spikes)
    const configuredMaxMbps = Math.max(
      this.serverConfig.ispMaxDownMbps || 1000,
      this.serverConfig.ispMaxUpMbps || 200
    );
    const maxPlausibleWanBps = Math.max(DEFAULT_MAX_PLAUSIBLE_BPS, configuredMaxMbps * 125_000 * 4);

    this.probeStatus = {
      ...this.probeStatus,
      connected: true,
      mode: snapshot.source,
      probeId: snapshot.probeId || 'router-wan',
      iface: snapshot.iface?.iface || 'eth0',
      hostname: snapshot.system?.hostname || this.probeStatus.hostname,
      kernel: snapshot.system?.kernel || this.probeStatus.kernel,
      arch: snapshot.system?.arch || this.probeStatus.arch,
      uptimeSec: snapshot.system?.uptimeSec ?? this.probeStatus.uptimeSec,
      load1m: snapshot.system?.load1m ?? this.probeStatus.load1m,
      memUsedPct: snapshot.system?.memUsedPct ?? this.probeStatus.memUsedPct,
      conntrackCount:
        snapshot.system?.conntrackCount ??
        (snapshot.rawConntrackLines?.length || snapshot.flows.length || this.probeStatus.conntrackCount),
      conntrackMax: snapshot.system?.conntrackMax ?? this.probeStatus.conntrackMax,
      lastHeartbeat: now,
    };

    let rxBps = 0;
    let txBps = 0;

    if (isMicroBurst) {
      // Buffered TCP/WS frames arriving <0.5s apart: keep previous rate rather than dividing by tiny dt
      rxBps = this.lastWanRxBps;
      txBps = this.lastWanTxBps;
    } else if (this.lastIface && this.lastIface.iface === snapshot.iface.iface) {
      const rxDeltaBytes = computeCounterDelta(
        snapshot.iface.rxBytes,
        this.lastIface.rxBytes,
        dtSec,
        maxPlausibleWanBps
      );
      const txDeltaBytes = computeCounterDelta(
        snapshot.iface.txBytes,
        this.lastIface.txBytes,
        dtSec,
        maxPlausibleWanBps
      );
      rxBps = rxDeltaBytes / dtSec;
      txBps = txDeltaBytes / dtSec;
    }

    this.lastWanRxBps = rxBps;
    this.lastWanTxBps = txBps;
    this.lastIface = { ...snapshot.iface };
    this.lastTimestamp = now;

    if (rxBps > this.peakRxBps) this.peakRxBps = rxBps;
    if (txBps > this.peakTxBps) this.peakTxBps = txBps;

    // Update main router Ethernet port negotiation speeds & per-port Rx/Tx rates
    // Note: ports refresh every ~30s, so compute delta using each port's own elapsed timestamp (not global 3s dtSec!)
    if (Array.isArray(snapshot.ports) && snapshot.ports.length > 0) {
      this.routerPorts = snapshot.ports.map((port) => {
        const prevPort = this.prevRouterPortBytes.get(port.id);
        const portDtSec = prevPort && now > prevPort.ts ? Math.max(1, (now - prevPort.ts) / 1000) : dtSec;
        const computedRx =
          port.rxBps > 0
            ? port.rxBps
            : prevPort
              ? Math.round(computeCounterDelta(port.rxBytes, prevPort.rx, portDtSec) / portDtSec)
              : 0;
        const computedTx =
          port.txBps > 0
            ? port.txBps
            : prevPort
              ? Math.round(computeCounterDelta(port.txBytes, prevPort.tx, portDtSec) / portDtSec)
              : 0;
        this.prevRouterPortBytes.set(port.id, { rx: port.rxBytes, tx: port.txBytes, ts: now });
        return {
          ...port,
          rxBps: computedRx,
          txBps: computedTx,
        };
      });
    } else if (this.routerPorts.length === 0) {
      // Synthesize baseline WAN port entry from active interface counters if agent doesn't emit ports yet
      this.routerPorts = [
        {
          id: snapshot.iface.iface || 'eth0',
          label: `WAN (${snapshot.iface.iface || 'eth0'})`,
          role: 'wan',
          linkUp: true,
          speedMbps: 1000,
          duplex: 'full',
          rxBytes: snapshot.iface.rxBytes,
          txBytes: snapshot.iface.txBytes,
          rxBps: Math.round(rxBps),
          txBps: Math.round(txBps),
        },
      ];
    } else {
      // Keep WAN port counters fresh between slower port refreshes
      const wanIdx = this.routerPorts.findIndex(
        (p) => p.role === 'wan' || p.id === snapshot.iface.iface
      );
      if (wanIdx >= 0) {
        this.routerPorts[wanIdx] = {
          ...this.routerPorts[wanIdx],
          rxBytes: snapshot.iface.rxBytes,
          txBytes: snapshot.iface.txBytes,
          rxBps: Math.round(rxBps),
          txBps: Math.round(txBps),
        };
      }
    }

    if (Array.isArray(snapshot.subnets)) {
      this.routerSubnets = snapshot.subnets
        .filter((s) => s && typeof s.cidr === 'string' && parseIpv4Cidr(s.cidr))
        .map((s) => ({ ...s }));
    }
    if (snapshot.wan && typeof snapshot.wan === 'object') {
      this.wanDetails = {
        ...snapshot.wan,
        iface: snapshot.wan.iface || snapshot.iface?.iface || this.probeStatus.iface,
        dns: Array.isArray(snapshot.wan.dns) ? snapshot.wan.dns.filter(Boolean) : [],
      };
    }
    if (Array.isArray(snapshot.satelliteInfo)) {
      this.routerSatelliteInfo = snapshot.satelliteInfo.map((s) => ({ ...s }));
    }
    if (Array.isArray(snapshot.routerClients)) {
      this.routerClients = snapshot.routerClients.map((c) => ({ ...c }));
    }
    if (Array.isArray(snapshot.satellites)) {
      this.probeSatellites = snapshot.satellites.map((s) => ({
        ...s,
        ports: s.ports.map((p) => ({ ...p })),
        clients: s.clients.map((c) => ({ ...c })),
      }));
    } else if (snapshot.source === 'live') {
      // Clear simulator satellites once a real router probe takes over
      this.probeSatellites = this.probeSatellites.filter((s) => s.source !== 'simulator');
    }

    const arpByIp = new Map<string, ArpEntry>();
    for (const entry of snapshot.arp || []) {
      if (!this.isLanClientIp(entry.ip, entry.device)) continue;
      arpByIp.set(entry.ip, entry);
    }

    const rawFlows: RawConntrackFlow[] =
      snapshot.flows && snapshot.flows.length > 0
        ? snapshot.flows
        : snapshot.rawConntrackLines
          ? parseProcConntrackLines(snapshot.rawConntrackLines)
          : [];

    const seenActiveIds = new Set<string>();
    const activeEnrichedFlows: EnrichedFlow[] = [];

    for (const raw of rawFlows) {
      const proto = normalizeProtocol(raw.proto);
      const state = normalizeState(raw.state, proto);
      const assured = raw.assured ?? true;
      const id = raw.id || `${proto}:${raw.src}:${raw.sport}->${raw.dst}:${raw.dport}`;

      const prev = this.flowRecords.get(id);
      // If a previously ended 5-tuple is reused, treat it as a fresh baseline instead of computing a bogus delta
      const usablePrev = prev && !prev.endedAt ? prev : undefined;
      const flowDtSec =
        usablePrev && now > usablePrev.lastSeen
          ? Math.max(0.5, (now - usablePrev.lastSeen) / 1000)
          : dtSec;

      const flowTxBps = isMicroBurst
        ? (usablePrev?.txBps ?? 0)
        : usablePrev
          ? Math.round(computeCounterDelta(raw.txBytes, usablePrev.prevTxBytes, flowDtSec) / flowDtSec)
          : 0;
      const flowRxBps = isMicroBurst
        ? (usablePrev?.rxBps ?? 0)
        : usablePrev
          ? Math.round(computeCounterDelta(raw.rxBytes, usablePrev.prevRxBytes, flowDtSec) / flowDtSec)
          : 0;

      // Drop brand-new closing/unestablished sessions, and only retain previously active flows
      // that actually carried tangible traffic so idle background sockets never pop in on close
      if (!isActiveConnectionState(state, proto, assured)) {
        if (prev && !prev.endedAt) {
          if (!prev.hadTangibleTraffic) {
            this.flowRecords.delete(id);
            continue;
          }
          const finalTx = Math.max(prev.flow.txBytes, raw.txBytes);
          const finalRx = Math.max(prev.flow.rxBytes, raw.rxBytes);
          prev.endedAt = now;
          prev.txBps = 0;
          prev.rxBps = 0;
          prev.flow = {
            ...prev.flow,
            txBytes: finalTx,
            rxBytes: finalRx,
            totalBytes: finalTx + finalRx,
            txBps: 0,
            rxBps: 0,
            totalBps: 0,
            ended: true,
            endedAt: now,
          };
        }
        continue;
      }

      seenActiveIds.add(id);

      const isTangible = hasTangibleTraffic(flowRxBps, flowTxBps);
      // Only spend external rDNS lookups on tangible active flows or newly observed flows
      const shouldResolveExternal = isTangible || !prev;

      const arp = arpByIp.get(raw.src) || arpByIp.get(raw.dst);
      const srcIsPrivate = isPrivateIp(raw.src);
      const dstIsPrivate = isPrivateIp(raw.dst);

      const srcPtr = srcIsPrivate
        ? (lanRdnsLookup ? lanRdnsLookup(raw.src) : null)
        : (shouldResolveExternal && rdnsLookup ? rdnsLookup(raw.src) : null);
      const dstCachedRdns = dstIsPrivate
        ? (lanRdnsLookup ? lanRdnsLookup(raw.dst) : null)
        : (shouldResolveExternal && rdnsLookup ? rdnsLookup(raw.dst) : null);

      const meaningfulArpHost =
        arp && isMeaningfulHostname(arp.hostname, raw.src) ? arp.hostname : undefined;

      const srcHost = srcIsPrivate
        ? resolveHostIdentity({
            ip: raw.src,
            mac: arp?.mac,
            dhcpHostname: meaningfulArpHost,
            ptrHostname: srcPtr,
            providedVendor: arp?.vendor,
            aliases: this.deviceAliases,
            stripDomain: this.serverConfig.stripLanDomain,
            inferDeviceNames: this.serverConfig.inferDeviceNames,
          }).hostname
        : describeRemoteIp(raw.src, srcPtr, proto, raw.sport).label;

      const dstArp = arpByIp.get(raw.dst);
      const meaningfulDstArp =
        dstArp && isMeaningfulHostname(dstArp.hostname, raw.dst) ? dstArp.hostname : undefined;
      const remoteInfo = dstIsPrivate
        ? {
            label: resolveHostIdentity({
              ip: raw.dst,
              mac: dstArp?.mac,
              dhcpHostname: meaningfulDstArp,
              ptrHostname: dstCachedRdns,
              providedVendor: dstArp?.vendor,
              aliases: this.deviceAliases,
              stripDomain: this.serverConfig.stripLanDomain,
              inferDeviceNames: this.serverConfig.inferDeviceNames,
            }).hostname,
            service: 'Local Network',
            category: 'Local Network' as const,
          }
        : describeRemoteIp(raw.dst, dstCachedRdns, proto, raw.dport);

      const hadTangibleTraffic = isTangible || Boolean(usablePrev?.hadTangibleTraffic);
      const lastActiveAt = isTangible ? now : (usablePrev?.lastActiveAt ?? 0);

      const flow: EnrichedFlow = {
        id,
        proto,
        app: classifyApplication(proto, raw.sport, raw.dport),
        state,
        ttl: raw.ttl ?? 120,
        srcIp: raw.src,
        srcHost,
        srcMac: arp?.mac ? normalizeMac(arp.mac) : undefined,
        sport: raw.sport,
        dstIp: raw.dst,
        dstHost: remoteInfo.label,
        dstService: remoteInfo.service,
        dstCategory: remoteInfo.category,
        dport: raw.dport,
        txBytes: raw.txBytes,
        rxBytes: raw.rxBytes,
        totalBytes: raw.txBytes + raw.rxBytes,
        txBps: flowTxBps,
        rxBps: flowRxBps,
        totalBps: flowTxBps + flowRxBps,
        assured,
        firstSeen: prev ? prev.firstSeen : now,
        lastSeen: now,
        ...(lastActiveAt > 0 ? { lastActiveAt } : {}),
        ended: false,
      };

      this.flowRecords.set(id, {
        firstSeen: flow.firstSeen,
        lastSeen: now,
        lastActiveAt,
        hadTangibleTraffic,
        endedAt: undefined,
        prevTxBytes: raw.txBytes,
        prevRxBytes: raw.rxBytes,
        txBps: flowTxBps,
        rxBps: flowRxBps,
        flow,
      });

      activeEnrichedFlows.push(flow);
    }

    // Mark previously active tangible flows that disappeared as ended; drop idle sockets cleanly
    const retainedEndedFlows: EnrichedFlow[] = [];
    for (const [key, rec] of this.flowRecords.entries()) {
      if (seenActiveIds.has(key)) continue;

      if (!rec.hadTangibleTraffic) {
        this.flowRecords.delete(key);
        continue;
      }

      if (!rec.endedAt) {
        rec.endedAt = now;
        rec.txBps = 0;
        rec.rxBps = 0;
        rec.flow = {
          ...rec.flow,
          txBps: 0,
          rxBps: 0,
          totalBps: 0,
          ended: true,
          endedAt: now,
        };
      }

      if (now - rec.endedAt > this.endedFlowRetentionMs) {
        this.flowRecords.delete(key);
        continue;
      }

      retainedEndedFlows.push(rec.flow);
    }

    // Cap retained ended flows by keeping the most recently ended ones
    if (retainedEndedFlows.length > this.maxRetainedEndedFlows) {
      retainedEndedFlows.sort((a, b) => (b.endedAt || b.lastSeen) - (a.endedAt || a.lastSeen));
      const dropped = retainedEndedFlows.splice(this.maxRetainedEndedFlows);
      for (const d of dropped) {
        this.flowRecords.delete(d.id);
      }
    }

    // Hard-cap internal flowRecords so long-running containers never accumulate unbounded map entries
    if (this.flowRecords.size > this.maxTrackedFlowRecords) {
      const overflow = this.flowRecords.size - this.maxTrackedFlowRecords;
      let removed = 0;
      for (const [k, rec] of this.flowRecords.entries()) {
        if (rec.endedAt) {
          this.flowRecords.delete(k);
          removed += 1;
          if (removed >= overflow) break;
        }
      }
      if (removed < overflow) {
        for (const k of this.flowRecords.keys()) {
          if (!seenActiveIds.has(k)) {
            this.flowRecords.delete(k);
            removed += 1;
            if (removed >= overflow) break;
          }
        }
      }
    }

    activeEnrichedFlows.sort((a, b) => {
      if (b.totalBps !== a.totalBps) return b.totalBps - a.totalBps;
      return b.totalBytes - a.totalBytes;
    });
    retainedEndedFlows.sort((a, b) => (b.endedAt || b.lastSeen) - (a.endedAt || a.lastSeen));

    // Expose top active flows + bounded ended flows to keep WS & browser rendering lean
    const snapshotActiveFlows =
      activeEnrichedFlows.length > this.maxActiveSnapshotFlows
        ? activeEnrichedFlows.slice(0, this.maxActiveSnapshotFlows)
        : activeEnrichedFlows;
    const enrichedFlows: EnrichedFlow[] = [...snapshotActiveFlows, ...retainedEndedFlows];
    const tangibleFlows = activeEnrichedFlows.filter((f) => hasTangibleTraffic(f.rxBps, f.txBps));

    const routerLoadPct = computePerceivedRouterLoadPct({
      load1m: this.probeStatus.load1m,
      memUsedPct: this.probeStatus.memUsedPct,
      conntrackCount: this.probeStatus.conntrackCount,
      conntrackMax: this.probeStatus.conntrackMax,
    });

    const point: TrafficPoint = {
      timestamp: now,
      rxBps: Math.round(rxBps),
      txBps: Math.round(txBps),
      activeFlows: tangibleFlows.length,
      routerLoadPct,
    };
    const { historyUpdated, rollupUpdated } = this.recordHistoryPoint(point);

    // Aggregate LAN hosts with LAN DNS PTR, randomized MAC detection, behavioral hints, and aliases
    const hostMap = new Map<
      string,
      HostSummary & {
        appCounts: Map<string, number>;
        serviceCounts: Map<string, number>;
        dhcpHostname?: string;
        providedVendor?: string;
        probeServiceName?: string;
        probeServiceProtocol?: string;
        probeServiceModel?: string;
        probeAdvertisedServices?: string[];
        observedFlows: Array<{ dstService: string; dstHost?: string; app: string; dport: number }>;
      }
    >();

    // Refresh connected host presence cache from ARP + router/satellite client tables
    const attachedMacs = new Set<string>();
    type AttachedClientMeta = { link: SatelliteClientLink; apName: string; fromSatellite: boolean };
    const clientLinkByMac = new Map<string, AttachedClientMeta>();
    const clientLinkByIp = new Map<string, AttachedClientMeta>();
    const isActiveWifiLink = (link: SatelliteClientLink) =>
      link.connectionType === 'wifi' &&
      ((link.wifiRxMbps ?? 0) > 0 || (link.wifiTxMbps ?? 0) > 0 || (link.linkSpeedMbps ?? 0) > 0);
    const isConfirmedPhysicalPort = (link: SatelliteClientLink) =>
      link.connectionType === 'ethernet' && /^LAN\s*\d+/i.test(link.portOrRadio || '');

    const shouldReplaceLink = (existing: AttachedClientMeta | undefined, incoming: AttachedClientMeta): boolean => {
      if (!existing) return true;
      // Satellite attachment is more specific than generic router bridge entry
      if (incoming.fromSatellite && !existing.fromSatellite) {
        if (!isConfirmedPhysicalPort(existing.link) && !isActiveWifiLink(existing.link)) return true;
        if (isActiveWifiLink(incoming.link) || isConfirmedPhysicalPort(incoming.link)) return true;
      }
      // Confirmed physical switch port beats ghost/0-rate Wi-Fi or generic bridge entry
      if (isConfirmedPhysicalPort(incoming.link) && !isActiveWifiLink(existing.link)) return true;
      // Active Wi-Fi beats generic bridge Ethernet (e.g. br0/Ethernet without physical port)
      if (isActiveWifiLink(incoming.link) && !isConfirmedPhysicalPort(existing.link) && !isActiveWifiLink(existing.link)) {
        return true;
      }
      return false;
    };

    const registerClientLink = (link: SatelliteClientLink, apName: string, fromSatellite: boolean) => {
      const candidate: AttachedClientMeta = { link, apName, fromSatellite };
      const m = normalizeMac(link.mac);
      if (m && m !== '00:00:00:00:00:00') {
        attachedMacs.add(m);
        if (shouldReplaceLink(clientLinkByMac.get(m), candidate)) {
          clientLinkByMac.set(m, candidate);
        }
      }
      if (link.ip) {
        if (shouldReplaceLink(clientLinkByIp.get(link.ip), candidate)) {
          clientLinkByIp.set(link.ip, candidate);
        }
      }
    };

    const allSatellites = this.buildTopologyTelemetry().satellites;
    for (const rc of this.routerClients) {
      registerClientLink(rc, 'Main AP', false);
    }
    for (const sat of allSatellites) {
      if (!sat.connected) continue;
      for (const sc of sat.clients || []) {
        registerClientLink(sc, sat.name, true);
      }
    }

    for (const entry of snapshot.arp || []) {
      // Exclude WAN-side ARP neighbors (ISP gateway, public IPs, WAN interface entries)
      if (!this.isLanClientIp(entry.ip, entry.device)) continue;
      const normMac = normalizeMac(entry.mac);
      const prevKnown = this.knownHostsCache.get(entry.ip);
      const dhcpHost = isMeaningfulHostname(entry.hostname, entry.ip)
        ? entry.hostname
        : prevKnown?.dhcpHostname;
      const providedVendor = entry.vendor || prevKnown?.providedVendor;
      const mergedServices = Array.from(
        new Set([
          ...(prevKnown?.advertisedServices || []),
          ...(Array.isArray(entry.advertisedServices) ? entry.advertisedServices : []),
        ])
      ).slice(0, 8);
      this.knownHostsCache.set(entry.ip, {
        ip: entry.ip,
        mac: normMac && normMac !== '00:00:00:00:00:00' ? normMac : prevKnown?.mac || normMac,
        dhcpHostname: dhcpHost,
        providedVendor,
        serviceName: entry.serviceName || prevKnown?.serviceName,
        serviceProtocol: entry.serviceProtocol || prevKnown?.serviceProtocol,
        serviceModel: entry.model || prevKnown?.serviceModel,
        advertisedServices: mergedServices.length > 0 ? mergedServices : undefined,
        lastSeen: now,
      });
    }

    // Refresh lastSeen for any cached host currently associated on router or satellite Wi-Fi/LAN
    // and ensure satellite/router clients with known IPs are also seeded
    for (const known of this.knownHostsCache.values()) {
      if (known.mac && attachedMacs.has(known.mac)) {
        known.lastSeen = now;
      }
    }
    for (const sc of [
      ...this.routerClients,
      ...allSatellites.filter((s) => s.connected).flatMap((s) => s.clients || []),
    ]) {
      if (sc.ip && this.isLanClientIp(sc.ip) && !this.knownHostsCache.has(sc.ip)) {
        const normMac = normalizeMac(sc.mac);
        this.knownHostsCache.set(sc.ip, {
          ip: sc.ip,
          mac: normMac,
          lastSeen: now,
        });
      }
    }

    // Seed hostMap from all currently connected / recently seen LAN devices (not only active traffic)
    for (const [ip, known] of this.knownHostsCache.entries()) {
      if (!this.isLanClientIp(ip) || now - known.lastSeen > this.hostPresenceTtlMs) {
        this.knownHostsCache.delete(ip);
        continue;
      }
      hostMap.set(ip, {
        ip,
        mac: known.mac,
        hostname: ip,
        vendor: known.providedVendor || 'LAN Device',
        nameSource: 'ip',
        isRandomizedMac: false,
        dhcpHostname: known.dhcpHostname,
        providedVendor: known.providedVendor,
        probeServiceName: known.serviceName,
        probeServiceProtocol: known.serviceProtocol,
        probeServiceModel: known.serviceModel,
        probeAdvertisedServices: known.advertisedServices,
        activeFlows: 0,
        rxBytes: 0,
        txBytes: 0,
        totalBytes: 0,
        rxBps: 0,
        txBps: 0,
        topApps: [],
        topServices: [],
        lastSeen: known.lastSeen,
        appCounts: new Map(),
        serviceCounts: new Map(),
        observedFlows: [],
      });
    }

    const protoMap = new Map<string, ProtocolSummary>();
    const remoteMap = new Map<string, RemoteEndpointSummary & { portSet: Set<number> }>();
    const clientLinkMap = new Map<string, ClientDestinationLink>();

    let totalFlowBytes = 0;

    // Only aggregate LIVE (non-ended) flows into host stats, protocols, remotes, and clientLinks
    for (const f of activeEnrichedFlows) {
      totalFlowBytes += f.totalBytes;

      const srcIsLan = this.isLanClientIp(f.srcIp);
      const dstIsLan = this.isLanClientIp(f.dstIp);
      const lanIp = srcIsLan ? f.srcIp : dstIsLan ? f.dstIp : null;

      const ensureHostRecord = (ip: string, mac?: string) => {
        const existingKnown = this.knownHostsCache.get(ip);
        if (existingKnown) {
          existingKnown.lastSeen = now;
        } else {
          this.knownHostsCache.set(ip, {
            ip,
            mac: normalizeMac(mac),
            lastSeen: now,
          });
        }
        let host = hostMap.get(ip);
        if (!host) {
          host = {
            ip,
            mac: normalizeMac(mac),
            hostname: ip,
            vendor: 'LAN Device',
            nameSource: 'ip',
            isRandomizedMac: false,
            activeFlows: 0,
            rxBytes: 0,
            txBytes: 0,
            totalBytes: 0,
            rxBps: 0,
            txBps: 0,
            topApps: [],
            topServices: [],
            lastSeen: now,
            appCounts: new Map(),
            serviceCounts: new Map(),
            observedFlows: [],
          };
          hostMap.set(ip, host);
        }
        return host;
      };

      if (lanIp) {
        const host = ensureHostRecord(lanIp, lanIp === f.srcIp ? f.srcMac : undefined);
        host.activeFlows += 1;
        host.rxBytes += f.rxBytes;
        host.txBytes += f.txBytes;
        host.totalBytes += f.totalBytes;
        host.rxBps += f.rxBps;
        host.txBps += f.txBps;
        host.appCounts.set(f.app, (host.appCounts.get(f.app) || 0) + f.totalBytes);
        const namedSvc = extractNamedService(f.dstService, f.dstHost);
        if (namedSvc) {
          const weight = hasTangibleTraffic(f.rxBps, f.txBps)
            ? Math.max(f.totalBytes, f.totalBps * 10)
            : Math.max(1, Math.round(f.totalBytes * 0.1));
          host.serviceCounts.set(namedSvc, (host.serviceCounts.get(namedSvc) || 0) + weight);
        }
        host.observedFlows.push({
          dstService: f.dstService,
          dstHost: f.dstHost,
          app: f.app,
          dport: f.dport,
        });
      }

      // For inter-VLAN / LAN-to-LAN flows (e.g. 10.0.0.x -> 10.0.1.x Docker container), also track the destination LAN/VLAN host
      if (srcIsLan && dstIsLan && f.dstIp !== f.srcIp) {
        const dstArpEntry = arpByIp.get(f.dstIp);
        const dstHost = ensureHostRecord(f.dstIp, dstArpEntry?.mac);
        dstHost.activeFlows += 1;
        dstHost.rxBytes += f.txBytes;
        dstHost.txBytes += f.rxBytes;
        dstHost.totalBytes += f.totalBytes;
        dstHost.rxBps += f.txBps;
        dstHost.txBps += f.rxBps;
        dstHost.appCounts.set(f.app, (dstHost.appCounts.get(f.app) || 0) + f.totalBytes);
      }

      if (hasTangibleTraffic(f.rxBps, f.txBps)) {
        const pKey = f.app;
        const existingProto = protoMap.get(pKey) || {
          app: f.app,
          proto: f.proto,
          bytes: 0,
          bps: 0,
          flowCount: 0,
          sharePct: 0,
        };
        existingProto.bytes += f.totalBytes;
        existingProto.bps += f.totalBps;
        existingProto.flowCount += 1;
        protoMap.set(pKey, existingProto);

        const remoteIp = !isPrivateIp(f.dstIp) ? f.dstIp : !isPrivateIp(f.srcIp) ? f.srcIp : null;
        if (remoteIp) {
          const cached = rdnsLookup ? rdnsLookup(remoteIp) : null;
          const desc = describeRemoteIp(remoteIp, cached, f.proto, f.dport);
          let rem = remoteMap.get(remoteIp);
          if (!rem) {
            rem = {
              ip: remoteIp,
              label: desc.label,
              service: desc.service,
              category: desc.category,
              ports: [],
              portSet: new Set<number>(),
              bytes: 0,
              bps: 0,
              flowCount: 0,
            };
            remoteMap.set(remoteIp, rem);
          }
          rem.portSet.add(f.dport);
          rem.bytes += f.totalBytes;
          rem.bps += f.totalBps;
          rem.flowCount += 1;
        }
      }
    }

    // Resolve final identity for every discovered local device (Alias > LAN DNS PTR > DHCP > Fingerprint > IP)
    const resolvedNameByIp = new Map<string, string>();
    let randomizedMacCount = 0;

    const hosts: HostSummary[] = Array.from(hostMap.values())
      .map(
        ({
          appCounts,
          serviceCounts,
          dhcpHostname,
          providedVendor,
          probeServiceName,
          probeServiceProtocol,
          probeServiceModel,
          probeAdvertisedServices,
          observedFlows,
          ...rest
        }) => {
          const ptrHostname = lanRdnsLookup ? lanRdnsLookup(rest.ip) : null;
          const serverSvc = serviceLookup ? serviceLookup(rest.ip) : null;
          const mergedServices = Array.from(
            new Set([
              ...(probeAdvertisedServices || []),
              ...(serverSvc?.services || []),
            ])
          ).slice(0, 8);
          const effectiveServiceName = serverSvc?.name || probeServiceName;
          const effectiveServiceProtocol =
            (serverSvc?.name ? serverSvc.protocol : undefined) ||
            probeServiceProtocol ||
            serverSvc?.protocol;
          const effectiveServiceModel = serverSvc?.model || probeServiceModel;
          const deviceHint = fingerprintDeviceHint(observedFlows);
          const identity = resolveHostIdentity({
            ip: rest.ip,
            mac: rest.mac,
            dhcpHostname,
            ptrHostname,
            serviceName: effectiveServiceName,
            serviceProtocol: effectiveServiceProtocol,
            serviceModel: effectiveServiceModel,
            advertisedServices: mergedServices.length > 0 ? mergedServices : undefined,
            providedVendor,
            deviceHint,
            aliases: this.deviceAliases,
            stripDomain: this.serverConfig.stripLanDomain,
            inferDeviceNames: this.serverConfig.inferDeviceNames,
          });

          if (identity.isRandomizedMac) {
            randomizedMacCount += 1;
          }
          resolvedNameByIp.set(rest.ip, identity.hostname);

          const sortedApps = Array.from(appCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([app]) => app);

          const freshServices = Array.from(serviceCounts.entries())
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 4)
            .map(([svc]) => svc);

          const cachedSvc = this.hostTopServicesCache.get(rest.ip);
          let stableTopServices: string[];
          if (
            !cachedSvc ||
            (cachedSvc.services.length === 0 && freshServices.length > 0) ||
            now - cachedSvc.updatedAt >= this.topServicesRefreshMs
          ) {
            stableTopServices = freshServices;
            this.hostTopServicesCache.set(rest.ip, { services: freshServices, updatedAt: now });
          } else {
            stableTopServices = cachedSvc.services;
          }

          const normMac = normalizeMac(rest.mac);
          const clientLinkMeta =
            (normMac && normMac !== '00:00:00:00:00:00' ? clientLinkByMac.get(normMac) : undefined) ||
            clientLinkByIp.get(rest.ip);
          const clientLink = clientLinkMeta?.link;
          const isWifi = clientLink?.connectionType === 'wifi';
          const fallbackWifiSpeed =
            isWifi && clientLink.linkSpeedMbps > 0 ? clientLink.linkSpeedMbps : undefined;
          const wifiRxMbps = isWifi
            ? (clientLink.wifiRxMbps && clientLink.wifiRxMbps > 0 ? clientLink.wifiRxMbps : fallbackWifiSpeed)
            : undefined;
          const wifiTxMbps = isWifi
            ? (clientLink.wifiTxMbps && clientLink.wifiTxMbps > 0 ? clientLink.wifiTxMbps : fallbackWifiSpeed)
            : undefined;
          const wifiBand = isWifi
            ? clientLink.wifiBand || extractWifiBand(clientLink.portOrRadio)
            : undefined;
          const apName = clientLinkMeta?.apName || 'Main AP';

          return {
            ...rest,
            hostname: identity.hostname,
            vendor: identity.vendor,
            nameSource: identity.nameSource,
            isRandomizedMac: identity.isRandomizedMac,
            ptrHostname: identity.ptrHostname,
            serviceName: identity.serviceName,
            serviceProtocol: identity.serviceProtocol,
            advertisedServices: identity.advertisedServices,
            deviceHint: identity.deviceHint,
            aliasKey: identity.aliasKey,
            aliasMatchBy: identity.aliasMatchBy,
            topApps: sortedApps,
            topServices: stableTopServices,
            connectionType: (isWifi ? 'wifi' : 'ethernet') as 'wifi' | 'ethernet',
            linkRadioOrPort: isWifi ? wifiBand : clientLink?.portOrRadio || 'Ethernet',
            wifiBand,
            apName,
            wifiRxMbps,
            wifiTxMbps,
            wifiSignalDbm: isWifi ? clientLink.signalDbm : undefined,
          };
        }
      )
      .sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps) || b.totalBytes - a.totalBytes);

    const { hosts: vlanTaggedHosts, detectedSubnets } = this.applyVlanTagsAndBuildSubnets(hosts);

    // Back-populate resolved hostnames into all flows (including retained ended flows)
    // and build live tangible client-destination links cleanly separated by Internet vs LAN scope
    for (const f of enrichedFlows) {
      const srcPrivate = isPrivateIp(f.srcIp);
      const dstPrivate = isPrivateIp(f.dstIp);
      if (srcPrivate && resolvedNameByIp.has(f.srcIp)) {
        f.srcHost = resolvedNameByIp.get(f.srcIp)!;
      }
      if (dstPrivate && resolvedNameByIp.has(f.dstIp)) {
        f.dstHost = resolvedNameByIp.get(f.dstIp)!;
      }

      if (f.ended || !hasTangibleTraffic(f.rxBps, f.txBps)) continue;
      if (!srcPrivate && !dstPrivate) continue;

      // Skip loopback / self-traffic
      if (
        f.srcIp === f.dstIp ||
        f.srcIp.startsWith('127.') ||
        f.dstIp.startsWith('127.')
      ) {
        continue;
      }

      let scope: 'internet' | 'lan';
      let clientIp: string;
      let clientName: string;
      let serviceName: string;
      let category = f.dstCategory;
      let dstIp: string;

      if (srcPrivate && dstPrivate) {
        scope = 'lan';
        clientIp = f.srcIp;
        clientName = resolvedNameByIp.get(f.srcIp) || f.srcHost;
        serviceName = resolvedNameByIp.get(f.dstIp) || f.dstHost || f.dstIp;
        category = 'Local Network';
        dstIp = f.dstIp;
      } else if (srcPrivate && !dstPrivate) {
        scope = 'internet';
        clientIp = f.srcIp;
        clientName = resolvedNameByIp.get(f.srcIp) || f.srcHost;
        serviceName =
          f.dstService && f.dstService !== 'Local Network'
            ? f.dstService
            : f.dstHost || f.dstIp;
        category = f.dstCategory === 'Local Network' ? 'Other' : f.dstCategory;
        dstIp = f.dstIp;
      } else {
        // !srcPrivate && dstPrivate (inbound internet flow targeting a LAN host)
        scope = 'internet';
        clientIp = f.dstIp;
        clientName = resolvedNameByIp.get(f.dstIp) || f.dstHost || f.dstIp;
        const remoteDesc = describeRemoteIp(f.srcIp, null, f.proto, f.sport);
        serviceName = remoteDesc.service;
        category = remoteDesc.category;
        dstIp = f.srcIp;
      }

      const linkKey = `${scope}:${clientIp}=>${serviceName}`;
      const existingLink = clientLinkMap.get(linkKey) || {
        clientIp,
        clientName,
        service: serviceName,
        category,
        scope,
        dstIp,
        rxBps: 0,
        txBps: 0,
        totalBps: 0,
        totalBytes: 0,
        flowCount: 0,
      };
      existingLink.rxBps += f.rxBps;
      existingLink.txBps += f.txBps;
      existingLink.totalBps += f.totalBps;
      existingLink.totalBytes += f.totalBytes;
      existingLink.flowCount += 1;
      clientLinkMap.set(linkKey, existingLink);
    }

    // Compute LAN interface summary (e.g., eth1 across all LAN ports, br0, Wi-Fi) strictly excluding WAN traffic
    const measuredLanIfaces: Array<{
      iface: string;
      rxBps: number;
      txBps: number;
      rxBytes: number;
      txBytes: number;
    }> = [];
    if (Array.isArray(snapshot.lanIfaces) && snapshot.lanIfaces.length > 0) {
      for (const lif of snapshot.lanIfaces) {
        const prev = this.prevLanIfaceBytes.get(lif.iface);
        const lifDtSec = prev && now > prev.ts ? Math.max(0.5, (now - prev.ts) / 1000) : dtSec;
        const lifRxBps =
          prev && !isMicroBurst
            ? Math.round(computeCounterDelta(lif.rxBytes, prev.rx, lifDtSec) / lifDtSec)
            : 0;
        const lifTxBps =
          prev && !isMicroBurst
            ? Math.round(computeCounterDelta(lif.txBytes, prev.tx, lifDtSec) / lifDtSec)
            : 0;
        this.prevLanIfaceBytes.set(lif.iface, { rx: lif.rxBytes, tx: lif.txBytes, ts: now });
        measuredLanIfaces.push({
          iface: lif.iface,
          rxBps: lifRxBps,
          txBps: lifTxBps,
          rxBytes: lif.rxBytes,
          txBytes: lif.txBytes,
        });
      }
    }

    // Periodically prune stale hostTopServicesCache entries so long-running sessions stay bounded
    if (this.hostTopServicesCache.size > 120) {
      const staleCutoff = now - this.hostPresenceTtlMs;
      for (const [k, entry] of this.hostTopServicesCache.entries()) {
        if (entry.updatedAt < staleCutoff) {
          this.hostTopServicesCache.delete(k);
        }
      }
    }

    const conntrackLanLinks = Array.from(clientLinkMap.values()).filter((l) => l.scope === 'lan');
    const conntrackLanRxBps = conntrackLanLinks.reduce((sum, l) => sum + l.rxBps, 0);
    const conntrackLanTxBps = conntrackLanLinks.reduce((sum, l) => sum + l.txBps, 0);

    const primaryLanIface =
      measuredLanIfaces.find((i) => i.iface === 'eth1') ||
      measuredLanIfaces.find((i) => i.iface === 'br0' || i.iface === 'br-lan') ||
      measuredLanIfaces.find((i) => i.iface.startsWith('lan')) ||
      measuredLanIfaces[0];

    if (primaryLanIface) {
      // On eth1/br0, routed WAN download goes out tx and WAN upload comes in rx; subtract WAN so WAN never bleeds into LAN
      const lanIntraRx = Math.max(0, Math.round(primaryLanIface.rxBps - txBps));
      const lanIntraTx = Math.max(0, Math.round(primaryLanIface.txBps - rxBps));
      const effectiveLanRx = Math.max(conntrackLanRxBps, lanIntraRx);
      const effectiveLanTx = Math.max(conntrackLanTxBps, lanIntraTx);
      this.latestLanSummary = {
        iface: primaryLanIface.iface,
        rxBps: effectiveLanRx,
        txBps: effectiveLanTx,
        totalBps: effectiveLanRx + effectiveLanTx,
        rxBytes: primaryLanIface.rxBytes,
        txBytes: primaryLanIface.txBytes,
        activeInterfaces: measuredLanIfaces
          .filter((i) => i.rxBps + i.txBps > 512)
          .map((i) => i.iface),
      };

      // When L2 switched/bridged LAN traffic on eth1/br0 bypasses L3 conntrack, surface clean LAN-only flow links
      const unmeasuredLanRx = Math.max(0, lanIntraRx - conntrackLanRxBps);
      const unmeasuredLanTx = Math.max(0, lanIntraTx - conntrackLanTxBps);
      const unmeasuredLanTotal = unmeasuredLanRx + unmeasuredLanTx;
      if (unmeasuredLanTotal >= 10_240 && conntrackLanLinks.length < 3) {
        const activePorts = this.routerPorts
          .filter((p) => p.role !== 'wan' && p.linkUp && p.rxBps + p.txBps >= 8_192)
          .sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps));

        if (activePorts.length >= 2 && conntrackLanLinks.length === 0) {
          const srcPort = activePorts[0];
          const dstPort = activePorts[1];
          clientLinkMap.set(`lan:iface:${srcPort.id}=>${dstPort.id}`, {
            clientIp: srcPort.id,
            clientName: srcPort.label,
            service: dstPort.label,
            category: 'Local Network',
            scope: 'lan',
            rxBps: unmeasuredLanRx,
            txBps: unmeasuredLanTx,
            totalBps: unmeasuredLanTotal,
            totalBytes: primaryLanIface.rxBytes + primaryLanIface.txBytes,
            flowCount: 1,
          });
        } else if (conntrackLanLinks.length === 0) {
          const ifaceLabel = `LAN Switch (${primaryLanIface.iface})`;
          const targetLabel =
            activePorts.length === 1 ? activePorts[0].label : 'Local Network';
          clientLinkMap.set(`lan:iface:${primaryLanIface.iface}=>${targetLabel}`, {
            clientIp: primaryLanIface.iface,
            clientName: ifaceLabel,
            service: targetLabel,
            category: 'Local Network',
            scope: 'lan',
            rxBps: unmeasuredLanRx,
            txBps: unmeasuredLanTx,
            totalBps: unmeasuredLanTotal,
            totalBytes: primaryLanIface.rxBytes + primaryLanIface.txBytes,
            flowCount: 1,
          });
        }
      }
    } else if (conntrackLanLinks.length > 0) {
      this.latestLanSummary = {
        iface: 'LAN',
        rxBps: conntrackLanRxBps,
        txBps: conntrackLanTxBps,
        totalBps: conntrackLanRxBps + conntrackLanTxBps,
        rxBytes: conntrackLanLinks.reduce((s, l) => s + l.totalBytes, 0),
        txBytes: 0,
      };
    }

    this.serverStats.randomizedMacCount = randomizedMacCount;

    const protocols: ProtocolSummary[] = Array.from(protoMap.values())
      .map((p) => ({
        ...p,
        sharePct: totalFlowBytes > 0 ? Math.round((p.bytes / totalFlowBytes) * 100) : 0,
      }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10);

    const remotes: RemoteEndpointSummary[] = Array.from(remoteMap.values())
      .map(({ portSet, ...rest }) => ({
        ...rest,
        ports: Array.from(portSet).slice(0, 4),
      }))
      .sort((a, b) => b.bps - a.bps || b.bytes - a.bytes)
      .slice(0, 12);

    // Keep top Internet links and top LAN links strictly ranked by live throughput (bps)
    const allLinksSorted = Array.from(clientLinkMap.values()).sort(
      (a, b) => b.totalBps - a.totalBps || b.totalBytes - a.totalBytes
    );
    const internetLinks = allLinksSorted.filter((l) => l.scope === 'internet').slice(0, 15);
    const lanLinks = allLinksSorted.filter((l) => l.scope === 'lan').slice(0, 8);
    const clientLinks: ClientDestinationLink[] = [...internetLinks, ...lanLinks];

    // Keep long-lived internal maps bounded across days of container uptime
    if (this.knownDeviceKeys.size > 1000) {
      const keep = new Set(
        vlanTaggedHosts.map((h) => (h.mac && h.mac !== '00:00:00:00:00:00' ? h.mac : h.ip))
      );
      this.knownDeviceKeys = keep;
    }
    if (this.prevRouterPortBytes.size > 64) {
      const stale = now - 10 * 60_000;
      for (const [k, v] of this.prevRouterPortBytes.entries()) {
        if (v.ts < stale) this.prevRouterPortBytes.delete(k);
      }
    }
    if (this.prevLanIfaceBytes.size > 64) {
      const stale = now - 10 * 60_000;
      for (const [k, v] of this.prevLanIfaceBytes.entries()) {
        if (v.ts < stale) this.prevLanIfaceBytes.delete(k);
      }
    }

    const newAlerts = this.evaluateRules(
      now,
      rxBps,
      txBps,
      vlanTaggedHosts,
      tangibleFlows.length,
      snapshot.system?.load1m ?? this.probeStatus.load1m,
      snapshot.system?.memUsedPct ?? this.probeStatus.memUsedPct
    );

    const nextTopology = this.buildTopologyTelemetry();

    this.latestSnapshot = {
      probe: { ...this.probeStatus },
      kpis: {
        rxBps: Math.round(rxBps),
        txBps: Math.round(txBps),
        combinedBps: Math.round(rxBps + txBps),
        totalRxBytes: snapshot.iface.rxBytes,
        totalTxBytes: snapshot.iface.txBytes,
        activeFlows: tangibleFlows.length,
        activeHosts: vlanTaggedHosts.filter((h) => hasTangibleTraffic(h.rxBps, h.txBps)).length,
        peakRxBps: Math.round(this.peakRxBps),
        peakTxBps: Math.round(this.peakTxBps),
      },
      ...(this.latestLanSummary ? { lanSummary: { ...this.latestLanSummary } } : {}),
      history: [...this.history],
      rollupHistory: [...this.rollupHistory],
      flows: enrichedFlows,
      hosts: vlanTaggedHosts,
      protocols,
      remotes,
      clientLinks,
      detectedSubnets,
      topology: nextTopology,
      rules: this.rules.map((r) => ({ ...r })),
      alerts: this.alerts.map((a) => ({ ...a })),
      notifications: {
        ntfy: { ...this.notifications.ntfy },
        telegram: { ...this.notifications.telegram },
      },
      deviceAliases: { ...this.deviceAliases },
      serverConfig: { ...this.serverConfig },
      serverStats: { ...this.serverStats },
    };

    if (historyUpdated) this.revisions.history += 1;
    if (rollupUpdated) this.revisions.rollup += 1;
    this.revisions.hosts += 1;
    this.revisions.flows += 1;
    this.revisions.clientLinks += 1;
    if (newAlerts.length > 0) this.revisions.alerts += 1;

    const subnetsSig = JSON.stringify(detectedSubnets);
    if (subnetsSig !== this.lastDetectedSubnetsSig) {
      this.lastDetectedSubnetsSig = subnetsSig;
      this.revisions.detectedSubnets += 1;
    }

    const topoSig = JSON.stringify(nextTopology);
    if (topoSig !== this.lastTopologySig) {
      this.lastTopologySig = topoSig;
      this.revisions.topology += 1;
    }

    return {
      dashboard: this.latestSnapshot,
      newAlerts,
    };
  }

  private evaluateRules(
    now: number,
    rxBps: number,
    txBps: number,
    hosts: HostSummary[],
    totalFlows: number,
    routerLoad1m: number,
    routerMemPct: number
  ): AlertEvent[] {
    const triggered: AlertEvent[] = [];
    const rxMbps = Math.round((rxBps * 8) / 1_000_000);
    const txMbps = Math.round((txBps * 8) / 1_000_000);
    const combinedMbps = rxMbps + txMbps;

    const maxFlowHost = hosts.reduce<HostSummary | null>(
      (acc, h) => (!acc || h.activeFlows > acc.activeFlows ? h : acc),
      null
    );
    const maxRxHost = hosts.reduce<HostSummary | null>(
      (acc, h) => (!acc || h.rxBps > acc.rxBps ? h : acc),
      null
    );
    const maxTxHost = hosts.reduce<HostSummary | null>(
      (acc, h) => (!acc || h.txBps > acc.txBps ? h : acc),
      null
    );

    // Track newly discovered local devices (after baseline snapshot)
    const newlyJoined: HostSummary[] = [];
    for (const host of hosts) {
      const deviceKey = host.mac && host.mac !== '00:00:00:00:00:00' ? host.mac : host.ip;
      if (!this.knownDeviceKeys.has(deviceKey)) {
        this.knownDeviceKeys.add(deviceKey);
        if (this.hasDeviceBaseline) {
          newlyJoined.push(host);
        }
      }
    }
    if (!this.hasDeviceBaseline && hosts.length > 0) {
      this.hasDeviceBaseline = true;
    }

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.metric === 'agent_offline') continue;

      const lastFired = this.lastAlertFiredAt.get(rule.id) || 0;
      if (rule.metric !== 'new_device' && now - lastFired < 20_000) continue;

      let value = 0;
      let shouldFire = false;
      let severity: 'warning' | 'critical' = 'warning';
      let message = '';

      if (rule.metric === 'wan_rx_mbps') {
        value = rxMbps;
        shouldFire = value > rule.threshold;
        severity = value > rule.threshold * 1.4 ? 'critical' : 'warning';
        message = `Internet download reached ${value} Mbps (threshold ${rule.threshold} Mbps)`;
      } else if (rule.metric === 'wan_tx_mbps') {
        value = txMbps;
        shouldFire = value > rule.threshold;
        severity = value > rule.threshold * 1.4 ? 'critical' : 'warning';
        message = `Internet upload reached ${value} Mbps (threshold ${rule.threshold} Mbps)`;
      } else if (rule.metric === 'wan_combined_mbps') {
        value = combinedMbps;
        shouldFire = value > rule.threshold;
        severity = value > rule.threshold * 1.4 ? 'critical' : 'warning';
        message = `Combined bandwidth reached ${value} Mbps (threshold ${rule.threshold} Mbps)`;
      } else if (rule.metric === 'host_rx_mbps' && maxRxHost) {
        value = Math.round((maxRxHost.rxBps * 8) / 1_000_000);
        shouldFire = value > rule.threshold;
        severity = value > rule.threshold * 1.4 ? 'critical' : 'warning';
        message = `${maxRxHost.hostname} (${maxRxHost.ip}) download reached ${value} Mbps (threshold ${rule.threshold} Mbps)`;
      } else if (rule.metric === 'host_tx_mbps' && maxTxHost) {
        value = Math.round((maxTxHost.txBps * 8) / 1_000_000);
        shouldFire = value > rule.threshold;
        severity = value > rule.threshold * 1.4 ? 'critical' : 'warning';
        message = `${maxTxHost.hostname} (${maxTxHost.ip}) upload reached ${value} Mbps (threshold ${rule.threshold} Mbps)`;
      } else if (rule.metric === 'host_flows' && maxFlowHost) {
        value = maxFlowHost.activeFlows;
        shouldFire = value > rule.threshold;
        severity = value > rule.threshold * 1.4 ? 'critical' : 'warning';
        message = `${maxFlowHost.hostname} (${maxFlowHost.ip}) opened ${value} active connections (threshold ${rule.threshold})`;
      } else if (rule.metric === 'total_flows') {
        value = totalFlows;
        shouldFire = value > rule.threshold;
        severity = value > rule.threshold * 1.4 ? 'critical' : 'warning';
        message = `Active router connections reached ${value} (threshold ${rule.threshold})`;
      } else if (rule.metric === 'new_device' && newlyJoined.length > 0) {
        const first = newlyJoined[0];
        value = newlyJoined.length;
        shouldFire = true;
        severity = 'warning';
        message =
          newlyJoined.length === 1
            ? `New device detected: ${first.hostname} (${first.ip}${first.mac ? ` · ${first.mac}` : ''})`
            : `${newlyJoined.length} new devices detected (including ${first.hostname} · ${first.ip})`;
      } else if (rule.metric === 'router_high_load') {
        value = Number(routerLoad1m.toFixed(2));
        shouldFire = value > rule.threshold;
        severity = value > rule.threshold * 1.5 ? 'critical' : 'warning';
        message = `Router 1-min CPU load reached ${value} (threshold ${rule.threshold})`;
      } else if (rule.metric === 'router_high_mem') {
        value = Math.round(routerMemPct);
        shouldFire = value > rule.threshold;
        severity = value >= 95 ? 'critical' : 'warning';
        message = `Router memory usage reached ${value}% (threshold ${rule.threshold}%)`;
      }

      if (shouldFire) {
        const alert: AlertEvent = {
          id: `${rule.id}-${now}-${triggered.length}`,
          ruleId: rule.id,
          ruleName: rule.name,
          severity,
          message,
          value,
          threshold: rule.threshold,
          timestamp: now,
          acknowledged: false,
        };
        this.lastAlertFiredAt.set(rule.id, now);
        this.alerts.unshift(alert);
        if (this.alerts.length > 50) this.alerts.pop();
        triggered.push(alert);
      }
    }

    return triggered;
  }

  public getSnapshot(): DashboardSnapshot {
    return this.latestSnapshot;
  }
}

export { TrafficMonitorEngine as TelemetryEngine };

export function exportFlowsToCsv(flows: EnrichedFlow[]): string {
  const headers = [
    'Protocol',
    'Application',
    'Category',
    'Source IP',
    'Source Host',
    'Source Port',
    'Destination IP',
    'Destination Host',
    'Service',
    'Destination Port',
    'Download Bytes',
    'Upload Bytes',
    'Download Rate (B/s)',
    'Upload Rate (B/s)',
  ];

  const escapeCell = (val: string | number) => {
    const s = String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const rows = flows.map((f) =>
    [
      f.proto,
      f.app,
      f.dstCategory,
      f.srcIp,
      f.srcHost,
      f.sport,
      f.dstIp,
      f.dstHost || f.dstIp,
      f.dstService,
      f.dport,
      f.rxBytes,
      f.txBytes,
      f.rxBps,
      f.txBps,
    ]
      .map(escapeCell)
      .join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}
