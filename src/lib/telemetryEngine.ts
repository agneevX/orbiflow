import type {
  AlertEvent,
  AlertRule,
  ArpEntry,
  ClientDestinationLink,
  DashboardSnapshot,
  DeviceAlias,
  EnrichedFlow,
  EthernetPortMetrics,
  HostSummary,
  InterfaceCounters,
  NotificationConfig,
  ProbeSnapshot,
  ProbeStatus,
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
  condenseServiceLabel,
  describeRemoteIp,
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

interface FlowTrackRecord {
  firstSeen: number;
  lastSeen: number;
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
  lastSeen: number;
}

export type RdnsLookupFn = (ip: string) => string | null;

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

export class TrafficMonitorEngine {
  private history: TrafficPoint[] = []; // High-resolution samples (last 15 minutes)
  private readonly maxHistoryPoints = 900;
  private rollupHistory: TrafficPoint[] = []; // 1-minute buckets (up to 24h = 1440 buckets)
  private readonly maxRollupPoints = 1440;
  private currentBucketStart = 0;
  private bucketSamples: TrafficPoint[] = [];

  private flowRecords = new Map<string, FlowTrackRecord>();
  private readonly endedFlowRetentionMs = 10 * 60_000; // Keep ended flows visible for 10m
  private readonly maxRetainedEndedFlows = 500;
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
    tablePreferences: sanitizeTablePreferences(DEFAULT_TABLE_PREFERENCES),
    featureVisibility: sanitizeFeatureVisibility(DEFAULT_FEATURE_VISIBILITY),
  };

  private hostTopServicesCache = new Map<string, { services: string[]; updatedAt: number }>();
  private readonly topServicesRefreshMs = 15_000;
  private routerPorts: EthernetPortMetrics[] = [];
  private prevRouterPortBytes = new Map<string, { rx: number; tx: number }>();
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

  constructor() {
    this.latestSnapshot = this.buildEmptySnapshot();
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

  private buildTopologyTelemetry(): TopologyTelemetry {
    const wanPort =
      this.routerPorts.find((p) => p.role === 'wan') ||
      this.routerPorts.find((p) => p.id === this.probeStatus.iface) ||
      this.routerPorts.find((p) => p.linkUp && p.speedMbps > 0);
    const routerWanSpeedMbps = this.wanDetails?.linkSpeedMbps || wanPort?.speedMbps || 1000;

    // Combine SSH-polled satellites with any probe-reported/simulated satellites (SSH takes precedence by id)
    const mergedById = new Map<string, SatelliteTelemetry>();
    for (const sat of this.probeSatellites) {
      mergedById.set(sat.id, { ...sat });
    }
    for (const sat of this.sshSatellites) {
      mergedById.set(sat.id, { ...sat });
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
      routerPorts: this.routerPorts.map((p) => ({ ...p })),
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
  }

  public hydrateFromStorage(saved: {
    history?: TrafficPoint[];
    rollupHistory?: TrafficPoint[];
    peakRxBps?: number;
    peakTxBps?: number;
    rules?: AlertRule[];
    alerts?: AlertEvent[];
    serverConfig?: ServerConfig;
  }): void {
    if (Array.isArray(saved.history)) {
      this.history = saved.history.slice(-this.maxHistoryPoints);
    }
    if (Array.isArray(saved.rollupHistory)) {
      this.rollupHistory = saved.rollupHistory.slice(-this.maxRollupPoints);
    }
    if (typeof saved.peakRxBps === 'number') this.peakRxBps = saved.peakRxBps;
    if (typeof saved.peakTxBps === 'number') this.peakTxBps = saved.peakTxBps;
    if (Array.isArray(saved.rules) && saved.rules.length > 0) this.rules = saved.rules;
    if (Array.isArray(saved.alerts)) this.alerts = saved.alerts;
    if (saved.serverConfig) {
      this.serverConfig = {
        ...this.serverConfig,
        ...saved.serverConfig,
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
    const nextTablePrefs = cfg.tablePreferences
      ? sanitizeTablePreferences(cfg.tablePreferences, this.serverConfig.tablePreferences)
      : this.serverConfig.tablePreferences;
    const nextFeatureVis = cfg.featureVisibility
      ? sanitizeFeatureVisibility(cfg.featureVisibility, this.serverConfig.featureVisibility)
      : this.serverConfig.featureVisibility;
    this.serverConfig = {
      ...this.serverConfig,
      ...cfg,
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
        tablePreferences: sanitizeTablePreferences(this.serverConfig.tablePreferences),
        featureVisibility: sanitizeFeatureVisibility(this.serverConfig.featureVisibility),
      },
      serverStats: { ...this.serverStats },
    };
    if (
      prevInfer !== this.serverConfig.inferDeviceNames ||
      prevStrip !== this.serverConfig.stripLanDomain
    ) {
      this.reapplyAliasesToLatestSnapshot();
    }
  }

  public setServerStats(stats: Partial<ServerStats>): void {
    this.serverStats = { ...this.serverStats, ...stats };
    this.latestSnapshot = {
      ...this.latestSnapshot,
      serverStats: { ...this.serverStats },
    };
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
    return this.rules;
  }

  public acknowledgeAlert(id: string): void {
    this.alerts = this.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a));
    this.latestSnapshot = {
      ...this.latestSnapshot,
      alerts: this.alerts.map((a) => ({ ...a })),
    };
  }

  public clearAlerts(): void {
    this.alerts = [];
    this.latestSnapshot = {
      ...this.latestSnapshot,
      alerts: [],
    };
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

  private reapplyAliasesToLatestSnapshot(): void {
    const hostNameByIp = new Map<string, string>();
    const updatedHosts = this.latestSnapshot.hosts.map((h) => {
      const identity = resolveHostIdentity({
        ip: h.ip,
        mac: h.mac,
        dhcpHostname: h.nameSource === 'dhcp' ? h.hostname : undefined,
        ptrHostname: h.ptrHostname,
        providedVendor: h.vendor.includes('Private MAC') ? undefined : h.vendor,
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
        aliasKey: identity.aliasKey,
        aliasMatchBy: identity.aliasMatchBy,
      };
    });

    const updatedFlows = this.latestSnapshot.flows.map((f) => {
      const resolvedSrc = hostNameByIp.get(f.srcIp);
      return resolvedSrc ? { ...f, srcHost: resolvedSrc } : f;
    });

    const updatedLinks = this.latestSnapshot.clientLinks.map((l) => {
      const resolved = hostNameByIp.get(l.clientIp);
      return resolved ? { ...l, clientName: resolved } : l;
    });

    this.latestSnapshot = {
      ...this.latestSnapshot,
      hosts: updatedHosts,
      flows: updatedFlows,
      clientLinks: updatedLinks,
      deviceAliases: { ...this.deviceAliases },
    };
  }

  private recordHistoryPoint(point: TrafficPoint): void {
    this.history.push(point);
    if (this.history.length > this.maxHistoryPoints) {
      this.history.shift();
    }

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
        this.rollupHistory.push({
          timestamp: this.currentBucketStart,
          rxBps: avgRx,
          txBps: avgTx,
          activeFlows: avgFlows,
          ...(peakRouterLoadPct !== undefined ? { routerLoadPct: peakRouterLoadPct } : {}),
        });
        if (this.rollupHistory.length > this.maxRollupPoints) {
          this.rollupHistory.shift();
        }
      }
      this.currentBucketStart = minuteFloor;
      this.bucketSamples = [point];
    } else {
      this.bucketSamples.push(point);
    }
  }

  public ingest(
    snapshot: ProbeSnapshot,
    rdnsLookup?: RdnsLookupFn,
    lanRdnsLookup?: RdnsLookupFn
  ): {
    dashboard: DashboardSnapshot;
    newAlerts: AlertEvent[];
  } {
    const now = snapshot.timestamp || Date.now();
    const dtSec =
      this.lastTimestamp > 0 && now > this.lastTimestamp
        ? Math.max(0.25, (now - this.lastTimestamp) / 1000)
        : 1;

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

    if (
      this.lastIface &&
      this.lastIface.iface === snapshot.iface.iface &&
      snapshot.iface.rxBytes >= this.lastIface.rxBytes &&
      snapshot.iface.txBytes >= this.lastIface.txBytes
    ) {
      rxBps = (snapshot.iface.rxBytes - this.lastIface.rxBytes) / dtSec;
      txBps = (snapshot.iface.txBytes - this.lastIface.txBytes) / dtSec;
    }

    this.lastIface = { ...snapshot.iface };
    this.lastTimestamp = now;

    if (rxBps > this.peakRxBps) this.peakRxBps = rxBps;
    if (txBps > this.peakTxBps) this.peakTxBps = txBps;

    // Update main router Ethernet port negotiation speeds & per-port Rx/Tx rates
    if (Array.isArray(snapshot.ports) && snapshot.ports.length > 0) {
      this.routerPorts = snapshot.ports.map((port) => {
        const prevPort = this.prevRouterPortBytes.get(port.id);
        const computedRx =
          port.rxBps > 0
            ? port.rxBps
            : prevPort && port.rxBytes >= prevPort.rx
              ? Math.round((port.rxBytes - prevPort.rx) / dtSec)
              : 0;
        const computedTx =
          port.txBps > 0
            ? port.txBps
            : prevPort && port.txBytes >= prevPort.tx
              ? Math.round((port.txBytes - prevPort.tx) / dtSec)
              : 0;
        this.prevRouterPortBytes.set(port.id, { rx: port.rxBytes, tx: port.txBytes });
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
      const txDelta =
        prev && raw.txBytes >= prev.prevTxBytes ? (raw.txBytes - prev.prevTxBytes) / dtSec : 0;
      const rxDelta =
        prev && raw.rxBytes >= prev.prevRxBytes ? (raw.rxBytes - prev.prevRxBytes) / dtSec : 0;

      const flowTxBps = prev ? Math.round(txDelta) : 0;
      const flowRxBps = prev ? Math.round(rxDelta) : 0;

      // Drop brand-new closing/unestablished sessions, but if a previously tracked live flow
      // transitions to TIME_WAIT / FIN_WAIT / CLOSE_WAIT / CLOSE, mark it ended so it stays readable
      if (!isActiveConnectionState(state, proto, assured)) {
        if (prev && !prev.endedAt) {
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
        ended: false,
      };

      this.flowRecords.set(id, {
        firstSeen: flow.firstSeen,
        lastSeen: now,
        endedAt: undefined,
        prevTxBytes: raw.txBytes,
        prevRxBytes: raw.rxBytes,
        txBps: flowTxBps,
        rxBps: flowRxBps,
        flow,
      });

      activeEnrichedFlows.push(flow);
    }

    // Mark previously active flows that disappeared as ended and retain them for 10m
    const retainedEndedFlows: EnrichedFlow[] = [];
    for (const [key, rec] of this.flowRecords.entries()) {
      if (seenActiveIds.has(key)) continue;

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

    activeEnrichedFlows.sort((a, b) => {
      if (b.totalBps !== a.totalBps) return b.totalBps - a.totalBps;
      return b.totalBytes - a.totalBytes;
    });
    retainedEndedFlows.sort((a, b) => (b.endedAt || b.lastSeen) - (a.endedAt || a.lastSeen));

    const enrichedFlows: EnrichedFlow[] = [...activeEnrichedFlows, ...retainedEndedFlows];
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
    this.recordHistoryPoint(point);

    // Aggregate LAN hosts with LAN DNS PTR, randomized MAC detection, behavioral hints, and aliases
    const hostMap = new Map<
      string,
      HostSummary & {
        appCounts: Map<string, number>;
        serviceCounts: Map<string, number>;
        dhcpHostname?: string;
        providedVendor?: string;
        observedFlows: Array<{ dstService: string; dstHost?: string; app: string; dport: number }>;
      }
    >();

    // Refresh connected host presence cache from ARP + router/satellite client tables
    const attachedMacs = new Set<string>();
    const clientLinkByMac = new Map<string, SatelliteClientLink>();
    const clientLinkByIp = new Map<string, SatelliteClientLink>();
    const registerClientLink = (link: SatelliteClientLink) => {
      const m = normalizeMac(link.mac);
      if (m && m !== '00:00:00:00:00:00') {
        attachedMacs.add(m);
        const existing = clientLinkByMac.get(m);
        // Prefer direct Wi-Fi station records over L2 Ethernet bridge entries
        if (!existing || (existing.connectionType !== 'wifi' && link.connectionType === 'wifi')) {
          clientLinkByMac.set(m, link);
        }
      }
      if (link.ip) {
        const existingIp = clientLinkByIp.get(link.ip);
        if (!existingIp || (existingIp.connectionType !== 'wifi' && link.connectionType === 'wifi')) {
          clientLinkByIp.set(link.ip, link);
        }
      }
    };

    const allSatellites = this.buildTopologyTelemetry().satellites;
    for (const rc of this.routerClients) {
      registerClientLink(rc);
    }
    for (const sat of allSatellites) {
      if (!sat.connected) continue;
      for (const sc of sat.clients || []) {
        registerClientLink(sc);
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
      this.knownHostsCache.set(entry.ip, {
        ip: entry.ip,
        mac: normMac && normMac !== '00:00:00:00:00:00' ? normMac : prevKnown?.mac || normMac,
        dhcpHostname: dhcpHost,
        providedVendor,
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

      const lanIp = this.isLanClientIp(f.srcIp)
        ? f.srcIp
        : this.isLanClientIp(f.dstIp)
          ? f.dstIp
          : null;

      if (lanIp) {
        const existingKnown = this.knownHostsCache.get(lanIp);
        if (existingKnown) {
          existingKnown.lastSeen = now;
        } else {
          this.knownHostsCache.set(lanIp, {
            ip: lanIp,
            mac: normalizeMac(f.srcMac),
            lastSeen: now,
          });
        }
        let host = hostMap.get(lanIp);
        if (!host) {
          host = {
            ip: lanIp,
            mac: normalizeMac(f.srcMac),
            hostname: lanIp,
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
          hostMap.set(lanIp, host);
        }
        host.activeFlows += 1;
        host.rxBytes += f.rxBytes;
        host.txBytes += f.txBytes;
        host.totalBytes += f.totalBytes;
        host.rxBps += f.rxBps;
        host.txBps += f.txBps;
        host.appCounts.set(f.app, (host.appCounts.get(f.app) || 0) + f.totalBytes);
        const shortSvc = condenseServiceLabel(f.dstService, f.app);
        const weight = hasTangibleTraffic(f.rxBps, f.txBps)
          ? Math.max(f.totalBytes, f.totalBps * 10)
          : Math.max(1, Math.round(f.totalBytes * 0.1));
        host.serviceCounts.set(shortSvc, (host.serviceCounts.get(shortSvc) || 0) + weight);
        host.observedFlows.push({
          dstService: f.dstService,
          dstHost: f.dstHost,
          app: f.app,
          dport: f.dport,
        });
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
      .map(({ appCounts, serviceCounts, dhcpHostname, providedVendor, observedFlows, ...rest }) => {
        const ptrHostname = lanRdnsLookup ? lanRdnsLookup(rest.ip) : null;
        const deviceHint = fingerprintDeviceHint(observedFlows);
        const identity = resolveHostIdentity({
          ip: rest.ip,
          mac: rest.mac,
          dhcpHostname,
          ptrHostname,
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
        const clientLink =
          (normMac && normMac !== '00:00:00:00:00:00' ? clientLinkByMac.get(normMac) : undefined) ||
          clientLinkByIp.get(rest.ip);
        const isWifi = clientLink?.connectionType === 'wifi';
        const fallbackWifiSpeed =
          isWifi && clientLink.linkSpeedMbps > 0 ? clientLink.linkSpeedMbps : undefined;
        const wifiRxMbps = isWifi
          ? (clientLink.wifiRxMbps && clientLink.wifiRxMbps > 0 ? clientLink.wifiRxMbps : fallbackWifiSpeed)
          : undefined;
        const wifiTxMbps = isWifi
          ? (clientLink.wifiTxMbps && clientLink.wifiTxMbps > 0 ? clientLink.wifiTxMbps : fallbackWifiSpeed)
          : undefined;

        return {
          ...rest,
          hostname: identity.hostname,
          vendor: identity.vendor,
          nameSource: identity.nameSource,
          isRandomizedMac: identity.isRandomizedMac,
          ptrHostname: identity.ptrHostname,
          deviceHint: identity.deviceHint,
          aliasKey: identity.aliasKey,
          aliasMatchBy: identity.aliasMatchBy,
          topApps: sortedApps,
          topServices: stableTopServices,
          connectionType: clientLink?.connectionType,
          linkRadioOrPort: clientLink?.portOrRadio,
          wifiRxMbps,
          wifiTxMbps,
          wifiSignalDbm: isWifi ? clientLink.signalDbm : undefined,
        };
      })
      .sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps) || b.totalBytes - a.totalBytes);

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

    const clientLinks: ClientDestinationLink[] = Array.from(clientLinkMap.values())
      .sort((a, b) => b.totalBps - a.totalBps || b.totalBytes - a.totalBytes)
      .slice(0, 24);

    const newAlerts = this.evaluateRules(
      now,
      rxBps,
      txBps,
      hosts,
      tangibleFlows.length,
      snapshot.system?.load1m ?? this.probeStatus.load1m,
      snapshot.system?.memUsedPct ?? this.probeStatus.memUsedPct
    );

    this.latestSnapshot = {
      probe: { ...this.probeStatus },
      kpis: {
        rxBps: Math.round(rxBps),
        txBps: Math.round(txBps),
        combinedBps: Math.round(rxBps + txBps),
        totalRxBytes: snapshot.iface.rxBytes,
        totalTxBytes: snapshot.iface.txBytes,
        activeFlows: tangibleFlows.length,
        activeHosts: hosts.filter((h) => hasTangibleTraffic(h.rxBps, h.txBps)).length,
        peakRxBps: Math.round(this.peakRxBps),
        peakTxBps: Math.round(this.peakTxBps),
      },
      history: [...this.history],
      rollupHistory: [...this.rollupHistory],
      flows: enrichedFlows,
      hosts,
      protocols,
      remotes,
      clientLinks,
      topology: this.buildTopologyTelemetry(),
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
