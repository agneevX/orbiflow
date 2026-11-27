import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Cable,
  Check,
  Columns3,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  Wifi,
  X,
} from 'lucide-react';
import type {
  BandwidthUnit,
  DetectedSubnet,
  DeviceNameSource,
  DevicesTablePrefs,
  HostSummary,
} from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import {
  compareIpv4,
  formatBandwidth,
  formatBytes,
  hasTangibleTraffic,
} from '../lib/formatters';
import { DEFAULT_DEVICES_TABLE_PREFS } from '../lib/tablePreferences';
import { formatWifiRatesLabel } from '../lib/topology';
import { TechTerm } from './TechTerm';

interface HostsViewProps {
  hosts: HostSummary[];
  detectedSubnets?: DetectedSubnet[];
  unit: BandwidthUnit;
  theme: ThemePalette;
  prefs: DevicesTablePrefs;
  onUpdatePrefs: (next: DevicesTablePrefs) => Promise<void>;
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

const DEVICE_COLUMN_ITEMS: Array<{
  key: keyof DevicesTablePrefs;
  label: string;
  section: 'columns' | 'details';
}> = [
  { key: 'showIp', label: 'IP Address', section: 'columns' },
  { key: 'showMac', label: 'MAC Address', section: 'columns' },
  { key: 'showConnection', label: 'Connection / Wi-Fi Rate', section: 'columns' },
  { key: 'showTopServices', label: 'Top Services', section: 'columns' },
  { key: 'showConnections', label: 'Connections Count', section: 'columns' },
  { key: 'showDownload', label: 'Download', section: 'columns' },
  { key: 'showUpload', label: 'Upload', section: 'columns' },
  { key: 'showTotal', label: 'Total', section: 'columns' },
  { key: 'showVendorSource', label: 'Vendor & Name Source', section: 'details' },
];

export function HostsView({
  hosts,
  detectedSubnets = [],
  unit,
  theme,
  prefs,
  onUpdatePrefs,
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
  const [vlanFilter, setVlanFilter] = useState<string>('ALL');
  const [showIdle, setShowIdle] = useState(true);
  // Default to Total Data descending so rows remain calm and do not jump every poll tick
  const [sortKey, setSortKey] = useState<HostSortKey>('totalBytes');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);

  const [localPrefs, setLocalPrefs] = useState<DevicesTablePrefs>(prefs);
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

  const vlanOptions = useMemo(() => {
    const map = new Map<string, { label: string; cidr: string }>();
    for (const h of hosts) {
      if (h.vlanName && h.vlanCidr) {
        map.set(h.vlanCidr, { label: h.vlanName, cidr: h.vlanCidr });
      }
    }
    for (const sub of detectedSubnets) {
      if (!sub.isPrimary && !map.has(sub.cidr)) {
        map.set(sub.cidr, {
          label: sub.name || (sub.vlanId ? `VLAN ${sub.vlanId}` : sub.cidr),
          cidr: sub.cidr,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [hosts, detectedSubnets]);

  const filteredHosts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = hosts.filter((h) => {
      if (!showIdle && !hasTangibleTraffic(h.rxBps, h.txBps)) return false;

      if (vlanFilter === 'PRIMARY') {
        if (h.vlanCidr) return false;
      } else if (vlanFilter !== 'ALL') {
        if (h.vlanCidr !== vlanFilter) return false;
      }

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
      const services = (h.topServices || []).join(' ');
      const connHint =
        h.connectionType === 'wifi'
          ? `wifi wi-fi ${h.wifiBand || ''} ${h.apName || 'main ap'}`
          : `ethernet wired ${h.apName || 'main ap'}`;
      const vlanHint = `${h.vlanName || ''} ${h.vlanCidr || ''}`;
      const haystack = `${h.hostname} ${h.ip} ${h.mac} ${h.vendor} ${services} ${connHint} ${vlanHint} ${h.ptrHostname || ''}`.toLowerCase();
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
      return compareIpv4(a.ip, b.ip);
    });
  }, [hosts, search, typeFilter, vlanFilter, showIdle, sortKey, sortDir]);

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

  const togglePref = (key: keyof DevicesTablePrefs) => {
    const next: DevicesTablePrefs = { ...localPrefs, [key]: !localPrefs[key] };
    setLocalPrefs(next);
    void onUpdatePrefs(next);
  };

  const resetColumnDefaults = () => {
    const next = { ...DEFAULT_DEVICES_TABLE_PREFS };
    setLocalPrefs(next);
    void onUpdatePrefs(next);
  };

  const visibleColCount =
    2 +
    [
      localPrefs.showIp,
      localPrefs.showMac,
      localPrefs.showConnection,
      localPrefs.showTopServices,
      localPrefs.showConnections,
      localPrefs.showDownload,
      localPrefs.showUpload,
      localPrefs.showTotal,
    ].filter(Boolean).length;

  const isCustomized = (
    Object.keys(DEFAULT_DEVICES_TABLE_PREFS) as Array<keyof DevicesTablePrefs>
  ).some((k) => localPrefs[k] !== DEFAULT_DEVICES_TABLE_PREFS[k]);

  return (
    <div className="space-y-4">
      {/* Search, Filter & Global Column Customizer */}
      <div className="app-surface border rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
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

        {vlanOptions.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="hosts-vlan-filter" className="text-xs app-text-muted whitespace-nowrap">
              VLAN
            </label>
            <select
              id="hosts-vlan-filter"
              data-testid="hosts-vlan-select"
              value={vlanFilter}
              onChange={(e) => setVlanFilter(e.target.value)}
              className="app-input border rounded-xl px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500"
            >
              <option value="ALL">All Subnets</option>
              <option value="PRIMARY">Primary LAN</option>
              {vlanOptions.map((v) => (
                <option key={v.cidr} value={v.cidr}>
                  {v.label} ({v.cidr})
                </option>
              ))}
            </select>
          </div>
        )}

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

        {/* Global Column Customizer */}
        <div ref={columnsRef} className="relative">
          <button
            type="button"
            data-testid="hosts-columns-btn"
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
              data-testid="hosts-columns-popover"
              className="absolute right-0 top-full mt-2 w-60 p-3.5 rounded-2xl border app-border app-surface shadow-xl z-30 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold">Devices Columns</div>
                  <div className="text-[11px] app-text-muted">Saved globally in config.json</div>
                </div>
                <button
                  type="button"
                  data-testid="hosts-columns-reset"
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
                {DEVICE_COLUMN_ITEMS.filter((i) => i.section === 'columns').map((item) => (
                  <label
                    key={item.key}
                    className="flex items-center gap-2 py-1 px-1.5 rounded-lg app-row-hover cursor-pointer text-xs select-none"
                  >
                    <input
                      type="checkbox"
                      data-testid={`hosts-col-${item.key}`}
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
                {DEVICE_COLUMN_ITEMS.filter((i) => i.section === 'details').map((item) => (
                  <label
                    key={item.key}
                    className="flex items-center gap-2 py-1 px-1.5 rounded-lg app-row-hover cursor-pointer text-xs select-none"
                  >
                    <input
                      type="checkbox"
                      data-testid={`hosts-col-${item.key}`}
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
          <div className="text-xs font-medium app-text-muted tabular-nums whitespace-nowrap">
            {filteredHosts.length} / {showIdle ? hosts.length : activeHostCount}{' '}
            {showIdle ? 'devices' : 'active'}
          </div>
        </div>
      </div>

      {/* Stable Devices Table with Globally Customizable Columns */}
      <div className="app-surface border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse" data-testid="hosts-table">
            <thead>
              <tr className="border-b app-border text-[11px] font-medium app-text-muted app-sidebar">
                <th className="py-2.5 px-3 min-w-[200px]">
                  <button
                    type="button"
                    data-testid="sort-hosts-hostname"
                    onClick={() => toggleSort('hostname')}
                    className="inline-flex items-center gap-1 hover:opacity-80 whitespace-nowrap"
                  >
                    <span>Device</span>
                    {renderSortIcon('hostname')}
                  </button>
                </th>
                {localPrefs.showIp && (
                  <th className="py-2.5 px-3 whitespace-nowrap">
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
                )}
                {localPrefs.showMac && (
                  <th className="py-2.5 px-3 whitespace-nowrap">
                    <TechTerm
                      label="MAC Address"
                      tip="Hardware network identifier. Addresses with the IEEE locally administered bit set (2nd hex digit 2, 6, a, or e) are flagged as Private MACs."
                    />
                  </th>
                )}
                {localPrefs.showConnection && (
                  <th className="py-2.5 px-3 whitespace-nowrap">
                    <TechTerm
                      label="Connection"
                      tip="Wi-Fi clients display live RX/TX PHY link rates, band (2.4 GHz, 5 GHz, or 6 GHz), and connected AP (Main AP or satellite). Non-Wi-Fi clients are designated as Ethernet."
                    />
                  </th>
                )}
                {localPrefs.showTopServices && (
                  <th className="py-2.5 px-3 min-w-[160px] max-w-[260px]">Top Services</th>
                )}
                {localPrefs.showConnections && (
                  <th className="py-2.5 px-2 text-right whitespace-nowrap">
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
                )}
                {localPrefs.showDownload && (
                  <th className="py-2.5 px-2 text-right whitespace-nowrap">
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
                )}
                {localPrefs.showUpload && (
                  <th className="py-2.5 px-2 text-right whitespace-nowrap">
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
                )}
                {localPrefs.showTotal && (
                  <th className="py-2.5 px-2 text-right whitespace-nowrap">
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
                )}
                <th className="py-2.5 px-3 text-right whitespace-nowrap">Flows</th>
              </tr>
            </thead>
            <tbody className="divide-y app-border text-xs">
              {filteredHosts.length === 0 ? (
                <tr>
                  <td
                    colSpan={Math.max(1, visibleColCount)}
                    className="py-10 text-center app-text-muted space-y-2"
                  >
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
                  const serviceList = host.topServices || [];
                  const serviceText = serviceList.length > 0 ? serviceList.join(', ') : '—';

                  return (
                    <tr
                      key={host.ip}
                      data-testid={`host-row-${host.ip}`}
                      className={`app-row-hover transition-colors ${isEditing ? '' : 'h-[62px]'}`}
                    >
                      <td className="py-2.5 px-3 align-middle max-w-[260px]">
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
                            {localPrefs.showVendorSource && (
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
                            )}
                          </div>
                        )}
                      </td>

                      {localPrefs.showIp && (
                        <td className="py-2.5 px-3 align-middle whitespace-nowrap tabular-nums">
                          <div>{host.ip}</div>
                          {host.vlanName && (
                            <div
                              className="mt-0.5 inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400"
                              title={host.vlanCidr}
                            >
                              {host.vlanName}
                            </div>
                          )}
                        </td>
                      )}

                      {localPrefs.showMac && (
                        <td className="py-2.5 px-3 align-middle font-mono text-[11px] app-text-muted whitespace-nowrap">
                          <div title={host.mac}>{host.mac}</div>
                          {host.isRandomizedMac && (
                            <div className="text-[11px] font-sans text-amber-500 leading-4">
                              <TechTerm
                                label="Private MAC"
                                tip="IEEE 802.3 locally administered (randomized) MAC address. Pinning a custom name by MAC persists across DHCP renewals on your home Wi-Fi."
                              />
                            </div>
                          )}
                        </td>
                      )}

                      {localPrefs.showConnection && (
                        <td
                          data-testid={`host-connection-${host.ip}`}
                          className="py-2.5 px-3 align-middle whitespace-nowrap"
                        >
                          {host.connectionType === 'wifi' ? (
                            <div className="space-y-0.5">
                              <div className="inline-flex items-center gap-1.5 font-mono text-[11px] font-medium tabular-nums">
                                <Wifi className="h-3.5 w-3.5 text-sky-500 shrink-0" aria-hidden="true" />
                                <span>
                                  {formatWifiRatesLabel(host.wifiRxMbps, host.wifiTxMbps)}
                                </span>
                              </div>
                              <div className="text-[11px] app-text-muted pl-5 leading-4">
                                {[host.wifiBand || 'Wi-Fi', host.apName || 'Main AP']
                                  .filter(Boolean)
                                  .join(' · ')}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              <div className="inline-flex items-center gap-1.5 text-xs app-text-secondary">
                                <Cable
                                  className="h-3.5 w-3.5 text-emerald-500 shrink-0"
                                  aria-hidden="true"
                                />
                                <span>Ethernet</span>
                              </div>
                              <div className="text-[11px] app-text-muted pl-5 leading-4">
                                {host.apName || 'Main AP'}
                              </div>
                            </div>
                          )}
                        </td>
                      )}

                      {localPrefs.showTopServices && (
                        <td
                          className="py-2.5 px-3 align-middle app-text-secondary max-w-[240px]"
                          title={serviceText}
                        >
                          <div className="text-xs leading-snug line-clamp-2 break-words">
                            {serviceText}
                          </div>
                        </td>
                      )}

                      {localPrefs.showConnections && (
                        <td className="py-2.5 px-2 align-middle text-right font-medium tabular-nums whitespace-nowrap">
                          {host.activeFlows}
                        </td>
                      )}

                      {localPrefs.showDownload && (
                        <td
                          className="py-2.5 px-2 align-middle text-right font-medium whitespace-nowrap tabular-nums"
                          style={{ color: theme.rxColor }}
                        >
                          {formatBandwidth(host.rxBps, unit)}
                        </td>
                      )}

                      {localPrefs.showUpload && (
                        <td
                          className="py-2.5 px-2 align-middle text-right font-medium whitespace-nowrap tabular-nums"
                          style={{ color: theme.txColor }}
                        >
                          {formatBandwidth(host.txBps, unit)}
                        </td>
                      )}

                      {localPrefs.showTotal && (
                        <td className="py-2.5 px-2 align-middle text-right font-medium whitespace-nowrap tabular-nums">
                          {formatBytes(host.totalBytes)}
                        </td>
                      )}

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
