import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  Gamepad2,
  Globe,
  HardDrive,
  Laptop,
  Monitor,
  Network,
  Radio,
  Router,
  Search,
  Server,
  Smartphone,
  Tv,
  Wifi,
  X,
} from 'lucide-react';
import type {
  BandwidthUnit,
  DashboardSnapshot,
  EthernetPortMetrics,
  HostSummary,
  SatelliteClientLink,
  SatelliteTelemetry,
  WanDetails,
} from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  formatLinkSpeed,
  formatWifiRatesLabel,
  inferTopologyDeviceIcon,
  type TopologyDeviceIcon,
} from '../lib/topology';
import {
  compareIpv4,
  extractWifiBand,
  formatBandwidth,
  formatBytes,
  formatDuration,
  hasTangibleTraffic,
} from '../lib/formatters';
import { normalizeMac } from '../lib/deviceIdentity';
import { SatelliteManager, type SatelliteSavePayload } from './SatelliteManager';

interface TrafficMapViewProps {
  snapshot: DashboardSnapshot;
  unit: BandwidthUnit;
  theme: ThemePalette;
  paused: boolean;
  connectionsEnabled?: boolean;
  onInspectHostFlows: (host: HostSummary) => void;
  onSaveSatellite: (payload: SatelliteSavePayload) => Promise<{ ok: boolean; error?: string }>;
  onDeleteSatellite: (id: string) => Promise<void>;
  onTestSatellite: (
    payload: SatelliteSavePayload
  ) => Promise<{ ok: boolean; error?: string; summary?: string }>;
}

type ConnectionFilter = 'all' | 'active' | 'wifi' | 'ethernet';
type ClientSortMode = 'name' | 'ip' | 'traffic';

type InspectorSelection =
  | { kind: 'internet' }
  | { kind: 'router' }
  | { kind: 'satellite'; satId: string }
  | { kind: 'client'; ip: string };

interface MapClientEntry {
  host: HostSummary;
  apKey: string; // 'router' | `sat:${id}`
  link?: SatelliteClientLink;
  connectionType: 'ethernet' | 'wifi';
  wifiBand?: string;
  wifiRxMbps?: number;
  wifiTxMbps?: number;
  wifiSignalDbm?: number;
  active: boolean;
  stale: boolean;
  lastSeenMs: number;
}

const CLIENT_GRACE_MS = 5 * 60 * 1000;

function ClientDeviceIcon({ icon, className }: { icon: TopologyDeviceIcon; className?: string }) {
  const cls = className || 'h-4 w-4 shrink-0';
  switch (icon) {
    case 'tv':
      return <Tv className={cls} aria-hidden="true" />;
    case 'phone':
      return <Smartphone className={cls} aria-hidden="true" />;
    case 'laptop':
      return <Laptop className={cls} aria-hidden="true" />;
    case 'nas':
      return <HardDrive className={cls} aria-hidden="true" />;
    case 'server':
      return <Server className={cls} aria-hidden="true" />;
    case 'gaming':
      return <Gamepad2 className={cls} aria-hidden="true" />;
    case 'iot':
      return <Cpu className={cls} aria-hidden="true" />;
    default:
      return <Monitor className={cls} aria-hidden="true" />;
  }
}

function PortStrip({
  ports,
  expectedCount = 4,
  isRouter = false,
}: {
  ports: EthernetPortMetrics[];
  expectedCount?: number;
  isRouter?: boolean;
}) {
  const displayPorts: Array<EthernetPortMetrics & { placeholder?: boolean }> = useMemo(() => {
    if (ports.length > 0) return ports.slice(0, expectedCount);
    // Render clean placeholder port bays if probe hasn't reported port telemetry yet
    return Array.from({ length: expectedCount }, (_, idx) => {
      const isWan = isRouter && idx === 0;
      const lanNum = isRouter ? idx : idx + 1;
      return {
        id: `placeholder-${idx}`,
        label: isWan ? 'WAN' : `LAN ${lanNum}`,
        role: isWan ? 'wan' : 'lan',
        linkUp: false,
        speedMbps: 0,
        duplex: 'unknown' as const,
        rxBps: 0,
        txBps: 0,
        rxBytes: 0,
        txBytes: 0,
        placeholder: true,
      };
    });
  }, [ports, expectedCount, isRouter]);

  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${displayPorts.length}, minmax(0, 1fr))` }}
    >
      {displayPorts.map((port) => {
        const isUp = port.linkUp;
        const speedText = port.placeholder
          ? '—'
          : isUp
            ? formatLinkSpeed(port.speedMbps, 'ethernet', true)
            : 'Empty';
        const dotClass = !isUp
          ? 'bg-slate-400/40'
          : port.speedMbps >= 2500
            ? 'bg-violet-500'
            : port.speedMbps >= 1000
              ? 'bg-emerald-500'
              : 'bg-amber-500';
        const roleTag =
          port.role === 'wan'
            ? 'WAN'
            : port.role === 'backhaul'
              ? 'Backhaul'
              : port.label.replace(/\s*\(.+\)$/, '');

        return (
          <div
            key={port.id}
            title={`${port.label} (${port.role.toUpperCase()}) · ${speedText}${
              isUp && port.duplex && port.duplex !== 'unknown'
                ? ` ${port.duplex === 'full' ? 'FDX' : 'HDX'}`
                : ''
            }`}
            className={`px-2 py-1.5 rounded-lg border text-left transition-colors ${
              isUp
                ? 'app-border app-input'
                : 'border-dashed app-border opacity-60'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide truncate">
                {roleTag}
              </span>
              <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} aria-hidden="true" />
            </div>
            <div className="mt-0.5 text-[10px] font-mono tabular-nums app-text-muted truncate">
              {speedText}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PortNegotiationTable({
  ports,
  unit,
  theme,
}: {
  ports: EthernetPortMetrics[];
  unit: BandwidthUnit;
  theme: ThemePalette;
}) {
  if (!ports || ports.length === 0) {
    return (
      <div className="p-3 rounded-xl border app-border app-input text-xs app-text-muted">
        No Ethernet port telemetry reported yet. Update the router agent or configure SSH polling to
        read physical switch negotiation rates.
      </div>
    );
  }

  return (
    <div className="border app-border rounded-xl overflow-hidden">
      <table className="w-full text-[11px]">
        <thead className="app-sidebar border-b app-border text-[10px] app-text-muted">
          <tr>
            <th className="text-left font-medium px-2.5 py-2">Port</th>
            <th className="text-left font-medium px-2 py-2 whitespace-nowrap">Link Rate</th>
            <th className="text-right font-medium px-2.5 py-2 whitespace-nowrap">Rx / Tx</th>
          </tr>
        </thead>
        <tbody className="divide-y app-border font-mono tabular-nums">
          {ports.map((p) => {
            const speedText = formatLinkSpeed(
              p.speedMbps,
              p.role === 'wifi' ? 'wifi' : 'ethernet',
              p.linkUp
            );
            return (
              <tr key={p.id} className="app-input h-[44px]">
                <td className="px-2.5 py-1.5 align-middle font-sans min-w-0">
                  <div className="font-medium leading-4 truncate max-w-[125px]" title={p.label}>
                    {p.label}
                  </div>
                  <div className="text-[10px] leading-3.5 app-text-muted uppercase truncate">
                    {p.role}
                  </div>
                </td>
                <td className="px-2 py-1.5 align-middle whitespace-nowrap">
                  <span
                    className={
                      !p.linkUp
                        ? 'app-text-muted opacity-60'
                        : p.speedMbps >= 2500
                          ? 'text-violet-500 font-semibold'
                          : p.speedMbps >= 1000
                            ? 'text-emerald-500 font-semibold'
                            : 'text-amber-500 font-semibold'
                    }
                  >
                    {speedText}
                  </span>
                  {p.linkUp && p.duplex && p.duplex !== 'unknown' && (
                    <span className="text-[10px] app-text-muted ml-1">
                      {p.duplex === 'full' ? 'FDX' : 'HDX'}
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-1.5 align-middle text-right whitespace-nowrap leading-4">
                  <div style={{ color: theme.rxColor }}>↓ {formatBandwidth(p.rxBps, unit)}</div>
                  <div style={{ color: theme.txColor }}>↑ {formatBandwidth(p.txBps, unit)}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TrafficMapView({
  snapshot,
  unit,
  theme,
  paused,
  connectionsEnabled = true,
  onInspectHostFlows,
  onSaveSatellite,
  onDeleteSatellite,
  onTestSatellite,
}: TrafficMapViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [connFilter, setConnFilter] = useState<ConnectionFilter>('all');
  const [vlanFilter, setVlanFilter] = useState<string>('ALL');
  const [sortMode, setSortMode] = useState<ClientSortMode>('name');
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] = useState<InspectorSelection | null>(null);
  const [satelliteModalOpen, setSatelliteModalOpen] = useState(false);

  // 5-minute grace retention map keyed by IP so devices never flicker/vanish on brief poll gaps
  const retainedClientsRef = useRef<Map<string, MapClientEntry>>(new Map());

  useEffect(() => {
    if (!selection) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selection]);

  const topology = snapshot.topology || {
    routerPorts: [],
    routerWanSpeedMbps: 1000,
    routerClients: [],
    satellites: [],
    satelliteConfigs: [],
  };

  const satellites = useMemo(
    () =>
      [...(topology.satellites || [])].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      ),
    [topology.satellites]
  );

  // Build stabilized client roster with deterministic AP attribution & 5-minute anti-flicker grace
  const stabilizedClients = useMemo<MapClientEntry[]>(() => {
    const now = snapshot.probe.lastHeartbeat || Date.now();
    const satIpSet = new Set(satellites.map((s) => s.host));
    const satByNameLower = new Map<string, SatelliteTelemetry>();
    for (const sat of satellites) {
      satByNameLower.set(sat.name.trim().toLowerCase(), sat);
    }

    const routerClientByMac = new Map<string, SatelliteClientLink>();
    const routerClientByIp = new Map<string, SatelliteClientLink>();
    const routerWifiMacs = new Set<string>();
    const routerWiredMacs = new Set<string>();
    for (const rc of topology.routerClients || []) {
      const m = normalizeMac(rc.mac);
      if (m) {
        routerClientByMac.set(m, rc);
        if (rc.connectionType === 'wifi') routerWifiMacs.add(m);
        else if (rc.connectionType === 'ethernet') routerWiredMacs.add(m);
      }
      if (rc.ip) routerClientByIp.set(rc.ip, rc);
    }

    // Index satellite clients by MAC and IP
    const satClientByMac = new Map<string, { satId: string; link: SatelliteClientLink }>();
    const satClientByIp = new Map<string, { satId: string; link: SatelliteClientLink }>();
    for (const sat of satellites) {
      for (const cLink of sat.clients || []) {
        const m = normalizeMac(cLink.mac);
        if (m && routerWifiMacs.has(m) && cLink.connectionType !== 'wifi') continue;
        if (m && routerWiredMacs.has(m) && cLink.connectionType !== 'ethernet') continue;
        if (m && !satClientByMac.has(m)) {
          satClientByMac.set(m, { satId: sat.id, link: cLink });
        }
        if (cLink.ip && !satClientByIp.has(cLink.ip)) {
          satClientByIp.set(cLink.ip, { satId: sat.id, link: cLink });
        }
      }
    }

    const liveIps = new Set<string>();
    const retained = retainedClientsRef.current;

    for (const host of snapshot.hosts) {
      if (satIpSet.has(host.ip)) continue;
      liveIps.add(host.ip);

      const m = normalizeMac(host.mac);
      const satMatch = (m ? satClientByMac.get(m) : undefined) || satClientByIp.get(host.ip);
      const routerMatch = (m ? routerClientByMac.get(m) : undefined) || routerClientByIp.get(host.ip);

      let apKey = 'router';
      let link: SatelliteClientLink | undefined = routerMatch;

      if (satMatch) {
        apKey = `sat:${satMatch.satId}`;
        link = satMatch.link;
      } else if (host.apName && host.apName !== 'Main AP') {
        const byName = satByNameLower.get(host.apName.trim().toLowerCase());
        if (byName) {
          apKey = `sat:${byName.id}`;
        }
      }

      const connectionType: 'ethernet' | 'wifi' =
        link?.connectionType === 'wifi' || host.connectionType === 'wifi'
          ? 'wifi'
          : 'ethernet';
      const wifiRxMbps =
        connectionType === 'wifi' ? (link?.wifiRxMbps ?? host.wifiRxMbps) : undefined;
      const wifiTxMbps =
        connectionType === 'wifi' ? (link?.wifiTxMbps ?? host.wifiTxMbps) : undefined;
      const wifiSignalDbm =
        connectionType === 'wifi' ? (link?.signalDbm ?? host.wifiSignalDbm) : undefined;
      const wifiBand =
        connectionType === 'wifi'
          ? link?.wifiBand ||
            host.wifiBand ||
            extractWifiBand(link?.portOrRadio || host.linkRadioOrPort)
          : undefined;
      const active = hasTangibleTraffic(host.rxBps, host.txBps);

      retained.set(host.ip, {
        host,
        apKey,
        link,
        connectionType,
        wifiBand,
        wifiRxMbps,
        wifiTxMbps,
        wifiSignalDbm,
        active,
        stale: false,
        lastSeenMs: now,
      });
    }

    // Keep recently seen devices anchored for up to 5 minutes so rows don't pop in and out
    const validApKeys = new Set<string>(['router', ...satellites.map((s) => `sat:${s.id}`)]);
    for (const [ip, entry] of retained.entries()) {
      if (satIpSet.has(ip) || now - entry.lastSeenMs > CLIENT_GRACE_MS) {
        retained.delete(ip);
        continue;
      }
      if (!validApKeys.has(entry.apKey)) {
        entry.apKey = 'router';
      }
      if (!liveIps.has(ip)) {
        retained.set(ip, {
          ...entry,
          host: {
            ...entry.host,
            rxBps: 0,
            txBps: 0,
            activeFlows: 0,
          },
          active: false,
          stale: true,
        });
      }
    }

    return Array.from(retained.values());
  }, [snapshot.hosts, snapshot.probe.lastHeartbeat, satellites, topology.routerClients]);

  // Build VLAN dropdown options from clients and detectedSubnets
  const vlanOptions = useMemo(() => {
    const map = new Map<string, { label: string; cidr: string }>();
    for (const c of stabilizedClients) {
      if (c.host.vlanName && c.host.vlanCidr) {
        map.set(c.host.vlanCidr, { label: c.host.vlanName, cidr: c.host.vlanCidr });
      }
    }
    for (const sub of snapshot.detectedSubnets || []) {
      if (!sub.isPrimary && !map.has(sub.cidr)) {
        map.set(sub.cidr, {
          label: sub.name || (sub.vlanId ? `VLAN ${sub.vlanId}` : sub.cidr),
          cidr: sub.cidr,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [stabilizedClients, snapshot.detectedSubnets]);

  // Filter & deterministically sort clients
  const filteredClientsByAp = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const map = new Map<string, MapClientEntry[]>();
    map.set('router', []);
    for (const sat of satellites) {
      map.set(`sat:${sat.id}`, []);
    }

    for (const entry of stabilizedClients) {
      if (connFilter === 'active' && !entry.active) continue;
      if (connFilter === 'wifi' && entry.connectionType !== 'wifi') continue;
      if (connFilter === 'ethernet' && entry.connectionType !== 'ethernet') continue;

      if (vlanFilter === 'PRIMARY' && entry.host.vlanCidr) continue;
      if (vlanFilter !== 'ALL' && vlanFilter !== 'PRIMARY' && entry.host.vlanCidr !== vlanFilter) {
        continue;
      }

      if (q) {
        const hay = [
          entry.host.hostname,
          entry.host.ip,
          entry.host.mac,
          entry.host.vendor,
          entry.host.apName || '',
          entry.host.vlanName || '',
          entry.host.vlanCidr || '',
          ...(entry.host.topServices || []),
          entry.connectionType,
          entry.wifiBand || '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) continue;
      }

      const bucket = map.get(entry.apKey) || map.get('router')!;
      bucket.push(entry);
    }

    for (const list of map.values()) {
      list.sort((a, b) => {
        if (sortMode === 'ip') {
          return compareIpv4(a.host.ip, b.host.ip);
        }
        if (sortMode === 'traffic') {
          const diff = b.host.rxBps + b.host.txBps - (a.host.rxBps + a.host.txBps);
          if (Math.abs(diff) > 100) return diff;
        }
        const nameCmp = a.host.hostname.localeCompare(b.host.hostname, undefined, {
          sensitivity: 'base',
        });
        if (nameCmp !== 0) return nameCmp;
        return compareIpv4(a.host.ip, b.host.ip);
      });
    }

    return map;
  }, [stabilizedClients, satellites, connFilter, vlanFilter, searchQuery, sortMode]);

  const totalCountsByAp = useMemo(() => {
    const map = new Map<string, { total: number; active: number }>();
    map.set('router', { total: 0, active: 0 });
    for (const sat of satellites) {
      map.set(`sat:${sat.id}`, { total: 0, active: 0 });
    }
    for (const c of stabilizedClients) {
      const slot = map.get(c.apKey) || map.get('router')!;
      slot.total += 1;
      if (c.active) slot.active += 1;
    }
    return map;
  }, [stabilizedClients, satellites]);

  const totalActiveCount = useMemo(
    () => stabilizedClients.filter((c) => c.active).length,
    [stabilizedClients]
  );

  const totalVisibleClients = useMemo(() => {
    let n = 0;
    for (const list of filteredClientsByAp.values()) n += list.length;
    return n;
  }, [filteredClientsByAp]);

  const allApKeys = useMemo(
    () => ['router', ...satellites.map((s) => `sat:${s.id}`)],
    [satellites]
  );
  const allCollapsed = allApKeys.length > 0 && allApKeys.every((k) => collapsedNodes.has(k));

  const toggleNodeCollapse = (apKey: string) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(apKey)) next.delete(apKey);
      else next.add(apKey);
      return next;
    });
  };

  const toggleCollapseAll = () => {
    if (allCollapsed) {
      setCollapsedNodes(new Set());
    } else {
      setCollapsedNodes(new Set(allApKeys));
    }
  };

  const wanDetails: WanDetails | undefined = topology.wan;
  const wanSpeed = wanDetails?.linkSpeedMbps || topology.routerWanSpeedMbps || 1000;
  const wanActive = hasTangibleTraffic(snapshot.kpis.rxBps, snapshot.kpis.txBps);
  const ispLabel = snapshot.serverConfig.ispName?.trim() || 'Internet';
  const routerLabel = snapshot.probe.hostname || 'Orbi Router';

  // Resolve Inspector target data
  const inspectorData = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'internet') {
      return {
        kind: 'internet' as const,
        title: ispLabel,
        subtitle: wanDetails?.ip || `${snapshot.serverConfig.ispMaxDownMbps} / ${snapshot.serverConfig.ispMaxUpMbps} Mbps`,
        rxBps: snapshot.kpis.rxBps,
        txBps: snapshot.kpis.txBps,
        wan: wanDetails,
      };
    }
    if (selection.kind === 'router') {
      return {
        kind: 'router' as const,
        title: routerLabel,
        subtitle: `WAN ${formatLinkSpeed(wanSpeed, 'ethernet', snapshot.probe.connected)} · ${topology.routerPorts.length || 4} physical ports`,
        rxBps: snapshot.kpis.rxBps,
        txBps: snapshot.kpis.txBps,
        ports: topology.routerPorts,
      };
    }
    if (selection.kind === 'satellite') {
      const sat = satellites.find((s) => s.id === selection.satId);
      if (!sat) return null;
      const satClients = stabilizedClients.filter((c) => c.apKey === `sat:${sat.id}`);
      const childRx = satClients.reduce((acc, c) => acc + c.host.rxBps, 0);
      const childTx = satClients.reduce((acc, c) => acc + c.host.txBps, 0);
      return {
        kind: 'satellite' as const,
        title: sat.name,
        subtitle: sat.host,
        rxBps: sat.rxBps > 0 ? sat.rxBps : childRx,
        txBps: sat.txBps > 0 ? sat.txBps : childTx,
        sat,
      };
    }
    const client = stabilizedClients.find((c) => c.host.ip === selection.ip);
    if (!client) return null;
    return {
      kind: 'client' as const,
      title: client.host.hostname,
      subtitle: `${client.host.ip}${client.host.mac && client.host.mac !== '00:00:00:00:00:00' ? ` · ${client.host.mac}` : ''}`,
      rxBps: client.host.rxBps,
      txBps: client.host.txBps,
      client,
    };
  }, [
    selection,
    ispLabel,
    wanDetails,
    snapshot.serverConfig.ispMaxDownMbps,
    snapshot.serverConfig.ispMaxUpMbps,
    snapshot.kpis.rxBps,
    snapshot.kpis.txBps,
    snapshot.probe.connected,
    routerLabel,
    wanSpeed,
    topology.routerPorts,
    satellites,
    stabilizedClients,
  ]);

  const apColumns = useMemo(() => {
    const routerClients = filteredClientsByAp.get('router') || [];
    const routerCounts = totalCountsByAp.get('router') || { total: 0, active: 0 };
    const routerChildRx = routerClients.reduce((acc, c) => acc + c.host.rxBps, 0);
    const routerChildTx = routerClients.reduce((acc, c) => acc + c.host.txBps, 0);

    const cols: Array<{
      key: string;
      kind: 'router' | 'satellite';
      name: string;
      subtitle: string;
      connected: boolean;
      backhaulLabel?: string;
      backhaulType?: 'ethernet' | 'wifi';
      backhaulSignalDbm?: number;
      rxBps: number;
      txBps: number;
      ports?: EthernetPortMetrics[];
      clients: MapClientEntry[];
      totalCount: number;
      activeCount: number;
      sat?: SatelliteTelemetry;
    }> = [
      {
        key: 'router',
        kind: 'router',
        name: `${routerLabel} (Main AP)`,
        subtitle: 'Direct Wi-Fi & Wired LAN',
        connected: snapshot.probe.connected,
        rxBps: routerChildRx,
        txBps: routerChildTx,
        clients: routerClients,
        totalCount: routerCounts.total,
        activeCount: routerCounts.active,
      },
    ];

    for (const sat of satellites) {
      const key = `sat:${sat.id}`;
      const clients = filteredClientsByAp.get(key) || [];
      const counts = totalCountsByAp.get(key) || { total: 0, active: 0 };
      const childRx = clients.reduce((acc, c) => acc + c.host.rxBps, 0);
      const childTx = clients.reduce((acc, c) => acc + c.host.txBps, 0);
      cols.push({
        key,
        kind: 'satellite',
        name: sat.name,
        subtitle: sat.host,
        connected: sat.connected,
        backhaulLabel: formatLinkSpeed(sat.backhaulSpeedMbps, sat.backhaulType, sat.connected),
        backhaulType: sat.backhaulType,
        backhaulSignalDbm: sat.backhaulSignalDbm,
        rxBps: sat.rxBps > 0 ? sat.rxBps : childRx,
        txBps: sat.txBps > 0 ? sat.txBps : childTx,
        ports: sat.ports,
        clients,
        totalCount: counts.total,
        activeCount: counts.active,
        sat,
      });
    }

    return cols;
  }, [
    filteredClientsByAp,
    totalCountsByAp,
    routerLabel,
    snapshot.probe.connected,
    satellites,
  ]);

  const gridColsClass =
    apColumns.length <= 1
      ? 'grid-cols-1 max-w-2xl mx-auto'
      : apColumns.length === 2
        ? 'grid-cols-1 lg:grid-cols-2'
        : 'grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3';

  return (
    <div className="space-y-4" data-testid="traffic-map-viewport">
      {/* Top Controls Toolbar */}
      <div className="app-surface border rounded-2xl p-3.5 flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            className="h-4 w-4 app-text-muted absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="text"
            data-testid="map-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Find device, IP, VLAN, service, or satellite..."
            aria-label="Filter network map"
            className="w-full app-input border rounded-xl pl-9 pr-8 py-1.5 text-xs focus:outline-none focus:border-sky-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 app-text-muted hover:opacity-80"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Connection Filter Segmented Control */}
        <div
          className="inline-flex items-center p-0.5 rounded-xl border app-border app-input text-xs"
          role="group"
          aria-label="Filter by connection type"
        >
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'active', label: `Active (${totalActiveCount})` },
              { id: 'wifi', label: 'Wi-Fi' },
              { id: 'ethernet', label: 'Ethernet' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setConnFilter(item.id)}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors whitespace-nowrap ${
                connFilter === item.id
                  ? 'app-surface shadow-xs text-sky-500'
                  : 'app-text-muted hover:opacity-90'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* VLAN Filter (shown whenever secondary VLANs/subnets exist) */}
        {vlanOptions.length > 0 && (
          <select
            aria-label="Filter by VLAN"
            data-testid="map-vlan-select"
            value={vlanFilter}
            onChange={(e) => setVlanFilter(e.target.value)}
            className="app-input border rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500"
          >
            <option value="ALL">All Subnets</option>
            <option value="PRIMARY">Primary LAN</option>
            {vlanOptions.map((v) => (
              <option key={v.cidr} value={v.cidr}>
                {v.label} ({v.cidr})
              </option>
            ))}
          </select>
        )}

        {/* Deterministic Sort Selector */}
        <select
          aria-label="Sort devices in map"
          data-testid="map-sort-select"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as ClientSortMode)}
          className="app-input border rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500"
        >
          <option value="name">Sort: Name (A–Z)</option>
          <option value="ip">Sort: IP Address</option>
          <option value="traffic">Sort: Live Traffic</option>
        </select>

        <button
          type="button"
          onClick={toggleCollapseAll}
          className="px-2.5 py-1.5 rounded-xl border app-border app-input app-row-hover text-xs font-medium app-text-secondary whitespace-nowrap transition-colors"
        >
          {allCollapsed ? 'Expand All' : 'Collapse All'}
        </button>

        <button
          type="button"
          data-testid="manage-satellites-btn"
          onClick={() => setSatelliteModalOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border app-border app-input app-row-hover text-xs font-medium app-text-secondary whitespace-nowrap transition-colors"
        >
          <Radio className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
          <span>Satellites ({satellites.length})</span>
        </button>
      </div>

      {/* Native-Scale Top-to-Bottom Network Hierarchy */}
      <div className="space-y-0">
        {/* TIER 1: Internet Gateway */}
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="map-node-internet"
            onClick={() =>
              setSelection((cur) => (cur?.kind === 'internet' ? null : { kind: 'internet' }))
            }
            className={`w-full max-w-md text-left rounded-2xl border p-4 transition-all ${
              selection?.kind === 'internet'
                ? 'app-surface border-sky-500 ring-2 ring-sky-500/20'
                : 'app-surface app-border hover:border-sky-500/50'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-sky-500/12 border border-sky-500/25 flex items-center justify-center shrink-0">
                  <Globe className="h-5 w-5 text-sky-500" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-sm font-semibold truncate">{ispLabel}</span>
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${
                        snapshot.probe.connected ? 'bg-emerald-500' : 'bg-amber-500'
                      }`}
                      aria-hidden="true"
                    />
                  </div>
                  <div className="text-[11px] font-mono app-text-muted tabular-nums truncate">
                    {wanDetails?.ip
                      ? `${wanDetails.ip} · ${formatLinkSpeed(wanSpeed, 'ethernet', snapshot.probe.connected)}`
                      : `Plan ${snapshot.serverConfig.ispMaxDownMbps} / ${snapshot.serverConfig.ispMaxUpMbps} Mbps`}
                  </div>
                </div>
              </div>

              <div className="text-right font-mono text-xs tabular-nums shrink-0">
                <div style={{ color: theme.rxColor }} className="font-semibold">
                  ↓ {formatBandwidth(snapshot.kpis.rxBps, unit)}
                </div>
                <div style={{ color: theme.txColor }} className="font-semibold">
                  ↑ {formatBandwidth(snapshot.kpis.txBps, unit)}
                </div>
              </div>
            </div>
          </button>
        </div>

        {/* Vertical WAN Trunk Connector */}
        <div className="flex justify-center py-0.5" aria-hidden="true">
          <div className="relative flex flex-col items-center h-9">
            <div
              className={`w-0.5 h-full ${
                wanActive ? 'bg-sky-500/60' : 'bg-slate-400/35'
              }`}
            />
            {wanActive && !paused && (
              <span className="absolute top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-sky-400 animate-ping" />
            )}
            <span className="absolute top-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md text-[10px] font-mono app-surface border app-border app-text-muted whitespace-nowrap">
              WAN · {formatLinkSpeed(wanSpeed, 'ethernet', snapshot.probe.connected)}
            </span>
          </div>
        </div>

        {/* TIER 2: Main Orbi Router + 4 Physical Ports (1 WAN + 3 LAN) */}
        <div className="flex justify-center">
          <div
            data-testid="map-node-router"
            role="button"
            tabIndex={0}
            onClick={() =>
              setSelection((cur) => (cur?.kind === 'router' ? null : { kind: 'router' }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSelection((cur) => (cur?.kind === 'router' ? null : { kind: 'router' }));
              }
            }}
            className={`w-full max-w-2xl rounded-2xl border p-4 cursor-pointer transition-all space-y-3 ${
              selection?.kind === 'router'
                ? 'app-surface border-sky-500 ring-2 ring-sky-500/20'
                : 'app-surface app-border hover:border-sky-500/50'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-indigo-500/12 border border-indigo-500/25 flex items-center justify-center shrink-0">
                  <Router className="h-5 w-5 text-indigo-400" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-sm font-semibold truncate">
                      {routerLabel}
                    </span>
                    <span className="text-[11px] app-text-muted">Main Router</span>
                  </div>
                  <div className="text-[11px] font-mono app-text-muted tabular-nums flex flex-wrap items-center gap-x-2">
                    <span>{totalVisibleClients} shown</span>
                    <span>·</span>
                    <span>{satellites.length} satellite{satellites.length === 1 ? '' : 's'}</span>
                    {snapshot.probe.uptimeSec > 0 && (
                      <>
                        <span>·</span>
                        <span>Up {formatDuration(snapshot.probe.uptimeSec)}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="text-right font-mono text-xs tabular-nums shrink-0">
                <div style={{ color: theme.rxColor }} className="font-semibold">
                  ↓ {formatBandwidth(snapshot.kpis.rxBps, unit)}
                </div>
                <div style={{ color: theme.txColor }} className="font-semibold">
                  ↑ {formatBandwidth(snapshot.kpis.txBps, unit)}
                </div>
              </div>
            </div>

            {/* 4 Physical Ethernet Ports on Orbi Router: 1 WAN + 3 LAN */}
            <PortStrip ports={topology.routerPorts} expectedCount={4} isRouter />
          </div>
        </div>

        {/* Distribution Stem from Main Router to Tier 3 Access Points / Satellites */}
        <div className="flex flex-col items-center pt-0.5 pb-2" aria-hidden="true">
          <div className="w-0.5 h-5 bg-slate-400/35" />
          {apColumns.length > 1 && (
            <div className="w-[70%] max-w-4xl border-t-2 border-slate-400/30 h-3 relative">
              <span className="absolute left-0 top-0 w-0.5 h-3 bg-slate-400/35" />
              <span className="absolute right-0 top-0 w-0.5 h-3 bg-slate-400/35" />
              {apColumns.length >= 3 && (
                <span className="absolute left-1/2 -translate-x-1/2 top-0 w-0.5 h-3 bg-slate-400/35" />
              )}
            </div>
          )}
        </div>

        {/* TIER 3: Main AP + Satellites Columns with Scrollable, Rock-Steady Device Rosters */}
        <div className={`grid gap-4 items-start ${gridColsClass}`}>
          {apColumns.map((col) => {
            const isCollapsed = collapsedNodes.has(col.key);
            const isSelected =
              (col.kind === 'router' && selection?.kind === 'router') ||
              (col.kind === 'satellite' &&
                selection?.kind === 'satellite' &&
                selection.satId === col.sat?.id);
            const maxClientRate = col.clients.reduce(
              (mx, c) => Math.max(mx, c.host.rxBps + c.host.txBps),
              1
            );

            return (
              <section
                key={col.key}
                data-testid={col.kind === 'satellite' ? `map-node-sat:${col.sat?.id}` : 'map-ap-router'}
                className={`rounded-2xl border overflow-hidden transition-colors ${
                  isSelected
                    ? 'app-surface border-sky-500 ring-2 ring-sky-500/20'
                    : 'app-surface app-border'
                }`}
              >
                {/* AP / Satellite Column Header */}
                <div className="p-3.5 border-b app-border space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (col.kind === 'router') {
                          setSelection((cur) =>
                            cur?.kind === 'router' ? null : { kind: 'router' }
                          );
                        } else if (col.sat) {
                          const satId = col.sat.id;
                          setSelection((cur) =>
                            cur?.kind === 'satellite' && cur.satId === satId
                              ? null
                              : { kind: 'satellite', satId }
                          );
                        }
                      }}
                      className="flex items-center gap-2.5 min-w-0 text-left flex-1 group"
                    >
                      <div
                        className={`h-9 w-9 rounded-xl border flex items-center justify-center shrink-0 ${
                          col.kind === 'satellite'
                            ? 'bg-sky-500/12 border-sky-500/25 text-sky-500'
                            : 'bg-indigo-500/12 border-indigo-500/25 text-indigo-400'
                        }`}
                      >
                        {col.kind === 'satellite' ? (
                          <Radio className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Network className="h-4 w-4" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <h3 className="font-display text-sm font-semibold truncate group-hover:text-sky-500 transition-colors">
                            {col.name}
                          </h3>
                          <span
                            className={`h-2 w-2 rounded-full shrink-0 ${
                              col.connected ? 'bg-emerald-500' : 'bg-amber-500'
                            }`}
                            title={col.connected ? 'Online' : 'Offline'}
                          />
                        </div>
                        <div className="text-[11px] app-text-muted flex flex-wrap items-center gap-x-1.5 font-mono tabular-nums">
                          <span>{col.subtitle}</span>
                          {col.backhaulLabel && (
                            <>
                              <span>·</span>
                              <span className="inline-flex items-center gap-1">
                                {col.backhaulType === 'wifi' ? (
                                  <Wifi className="h-3 w-3 text-sky-500" aria-hidden="true" />
                                ) : (
                                  <Cable className="h-3 w-3 text-emerald-500" aria-hidden="true" />
                                )}
                                {col.backhaulLabel}
                              </span>
                            </>
                          )}
                          {col.backhaulSignalDbm !== undefined && (
                            <span>({col.backhaulSignalDbm} dBm)</span>
                          )}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right font-mono text-[11px] tabular-nums">
                        <div style={{ color: theme.rxColor }}>
                          ↓ {formatBandwidth(col.rxBps, unit)}
                        </div>
                        <div style={{ color: theme.txColor }}>
                          ↑ {formatBandwidth(col.txBps, unit)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleNodeCollapse(col.key)}
                        aria-expanded={!isCollapsed}
                        aria-label={isCollapsed ? `Expand ${col.name}` : `Collapse ${col.name}`}
                        className="p-1.5 rounded-lg border app-border app-row-hover app-text-muted"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Satellite 4 Physical LAN Ports Bar */}
                  {col.kind === 'satellite' && (
                    <PortStrip ports={col.ports || []} expectedCount={4} />
                  )}

                  {/* AP Roster Summary Bar */}
                  <div className="flex items-center justify-between text-[11px] app-text-muted">
                    <span className="tabular-nums">
                      {col.clients.length === col.totalCount
                        ? `${col.totalCount} device${col.totalCount === 1 ? '' : 's'}`
                        : `${col.clients.length} of ${col.totalCount} devices`}
                    </span>
                    <span className="tabular-nums">
                      {col.activeCount} active
                    </span>
                  </div>
                </div>

                {/* Scrollable, Deterministic Client Roster */}
                {!isCollapsed && (
                  <div className="max-h-[440px] overflow-y-auto divide-y app-border">
                    {col.clients.length === 0 ? (
                      <div className="py-8 px-4 text-center text-xs app-text-muted">
                        {col.totalCount === 0
                          ? 'No clients currently attached to this node.'
                          : 'No clients match the active filters.'}
                      </div>
                    ) : (
                      col.clients.map((entry) => {
                        const { host } = entry;
                        const isClientSelected =
                          selection?.kind === 'client' && selection.ip === host.ip;
                        const icon = inferTopologyDeviceIcon(host);
                        const rateSum = host.rxBps + host.txBps;
                        const barPct = entry.active
                          ? Math.max(6, Math.min(100, Math.round((rateSum / maxClientRate) * 100)))
                          : 0;

                        return (
                          <button
                            key={host.ip}
                            type="button"
                            data-testid={`map-node-client:${host.ip}`}
                            onClick={() =>
                              setSelection((cur) =>
                                cur?.kind === 'client' && cur.ip === host.ip
                                  ? null
                                  : { kind: 'client', ip: host.ip }
                              )
                            }
                            className={`w-full h-[52px] text-left px-3.5 py-0 flex items-center transition-colors relative overflow-hidden ${
                              isClientSelected
                                ? 'bg-sky-500/12'
                                : 'app-row-hover'
                            } ${entry.stale ? 'opacity-65' : ''}`}
                          >
                            <div className="flex items-center justify-between gap-2.5 w-full min-w-0">
                              {/* Left: Device Icon + Name + IP + VLAN + Link */}
                              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                <div
                                  className={`h-8 w-8 rounded-lg border flex items-center justify-center shrink-0 ${
                                    entry.active
                                      ? 'border-sky-500/35 bg-sky-500/10 text-sky-500'
                                      : 'app-border app-input app-text-muted'
                                  }`}
                                >
                                  <ClientDeviceIcon icon={icon} className="h-4 w-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 min-w-0 leading-4">
                                    <span
                                      className={`text-xs truncate ${
                                        entry.active ? 'font-semibold' : 'font-medium app-text-secondary'
                                      }`}
                                      title={host.hostname}
                                    >
                                      {host.hostname}
                                    </span>
                                    {entry.stale && (
                                      <span className="text-[10px] app-text-muted shrink-0">
                                        Idle
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 flex flex-nowrap items-center gap-x-1.5 text-[11px] leading-4 app-text-muted overflow-hidden whitespace-nowrap">
                                    <span className="font-mono tabular-nums shrink-0">{host.ip}</span>
                                    {host.vlanName && (
                                      <span
                                        title={host.vlanCidr}
                                        className="px-1.5 py-0 rounded bg-violet-500/15 text-violet-400 text-[10px] font-medium leading-4 shrink-0"
                                      >
                                        {host.vlanName}
                                      </span>
                                    )}
                                    <span aria-hidden="true" className="shrink-0">·</span>
                                    {entry.connectionType === 'wifi' ? (
                                      <span className="inline-flex items-center gap-1 min-w-0 truncate">
                                        <Wifi className="h-3 w-3 text-sky-500 shrink-0" aria-hidden="true" />
                                        <span className="truncate">{entry.wifiBand || 'Wi-Fi'}</span>
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 min-w-0 truncate">
                                        <Cable className="h-3 w-3 text-emerald-500 shrink-0" aria-hidden="true" />
                                        <span className="truncate">Ethernet</span>
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {/* Right: Live Rx / Tx */}
                              <div className="text-right font-mono text-[11px] leading-4 tabular-nums shrink-0">
                                <div
                                  style={entry.active ? { color: theme.rxColor } : undefined}
                                  className={entry.active ? 'font-medium' : 'app-text-muted'}
                                >
                                  ↓ {formatBandwidth(host.rxBps, unit)}
                                </div>
                                <div
                                  style={entry.active ? { color: theme.txColor } : undefined}
                                  className={entry.active ? 'font-medium' : 'app-text-muted'}
                                >
                                  ↑ {formatBandwidth(host.txBps, unit)}
                                </div>
                              </div>
                            </div>

                            {/* Subtle live throughput micro-bar overlaid at bottom edge so row height never shifts */}
                            {barPct > 0 && (
                              <div
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-x-3.5 bottom-0 h-[2px] rounded-full bg-slate-500/15 overflow-hidden"
                              >
                                <div
                                  className="h-full rounded-full bg-sky-500/70 transition-all duration-500"
                                  style={{ width: `${barPct}%` }}
                                />
                              </div>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {/* Fixed Slide-Over Inspector Drawer */}
      {inspectorData && (
        <aside
          data-testid="map-node-inspector"
          aria-label={`Details for ${inspectorData.title}`}
          className="fixed top-20 right-4 bottom-4 z-40 w-[380px] max-w-[calc(100vw-2rem)] rounded-2xl border app-border app-surface shadow-2xl flex flex-col overflow-hidden"
        >
          <div className="px-4 py-3.5 border-b app-border flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] font-medium app-text-muted">
                {inspectorData.kind === 'router'
                  ? 'Main Router'
                  : inspectorData.kind === 'satellite'
                    ? 'Orbi Satellite'
                    : inspectorData.kind === 'internet'
                      ? 'Internet Uplink'
                      : 'Connected Device'}
              </div>
              <h3 className="font-display text-sm font-semibold truncate mt-0.5">
                {inspectorData.title}
              </h3>
              {inspectorData.subtitle && (
                <div className="text-[11px] font-mono app-text-muted tabular-nums mt-0.5 truncate">
                  {inspectorData.subtitle}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelection(null)}
              aria-label="Close node inspector"
              className="p-1.5 rounded-lg app-text-muted app-row-hover"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Live Rx / Tx Summary */}
            <div className="grid grid-cols-2 gap-2.5">
              <div className="p-3 rounded-xl border app-border app-input">
                <div className="text-[11px] app-text-muted">Download (Rx)</div>
                <div
                  className="mt-1 font-mono text-sm font-semibold tabular-nums"
                  style={{ color: theme.rxColor }}
                >
                  ↓ {formatBandwidth(inspectorData.rxBps, unit)}
                </div>
              </div>
              <div className="p-3 rounded-xl border app-border app-input">
                <div className="text-[11px] app-text-muted">Upload (Tx)</div>
                <div
                  className="mt-1 font-mono text-sm font-semibold tabular-nums"
                  style={{ color: theme.txColor }}
                >
                  ↑ {formatBandwidth(inspectorData.txBps, unit)}
                </div>
              </div>
            </div>

            {/* Internet WAN Details */}
            {inspectorData.kind === 'internet' && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                  <span>WAN Interface Details</span>
                </h4>
                {inspectorData.wan ? (
                  <div className="p-3 rounded-xl border app-border app-input space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="app-text-muted">Public IP</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {inspectorData.wan.ip || 'Unavailable'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="app-text-muted">Default Gateway</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {inspectorData.wan.gateway || 'Unavailable'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="app-text-muted">DNS Servers</span>
                      <span className="font-mono app-text-secondary tabular-nums text-right truncate max-w-[200px]">
                        {inspectorData.wan.dns.length > 0
                          ? inspectorData.wan.dns.join(', ')
                          : 'Unavailable'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="app-text-muted">Interface</span>
                      <span className="font-mono app-text-secondary">
                        {inspectorData.wan.iface}
                        {inspectorData.wan.state ? ` (${inspectorData.wan.state})` : ''}
                      </span>
                    </div>
                    {inspectorData.wan.linkSpeedMbps > 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="app-text-muted">Link Rate</span>
                        <span className="font-mono app-text-secondary tabular-nums">
                          {formatLinkSpeed(
                            inspectorData.wan.linkSpeedMbps,
                            'ethernet',
                            inspectorData.wan.state !== 'down'
                          )}
                          {inspectorData.wan.duplex && inspectorData.wan.duplex !== 'unknown'
                            ? ` ${inspectorData.wan.duplex === 'full' ? 'FDX' : 'HDX'}`
                            : ''}
                        </span>
                      </div>
                    )}
                    {inspectorData.wan.mtu && inspectorData.wan.mtu > 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="app-text-muted">MTU</span>
                        <span className="font-mono app-text-secondary tabular-nums">
                          {inspectorData.wan.mtu}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 pt-1.5 border-t app-border">
                      <span className="app-text-muted">Configured Plan</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {snapshot.serverConfig.ispMaxDownMbps} /{' '}
                        {snapshot.serverConfig.ispMaxUpMbps} Mbps
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="p-3 rounded-xl border app-border app-input space-y-2 text-xs">
                    <p className="app-text-muted">
                      WAN interface details have not been reported by the router agent yet.
                    </p>
                    <div className="flex items-center justify-between gap-2 pt-1.5 border-t app-border">
                      <span className="app-text-muted">Configured Plan</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {snapshot.serverConfig.ispMaxDownMbps} /{' '}
                        {snapshot.serverConfig.ispMaxUpMbps} Mbps
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Router Details + 4 Ports */}
            {inspectorData.kind === 'router' && (
              <div className="space-y-3">
                <div className="space-y-1.5 text-xs app-text-muted">
                  {snapshot.probe.uptimeSec > 0 && (
                    <div className="flex items-center justify-between">
                      <span>Uptime</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {formatDuration(snapshot.probe.uptimeSec)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>Load Average (1m)</span>
                    <span className="font-mono app-text-secondary tabular-nums">
                      {snapshot.probe.load1m.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Memory</span>
                    <span className="font-mono app-text-secondary tabular-nums">
                      {snapshot.probe.memUsedPct}%
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold flex items-center gap-1.5">
                      <Server className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                      <span>Ethernet Ports (1 WAN + 3 LAN)</span>
                    </h4>
                    <span className="text-[11px] font-mono app-text-muted tabular-nums">
                      {inspectorData.ports.length} ports
                    </span>
                  </div>
                  <PortNegotiationTable
                    ports={inspectorData.ports}
                    unit={unit}
                    theme={theme}
                  />
                </div>
              </div>
            )}

            {/* Satellite Details + 4 LAN Ports */}
            {inspectorData.kind === 'satellite' && (
              <div className="space-y-3">
                <div className="space-y-1.5 text-xs app-text-muted">
                  <div className="flex items-center justify-between">
                    <span>Backhaul Mode</span>
                    <span className="font-mono app-text-secondary">
                      {inspectorData.sat.backhaulType === 'wifi' ? 'Wi-Fi' : 'Ethernet'}
                      {inspectorData.sat.backhaulIface
                        ? ` (${inspectorData.sat.backhaulIface})`
                        : ''}
                    </span>
                  </div>
                  {inspectorData.sat.backhaulStatus && (
                    <div className="flex items-center justify-between">
                      <span>Backhaul Status</span>
                      <span className="font-mono app-text-secondary">
                        {inspectorData.sat.backhaulStatus}
                      </span>
                    </div>
                  )}
                  {inspectorData.sat.backhaulSignalDbm !== undefined && (
                    <div className="flex items-center justify-between">
                      <span>Backhaul Signal</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {inspectorData.sat.backhaulSignalDbm} dBm
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>Telemetry Source</span>
                    <span className="font-mono app-text-secondary">
                      {inspectorData.sat.source === 'ssh'
                        ? 'Stateless SSH'
                        : inspectorData.sat.source === 'router'
                          ? 'Router (/usr/sbin/satelliteinfo)'
                          : 'Dev Simulator'}
                    </span>
                  </div>
                  {inspectorData.sat.uptimeSec > 0 && (
                    <div className="flex items-center justify-between">
                      <span>Uptime</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {formatDuration(inspectorData.sat.uptimeSec)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>Total Transferred</span>
                    <span className="font-mono app-text-secondary tabular-nums">
                      {formatBytes(inspectorData.sat.rxBytes + inspectorData.sat.txBytes)}
                    </span>
                  </div>
                  {inspectorData.sat.lastError && !inspectorData.sat.connected && (
                    <div className="text-[11px] text-amber-500 pt-1">
                      {inspectorData.sat.lastError}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold flex items-center gap-1.5">
                      <Server className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                      <span>Ethernet Ports (4 LAN)</span>
                    </h4>
                    <span className="text-[11px] font-mono app-text-muted tabular-nums">
                      {inspectorData.sat.ports?.length || 0} ports
                    </span>
                  </div>
                  <PortNegotiationTable
                    ports={inspectorData.sat.ports || []}
                    unit={unit}
                    theme={theme}
                  />
                </div>
              </div>
            )}

            {/* Client Details */}
            {inspectorData.kind === 'client' && (
              <div className="space-y-3">
                <div className="space-y-1.5 text-xs app-text-muted">
                  <div className="flex items-center justify-between gap-2">
                    <span>Connection</span>
                    <span className="font-mono app-text-secondary">
                      {inspectorData.client.connectionType === 'wifi'
                        ? `${inspectorData.client.wifiBand || 'Wi-Fi'} · ${formatWifiRatesLabel(
                            inspectorData.client.wifiRxMbps,
                            inspectorData.client.wifiTxMbps
                          )}`
                        : 'Ethernet'}
                    </span>
                  </div>
                  {inspectorData.client.wifiSignalDbm !== undefined && (
                    <div className="flex items-center justify-between gap-2">
                      <span>Wi-Fi Signal</span>
                      <span className="font-mono app-text-secondary tabular-nums">
                        {inspectorData.client.wifiSignalDbm} dBm
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span>Access Point</span>
                    <span className="app-text-secondary">
                      {inspectorData.client.host.apName || 'Main AP'}
                    </span>
                  </div>
                  {inspectorData.client.host.vlanName && (
                    <div className="flex items-center justify-between gap-2">
                      <span>VLAN / Subnet</span>
                      <span className="font-mono text-violet-400">
                        {inspectorData.client.host.vlanName} ({inspectorData.client.host.vlanCidr})
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span>Vendor</span>
                    <span className="app-text-secondary truncate max-w-[180px]">
                      {inspectorData.client.host.vendor}
                    </span>
                  </div>
                  {inspectorData.client.host.advertisedServices &&
                    inspectorData.client.host.advertisedServices.length > 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <span>Advertised Services</span>
                        <span
                          className="app-text-secondary truncate max-w-[185px]"
                          title={inspectorData.client.host.advertisedServices.join(', ')}
                        >
                          {inspectorData.client.host.advertisedServices.join(', ')}
                        </span>
                      </div>
                    )}
                  <div className="flex items-center justify-between gap-2">
                    <span>Active Connections</span>
                    <span className="font-mono app-text-secondary tabular-nums">
                      {inspectorData.client.host.activeFlows}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>Total Data</span>
                    <span className="font-mono app-text-secondary tabular-nums">
                      {formatBytes(inspectorData.client.host.totalBytes)}
                    </span>
                  </div>
                  {inspectorData.client.host.topServices.length > 0 && (
                    <div className="pt-1">
                      <div className="app-text-muted mb-1">Top Services</div>
                      <div className="app-text-secondary leading-snug">
                        {inspectorData.client.host.topServices.join(', ')}
                      </div>
                    </div>
                  )}
                </div>

                {connectionsEnabled && (
                  <button
                    type="button"
                    onClick={() => onInspectHostFlows(inspectorData.client.host)}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl app-btn-primary text-xs font-semibold transition-colors"
                  >
                    <span>Inspect Live Connections</span>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>
      )}

      {/* SSH Satellite Configuration Modal */}
      {satelliteModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
          onClick={() => setSatelliteModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Orbi Satellites SSH Configuration"
            data-testid="satellite-modal"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border app-border app-surface shadow-2xl"
          >
            <div className="px-5 py-4 border-b app-border flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                  <Radio className="h-4 w-4 text-sky-500" aria-hidden="true" />
                  <span>Orbi Satellites (Stateless SSH)</span>
                </h2>
                <p className="text-xs app-text-muted mt-0.5">
                  Collect Orbi-to-Satellite backhaul traffic, LAN clients, and Ethernet negotiation
                  rates without persistent satellite storage.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSatelliteModalOpen(false)}
                aria-label="Close satellite configuration modal"
                className="p-1.5 rounded-lg app-text-muted app-row-hover"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="p-5">
              <SatelliteManager
                configs={topology.satelliteConfigs || []}
                satellites={topology.satellites || []}
                unit={unit}
                onSaveSatellite={onSaveSatellite}
                onDeleteSatellite={onDeleteSatellite}
                onTestSatellite={onTestSatellite}
                compact
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
