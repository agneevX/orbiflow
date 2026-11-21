import { useMemo, useState } from 'react';
import { ArrowUpDown, Search, X } from 'lucide-react';
import type {
  BandwidthUnit,
  DestinationCategory,
  EnrichedFlow,
  TransportProtocol,
} from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  ALL_DESTINATION_CATEGORIES,
  formatBandwidth,
  formatBytes,
  formatDuration,
  hasTangibleTraffic,
} from '../lib/formatters';
import { TechTerm } from './TechTerm';

interface FlowsViewProps {
  flows: EnrichedFlow[];
  unit: BandwidthUnit;
  theme: ThemePalette;
  initialSearch?: string;
  onSelectFlow: (flow: EnrichedFlow) => void;
}

type SortKey = 'totalBps' | 'totalBytes' | 'rxBps' | 'txBps';

const PROTO_TIPS: Record<'TCP' | 'UDP' | 'ICMP', string> = {
  TCP: 'Transmission Control Protocol — reliable, ordered connections used for web browsing, video streaming, and downloads.',
  UDP: 'User Datagram Protocol — fast, low-latency traffic used for video calls, gaming, DNS lookups, and HTTP/3 (QUIC).',
  ICMP: 'Internet Control Message Protocol — diagnostic messages such as ping and network reachability checks.',
};

export function FlowsView({
  flows,
  unit,
  theme,
  initialSearch = '',
  onSelectFlow,
}: FlowsViewProps) {
  const [search, setSearch] = useState(initialSearch);
  const [protoFilter, setProtoFilter] = useState<'ALL' | TransportProtocol>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | DestinationCategory>('ALL');
  const [showIdle, setShowIdle] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('totalBps');
  const [sortAsc, setSortAsc] = useState(false);

  const activeCount = useMemo(
    () => flows.filter((f) => hasTangibleTraffic(f.rxBps, f.txBps)).length,
    [flows]
  );
  const idleCount = Math.max(0, flows.length - activeCount);

  const filteredFlows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = flows.filter((f) => {
      if (!showIdle && !hasTangibleTraffic(f.rxBps, f.txBps)) return false;
      if (protoFilter !== 'ALL' && f.proto !== protoFilter) return false;
      if (categoryFilter !== 'ALL' && f.dstCategory !== categoryFilter) return false;
      if (q) {
        const hay =
          `${f.srcIp} ${f.srcHost} ${f.dstIp} ${f.dstHost || ''} ${f.dstService} ${f.dstCategory} ${f.app} ${f.sport} ${f.dport}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      const diff = a[sortBy] - b[sortBy];
      return sortAsc ? diff : -diff;
    });
    return list;
  }, [flows, search, protoFilter, categoryFilter, showIdle, sortBy, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortBy(key);
      setSortAsc(false);
    }
  };

  const resetFilters = () => {
    setSearch('');
    setProtoFilter('ALL');
    setCategoryFilter('ALL');
  };

  const totalScopeCount = showIdle ? flows.length : activeCount;

  return (
    <div className="space-y-4">
      {/* Filter & Search Toolbar */}
      <div className="app-surface border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
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

        <div className="flex flex-wrap items-center gap-3">
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
                onClick={() => setProtoFilter(p)}
                className={`px-2.5 py-1 text-xs font-mono rounded-lg transition-colors whitespace-nowrap ${
                  protoFilter === p
                    ? 'bg-sky-500/15 text-sky-500 font-semibold'
                    : 'app-text-muted'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

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

          <span className="text-xs font-mono app-text-muted tabular-nums whitespace-nowrap">
            {filteredFlows.length} / {totalScopeCount} active
          </span>
        </div>
      </div>

      {/* Dense Active Flow Table (Established / Active Traffic Only — State column removed) */}
      <div className="app-surface border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse" data-testid="flows-table">
            <thead>
              <tr className="border-b app-border text-[11px] font-medium app-text-muted app-sidebar">
                <th className="py-2.5 px-3">
                  <TechTerm
                    label="App / Protocol"
                    tip="Detected application or service type along with the underlying transport protocol (TCP, UDP, or ICMP)."
                  />
                </th>
                <th className="py-2.5 px-3">
                  <TechTerm
                    label="Local Device : Port"
                    tip="The device on your local network and the source port used for this session."
                  />
                </th>
                <th className="py-2.5 px-3">
                  <TechTerm
                    label="Destination / Reverse DNS"
                    tip="Remote IP address, port, and automatically reverse-looked-up hostname / service."
                  />
                </th>
                <th className="py-2.5 px-3">Category</th>
                <th className="py-2.5 px-3 text-right">
                  <button
                    type="button"
                    onClick={() => handleSort('rxBps')}
                    className="inline-flex items-center gap-1"
                  >
                    Download
                    <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
                  </button>
                </th>
                <th className="py-2.5 px-3 text-right">
                  <button
                    type="button"
                    onClick={() => handleSort('txBps')}
                    className="inline-flex items-center gap-1"
                  >
                    Upload
                    <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
                  </button>
                </th>
                <th className="py-2.5 px-3 text-right">
                  <button
                    type="button"
                    onClick={() => handleSort('totalBytes')}
                    className="inline-flex items-center gap-1"
                  >
                    Total Data
                    <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
                  </button>
                </th>
                <th className="py-2.5 px-3 text-right">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y app-border text-xs">
              {filteredFlows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center space-y-3">
                    <p className="text-sm app-text-muted">
                      {!showIdle && idleCount > 0 && !search && protoFilter === 'ALL' && categoryFilter === 'ALL'
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
                filteredFlows.map((flow) => {
                  const hasResolvedHost = Boolean(flow.dstHost && flow.dstHost !== flow.dstIp);
                  return (
                    <tr
                      key={flow.id}
                      onClick={() => onSelectFlow(flow)}
                      className="app-row-hover cursor-pointer transition-colors"
                    >
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className="font-medium">{flow.app}</span>
                        <span
                          className="ml-1.5 font-mono app-text-muted"
                          title={
                            flow.proto === 'TCP' || flow.proto === 'UDP' || flow.proto === 'ICMP'
                              ? PROTO_TIPS[flow.proto]
                              : undefined
                          }
                        >
                          {flow.proto}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono whitespace-nowrap tabular-nums">
                        <span>{flow.srcHost}</span>
                        <span className="app-text-muted">:{flow.sport}</span>
                      </td>
                      <td className="py-2.5 px-3 max-w-[320px]">
                        <div className="flex items-center gap-1.5 truncate">
                          <span className="font-medium truncate">{flow.dstService}</span>
                          {hasResolvedHost && flow.dstHost !== flow.dstService && (
                            <span
                              className="font-mono text-[11px] app-text-muted truncate"
                              title={flow.dstHost}
                            >
                              · {flow.dstHost}
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] app-text-muted tabular-nums truncate">
                          {flow.dstIp}:{flow.dport}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 app-text-secondary whitespace-nowrap">
                        {flow.dstCategory}
                      </td>
                      <td
                        className="py-2.5 px-3 text-right font-mono whitespace-nowrap tabular-nums"
                        style={{ color: theme.rxColor }}
                      >
                        {formatBandwidth(flow.rxBps, unit)}
                      </td>
                      <td
                        className="py-2.5 px-3 text-right font-mono whitespace-nowrap tabular-nums"
                        style={{ color: theme.txColor }}
                      >
                        {formatBandwidth(flow.txBps, unit)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono whitespace-nowrap tabular-nums">
                        {formatBytes(flow.totalBytes)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono app-text-muted whitespace-nowrap tabular-nums">
                        {formatDuration((flow.lastSeen - flow.firstSeen) / 1000)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
