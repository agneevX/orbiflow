import { Menu, Pause, Play } from 'lucide-react';
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
}

const TAB_TITLES: Record<NavTab, string> = {
  overview: 'Home',
  flows: 'Connections',
  hosts: 'Devices',
  alerts: 'Alerts',
  setup: 'Agent',
  settings: 'Settings',
};

const PAUSABLE_TABS = new Set<NavTab>(['overview', 'flows', 'hosts']);

export function TopBar({
  activeTab,
  timeWindow,
  onChangeTimeWindow,
  windowAvailability,
  paused,
  onTogglePause,
  onOpenMobileMenu,
}: TopBarProps) {
  const showPauseButton = PAUSABLE_TABS.has(activeTab);

  return (
    <header className="sticky top-0 z-30 h-16 app-canvas border-b app-border px-4 sm:px-6 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 -ml-1 rounded-xl app-text-secondary app-row-hover"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="font-display text-base sm:text-lg font-semibold truncate">
          {TAB_TITLES[activeTab]}
        </h1>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {activeTab === 'overview' && (
          <div
            role="group"
            aria-label="Chart time window"
            data-testid="time-window-bar"
            className="hidden md:flex items-center h-10 app-surface border app-border rounded-xl p-1"
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
                  className={`inline-flex items-center gap-1.5 h-full px-3 text-xs font-mono rounded-lg transition-colors whitespace-nowrap ${
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
            aria-label={paused ? 'Resume live updates' : 'Pause live updates'}
            title={paused ? 'Resume live updates' : 'Pause live updates'}
            className={`inline-flex items-center justify-center h-10 w-10 rounded-xl transition-colors shrink-0 ${
              paused ? 'app-btn-warning' : 'app-btn-primary'
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
