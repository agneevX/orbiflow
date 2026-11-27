import { useEffect, useMemo, useRef, useState } from 'react';
import { List, Waypoints } from 'lucide-react';
import { Sidebar, type NavTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { OverviewView } from './components/OverviewView';
import { TrafficMapView } from './components/TrafficMapView';
import { FlowsView } from './components/FlowsView';
import { HostsView } from './components/HostsView';
import { AlertsView } from './components/AlertsView';
import { SetupView } from './components/SetupView';
import { SettingsView } from './components/SettingsView';
import { FlowInspectorDrawer } from './components/FlowInspectorDrawer';
import type { SatelliteSavePayload } from './components/SatelliteManager';
import {
  THEMES,
  applyThemeToDocument,
  getSystemPrefersDark,
  normalizeDarkTheme,
  normalizeLightTheme,
  normalizeThemeMode,
  resolveEffectiveIsDark,
  resolveThemeId,
  type AutoThemePair,
  type ThemeId,
  type ThemeMode,
} from './lib/themes';
import {
  ALL_TIME_WINDOWS,
  analyzeTimeWindow,
  type TimeWindowAnalysis,
} from './lib/timeWindowUtils';
import {
  DEFAULT_TABLE_PREFERENCES,
  sanitizeFeatureVisibility,
} from './lib/tablePreferences';
import {
  buildRouteUrl,
  getDocumentTitle,
  parseRouteFromLocation,
  type DevicesSubTab,
} from './lib/routing';
import type {
  AlertRule,
  BandwidthUnit,
  ConnectionsTablePrefs,
  DashboardSnapshot,
  DevicesTablePrefs,
  EnrichedFlow,
  HostSummary,
  NotificationConfig,
  ServerConfig,
  TablePreferences,
  TimeWindow,
} from './types/telemetry';

function loadInitialThemeState(): {
  mode: ThemeMode;
  darkTheme: ThemeId;
  lightTheme: ThemeId;
} {
  if (typeof window === 'undefined') {
    return { mode: 'auto', darkTheme: 'obsidian', lightTheme: 'daylight' };
  }

  const savedMode = localStorage.getItem('orbiflow:themeMode');
  const savedDark =
    localStorage.getItem('orbiflow:darkTheme') || localStorage.getItem('orbiflow:autoDarkTheme');
  const savedLight =
    localStorage.getItem('orbiflow:lightTheme') || localStorage.getItem('orbiflow:autoLightTheme');

  if (savedMode) {
    return {
      mode: normalizeThemeMode(savedMode),
      darkTheme: normalizeDarkTheme(savedDark),
      lightTheme: normalizeLightTheme(savedLight),
    };
  }

  const legacy = localStorage.getItem('orbiflow:theme');
  if (legacy && legacy !== 'auto') {
    const mapped = legacy === 'nordic' ? 'nord' : legacy;
    if (mapped in THEMES) {
      const t = THEMES[mapped as ThemeId];
      return {
        mode: t.isDark ? 'dark' : 'light',
        darkTheme: t.isDark ? t.id : normalizeDarkTheme(savedDark),
        lightTheme: !t.isDark ? t.id : normalizeLightTheme(savedLight),
      };
    }
  }

  return {
    mode: 'auto',
    darkTheme: normalizeDarkTheme(savedDark),
    lightTheme: normalizeLightTheme(savedLight),
  };
}

export default function App() {
  const initialRoute = useMemo(() => {
    if (typeof window === 'undefined') {
      return { tab: 'overview' as NavTab, devicesSubTab: 'list' as DevicesSubTab, query: '' };
    }
    return parseRouteFromLocation(window.location.pathname, window.location.search);
  }, []);

  const [activeTab, setActiveTab] = useState<NavTab>(initialRoute.tab);
  const [devicesSubTab, setDevicesSubTab] = useState<DevicesSubTab>(initialRoute.devicesSubTab);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('5m');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const latestSnapshotRef = useRef<DashboardSnapshot | null>(null);
  const pendingTablePrefsRef = useRef<{ prefs: TablePreferences; until: number } | null>(null);

  const initialTheme = useMemo(() => loadInitialThemeState(), []);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialTheme.mode);
  const [darkThemeId, setDarkThemeId] = useState<ThemeId>(initialTheme.darkTheme);
  const [lightThemeId, setLightThemeId] = useState<ThemeId>(initialTheme.lightTheme);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => getSystemPrefersDark());

  const [unit, setUnit] = useState<BandwidthUnit>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('orbiflow:unit') : null;
    return saved === 'MB/s' ? 'MB/s' : 'Mbps';
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('orbiflow:sidebarCollapsed') === 'true';
  });

  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedFlow, setSelectedFlow] = useState<EnrichedFlow | null>(null);
  const [flowSearchSeed, setFlowSearchSeed] = useState(initialRoute.query);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigate = (
    tab: NavTab,
    subTab: DevicesSubTab = tab === 'hosts' ? devicesSubTab : 'list',
    query = '',
    replace = false
  ) => {
    setActiveTab(tab);
    if (tab === 'hosts') {
      setDevicesSubTab(subTab);
    }
    if (tab === 'flows') {
      setFlowSearchSeed(query);
    } else {
      setFlowSearchSeed('');
    }
    if (typeof window !== 'undefined') {
      const targetUrl = buildRouteUrl(tab, subTab, tab === 'flows' ? query : '');
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      if (targetUrl !== currentUrl) {
        if (replace) {
          window.history.replaceState(null, '', targetUrl);
        } else {
          window.history.pushState(null, '', targetUrl);
        }
      }
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      const parsed = parseRouteFromLocation(window.location.pathname, window.location.search);
      setActiveTab(parsed.tab);
      setDevicesSubTab(parsed.devicesSubTab);
      setFlowSearchSeed(parsed.query);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = getDocumentTitle(activeTab, devicesSubTab);
    }
  }, [activeTab, devicesSubTab]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo(0, 0);
    }
  }, [activeTab, devicesSubTab]);

  const effectiveIsDark = resolveEffectiveIsDark(themeMode, systemPrefersDark);
  const effectiveThemeId = resolveThemeId(themeMode, systemPrefersDark, darkThemeId, lightThemeId);

  const handleChangeActiveTheme = (themeId: ThemeId) => {
    if (effectiveIsDark) {
      setDarkThemeId(normalizeDarkTheme(themeId));
    } else {
      setLightThemeId(normalizeLightTheme(themeId));
    }
  };

  const handleSelectAutoThemePair = (pair: AutoThemePair) => {
    setDarkThemeId(normalizeDarkTheme(pair.darkThemeId));
    setLightThemeId(normalizeLightTheme(pair.lightThemeId));
  };

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemPrefersDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyThemeToDocument(effectiveThemeId);
  }, [effectiveThemeId]);

  useEffect(() => {
    localStorage.setItem('orbiflow:themeMode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem('orbiflow:darkTheme', darkThemeId);
  }, [darkThemeId]);

  useEffect(() => {
    localStorage.setItem('orbiflow:lightTheme', lightThemeId);
  }, [lightThemeId]);

  useEffect(() => {
    localStorage.setItem('orbiflow:unit', unit);
  }, [unit]);

  useEffect(() => {
    localStorage.setItem('orbiflow:sidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && latestSnapshotRef.current) {
      setSnapshot(latestSnapshotRef.current);
      setNowTick(Date.now());
    }
  }, [paused]);

  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const mergePendingPrefs = (incoming: DashboardSnapshot): DashboardSnapshot => {
      const pending = pendingTablePrefsRef.current;
      if (!pending) return incoming;
      if (Date.now() > pending.until) {
        pendingTablePrefsRef.current = null;
        return incoming;
      }
      const incomingSig = JSON.stringify(incoming.serverConfig?.tablePreferences || null);
      const pendingSig = JSON.stringify(pending.prefs);
      if (incomingSig === pendingSig) {
        pendingTablePrefsRef.current = null;
        return incoming;
      }
      return {
        ...incoming,
        serverConfig: {
          ...incoming.serverConfig,
          tablePreferences: pending.prefs,
        },
      };
    };

    fetch('/api/state')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: DashboardSnapshot | null) => {
        if (active && data) {
          const merged = mergePendingPrefs(data);
          latestSnapshotRef.current = merged;
          setSnapshot(merged);
        }
      })
      .catch(() => {});

    const connect = () => {
      if (!active) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws/dashboard`;
      ws = new WebSocket(url);

      ws.onmessage = (evt) => {
        if (!active) return;
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'traffic:init') {
            const merged = mergePendingPrefs(msg.data);
            latestSnapshotRef.current = merged;
            if (!pausedRef.current) {
              setSnapshot(merged);
            }
          } else if (msg.type === 'traffic:tick') {
            // Always retain the latest background-collected snapshot even when UI display is paused
            const merged = mergePendingPrefs(msg.data);
            latestSnapshotRef.current = merged;
            if (!pausedRef.current) {
              setSnapshot(merged);
            }
          }
        } catch {
          // Ignore invalid JSON frame
        }
      };

      ws.onclose = () => {
        if (!active) return;
        retryTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  const applyUserSnapshot = (next: DashboardSnapshot) => {
    latestSnapshotRef.current = next;
    setSnapshot(next);
  };

  const handleToggleSimulator = async (enabled: boolean) => {
    const res = await fetch('/api/simulator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.snapshot) applyUserSnapshot(data.snapshot);
    }
  };

  const handleSaveRules = async (rules: AlertRule[]) => {
    const res = await fetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    if (res.ok && snapshot) {
      const data = await res.json();
      if (latestSnapshotRef.current) {
        latestSnapshotRef.current = { ...latestSnapshotRef.current, rules: data.rules };
      }
      setSnapshot({ ...snapshot, rules: data.rules });
    }
  };

  const handleSaveSettings = async (cfg: Partial<ServerConfig>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (res.ok && snapshot) {
      const data = await res.json();
      if (data.snapshot) {
        applyUserSnapshot(data.snapshot);
      } else {
        if (latestSnapshotRef.current) {
          latestSnapshotRef.current = {
            ...latestSnapshotRef.current,
            serverConfig: data.serverConfig,
            serverStats: data.serverStats,
          };
        }
        setSnapshot({
          ...snapshot,
          serverConfig: data.serverConfig,
          serverStats: data.serverStats,
        });
      }
    }
  };

  const applyOptimisticTablePrefs = (nextTablePrefs: TablePreferences) => {
    pendingTablePrefsRef.current = {
      prefs: nextTablePrefs,
      until: Date.now() + 8000,
    };
    if (latestSnapshotRef.current) {
      latestSnapshotRef.current = {
        ...latestSnapshotRef.current,
        serverConfig: {
          ...latestSnapshotRef.current.serverConfig,
          tablePreferences: nextTablePrefs,
        },
      };
    }
    setSnapshot((prev) =>
      prev
        ? {
            ...prev,
            serverConfig: {
              ...prev.serverConfig,
              tablePreferences: nextTablePrefs,
            },
          }
        : prev
    );
  };

  const handleUpdateConnectionsPrefs = async (next: ConnectionsTablePrefs) => {
    const base =
      pendingTablePrefsRef.current?.prefs ||
      latestSnapshotRef.current?.serverConfig.tablePreferences ||
      snapshot?.serverConfig.tablePreferences ||
      DEFAULT_TABLE_PREFERENCES;
    const nextTablePrefs: TablePreferences = {
      ...base,
      connections: next,
    };
    applyOptimisticTablePrefs(nextTablePrefs);
    await handleSaveSettings({ tablePreferences: nextTablePrefs });
  };

  const handleUpdateDevicesPrefs = async (next: DevicesTablePrefs) => {
    const base =
      pendingTablePrefsRef.current?.prefs ||
      latestSnapshotRef.current?.serverConfig.tablePreferences ||
      snapshot?.serverConfig.tablePreferences ||
      DEFAULT_TABLE_PREFERENCES;
    const nextTablePrefs: TablePreferences = {
      ...base,
      devices: next,
    };
    applyOptimisticTablePrefs(nextTablePrefs);
    await handleSaveSettings({ tablePreferences: nextTablePrefs });
  };

  const handleSaveNotifications = async (notifications: NotificationConfig) => {
    const res = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notifications),
    });
    if (res.ok && snapshot) {
      const data = await res.json();
      if (latestSnapshotRef.current) {
        latestSnapshotRef.current = {
          ...latestSnapshotRef.current,
          notifications: data.notifications,
        };
      }
      setSnapshot({ ...snapshot, notifications: data.notifications });
    }
  };

  const handleTestNotification = async (
    channel: 'ntfy' | 'telegram',
    config: NotificationConfig
  ): Promise<{ ok: boolean; error?: string; detail?: string }> => {
    const res = await fetch('/api/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, config }),
    });
    return res
      .json()
      .catch(() => ({ ok: false, error: 'Unable to parse server response' }));
  };

  const handleAcknowledgeAlert = async (id: string) => {
    await fetch(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' });
    if (latestSnapshotRef.current) {
      latestSnapshotRef.current = {
        ...latestSnapshotRef.current,
        alerts: latestSnapshotRef.current.alerts.map((a) =>
          a.id === id ? { ...a, acknowledged: true } : a
        ),
      };
    }
    if (snapshot) {
      setSnapshot({
        ...snapshot,
        alerts: snapshot.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
      });
    }
  };

  const handleClearAlerts = async () => {
    await fetch('/api/alerts/clear', { method: 'POST' });
    if (latestSnapshotRef.current) {
      latestSnapshotRef.current = { ...latestSnapshotRef.current, alerts: [] };
    }
    if (snapshot) {
      setSnapshot({ ...snapshot, alerts: [] });
    }
  };

  const handleSaveDeviceAlias = async (alias: {
    key: string;
    matchBy: 'mac' | 'ip';
    name: string;
  }) => {
    const res = await fetch('/api/devices/alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alias),
    });
    const data = await res.json();
    if (data.snapshot) {
      applyUserSnapshot(data.snapshot);
    }
  };

  const handleDeleteDeviceAlias = async (key: string) => {
    const res = await fetch(`/api/devices/alias/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.snapshot) {
      applyUserSnapshot(data.snapshot);
    }
  };

  const featureVisibility = useMemo(
    () => sanitizeFeatureVisibility(snapshot?.serverConfig.featureVisibility),
    [snapshot?.serverConfig.featureVisibility]
  );

  const devicesPageEnabled = featureVisibility.devices || featureVisibility.trafficMap;

  useEffect(() => {
    const tabDisabled =
      (activeTab === 'flows' && !featureVisibility.connections) ||
      (activeTab === 'hosts' && !devicesPageEnabled) ||
      (activeTab === 'alerts' && !featureVisibility.alerts) ||
      (activeTab === 'setup' && !featureVisibility.agent);
    if (tabDisabled) {
      navigate('overview', 'list', '', true);
    }
  }, [activeTab, featureVisibility, devicesPageEnabled]);

  useEffect(() => {
    if (devicesSubTab === 'list' && !featureVisibility.devices && featureVisibility.trafficMap) {
      if (activeTab === 'hosts') {
        navigate('hosts', 'map', '', true);
      } else {
        setDevicesSubTab('map');
      }
    } else if (
      devicesSubTab === 'map' &&
      !featureVisibility.trafficMap &&
      featureVisibility.devices
    ) {
      if (activeTab === 'hosts') {
        navigate('hosts', 'list', '', true);
      } else {
        setDevicesSubTab('list');
      }
    }
  }, [activeTab, devicesSubTab, featureVisibility.devices, featureVisibility.trafficMap]);

  const handleFilterConnections = (query: string) => {
    if (!featureVisibility.connections) return;
    navigate('flows', 'list', query);
  };

  const handleSelectHost = (host: HostSummary) => {
    if (!featureVisibility.connections) return;
    handleFilterConnections(host.ip);
  };

  const handleSaveSatellite = async (
    payload: SatelliteSavePayload
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch('/api/satellites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Invalid server response' }));
    if (res.ok && data.snapshot) {
      applyUserSnapshot(data.snapshot);
      return { ok: true };
    }
    return { ok: false, error: data.error || 'Failed to save satellite' };
  };

  const handleDeleteSatellite = async (id: string) => {
    const res = await fetch(`/api/satellites/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.snapshot) {
      applyUserSnapshot(data.snapshot);
    }
  };

  const handleTestSatellite = async (
    payload: SatelliteSavePayload
  ): Promise<{ ok: boolean; error?: string; summary?: string }> => {
    const res = await fetch('/api/satellites/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json().catch(() => ({ ok: false, error: 'Unable to parse server response' }));
  };

  const [nowTick, setNowTick] = useState(() => Date.now());
  const lastSampleClockRef = useRef<{ sampleTs: number; receivedAt: number }>({
    sampleTs: 0,
    receivedAt: Date.now(),
  });

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNowTick(Date.now()), 3000);
    return () => clearInterval(id);
  }, [paused]);

  const windowAvailability = useMemo(() => {
    const history = snapshot?.history ?? [];
    const rollupHistory = snapshot?.rollupHistory ?? [];
    const lastHistoryTs = history.length > 0 ? history[history.length - 1].timestamp : 0;
    const lastRollupTs =
      rollupHistory.length > 0 ? rollupHistory[rollupHistory.length - 1].timestamp : 0;
    const latestTs =
      lastHistoryTs > 0 || lastRollupTs > 0 ? Math.max(lastHistoryTs, lastRollupTs) : 0;

    if (latestTs > 0 && latestTs !== lastSampleClockRef.current.sampleTs) {
      lastSampleClockRef.current = { sampleTs: latestTs, receivedAt: Date.now() };
    }

    // Anchor the right edge strictly to the newest incoming sample timestamp while live data is arriving,
    // immune to browser-vs-router clock skew. Advance only if no new sample arrives for >30s locally.
    const localIdleMs = Math.max(0, nowTick - lastSampleClockRef.current.receivedAt);
    const referenceNow =
      latestTs > 0
        ? localIdleMs > 30_000
          ? latestTs + localIdleMs
          : latestTs
        : nowTick;

    const entries = ALL_TIME_WINDOWS.map((w) => [
      w,
      analyzeTimeWindow(w, history, rollupHistory, referenceNow),
    ]);
    return Object.fromEntries(entries) as Record<TimeWindow, TimeWindowAnalysis>;
  }, [snapshot?.history, snapshot?.rollupHistory, nowTick]);

  const activeTheme = THEMES[effectiveThemeId] || THEMES.obsidian;

  if (!snapshot) {
    return (
      <div className="min-h-screen app-canvas flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="font-display text-base font-semibold">
            Connecting to OrbiFlow Network Monitor
          </p>
          <p className="text-xs app-text-muted">Opening live update stream...</p>
        </div>
      </div>
    );
  }

  const unackAlerts = snapshot.alerts.filter((a) => !a.acknowledged).length;
  const activeTimeFormat = snapshot.serverConfig.timeFormat || '12h';

  return (
    <div className="min-h-screen app-canvas flex">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={(tab) => {
          const nextSub =
            tab === 'hosts'
              ? !featureVisibility.devices && featureVisibility.trafficMap
                ? 'map'
                : devicesSubTab
              : 'list';
          navigate(tab, nextSub, '');
        }}
        probe={snapshot.probe}
        unackAlerts={unackAlerts}
        themeMode={themeMode}
        effectiveIsDark={effectiveIsDark}
        activeThemeId={effectiveThemeId}
        onChangeThemeMode={setThemeMode}
        onChangeActiveTheme={handleChangeActiveTheme}
        onSelectAutoThemePair={handleSelectAutoThemePair}
        onToggleSimulator={handleToggleSimulator}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        featureVisibility={featureVisibility}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeTab={activeTab}
          timeWindow={timeWindow}
          onChangeTimeWindow={setTimeWindow}
          windowAvailability={windowAvailability}
          paused={paused}
          onTogglePause={() => setPaused((p) => !p)}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          rxBps={snapshot.kpis.rxBps}
          txBps={snapshot.kpis.txBps}
          probe={snapshot.probe}
          unit={unit}
          theme={activeTheme}
          serverConfig={snapshot.serverConfig}
          onSaveSettings={handleSaveSettings}
        />

        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewView
              snapshot={snapshot}
              timeWindow={timeWindow}
              windowAvailability={windowAvailability}
              onChangeTimeWindow={setTimeWindow}
              unit={unit}
              timeFormat={activeTimeFormat}
              theme={activeTheme}
              featureVisibility={featureVisibility}
              onSelectHost={handleSelectHost}
              onSelectFilter={handleFilterConnections}
              onViewAllFlows={() => {
                if (!featureVisibility.connections) return;
                navigate('flows', 'list', '');
              }}
              onOpenHosts={() => {
                if (!devicesPageEnabled) return;
                navigate('hosts', featureVisibility.devices ? 'list' : 'map', '');
              }}
            />
          )}

          {activeTab === 'flows' && featureVisibility.connections && (
            <FlowsView
              key={flowSearchSeed}
              flows={snapshot.flows}
              unit={unit}
              theme={activeTheme}
              initialSearch={flowSearchSeed}
              prefs={
                snapshot.serverConfig.tablePreferences?.connections ||
                DEFAULT_TABLE_PREFERENCES.connections
              }
              onUpdatePrefs={handleUpdateConnectionsPrefs}
              onSelectFlow={setSelectedFlow}
            />
          )}

          {activeTab === 'hosts' && devicesPageEnabled && (
            <div className="space-y-4">
              {featureVisibility.devices && featureVisibility.trafficMap && (
                <div
                  role="tablist"
                  aria-label="Devices view mode"
                  data-testid="devices-subtabs"
                  className="inline-flex items-center p-1 rounded-xl border app-border app-input gap-1"
                >
                  <button
                    type="button"
                    role="tab"
                    data-testid="devices-tab-list"
                    aria-selected={devicesSubTab === 'list'}
                    onClick={() => navigate('hosts', 'list', '')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      devicesSubTab === 'list'
                        ? 'app-surface font-semibold shadow-sm'
                        : 'app-text-muted hover:opacity-85'
                    }`}
                  >
                    <List className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Device List</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    data-testid="devices-tab-map"
                    aria-selected={devicesSubTab === 'map'}
                    onClick={() => navigate('hosts', 'map', '')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      devicesSubTab === 'map'
                        ? 'app-surface font-semibold shadow-sm'
                        : 'app-text-muted hover:opacity-85'
                    }`}
                  >
                    <Waypoints className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Network Map</span>
                  </button>
                </div>
              )}

              {devicesSubTab === 'list' && featureVisibility.devices && (
                <HostsView
                  hosts={snapshot.hosts}
                  detectedSubnets={snapshot.detectedSubnets || []}
                  unit={unit}
                  theme={activeTheme}
                  prefs={
                    snapshot.serverConfig.tablePreferences?.devices ||
                    DEFAULT_TABLE_PREFERENCES.devices
                  }
                  onUpdatePrefs={handleUpdateDevicesPrefs}
                  onInspectHostFlows={handleSelectHost}
                  onSaveAlias={handleSaveDeviceAlias}
                  onDeleteAlias={handleDeleteDeviceAlias}
                />
              )}

              {devicesSubTab === 'map' && featureVisibility.trafficMap && (
                <TrafficMapView
                  snapshot={snapshot}
                  unit={unit}
                  theme={activeTheme}
                  paused={paused}
                  connectionsEnabled={featureVisibility.connections}
                  onInspectHostFlows={handleSelectHost}
                  onSaveSatellite={handleSaveSatellite}
                  onDeleteSatellite={handleDeleteSatellite}
                  onTestSatellite={handleTestSatellite}
                />
              )}
            </div>
          )}

          {activeTab === 'alerts' && featureVisibility.alerts && (
            <AlertsView
              rules={snapshot.rules}
              alerts={snapshot.alerts}
              notifications={snapshot.notifications}
              timeFormat={activeTimeFormat}
              onSaveRules={handleSaveRules}
              onSaveNotifications={handleSaveNotifications}
              onTestNotification={handleTestNotification}
              onAcknowledgeAlert={handleAcknowledgeAlert}
              onClearAlerts={handleClearAlerts}
            />
          )}

          {activeTab === 'setup' && featureVisibility.agent && (
            <SetupView
              defaultToken={snapshot.serverConfig.probeToken}
              defaultDhcpLeasesPath={snapshot.serverConfig.dhcpLeasesPath}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              serverConfig={snapshot.serverConfig}
              serverStats={snapshot.serverStats}
              detectedSubnets={snapshot.detectedSubnets || []}
              sampleHostIp={snapshot.hosts[0]?.ip}
              satellites={snapshot.topology?.satellites || []}
              satelliteConfigs={snapshot.topology?.satelliteConfigs || []}
              unit={unit}
              onChangeUnit={setUnit}
              onSaveSettings={handleSaveSettings}
              onSaveSatellite={handleSaveSatellite}
              onDeleteSatellite={handleDeleteSatellite}
              onTestSatellite={handleTestSatellite}
            />
          )}
        </main>
      </div>

      <FlowInspectorDrawer
        flow={selectedFlow}
        unit={unit}
        timeFormat={activeTimeFormat}
        theme={activeTheme}
        onClose={() => setSelectedFlow(null)}
        onFilterByHost={handleFilterConnections}
      />
    </div>
  );
}
