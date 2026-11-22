import {
  Bell,
  Cpu,
  Database,
  Globe,
  HardDrive,
  Home,
  Layers,
  Monitor,
  Moon,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Share2,
  Sliders,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import type { BandwidthUnit, FeatureVisibility, ProbeStatus } from '../types/telemetry';
import {
  DARK_THEMES,
  LIGHT_THEMES,
  type ThemeId,
  type ThemeMode,
} from '../lib/themes';
import { DEFAULT_FEATURE_VISIBILITY } from '../lib/tablePreferences';
import { formatDuration } from '../lib/formatters';
import { TechTerm } from './TechTerm';

export type NavTab = 'overview' | 'topology' | 'flows' | 'hosts' | 'alerts' | 'setup' | 'settings';

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  probe: ProbeStatus;
  unackAlerts: number;
  themeMode: ThemeMode;
  effectiveIsDark: boolean;
  activeThemeId: ThemeId;
  onChangeThemeMode: (mode: ThemeMode) => void;
  onChangeActiveTheme: (themeId: ThemeId) => void;
  unit: BandwidthUnit;
  onChangeUnit: (u: BandwidthUnit) => void;
  onToggleSimulator: (enabled: boolean) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  featureVisibility?: FeatureVisibility;
}

const NAV_ITEMS: Array<{
  id: NavTab;
  label: string;
  icon: typeof Home;
  featureKey?: keyof FeatureVisibility;
}> = [
  { id: 'overview', label: 'Home', icon: Home },
  { id: 'topology', label: 'Traffic Map', icon: Share2, featureKey: 'trafficMap' },
  { id: 'flows', label: 'Connections', icon: Layers, featureKey: 'connections' },
  { id: 'hosts', label: 'Devices', icon: Network, featureKey: 'devices' },
  { id: 'alerts', label: 'Alerts', icon: Bell, featureKey: 'alerts' },
  { id: 'setup', label: 'Agent', icon: Terminal, featureKey: 'agent' },
  { id: 'settings', label: 'Settings', icon: Sliders },
];

const THEME_MODES: Array<{ id: ThemeMode; label: string; icon: typeof Monitor }> = [
  { id: 'auto', label: 'Auto', icon: Monitor },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  probe,
  unackAlerts,
  themeMode,
  effectiveIsDark,
  activeThemeId,
  onChangeThemeMode,
  onChangeActiveTheme,
  unit,
  onChangeUnit,
  onToggleSimulator,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
  featureVisibility = DEFAULT_FEATURE_VISIBILITY,
}: SidebarProps) {
  const visibleNavItems = NAV_ITEMS.filter(
    (item) => !item.featureKey || featureVisibility[item.featureKey]
  );
  const conntrackPct =
    probe.conntrackMax > 0
      ? Math.min(100, Math.round((probe.conntrackCount / probe.conntrackMax) * 100))
      : 0;

  const statusText =
    probe.mode === 'live'
      ? 'Live'
      : probe.mode === 'simulator'
        ? 'Dev Simulator'
        : 'Awaiting Agent';

  const statusColor =
    probe.mode === 'live'
      ? 'text-emerald-500'
      : probe.mode === 'simulator'
        ? 'text-sky-500'
        : 'text-amber-500';

  const availableThemes = effectiveIsDark ? DARK_THEMES : LIGHT_THEMES;

  const renderNavContent = (isCollapsed: boolean) => (
    <div className="flex h-full flex-col app-sidebar border-r">
      {/* Brand header */}
      <div
        className={`flex items-center h-16 border-b app-border ${
          isCollapsed ? 'justify-center px-2' : 'justify-between px-4'
        }`}
      >
        <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'gap-2.5 min-w-0'}`}>
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-500 shrink-0">
            <Network className="h-4 w-4" aria-hidden="true" />
          </div>
          {!isCollapsed && (
            <span className="font-display text-base font-semibold tracking-tight whitespace-nowrap truncate">
              OrbiFlow
            </span>
          )}
        </div>

        {!isCollapsed && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              data-testid="sidebar-collapse-btn"
              onClick={onToggleCollapse}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="hidden lg:inline-flex items-center justify-center h-8 w-8 rounded-xl app-text-muted app-row-hover transition-colors"
            >
              <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close navigation menu"
              className="lg:hidden p-1.5 app-text-muted rounded-xl"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
      </div>

      {/* Navigation links */}
      <nav
        aria-label="Primary navigation"
        className={`flex-1 py-3 space-y-1 overflow-y-auto ${isCollapsed ? 'px-2' : 'px-3 space-y-0.5'}`}
      >
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`nav-item-${item.id}`}
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              title={isCollapsed ? item.label : undefined}
              aria-label={isCollapsed ? item.label : undefined}
              aria-current={isActive ? 'page' : undefined}
              className={`relative w-full flex items-center rounded-xl text-sm font-medium transition-colors whitespace-nowrap border ${
                isCollapsed
                  ? 'justify-center px-0 py-2.5'
                  : 'justify-between px-3 py-2'
              } ${
                isActive
                  ? 'app-surface app-border font-semibold'
                  : 'app-text-muted border-transparent app-row-hover'
              }`}
            >
              <span className={`flex items-center ${isCollapsed ? 'justify-center' : 'gap-2.5'}`}>
                <Icon
                  className={`h-4 w-4 shrink-0 ${isActive ? 'text-sky-500' : 'app-text-muted'}`}
                  aria-hidden="true"
                />
                {!isCollapsed && <span>{item.label}</span>}
              </span>
              {item.id === 'alerts' && unackAlerts > 0 && (
                isCollapsed ? (
                  <span
                    className="absolute top-1.5 right-2 h-2 w-2 rounded-full bg-amber-500"
                    aria-label={`${unackAlerts} unacknowledged alerts`}
                  />
                ) : (
                  <span className="font-mono text-xs font-semibold text-amber-500 tabular-nums">
                    {unackAlerts}
                  </span>
                )
              )}
            </button>
          );
        })}

        {/* Display Preferences (expanded mode only): Appearance Mode + Theme Palette + Speed Unit */}
        {!isCollapsed && (
          <div className="pt-4 mt-4 border-t app-border px-1 space-y-3">
            {/* Part 1: Auto / Dark / Light mode */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 h-4">
                <span className="flex items-center gap-1.5 text-xs font-medium app-text-muted">
                  <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                  Appearance
                </span>
                {themeMode === 'auto' && (
                  <span
                    data-testid="auto-mode-resolved"
                    className="text-[11px] font-mono app-text-muted"
                  >
                    {effectiveIsDark ? 'Dark' : 'Light'}
                  </span>
                )}
              </div>
              <div
                role="group"
                aria-label="Appearance mode"
                className="grid grid-cols-3 h-9 app-input border rounded-xl p-1"
              >
                {THEME_MODES.map((m) => {
                  const ModeIcon = m.icon;
                  const active = themeMode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      data-testid={`theme-mode-${m.id}`}
                      aria-pressed={active}
                      onClick={() => onChangeThemeMode(m.id)}
                      className={`inline-flex items-center justify-center gap-1 h-full text-[11px] font-medium rounded-lg transition-colors ${
                        active ? 'app-surface font-semibold' : 'app-text-muted'
                      }`}
                    >
                      <ModeIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Part 2: Theme Palette following active Dark/Light mode */}
            <div className="space-y-1.5">
              <label
                htmlFor="theme-palette-select"
                className="flex items-center justify-between gap-1.5 h-4 text-xs font-medium app-text-muted"
              >
                <span className="flex items-center gap-1.5">
                  <Palette className="h-3.5 w-3.5" aria-hidden="true" />
                  Theme
                </span>
                <span className="text-[11px] font-normal opacity-80">
                  {effectiveIsDark ? 'Dark' : 'Light'}
                </span>
              </label>
              <select
                id="theme-palette-select"
                data-testid="theme-palette-select"
                value={activeThemeId}
                onChange={(e) => onChangeActiveTheme(e.target.value as ThemeId)}
                className="w-full h-9 app-input border rounded-xl px-2.5 text-xs focus:outline-none focus:border-sky-500"
              >
                {availableThemes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Speed Unit */}
            <div className="space-y-1.5">
              <span className="flex items-center h-4 text-xs font-medium app-text-muted">
                Speed Unit
              </span>
              <div
                role="group"
                aria-label="Bandwidth speed unit"
                className="grid grid-cols-2 h-9 app-input border rounded-xl p-1"
              >
                {(['Mbps', 'MB/s'] as BandwidthUnit[]).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => onChangeUnit(u)}
                    className={`h-full text-[11px] font-mono rounded-lg transition-colors ${
                      unit === u ? 'app-surface font-semibold' : 'app-text-muted'
                    }`}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </nav>

      {/* Router Agent Info Footer */}
      {isCollapsed ? (
        <div
          data-testid="sidebar-footer"
          className="py-3 px-2 border-t app-border flex flex-col items-center gap-2"
        >
          <div
            title={`Agent Feed: ${statusText} · Router: ${probe.hostname}`}
            className={`inline-flex items-center justify-center h-9 w-9 rounded-xl border app-border app-input ${statusColor}`}
          >
            <Radio className="h-4 w-4" aria-hidden="true" />
          </div>
          <button
            type="button"
            data-testid="sidebar-collapse-btn"
            onClick={onToggleCollapse}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="inline-flex items-center justify-center h-9 w-9 rounded-xl border app-border app-surface app-text-secondary app-row-hover transition-colors"
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div
          data-testid="sidebar-footer"
          className="p-4 border-t app-border space-y-2 text-xs"
        >
          <div className="space-y-1 app-text-muted">
            <div className="flex items-center justify-between gap-2 h-6">
              <span className="flex items-center gap-1.5 font-medium">
                <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Agent Feed</span>
              </span>
              <span className={`font-medium ${statusColor}`}>{statusText}</span>
            </div>

            <div className="flex items-center justify-between gap-2 h-6">
              <span className="flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Router</span>
              </span>
              <span className="font-mono app-text-secondary truncate max-w-[125px]">
                {probe.hostname}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 h-6">
              <span className="flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <TechTerm
                  label="Internet Port"
                  tip="The router network interface connected to your ISP modem (commonly eth0 or wan)."
                />
              </span>
              <span className="font-mono app-text-secondary">
                <TechTerm
                  label={probe.iface}
                  tip={`Linux kernel network interface "${probe.iface}" carrying all inbound and outbound internet traffic.`}
                />
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 h-6">
              <span className="flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <TechTerm
                  label="CPU / Up"
                  tip="1-minute average router processor load followed by total time since the last router reboot."
                />
              </span>
              <span className="font-mono app-text-secondary tabular-nums">
                {probe.load1m.toFixed(2)} · {formatDuration(probe.uptimeSec)}
              </span>
            </div>

            <div className="space-y-1.5 pt-0.5">
              <div className="flex items-center justify-between gap-2 h-6">
                <span className="flex items-center gap-1.5">
                  <Database className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <TechTerm
                    label="nf_conntrack"
                    tip="Linux Netfilter connection tracking table on your router. Shows active tracked internet connections versus the kernel table limit."
                  />
                </span>
                <span className="font-mono tabular-nums app-text-secondary">
                  {probe.conntrackCount} / {probe.conntrackMax}
                </span>
              </div>
              <div className="h-1.5 w-full bg-slate-700/30 rounded-full overflow-hidden">
                <div
                  className="h-full bg-sky-500 rounded-full transition-all duration-300"
                  style={{ width: `${Math.max(2, conntrackPct)}%` }}
                />
              </div>
            </div>
          </div>

          {probe.simulatorAvailable && probe.mode !== 'live' && (
            <button
              type="button"
              data-testid="toggle-simulator-btn"
              onClick={() => onToggleSimulator(!probe.simulatorEnabled)}
              className="w-full h-9 px-3 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors whitespace-nowrap"
            >
              {probe.simulatorEnabled ? 'Stop Test Stream' : 'Start Test Stream'}
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <aside
        data-testid="desktop-sidebar"
        data-collapsed={collapsed ? 'true' : 'false'}
        className={`hidden lg:block shrink-0 h-screen sticky top-0 transition-[width] duration-200 ${
          collapsed ? 'w-[68px]' : 'w-60'
        }`}
      >
        {renderNavContent(collapsed)}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative w-64 max-w-[82vw] h-full z-10">
            {renderNavContent(false)}
          </div>
        </div>
      )}
    </>
  );
}
