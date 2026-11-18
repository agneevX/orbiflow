import {
  Activity,
  Bell,
  Cpu,
  HardDrive,
  Layers,
  Network,
  Palette,
  Sliders,
  Terminal,
  X,
} from 'lucide-react';
import type { BandwidthUnit, ProbeStatus } from '../types/telemetry';
import {
  DARK_THEMES,
  LIGHT_THEMES,
  THEMES,
  type ThemeId,
  type ThemeSetting,
} from '../lib/themes';
import { formatDuration } from '../lib/formatters';

export type NavTab = 'overview' | 'flows' | 'hosts' | 'alerts' | 'setup' | 'settings';

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  probe: ProbeStatus;
  wsConnected: boolean;
  unackAlerts: number;
  themeSetting: ThemeSetting;
  effectiveThemeId: ThemeId;
  systemPrefersDark: boolean;
  onChangeThemeSetting: (setting: ThemeSetting) => void;
  unit: BandwidthUnit;
  onChangeUnit: (u: BandwidthUnit) => void;
  onToggleSimulator: (enabled: boolean) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{ id: NavTab; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Network Summary', icon: Activity },
  { id: 'flows', label: 'Connections', icon: Layers },
  { id: 'hosts', label: 'LAN Clients', icon: Network },
  { id: 'alerts', label: 'Alerts & Rules', icon: Bell },
  { id: 'setup', label: 'Router Agent', icon: Terminal },
  { id: 'settings', label: 'Server Settings', icon: Sliders },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  probe,
  wsConnected,
  unackAlerts,
  themeSetting,
  effectiveThemeId,
  systemPrefersDark,
  onChangeThemeSetting,
  unit,
  onChangeUnit,
  onToggleSimulator,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const conntrackPct =
    probe.conntrackMax > 0
      ? Math.min(100, Math.round((probe.conntrackCount / probe.conntrackMax) * 100))
      : 0;

  const statusText =
    probe.mode === 'live'
      ? 'Live RBK50'
      : probe.mode === 'simulator'
        ? 'Simulated RBK50'
        : 'Awaiting Agent';

  const statusColor =
    probe.mode === 'live'
      ? 'text-emerald-500'
      : probe.mode === 'simulator'
        ? 'text-sky-500'
        : 'text-amber-500';

  const navContent = (
    <div className="flex h-full flex-col app-sidebar border-r">
      {/* Brand header */}
      <div className="flex items-center justify-between px-5 h-16 border-b app-border">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sky-500/15 border border-sky-500/30 text-sky-500">
            <Network className="h-4 w-4" aria-hidden="true" />
          </div>
          <span className="font-display text-base font-semibold tracking-tight whitespace-nowrap">
            OrbiFlow
          </span>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation menu"
          className="lg:hidden p-1.5 app-text-muted rounded-md"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Navigation links */}
      <nav aria-label="Primary navigation" className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap border ${
                isActive
                  ? 'app-surface app-border font-semibold'
                  : 'app-text-muted border-transparent app-row-hover'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon
                  className={`h-4 w-4 shrink-0 ${isActive ? 'text-sky-500' : 'app-text-muted'}`}
                  aria-hidden="true"
                />
                <span>{item.label}</span>
              </span>
              {item.id === 'alerts' && unackAlerts > 0 && (
                <span className="font-mono text-xs font-semibold text-amber-500 tabular-nums">
                  {unackAlerts}
                </span>
              )}
            </button>
          );
        })}

        {/* Display Preferences: Theme & Bandwidth Unit */}
        <div className="pt-4 mt-4 border-t app-border px-1 space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="theme-select"
                className="flex items-center gap-1.5 text-xs font-medium app-text-muted"
              >
                <Palette className="h-3.5 w-3.5" aria-hidden="true" />
                Theme
              </label>
              {themeSetting === 'auto' && (
                <span
                  data-testid="auto-theme-resolved"
                  className="text-[11px] font-mono app-text-muted truncate"
                >
                  {THEMES[effectiveThemeId].label}
                </span>
              )}
            </div>
            <select
              id="theme-select"
              value={themeSetting}
              onChange={(e) => onChangeThemeSetting(e.target.value as ThemeSetting)}
              className="w-full app-input border rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500"
            >
              <option value="auto">
                Auto (System · {systemPrefersDark ? 'Dark' : 'Light'})
              </option>
              <optgroup label="Dark Themes">
                {DARK_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Light Themes">
                {LIGHT_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs font-medium app-text-muted">Rate Unit</span>
            <div
              role="group"
              aria-label="Bandwidth rate unit"
              className="grid grid-cols-2 app-input border rounded-md p-0.5"
            >
              {(['Mb/s', 'MB/s'] as BandwidthUnit[]).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => onChangeUnit(u)}
                  className={`py-1 text-xs font-mono rounded-sm transition-colors ${
                    unit === u
                      ? 'app-surface font-semibold'
                      : 'app-text-muted'
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>

      {/* Router node summary */}
      <div className="p-4 border-t app-border space-y-2.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="app-text-muted font-medium">Agent Feed</span>
          <span className={`font-medium ${statusColor}`}>{statusText}</span>
        </div>

        <div className="space-y-1.5 app-text-muted">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
              Router
            </span>
            <span className="font-mono app-text-secondary truncate max-w-[125px]">
              {probe.hostname}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>WAN</span>
            <span className="font-mono app-text-secondary">{probe.iface}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
              Load / Up
            </span>
            <span className="font-mono app-text-secondary tabular-nums">
              {probe.load1m.toFixed(2)} · {formatDuration(probe.uptimeSec)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Socket</span>
            <span className="font-mono app-text-secondary">
              {wsConnected ? 'Connected' : 'Reconnecting'}
            </span>
          </div>
        </div>

        <div className="pt-1 space-y-1">
          <div className="flex items-center justify-between text-[11px] app-text-muted">
            <span>nf_conntrack</span>
            <span className="font-mono tabular-nums app-text-secondary">
              {probe.conntrackCount} / {probe.conntrackMax}
            </span>
          </div>
          <div className="h-1.5 w-full bg-slate-700/30 rounded-sm overflow-hidden">
            <div
              className="h-full bg-sky-500 transition-all duration-300"
              style={{ width: `${Math.max(2, conntrackPct)}%` }}
            />
          </div>
        </div>

        {probe.mode !== 'live' && (
          <button
            type="button"
            onClick={() => onToggleSimulator(!probe.simulatorEnabled)}
            className="w-full py-1.5 px-3 rounded-md border app-border app-surface app-row-hover text-xs font-medium transition-colors whitespace-nowrap"
          >
            {probe.simulatorEnabled ? 'Stop Test Stream' : 'Start Test Stream'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-60 shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative w-64 max-w-[82vw] h-full z-10">{navContent}</div>
        </div>
      )}
    </>
  );
}
