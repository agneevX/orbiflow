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
  Radio,
  Share2,
  Sliders,
  Sun,
  Terminal,
  Wifi,
  X,
} from 'lucide-react';
import type { BandwidthUnit, ProbeStatus, TimeFormat } from '../types/telemetry';
import {
  DARK_THEMES,
  LIGHT_THEMES,
  type ThemeId,
  type ThemeMode,
} from '../lib/themes';
import { formatDuration } from '../lib/formatters';
import { TechTerm } from './TechTerm';

export type NavTab = 'overview' | 'topology' | 'flows' | 'hosts' | 'alerts' | 'setup' | 'settings';

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  probe: ProbeStatus;
  wsConnected: boolean;
  unackAlerts: number;
  themeMode: ThemeMode;
  effectiveIsDark: boolean;
  activeThemeId: ThemeId;
  onChangeThemeMode: (mode: ThemeMode) => void;
  onChangeActiveTheme: (themeId: ThemeId) => void;
  unit: BandwidthUnit;
  onChangeUnit: (u: BandwidthUnit) => void;
  timeFormat: TimeFormat;
  onChangeTimeFormat: (tf: TimeFormat) => void;
  onToggleSimulator: (enabled: boolean) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{ id: NavTab; label: string; icon: typeof Home }> = [
  { id: 'overview', label: 'Home', icon: Home },
  { id: 'topology', label: 'Traffic Map', icon: Share2 },
  { id: 'flows', label: 'Connections', icon: Layers },
  { id: 'hosts', label: 'Devices', icon: Network },
  { id: 'alerts', label: 'Alerts', icon: Bell },
  { id: 'setup', label: 'Agent', icon: Terminal },
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
  wsConnected,
  unackAlerts,
  themeMode,
  effectiveIsDark,
  activeThemeId,
  onChangeThemeMode,
  onChangeActiveTheme,
  unit,
  onChangeUnit,
  timeFormat,
  onChangeTimeFormat,
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

  const navContent = (
    <div className="flex h-full flex-col app-sidebar border-r">
      {/* Brand header */}
      <div className="flex items-center justify-between px-5 h-16 border-b app-border">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-500">
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
          className="lg:hidden p-1.5 app-text-muted rounded-xl"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Navigation links */}
      <nav aria-label="Primary navigation" className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
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
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap border ${
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

        {/* Display Preferences: Split Appearance Mode + Theme Palette + Speed Unit */}
        <div className="pt-4 mt-4 border-t app-border px-1 space-y-3">
          {/* Part 1: Auto / Dark / Light mode */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
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
              className="grid grid-cols-3 app-input border rounded-xl p-1"
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
                    className={`inline-flex items-center justify-center gap-1 py-1 text-[11px] font-medium rounded-lg transition-colors ${
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
              className="flex items-center justify-between gap-1.5 text-xs font-medium app-text-muted"
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
              className="w-full app-input border rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500"
            >
              {availableThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Speed Unit & Time Format side-by-side */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <span className="block text-[11px] font-medium app-text-muted">Unit</span>
              <div
                role="group"
                aria-label="Bandwidth speed unit"
                className="grid grid-cols-2 app-input border rounded-xl p-0.5"
              >
                {(['Mb/s', 'MB/s'] as BandwidthUnit[]).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => onChangeUnit(u)}
                    className={`py-1 text-[11px] font-mono rounded-lg transition-colors ${
                      unit === u ? 'app-surface font-semibold' : 'app-text-muted'
                    }`}
                  >
                    {u === 'Mb/s' ? 'Mb' : 'MB'}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <span className="block text-[11px] font-medium app-text-muted">Clock</span>
              <div
                role="group"
                aria-label="Time format"
                className="grid grid-cols-2 app-input border rounded-xl p-0.5"
              >
                {(['12h', '24h'] as TimeFormat[]).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    data-testid={`sidebar-time-format-${tf}`}
                    aria-pressed={timeFormat === tf}
                    onClick={() => onChangeTimeFormat(tf)}
                    className={`py-1 text-[11px] font-medium rounded-lg transition-colors ${
                      timeFormat === tf ? 'app-surface font-semibold' : 'app-text-muted'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Router Agent Info Footer (every item has a glyph + tooltips on technical terms) */}
      <div className="p-4 border-t app-border space-y-2.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 app-text-muted font-medium">
            <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Agent Feed</span>
          </span>
          <span className={`font-medium ${statusColor}`}>{statusText}</span>
        </div>

        <div className="space-y-1.5 app-text-muted">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Router</span>
            </span>
            <span className="font-mono app-text-secondary truncate max-w-[125px]">
              {probe.hostname}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
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

          <div className="flex items-center justify-between gap-2">
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

          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Wifi className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <TechTerm
                label="Live Link"
                tip="Real-time WebSocket connection between this browser tab and the OrbiFlow server."
              />
            </span>
            <span className="font-mono app-text-secondary">
              {wsConnected ? 'Connected' : 'Reconnecting'}
            </span>
          </div>
        </div>

        <div className="pt-1 space-y-1">
          <div className="flex items-center justify-between gap-2 text-[11px] app-text-muted">
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

        {probe.simulatorAvailable && probe.mode !== 'live' && (
          <button
            type="button"
            data-testid="toggle-simulator-btn"
            onClick={() => onToggleSimulator(!probe.simulatorEnabled)}
            className="w-full py-2 px-3 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors whitespace-nowrap"
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
