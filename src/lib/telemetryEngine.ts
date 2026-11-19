import type {
  AlertEvent,
  AlertRule,
  ArpEntry,
  ClientDestinationLink,
  DashboardSnapshot,
  DeviceAlias,
  EnrichedFlow,
  GeoIpInfo,
  HostSummary,
  InterfaceCounters,
  ProbeSnapshot,
  ProbeStatus,
  ProtocolSummary,
  RawConntrackFlow,
  RemoteEndpointSummary,
  ServerConfig,
  ServerStats,
  TrafficPoint,
} from '../types/telemetry';
import {
  classifyApplication,
  describeRemoteIp,
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

interface FlowTrackRecord {
  firstSeen: number;
  lastSeen: number;
  prevTxBytes: number;
  prevRxBytes: number;
  txBps: number;
  rxBps: number;
  flow: EnrichedFlow;
}

export type RdnsLookupFn = (ip: string) => string | null;
export type GeoIpLookupFn = (ip: string) => GeoIpInfo | null;

const DEFAULT_RULES: AlertRule[] = [
  {
    id: 'rule-wan-rx',
    name: 'High Download Usage',
    metric: 'wan_rx_mbps',
    threshold: 250,
    enabled: true,
  },
  {
    id: 'rule-wan-tx',
    name: 'High Upload Usage',
    metric: 'wan_tx_mbps',
    threshold: 65,
    enabled: true,
  },
  {
    id: 'rule-host-flows',
    name: 'Device Connection Flood',
    metric: 'host_flows',
    threshold: 60,
    enabled: true,
  },
  {
    id: 'rule-total-flows',
    name: 'High Connection Count',
    metric: 'total_flows',
    threshold: 1000,
    enabled: false,
  },
];

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
  private lastIface: InterfaceCounters | null = null;
  private lastTimestamp = 0;
  private peakRxBps = 0;
  private peakTxBps = 0;
  private rules: AlertRule[] = DEFAULT_RULES.map((r) => ({ ...r }));
  private alerts: AlertEvent[] = [];
  private lastAlertFiredAt = new Map<string, number>();
  private deviceAliases: Record<string, DeviceAlias> = {};

  private serverConfig: ServerConfig = {
    probeToken: 'orbi-rbk50-voxel-secret',
    persistenceMode: 'memory',
    cacheDir: '/config/cache',
    rdnsEnabled: false,
    rdnsTtlSec: 3600,
    rdnsSkipPrivate: true,
    lanDnsEnabled: true,
    lanDnsServer: '',
    lanDnsTtlSec: 300,
    stripLanDomain: true,
    geoipEnabled: true,
    geoipDir: '/config/geoip',
  };

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
    geoipActiveDir: '/config/geoip',
    geoipCityLoaded: false,
    geoipAsnLoaded: false,
    geoipCityFile: null,
    geoipAsnFile: null,
    geoipLookups: 0,
  };

  private probeStatus: ProbeStatus = {
    connected: false,
    mode: 'disconnected',
    probeId: 'orbi-rbk50-eth0',
    hostname: 'orbi-gateway',
    kernel: '3.14.77 #1 SMP PREEMPT armv7l',
    arch: 'armv7l IPQ4019',
    iface: 'eth0',
    uptimeSec: 0,
    load1m: 0,
    memUsedPct: 0,
    conntrackCount: 0,
    conntrackMax: 32768,
    lastHeartbeat: 0,
    simulatorEnabled: true,
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
      rules: this.rules.map((r) => ({ ...r })),
      alerts: [],
      deviceAliases: { ...this.deviceAliases },
      serverConfig: { ...this.serverConfig },
      serverStats: { ...this.serverStats },
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
    if (saved.serverConfig) this.serverConfig = { ...this.serverConfig, ...saved.serverConfig };
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
    this.serverConfig = { ...this.serverConfig, ...cfg };
    if (stats) {
      this.serverStats = { ...this.serverStats, ...stats };
    }
    this.latestSnapshot = {
      ...this.latestSnapshot,
      serverConfig: { ...this.serverConfig },
      serverStats: { ...this.serverStats },
    };
  }

  public setServerStats(stats: Partial<ServerStats>): void {
    this.serverStats = { ...this.serverStats, ...stats };
    this.latestSnapshot = {
      ...this.latestSnapshot,
      serverStats: { ...this.serverStats },
    };
  }

  public setSimulatorEnabled(enabled: boolean): void {
    this.probeStatus.simulatorEnabled = enabled;
    if (!enabled && this.probeStatus.mode === 'simulator') {
      this.probeStatus.connected = false;
      this.probeStatus.mode = 'disconnected';
    }
    this.latestSnapshot = {
      ...this.latestSnapshot,
      probe: { ...this.probeStatus },
    };
  }

  public isSimulatorEnabled(): boolean {
    return this.probeStatus.simulatorEnabled;
  }

  public hasActiveLiveProbe(now = Date.now()): boolean {
    return this.probeStatus.mode === 'live' && now - this.probeStatus.lastHeartbeat < 20_000;
  }

  public markProbeDisconnected(probeId: string): void {
    if (this.probeStatus.mode === 'live' && this.probeStatus.probeId === probeId) {
      this.probeStatus.connected = false;
      this.probeStatus.mode = 'disconnected';
      this.latestSnapshot = {
        ...this.latestSnapshot,
        probe: { ...this.probeStatus },
      };
    }
  }

  public updateRules(nextRules: AlertRule[]): AlertRule[] {
    this.rules = nextRules.map((r) => ({
      ...r,
      threshold: Math.max(1, Number(r.threshold) || 1),
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
        this.rollupHistory.push({
          timestamp: this.currentBucketStart,
          rxBps: avgRx,
          txBps: avgTx,
          activeFlows: avgFlows,
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
    geoipLookup?: GeoIpLookupFn,
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
      probeId: snapshot.probeId || 'orbi-rbk50-eth0',
      iface: snapshot.iface?.iface || 'eth0',
      hostname: snapshot.system?.hostname || this.probeStatus.hostname,
      kernel: snapshot.system?.kernel || this.probeStatus.kernel,
      arch: snapshot.system?.arch || this.probeStatus.arch,
      uptimeSec: snapshot.system?.uptimeSec ?? this.probeStatus.uptimeSec,
      load1m: snapshot.system?.load1m ?? this.probeStatus.load1m,
      memUsedPct: snapshot.system?.memUsedPct ?? this.probeStatus.memUsedPct,
      conntrackCount: snapshot.system?.conntrackCount ?? snapshot.flows.length,
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

    const arpByIp = new Map<string, ArpEntry>();
    for (const entry of snapshot.arp || []) {
      arpByIp.set(entry.ip, entry);
    }

    const rawFlows: RawConntrackFlow[] =
      snapshot.flows && snapshot.flows.length > 0
        ? snapshot.flows
        : snapshot.rawConntrackLines
          ? parseProcConntrackLines(snapshot.rawConntrackLines)
          : [];

    const seenIds = new Set<string>();
    const enrichedFlows: EnrichedFlow[] = [];

    for (const raw of rawFlows) {
      const proto = normalizeProtocol(raw.proto);
      const id = raw.id || `${proto}:${raw.src}:${raw.sport}->${raw.dst}:${raw.dport}`;
      seenIds.add(id);

      const prev = this.flowRecords.get(id);
      const txDelta =
        prev && raw.txBytes >= prev.prevTxBytes ? (raw.txBytes - prev.prevTxBytes) / dtSec : 0;
      const rxDelta =
        prev && raw.rxBytes >= prev.prevRxBytes ? (raw.rxBytes - prev.prevRxBytes) / dtSec : 0;

      const flowTxBps = prev ? Math.round(txDelta) : 0;
      const flowRxBps = prev ? Math.round(rxDelta) : 0;

      const arp = arpByIp.get(raw.src) || arpByIp.get(raw.dst);
      const srcIsPrivate = isPrivateIp(raw.src);
      const dstIsPrivate = isPrivateIp(raw.dst);

      const srcPtr = srcIsPrivate
        ? (lanRdnsLookup ? lanRdnsLookup(raw.src) : null)
        : (rdnsLookup ? rdnsLookup(raw.src) : null);
      const dstCachedRdns = dstIsPrivate
        ? (lanRdnsLookup ? lanRdnsLookup(raw.dst) : null)
        : (rdnsLookup ? rdnsLookup(raw.dst) : null);
      const dstGeo = !dstIsPrivate && geoipLookup ? geoipLookup(raw.dst) || undefined : undefined;

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
          }).hostname
        : describeRemoteIp(raw.src, srcPtr).label;

      const dstArp = arpByIp.get(raw.dst);
      const meaningfulDstArp =
        dstArp && isMeaningfulHostname(dstArp.hostname, raw.dst) ? dstArp.hostname : undefined;
      const baseRemoteInfo = dstIsPrivate
        ? {
            label: resolveHostIdentity({
              ip: raw.dst,
              mac: dstArp?.mac,
              dhcpHostname: meaningfulDstArp,
              ptrHostname: dstCachedRdns,
              providedVendor: dstArp?.vendor,
              aliases: this.deviceAliases,
              stripDomain: this.serverConfig.stripLanDomain,
            }).hostname,
            service: 'Local Network',
          }
        : describeRemoteIp(raw.dst, dstCachedRdns);

      const remoteInfo = {
        label: baseRemoteInfo.label,
        service:
          baseRemoteInfo.service === 'External IP' && dstGeo?.org
            ? dstGeo.org
            : baseRemoteInfo.service,
      };

      const flow: EnrichedFlow = {
        id,
        proto,
        app: classifyApplication(proto, raw.sport, raw.dport),
        state: normalizeState(raw.state, proto),
        ttl: raw.ttl ?? 120,
        srcIp: raw.src,
        srcHost,
        srcMac: arp?.mac ? normalizeMac(arp.mac) : undefined,
        sport: raw.sport,
        dstIp: raw.dst,
        dstHost: remoteInfo.label,
        dstService: remoteInfo.service,
        dstGeo,
        dport: raw.dport,
        txBytes: raw.txBytes,
        rxBytes: raw.rxBytes,
        totalBytes: raw.txBytes + raw.rxBytes,
        txBps: flowTxBps,
        rxBps: flowRxBps,
        totalBps: flowTxBps + flowRxBps,
        assured: raw.assured ?? true,
        firstSeen: prev ? prev.firstSeen : now,
        lastSeen: now,
      };

      this.flowRecords.set(id, {
        firstSeen: flow.firstSeen,
        lastSeen: now,
        prevTxBytes: raw.txBytes,
        prevRxBytes: raw.rxBytes,
        txBps: flowTxBps,
        rxBps: flowRxBps,
        flow,
      });

      enrichedFlows.push(flow);
    }

    // Expire stale flows after 30s (supports 5s low-CPU polling comfortably)
    for (const [key, rec] of this.flowRecords.entries()) {
      if (!seenIds.has(key) && now - rec.lastSeen > 30_000) {
        this.flowRecords.delete(key);
      }
    }

    enrichedFlows.sort((a, b) => {
      if (b.totalBps !== a.totalBps) return b.totalBps - a.totalBps;
      return b.totalBytes - a.totalBytes;
    });

    const point: TrafficPoint = {
      timestamp: now,
      rxBps: Math.round(rxBps),
      txBps: Math.round(txBps),
      activeFlows: enrichedFlows.length,
    };
    this.recordHistoryPoint(point);

    // Aggregate LAN hosts with LAN DNS PTR, randomized MAC detection, behavioral hints, and aliases
    const hostMap = new Map<
      string,
      HostSummary & {
        appCounts: Map<string, number>;
        dhcpHostname?: string;
        providedVendor?: string;
        observedFlows: Array<{ dstService: string; dstHost?: string; app: string; dport: number }>;
      }
    >();

    for (const entry of snapshot.arp || []) {
      const normMac = normalizeMac(entry.mac);
      hostMap.set(entry.ip, {
        ip: entry.ip,
        mac: normMac,
        hostname: entry.ip,
        vendor: entry.vendor || 'LAN Device',
        nameSource: 'ip',
        isRandomizedMac: false,
        dhcpHostname: isMeaningfulHostname(entry.hostname, entry.ip) ? entry.hostname : undefined,
        providedVendor: entry.vendor,
        activeFlows: 0,
        rxBytes: 0,
        txBytes: 0,
        totalBytes: 0,
        rxBps: 0,
        txBps: 0,
        topApps: [],
        lastSeen: now,
        appCounts: new Map(),
        observedFlows: [],
      });
    }

    const protoMap = new Map<string, ProtocolSummary>();
    const remoteMap = new Map<string, RemoteEndpointSummary & { portSet: Set<number> }>();
    const clientLinkMap = new Map<string, ClientDestinationLink>();

    let totalFlowBytes = 0;

    for (const f of enrichedFlows) {
      totalFlowBytes += f.totalBytes;

      const lanIp = isPrivateIp(f.srcIp) ? f.srcIp : isPrivateIp(f.dstIp) ? f.dstIp : null;

      if (lanIp) {
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
            lastSeen: now,
            appCounts: new Map(),
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
        host.observedFlows.push({
          dstService: f.dstService,
          dstHost: f.dstHost,
          app: f.app,
          dport: f.dport,
        });
      }

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
        const geo = geoipLookup ? geoipLookup(remoteIp) || undefined : undefined;
        const desc = describeRemoteIp(remoteIp, cached);
        let rem = remoteMap.get(remoteIp);
        if (!rem) {
          rem = {
            ip: remoteIp,
            label: desc.label,
            service: desc.service === 'External IP' && geo?.org ? geo.org : desc.service,
            geo,
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

    // Resolve final identity for every discovered local device (Alias > LAN DNS PTR > DHCP > Fingerprint > IP)
    const resolvedNameByIp = new Map<string, string>();
    let randomizedMacCount = 0;

    const hosts: HostSummary[] = Array.from(hostMap.values())
      .map(({ appCounts, dhcpHostname, providedVendor, observedFlows, ...rest }) => {
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
        });

        if (identity.isRandomizedMac) {
          randomizedMacCount += 1;
        }
        resolvedNameByIp.set(rest.ip, identity.hostname);

        const sortedApps = Array.from(appCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([app]) => app);

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
        };
      })
      .sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps) || b.totalBytes - a.totalBytes);

    // Back-populate resolved hostnames into flows & client-destination links so all views match
    for (const f of enrichedFlows) {
      const lanIp = isPrivateIp(f.srcIp) ? f.srcIp : isPrivateIp(f.dstIp) ? f.dstIp : null;
      if (isPrivateIp(f.srcIp) && resolvedNameByIp.has(f.srcIp)) {
        f.srcHost = resolvedNameByIp.get(f.srcIp)!;
      }
      if (lanIp) {
        const clientName = resolvedNameByIp.get(lanIp) || f.srcHost;
        const serviceName = f.dstService;
        const linkKey = `${lanIp}=>${serviceName}`;
        const existingLink = clientLinkMap.get(linkKey) || {
          clientIp: lanIp,
          clientName,
          service: serviceName,
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

    const newAlerts = this.evaluateRules(now, rxBps, txBps, hosts, enrichedFlows.length);

    this.latestSnapshot = {
      probe: { ...this.probeStatus },
      kpis: {
        rxBps: Math.round(rxBps),
        txBps: Math.round(txBps),
        combinedBps: Math.round(rxBps + txBps),
        totalRxBytes: snapshot.iface.rxBytes,
        totalTxBytes: snapshot.iface.txBytes,
        activeFlows: enrichedFlows.length,
        activeHosts: hosts.filter((h) => h.activeFlows > 0).length,
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
      rules: this.rules.map((r) => ({ ...r })),
      alerts: this.alerts.map((a) => ({ ...a })),
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
    totalFlows: number
  ): AlertEvent[] {
    const triggered: AlertEvent[] = [];
    const rxMbps = Math.round((rxBps * 8) / 1_000_000);
    const txMbps = Math.round((txBps * 8) / 1_000_000);
    const maxHost = hosts.reduce<HostSummary | null>(
      (acc, h) => (!acc || h.activeFlows > acc.activeFlows ? h : acc),
      null
    );

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const lastFired = this.lastAlertFiredAt.get(rule.id) || 0;
      if (now - lastFired < 20_000) continue;

      let value = 0;
      let message = '';

      if (rule.metric === 'wan_rx_mbps') {
        value = rxMbps;
        message = `Internet download reached ${value} Mb/s (threshold ${rule.threshold} Mb/s)`;
      } else if (rule.metric === 'wan_tx_mbps') {
        value = txMbps;
        message = `Internet upload reached ${value} Mb/s (threshold ${rule.threshold} Mb/s)`;
      } else if (rule.metric === 'host_flows' && maxHost) {
        value = maxHost.activeFlows;
        message = `${maxHost.hostname} (${maxHost.ip}) opened ${value} active connections (threshold ${rule.threshold})`;
      } else if (rule.metric === 'total_flows') {
        value = totalFlows;
        message = `Active router connections reached ${value} (threshold ${rule.threshold})`;
      }

      if (value > rule.threshold) {
        const alert: AlertEvent = {
          id: `${rule.id}-${now}`,
          ruleId: rule.id,
          ruleName: rule.name,
          severity: value > rule.threshold * 1.4 ? 'critical' : 'warning',
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
    'State',
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
      f.state,
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
