import { ArrowDownRight, ArrowUpRight, Gauge, Layers } from 'lucide-react';
import type {
  BandwidthUnit,
  DashboardSnapshot,
  HostSummary,
  TimeWindow,
} from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  ALL_TIME_WINDOWS,
  analyzeTimeWindow,
  type TimeWindowAnalysis,
} from '../lib/timeWindowUtils';
import { ThroughputChart } from './ThroughputChart';
import { ClientFlowDiagram } from './ClientFlowDiagram';
import { formatBandwidth, formatBytes } from '../lib/formatters';

interface OverviewViewProps {
  snapshot: DashboardSnapshot;
  timeWindow: TimeWindow;
  windowAvailability: Record<TimeWindow, TimeWindowAnalysis>;
  onChangeTimeWindow?: (w: TimeWindow) => void;
  unit: BandwidthUnit;
  theme: ThemePalette;
  onSelectHost: (host: HostSummary) => void;
  onSelectFilter: (query: string) => void;
  onViewAllFlows: () => void;
}

export function OverviewView({
  snapshot,
  timeWindow,
  windowAvailability,
  onChangeTimeWindow,
  unit,
  theme,
  onSelectHost,
  onSelectFilter,
  onViewAllFlows,
}: OverviewViewProps) {
  const isLongWindow = timeWindow === '1h' || timeWindow === '6h' || timeWindow === '24h';
  const activeAnalysis =
    windowAvailability[timeWindow] ||
    analyzeTimeWindow(timeWindow, snapshot.history, snapshot.rollupHistory);

  const topHosts = snapshot.hosts.slice(0, 5);
  const topServices = (() => {
    const map = new Map<string, { service: string; bps: number; bytes: number; flows: number }>();
    for (const l of snapshot.clientLinks) {
      const cur = map.get(l.service) || { service: l.service, bps: 0, bytes: 0, flows: 0 };
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
      {/* 4-Column Summary KPI Strip (Zero packet counters) */}
      <section
        aria-label="Key WAN bandwidth metrics"
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"
      >
        <div className="app-surface border rounded-lg p-4">
          <div className="flex items-center justify-between text-xs app-text-muted">
            <span>Download Speed (Rx)</span>
            <ArrowDownRight className="h-4 w-4" style={{ color: theme.rxColor }} aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">
            {formatBandwidth(snapshot.kpis.rxBps, unit)}
          </div>
          <div className="mt-1.5 text-xs app-text-muted font-mono tabular-nums">
            Peak {formatBandwidth(snapshot.kpis.peakRxBps, unit)} · Total {formatBytes(snapshot.kpis.totalRxBytes)}
          </div>
        </div>

        <div className="app-surface border rounded-lg p-4">
          <div className="flex items-center justify-between text-xs app-text-muted">
            <span>Upload Speed (Tx)</span>
            <ArrowUpRight className="h-4 w-4" style={{ color: theme.txColor }} aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">
            {formatBandwidth(snapshot.kpis.txBps, unit)}
          </div>
          <div className="mt-1.5 text-xs app-text-muted font-mono tabular-nums">
            Peak {formatBandwidth(snapshot.kpis.peakTxBps, unit)} · Total {formatBytes(snapshot.kpis.totalTxBytes)}
          </div>
        </div>

        <div className="app-surface border rounded-lg p-4">
          <div className="flex items-center justify-between text-xs app-text-muted">
            <span>Combined Throughput</span>
            <Gauge className="h-4 w-4 app-text-muted" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">
            {formatBandwidth(snapshot.kpis.combinedBps, unit)}
          </div>
          <div className="mt-1.5 text-xs app-text-muted font-mono tabular-nums">
            Total {formatBytes(snapshot.kpis.totalRxBytes + snapshot.kpis.totalTxBytes)} transferred
          </div>
        </div>

        <div className="app-surface border rounded-lg p-4">
          <div className="flex items-center justify-between text-xs app-text-muted">
            <span>Active Connections</span>
            <Layers className="h-4 w-4 app-text-muted" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">
            {snapshot.kpis.activeFlows}
          </div>
          <div className="mt-1.5 text-xs app-text-muted font-mono tabular-nums">
            {snapshot.kpis.activeHosts} active LAN clients
          </div>
        </div>
      </section>

      {/* Primary Focal Anchor: Live Bandwidth Chart */}
      <section className="app-surface border rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h2 className="font-display text-sm font-semibold">
              WAN Bandwidth History ({snapshot.probe.iface})
            </h2>
            <p className="text-xs app-text-muted mt-0.5">
              {activeAnalysis.status === 'full' ? (
                <>Live traffic rates from {snapshot.probe.hostname} over WebSocket</>
              ) : (
                <span
                  data-testid="window-coverage-note"
                  className={activeAnalysis.status === 'empty' ? 'text-amber-500 font-medium' : ''}
                >
                  {activeAnalysis.summaryText}
                </span>
              )}
            </p>
          </div>
          {onChangeTimeWindow && (
            <div
              role="group"
              aria-label="Mobile chart time window"
              className="flex md:hidden items-center app-input border rounded-md p-0.5"
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
                    className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-mono rounded-sm transition-colors ${
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
          unit={unit}
          theme={theme}
          longWindow={isLongWindow}
          height={250}
        />
      </section>

      {/* Client to Destination Flow Diagram */}
      <section className="app-surface border rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h2 className="font-display text-sm font-semibold">
              Client to Destination Flow Map
            </h2>
            <p className="text-xs app-text-muted mt-0.5">
              Live bandwidth paths between LAN clients and external services
            </p>
          </div>
          <button
            type="button"
            onClick={onViewAllFlows}
            className="text-xs font-medium text-sky-500 hover:text-sky-400 transition-colors whitespace-nowrap"
          >
            Inspect all {snapshot.flows.length} connections →
          </button>
        </div>

        <ClientFlowDiagram
          links={snapshot.clientLinks}
          unit={unit}
          theme={theme}
          onSelectFilter={onSelectFilter}
        />
      </section>

      {/* Compact Two-Column Summary: Top Clients & Top Services */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <section className="app-surface border rounded-lg p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-sm font-semibold">Top LAN Clients</h2>
            <span className="text-xs app-text-muted">Click client to filter</span>
          </div>

          {topHosts.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-8 text-sm app-text-muted">
              No active LAN clients detected yet.
            </div>
          ) : (
            <div className="divide-y app-border">
              {topHosts.map((host) => (
                <button
                  key={host.ip}
                  type="button"
                  onClick={() => onSelectHost(host)}
                  className="w-full py-2.5 px-2 -mx-2 rounded-md app-row-hover transition-colors flex items-center justify-between gap-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{host.hostname}</span>
                      <span className="font-mono text-xs app-text-muted tabular-nums">
                        {host.ip}
                      </span>
                    </div>
                    <div className="text-xs app-text-muted mt-0.5 truncate">
                      {host.vendor} · {host.activeFlows} connections
                    </div>
                  </div>
                  <div className="text-right font-mono text-xs tabular-nums shrink-0">
                    <div style={{ color: theme.rxColor }}>
                      {formatBandwidth(host.rxBps, unit)} ↓
                    </div>
                    <div style={{ color: theme.txColor }}>
                      {formatBandwidth(host.txBps, unit)} ↑
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="app-surface border rounded-lg p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-sm font-semibold">Top Destinations</h2>
            <span className="text-xs app-text-muted">Click service to filter</span>
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
                  className="w-full py-2.5 px-2 -mx-2 rounded-md app-row-hover transition-colors flex items-center justify-between gap-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{srv.service}</div>
                    <div className="text-xs app-text-muted mt-0.5">
                      {srv.flows} active connections · {formatBytes(srv.bytes)}
                    </div>
                  </div>
                  <div className="font-mono text-xs font-medium tabular-nums shrink-0">
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
