import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Check,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { BandwidthUnit, DeviceNameSource, HostSummary } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  compareIpv4,
  formatBandwidth,
  formatBytes,
  hasTangibleTraffic,
} from '../lib/formatters';
import { TechTerm } from './TechTerm';

interface HostsViewProps {
  hosts: HostSummary[];
  unit: BandwidthUnit;
  theme: ThemePalette;
  onInspectHostFlows: (host: HostSummary) => void;
  onSaveAlias: (alias: { key: string; matchBy: 'mac' | 'ip'; name: string }) => Promise<void>;
  onDeleteAlias: (key: string) => Promise<void>;
}

type HostSortKey = 'totalBytes' | 'rxBps' | 'txBps' | 'activeFlows' | 'hostname' | 'ip';
type HostTypeFilter = 'ALL' | 'NAMED' | 'INFERRED' | 'IP_ONLY' | 'PRIVATE_MAC';

const SOURCE_META: Record<DeviceNameSource, { label: string; tip: string }> = {
  alias: {
    label: 'Custom',
    tip: 'Manually named by you and saved persistently in /config/config.json.',
  },
  'lan-dns': {
    label: 'LAN DNS',
    tip: 'Resolved via reverse PTR lookup against your local DNS server / router dnsmasq.',
  },
  dhcp: {
    label: 'DHCP',
    tip: 'Hostname reported by the router DHCP lease file or static hosts table.',
  },
  fingerprint: {
    label: 'Inferred',
    tip: 'No DHCP or DNS name was found (common with Private Wi-Fi MACs). Device type was inferred from its live traffic destinations. You can disable inferred names in Settings or click the rename icon.',
  },
  ip: {
    label: 'IP Only',
    tip: 'No hostname resolved from LAN DNS or DHCP. Click the rename icon to assign a permanent custom name.',
  },
};

export function HostsView({
  hosts,
  unit,
  theme,
  onInspectHostFlows,
  onSaveAlias,
  onDeleteAlias,
}: HostsViewProps) {
  const [editingIp, setEditingIp] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [matchBy, setMatchBy] = useState<'mac' | 'ip'>('mac');
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<HostTypeFilter>('ALL');
  const [showIdle, setShowIdle] = useState(false);
  // Default to Total Data descending so rows remain calm and do not jump every poll tick
  const [sortKey, setSortKey] = useState<HostSortKey>('totalBytes');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  const activeHostCount = useMemo(
    () => hosts.filter((h) => hasTangibleTraffic(h.rxBps, h.txBps)).length,
    [hosts]
  );
  const idleCount = Math.max(0, hosts.length - activeHostCount);
  const randomizedCount = useMemo(
    () =>
      hosts.filter(
        (h) => (showIdle || hasTangibleTraffic(h.rxBps, h.txBps)) && h.isRandomizedMac
      ).length,
    [hosts, showIdle]
  );

  const toggleSort = (key: HostSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'hostname' || key === 'ip' ? 'asc' : 'desc');
    }
  };

  const renderSortIcon = (key: HostSortKey) => {
    if (sortKey !== key) {
      return <ArrowUpDown className="h-3 w-3 opacity-45 shrink-0" aria-hidden="true" />;
    }
    return sortDir === 'desc' ? (
      <ArrowDown className="h-3 w-3 text-sky-500 shrink-0" aria-hidden="true" />
    ) : (
      <ArrowUp className="h-3 w-3 text-sky-500 shrink-0" aria-hidden="true" />
    );
  };

  const filteredHosts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = hosts.filter((h) => {
      if (!showIdle && !hasTangibleTraffic(h.rxBps, h.txBps)) return false;

      if (typeFilter === 'NAMED') {
        if (h.nameSource !== 'alias' && h.nameSource !== 'lan-dns' && h.nameSource !== 'dhcp') {
          return false;
        }
      } else if (typeFilter === 'INFERRED') {
        if (h.nameSource !== 'fingerprint') return false;
      } else if (typeFilter === 'IP_ONLY') {
        if (h.nameSource !== 'ip') return false;
      } else if (typeFilter === 'PRIVATE_MAC') {
        if (!h.isRandomizedMac) return false;
      }

      if (!q) return true;
      const services = (h.topServices?.length ? h.topServices : h.topApps).join(' ');
      const haystack = `${h.hostname} ${h.ip} ${h.mac} ${h.vendor} ${services} ${h.ptrHostname || ''}`.toLowerCase();
      return haystack.includes(q);
    });

    const dir = sortDir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'hostname') {
        cmp = a.hostname.localeCompare(b.hostname, undefined, { sensitivity: 'base' });
      } else if (sortKey === 'ip') {
        cmp = compareIpv4(a.ip, b.ip);
      } else {
        cmp = a[sortKey] - b[sortKey];
      }
      if (cmp !== 0) return cmp * dir;
      // Deterministic IP tie-breaker prevents rows with identical rates from shuffling
      return compareIpv4(a.ip, b.ip);
    });
  }, [hosts, search, typeFilter, showIdle, sortKey, sortDir]);

  const startEdit = (host: HostSummary) => {
    setEditingIp(host.ip);
    setDraftName(host.nameSource === 'ip' ? '' : host.hostname);
    const hasRealMac = host.mac && host.mac !== '00:00:00:00:00:00';
    setMatchBy(host.aliasMatchBy ?? (hasRealMac ? 'mac' : 'ip'));
  };

  const cancelEdit = () => {
    setEditingIp(null);
    setDraftName('');
  };

  const commitEdit = async (host: HostSummary) => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      cancelEdit();
      return;
    }
    const key = matchBy === 'mac' ? `mac:${host.mac}` : `ip:${host.ip}`;
    setSaving(true);
    try {
      await onSaveAlias({ key, matchBy, name: trimmed });
      setEditingIp(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Search, Filter & Activity Controls */}
      <div className="app-surface border rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search
            className="h-4 w-4 app-text-muted absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="text"
            data-testid="hosts-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by device name, IP, MAC, vendor, or service..."
            aria-label="Filter devices"
            className="w-full app-input border rounded-xl pl-9 pr-3 py-1.5 text-xs focus:outline-none focus:border-sky-500"
          />
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="hosts-type-filter" className="text-xs app-text-muted whitespace-nowrap">
            Filter
          </label>
          <select
            id="hosts-type-filter"
            data-testid="hosts-filter-select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as HostTypeFilter)}
            className="app-input border rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500"
          >
            <option value="ALL">All Devices</option>
            <option value="NAMED">Named (Custom / DNS / DHCP)</option>
            <option value="INFERRED">Inferred Names</option>
            <option value="IP_ONLY">IP Only</option>
            <option value="PRIVATE_MAC">Private MAC</option>
          </select>
        </div>

        <label className="inline-flex items-center gap-1.5 text-xs app-text-muted cursor-pointer whitespace-nowrap select-none">
          <input
            type="checkbox"
            data-testid="show-idle-hosts-toggle"
            checked={showIdle}
            onChange={(e) => setShowIdle(e.target.checked)}
            className="h-3.5 w-3.5 rounded text-sky-500 focus:ring-sky-500"
          />
          <span>Show idle{idleCount > 0 ? ` (${idleCount})` : ''}</span>
        </label>

        <div className="flex items-center gap-3 ml-auto">
          {randomizedCount > 0 && (
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-amber-500 whitespace-nowrap">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <TechTerm
                label={`${randomizedCount} Private MAC`}
                tip="Devices using IEEE 802.3 locally administered (randomized) MAC addresses. Pinning a custom name by MAC works across IP renewals on your home Wi-Fi."
              />
            </div>
          )}
          <div className="text-xs font-mono app-text-muted tabular-nums whitespace-nowrap">
            {filteredHosts.length} / {showIdle ? hosts.length : activeHostCount}{' '}
            {showIdle ? 'devices' : 'active'}
          </div>
        </div>
      </div>

      {/* Fixed-Layout Stable Devices Table */}
      <div className="app-surface border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] table-fixed text-left border-collapse">
            <colgroup>
              <col className="w-[23%]" />
              <col className="w-[12%]" />
              <col className="w-[15%]" />
              <col className="w-[17%]" />
              <col className="w-[6%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[6%]" />
              <col className="w-[5%]" />
            </colgroup>
            <thead>
              <tr className="border-b app-border text-[11px] font-medium app-text-muted app-sidebar">
                <th className="py-2.5 px-3">
                  <button
                    type="button"
                    data-testid="sort-hosts-hostname"
                    onClick={() => toggleSort('hostname')}
                    className="inline-flex items-center gap-1 hover:opacity-80 whitespace-nowrap"
                  >
                    <span>Device Name / Type</span>
                    {renderSortIcon('hostname')}
                  </button>
                </th>
                <th className="py-2.5 px-3">
                  <button
                    type="button"
                    data-testid="sort-hosts-ip"
                    onClick={() => toggleSort('ip')}
                    className="inline-flex items-center gap-1 hover:opacity-80 whitespace-nowrap"
                  >
                    <span>IP Address</span>
                    {renderSortIcon('ip')}
                  </button>
                </th>
                <th className="py-2.5 px-3">
                  <TechTerm
                    label="MAC Address"
                    tip="Hardware network identifier. Addresses with the IEEE locally administered bit set (2nd hex digit 2, 6, a, or e) are flagged as Private MACs."
                  />
                </th>
                <th className="py-2.5 px-3">Top Services</th>
                <th className="py-2.5 px-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-hosts-flows"
                    onClick={() => toggleSort('activeFlows')}
                    className="inline-flex items-center justify-end gap-1 ml-auto hover:opacity-80 whitespace-nowrap"
                  >
                    <span>Conns</span>
                    {renderSortIcon('activeFlows')}
                  </button>
                </th>
                <th className="py-2.5 px-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-hosts-rx"
                    onClick={() => toggleSort('rxBps')}
                    className="inline-flex items-center justify-end gap-1 ml-auto hover:opacity-80 whitespace-nowrap"
                  >
                    <span>Download</span>
                    {renderSortIcon('rxBps')}
                  </button>
                </th>
                <th className="py-2.5 px-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-hosts-tx"
                    onClick={() => toggleSort('txBps')}
                    className="inline-flex items-center justify-end gap-1 ml-auto hover:opacity-80 whitespace-nowrap"
                  >
                    <span>Upload</span>
                    {renderSortIcon('txBps')}
                  </button>
                </th>
                <th className="py-2.5 px-2 text-right">
                  <button
                    type="button"
                    data-testid="sort-hosts-total"
                    onClick={() => toggleSort('totalBytes')}
                    className="inline-flex items-center justify-end gap-1 ml-auto hover:opacity-80 whitespace-nowrap"
                  >
                    <span>Total</span>
                    {renderSortIcon('totalBytes')}
                  </button>
                </th>
                <th className="py-2.5 px-3 text-right">Flows</th>
              </tr>
            </thead>
            <tbody className="divide-y app-border text-xs">
              {filteredHosts.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center app-text-muted space-y-2">
                    <div>
                      {!showIdle && idleCount > 0 && !search && typeFilter === 'ALL'
                        ? `No devices with active traffic right now (${idleCount} idle devices hidden).`
                        : 'No devices match the current filters.'}
                    </div>
                    {!showIdle && idleCount > 0 && !search && typeFilter === 'ALL' && (
                      <button
                        type="button"
                        onClick={() => setShowIdle(true)}
                        className="px-3.5 py-1.5 rounded-xl border app-border app-surface app-row-hover text-xs font-medium transition-colors"
                      >
                        Show {idleCount} Idle Devices
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filteredHosts.map((host) => {
                  const isEditing = editingIp === host.ip;
                  const sourceMeta = SOURCE_META[host.nameSource] || SOURCE_META.ip;
                  const hasValidMac = host.mac && host.mac !== '00:00:00:00:00:00';
                  const serviceList =
                    host.topServices && host.topServices.length > 0
                      ? host.topServices
                      : host.topApps;
                  const serviceText = serviceList.length > 0 ? serviceList.join(', ') : 'Idle';

                  return (
                    <tr
                      key={host.ip}
                      data-testid={`host-row-${host.ip}`}
                      className={`app-row-hover transition-colors ${isEditing ? '' : 'h-[64px]'}`}
                    >
                      <td className="py-2.5 px-3 align-middle overflow-hidden">
                        {isEditing ? (
                          <div className="space-y-1.5" data-testid="device-rename-form">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                data-testid="device-rename-input"
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void commitEdit(host);
                                  } else if (e.key === 'Escape') {
                                    cancelEdit();
                                  }
                                }}
                                placeholder="e.g. Alex's iPhone"
                                autoFocus
                                className="w-full min-w-0 app-input border rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-sky-500"
                              />
                              <button
                                type="button"
                                data-testid="device-rename-save"
                                disabled={saving}
                                onClick={() => void commitEdit(host)}
                                aria-label="Save custom device name"
                                className="p-1 rounded-lg app-btn-primary shrink-0"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                aria-label="Cancel rename"
                                className="p-1 rounded-lg border app-border app-row-hover app-text-muted shrink-0"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="flex items-center gap-2.5 text-[11px] app-text-muted flex-wrap">
                              <span>Pin:</span>
                              {hasValidMac && (
                                <label className="inline-flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="radio"
                                    name={`match-${host.ip}`}
                                    checked={matchBy === 'mac'}
                                    onChange={() => setMatchBy('mac')}
                                    className="text-sky-500"
                                  />
                                  <span>MAC</span>
                                </label>
                              )}
                              <label className="inline-flex items-center gap-1 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`match-${host.ip}`}
                                  checked={matchBy === 'ip'}
                                  onChange={() => setMatchBy('ip')}
                                  className="text-sky-500"
                                />
                                <span>IP</span>
                              </label>
                              {host.aliasKey && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await onDeleteAlias(host.aliasKey!);
                                    setEditingIp(null);
                                  }}
                                  className="inline-flex items-center gap-1 text-amber-500 hover:underline ml-auto"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Reset
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="min-w-0">
                            <div className="flex items-center gap-1 min-w-0">
                              <span className="font-medium truncate" title={host.hostname}>
                                {host.hostname}
                              </span>
                              <button
                                type="button"
                                data-testid={`rename-host-${host.ip}`}
                                onClick={() => startEdit(host)}
                                aria-label={`Rename ${host.hostname}`}
                                title="Assign custom device name (saved in /config/config.json)"
                                className="p-1 rounded-lg app-text-muted hover:text-sky-500 transition-colors shrink-0"
                              >
                                <Pencil className="h-3 w-3" aria-hidden="true" />
                              </button>
                            </div>
                            <div className="text-[11px] app-text-muted flex items-center gap-1.5 min-w-0 leading-4">
                              <span className="truncate" title={host.vendor}>
                                {host.vendor}
                              </span>
                              <span aria-hidden="true" className="shrink-0">
                                ·
                              </span>
                              <span className="shrink-0">
                                <TechTerm
                                  label={sourceMeta.label}
                                  tip={
                                    host.ptrHostname
                                      ? `${sourceMeta.tip} Full PTR: ${host.ptrHostname}`
                                      : sourceMeta.tip
                                  }
                                />
                              </span>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 align-middle font-mono whitespace-nowrap tabular-nums truncate">
                        {host.ip}
                      </td>
                      <td className="py-2.5 px-3 align-middle font-mono app-text-muted overflow-hidden">
                        <div className="truncate" title={host.mac}>
                          {host.mac}
                        </div>
                        {host.isRandomizedMac && (
                          <div className="text-[11px] font-sans text-amber-500 leading-4 truncate">
                            <TechTerm
                              label="Private MAC"
                              tip="IEEE 802.3 locally administered (randomized) MAC address. Pinning a custom name by MAC persists across DHCP renewals on your home Wi-Fi."
                            />
                          </div>
                        )}
                      </td>
                      <td
                        className="py-2.5 px-3 align-middle app-text-secondary overflow-hidden"
                        title={serviceText}
                      >
                        <div className="text-xs leading-snug line-clamp-2 break-words">
                          {serviceText}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 align-middle text-right font-mono tabular-nums whitespace-nowrap">
                        {host.activeFlows}
                      </td>
                      <td
                        className="py-2.5 px-2 align-middle text-right font-mono whitespace-nowrap tabular-nums"
                        style={{ color: theme.rxColor }}
                      >
                        {formatBandwidth(host.rxBps, unit)}
                      </td>
                      <td
                        className="py-2.5 px-2 align-middle text-right font-mono whitespace-nowrap tabular-nums"
                        style={{ color: theme.txColor }}
                      >
                        {formatBandwidth(host.txBps, unit)}
                      </td>
                      <td className="py-2.5 px-2 align-middle text-right font-mono whitespace-nowrap tabular-nums">
                        {formatBytes(host.totalBytes)}
                      </td>
                      <td className="py-2.5 px-3 align-middle text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onInspectHostFlows(host)}
                          aria-label={`View connections for ${host.hostname}`}
                          title={`Inspect connections for ${host.hostname}`}
                          className="inline-flex items-center justify-center h-7 w-7 rounded-lg border app-border app-row-hover app-text-secondary transition-colors"
                        >
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
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
