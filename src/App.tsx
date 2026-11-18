import { useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar, type NavTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { OverviewView } from './components/OverviewView';
import { FlowsView } from './components/FlowsView';
import { HostsView } from './components/HostsView';
import { AlertsView } from './components/AlertsView';
import { SetupView } from './components/SetupView';
import { SettingsView } from './components/SettingsView';
import { FlowInspectorDrawer } from './components/FlowInspectorDrawer';
import { THEMES, applyThemeToDocument, type ThemeId } from './lib/themes';
import {
  ALL_TIME_WINDOWS,
  analyzeTimeWindow,
  type TimeWindowAnalysis,
} from './lib/timeWindowUtils';
import type {
  AlertRule,
  BandwidthUnit,
  DashboardSnapshot,
  EnrichedFlow,
  HostSummary,
  ServerConfig,
  TimeWindow,
} from './types/telemetry';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('1m');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  const [themeId, setThemeId] = useState<ThemeId>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('orbiflow:theme') : null;
    return saved && saved in THEMES ? (saved as ThemeId) : 'obsidian';
  });

  const [unit, setUnit] = useState<BandwidthUnit>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('orbiflow:unit') : null;
    return saved === 'MB/s' ? 'MB/s' : 'Mb/s';
  });

  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [selectedFlow, setSelectedFlow] = useState<EnrichedFlow | null>(null);
  const [flowSearchSeed, setFlowSearchSeed] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    applyThemeToDocument(themeId);
    localStorage.setItem('orbiflow:theme', themeId);
  }, [themeId]);

  useEffect(() => {
    localStorage.setItem('orbiflow:unit', unit);
  }, [unit]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    fetch('/api/state')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: DashboardSnapshot | null) => {
        if (active && data) setSnapshot(data);
      })
      .catch(() => {});

    const connect = () => {
      if (!active) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws/dashboard`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (active) setWsConnected(true);
      };

      ws.onmessage = (evt) => {
        if (!active) return;
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'traffic:init') {
            setSnapshot(msg.data);
          } else if (msg.type === 'traffic:tick' && !pausedRef.current) {
            setSnapshot(msg.data);
          }
        } catch {
          // Ignore invalid JSON frame
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setWsConnected(false);
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

  const handleToggleSimulator = async (enabled: boolean) => {
    const res = await fetch('/api/simulator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.snapshot) setSnapshot(data.snapshot);
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
      setSnapshot({
        ...snapshot,
        serverConfig: data.serverConfig,
        serverStats: data.serverStats,
      });
    }
  };

  const handleClearRdnsCache = async () => {
    const res = await fetch('/api/rdns/clear', { method: 'POST' });
    if (res.ok && snapshot) {
      const data = await res.json();
      setSnapshot({ ...snapshot, serverStats: data.serverStats });
    }
  };

  const handleAcknowledgeAlert = async (id: string) => {
    await fetch(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' });
    if (snapshot) {
      setSnapshot({
        ...snapshot,
        alerts: snapshot.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
      });
    }
  };

  const handleClearAlerts = async () => {
    await fetch('/api/alerts/clear', { method: 'POST' });
    if (snapshot) {
      setSnapshot({ ...snapshot, alerts: [] });
    }
  };

  const handleExportCsv = () => {
    const link = document.createElement('a');
    link.href = '/api/export/flows.csv';
    link.download = 'orbiflow-connections.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleFilterConnections = (query: string) => {
    setFlowSearchSeed(query);
    setActiveTab('flows');
  };

  const handleSelectHost = (host: HostSummary) => {
    handleFilterConnections(host.ip);
  };

  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNowTick(Date.now()), 5000);
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
    const referenceNow = Math.max(nowTick, latestTs);
    const entries = ALL_TIME_WINDOWS.map((w) => [
      w,
      analyzeTimeWindow(w, history, rollupHistory, referenceNow),
    ]);
    return Object.fromEntries(entries) as Record<TimeWindow, TimeWindowAnalysis>;
  }, [snapshot?.history, snapshot?.rollupHistory, nowTick]);

  const activeTheme = THEMES[themeId] || THEMES.obsidian;

  if (!snapshot) {
    return (
      <div className="min-h-screen app-canvas flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="font-display text-base font-semibold">
            Connecting to OrbiFlow Traffic Collector
          </p>
          <p className="text-xs app-text-muted">
            Opening live WebSocket stream on /ws/dashboard...
          </p>
        </div>
      </div>
    );
  }

  const unackAlerts = snapshot.alerts.filter((a) => !a.acknowledged).length;

  return (
    <div className="min-h-screen app-canvas flex">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={(tab) => {
          if (tab !== 'flows') setFlowSearchSeed('');
          setActiveTab(tab);
        }}
        probe={snapshot.probe}
        wsConnected={wsConnected}
        unackAlerts={unackAlerts}
        themeId={themeId}
        onChangeTheme={setThemeId}
        unit={unit}
        onChangeUnit={setUnit}
        onToggleSimulator={handleToggleSimulator}
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
          onExportCsv={handleExportCsv}
        />

        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewView
              snapshot={snapshot}
              timeWindow={timeWindow}
              windowAvailability={windowAvailability}
              onChangeTimeWindow={setTimeWindow}
              unit={unit}
              theme={activeTheme}
              onSelectHost={handleSelectHost}
              onSelectFilter={handleFilterConnections}
              onViewAllFlows={() => {
                setFlowSearchSeed('');
                setActiveTab('flows');
              }}
            />
          )}

          {activeTab === 'flows' && (
            <FlowsView
              key={flowSearchSeed}
              flows={snapshot.flows}
              unit={unit}
              theme={activeTheme}
              initialSearch={flowSearchSeed}
              onSelectFlow={setSelectedFlow}
            />
          )}

          {activeTab === 'hosts' && (
            <HostsView
              hosts={snapshot.hosts}
              unit={unit}
              theme={activeTheme}
              onInspectHostFlows={handleSelectHost}
            />
          )}

          {activeTab === 'alerts' && (
            <AlertsView
              rules={snapshot.rules}
              alerts={snapshot.alerts}
              onSaveRules={handleSaveRules}
              onAcknowledgeAlert={handleAcknowledgeAlert}
              onClearAlerts={handleClearAlerts}
            />
          )}

          {activeTab === 'setup' && <SetupView />}

          {activeTab === 'settings' && (
            <SettingsView
              serverConfig={snapshot.serverConfig}
              serverStats={snapshot.serverStats}
              onSaveSettings={handleSaveSettings}
              onClearRdnsCache={handleClearRdnsCache}
            />
          )}
        </main>
      </div>

      <FlowInspectorDrawer
        flow={selectedFlow}
        unit={unit}
        theme={activeTheme}
        onClose={() => setSelectedFlow(null)}
        onFilterByHost={handleFilterConnections}
      />
    </div>
  );
}
