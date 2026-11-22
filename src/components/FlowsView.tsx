import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import type {
  BandwidthUnit,
  ConnectionsTablePrefs,
  DestinationCategory,
  EnrichedFlow,
  TransportProtocol,
} from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  ALL_DESTINATION_CATEGORIES,
  formatAppForProtocolFilter,
  formatBandwidth,
  formatBytes,
  formatDuration,
  hasTangibleTraffic,
} from '../lib/formatters';
import { DEFAULT_CONNECTIONS_TABLE_PREFS } from '../lib/tablePreferences';
import { TechTerm } from './TechTerm';

interface FlowsViewProps {
  flows: EnrichedFlow[];
  unit: BandwidthUnit;
  theme: ThemePalette;
  initialSearch?: string;
  prefs: ConnectionsTablePrefs;
  onUpdatePrefs: (next: ConnectionsTablePrefs) => Promise<void>;
  onSelectFlow: (flow: EnrichedFlow) => void;
}

type SortKey = 'totalBps' | 'totalBytes' | 'rxBps' | 'txBps';

const PROTO_TIPS: Record<'TCP' | 'UDP' | 'ICMP', string> = {
  TCP: 'Transmission Control Protocol — reliable, ordered connections used for web browsing, video streaming, and downloads.',
  UDP: 'User Datagram Protocol — fast, low-latency traffic used for video calls, gaming, DNS lookups, and HTTP/3 (QUIC).',
  ICMP: 'Internet Control Message Protocol — diagnostic messages such as ping and network reachability checks.',
};

const COLUMN_TOGGLE_ITEMS: Array<{
  key: keyof ConnectionsTablePrefs;
  label: string;
  section: 'columns' | 'details';
}> = [
  { key: 'showAppProtocol', label: 'App / Protocol', section: 'columns' },
  { key: 'showLocalDevice', label: 'Local Device', section: 'columns' },
  { key: 'showDestination', label: 'Destination', section: 'columns' },
  { key: 'showDestinationIpPort', label: 'Destination IP : Port', section: 'columns' },
  { key: 'showCategory', label: 'Category', section: 'columns' },
  { key: 'showDownload', label: 'Download', section: 'columns' },
  { key: 'showUpload', label: 'Upload', section: 'columns' },
  { key: 'showTotal', label: 'Total', section: 'columns' },
  { key: 'showDuration', label: 'Duration', section: 'columns' },
  { key: 'showProtocol', label: 'Protocol badge (TCP/UDP)', section: 'details' },
  { key: 'showLocalPort', label: 'Local device port', section: 'details' },
  { key: 'showLocalIp', label: 'Local IP address', section: 'details' },
  { key: 'showDestinationRdns', label: 'Reverse DNS on next line', section: 'details' },
];

export function FlowsView({
  flows,
  unit,
  theme,
  initialSearch = '',
  prefs,
  onUpdatePrefs,
  onSelectFlow,
}: FlowsViewProps) {
  const [search, setSearch] = useState(initialSearch);
  const [protoFilter, setProtoFilter] = useState<'ALL' | TransportProtocol>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | DestinationCategory>('ALL');
  const [showIdle, setShowIdle] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('totalBps');
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const PAGE_SIZE = 50;

  const [localPrefs, setLocalPrefs] = useState<ConnectionsTablePrefs>(prefs);
  const prefsSignature = useMemo(() => JSON.stringify(prefs), [prefs]);
  const lastSyncedPrefsRef = useRef<string>(prefsSignature);

  useEffect(() => {
    if (prefsSignature !== lastSyncedPrefsRef.current) {
      lastSyncedPrefsRef.current = prefsSignature;
      setLocalPrefs(prefs);
    }
  }, [prefs, prefsSignature]);

  useEffect(() => {
    if (!columnsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (columnsRef.current && !columnsRef.current.contains(e.target as Node)) {
        setColumnsOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColumnsOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [columnsOpen]);

  useEffect(() => {
    setPage(1);
  }, [search, protoFilter, categoryFilter, showIdle]);

  const activeCount = useMemo(
    () => flows.filter((f) => !f.ended && hasTangibleTraffic(f.rxBps, f.txBps)).length,
    [flows]
  );
  const endedCount = useMemo(() => flows.filter((f) => Boolean(f.ended)).length, [flows]);
  const idleCount = useMemo(
    () => flows.filter((f) => !f.ended && !hasTangibleTraffic(f.rxBps, f.txBps)).length,
    [flows]
  );

  const filteredFlows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = flows.filter((f) => {
      // Keep active flows AND recently ended flows visible so rows don't vanish before reading
      if (!showIdle && !f.ended && !hasTangibleTraffic(f.rxBps, f.txBps)) return false;
      if (protoFilter !== 'ALL' && f.proto !== protoFilter) return false;
      if (protoFilter !== 'ICMP' && categoryFilter !== 'ALL' && f.dstCategory !== categoryFilter) {
        return false;
      }
      if (q) {
        const hay =
          `${f.srcIp} ${f.srcHost} ${f.dstIp} ${f.dstHost || ''} ${f.dstService} ${f.dstCategory} ${f.app} ${f.sport} ${f.dport}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      const diff = a[sortBy] - b[sortBy];
      if (diff !== 0) return sortAsc ? diff : -diff;
      // Tie-breaker: live flows before ended flows, then most recently seen/ended first
      const aEnded = a.ended ? 1 : 0;
      const bEnded = b.ended ? 1 : 0;
      if (aEnded !== bEnded) return aEnded - bEnded;
      return (b.endedAt || b.lastSeen) - (a.endedAt || a.lastSeen);
    });
    return list;
  }, [flows, search, protoFilter, categoryFilter, showIdle, sortBy, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(filteredFlows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pagedFlows = useMemo(
    () => filteredFlows.slice(pageStart, pageStart + PAGE_SIZE),
    [filteredFlows, pageStart]
  );

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortBy(key);
      setSortAsc(false);
    }
    setPage(1);
  };

  const resetFilters = () => {
    setSearch('');
    setProtoFilter('ALL');
    setCategoryFilter('ALL');
    setPage(1);
  };

  const togglePref = (key: keyof ConnectionsTablePrefs) => {
    const next: ConnectionsTablePrefs = { ...localPrefs, [key]: !localPrefs[key] };
    setLocalPrefs(next);
    void onUpdatePrefs(next);
  };

  const resetColumnDefaults = () => {
    const next = { ...DEFAULT_CONNECTIONS_TABLE_PREFS };
    setLocalPrefs(next);
    void onUpdatePrefs(next);
  };

  const visibleColCount = [
    localPrefs.showAppProtocol,
    localPrefs.showLocalDevice,
    localPrefs.showDestination,
    localPrefs.showDestinationIpPort,
    localPrefs.showCategory,
    localPrefs.showDownload,
    localPrefs.showUpload,
    localPrefs.showTotal,
    localPrefs.showDuration,
  ].filter(Boolean).length;

  const isCustomized = (
    Object.keys(DEFAULT_CONNECTIONS_TABLE_PREFS) as Array<keyof ConnectionsTablePrefs>
  ).some((k) => localPrefs[k] !== DEFAULT_CONNECTIONS_TABLE_PREFS[k]);

  const totalScopeCount = showIdle ? flows.length : activeCount + endedCount;

  return (
    <div className="space-y-4">
      {/* Filter, Search & Global Column Customization Toolbar */}
      <div className="app-surface border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <label htmlFor="flow-search-input" className="sr-only">
            Filter connections by IP, device, hostname, service, category, or port
          </label>
          <Search
            className="h-4 w-4 app-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            id="flow-search-input"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by IP, device, hostname, category, port..."
            className="w-full pl-9 pr-8 py-2 app-input border rounded-xl text-xs focus:outline-none focus:border-sky-500"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search query"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 app-text-muted"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <div
            role="group"
            aria-label="Filter by transport protocol"
            className="flex items-center app-input border rounded-xl p-1"
          >
            {(['ALL', 'TCP', 'UDP', 'ICMP'] as const).map((p) => (
              <button
                key={p}
                type="button"
                title={p === 'ALL' ? 'Show all connection protocols' : PROTO_TIPS[p]}
                onClick={() => {
                  setProtoFilter(p);
                  if (p === 'ICMP') setCategoryFilter('ALL');
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  protoFilter === p
                    ? 'bg-sky-500/15 text-sky-500 font-semibold'
                    : 'app-text-muted'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {protoFilter !== 'ICMP' && (
            <div className="flex items-center gap-2">
              <label htmlFor="category-filter" className="text-xs app-text-muted whitespace-nowrap">
                Category
              </label>
              <select
                id="category-filter"
                data-testid="category-filter-select"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as 'ALL' | DestinationCategory)}
                className="app-input border rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500"
              >
                <option value="ALL">All Categories</option>
                {ALL_DESTINATION_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          )}

          <label className="inline-flex items-center gap-1.5 text-xs app-text-muted cursor-pointer whitespace-nowrap select-none">
            <input
              type="checkbox"
              data-testid="show-idle-flows-toggle"
              checked={showIdle}
              onChange={(e) => setShowIdle(e.target.checked)}
              className="h-3.5 w-3.5 rounded text-sky-500 focus:ring-sky-500"
            />
            <span>Show idle{idleCount > 0 ? ` (${idleCount})` : ''}</span>
          </label>

          {/* Global Column Customizer */}
          <div ref={columnsRef} className="relative">
            <button
              type="button"
              data-testid="flows-columns-btn"
              aria-expanded={columnsOpen}
              onClick={() => setColumnsOpen((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-colors whitespace-nowrap ${
                columnsOpen || isCustomized
                  ? 'border-sky-500/50 bg-sky-500/10 text-sky-500'
                  : 'app-border app-input app-row-hover app-text-secondary'
              }`}
            >
              <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Columns</span>
            </button>

            {columnsOpen && (
              <div
                data-testid="flows-columns-popover"
                className="absolute right-0 top-full mt-2 w-64 p-3.5 rounded-2xl border app-border app-surface shadow-xl z-30 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold">Connections Columns</div>
                    <div className="text-[11px] app-text-muted">Saved globally in config.json</div>
                  </div>
                  <button
                    type="button"
                    data-testid="flows-columns-reset"
                    onClick={resetColumnDefaults}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-500 hover:text-sky-400"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Reset
                  </button>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wider app-text-muted">
                    Visible Columns
                  </div>
                  {COLUMN_TOGGLE_ITEMS.filter((i) => i.section === 'columns').map((item) => (
                    <label
                      key={item.key}
                      className="flex items-center gap-2 py-1 px-1.5 rounded-lg app-row-hover cursor-pointer text-xs select-none"
                    >
                      <input
                        type="checkbox"
                        data-testid={`flows-col-${item.key}`}
                        checked={localPrefs[item.key]}
                        onChange={() => togglePref(item.key)}
                        className="h-3.5 w-3.5 rounded text-sky-500 focus:ring-sky-500"
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>

                <div className="pt-2 border-t app-border space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wider app-text-muted">
                    Cell Details
                  </div>
                  {COLUMN_TOGGLE_ITEMS.filter((i) => i.section === 'details').map((item) => (
                    <label
                      key={item.key}
                      className="flex items-center gap-2 py-1 px-1.5 rounded-lg app-row-hover cursor-pointer text-xs select-none"
                    >
                      <input
                        type="checkbox"
                        data-testid={`flows-col-${item.key}`}
                        checked={localPrefs[item.key]}
                        onChange={() => togglePref(item.key)}
                        className="h-3.5 w-3.5 rounded text-sky-500 focus:ring-sky-500"
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <span className="text-xs font-medium app-text-muted tabular-nums whitespace-nowrap">
            {filteredFlows.length} / {totalScopeCount} shown
          </span>
        </div>
      </div>

      {/* Customizable Active Connections Table */}
      <div className="app-surface border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse" data-testid="flows-table">
            <thead>
              <tr className="border-b app-border text-[11px] font-medium app-text-muted app-sidebar">
                {localPrefs.showAppProtocol && (
                  <th className="py-2.5 px-3 whitespace-nowrap">
                    <TechTerm
                      label={
                        localPrefs.showProtocol && protoFilter === 'ALL' ? 'App / Protocol' : 'App'
                      }
                      tip="Detected application or service type along with the optional underlying transport protocol (TCP, UDP, or ICMP)."
                    />
                  </th>
                )}
                {localPrefs.showLocalDevice && (
                  <th className="py-2.5 px-3 whitespace-nowrap">
                    <TechTerm
                      label={localPrefs.showLocalPort ? 'Local Device : Port' : 'Local Device'}
                      tip="The device on your local network initiating or receiving this connection."
                    />
                  </th>
                )}
                {localPrefs.showDestination && (
                  <th className="py-2.5 px-3 whitespace-nowrap">
                    <TechTerm
                      label={localPrefs.showDestinationRdns ? 'Destination' : 'Destination Service'}
                      tip="Detected destination service name with reverse DNS hostname shown underneath when resolved."
                    />
                  </th>
                )}
                {localPrefs.showDestinationIpPort && (
                  <th className="py-2.5 px-3 whitespace-nowrap">Destination IP : Port</th>
                )}
                {localPrefs.showCategory && (
                  <th className="py-2.5 px-3 whitespace-nowrap">Category</th>
                )}
                {localPrefs.showDownload && (
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort('rxBps')}
                      className="inline-flex items-center gap-1"
                    >
                      Download
                      <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </th>
                )}
                {localPrefs.showUpload && (
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort('txBps')}
                      className="inline-flex items-center gap-1"
                    >
                      Upload
                      <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </th>
                )}
                {localPrefs.showTotal && (
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort('totalBytes')}
                      className="inline-flex items-center gap-1"
                    >
                      Total
                      <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </th>
                )}
                {localPrefs.showDuration && (
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Duration</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y app-border text-xs">
              {filteredFlows.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(1, visibleColCount)} className="py-12 text-center space-y-3">
                    <p className="text-sm app-text-muted">
                      {!showIdle &&
                      idleCount > 0 &&
                      !search &&
                      protoFilter === 'ALL' &&
                      categoryFilter === 'ALL'
                        ? `No active traffic right now (${idleCount} idle established connections hidden).`
                        : 'No active connections match your current filters.'}
                    </p>
                    <div className="flex items-center justify-center gap-2">
                      {(search || protoFilter !== 'ALL' || categoryFilter !== 'ALL') && (
                        <button
                          type="button"
                          onClick={resetFilters}
                          className="px-3.5 py-1.5 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors"
                        >
                          Clear Filters
                        </button>
                      )}
                      {!showIdle && idleCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowIdle(true)}
                          className="px-3.5 py-1.5 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors"
                        >
                          Show {idleCount} Idle Connections
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                pagedFlows.map((flow) => {
                  const hasResolvedHost = Boolean(
                    flow.dstHost && flow.dstHost !== flow.dstIp && flow.dstHost !== flow.dstService
                  );
                  return (
                    <tr
                      key={flow.id}
                      data-ended={flow.ended ? 'true' : 'false'}
                      onClick={() => onSelectFlow(flow)}
                      className={`app-row-hover cursor-pointer transition-colors ${
                        flow.ended ? 'opacity-65' : ''
                      }`}
                    >
                      {localPrefs.showAppProtocol && (
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span className="font-medium">
                            {formatAppForProtocolFilter(
                              flow.app,
                              flow.proto,
                              flow.dport,
                              protoFilter
                            )}
                          </span>
                          {localPrefs.showProtocol && protoFilter === 'ALL' && (
                            <span
                              className="ml-1.5 text-[11px] app-text-muted"
                              title={
                                flow.proto === 'TCP' ||
                                flow.proto === 'UDP' ||
                                flow.proto === 'ICMP'
                                  ? PROTO_TIPS[flow.proto]
                                  : undefined
                              }
                            >
                              {flow.proto}
                            </span>
                          )}
                        </td>
                      )}

                      {localPrefs.showLocalDevice && (
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <div className="tabular-nums">
                            <span className="font-medium">{flow.srcHost}</span>
                            {localPrefs.showLocalPort && (
                              <span className="font-mono text-[11px] app-text-muted">
                                :{flow.sport}
                              </span>
                            )}
                          </div>
                          {localPrefs.showLocalIp && flow.srcHost !== flow.srcIp && (
                            <div className="text-[11px] font-mono app-text-muted tabular-nums">
                              {flow.srcIp}
                            </div>
                          )}
                        </td>
                      )}

                      {localPrefs.showDestination && (
                        <td className="py-2.5 px-3 max-w-[300px]">
                          <div className="font-medium truncate" title={flow.dstService}>
                            {flow.dstService}
                          </div>
                          {localPrefs.showDestinationRdns && hasResolvedHost && (
                            <div
                              className="text-[11px] app-text-muted truncate"
                              title={flow.dstHost}
                            >
                              {flow.dstHost}
                            </div>
                          )}
                        </td>
                      )}

                      {localPrefs.showDestinationIpPort && (
                        <td className="py-2.5 px-3 font-mono text-[11px] app-text-secondary whitespace-nowrap tabular-nums">
                          {flow.dstIp}:{flow.dport}
                        </td>
                      )}

                      {localPrefs.showCategory && (
                        <td className="py-2.5 px-3 app-text-secondary whitespace-nowrap">
                          {flow.proto === 'ICMP' ? '—' : flow.dstCategory}
                        </td>
                      )}

                      {localPrefs.showDownload && (
                        <td
                          className="py-2.5 px-3 text-right font-medium whitespace-nowrap tabular-nums"
                          style={{ color: theme.rxColor }}
                        >
                          {formatBandwidth(flow.rxBps, unit)}
                        </td>
                      )}

                      {localPrefs.showUpload && (
                        <td
                          className="py-2.5 px-3 text-right font-medium whitespace-nowrap tabular-nums"
                          style={{ color: theme.txColor }}
                        >
                          {formatBandwidth(flow.txBps, unit)}
                        </td>
                      )}

                      {localPrefs.showTotal && (
                        <td className="py-2.5 px-3 text-right font-medium whitespace-nowrap tabular-nums">
                          {formatBytes(flow.totalBytes)}
                        </td>
                      )}

                      {localPrefs.showDuration && (
                        <td className="py-2.5 px-3 text-right app-text-muted whitespace-nowrap tabular-nums">
                          <span>{formatDuration((flow.lastSeen - flow.firstSeen) / 1000)}</span>
                          {flow.ended && (
                            <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-80">
                              Ended
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer (50 connections per page) */}
        {filteredFlows.length > 0 && (
          <div
            data-testid="flows-pagination"
            className="px-4 py-3 border-t app-border flex flex-wrap items-center justify-between gap-3 text-xs app-text-muted"
          >
            <span className="tabular-nums">
              Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredFlows.length)} of{' '}
              {filteredFlows.length} connections
              {endedCount > 0 ? ` (${endedCount} recently ended)` : ''}
            </span>

            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="flows-page-prev"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border app-border app-surface app-row-hover disabled:opacity-40 disabled:pointer-events-none transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Prev</span>
                </button>
                <span
                  data-testid="flows-page-indicator"
                  className="px-2 font-mono tabular-nums app-text-secondary"
                >
                  Page {safePage} / {totalPages}
                </span>
                <button
                  type="button"
                  data-testid="flows-page-next"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border app-border app-surface app-row-hover disabled:opacity-40 disabled:pointer-events-none transition-colors"
                >
                  <span>Next</span>
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
