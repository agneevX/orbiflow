import { Download, Menu, Pause, Play } from 'lucide-react';
import type { NavTab } from './Sidebar';
import type { TimeWindow } from '../types/telemetry';
import { ALL_TIME_WINDOWS, type TimeWindowAnalysis } from '../lib/timeWindowUtils';

interface TopBarProps {
  activeTab: NavTab;
  timeWindow: TimeWindow;
  onChangeTimeWindow: (w: TimeWindow) => void;
  windowAvailability?: Record<TimeWindow, TimeWindowAnalysis>;
  paused: boolean;
  onTogglePause: () => void;
  onOpenMobileMenu: () => void;
  onExportCsv: () => void;
}

const TAB_TITLES: Record<NavTab, string> = {
  overview: 'Network Summary',
  flows: 'Active Connections',
  hosts: 'LAN Clients',
  alerts: 'Alerts & Rules',
  setup: 'Router Agent',
  settings: 'Server Settings',
};

export function TopBar({
  activeTab,
  timeWindow,
  onChangeTimeWindow,
  windowAvailability,
  paused,
  onTogglePause,
  onOpenMobileMenu,
  onExportCsv,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 h-16 app-canvas border-b app-border px-4 sm:px-6 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 -ml-1 rounded-md app-text-secondary app-row-hover"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs app-text-muted hidden sm:inline whitespace-nowrap">
            eth0 WAN
          </span>
          <span className="app-text-muted hidden sm:inline" aria-hidden="true">
            /
          </span>
          <h1 className="font-display text-base sm:text-lg font-semibold truncate">
            {TAB_TITLES[activeTab]}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {activeTab === 'overview' && (
          <div
            role="group"
            aria-label="Chart time window"
            className="hidden md:flex items-center app-surface border app-border rounded-md p-0.5"
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
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-sm transition-colors whitespace-nowrap ${
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

        <button
          type="button"
          onClick={onExportCsv}
          className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border app-border app-surface app-row-hover text-xs font-medium transition-colors whitespace-nowrap shrink-0"
        >
          <Download className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
          Export CSV
        </button>

        <button
          type="button"
          onClick={onTogglePause}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            paused
              ? 'bg-amber-500/15 text-amber-500 border border-amber-500/40'
              : 'bg-sky-500 text-slate-950 hover:bg-sky-400'
          }`}
        >
          {paused ? (
            <>
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              Resume Stream
            </>
          ) : (
            <>
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              Pause Stream
            </>
          )}
        </button>
      </div>
    </header>
  );
}
