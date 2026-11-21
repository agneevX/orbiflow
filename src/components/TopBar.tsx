import { useEffect, useRef, useState } from 'react';
import { Check, PanelLeft, Pause, Play } from 'lucide-react';
import type { NavTab } from './Sidebar';
import type { BandwidthUnit, ProbeStatus, ServerConfig, TimeWindow } from '../types/telemetry';
import { ALL_TIME_WINDOWS, type TimeWindowAnalysis } from '../lib/timeWindowUtils';
import { computeIspUtilization } from '../lib/topology';
import { computePerceivedRouterLoadPct, formatBandwidth } from '../lib/formatters';
import type { ThemePalette } from '../lib/themes';

interface TopBarProps {
  activeTab: NavTab;
  timeWindow: TimeWindow;
  onChangeTimeWindow: (w: TimeWindow) => void;
  windowAvailability?: Record<TimeWindow, TimeWindowAnalysis>;
  paused: boolean;
  onTogglePause: () => void;
  onOpenMobileMenu: () => void;
  rxBps: number;
  txBps: number;
  probe: ProbeStatus;
  unit: BandwidthUnit;
  theme: ThemePalette;
  serverConfig: ServerConfig;
  onSaveSettings: (cfg: Partial<ServerConfig>) => Promise<void>;
}

const TAB_TITLES: Record<NavTab, string> = {
  overview: 'Home',
  topology: 'Traffic Map',
  flows: 'Connections',
  hosts: 'Devices',
  alerts: 'Alerts',
  setup: 'Agent',
  settings: 'Settings',
};

const PAUSABLE_TABS = new Set<NavTab>(['overview', 'topology', 'flows', 'hosts']);

export function TopBar({
  activeTab,
  timeWindow,
  onChangeTimeWindow,
  windowAvailability,
  paused,
  onTogglePause,
  onOpenMobileMenu,
  rxBps,
  txBps,
  probe,
  unit,
  theme,
  serverConfig,
  onSaveSettings,
}: TopBarProps) {
  const showPauseButton = PAUSABLE_TABS.has(activeTab);
  const util = computeIspUtilization(
    rxBps,
    txBps,
    serverConfig.ispMaxDownMbps,
    serverConfig.ispMaxUpMbps
  );
  const routerLoadPct = computePerceivedRouterLoadPct({
    load1m: probe.load1m,
    memUsedPct: probe.memUsedPct,
    conntrackCount: probe.conntrackCount,
    conntrackMax: probe.conntrackMax,
  });

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [downLimit, setDownLimit] = useState(String(serverConfig.ispMaxDownMbps || 1000));
  const [upLimit, setUpLimit] = useState(String(serverConfig.ispMaxUpMbps || 200));
  const [saving, setSaving] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDownLimit(String(serverConfig.ispMaxDownMbps || 1000));
    setUpLimit(String(serverConfig.ispMaxUpMbps || 200));
  }, [serverConfig.ispMaxDownMbps, serverConfig.ispMaxUpMbps]);

  useEffect(() => {
    if (!popoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [popoverOpen]);

  const handleSaveSpeed = async (e: React.FormEvent) => {
    e.preventDefault();
    const downNum = Math.max(1, Math.min(100_000, Math.round(Number(downLimit) || 1000)));
    const upNum = Math.max(1, Math.min(100_000, Math.round(Number(upLimit) || 200)));
    setSaving(true);
    try {
      await onSaveSettings({
        ispMaxDownMbps: downNum,
        ispMaxUpMbps: upNum,
      });
      setPopoverOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const internetBarColor =
    util.peakPct >= 85
      ? 'linear-gradient(90deg, #f97316, #ef4444)'
      : util.peakPct >= 65
        ? 'linear-gradient(90deg, #0ea5e9, #f59e0b)'
        : theme.rxColor;

  const internetTextColor =
    util.peakPct >= 85 ? '#ef4444' : util.peakPct >= 65 ? '#f59e0b' : theme.rxColor;

  const loadBarColor =
    routerLoadPct >= 80
      ? 'linear-gradient(90deg, #f97316, #ef4444)'
      : routerLoadPct >= 60
        ? 'linear-gradient(90deg, #10b981, #f59e0b)'
        : theme.txColor;

  const loadTextColor =
    routerLoadPct >= 80 ? '#ef4444' : routerLoadPct >= 60 ? '#f59e0b' : theme.txColor;

  return (
    <header className="sticky top-0 z-30 h-14 sm:h-16 app-topbar border-b px-3 sm:px-6 flex items-center justify-between gap-2 sm:gap-4">
      {/* Left: Mobile Menu + Page Title */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Open navigation menu"
          className="lg:hidden inline-flex items-center justify-center h-9 w-9 sm:h-10 sm:w-10 -ml-1 rounded-xl border app-border app-surface/80 app-text-secondary app-row-hover transition-colors shrink-0"
        >
          <PanelLeft className="h-4 w-4 sm:h-[18px] sm:w-[18px]" strokeWidth={1.85} aria-hidden="true" />
        </button>
        <h1 className="font-display text-sm sm:text-base font-semibold tracking-tight truncate max-w-[92px] sm:max-w-[150px] md:max-w-none">
          {TAB_TITLES[activeTab]}
        </h1>
      </div>

      {/* Center: Dual Symmetrical Internet & Load Progress Bar */}
      <div
        ref={popRef}
        className="relative flex-1 min-w-0 flex justify-end sm:justify-center max-w-[440px]"
      >
        <button
          type="button"
          data-testid="topbar-utilization-btn"
          onClick={() => setPopoverOpen((v) => !v)}
          aria-expanded={popoverOpen}
          aria-label={`Internet usage ${util.peakPct.toFixed(1)}% (${formatBandwidth(rxBps, unit)} down, ${formatBandwidth(txBps, unit)} up) and router load ${routerLoadPct}%. Click to configure internet plan speeds.`}
          className="w-full max-w-[240px] sm:max-w-[340px] md:max-w-[400px] xl:max-w-[440px] h-9 sm:h-10 px-3 sm:px-3.5 rounded-xl border app-border app-surface/85 app-row-hover transition-colors flex flex-col justify-center gap-1.5 text-left"
        >
          <div className="grid grid-cols-2 gap-3 w-full items-center">
            {/* Left bar: Internet (label left, % right) */}
            <div className="min-w-0 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-1.5 text-[11px] leading-none font-medium tabular-nums">
                <span className="app-text-secondary truncate">Internet</span>
                <span
                  data-testid="topbar-utilization-pct"
                  className="font-semibold shrink-0"
                  style={{ color: internetTextColor }}
                >
                  {util.peakPct.toFixed(1)}%
                </span>
              </div>
              <div
                className="h-1 w-full rounded-full bg-slate-500/20 overflow-hidden"
                aria-hidden="true"
              >
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${util.peakPct > 0 ? Math.max(4, util.peakPct) : 0}%`,
                    background: internetBarColor,
                  }}
                />
              </div>
            </div>

            {/* Right bar: Load (% left, label right) */}
            <div className="min-w-0 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-1.5 text-[11px] leading-none font-medium tabular-nums">
                <span
                  data-testid="topbar-load-pct"
                  className="font-semibold shrink-0"
                  style={{ color: loadTextColor }}
                >
                  {routerLoadPct}%
                </span>
                <span className="app-text-secondary truncate text-right">Load</span>
              </div>
              <div
                className="h-1 w-full rounded-full bg-slate-500/20 overflow-hidden"
                aria-hidden="true"
              >
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${routerLoadPct > 0 ? Math.max(4, routerLoadPct) : 0}%`,
                    background: loadBarColor,
                  }}
                />
              </div>
            </div>
          </div>
        </button>

        {popoverOpen && (
          <form
            onSubmit={handleSaveSpeed}
            data-testid="isp-speed-popover"
            className="fixed sm:absolute right-3 sm:right-auto sm:left-1/2 sm:-translate-x-1/2 top-[60px] sm:top-full sm:mt-2 w-[min(18rem,calc(100vw-1.5rem))] p-4 rounded-2xl border app-border app-surface shadow-xl z-40 space-y-3"
          >
            <div>
              <div className="text-xs font-semibold">Internet Plan Speeds</div>
              <p className="text-[11px] app-text-muted mt-0.5">
                Set your plan speeds to calculate internet usage %.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label
                  htmlFor="topbar-max-down"
                  className="block text-[11px] app-text-muted mb-1"
                >
                  Download (Mbps)
                </label>
                <input
                  id="topbar-max-down"
                  data-testid="topbar-max-down-input"
                  type="number"
                  min={1}
                  max={100000}
                  value={downLimit}
                  onChange={(e) => setDownLimit(e.target.value)}
                  className="w-full app-input border rounded-lg px-2.5 py-1.5 text-xs tabular-nums focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label htmlFor="topbar-max-up" className="block text-[11px] app-text-muted mb-1">
                  Upload (Mbps)
                </label>
                <input
                  id="topbar-max-up"
                  data-testid="topbar-max-up-input"
                  type="number"
                  min={1}
                  max={100000}
                  value={upLimit}
                  onChange={(e) => setUpLimit(e.target.value)}
                  className="w-full app-input border rounded-lg px-2.5 py-1.5 text-xs tabular-nums focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPopoverOpen(false)}
                className="px-2.5 py-1.5 rounded-lg text-xs app-text-muted hover:opacity-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="topbar-save-speed-btn"
                disabled={saving}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg app-btn-primary text-xs font-semibold disabled:opacity-60"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Right: Uniform Height Time Window (Home lg+) & Blended Pause Toggle */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {activeTab === 'overview' && (
          <div
            role="group"
            aria-label="Chart time window"
            data-testid="time-window-bar"
            className="hidden lg:flex items-center h-10 app-surface border app-border rounded-xl p-1"
          >
            {ALL_TIME_WINDOWS.map((w) => {
              const info = windowAvailability?.[w];
              const isEmpty = info?.status === 'empty';
              const isPartial = info?.status === 'partial';
              const selected = timeWindow === w;
              const statusLabel = isEmpty
                ? `${w} — No data`
                : isPartial
                  ? `${w} — Partial data (${info.coveragePct}%)`
                  : `${w} — Complete data`;

              return (
                <button
                  key={w}
                  type="button"
                  title={statusLabel}
                  aria-label={isEmpty ? `${w} (no data)` : isPartial ? `${w} (partial data)` : w}
                  onClick={() => onChangeTimeWindow(w)}
                  className={`inline-flex items-center gap-1.5 h-full px-2.5 text-xs font-medium tabular-nums rounded-lg transition-colors whitespace-nowrap ${
                    selected
                      ? 'bg-sky-500/15 text-sky-500 font-semibold'
                      : isEmpty
                        ? 'app-text-muted opacity-45 hover:opacity-80'
                        : 'app-text-muted hover:opacity-90'
                  }`}
                >
                  <span>{w}</span>
                  {isEmpty && (
                    <span
                      className="w-1.5 h-1.5 rounded-full border border-current opacity-80"
                      aria-hidden="true"
                    />
                  )}
                  {isPartial && (
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-amber-400/80"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {showPauseButton && (
          <button
            type="button"
            data-testid="pause-stream-btn"
            onClick={onTogglePause}
            aria-label={
              paused
                ? 'Resume live display (background collection active)'
                : 'Pause display updates (background collection continues)'
            }
            title={
              paused
                ? 'Resume live display (data still collecting in background)'
                : 'Pause display updates (data continues collecting in background)'
            }
            className={`inline-flex items-center justify-center h-9 w-9 sm:h-10 sm:w-10 rounded-xl border transition-colors shrink-0 ${
              paused
                ? 'border-amber-500/40 bg-amber-500/12 text-amber-500 hover:bg-amber-500/20'
                : 'app-border app-surface/85 app-text-secondary app-row-hover'
            }`}
          >
            {paused ? (
              <Play className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Pause className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </header>
  );
}
