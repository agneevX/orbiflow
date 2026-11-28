import type {
  AlertEvent,
  AlertRule,
  ClientDestinationLink,
  DashboardSnapshot,
  DetectedSubnet,
  DeviceAlias,
  EnrichedFlow,
  HostSummary,
  LanTrafficSummary,
  NotificationConfig,
  ProbeStatus,
  ServerConfig,
  ServerStats,
  TopologyTelemetry,
  TrafficPoint,
} from '../types/telemetry';

export type DashboardTabId = 'overview' | 'flows' | 'hosts' | 'alerts' | 'setup' | 'settings';
export type DevicesSubTabId = 'list' | 'map';

export interface ClientSubscription {
  tab: DashboardTabId;
  subTab: DevicesSubTabId;
  visible: boolean;
}

export interface SnapshotRevisions {
  history: number;
  rollup: number;
  hosts: number;
  flows: number;
  clientLinks: number;
  topology: number;
  detectedSubnets: number;
  rules: number;
  alerts: number;
  notifications: number;
  deviceAliases: number;
  serverConfig: number;
  serverStats: number;
}

export interface DashboardDelta {
  probe?: ProbeStatus;
  kpis?: DashboardSnapshot['kpis'];
  lanSummary?: LanTrafficSummary | null;
  historyAppend?: TrafficPoint[];
  historyReplace?: TrafficPoint[];
  rollupAppend?: TrafficPoint[];
  rollupReplace?: TrafficPoint[];
  flows?: EnrichedFlow[];
  hosts?: HostSummary[];
  clientLinks?: ClientDestinationLink[];
  detectedSubnets?: DetectedSubnet[];
  topology?: TopologyTelemetry;
  rules?: AlertRule[];
  alerts?: AlertEvent[];
  notifications?: NotificationConfig;
  deviceAliases?: Record<string, DeviceAlias>;
  serverConfig?: ServerConfig;
  serverStats?: ServerStats;
}

export interface WsClientState {
  sub: ClientSubscription;
  lastHistoryTs: number;
  lastRollupTs: number;
  needsHistoryResync: boolean;
  sentRevs: SnapshotRevisions;
  lastStatsSentAt: number;
}

export const DEFAULT_CLIENT_SUBSCRIPTION: ClientSubscription = {
  tab: 'overview',
  subTab: 'list',
  visible: true,
};

const VALID_TABS = new Set<DashboardTabId>([
  'overview',
  'flows',
  'hosts',
  'alerts',
  'setup',
  'settings',
]);

const MAX_CLIENT_HISTORY_POINTS = 1800;
const MAX_CLIENT_HISTORY_AGE_MS = 65 * 60_000;
const MAX_CLIENT_ROLLUP_POINTS = 360;
const MAX_CLIENT_ROLLUP_AGE_MS = 6 * 60 * 60_000;
const STATS_THROTTLE_MS = 15_000;

export function parseClientSubscription(raw: {
  tab?: unknown;
  subTab?: unknown;
  visible?: unknown;
}): ClientSubscription {
  const tab =
    typeof raw.tab === 'string' && VALID_TABS.has(raw.tab as DashboardTabId)
      ? (raw.tab as DashboardTabId)
      : 'overview';
  const subTab: DevicesSubTabId = raw.subTab === 'map' ? 'map' : 'list';
  const visible = raw.visible !== false && raw.visible !== 'false' && raw.visible !== '0';
  return { tab, subTab, visible };
}

function needsFlows(sub: ClientSubscription): boolean {
  return sub.visible && sub.tab === 'flows';
}

function needsHosts(sub: ClientSubscription): boolean {
  return sub.visible && (sub.tab === 'overview' || sub.tab === 'hosts' || sub.tab === 'settings');
}

function needsClientLinks(sub: ClientSubscription): boolean {
  return sub.visible && sub.tab === 'overview';
}

function needsTopology(sub: ClientSubscription): boolean {
  return sub.visible && ((sub.tab === 'hosts' && sub.subTab === 'map') || sub.tab === 'settings');
}

function filterWireClientLinks(links: ClientDestinationLink[]): ClientDestinationLink[] {
  // Overview & ClientFlowDiagram strictly display Internet links; omit LAN-only links from WS wire
  return links.filter((l) => l.scope !== 'lan' && l.category !== 'Local Network').slice(0, 15);
}

const EMPTY_TOPOLOGY: TopologyTelemetry = {
  routerPorts: [],
  routerWanSpeedMbps: 1000,
  routerClients: [],
  satellites: [],
  satelliteConfigs: [],
};

export function createInitialRevisions(): SnapshotRevisions {
  return {
    history: 0,
    rollup: 0,
    hosts: 0,
    flows: 0,
    clientLinks: 0,
    topology: 0,
    detectedSubnets: 0,
    rules: 0,
    alerts: 0,
    notifications: 0,
    deviceAliases: 0,
    serverConfig: 0,
    serverStats: 0,
  };
}

/**
 * Creates per-socket tracking state and produces the compact initial `traffic:init` payload.
 * Unused fields (protocols, remotes) and off-tab heavy arrays (flows, topology) are omitted
 * until the client subscribes to a tab that renders them.
 */
export function buildInitPayload(
  snapshot: DashboardSnapshot,
  revs: SnapshotRevisions,
  sub: ClientSubscription,
  now = Date.now()
): { payload: DashboardSnapshot; state: WsClientState } {
  const includeFlows = needsFlows(sub);
  const includeHosts = needsHosts(sub) || true; // Overview/Hosts count is small (~5 KB) & shown in KPIs
  const includeLinks = needsClientLinks(sub);
  const includeTopology = needsTopology(sub);

  const lastHistoryTs =
    snapshot.history.length > 0 ? snapshot.history[snapshot.history.length - 1].timestamp : 0;
  const lastRollupTs =
    snapshot.rollupHistory.length > 0
      ? snapshot.rollupHistory[snapshot.rollupHistory.length - 1].timestamp
      : 0;

  const payload: DashboardSnapshot = {
    ...snapshot,
    protocols: [],
    remotes: [],
    flows: includeFlows ? snapshot.flows : [],
    hosts: includeHosts ? snapshot.hosts : [],
    clientLinks: includeLinks ? filterWireClientLinks(snapshot.clientLinks) : [],
    topology: includeTopology ? snapshot.topology : EMPTY_TOPOLOGY,
  };

  const state: WsClientState = {
    sub: { ...sub },
    lastHistoryTs,
    lastRollupTs,
    needsHistoryResync: false,
    sentRevs: {
      ...revs,
      flows: includeFlows ? revs.flows : -1,
      hosts: includeHosts ? revs.hosts : -1,
      clientLinks: includeLinks ? revs.clientLinks : -1,
      topology: includeTopology ? revs.topology : -1,
    },
    lastStatsSentAt: now,
  };

  return { payload, state };
}

/**
 * Computes the minimal incremental `traffic:delta` payload for a single connected browser client.
 * Returns `null` when nothing relevant to this client changed.
 */
export function buildDeltaPayload(
  snapshot: DashboardSnapshot,
  revs: SnapshotRevisions,
  state: WsClientState,
  options?: { forceProbeKpis?: boolean; now?: number }
): DashboardDelta | null {
  const now = options?.now ?? Date.now();
  const delta: DashboardDelta = {};
  let hasChanges = false;
  const sub = state.sub;

  // Always include lightweight probe & KPI updates on telemetry ticks (or when forced)
  if (options?.forceProbeKpis || revs.history !== state.sentRevs.history) {
    delta.probe = snapshot.probe;
    delta.kpis = snapshot.kpis;
    if (snapshot.lanSummary) {
      delta.lanSummary = snapshot.lanSummary;
    }
    hasChanges = true;
  }

  // History delta: append ONLY points newer than lastHistoryTs (typically 1 point = ~75 bytes)
  if (state.needsHistoryResync) {
    delta.historyReplace = snapshot.history;
    delta.rollupReplace = snapshot.rollupHistory;
    state.lastHistoryTs =
      snapshot.history.length > 0 ? snapshot.history[snapshot.history.length - 1].timestamp : 0;
    state.lastRollupTs =
      snapshot.rollupHistory.length > 0
        ? snapshot.rollupHistory[snapshot.rollupHistory.length - 1].timestamp
        : 0;
    state.sentRevs.history = revs.history;
    state.sentRevs.rollup = revs.rollup;
    state.needsHistoryResync = false;
    hasChanges = true;
  } else {
    if (revs.history !== state.sentRevs.history) {
      const hist = snapshot.history;
      if (hist.length > 0) {
        const newestTs = hist[hist.length - 1].timestamp;
        if (state.lastHistoryTs === 0 || newestTs < state.lastHistoryTs) {
          delta.historyReplace = hist;
        } else {
          // Scan backwards from the end (almost always 1 step!)
          let idx = hist.length - 1;
          while (idx > 0 && hist[idx - 1].timestamp > state.lastHistoryTs) {
            idx -= 1;
          }
          const slice =
            hist[idx].timestamp >= state.lastHistoryTs ? hist.slice(idx) : [];
          if (slice.length > 0) {
            delta.historyAppend = slice;
          }
        }
        state.lastHistoryTs = newestTs;
      }
      state.sentRevs.history = revs.history;
      hasChanges = true;
    }

    if (revs.rollup !== state.sentRevs.rollup) {
      const roll = snapshot.rollupHistory;
      if (roll.length > 0) {
        const newestTs = roll[roll.length - 1].timestamp;
        if (state.lastRollupTs === 0 || newestTs < state.lastRollupTs) {
          delta.rollupReplace = roll;
        } else {
          let idx = roll.length - 1;
          while (idx > 0 && roll[idx - 1].timestamp > state.lastRollupTs) {
            idx -= 1;
          }
          const slice =
            roll[idx].timestamp >= state.lastRollupTs ? roll.slice(idx) : [];
          if (slice.length > 0) {
            delta.rollupAppend = slice;
          }
        }
        state.lastRollupTs = newestTs;
      }
      state.sentRevs.rollup = revs.rollup;
      hasChanges = true;
    }
  }

  // View-scoped live payloads (skipped entirely when tab is hidden or on another view!)
  if (needsFlows(sub) && revs.flows !== state.sentRevs.flows) {
    delta.flows = snapshot.flows;
    state.sentRevs.flows = revs.flows;
    hasChanges = true;
  }

  if (needsHosts(sub) && revs.hosts !== state.sentRevs.hosts) {
    delta.hosts = snapshot.hosts;
    state.sentRevs.hosts = revs.hosts;
    hasChanges = true;
  }

  if (needsClientLinks(sub) && revs.clientLinks !== state.sentRevs.clientLinks) {
    delta.clientLinks = filterWireClientLinks(snapshot.clientLinks);
    state.sentRevs.clientLinks = revs.clientLinks;
    hasChanges = true;
  }

  if (needsTopology(sub) && revs.topology !== state.sentRevs.topology) {
    delta.topology = snapshot.topology;
    state.sentRevs.topology = revs.topology;
    hasChanges = true;
  }

  // Slowly-changing config & alert slices (only transmitted when their revision bumps)
  if (sub.visible && revs.detectedSubnets !== state.sentRevs.detectedSubnets) {
    delta.detectedSubnets = snapshot.detectedSubnets;
    state.sentRevs.detectedSubnets = revs.detectedSubnets;
    hasChanges = true;
  }

  if (revs.rules !== state.sentRevs.rules) {
    delta.rules = snapshot.rules;
    state.sentRevs.rules = revs.rules;
    hasChanges = true;
  }

  if (revs.alerts !== state.sentRevs.alerts) {
    delta.alerts = snapshot.alerts;
    state.sentRevs.alerts = revs.alerts;
    hasChanges = true;
  }

  if (revs.notifications !== state.sentRevs.notifications) {
    delta.notifications = snapshot.notifications;
    state.sentRevs.notifications = revs.notifications;
    hasChanges = true;
  }

  if (revs.deviceAliases !== state.sentRevs.deviceAliases) {
    delta.deviceAliases = snapshot.deviceAliases;
    state.sentRevs.deviceAliases = revs.deviceAliases;
    hasChanges = true;
  }

  if (revs.serverConfig !== state.sentRevs.serverConfig) {
    delta.serverConfig = snapshot.serverConfig;
    state.sentRevs.serverConfig = revs.serverConfig;
    hasChanges = true;
  }

  if (
    sub.visible &&
    revs.serverStats !== state.sentRevs.serverStats &&
    (sub.tab === 'settings' || now - state.lastStatsSentAt >= STATS_THROTTLE_MS)
  ) {
    delta.serverStats = snapshot.serverStats;
    state.sentRevs.serverStats = revs.serverStats;
    state.lastStatsSentAt = now;
    hasChanges = true;
  }

  return hasChanges ? delta : null;
}

function mergeTrafficSeries(
  prev: TrafficPoint[],
  append: TrafficPoint[],
  maxPoints: number,
  maxAgeMs: number
): TrafficPoint[] {
  if (!append || append.length === 0) return prev;
  const next = prev.slice();
  for (const pt of append) {
    if (!pt || !Number.isFinite(pt.timestamp)) continue;
    const last = next.length > 0 ? next[next.length - 1] : null;
    if (!last || pt.timestamp > last.timestamp) {
      next.push(pt);
    } else if (pt.timestamp === last.timestamp) {
      next[next.length - 1] = pt;
    }
  }
  const latestTs = next.length > 0 ? next[next.length - 1].timestamp : 0;
  const cutoff = latestTs - maxAgeMs;
  let dropCount = 0;
  while (
    next.length - dropCount > maxPoints ||
    (dropCount < next.length && next[dropCount].timestamp < cutoff)
  ) {
    dropCount += 1;
  }
  return dropCount > 0 ? next.slice(dropCount) : next;
}

/**
 * Pure, idempotent client-side reducer that applies a `traffic:delta` onto the current
 * `DashboardSnapshot`, preserving object references for every unchanged slice so React
 * components and `useMemo` hooks skip unnecessary recomputation.
 */
export function applyDashboardDelta(
  prev: DashboardSnapshot,
  delta: DashboardDelta
): DashboardSnapshot {
  if (!delta) return prev;

  let nextHistory = prev.history;
  if (delta.historyReplace) {
    nextHistory = delta.historyReplace;
  } else if (delta.historyAppend && delta.historyAppend.length > 0) {
    nextHistory = mergeTrafficSeries(
      prev.history,
      delta.historyAppend,
      MAX_CLIENT_HISTORY_POINTS,
      MAX_CLIENT_HISTORY_AGE_MS
    );
  }

  let nextRollup = prev.rollupHistory;
  if (delta.rollupReplace) {
    nextRollup = delta.rollupReplace;
  } else if (delta.rollupAppend && delta.rollupAppend.length > 0) {
    nextRollup = mergeTrafficSeries(
      prev.rollupHistory,
      delta.rollupAppend,
      MAX_CLIENT_ROLLUP_POINTS,
      MAX_CLIENT_ROLLUP_AGE_MS
    );
  }

  const nextLanSummary =
    delta.lanSummary === undefined
      ? prev.lanSummary
      : delta.lanSummary === null
        ? undefined
        : delta.lanSummary;

  return {
    ...prev,
    probe: delta.probe ?? prev.probe,
    kpis: delta.kpis ?? prev.kpis,
    lanSummary: nextLanSummary,
    history: nextHistory,
    rollupHistory: nextRollup,
    flows: delta.flows ?? prev.flows,
    hosts: delta.hosts ?? prev.hosts,
    clientLinks: delta.clientLinks ?? prev.clientLinks,
    detectedSubnets: delta.detectedSubnets ?? prev.detectedSubnets,
    topology: delta.topology ?? prev.topology,
    rules: delta.rules ?? prev.rules,
    alerts: delta.alerts ?? prev.alerts,
    notifications: delta.notifications ?? prev.notifications,
    deviceAliases: delta.deviceAliases ?? prev.deviceAliases,
    serverConfig: delta.serverConfig ?? prev.serverConfig,
    serverStats: delta.serverStats ?? prev.serverStats,
  };
}
