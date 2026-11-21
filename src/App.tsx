import { useEffect, useMemo, useRef, useState } from 'react';
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
  type ThemeId,
  type ThemeMode,
} from './lib/themes';
import {
  ALL_TIME_WINDOWS,
  analyzeTimeWindow,
  type TimeWindowAnalysis,
} from './lib/timeWindowUtils';
import { DEFAULT_TABLE_PREFERENCES } from './lib/tablePreferences';
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
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('5m');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const latestSnapshotRef = useRef<DashboardSnapshot | null>(null);

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

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo(0, 0);
    }
  }, [activeTab]);
  const [flowSearchSeed, setFlowSearchSeed] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const effectiveIsDark = resolveEffectiveIsDark(themeMode, systemPrefersDark);
  const effectiveThemeId = resolveThemeId(themeMode, systemPrefersDark, darkThemeId, lightThemeId);

  const handleChangeActiveTheme = (themeId: ThemeId) => {
    if (effectiveIsDark) {
      setDarkThemeId(normalizeDarkTheme(themeId));
    } else {
      setLightThemeId(normalizeLightTheme(themeId));
    }
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

    fetch('/api/state')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: DashboardSnapshot | null) => {
        if (active && data) {
          latestSnapshotRef.current = data;
          setSnapshot(data);
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
            latestSnapshotRef.current = msg.data;
            if (!pausedRef.current) {
              setSnapshot(msg.data);
            }
          } else if (msg.type === 'traffic:tick') {
            // Always retain the latest background-collected snapshot even when UI display is paused
            latestSnapshotRef.current = msg.data;
            if (!pausedRef.current) {
              setSnapshot(msg.data);
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

  const handleUpdateConnectionsPrefs = async (next: ConnectionsTablePrefs) => {
    const current = snapshot?.serverConfig.tablePreferences || DEFAULT_TABLE_PREFERENCES;
    await handleSaveSettings({
      tablePreferences: {
        ...current,
        connections: next,
      },
    });
  };

  const handleUpdateDevicesPrefs = async (next: DevicesTablePrefs) => {
    const current = snapshot?.serverConfig.tablePreferences || DEFAULT_TABLE_PREFERENCES;
    await handleSaveSettings({
      tablePreferences: {
        ...current,
        devices: next,
      },
    });
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

  const handleFilterConnections = (query: string) => {
    setFlowSearchSeed(query);
    setActiveTab('flows');
  };

  const handleSelectHost = (host: HostSummary) => {
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

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNowTick(Date.now()), 3000);
    return () => clearInterval(id);
  }, [paused]);

  const windowAvailability = useMemo(() => {
    const history = snapshot?.history ?? [];
    const rollupHistory = snapshot?.rollupHistory ?? [];
    const latestTs =
      history.length > 0
        ? history[history.length - 1].timestamp
        : rollupHistory.length > 0
          ? rollupHistory[rollupHistory.length - 1].timestamp
          : nowTick;
    // Anchor the right edge of live graphs to the latest incoming sample timestamp
    // so there is zero empty gap on the right; only advance with wall-clock if data stops.
    const referenceNow =
      history.length > 0 || rollupHistory.length > 0
        ? nowTick - latestTs > 20_000
          ? nowTick
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
          if (tab !== 'flows') setFlowSearchSeed('');
          setActiveTab(tab);
        }}
        probe={snapshot.probe}
        unackAlerts={unackAlerts}
        themeMode={themeMode}
        effectiveIsDark={effectiveIsDark}
        activeThemeId={effectiveThemeId}
        onChangeThemeMode={setThemeMode}
        onChangeActiveTheme={handleChangeActiveTheme}
        unit={unit}
        onChangeUnit={setUnit}
        onToggleSimulator={handleToggleSimulator}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
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
              onSelectHost={handleSelectHost}
              onSelectFilter={handleFilterConnections}
              onViewAllFlows={() => {
                setFlowSearchSeed('');
                setActiveTab('flows');
              }}
              onOpenHosts={() => setActiveTab('hosts')}
            />
          )}

          {activeTab === 'topology' && (
            <TrafficMapView
              snapshot={snapshot}
              unit={unit}
              theme={activeTheme}
              paused={paused}
              onInspectHostFlows={handleSelectHost}
              onSaveSatellite={handleSaveSatellite}
              onDeleteSatellite={handleDeleteSatellite}
              onTestSatellite={handleTestSatellite}
            />
          )}

          {activeTab === 'flows' && (
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

          {activeTab === 'hosts' && (
            <HostsView
              hosts={snapshot.hosts}
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

          {activeTab === 'alerts' && (
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

          {activeTab === 'setup' && (
            <SetupView
              defaultToken={snapshot.serverConfig.probeToken}
              defaultDhcpLeasesPath={snapshot.serverConfig.dhcpLeasesPath}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              serverConfig={snapshot.serverConfig}
              serverStats={snapshot.serverStats}
              satellites={snapshot.topology?.satellites || []}
              satelliteConfigs={snapshot.topology?.satelliteConfigs || []}
              unit={unit}
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
