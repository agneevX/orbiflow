import { useMemo, useState } from 'react';
import { ArrowUpDown, Search, X } from 'lucide-react';
import type { BandwidthUnit, EnrichedFlow, TransportProtocol } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import { formatBandwidth, formatBytes, formatDuration } from '../lib/formatters';
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

const STATE_TIPS: Record<string, string> = {
  ESTABLISHED: 'Active two-way connection currently exchanging data.',
  STATELESS: 'Connectionless UDP or ICMP traffic tracked by recent activity.',
  TIME_WAIT: 'Connection recently closed and waiting briefly for stray packets.',
  SYN_SENT: 'Device has started opening a new connection and is waiting for a reply.',
  FIN_WAIT: 'Connection is closing down gracefully.',
  CLOSE_WAIT: 'Remote server closed the connection; waiting for the local app to finish.',
  CLOSE: 'Connection is closed and will soon expire from the router table.',
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
  const [stateFilter, setStateFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<SortKey>('totalBps');
  const [sortAsc, setSortAsc] = useState(false);

  const filteredFlows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = flows.filter((f) => {
      if (protoFilter !== 'ALL' && f.proto !== protoFilter) return false;
      if (stateFilter !== 'ALL' && f.state !== stateFilter) return false;
      if (q) {
        const geoStr = f.dstGeo
          ? `${f.dstGeo.city || ''} ${f.dstGeo.countryName || ''} ${f.dstGeo.countryCode || ''} ${f.dstGeo.org || ''} ${f.dstGeo.asn ? `AS${f.dstGeo.asn}` : ''}`
          : '';
        const hay = `${f.srcIp} ${f.srcHost} ${f.dstIp} ${f.dstHost || ''} ${f.dstService} ${f.app} ${f.sport} ${f.dport} ${geoStr}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      const diff = a[sortBy] - b[sortBy];
      return sortAsc ? diff : -diff;
    });
    return list;
  }, [flows, search, protoFilter, stateFilter, sortBy, sortAsc]);

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
    setStateFilter('ALL');
  };

  return (
    <div className="space-y-4">
      {/* Filter & Search Toolbar */}
      <div className="app-surface border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <label htmlFor="flow-search-input" className="sr-only">
            Filter connections by IP, device, service, location, port, or application
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
            placeholder="Filter by IP, device, service, location, port..."
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
            <label htmlFor="state-filter" className="text-xs app-text-muted whitespace-nowrap">
              <TechTerm
                label="State"
                tip="Current lifecycle status of the connection as tracked by the router."
              />
            </label>
            <select
              id="state-filter"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="app-input border rounded-xl px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
            >
              <option value="ALL">All States</option>
              <option value="ESTABLISHED">ESTABLISHED</option>
              <option value="STATELESS">STATELESS</option>
              <option value="TIME_WAIT">TIME_WAIT</option>
              <option value="SYN_SENT">SYN_SENT</option>
            </select>
          </div>

          <span className="text-xs font-mono app-text-muted tabular-nums whitespace-nowrap">
            {filteredFlows.length} / {flows.length} connections
          </span>
        </div>
      </div>

      {/* Dense Flow Table */}
      <div className="app-surface border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
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
                    tip="The device on your home network and the local port number used for this session."
                  />
                </th>
                <th className="py-2.5 px-3">Destination / Service</th>
                <th className="py-2.5 px-3">
                  <TechTerm
                    label="State"
                    tip="Connection status reported by the router (e.g., ESTABLISHED for active TCP sessions or STATELESS for UDP)."
                  />
                </th>
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
                  <td colSpan={8} className="py-12 text-center">
                    <p className="text-sm app-text-muted">
                      No active connections match your current filters.
                    </p>
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="mt-3 px-3.5 py-1.5 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors"
                    >
                      Clear Filters
                    </button>
                  </td>
                </tr>
              ) : (
                filteredFlows.map((flow) => (
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
                    <td className="py-2.5 px-3 font-mono whitespace-nowrap tabular-nums max-w-[300px] truncate">
                      <span>{flow.dstIp}</span>
                      <span className="app-text-muted">:{flow.dport}</span>
                      <span className="ml-1.5 font-sans app-text-muted">
                        ({flow.dstService}
                        {flow.dstGeo && (flow.dstGeo.city || flow.dstGeo.countryCode)
                          ? ` · ${
                              flow.dstGeo.city && flow.dstGeo.countryCode
                                ? `${flow.dstGeo.city}, ${flow.dstGeo.countryCode}`
                                : flow.dstGeo.city || flow.dstGeo.countryCode
                            }`
                          : ''}
                        )
                      </span>
                    </td>
                    <td
                      className="py-2.5 px-3 font-mono app-text-muted whitespace-nowrap"
                      title={STATE_TIPS[flow.state] || flow.state}
                    >
                      {flow.state}
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
