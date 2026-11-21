import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, MonitorSmartphone } from 'lucide-react';
import type {
  BandwidthUnit,
  DashboardSnapshot,
  HostSummary,
  TimeFormat,
  TimeWindow,
} from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  ALL_TIME_WINDOWS,
  analyzeTimeWindow,
  type TimeWindowAnalysis,
} from '../lib/timeWindowUtils';
import { ThroughputChart } from './ThroughputChart';
import { ClientFlowDiagram, type FlowScopeTab } from './ClientFlowDiagram';
import {
  formatBandwidth,
  formatBytes,
  hasTangibleTraffic,
} from '../lib/formatters';

interface OverviewViewProps {
  snapshot: DashboardSnapshot;
  timeWindow: TimeWindow;
  windowAvailability: Record<TimeWindow, TimeWindowAnalysis>;
  onChangeTimeWindow?: (w: TimeWindow) => void;
  unit: BandwidthUnit;
  timeFormat: TimeFormat;
  theme: ThemePalette;
  onSelectHost: (host: HostSummary) => void;
  onSelectFilter: (query: string) => void;
  onViewAllFlows: () => void;
  onOpenHosts?: () => void;
}

export function OverviewView({
  snapshot,
  timeWindow,
  windowAvailability,
  onChangeTimeWindow,
  unit,
  timeFormat,
  theme,
  onSelectHost,
  onSelectFilter,
  onViewAllFlows,
  onOpenHosts,
}: OverviewViewProps) {
  const [flowsTab, setFlowsTab] = useState<FlowScopeTab>('internet');

  const isLongWindow = timeWindow === '1h' || timeWindow === '6h' || timeWindow === '24h';
  const activeAnalysis =
    windowAvailability[timeWindow] ||
    analyzeTimeWindow(timeWindow, snapshot.history, snapshot.rollupHistory);

  const onlineClientsCount = snapshot.hosts.length;
  const activeClientsCount = snapshot.kpis.activeHosts;

  const topHosts = snapshot.hosts
    .filter((h) => hasTangibleTraffic(h.rxBps, h.txBps))
    .slice(0, 5);

  const topServices = (() => {
    const map = new Map<
      string,
      { service: string; category: string; bps: number; bytes: number; flows: number }
    >();
    for (const l of snapshot.clientLinks) {
      if (l.scope === 'lan' || l.category === 'Local Network') continue;
      const cur = map.get(l.service) || {
        service: l.service,
        category: l.category,
        bps: 0,
        bytes: 0,
        flows: 0,
      };
      cur.bps += l.totalBps;
      cur.bytes += l.totalBytes;
      cur.flows += l.flowCount;
      map.set(l.service, cur);
    }
    return Array.from(map.values())
      .sort((a, b) => b.bps - a.bps || b.bytes - a.bytes)
      .slice(0, 5);
  })();

  return (
    <div className="space-y-6">
      {/* KPI Cards: Download, Upload, Clients Online */}
      <section
        aria-label="Live internet speeds and clients online"
        data-testid="home-kpi-cards"
        className="grid grid-cols-1 sm:grid-cols-3 gap-4"
      >
        <div className="app-surface border rounded-2xl px-4 py-2.5 sm:px-4 sm:py-3 flex flex-col justify-between gap-1">
          <div className="flex items-center justify-between gap-2 text-xs app-text-muted">
            <span className="font-medium">Download</span>
            <ArrowDownRight className="h-3.5 w-3.5 shrink-0 app-text-muted" aria-hidden="true" />
          </div>
          <div
            data-testid="kpi-download-live"
            className="font-display text-lg sm:text-xl font-semibold tracking-tight leading-snug tabular-nums"
          >
            {formatBandwidth(snapshot.kpis.rxBps, unit)}
          </div>
        </div>

        <div className="app-surface border rounded-2xl px-4 py-2.5 sm:px-4 sm:py-3 flex flex-col justify-between gap-1">
          <div className="flex items-center justify-between gap-2 text-xs app-text-muted">
            <span className="font-medium">Upload</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 app-text-muted" aria-hidden="true" />
          </div>
          <div
            data-testid="kpi-upload-live"
            className="font-display text-lg sm:text-xl font-semibold tracking-tight leading-snug tabular-nums"
          >
            {formatBandwidth(snapshot.kpis.txBps, unit)}
          </div>
        </div>

        <button
          type="button"
          data-testid="kpi-clients-online-card"
          onClick={() => onOpenHosts?.()}
          className="app-surface border rounded-2xl px-4 py-2.5 sm:px-4 sm:py-3 flex flex-col justify-between gap-1 text-left app-row-hover transition-colors"
        >
          <div className="flex items-center justify-between gap-2 text-xs app-text-muted w-full">
            <span className="font-medium">Clients Online</span>
            <MonitorSmartphone className="h-3.5 w-3.5 shrink-0 app-text-muted" aria-hidden="true" />
          </div>
          <div
            data-testid="kpi-clients-online-count"
            className="font-display text-lg sm:text-xl font-semibold tracking-tight leading-snug tabular-nums"
          >
            {onlineClientsCount}
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] app-text-muted tabular-nums w-full min-w-0">
            <span className="truncate">
              <span className="font-medium app-text-secondary">{activeClientsCount}</span> active
            </span>
            <span className="shrink-0">
              {snapshot.kpis.activeFlows}{' '}
              {snapshot.kpis.activeFlows === 1 ? 'connection' : 'connections'}
            </span>
          </div>
        </button>
      </section>

      {/* Primary Focal Anchor: Internet traffic Chart */}
      <section className="app-surface border rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="font-display text-sm font-semibold">Internet traffic</h2>
            <p className="text-xs app-text-muted mt-0.5">
              Real-time download and upload throughput across the {timeWindow} window
              {activeAnalysis.status !== 'full' && (
                <>
                  {' · '}
                  <span
                    data-testid="window-coverage-note"
                    className={
                      activeAnalysis.status === 'empty' ? 'text-amber-500 font-medium' : ''
                    }
                  >
                    {activeAnalysis.summaryText}
                  </span>
                </>
              )}
            </p>
          </div>
          {onChangeTimeWindow && (
            <div
              role="group"
              aria-label="Mobile chart time window"
              className="flex lg:hidden items-center h-9 app-input border rounded-xl p-1"
            >
              {ALL_TIME_WINDOWS.map((w) => {
                const info = windowAvailability[w];
                const isEmpty = info?.status === 'empty';
                const isPartial = info?.status === 'partial';
                return (
                  <button
                    key={w}
                    type="button"
                    aria-label={isEmpty ? `${w} (no data)` : isPartial ? `${w} (partial data)` : w}
                    onClick={() => onChangeTimeWindow(w)}
                    className={`inline-flex items-center gap-1 h-full px-2 text-xs font-medium tabular-nums rounded-lg transition-colors ${
                      timeWindow === w
                        ? 'bg-sky-500/15 text-sky-500 font-semibold'
                        : isEmpty
                          ? 'app-text-muted opacity-45'
                          : 'app-text-muted'
                    }`}
                  >
                    <span>{w}</span>
                    {isEmpty && (
                      <span
                        className="w-1 h-1 rounded-full border border-current opacity-80"
                        aria-hidden="true"
                      />
                    )}
                    {isPartial && (
                      <span
                        className="w-1 h-1 rounded-full bg-amber-400/80"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <ThroughputChart
          analysis={activeAnalysis}
          fullHistory={snapshot.history}
          fullRollupHistory={snapshot.rollupHistory}
          unit={unit}
          timeFormat={timeFormat}
          theme={theme}
          longWindow={isLongWindow}
          height={250}
        />
      </section>

      {/* Device to Destination Flow Diagram */}
      <section className="app-surface border rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2.5">
          <div>
            <h2 className="font-display text-sm font-semibold">Flows</h2>
            <p className="text-xs app-text-muted mt-0.5">
              {flowsTab === 'internet'
                ? 'Live internet traffic paths from top active local devices'
                : 'Live local network traffic between devices on your LAN'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div
              role="tablist"
              aria-label="Traffic flow scope"
              className="inline-flex items-center h-8 app-input border rounded-xl p-0.5"
            >
              {(['internet', 'lan'] as FlowScopeTab[]).map((tab) => {
                const active = flowsTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    data-testid={`flows-tab-${tab}`}
                    aria-selected={active}
                    onClick={() => setFlowsTab(tab)}
                    className={`px-3 h-full rounded-lg text-xs font-medium transition-colors ${
                      active
                        ? 'app-surface font-semibold'
                        : 'app-text-muted hover:opacity-80'
                    }`}
                  >
                    {tab === 'internet' ? 'Internet' : 'LAN'}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              data-testid="inspect-connections-btn"
              onClick={onViewAllFlows}
              className="text-xs font-medium text-sky-500 hover:text-sky-400 transition-colors whitespace-nowrap"
            >
              Inspect connections
            </button>
          </div>
        </div>

        <ClientFlowDiagram
          links={snapshot.clientLinks}
          scope={flowsTab}
          unit={unit}
          theme={theme}
          onSelectFilter={onSelectFilter}
        />
      </section>

      {/* Compact Two-Column Summary: Top Devices & Top Destinations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <section className="app-surface border rounded-2xl p-4 sm:p-5 flex flex-col">
          <div className="mb-3">
            <h2 className="font-display text-sm font-semibold">Top Devices</h2>
            <p className="text-xs app-text-muted mt-0.5">
              Local clients transferring the most bandwidth right now
            </p>
          </div>

          {topHosts.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-8 text-sm app-text-muted">
              No active local devices detected yet.
            </div>
          ) : (
            <div className="divide-y app-border">
              {topHosts.map((host) => (
                <button
                  key={host.ip}
                  type="button"
                  onClick={() => onSelectHost(host)}
                  className="w-full py-2.5 px-2.5 -mx-2.5 rounded-xl app-row-hover transition-colors flex items-center justify-between gap-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{host.hostname}</span>
                      <span className="text-xs app-text-muted tabular-nums">{host.ip}</span>
                    </div>
                    <div className="text-xs app-text-muted mt-0.5 truncate">
                      {host.vendor} · {host.activeFlows} connections
                    </div>
                  </div>
                  <div className="text-right text-xs font-medium tabular-nums shrink-0">
                    <div>{formatBandwidth(host.rxBps, unit)} ↓</div>
                    <div className="app-text-muted">{formatBandwidth(host.txBps, unit)} ↑</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="app-surface border rounded-2xl p-4 sm:p-5 flex flex-col">
          <div className="mb-3">
            <h2 className="font-display text-sm font-semibold">Top Destinations</h2>
            <p className="text-xs app-text-muted mt-0.5">
              Internet services receiving the highest active traffic
            </p>
          </div>

          {topServices.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-8 text-sm app-text-muted">
              No destination services observed yet.
            </div>
          ) : (
            <div className="divide-y app-border">
              {topServices.map((srv) => (
                <button
                  key={srv.service}
                  type="button"
                  onClick={() => onSelectFilter(srv.service)}
                  className="w-full py-2.5 px-2.5 -mx-2.5 rounded-xl app-row-hover transition-colors flex items-center justify-between gap-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{srv.service}</div>
                    <div className="text-xs app-text-muted mt-0.5 truncate">
                      {srv.category} · {srv.flows} active connections · {formatBytes(srv.bytes)}
                    </div>
                  </div>
                  <div className="text-xs font-medium tabular-nums shrink-0">
                    {formatBandwidth(srv.bps, unit)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
